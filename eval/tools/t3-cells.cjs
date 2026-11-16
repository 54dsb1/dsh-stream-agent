// eval/tools/t3-cells.cjs —— M2 T3 三格基线（B / A-1a / A-1b 首请求拆分与归因）
//
// 用法：
//   node eval/tools/t3-cells.cjs --stamp <2026-11-15> [--cell-b baseline] [--cell-a1a stream] [--cell-a1b <目录>]
//
// 三格定义（升级方案 §3.2 / upgrade-plan v0.3.0-beta.1）：
//   B    = 既有 profile + 0.2.0 bundle（tf-code 现状开启）      —— eval/runs/<stamp>/baseline/
//   A-1a = stream profile + 显式开启 tf-code（复现 0.2.0 现状） —— eval/runs/<stamp>/stream/
//   A-1b = stream profile + 关闭 tf-code（K1 后的默认装配）     —— 需单独跑（--cell-a1b 指定目录）
//
// 判定规则：
//   1. A-1a 与 B 的首请求 messages 必须逐字节相等（装配没有引入额外提示面）；
//      不等 → 先定位差异来源（宿主注入/preset 行/配置覆盖），定位不了不得进入 K1。
//   2. A-1b 与 A-1a 的差值必须等于 tf-code 协议段的实测长度（字符 + token）。
//   3. 只有当 tf-code 段占 B 的 T3 ≥10% 时，才允许对外主张 "≤0.9×B"；否则如实写"持平"。
//
// 拆分口径：system 消息 = [系统提示 | 协议段(含 tf-code 段) | 工具 schema 文本 | 任务不变量]，
// 四部分之和 = 首请求 system 字符数；任务文本 = 首条 user 消息。

const fs = require('node:fs');
const path = require('node:path');

const PKG_ROOT = path.resolve(__dirname, '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

/** 从 probe.jsonl 取首请求（跳过标题旁路）的 options 原文 + 首个 usage。 */
function firstRequest(probePath) {
  if (!fs.existsSync(probePath)) return null;
  const lines = fs.readFileSync(probePath, 'utf8').split('\n').filter(Boolean);
  let firstOptions = null;
  let firstUsage = null;
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.kind === 'request' && firstOptions === null) {
      let opts;
      try { opts = JSON.parse(rec.options); } catch { continue; }
      // 标题旁路剔除（E5）
      const msgs = opts.messages || [];
      if (opts.maxTokens === 64 && msgs.length <= 2) continue;
      if (JSON.stringify(msgs).includes('Generate the session title')) continue;
      firstOptions = opts;
    }
    if (rec.kind === 'chunk' && firstUsage === null) {
      try {
        const c = JSON.parse(rec.chunk);
        if (c.type === 'usage') firstUsage = c.usage;
      } catch { /* 忽略 */ }
    }
    if (firstOptions !== null && firstUsage !== null) break;
  }
  return firstOptions === null ? null : { options: firstOptions, usage: firstUsage };
}

/** system 消息四段拆分：用内核常量做边界定位（导出自 dist/entry/loop.js）。 */
function splitSystem(systemText, constants) {
  const parts = {};
  const { DEFAULT_SYSTEM_PROMPT, DEFAULT_PROTOCOL_TEXT, DEFAULT_CODE_PROTOCOL_SECTION, DEFAULT_INVARIANTS } = constants;
  parts.systemPrompt = systemText.includes(DEFAULT_SYSTEM_PROMPT) ? DEFAULT_SYSTEM_PROMPT.length : 0;
  const codeLen = systemText.includes(DEFAULT_CODE_PROTOCOL_SECTION) ? DEFAULT_CODE_PROTOCOL_SECTION.length : 0;
  const protocolLen = systemText.includes(DEFAULT_PROTOCOL_TEXT) ? DEFAULT_PROTOCOL_TEXT.length : 0;
  parts.protocolWithoutCode = protocolLen;
  parts.codeSection = codeLen;
  parts.invariants = systemText.includes(DEFAULT_INVARIANTS) ? DEFAULT_INVARIANTS.length : 0;
  const known = parts.systemPrompt + protocolLen + (codeLen > 0 ? 2 : 0) + codeLen + 2 + parts.invariants;
  parts.toolSchemasAndGlue = Math.max(0, systemText.length - known);
  parts.totalChars = systemText.length;
  return parts;
}

function main() {
  const stamp = arg('stamp');
  if (stamp === undefined) { console.error('用法：node eval/tools/t3-cells.cjs --stamp <2026-11-15> [--cell-a1b <目录名>]'); process.exit(2); }
  const runDir = path.join(PKG_ROOT, 'eval', 'runs', stamp);
  // 内核常量（协议段边界）；从 dist 取（构建产物与真机装配一致）
  const loopDist = path.join(PKG_ROOT, 'dist', 'entry', 'loop.js');
  // 动态 import（CJS 里用 createRequire）；这些常量是协议文本的权威形态
  const { pathToFileURL } = require('node:url');
  const imported = awaitImport(loopDist);
  const constants = {
    DEFAULT_SYSTEM_PROMPT: imported.DEFAULT_SYSTEM_PROMPT,
    DEFAULT_PROTOCOL_TEXT: imported.DEFAULT_PROTOCOL_TEXT,
    DEFAULT_CODE_PROTOCOL_SECTION: imported.DEFAULT_CODE_PROTOCOL_SECTION,
    DEFAULT_INVARIANTS: imported.DEFAULT_INVARIANTS,
  };

  const tasks = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'eval', 'tasks', 'tasks.json'), 'utf8')).tasks;
  const cells = {};
  const cellDefs = [
    ['B', arg('cell-b', 'baseline')],
    ['A-1a', arg('cell-a1a', 'stream')],
  ];
  const a1bDir = arg('cell-a1b');
  if (a1bDir !== undefined) cellDefs.push(['A-1b', a1bDir]);

  for (const [cell, dir] of cellDefs) {
    const rows = {};
    let equalCount = 0;
    let compared = 0;
    for (const task of tasks) {
      const probePath = path.join(runDir, dir, task.id, 'probe', 'probe.jsonl');
      const first = firstRequest(probePath);
      if (first === null) { rows[task.id] = { missing: true }; continue; }
      const systemText = first.options.messages.find((m) => m.role === 'system')?.content?.map((b) => b.text ?? '').join('') ?? '';
      const userText = first.options.messages.filter((m) => m.role === 'user').map((m) => m.content.map((b) => b.text ?? '').join('')).join('\n');
      rows[task.id] = {
        systemChars: systemText.length,
        split: splitSystem(systemText, constants),
        userChars: userText.length,
        usage: first.usage,
        messagesHash: require('node:crypto').createHash('sha256').update(JSON.stringify(first.options.messages)).digest('hex').slice(0, 16),
      };
    }
    cells[cell] = { dir, tasks: rows };
    void equalCount; void compared;
  }

  // 逐任务对账：A-1a vs B 首请求逐字节相等
  console.log(`# T3 三格（stamp=${stamp}）\n`);
  console.log('| 任务 | B system | A-1a system | A-1b system | A-1a==B | B usage(全量) |');
  console.log('|---|---|---|---|---|---|');
  let byteEqual = 0;
  let compared = 0;
  for (const task of tasks) {
    const b = cells['B'].tasks[task.id];
    const a = cells['A-1a'].tasks[task.id];
    const ab = cells['A-1b']?.tasks[task.id];
    if (b?.missing || a?.missing) { console.log(`| ${task.id} | - | - | - | - | - |`); continue; }
    compared += 1;
    const equal = a.messagesHash === b.messagesHash;
    if (equal) byteEqual += 1;
    const usage = b.usage;
    const total = usage ? (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0) : null;
    console.log(`| ${task.id} | ${b.systemChars} | ${a.systemChars} | ${ab ? ab.systemChars : '未跑'} | ${equal ? '✓' : '✗ ' + a.messagesHash + '/' + b.messagesHash} | ${total ?? '?'} |`);
  }
  console.log(`\nA-1a == B（首请求逐字节）：${byteEqual}/${compared}`);
  const a1bDef = cells['A-1b'];
  if (a1bDef !== undefined) {
    let diffs = [];
    for (const task of tasks) {
      const a = cells['A-1a'].tasks[task.id];
      const ab = a1bDef.tasks[task.id];
      if (a?.missing || ab?.missing || ab === undefined) continue;
      diffs.push(ab.systemChars - a.systemChars);
    }
    const codeLen = constants.DEFAULT_CODE_PROTOCOL_SECTION.length;
    console.log(`A-1b − A-1a 差值：${diffs.join(', ')} 字符（tf-code 协议段实测 ${codeLen} 字符）`);
    console.log(`判定：${diffs.every((d) => d === -codeLen - 2) ? '差值 = code 段长度 ✓' : '差值与 code 段不符 → 先定位差异来源'}`);
  } else {
    console.log('A-1b：未提供（K1 切换后的装配跑一遍并传 --cell-a1b）；tf-code 段长度（代码事实）= ' + constants.DEFAULT_CODE_PROTOCOL_SECTION.length + ' 字符');
  }
  console.log('\nK1 门槛（升级方案 M2 判定规则）：tf-code 段占 B 的 T3 比例 = code 段 token / B 首请求 token；');
  console.log('≥10% 才可主张 "A-1b ≤ 0.9×B"，否则如实写"持平"。以本表逐任务值与同批 usage 复算。');
}

// CJS 里加载 ESM 构建产物
function awaitImport(absPath) {
  const req = require('node:module').createRequire(__filename);
  let mod = null;
  // Node 22+ 支持 require(esm)（构建产物是零依赖 ESM）
  try {
    mod = req(absPath);
  } catch {
    throw new Error(`无法加载 ${absPath}（请先 npm run build）`);
  }
  return mod;
}

main();
