// eval/tools/rollback-drill.mjs —— §12.4 回退开关逐项演练（驱动级，离线）
//
// 做什么：跑一遍测试套件（TAP），把九项回退开关各自映射到具名用例，
// 逐项给出"关闭后行为"的通过/失败，并写成机器可读产物 eval/runs/rollback-<stamp>.json。
//
// 为什么映射而不是另写脚本：每项开关的"关闭后行为"已经在对应用例里被断言成
// 具体形态（消息序列、注入行、工具面、限流记录）。演练要证明的是"这些断言今天仍然成立"，
// 因此判据 = 映射到的用例全部 PASS，且映射本身有效（找不到用例即判失败，防止映射腐烂）。
//
// 边界（如实标注，不冒充）：本脚本是**驱动级**证据，不覆盖真机安装/卸载/回退循环
// （那一步走 scripts/install-cycle.mjs，产物在 eval/GATE-<ver>.md 勾选）。
//
// 用法：
//   node eval/tools/rollback-drill.mjs [--stamp 2026-11-23] [--tap <已有 tap 文件>]
// 产物：
//   eval/runs/rollback-<stamp>.json   （schema=rollback-drill/1）

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const stamp = arg('stamp') ?? new Date().toISOString().slice(0, 10);
const tapPath = arg('tap');

// §12.4 九项（id / 计划书写法 / 关闭后应当成立 / 具名用例映射）
const SWITCHES = [
  {
    id: 'channel-standard',
    plan: "channel: 'standard'",
    expect: '代码通道不启用：回退标准通道后可验证，标准通道工具路径可用',
    cases: ['R1. channel=code 无来源：回退 standard', 'S5. tf-call E2E'],
  },
  {
    id: 'tier-standard',
    plan: "tier: 'standard'",
    expect: '数值回默认：maxSteps 24 / maxInputTokens 20k / peek 24k / keepRecent 30 / 摘要 16k',
    cases: ['档位数值（§4.2 表）'],
  },
  {
    id: 'effectElision-false',
    plan: 'effectElision: false',
    expect: '保留程序全文：不产生 [applied pN]，幂等重发仍回灌原始结果',
    cases: ['E2. 回退点：effectElision=false'],
  },
  {
    id: 'surfaceCompaction-false',
    plan: 'surfaceCompaction: false',
    expect: '不压缩：无摘要、无 context-rebased，消息序列保持原样',
    cases: ['C3. 回退点：surfaceCompaction=false'],
  },
  {
    id: 'spanLedger-false',
    plan: 'spanLedger: false',
    expect: '无重复抑制：重复读取恒回正文（行为等价 0.4.x）',
    cases: ['S4. 回退点：spanLedger=false'],
  },
  {
    id: 'peekIndex-false',
    plan: 'peekIndex: false',
    expect: '回到头部截断：大文件不再投行锚索引',
    cases: ['R3. maxReadChars（读取侧）'],
  },
  {
    id: 'prefixPolicy-fail',
    plan: "prefixPolicy: 'fail'",
    expect: '绝不换基：append-drift 也 fail-closed，违约必报错',
    cases: ['P2. 真实漂移（append-drift）预算内放行一次；prefixPolicy=fail'],
  },
  {
    id: 'surfacePolicy-profile',
    plan: "surfacePolicy: 'profile'",
    expect: '0.4.x 工具面：走 core 白名单过滤',
    cases: ['S11. nativeTools 开启：reserved-only 全量透传；profile 档'],
  },
  {
    id: 'limits-off',
    plan: 'maxSteps / maxInputTokens 取消（置 0）',
    expect: '无上限（仅观测告警）：不压缩、不收束，长任务不中断',
    cases: ['G1. shouldCompact', 'G2. shouldStopForSteps'],
  },
];

// ---------------------------------------------------------------------------
// 跑测试并解析 TAP
// ---------------------------------------------------------------------------

function runSuite() {
  if (tapPath !== undefined) {
    if (!existsSync(tapPath)) throw new Error(`--tap 指定的文件不存在：${tapPath}`);
    return readFileSync(tapPath, 'utf8');
  }
  try {
    return execSync('node --test --test-reporter=tap "test/*.test.ts" "test/kernel/*.test.ts"', {
      cwd: pkgRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // 有用例失败时 --test 仍会输出完整 TAP，只是退出码非 0——TAP 才是判据
    const out = String(error.stdout ?? '');
    if (out.includes('ok ') || out.includes('not ok ')) return out;
    throw error;
  }
}

/** 解析 TAP：收集 (name, pass)。SKIP 记为 skipped（不算通过也不算失败，由映射判定要求）。 */
function parseTap(tap) {
  const results = [];
  for (const line of tap.split(/\r?\n/)) {
    // 嵌套子测试在 TAP 里有缩进（describe 内的用例），必须允许前导空白，否则只解析到顶层套件。
    const hit = /^\s*(not ok|ok)\s+\d+\s+-\s+(.*)$/.exec(line.trimEnd());
    if (hit === null) continue;
    const pass = hit[1] === 'ok';
    let name = hit[2].trim();
    const skip = /#\s*SKIP\b.*$/i.exec(name);
    if (skip !== null) name = name.slice(0, skip.index).trim();
    results.push({ name, pass, skipped: skip !== null });
  }
  return results;
}

const tap = runSuite();
const results = parseTap(tap);
const summary = {
  tests: results.length,
  pass: results.filter((r) => r.pass && !r.skipped).length,
  fail: results.filter((r) => !r.pass).length,
  skipped: results.filter((r) => r.skipped).length,
};
if (summary.tests === 0) {
  console.error('[drill] 未能解析到任何用例——TAP 输出形态变了？拒绝产出空记录。');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 逐项判定
// ---------------------------------------------------------------------------

const switches = SWITCHES.map((sw) => {
  const cases = sw.cases.map((pattern) => {
    const matched = results.filter((r) => r.name.includes(pattern));
    const failing = matched.filter((r) => !r.pass);
    const pass = matched.length > 0 && failing.length === 0;
    return {
      pattern,
      matched: matched.map((r) => r.name),
      pass,
      reason: matched.length === 0 ? '映射失效：套件中找不到该用例（用例改名后必须同步本映射）' : (failing.length > 0 ? `用例失败：${failing.map((r) => r.name).join('；')}` : ''),
    };
  });
  const pass = cases.every((c) => c.pass);
  return { id: sw.id, plan: sw.plan, expect: sw.expect, pass, cases };
});

const allPass = switches.every((s) => s.pass);
const report = {
  schema: 'rollback-drill/1',
  generatedAt: new Date().toISOString(),
  level: 'driver-offline',
  note: '驱动级回退演练（离线，mock 流驱动真实驱动器）。不覆盖真机安装/卸载/回退循环——那一步走 scripts/install-cycle.mjs，记录在 eval/GATE-<ver>.md。',
  suite: summary,
  switches,
  allPass,
};

const outDir = join(pkgRoot, 'eval', 'runs');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `rollback-${stamp}.json`);
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

for (const sw of switches) {
  console.log(`[${sw.pass ? 'PASS' : 'FAIL'}] ${sw.id}（${sw.plan}）— ${sw.expect}`);
  for (const c of sw.cases) {
    if (!c.pass) console.log(`        ├ ${c.pattern} → ${c.reason}`);
  }
}
console.log('');
console.log(`[drill] 套件：${summary.tests} 用例 / ${summary.pass} pass / ${summary.fail} fail / ${summary.skipped} skip`);
console.log(`[drill] 九项开关：${switches.filter((s) => s.pass).length}/${switches.length} 通过；产物 eval/runs/rollback-${stamp}.json`);
process.exit(allPass ? 0 : 1);
