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

/** 从 probe chunk 记录提取模型输出的写入类 tf-* 命令（对照臂）。
 *  注意：必须取模型输出（chunk 流的 text 增量），不能取 request messages——
 *  系统提示的协议示例文本里也有 <tf-write> 字样（smoke 实测误提取教训）。
 *
 *  M3 修复（0.3.0）：
 *  · 属性序无关——旧正则要求 path 在 id 之前，模型输出 id/depends_on 在前时提取 0 命中
 *    （replay 0/10 的直接根因）；改为引号感知的头部扫描 + 通用属性解析。
 *  · 支持 tf-edit（replace）与 tf-append（追加/锚点插入）的回放，不再只认 tf-write。
 *  · 未闭合命令如实计入 errors（提取器出错 = "提取失败"，不假装"回放通过"）。 */
function extractTfWritesFromChunks(probeLines) {
  const ops = [];
  const errors = [];
  const textBySeq = new Map(); // seq -> 聚合的模型文本
  for (const l of probeLines) {
    if (l.kind !== 'chunk') continue;
    try {
      const c = JSON.parse(l.chunk);
      // dsh-llm 流词汇：text 增量字段是 `text`（text-delta / reasoning-delta 同形）；
      // 旧代码读 `textDelta` 永远命不中——replay 0/10 的第二个根因（2026-11-15 实测数据核对）。
      if ((c.type === 'text' || c.type === 'text-delta') && typeof c.text === 'string') {
        textBySeq.set(l.seq, (textBySeq.get(l.seq) || '') + c.text);
      }
    } catch { /* 原文保留，解析失败如实跳过 */ }
  }
  const seqs = [...textBySeq.keys()].sort((a, b) => a - b);
  for (const seq of seqs) {
    const text = textBySeq.get(seq);
    const re = /<tf-(write|edit|append)(\s|\n)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const tag = `tf-${m[1]}`;
      // 引号感知地找头部结束 '>'（属性值可含 >）
      let i = m.index + tag.length + 1;
      let inQuote = false;
      let headerEnd = -1;
      for (; i < text.length; i++) {
        const ch = text[i];
        if (inQuote) {
          if (ch === '"') inQuote = false;
          continue;
        }
        if (ch === '"') inQuote = true;
        else if (ch === '>') { headerEnd = i; break; }
      }
      if (headerEnd === -1) {
        errors.push({ seq, tag, reason: 'unclosed-header' });
        continue;
      }
      const header = text.slice(m.index, headerEnd + 1);
      if (header.endsWith('/>')) {
        errors.push({ seq, tag, reason: 'self-closing-write-command' });
        continue;
      }
      // 通用属性解析（键序无关）
      const attrs = {};
      const attrRe = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/g;
      let am;
      while ((am = attrRe.exec(header)) !== null) attrs[am[1]] = am[2];
      const bodyStart = headerEnd + 1;
      const closeTag = `</${tag}>`;
      const closeIdx = text.indexOf(closeTag, bodyStart);
      if (closeIdx === -1) {
        errors.push({ seq, tag, reason: 'unclosed-body' });
        continue;
      }
      const body = text.slice(bodyStart, closeIdx);
      re.lastIndex = closeIdx + closeTag.length;
      if (attrs['path'] === undefined) { errors.push({ seq, tag, reason: 'missing-path' }); continue; }
      // 绝对路径处理：模型把任务工作区绝对路径回显时，取 '/ws/' 之后的部分相对化；
      // 无法相对化（工作区外路径）→ 提取失败如实记录，不静默丢。
      let relPath = attrs['path'];
      const wsSplit = relPath.replace(/\\/g, '/').split(/\/ws\//);
      if (/^([a-zA-Z]:[\\/]|\/)/.test(relPath)) {
        if (wsSplit.length > 1) relPath = wsSplit[wsSplit.length - 1];
        else { errors.push({ seq, tag, reason: `absolute-path-outside-workspace:${attrs['path'].slice(0, 60)}` }); continue; }
      }
      if (tag === 'tf-write') {
        ops.push({ path: relPath, content: body, source: `tf-write@seq${seq}` });
      } else if (tag === 'tf-edit') {
        const split = splitEditBody(body);
        if (split === null) { errors.push({ seq, tag, reason: 'bad-edit-markers' }); continue; }
        ops.push({ path: relPath, replace: { old: split.old, new: split.new }, source: `tf-edit@seq${seq}` });
      } else {
        ops.push({ path: relPath, append: body, source: `tf-append@seq${seq}` });
      }
    }
  }
  if (errors.length > 0) ops.push({ __errors: errors });
  return ops;
}

/** tf-edit body 的 OLD/NEW 标记切分（与 src/kernel/parser.ts 的 splitEditBody 同语义）。
 *  本文件是 CJS 工具，不 import TS 内核——两处语义必须同步，改一处即改另一处。 */
function splitEditBody(body) {
  const lines = body.split('\n');
  const idxOld = lines.indexOf('<<<<<<< OLD');
  const idxSplit = lines.indexOf('=======');
  const idxEnd = lines.indexOf('>>>>>>> NEW');
  if (idxOld === -1 || idxSplit === -1 || idxEnd === -1) return null;
  if (!(idxOld < idxSplit && idxSplit < idxEnd)) return null;
  if (lines.indexOf('<<<<<<< OLD', idxOld + 1) !== -1) return null;
  if (lines.indexOf('=======', idxSplit + 1) !== -1) return null;
  if (lines.indexOf('>>>>>>> NEW', idxEnd + 1) !== -1) return null;
  return { old: lines.slice(idxOld + 1, idxSplit).join('\n'), new: lines.slice(idxSplit + 1, idxEnd).join('\n') };
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
    const next = cur.split(op.replace.old).join(op.replace.new);
    if (next === cur) return `replace 未命中（old 不在文件中）: ${rel}`;
    existing.set(rel, next);
    return null;
  }
  if (op.append) {
    // tf-append 语义：锚点插入（op.anchor 给定时替换 anchor → anchor+正文）或 EOF 追加。
    if (op.anchor) {
      const cur = existing.get(rel);
      if (cur === undefined) return `append 锚点目标不存在: ${rel}`;
      if (!cur.includes(op.anchor)) return `append 锚点未命中: ${rel}`;
      existing.set(rel, cur.replace(op.anchor, `${op.anchor}\n${op.append}`));
      return null;
    }
    const cur = existing.get(rel);
    existing.set(rel, cur === undefined ? op.append : `${cur}\n${op.append}`);
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
  let extractErrors = [];
  const skipped = [];
  if (arm === 'stream') {
    const probeFile = path.join(taskDir, 'probe', 'probe.jsonl');
    if (!fs.existsSync(probeFile)) return { taskId, error: 'probe.jsonl 不存在' };
    const probeLines = fs.readFileSync(probeFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { kind: 'PARSE_ERROR' }; } });
    ops = extractTfWritesFromChunks(probeLines);
    // 提取器自身的错误（未闭合/缺属性等）：报告"提取失败"，不得记成"回放通过"
    extractErrors = ops.filter((o) => o.__errors !== undefined).flatMap((o) => o.__errors);
    ops = ops.filter((o) => o.__errors === undefined);
  } else {
    const logPath = path.join(taskDir, 'session-log', 'session.v4.jsonl.zstd');
    if (!fs.existsSync(logPath)) return { taskId, error: 'session log 存档不存在' };
    const records = parseSessionLog(logPath);
    const extracted = extractNativeWrites(records);
    ops = extracted.ops;
    skipped.push(...extracted.skipped);
  }

  const errors = [...extractErrors];
  for (const op of ops) {
    const e = applyOp(op);
    if (e) errors.push(e);
  }
  flush(replDir);
  const manifest = workspaceManifest(replDir);
  fs.writeFileSync(path.join(replDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const wsManifest = JSON.parse(fs.readFileSync(path.join(taskDir, 'ws', 'manifest.json'), 'utf8'));
  const hashMatch = manifest.root === wsManifest.root;
  // M3 语义（alpha.1）：零写入任务在种子树 == 结果树时通过（不得因 0 操作判失败）；
  // 提取器出错 = "提取失败"（不通过）；哈希不一致 = 存在未回放的写入差异（不通过）。
  const pass = extractErrors.length === 0 && errors.length === 0 && hashMatch;
  const replay = {
    opsReplayed: ops.length, skipped, errors,
    replRoot: manifest.root,
    wsRoot: wsManifest.root,
    pass,
    note: extractErrors.length > 0
      ? `提取失败 ${extractErrors.length} 条（未闭合/缺属性等）：不记为回放通过`
      : errors.length > 0
        ? `回放应用出错 ${errors.length} 条`
        : ops.length === 0
          ? (hashMatch ? '零写入任务：种子树 == 结果树（通过，非"提取失败"）' : '零写入但树哈希不一致：存在未回放的写入差异')
          : (hashMatch ? '重放树哈希 == 实跑树哈希' : '哈希不一致，见 repl/ 与 ws/ manifest'),
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
