// eval/tools/replay-check.cjs —— M5 回放一致性：按取证重放写入操作，比对工作区树哈希
//
// 用法：node eval/tools/replay-check.cjs --stamp <2026-11-14> [--tasks W1,R1]
//
// 重放来源（两臂各自的取证面）：
//   - 对照臂（stream）：probe.jsonl 逐请求 messages 原文里的 tf-write 命令（协议文本，可靠）
//   - 基线臂（baseline）：session log assistant/attempt 流里的原生 tool_call（write 族）
//     ——骨架来源是 v4 日志的 assistant/attempt chunk 流（同 06 驱动器累积逻辑）
// 重放目标：空 repl/ 目录先铺同一份 seed，再按记录顺序重放全部写入，然后
//   repl/manifest.json 的树哈希 == 实跑后 ws/manifest.json 的树哈希 → M5 通过。
// 不可重放面（bash 命令、非 write 族工具）如实记 skipped，不假装通过。
//
// 用法（回填 metrics.json 的 replay 字段）：
//   node eval/tools/replay-check.cjs --stamp <stamp>

const fs = require('node:fs');
const path = require('node:path');
const { workspaceManifest, parseSessionLog } = require('./session-log.cjs');

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const TASKS_FILE = path.join(PKG_ROOT, 'eval', 'tasks', 'tasks.json');
const FIXTURES = path.join(PKG_ROOT, 'eval', 'tasks', 'fixtures');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

/** 从 probe chunk 记录提取模型输出的 tf-write（对照臂）。
 *  注意：必须取模型输出（chunk 流的 text 增量），不能取 request messages——
 *  系统提示的协议示例文本里也有 <tf-write> 字样（smoke 实测误提取教训）。 */
function extractTfWritesFromChunks(probeLines) {
  const ops = [];
  const textBySeq = new Map(); // seq -> 聚合的模型文本
  for (const l of probeLines) {
    if (l.kind !== 'chunk') continue;
    try {
      const c = JSON.parse(l.chunk);
      if (c.type === 'text' && typeof c.text === 'string') {
        textBySeq.set(l.seq, (textBySeq.get(l.seq) || '') + c.text);
      } else if (c.type === 'text-delta' && typeof c.textDelta === 'string') {
        textBySeq.set(l.seq, (textBySeq.get(l.seq) || '') + c.textDelta);
      }
    } catch { /* 原文保留，解析失败如实跳过 */ }
  }
  const seqs = [...textBySeq.keys()].sort((a, b) => a - b);
  for (const seq of seqs) {
    const re = /<tf-write\s+path="([^"]+)"[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/tf-write>/g;
    let match;
    while ((match = re.exec(textBySeq.get(seq))) !== null) {
      ops.push({ path: match[1], content: match[3], source: `tf-write@seq${seq}` });
    }
  }
  return ops;
}

/** 从 session log assistant/attempt 流累积原生 tool_call（基线臂）。 */
function extractNativeWrites(records) {
  const calls = new Map(); // id -> {name, arguments}
  for (const r of records) {
    if (r.type !== 'assistant/attempt') continue;
    for (const s of (r.data && r.data.stream) || []) {
      const c = s.chunk || {};
      if (c.type === 'tool-call-delta' && c.id !== undefined) {
        const acc = calls.get(c.id) || { name: undefined, args: '' };
        if (c.name !== undefined) acc.name = c.name;
        if (typeof c.argumentsDelta === 'string') acc.args += c.argumentsDelta;
        calls.set(c.id, acc);
      } else if (c.type === 'tool-call' && c.block && c.block.id !== undefined) {
        const acc = calls.get(c.block.id) || { name: undefined, args: '' };
        if (c.block.name !== undefined) acc.name = c.block.name;
        if (typeof c.block.arguments === 'string' && acc.args.length === 0) acc.args = c.block.arguments;
        calls.set(c.block.id, acc);
      }
    }
  }
  const ops = [];
  const skipped = [];
  for (const [id, acc] of calls) {
    let args = {};
    try { args = JSON.parse(acc.args || '{}'); } catch { args = null; }
    if (acc.name === 'write' && args && typeof args.file_path === 'string') {
      ops.push({ path: args.file_path, content: String(args.content ?? ''), source: `native:${acc.name}` });
    } else if (acc.name === 'str_replace_editor' && args && typeof args.path === 'string' && args.command === 'create') {
      ops.push({ path: args.path, content: String(args.file_text ?? ''), source: `native:${acc.name}` });
    } else if (acc.name === 'str_replace_editor' && args && typeof args.path === 'string') {
      // str_replace：读取当前内容做替换（replay 目录中 seed 已铺，顺序回放即可）
      const rel = normRel(args.path);
      const cur = existing.get(rel);
      if (cur !== undefined && typeof args.old_string === 'string') {
        ops.push({ path: rel, replace: { old: args.old_string, new: String(args.new_string ?? '') }, source: `native:${acc.name}` });
      } else skipped.push({ id, name: acc.name, reason: 'replace-target-missing' });
    } else {
      skipped.push({ id, name: acc.name, reason: acc.name === undefined ? 'incomplete-call' : 'not-a-write-tool' });
    }
  }
  return { ops, skipped };
}

const existing = new Map(); // replay 目录当前内容（rel -> string），供 str_replace 顺序回放

function normRel(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
}

function seedWorkspace(replDir, task) {
  fs.rmSync(replDir, { recursive: true, force: true });
  fs.mkdirSync(replDir, { recursive: true });
  for (const s of task.seed || []) {
    const dst = path.join(replDir, s.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, s.fixture), dst);
  }
  existing.clear();
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else existing.set(path.relative(replDir, p).replace(/\\/g, '/'), fs.readFileSync(p, 'utf8'));
    }
  })(replDir);
}

function applyOp(op) {
  const rel = normRel(op.path);
  if (op.replace) {
    const cur = existing.get(rel);
    if (cur === undefined) return `replace 目标不存在: ${rel}`;
    existing.set(rel, cur.split(op.replace.old).join(op.replace.new));
    return null;
  }
  existing.set(rel, String(op.content));
  return null;
}

function flush(replDir) {
  for (const [rel, content] of existing) {
    const p = path.join(replDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
}

function checkTask(task, runDir, arm, taskId) {
  const taskDir = path.join(runDir, arm, taskId);
  const metricsPath = path.join(taskDir, 'metrics.json');
  if (!fs.existsSync(metricsPath)) return { taskId, error: 'metrics.json 不存在（未跑）' };
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));

  const replDir = path.join(taskDir, 'repl');
  seedWorkspace(replDir, task);
  let ops = [];
  const skipped = [];
  if (arm === 'stream') {
    const probeFile = path.join(taskDir, 'probe', 'probe.jsonl');
    if (!fs.existsSync(probeFile)) return { taskId, error: 'probe.jsonl 不存在' };
    const probeLines = fs.readFileSync(probeFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { kind: 'PARSE_ERROR' }; } });
    ops = extractTfWritesFromChunks(probeLines);
  } else {
    const logPath = path.join(taskDir, 'session-log', 'session.v4.jsonl.zstd');
    if (!fs.existsSync(logPath)) return { taskId, error: 'session log 存档不存在' };
    const records = parseSessionLog(logPath);
    const extracted = extractNativeWrites(records);
    ops = extracted.ops;
    skipped.push(...extracted.skipped);
  }

  const errors = [];
  for (const op of ops) {
    const e = applyOp(op);
    if (e) errors.push(e);
  }
  flush(replDir);
  const manifest = workspaceManifest(replDir);
  fs.writeFileSync(path.join(replDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const wsManifest = JSON.parse(fs.readFileSync(path.join(taskDir, 'ws', 'manifest.json'), 'utf8'));
  const replay = {
    opsReplayed: ops.length, skipped, errors,
    replRoot: manifest.root,
    wsRoot: wsManifest.root,
    pass: ops.length > 0 && errors.length === 0 && manifest.root === wsManifest.root,
    note: ops.length === 0 ? '提取零写入操作：回放不可得（如实标注，不假装通过）' : (errors.length === 0 && manifest.root === wsManifest.root ? '重放树哈希 == 实跑树哈希' : '哈希不一致，见 repl/ 与 ws/ manifest'),
  };
  metrics.replay = replay;
  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2), 'utf8');
  console.log(`[${arm}/${taskId}] replay ops=${replay.opsReplayed} skipped=${skipped.length} pass=${replay.pass}`);
  return { taskId, replay };
}

function main() {
  const stamp = arg('stamp');
  if (!stamp) { console.error('--stamp 必填'); process.exit(2); }
  const runDir = path.join(PKG_ROOT, 'eval', 'runs', stamp);
  const all = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  const pick = arg('tasks', 'all') === 'all' ? all.tasks : all.tasks.filter((t) => arg('tasks', '').split(',').includes(t.id));
  for (const arm of ['baseline', 'stream']) {
    for (const t of pick) {
      if (fs.existsSync(path.join(runDir, arm, t.id, 'metrics.json'))) checkTask(t, runDir, arm, t.id);
    }
  }
}

if (require.main === module) main();
module.exports = { extractTfWritesFromChunks, extractNativeWrites, checkTask };
