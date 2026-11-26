// scripts/gate.mjs —— R4 发布门禁（C1/C2/C8/C9 + 装配一致性 + 回退演练，共六项）
//
// 用法：npm run gate -- [--stamp <eval/runs 目录名>] [--offline]
//
// 门禁语义（计划硬规则）：任一项未过不发布；不允许"先发后补"。
// 离线可判项就地判定；需要真机/评测数据的项从 eval/runs/<stamp> 与四臂产物取证，
// 缺数据 = 未通过（不得用历史数据补），并如实标注"待人工复测"。
//
// 记录文件 eval/GATE-<version>.md：自动项每次重判，真机项保留既有勾选（不覆盖人工记录）。

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, '..');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

// --offline：只跑与发布状态无关的离线装配不变量（G1–G3），供 CI 使用。
// G4 断言"HEAD 精确 tagged"，只在发布提交上成立，日常提交必然为假——由发布流程自己守；
// G5/G6 需真机数据，离线模式既不判定也不改写记录文件。
const offlineOnly = process.argv.includes('--offline');

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
// 不设默认 stamp：旧默认值（某个固定日期）会让门禁静默指向历史批次，
// 与"缺数据 = 未通过、不得用历史数据补"直接冲突。发布必须显式指定本次批次。
const stamp = arg('stamp');
const runDir = stamp ? join(pkgRoot, 'eval', 'runs', stamp) : null;
const recordPath = join(pkgRoot, 'eval', `GATE-${pkg.version}.md`);

const gates = [];

function gate(id, name, pass, evidence) {
  gates.push({ id, name, pass, evidence });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name} — ${evidence}`);
}

// ---- G1 装配一致性（R2 + G2/R3 + NOTICE）----
// 项数从脚本输出解析，不在门禁里硬编码：检查项增加时断言自动跟随，
// 避免"脚本绿、门禁红"的自锁（回归：check 扩到 7 项后此处曾恒 FAIL）。
{
  let out = '';
  let nums = null;
  let ok = false;
  try {
    out = execSync('node scripts/check-consistency.mjs', { cwd: pkgRoot, encoding: 'utf8' });
    nums = out.match(/(\d+)\/(\d+)\s*全绿/);
    ok = nums !== null && nums[1] === nums[2];
  } catch (error) {
    out = String(error.stdout ?? error.message ?? '');
  }
  const total = nums?.[2] ?? '?';
  gate('G1', `装配一致性（${total} 项全绿）`, ok,
    ok ? out.trim().split('\n').pop() : out.split('\n').slice(-4).join(' | '));
}

// ---- G2 C2 单 loop 权威：E_DOUBLE_LOOP 具名失败（单测覆盖 + patch 结构）----
{
  const patch = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8');
  const loopDisabled = patch.includes('- id: agent-loop') && patch.includes('disabled: true');
  const loopLast = patch.indexOf('agent-loop') < patch.lastIndexOf('stream-agent');
  const hasNamedError = readFileSync(join(pkgRoot, 'src', 'entry', 'loop.ts'), 'utf8').includes('E_DOUBLE_LOOP');
  gate('G2', 'C2 单 loop 权威（agent-loop 停用 + E_DOUBLE_LOOP 具名）', loopDisabled && loopLast && hasNamedError,
    `agent-loop 停用行=${loopDisabled}，loop entry 最后装载=${loopLast}，具名诊断=${hasNamedError}（单测 test/activation.test.ts）`);
}

// ---- G3 C8 零残留结构（卸载原子性：停用只在 bundle 层）----
{
  const profilePatch = join(pkgRoot, 'profiles', 'stream', 'cordis.patch.yml');
  const profileText = existsSync(profilePatch) ? readFileSync(profilePatch, 'utf8') : '';
  // 只查停用行/接管行本身（注释里的"agent-loop"字样不算装配行）
  const noDisableInProfile = !/^\s*-\s+id:\s*agent-loop/m.test(profileText) && !/^\s*-\s+id:\s*stream-agent/m.test(profileText);
  gate('G3', 'C8 卸载原子（停用只在 bundle 层；profile patch 无接管行）', noDisableInProfile,
    `profiles/stream/cordis.patch.yml 无 agent-loop 行=${noDisableInProfile}（真机装卸回归：scripts/install-cycle.mjs，待人工复测）`);
}

// ---- G4 C9 版本可追溯：tag = package ----
if (offlineOnly) {
  console.log('[SKIP] G4 C9 tag = package — --offline 模式不判定（只在发布提交上成立）');
} else {
  let tag = '';
  try {
    tag = execSync(`git describe --tags --exact-match 2>nul`, { cwd: pkgRoot, encoding: 'utf8', shell: true }).trim();
  } catch {
    tag = '';
  }
  const onTag = tag === `v${pkg.version}`;
  gate('G4', 'C9 tag = package', onTag, onTag ? `tag v${pkg.version} 精确命中` : `当前 HEAD 无精确 tag（发布提交时打 v${pkg.version}；工作区数字以 package.json 为准）`);
}

// ---- G5 C1 对照数据：0.4.x 两口径可复算 + 0.5.0 四臂 H1/H2 有结论 ----
// §12.2 硬规则：结论必须同时给严格二分量与四分量；§12.3-2 要求四臂完成且 H1/H2 有明确结论（含被证伪）。
if (offlineOnly) {
  console.log('[SKIP] G5 C1 对照数据 — --offline 模式不判定（需真机评测数据）');
} else {
  const resultsPath = join(pkgRoot, 'eval', 'RESULTS.md');
  const results = existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8') : '';
  // 数字里带千分位与中间等号（"129,178 / 446,410 = 28.9%"），旧正则要求"全量口径"后紧跟数字，实际匹配不到。
  const fourPart = results.match(/全量口径[^\n]*?([\d.]+)%/);
  const strictPart = results.match(/严格二分量[^\n]*?([\d.]+)%/);
  const hasMatrix = runDir !== null && existsSync(join(runDir, 'stream')) && existsSync(join(runDir, 'baseline'));

  // 四臂真机产物：eval/runs/four-arm-*.json 且 schema 为 four-arm-real/*、verdict 同时给出 h1 与 h2。
  let fourArm = null;
  const runsDir = join(pkgRoot, 'eval', 'runs');
  if (existsSync(runsDir)) {
    for (const name of readdirSync(runsDir).filter((n) => /^four-arm-.*\.json$/.test(n))) {
      try {
        const data = JSON.parse(readFileSync(join(runsDir, name), 'utf8'));
        const verdict = data.verdict;
        if (typeof data.schema === 'string' && data.schema.startsWith('four-arm-real') && verdict?.h1 && verdict?.h2) {
          fourArm = { file: name, h1: verdict.h1, h2: verdict.h2 };
        }
      } catch {
        // 坏文件不阻断门禁判定，只是不作为取证
      }
    }
  }

  const pass = hasMatrix && fourPart !== null && strictPart !== null && fourArm !== null;
  const evidence = [
    stamp === undefined ? '未指定 --stamp（发布必须显式指定本次批次目录，缺省不取历史批次）' : `eval/runs/${stamp} 两臂在位=${hasMatrix}`,
    `两口径可复算：四分量=${fourPart?.[1] ?? '缺'}%、严格二分量=${strictPart?.[1] ?? '缺'}%`,
    fourArm === null
      ? '四臂真机产物缺失（需 eval/runs/four-arm-<stamp>.json，schema=four-arm-real/*，verdict.h1/h2 均已判定）'
      : `四臂=${fourArm.file}（H1 ${fourArm.h1}；H2 ${fourArm.h2}）`,
  ].join('；');
  gate('G5', 'C1 对照数据（0.4.x 两口径 + 四臂 H1/H2）', pass, evidence);
}

// ---- G6 回退演练（§12.3-3：每项新能力可独立回退）----
// 九项开关由 eval/tools/rollback-drill.mjs 映射到具名用例并产出 rollback-<stamp>.json，
// 门禁只消费该产物（不重复跑套件）；安装/卸载/回退循环需真机，保留人工勾选。
const ROLLBACK_SWITCH_IDS = [
  'channel-standard',
  'tier-standard',
  'effectElision-false',
  'surfaceCompaction-false',
  'spanLedger-false',
  'peekIndex-false',
  'prefixPolicy-fail',
  'surfacePolicy-profile',
  'limits-off',
];
const SWITCH_LABEL = {
  'channel-standard': "channel: 'standard'",
  'tier-standard': "tier: 'standard'",
  'effectElision-false': 'effectElision: false',
  'surfaceCompaction-false': 'surfaceCompaction: false',
  'spanLedger-false': 'spanLedger: false',
  'peekIndex-false': 'peekIndex: false',
  'prefixPolicy-fail': "prefixPolicy: 'fail'",
  'surfacePolicy-profile': "surfacePolicy: 'profile'",
  'limits-off': 'maxSteps / maxInputTokens 取消',
};
const MANUAL_ITEMS = [
  ['安装-回退循环', 'scripts/install-cycle.mjs 10 轮 + 回退 0.4.0 产物验证宿主恢复（真机）'],
  ['R3 评测矩阵', '10 任务 + 哨兵两臂重跑（eval/tools/runner.cjs --stamp <新>），数字可复算'],
  ['四臂 benchmark', 'L0–L3 真机，产物写入 eval/runs/four-arm-<stamp>.json（判定见 G5）'],
  ['M2 T3 三格', 'B / A-1a / A-1b 同批首请求对照（eval/tools/t3-cells.cjs）'],
  ['K6 真机五场景', '成功/失败/取消/拒绝/partial（eval/tools/manual-code-scenarios.md）'],
];

/** 递归取目录下最新 mtime（毫秒）；用于判定演练产物是否早于最近一次源码/测试改动。 */
function newestMtime(dir) {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
    else if (/\.(ts|js|json|yml)$/.test(entry.name)) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

/** 取最新的回退演练产物，并校验：schema、九项齐全、全通过、不早于最近改动。 */
function readRollbackDrill() {
  const dir = join(pkgRoot, 'eval', 'runs');
  if (!existsSync(dir)) return { ok: false, reason: 'eval/runs 不存在（先跑 node eval/tools/rollback-drill.mjs）' };
  const files = readdirSync(dir).filter((n) => /^rollback-.*\.json$/.test(n)).sort();
  if (files.length === 0) return { ok: false, reason: '无 rollback-*.json（先跑 node eval/tools/rollback-drill.mjs）' };
  const file = files[files.length - 1];
  let data;
  try {
    data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch {
    return { ok: false, reason: `${file} 解析失败` };
  }
  if (data.schema !== 'rollback-drill/1') return { ok: false, reason: `${file} schema=${data.schema}` };
  const got = new Set((data.switches ?? []).map((s) => s.id));
  const missingIds = ROLLBACK_SWITCH_IDS.filter((id) => !got.has(id));
  if (missingIds.length > 0) return { ok: false, reason: `${file} 缺项：${missingIds.join('、')}` };
  if (data.allPass !== true) {
    const failing = (data.switches ?? []).filter((s) => !s.pass).map((s) => s.id);
    return { ok: false, file, data, reason: `${file} 未全过：${failing.join('、')}` };
  }
  const generated = Date.parse(data.generatedAt ?? '');
  const newest = Math.max(newestMtime(join(pkgRoot, 'src')), newestMtime(join(pkgRoot, 'test')));
  if (!Number.isFinite(generated)) return { ok: false, file, data, reason: `${file} 缺 generatedAt` };
  if (generated < newest) {
    return { ok: false, file, data, reason: `${file} 早于最近一次 src/test 改动（产物过期，重跑演练）` };
  }
  return { ok: true, file, data };
}

// 读取既有记录中已勾选的人工项（按"项目名"匹配），重写时保留，避免覆盖人工工作。
function readChecked() {
  const set = new Set();
  if (!existsSync(recordPath)) return set;
  const text = readFileSync(recordPath, 'utf8');
  const at = text.indexOf('## 真机复测清单');
  if (at < 0) return set;
  // 按 CRLF/LF 双兼容切分：Windows 工作树（git autocrlf 或编辑器）会写入 \r\n，
  // 直接用 $ 锚定的正则匹配不到行尾，会导致已有勾选被静默清空。
  for (const line of text.slice(at).split(/\r?\n/)) {
    const hit = line.match(/^- \[x\] ([^—]+?)(?:\s+—\s+.*)?$/);
    if (hit) set.add(hit[1].trim().replace(/^`|`$/g, ''));
  }
  return set;
}

const checked = readChecked();
const missingManual = MANUAL_ITEMS.map(([k]) => k).filter((k) => !checked.has(k));

let drill = { ok: false, reason: '离线模式未判定' };
if (offlineOnly) {
  console.log('[SKIP] G6 回退演练 — --offline 模式不判定（九项开关需演练产物，安装循环需真机）');
} else {
  drill = readRollbackDrill();
  const switchPass = ROLLBACK_SWITCH_IDS.filter((id) => drill.ok || (drill.data?.switches ?? []).some((s) => s.id === id && s.pass)).length;
  const pass = drill.ok && missingManual.length === 0;
  const parts = [
    drill.ok
      ? `九项开关 ${switchPass}/${ROLLBACK_SWITCH_IDS.length} 通过（${drill.file}，生成 ${drill.data.generatedAt}；驱动级离线）`
      : `九项开关未取证：${drill.reason}`,
    missingManual.length === 0
      ? '真机项已勾选'
      : `真机项未勾选 ${missingManual.length}/${MANUAL_ITEMS.length}：${missingManual.join('、')}`,
  ];
  gate('G6', '回退演练（九项开关 + 安装循环）', pass, parts.join('；'));
}

const failed = gates.filter((g) => !g.pass);
console.log('');
if (offlineOnly) {
  console.log(`[gate] 离线装配不变项 ${gates.length - failed.length}/${gates.length} 通过（G4/G5/G6 未判定；CI 只守离线不变量）`);
  process.exit(failed.length > 0 ? 1 : 0);
}
console.log(`[gate] ${gates.length - failed.length}/${gates.length} 项通过${failed.length > 0 ? `；未过：${failed.map((g) => g.id).join('、')}` : ''}`);
console.log('[gate] 纪律：G5/G6 需真机数据，未过前不得发布（不允许先发后补）。');

// 产出/更新门禁记录：自动项重判，真机项保留既有勾选。
const switchLines = ROLLBACK_SWITCH_IDS.map((id) => {
  const hit = (drill.data?.switches ?? []).find((s) => s.id === id);
  const mark = hit?.pass === true ? 'x' : ' ';
  const detail = hit === undefined ? '未取证' : (hit.pass ? 'PASS' : 'FAIL');
  const file = drill.file ?? 'rollback-<stamp>.json';
  return `- [${mark}] ${SWITCH_LABEL[id]} — ${detail}（${file}；${hit?.expect ?? '待演练'}）`;
});
const report = [
  `# eval/GATE-${pkg.version}.md —— ${pkg.version} 发布门禁记录`,
  '',
  `> 生成：scripts/gate.mjs（自动项每次重判；真机项保留既有勾选，不覆盖人工记录）`,
  '',
  '## 自动项',
  '',
  ...gates.map((g) => `- [${g.pass ? 'x' : ' '}] ${g.id} ${g.name} — ${g.evidence}`),
  '',
  '## 回退开关逐项（§12.4，九项；产物 eval/runs/rollback-<stamp>.json）',
  '',
  ...switchLines,
  '',
  '## 真机复测清单（发布前必须回填）',
  '',
  ...MANUAL_ITEMS.map(([k, d]) => `- [${checked.has(k) ? 'x' : ' '}] ${k} — ${d}`),
  '',
].join('\n');
writeFileSync(recordPath, report, 'utf8');
console.log(`[gate] 门禁记录已写入 eval/GATE-${pkg.version}.md`);
process.exit(failed.length > 0 ? 1 : 0);
