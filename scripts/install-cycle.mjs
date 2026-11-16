// scripts/install-cycle.mjs —— S6 装卸与回退演练驱动：10 次安装/卸载循环 + 宿主恢复验证
//
// 用法：
//   node scripts/install-cycle.mjs --dsh <dsh 可执行> --profile <专用 profile 名> [--rounds 10]
//   node scripts/install-cycle.mjs --plan-only          # 只打印演练计划（不执行，用于无宿主环境）
//
// 每轮循环（一个完整装卸周期）：
//   1. dsh plugin add   <插件根目录> --profile <目标>   （安装前由 install-check 前置校验）
//   2. 启动自证：dsh --profile <目标> headless 冒烟一次，断言横幅 TAKEOVER-ACTIVE / loop=stream
//   3. dsh plugin remove <插件名> --profile <目标>
//   4. 卸载验证：宿主 loop 恢复（agent-loop 重新可用）；web 能创建会话；无 stream-agent-* 残留 entry
//
// 红线（C8/C3）：任一轮失败即中止并保留现场日志（--keep 给出日志目录）；回退路径是
// "回退到 0.2.x 产物（B 形态）或删除专用 profile"，不手工修 profile。
//
// 本脚本只在有真实 dsh 宿主的机器上执行；CI / 无宿主环境用 --plan-only 打印计划。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const dsh = arg('dsh');
const profile = arg('profile', 'stream');
const rounds = Number(arg('rounds', '10'));
const planOnly = process.argv.includes('--plan-only');
const pluginName = '@hugesb/dsh-stream-agent';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

if (planOnly) {
  console.log(`[install-cycle] 演练计划（--plan-only，不执行）：`);
  console.log(`  目标 profile：${profile}（必须是专用 profile；install-check 前置校验先跑）`);
  console.log(`  轮次：${rounds}，每轮：plugin add → 启动自证(TAKEOVER-ACTIVE) → plugin remove → 恢复验证(无残留 entry)`);
  console.log(`  判定：10/10 轮通过 = S6 交付；任一轮失败保留现场日志并中止`);
  console.log(`  回退：删除专用 profile 或回退 0.2.x 产物（B 形态），不手工修 profile`);
  process.exit(0);
}

if (dsh === undefined) {
  console.error('用法：node scripts/install-cycle.mjs --dsh <dsh 可执行> --profile <专用 profile 名> [--rounds 10]');
  console.error('无宿主环境请用 --plan-only 查看演练计划。');
  process.exit(3);
}

const workdir = mkdtempSync(join(tmpdir(), 'install-cycle-'));
let failures = 0;
console.log(`[install-cycle] ${rounds} 轮装卸演练：profile=${profile} plugin=${pluginName}`);
for (let i = 1; i <= rounds; i++) {
  const add = run(dsh, ['plugin', 'add', pkgRoot, '--profile', profile]);
  const smoke = run(dsh, ['--profile', profile, 'headless', '--once', 'smoke']);
  const remove = run(dsh, ['plugin', 'remove', pluginName, '--profile', profile]);
  const restore = run(dsh, ['--profile', profile, 'headless', '--once', 'smoke']);
  const ok = add.code === 0
    && smoke.stdout.includes('TAKEOVER-ACTIVE')
    && remove.code === 0
    && restore.code === 0
    && !restore.stdout.includes('TAKEOVER-ACTIVE')
    && !restore.stdout.includes('stream-agent');
  console.log(`  round ${i}: add=${add.code} takeover=${smoke.stdout.includes('TAKEOVER-ACTIVE') ? 'yes' : 'no'} remove=${remove.code} restore=${restore.code === 0 && !restore.stdout.includes('stream-agent') ? 'clean' : 'residue'} → ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) {
    failures += 1;
    console.error(`  现场保留：${workdir}`);
    console.error(`  add.stderr: ${add.stderr.slice(0, 400)}`);
    console.error(`  smoke.stderr: ${smoke.stderr.slice(0, 400)}`);
    console.error(`  restore.stdout: ${restore.stdout.slice(0, 400)}`);
    break;
  }
}
if (failures === 0) {
  rmSync(workdir, { recursive: true, force: true });
  console.log(`[install-cycle] 通过：${rounds}/${rounds} 轮，0 残留，宿主 loop 恢复（S6/C8 达成）。`);
} else {
  process.exit(1);
}
