#!/usr/bin/env node
// eval/tools/surface-baseline.cjs —— v0.4.0 P0：工具面对等基线度量（离线静态取证）
//
// 量什么（design §10 P0 / G1 判据的取证面）：
//   1. 对等矩阵：standard/ptc/stream 三份 preset 声明行 → 模型可达工具清单（逐行取证）；
//   2. schema 成本：standard 面每个工具的 parameters 段源文本字节数（近似下界——
//      description 多为运行时拼装（describe(...)），静态提取不到，如实标注"待真机复测"）；
//   3. stream 面的协议固定成本：dist 里的 DEFAULT_PROTOCOL_TEXT / CALL / CODE 段字符数。
//
// 口径纪律（METRICS.md 同款）：没有测量就不写百分比；本脚本产出可复算的原始数字，
// 真机 schema 成本（含 description 的运行时拼装）标注"待复测"，不用静态数字冒充。
//
// 用法：
//   node eval/tools/surface-baseline.cjs [--host-root <宿主 node_modules/@deepseek-ai>] [--json]
// 缺省 host-root 自动探测 appasar-extract（本机取证目录）；缺席时矩阵照出、schema 成本标 n/a。

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---- 对等矩阵（design §2.1 + preset/stream/cordis.patch.yml 0.4.0 行；取证 = patch 行名）----
// standard/ptc 的行来自 dsh-web-app/presets/{standard,ptc}.patch.yml；stream 来自本包 preset/stream。
const MATRIX = [
  // [模型可见工具名, standard 行, ptc 行, stream 通道（0.4.0）, 宿主包]
  ['read', 'tool-fs', 'tool-fs', 'tf-read / tf-call / native(core)', 'dsh-tool-fs'],
  ['write', 'tool-fs', 'tool-fs', 'tf-write / tf-call / native(core)', 'dsh-tool-fs'],
  ['edit', 'tool-fs', 'tool-fs', 'tf-edit / tf-call / native(core)', 'dsh-tool-fs'],
  ['apply_patch', '—(applyPatch:false)', '—(applyPatch:false)', 'tf-append(EOF 锚) / tf-call / native(core 流开 applyPatch:true)', 'dsh-tool-fs'],
  ['read_image', 'tool-fs', 'tool-fs', 'tf-call / native(standard/full)', 'dsh-tool-fs'],
  ['grep', 'tool-fs-search', 'tool-fs-search', 'tf-grep / tf-call / native(core)', 'dsh-tool-fs-search'],
  ['glob', 'tool-fs-search', 'tool-fs-search', 'tf-glob / tf-call / native(core)', 'dsh-tool-fs-search'],
  ['bash|pwsh', 'tool-bash|tool-pwsh', 'tool-bash|tool-pwsh', 'tf-bash / tf-call / native(core)', 'dsh-tool-bash|dsh-tool-pwsh'],
  ['job_list|job_output|job_kill', 'tool-jobs', 'tool-jobs', 'tf-call / native(standard/full)', 'dsh-tool-jobs'],
  ['schedule_create|schedule_edit|schedule_list|schedule_view', 'tool-schedule', 'tool-schedule', 'tf-call / native(standard/full)', 'dsh-tool-schedule'],
  ['skill', 'tool-skill', 'tool-skill', 'tf-call / native(standard/full)', 'dsh-tool-skill'],
  ['create_goal|get_goal|update_goal', 'tool-goal+command-goal', 'tool-goal+command-goal', 'tf-call / native(standard/full)', 'dsh-tool-goal'],
  ['exit_plan_mode', 'plan-mode 组', 'plan-mode 组', 'tf-plan 收束语义（不经宿主 plan-mode）；tf-call 需声明行', 'dsh-plan-mode'],
  ['subagent|subagent_fork', 'delegation 组', 'delegation 组', 'tf-call（delegation 组已声明，0.4.0 preset 行）', 'dsh-tool-subagent'],
  ['workflow', 'tool-workflow', 'disabled(ptc)', '不启用（§5.2 非目标：与 ptc 对齐）', 'dsh-tool-workflow'],
  ['ask_user_question', 'tool-ask-user', 'tool-ask-user', 'tf-call / native(standard/full)', 'dsh-tool-ask-user'],
  ['todo_write', 'tool-todo', 'tool-todo', 'tf-call / native(standard/full)', 'dsh-tool-todo'],
  ['web_search|web_fetch', 'tool-web', 'tool-web', 'tf-call / native(standard/full)', 'dsh-tool-web'],
  ['present', 'present', 'present', 'tf-call / native(standard/full)', 'dsh-tool-present'],
  ['office_convert|office_recalculate|office_render', 'tool-office', 'tool-office', 'tf-call / native(standard/full)', 'dsh-tool-office'],
  ['run_code', '—', 'tool-executor-ptc', 'tf-code（PTC 桥接；K1 默认关）', 'dsh-tool-executor-ptc'],
];

// ---- schema 源文本提取：宿主工具包 lib/index.js 里 defineTool({...}) 的 parameters 段 ----
function extractToolSchemas(hostRoot, packageName) {
  const file = path.join(hostRoot, packageName, 'lib', 'index.js');
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  let idx = 0;
  for (;;) {
    const start = src.indexOf('defineTool({', idx);
    if (start === -1) break;
    // 从 defineTool({ 起做花括号配对，拿整个字面量
    let depth = 0;
    let end = -1;
    for (let i = start + 'defineTool('.length; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) break;
    const literal = src.slice(start, end + 1);
    const nameMatch = literal.match(/\bname:\s*"([^"]+)"/);
    const paramMatch = literal.match(/\bparameters:\s*\{/);
    if (nameMatch !== null && paramMatch !== null) {
      // parameters 段长度：从 parameters:{ 到配对 }（括号计数）
      const pStart = paramMatch.index + 'parameters:'.length;
      let pDepth = 0;
      let pEnd = -1;
      for (let i = pStart; i < literal.length; i++) {
        const ch = literal[i];
        if (ch === '{') pDepth += 1;
        else if (ch === '}') {
          pDepth -= 1;
          if (pDepth === 0) { pEnd = i; break; }
        }
      }
      const paramsText = pEnd === -1 ? '' : literal.slice(pStart, pEnd + 1);
      const descMatch = literal.match(/\bdescription:\s*(describe\([^)]*\)|`[^`]*`|"[^"]*")/);
      out.push({
        name: nameMatch[1],
        paramsBytes: Buffer.byteLength(paramsText, 'utf8'),
        descriptionKind: descMatch === null ? 'literal' : (descMatch[1].startsWith('describe(') ? 'runtime-composed(静态不可提取)' : 'literal'),
        descriptionBytes: descMatch === null ? 0 : Buffer.byteLength(descMatch[1], 'utf8'),
      });
    }
    idx = end + 1;
  }
  return out;
}

/** stream 侧固定协议段字符数（权威口径 = src 模块导入实测，不用 dist 文本切片）。
 *  子进程跑 node --experimental-strip-types 导入 src/entry/loop.ts；失败返回错误占位。 */
function measureProtocolTexts() {
  const { spawnSync } = require('node:child_process');
  const { pathToFileURL } = require('node:url');
  const entryUrl = pathToFileURL(path.join(__dirname, '..', '..', 'src', 'entry', 'loop.ts')).href;
  const script = `import(${JSON.stringify(entryUrl)}).then((m) => console.log(JSON.stringify({ SYSTEM: m.DEFAULT_SYSTEM_PROMPT.length, PROTOCOL: m.DEFAULT_PROTOCOL_TEXT.length, CALL: (m.DEFAULT_CALL_PROTOCOL_SECTION ?? '').length, CODE: (m.DEFAULT_CODE_PROTOCOL_SECTION ?? '').length, INVARIANTS: m.DEFAULT_INVARIANTS.length })))`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000, cwd: path.join(__dirname, '..', '..') });
  if (res.status !== 0) return { error: (res.stderr || 'import failed').split('\n')[0] };
  try {
    return JSON.parse(res.stdout.trim());
  } catch {
    return { error: 'unparsable output' };
  }
}

function main() {
  const args = process.argv.slice(2);
  const wantJson = args.includes('--json');
  const rootIdx = args.indexOf('--host-root');
  const candidates = [
    rootIdx >= 0 ? args[rootIdx + 1] : null,
    'D:/AIagentoutput/zcode/010-harness/scratch/appasar-extract/dsh/node_modules/@deepseek-ai',
  ].filter(Boolean);
  const hostRoot = candidates.find((p) => fs.existsSync(p)) ?? null;

  const packages = [...new Set(MATRIX.flatMap((row) => (row[4] ?? '').split('|').filter((p) => p !== '' && !p.startsWith('dsh-plan-mode'))))];
  const schemaStats = {};
  for (const pkg of packages) {
    const extracted = hostRoot === null ? null : extractToolSchemas(hostRoot, pkg);
    if (extracted !== null && extracted.length > 0) schemaStats[pkg] = extracted;
  }

  const protocolTexts = measureProtocolTexts();

  const report = {
    stamp: new Date().toISOString(),
    hostRoot,
    matrix: MATRIX.map(([tools, standard, ptc, stream, pkg]) => ({ tools, standard, ptc, stream4: stream, packages: pkg })),
    schemaStats: hostRoot === null ? { note: 'host-root 缺席：schema 成本未测量（矩阵照常）' } : schemaStats,
    protocolTexts,
    notes: [
      'paramsBytes = 宿主 lib 源码里 parameters 字面量的 UTF-8 字节数（JSON 序列化后与此同量级；近似下界）',
      'descriptionKind=runtime-composed 的工具（todo_write 等）描述文本静态不可提取，真机 schema 成本待复测',
      '对等判定看"通道"列：tf-call 是全量可达通道（G1），native(core) 只在 nativeTools:true 时声明',
    ],
  };

  if (wantJson) {
    process.stdout.write(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`# surface-baseline @ ${report.stamp}  hostRoot=${hostRoot ?? '(缺席)'}`);
  console.log('');
  console.log('## 对等矩阵（G1：stream 列每格有通道即有路径）');
  for (const row of report.matrix) console.log(`| ${row.tools} | ${row.standard} | ${row.ptc} | ${row.stream4} |`);
  console.log('');
  console.log('## schema 源文本成本（parameters 字面量字节；description 运行时拼装待真机复测）');
  for (const [pkg, tools] of Object.entries(schemaStats)) {
    console.log(`### ${pkg}`);
    for (const t of tools) console.log(`- ${t.name}: params ${t.paramsBytes}B, desc(${t.descriptionKind}) ${t.descriptionBytes}B`);
  }
  console.log('');
  console.log('## stream 固定协议段（字符）');
  for (const [k, v] of Object.entries(protocolTexts)) console.log(`- ${k}: ${v}`);
}

main();
