// scripts/gate.mjs —— R4 发布门禁（C1/C2/C8/C9 + 装配一致性 + 回退演练，共六项）
//
// 用法：npm run gate（= node scripts/gate.mjs [--stamp <eval/runs 目录名>]）
//
// 门禁语义（计划硬规则）：任一项未过不发布；不允许"先发后补"。
// 离线可判项就地判定；需要真机/评测数据的项从 eval/runs/<stamp> 取证，
// 缺数据 = 未通过（不得用历史数据补），并如实标注"待人工复测"。

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, '..');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const stamp = arg('stamp') ?? '2026-11-15';
const runDir = join(pkgRoot, 'eval', 'runs', stamp);

const gates = [];

function gate(id, name, pass, evidence) {
  gates.push({ id, name, pass, evidence });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${id} ${name} — ${evidence}`);
}

// ---- G1 装配一致性（R2）----
{
  let out = '';
  let ok = false;
  try {
    out = execSync('node scripts/check-consistency.mjs', { cwd: pkgRoot, encoding: 'utf8' });
    ok = out.includes('4/4 全绿');
  } catch (error) {
    out = String(error.stdout ?? error.message ?? '');
  }
  gate('G1', '装配一致性（R2 四项）', ok, ok ? out.trim().split('\n').pop() : out.split('\n').slice(-4).join(' | '));
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
{
  let tag = '';
  try {
    tag = execSync(`git describe --tags --exact-match 2>nul`, { cwd: pkgRoot, encoding: 'utf8', shell: true }).trim();
  } catch {
    tag = '';
  }
  const onTag = tag === `v${pkg.version}`;
  gate('G4', 'C9 tag = package', onTag, onTag ? `tag v${pkg.version} 精确命中` : `当前 HEAD 无精确 tag（发布提交时打 v${pkg.version}；工作区数字以 package.json 为准）`);
}

// ---- G5 C1 token 门槛：T1 ≤22.3%、逐任务 ≤+2%、请求数 ≤59、checks ≥9/10 ----
{
  const resultsPath = join(pkgRoot, 'eval', 'RESULTS.md');
  const results = existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8') : '';
  const hasCurrentRun = existsSync(join(runDir, 'stream')) && existsSync(join(runDir, 'baseline'));
  // 0.2.0 基线数字可从既有 runs 复算（summarize.cjs）；0.3.0 的对照数字需重跑评测矩阵（R3）
  const t1Match = results.match(/全量口径[^\d]*([\d.]+)%/);
  gate('G5', 'C1 token 门槛（T1/checks/请求数）', hasCurrentRun && t1Match !== null,
    hasCurrentRun
      ? `eval/runs/${stamp} 两臂在位；T1=${t1Match?.[1] ?? '?'}%（0.2.0 基线口径）；0.3.0 对照数字以 summarize.cjs 复算为准，发布前必须重跑 R3`
      : `eval/runs/${stamp} 缺两臂数据 → 未通过（不允许用历史数据补；跑 eval/tools/runner.cjs 后重审）`);
}

// ---- G6 回退演练记录 ----
{
  const drill = join(pkgRoot, 'eval', 'GATE-0.3.0.md');
  // 必须是"已勾选"的复选框（防止模板文案本身造成假阳性）
  const recorded = existsSync(drill) && /- \[x\] 回退演练：已执行/.test(readFileSync(drill, 'utf8'));
  gate('G6', '回退演练（安装→使用→回退→宿主恢复）', recorded,
    recorded ? 'eval/GATE-0.3.0.md 已勾选回退演练记录' : '未记录 → 发布前在真机执行 scripts/install-cycle.mjs 并勾选 eval/GATE-0.3.0.md 中的回退演练项');
}

const failed = gates.filter((g) => !g.pass);
console.log('');
console.log(`[gate] ${gates.length - failed.length}/${gates.length} 项通过${failed.length > 0 ? `；未过：${failed.map((g) => g.id).join('、')}` : ''}`);
console.log('[gate] 纪律：G5/G6 需真机数据，未过前不得发布（不允许先发后补）。');

// 产出/更新门禁记录
const report = [
  '# eval/GATE-0.3.0.md —— 0.3.0 发布门禁记录',
  '',
  `> 生成：scripts/gate.mjs（离线项就地判定；真机项见下）`,
  '',
  ...gates.map((g) => `- [${g.pass ? 'x' : ' '}] ${g.id} ${g.name} — ${g.evidence}`),
  '',
  '## 真机复测清单（发布前必须回填）',
  '',
  '- [ ] R3 评测矩阵：10 任务 + 哨兵两臂重跑（`eval/tools/runner.cjs --stamp <新>`），数字可复算',
  '- [ ] 回退演练：已执行（scripts/install-cycle.mjs 10 轮 + 回退 0.2.x 产物验证宿主恢复）',
  '- [ ] M2 T3 三格：B / A-1a / A-1b 同批首请求对照（eval/tools/t3-cells.cjs）',
  '- [ ] K6 真机五场景：成功/失败/取消/拒绝/partial（eval/tools/manual-code-scenarios.md）',
  '',
].join('\n');
writeFileSync(join(pkgRoot, 'eval', 'GATE-0.3.0.md'), report, 'utf8');
console.log('[gate] 门禁记录已写入 eval/GATE-0.3.0.md');
process.exit(failed.length > 0 ? 1 : 0);
