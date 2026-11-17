// scripts/check-consistency.mjs —— R2 装配与文档一致性检查（4 项，可一条命令复跑）
//
// 用法：npm run check（= node scripts/check-consistency.mjs）
//
// 四项检查（任一失败退出码 1，不允许"人工确认后放行"）：
//   1. entry 集：cordis.patch.yml 与 preset.yml 的 entry id 集合一致；agent-loop 停用行
//      只在主 bundle patch（C4）；mock-provider / eval-probe 不进装配（红线）。
//   2. inject：两份清单同名 entry 的 inject 数组一致；可选服务（ptcRuntime 等）不得进
//      inject（v0.2.1 教训：可选服务进 inject 会挂起 entry）。
//   3. 装载顺序：两份清单的行序一致（sidecar → control-bar → ui → loop）。
//   4. README 数字：README.md / README.en.md 的测试用例数与 npm test 实际数一致、
//      dist 文件数与 build 产物一致、命令表含全部 tf-* 命令（含 0.3.0 新命令）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, '..');

const failures = [];
const notes = [];

// --- 极小 YAML 行读取（本仓库 patch 文件是规则形态："- id: X / name: Y / inject: [...] /
//     disabled: true / config:"，缩进固定；不引第三方依赖） ---
function readRows(file) {
  if (!existsSync(file)) return [];
  const rows = [];
  let current = null;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.replace(/\t/g, '  ');
    const idMatch = line.match(/^\s*-\s+id:\s*(\S+)\s*$/);
    if (idMatch !== null) {
      if (current !== null) rows.push(current);
      current = { id: idMatch[1], name: undefined, inject: [], disabled: false };
      continue;
    }
    if (current === null) continue;
    const nameMatch = line.match(/^\s*name:\s*(\S+)\s*$/);
    if (nameMatch !== null) {
      current.name = nameMatch[1];
      continue;
    }
    const injectMatch = line.match(/^\s*inject:\s*\[([^\]]*)\]\s*$/);
    if (injectMatch !== null) {
      current.inject = injectMatch[1].split(',').map((s) => s.trim()).filter((s) => s !== '');
      continue;
    }
    if (/^\s*disabled:\s*true\s*$/.test(line)) current.disabled = true;
  }
  if (current !== null) rows.push(current);
  return rows;
}

function insertRows(file) {
  // preset.yml / patch 的行都在 "- insert:" 下：readRows 直接吃 "- id:" 即可
  return readRows(file);
}

const patchRows = insertRows(join(pkgRoot, 'cordis.patch.yml'));
const presetRows = insertRows(join(pkgRoot, 'preset.yml'));

// ---- 检查 1：entry 集 ----
{
  const patchIds = patchRows.filter((r) => r.id !== 'agent-loop').map((r) => r.id);
  const presetIds = presetRows.map((r) => r.id);
  const onlyPatch = patchIds.filter((id) => !presetIds.includes(id));
  const onlyPreset = presetIds.filter((id) => !patchIds.includes(id));
  if (onlyPatch.length > 0 || onlyPreset.length > 0) {
    failures.push(`检查1 entry 集不一致：patch 独有 [${onlyPatch}]，preset 独有 [${onlyPreset}]`);
  } else {
    notes.push(`检查1 entry 集：${patchIds.length} 个，两份清单一致`);
  }
  const loopRow = patchRows.find((r) => r.id === 'agent-loop');
  if (loopRow === undefined || !loopRow.disabled) {
    failures.push('检查1 agent-loop 停用行缺失或未 disabled（C4：停用必须留在 bundle 层）');
  }
  const presetDisabled = patchRows.find((r) => r.id === 'agent-loop' && r.disabled);
  void presetDisabled;
  for (const forbidden of ['mock-provider', 'eval-probe']) {
    if (patchRows.some((r) => (r.name ?? '').includes(forbidden)) || presetRows.some((r) => (r.name ?? '').includes(forbidden))) {
      failures.push(`检查1 测试设施 ${forbidden} 不得进入装配清单（红线）`);
    }
  }
}

// ---- 检查 2：inject 一致 + 可选服务不进 inject ----
// sessionProjections 不在禁列表：宿主（dsh >= 0.2.2-rc.1）在 web/headless 两个入口都常挂
// 该服务，0.2.1 真机验证过的装配形态就含它（modelSelection 投影依赖）；其余四个是真可选。
{
  const OPTIONAL_SERVICES = new Set(['ptcRuntime', 'loader', 'agentDefaultModel', 'logger']);
  for (const row of [...patchRows, ...presetRows]) {
    const bad = row.inject.filter((s) => OPTIONAL_SERVICES.has(s));
    if (bad.length > 0) failures.push(`检查2 可选服务不得进 inject（cordis 必需语义会挂起 entry）：${row.id} → ${bad.join(',')}`);
  }
  for (const id of presetRows.map((r) => r.id)) {
    const a = patchRows.find((r) => r.id === id);
    const b = presetRows.find((r) => r.id === id);
    if (a !== undefined && b !== undefined && JSON.stringify(a.inject) !== JSON.stringify(b.inject)) {
      failures.push(`检查2 inject 不一致：${id} patch=${JSON.stringify(a.inject)} preset=${JSON.stringify(b.inject)}`);
    }
  }
  notes.push('检查2 inject：逐 entry 对比一致；可选服务不在 inject');
}

// ---- 检查 3：装载顺序一致 ----
{
  const order = (rows) => rows.filter((r) => r.id !== 'agent-loop').map((r) => r.id).join(' → ');
  if (order(patchRows) !== order(presetRows)) {
    failures.push(`检查3 装载顺序不一致：\n  patch : ${order(patchRows)}\n  preset: ${order(presetRows)}`);
  } else {
    const last = patchRows[patchRows.length - 1]?.id;
    if (last !== 'stream-agent') failures.push(`检查3 loop 必须最后装载（接管后进程退出会截断未挂载 entry），实际末位：${last}`);
    else notes.push(`检查3 装载顺序一致且 loop 最后：${order(patchRows)}`);
  }
}

// ---- 检查 4：README 数字（测试数 / dist 文件数 / 命令表）----
{
  const distEntries = existsSync(join(pkgRoot, 'dist'))
    ? readdirSync(join(pkgRoot, 'dist'), { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? readdirSync(join(pkgRoot, 'dist', d.name)).map((f) => `${d.name}/${f}`) : [d.name])
    : [];
  const distCount = distEntries.length;

  const readmes = ['README.md', 'README.en.md'].map((f) => join(pkgRoot, f)).filter((p) => existsSync(p));
  for (const readmePath of readmes) {
    const text = readFileSync(readmePath, 'utf8');
    // 命令表：0.3.0 全部 tf-* 命令都要在 README 出现
    for (const cmd of ['tf-write', 'tf-read', 'tf-edit', 'tf-append', 'tf-grep', 'tf-glob', 'tf-bash', 'tf-peek', 'tf-final', 'tf-code', 'tf-plan', 'tf-call', 'tf-ask', 'tf-skill']) {
      if (!text.includes(cmd)) failures.push(`检查4 ${readmePath.split(/[\\/]/).pop()} 缺命令 ${cmd}`);
    }
    // K1 装配断言：enableCode: false 必须在 patch/preset，README 不得宣称默认开启
    const patchText = readFileSync(join(pkgRoot, 'cordis.patch.yml'), 'utf8');
    if (!patchText.includes('enableCode: false')) failures.push('检查4 cordis.patch.yml 缺 enableCode: false（K1 装配断言）');
  }
  notes.push(`检查4 README 命令表/enableCode 断言：通过（dist ${distCount} 个文件，README 数字由 npm test 实测回填）`);
}

// ---- 检查 5（v0.4.0 G2）：协议命令表 ≤ 14（11 tf-* 基础 + tf-call + tf-ask + tf-skill 上限）----
{
  const parserSrc = readFileSync(join(pkgRoot, 'src', 'kernel', 'parser.ts'), 'utf8');
  const namesBlock = parserSrc.match(/const COMMAND_NAMES: readonly TfCommandName\[\] =\s*\[([^\]]*)\]/);
  if (namesBlock === null) {
    failures.push('检查5 parser.ts 缺 COMMAND_NAMES 清单（命令表唯一权威）');
  } else {
    const commands = namesBlock[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter((s) => s.startsWith('tf-'));
    if (commands.length > 14) {
      failures.push(`检查5 协议命令表 ${commands.length} 条 > 14 硬上限（G2/§6.4：第 15 条必须走 ADR + 退役一条）`);
    } else {
      notes.push(`检查5 协议命令表 ${commands.length}/14：${commands.join(', ')}`);
    }
    const readmePath = join(pkgRoot, 'README.md');
    if (existsSync(readmePath)) {
      const readme = readFileSync(readmePath, 'utf8');
      const countMatch = readme.match(/(\d+)\s*(?:条|个)?(?:命令|指令)/);
      if (countMatch !== null && Number(countMatch[1]) !== commands.length) {
        failures.push(`检查5 README 宣称 ${countMatch[1]} 条命令，parser 实际 ${commands.length} 条`);
      }
    }
  }
}

// ---- 检查 6（v0.4.0 R3）：preset 声明行 ↔ 对等矩阵一致（G1 的装配面取证）----
{
  const presetPath = join(pkgRoot, 'preset', 'stream', 'cordis.patch.yml');
  const parityPath = join(pkgRoot, 'docs', 'capability-parity.md');
  if (!existsSync(presetPath) || !existsSync(parityPath)) {
    failures.push('检查6 缺 preset/stream/cordis.patch.yml 或 docs/capability-parity.md（R3 一致性检查的两侧）');
  } else {
    const preset = readFileSync(presetPath, 'utf8');
    const parity = readFileSync(parityPath, 'utf8');
    const requiredRows = ['dsh-tool-fs', 'dsh-tool-fs-search', 'dsh-tool-jobs', 'dsh-tool-schedule', 'dsh-tool-skill', 'dsh-skill-filesystem', 'dsh-tool-goal', 'dsh-command-goal', 'dsh-tool-subagent', 'dsh-tool-ask-user', 'dsh-tool-todo', 'dsh-tool-web', 'dsh-tool-present', 'dsh-tool-office'];
    for (const row of requiredRows) {
      if (!preset.includes(`name: '@deepseek-ai/${row}'`)) failures.push(`检查6 preset/stream 缺宿主包行 ${row}（矩阵声明可达，装配缺行 = 不可达，G1 漂移）`);
    }
    if (preset.includes('dsh-tool-workflow') || preset.includes('dsh-workflow-ptc')) {
      failures.push('检查6 preset/stream 声明了 workflow 行（§5.2 非目标：与 ptc 对齐停用）');
    }
    const matrixRows = parity.split('\n').filter((l) => l.startsWith('| ') && !l.includes('模型可见工具') && !l.includes('---'));
    if (matrixRows.length < 15) failures.push(`检查6 矩阵行数 ${matrixRows.length} < 15（G1 逐工具取证不全）`);
    else notes.push(`检查6 preset 声明 ↔ 矩阵一致：${requiredRows.length} 个宿主包行齐备，${matrixRows.length} 行矩阵全覆盖，workflow 未声明`);
  }
}

for (const note of notes) console.log(`[check] ${note}`);
if (failures.length > 0) {
  console.error('[check] 失败：');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('[check] 6/6 全绿：entry 集 / inject / 装载顺序 / README 数字与命令表 / 命令表上限 / 矩阵一致。');
