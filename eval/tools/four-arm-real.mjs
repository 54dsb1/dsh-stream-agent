// eval/tools/four-arm-real.mjs —— 四臂真机跑批（§12.1/§12.3）
//
// 四臂（每条臂 = 一个 headless profile 上的 patch 覆盖层）：
//   L0 原生         patches/eval-baseline.yml     无插件，standard 工具面
//   L1 PTC          patches/eval-ptc.yml          仅 PTC 执行器，无本插件
//   L2 标准通道     patches/eval-stream.yml       本插件 + 标准通道
//   L3 代码通道     patches/eval-stream-ptc.yml   本插件 + PTC 执行器 + channel=code
//
// 执行复用了已验证的取证管线：每臂每任务调一次 eval/tools/runner.cjs（--patch 覆盖），
// 由它负责 seed、探针、session log 归档、metrics.json。本脚本只做编排 + 投影 + 判据。
//
// 用法：
//   node eval/tools/four-arm-real.mjs --plan                       只打印将要执行的命令（零请求）
//   node eval/tools/four-arm-real.mjs --stamp 2026-11-24           真机跑批（需 DEEPSEEK_API_KEY）
//   node eval/tools/four-arm-real.mjs --from-run 2026-11-24        从已落盘的 metrics 聚合（不重跑）
//   node eval/tools/four-arm-real.mjs --recompute eval/runs/four-arm-x.json   只重算判据
//
// 缺凭据 = 不产出结论（exit 3），绝不写"数据不足"伪装成跑过。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeVerdict } from './four-arm-verdict.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function arg(name, def = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes(`--${name}`);

const ARMS = [
  { id: 'L0', patch: 'patches/eval-baseline.yml', desc: '原生（无插件）' },
  { id: 'L1', patch: 'patches/eval-ptc.yml', desc: 'PTC 执行器（无插件）' },
  { id: 'L2', patch: 'patches/eval-stream.yml', desc: '本插件 · 标准通道' },
  { id: 'L3', patch: 'patches/eval-stream-ptc.yml', desc: '本插件 · 代码通道' },
];

const stamp = arg('stamp', new Date().toISOString().slice(0, 10));
const tasksArg = arg('tasks', 'all');
const timeout = arg('timeout', '900');
const key = arg('key', '') || process.env.DEEPSEEK_API_KEY || '';
const runDir = join(pkgRoot, 'eval', 'runs', stamp);
const outPath = join(pkgRoot, 'eval', 'runs', `four-arm-${stamp}.json`);

function fail(code, message) {
  console.error(`[four-arm] ${message}`);
  process.exit(code);
}

/** 从 metrics.json 投影成判据输入（口径见 four-arm-verdict.mjs 文件头）。 */
function project(arm, task, metricsPath) {
  const m = JSON.parse(readFileSync(metricsPath, 'utf8'));
  const t = m.M1_tokens ?? {};
  const input = Number(t.input ?? 0);
  const output = Number(t.output ?? 0);
  const cacheRead = Number(t.cacheRead ?? 0);
  const cacheWrite = Number(t.cacheWrite ?? 0);
  const series = Array.isArray(t.usageOriginal)
    ? t.usageOriginal.map((u) => Number(u?.usage?.inputTokens ?? 0))
    : [];
  return {
    arm,
    task,
    outcome: m.checksPass === true ? 'completed' : 'checks-failed',
    N: Number(m.M2_callCount?.probe ?? 0),
    tokens_strict: input - cacheRead - cacheWrite + output,
    tokens_with_cache: input + output,
    cache_hit_ratio: input > 0 ? cacheRead / input : null,
    C_max: series.length > 0 ? Math.max(...series) : null,
    checks_pass: m.checksPass === true,
    series,
  };
}

/** 扫描 eval/runs/<stamp>/<arm>/<task>/metrics.json，聚合成 rows。 */
function collect() {
  const rows = [];
  const missing = [];
  for (const arm of ARMS) {
    const armDir = join(runDir, arm.id);
    if (!existsSync(armDir)) {
      missing.push(`${arm.id}（无目录 ${armDir}）`);
      continue;
    }
    const tasks = readFileSync(join(pkgRoot, 'eval', 'tasks', 'tasks.json'), 'utf8');
    const ids = JSON.parse(tasks).tasks.map((t) => t.id);
    for (const task of ids) {
      const p = join(armDir, task, 'metrics.json');
      if (!existsSync(p)) {
        missing.push(`${arm.id}/${task}`);
        continue;
      }
      rows.push(project(arm.id, task, p));
    }
  }
  return { rows, missing };
}

function buildArtifact(rows) {
  const { h1, h2 } = computeVerdict(rows);
  return {
    schema: 'four-arm-real/1',
    stamp,
    generatedAt: new Date().toISOString(),
    arms: ARMS.map((a) => ({ id: a.id, desc: a.desc, patch: a.patch })),
    tasks: [...new Set(rows.map((r) => r.task))].sort(),
    metrics: rows,
    verdict: {
      h1: h1.verdict,
      h2: h2.verdict,
      detail: { h1, h2 },
    },
    note: '两个口径同时留存（tokens_strict 结论用 / tokens_with_cache 参考）。H1/H2 判据见 eval/tools/four-arm-verdict.mjs。',
  };
}

// ---------------------------------------------------------------------------
// 模式
// ---------------------------------------------------------------------------

if (has('recompute')) {
  const file = arg('recompute');
  if (file === undefined || !existsSync(file)) fail(2, `--recompute 需要存在的文件：${file}`);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(data.metrics) || data.metrics.length === 0) fail(2, '产物里没有 metrics 数组');
  const rebuilt = buildArtifact(data.metrics);
  writeFileSync(file, `${JSON.stringify({ ...data, verdict: rebuilt.verdict, recomputedAt: rebuilt.generatedAt }, null, 2)}\n`, 'utf8');
  console.log(`[four-arm] 判据重算：H1 ${rebuilt.verdict.h1}；H2 ${rebuilt.verdict.h2} → ${file}`);
  process.exit(0);
}

if (has('plan')) {
  console.log(`[four-arm] 计划：stamp=${stamp} tasks=${tasksArg} timeout=${timeout}s key=${key ? 'SET' : 'NOT SET'}`);
  for (const arm of ARMS) {
    if (!existsSync(join(pkgRoot, arm.patch))) fail(2, `缺补丁：${arm.patch}`);
    console.log(`  ${arm.id} ${arm.desc}`);
    console.log(`    node eval/tools/runner.cjs --arm ${arm.id} --patch ${arm.patch} --stamp ${stamp} --tasks ${tasksArg} --timeout ${timeout}`);
  }
  console.log(`[four-arm] 产物将写入 eval/runs/four-arm-${stamp}.json（schema=four-arm-real/1）`);
  process.exit(0);
}

if (has('from-run')) {
  const from = arg('from-run');
  if (from !== stamp) {
    // 允许 --from-run <stamp> 与 --stamp 不同：以 --from-run 为准
    console.log(`[four-arm] 聚合已落盘批次 ${from}（不重跑）`);
  }
  const fromDir = join(pkgRoot, 'eval', 'runs', from);
  if (!existsSync(fromDir)) fail(2, `批次目录不存在：${fromDir}`);
  // 重扫指定批次（collect() 只扫当前 stamp）
  const rows2 = [];
  const missing2 = [];
  const taskIds = JSON.parse(readFileSync(join(pkgRoot, 'eval', 'tasks', 'tasks.json'), 'utf8')).tasks.map((t) => t.id);
  for (const arm of ARMS) {
    for (const task of taskIds) {
      const p = join(fromDir, arm.id, task, 'metrics.json');
      if (!existsSync(p)) {
        missing2.push(`${arm.id}/${task}`);
        continue;
      }
      rows2.push(project(arm.id, task, p));
    }
  }
  if (missing2.length > 0) {
    fail(4, `批次 ${from} 数据不完整（缺 ${missing2.length} 个 metrics.json，例：${missing2.slice(0, 3).join('、')}）——不允许用部分数据出结论`);
  }
  const artifact = { ...buildArtifact(rows2), stamp: from };
  writeFileSync(join(pkgRoot, 'eval', 'runs', `four-arm-${from}.json`), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`[four-arm] H1 ${artifact.verdict.h1}；H2 ${artifact.verdict.h2} → eval/runs/four-arm-${from}.json`);
  process.exit(0);
}

// ---- 默认：真机跑批 ----
if (key === '') {
  fail(3, [
    '缺少凭据：需要 DEEPSEEK_API_KEY（或用 --key 传入）。',
    '缺凭据时不产出任何结论文件——"数据不足"不得伪装成"跑过"。',
    '拿到 key 后：DEEPSEEK_API_KEY=... node eval/tools/four-arm-real.mjs --stamp <id>',
  ].join('\n'));
}
const dshCheck = spawnSync('dsh', ['--version'], { encoding: 'utf8', shell: true });
if (dshCheck.status !== 0) fail(2, `找不到 dsh（${dshCheck.error?.message ?? dshCheck.status}）`);

mkdirSync(runDir, { recursive: true });
for (const arm of ARMS) {
  if (!existsSync(join(pkgRoot, arm.patch))) fail(2, `缺补丁：${arm.patch}`);
  console.log(`[four-arm] ${arm.id} ${arm.desc} → runner`);
  const res = spawnSync(
    'node',
    ['eval/tools/runner.cjs', '--arm', arm.id, '--patch', arm.patch, '--stamp', stamp, '--tasks', tasksArg, '--timeout', timeout],
    { cwd: pkgRoot, env: { ...process.env, DEEPSEEK_API_KEY: key }, stdio: 'inherit', encoding: 'utf8' },
  );
  if (res.status !== 0) {
    console.error(`[four-arm] ${arm.id} runner 退出码 ${res.status}：继续收集其余臂，最终按完整性判定（缺数据不出结论）`);
  }
}

const { rows, missing } = collect();
if (missing.length > 0) {
  fail(4, `数据不完整（缺 ${missing.length} 项，例：${missing.slice(0, 5).join('、')}）——不出结论。补齐后可用 --from-run ${stamp} 聚合。`);
}
const artifact = buildArtifact(rows);
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log('');
console.log(`[four-arm] H1 ${artifact.verdict.h1}（聚合降幅 ${(artifact.verdict.detail.h1.aggregateReduction * 100).toFixed(1)}%，达标任务 ${artifact.verdict.detail.h1.tasksMeeting15Pct}/${artifact.verdict.detail.h1.totalPairs}）`);
console.log(`[four-arm] H2 ${artifact.verdict.h2}`);
console.log(`[four-arm] 产物 → ${outPath}`);
