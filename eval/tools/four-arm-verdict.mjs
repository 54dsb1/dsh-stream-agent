// eval/tools/four-arm-verdict.mjs —— 四臂判据（§12.1 H1/H2）的纯函数实现
//
// 为什么单独成文件：判据是"对外结论"的唯一来源，必须可单测、可复算、可在不重跑真机的
// 情况下从已落盘的 metrics 重算。本文件不读文件、不发请求，只做算术。
//
// 口径（§12.2 硬规则，两个口径同时给）：
//   tokens_strict      = (input − cacheRead − cacheWrite) + output     （严格二分量，结论用）
//   tokens_with_cache  = input + output                                （参考口径，不单独用于结论）
//   N                  = probe 请求数（M2 主口径）
//   series[i]          = 第 i 个请求的 inputTokens（含缓存读，口径同 provider 上报）
//
// H1（§12.1）：L3 与 L1 在 |ΔN| ≤ 1 的成对样本上，总 token 低 ≥15%，且 10 个任务中 ≥7 个成立。
// H2（§12.1）：L2 的上下文增长斜率 ≤ L1 的 1/3；交叉点 ≤6 回合。
//   · 斜率 = 单任务逐请求 inputTokens 对请求序号的线性回归斜率（取两臂都跑过的、N 最大的任务）；
//   · 交叉点 = 该任务上 L2 累计 strict token 首次低于 L1 的请求序号；未出现 = null。

export const H1_MIN_TASKS = 7;
export const H1_MIN_REDUCTION = 0.15;
export const H2_SLOPE_RATIO = 1 / 3;
export const H2_MAX_CROSSOVER = 6;

/** 线性回归斜率（最小二乘）。点不足 2 个或 x 无方差时返回 0。 */
export function slope(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - meanX) * (p.y - meanY);
    den += (p.x - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** 首次 L2 累计 strict 低于 L1 的请求序号（1 基）；未出现返回 null。 */
export function crossoverTurn(l1Series, l2Series) {
  const n = Math.min(l1Series?.length ?? 0, l2Series?.length ?? 0);
  let c1 = 0;
  let c2 = 0;
  for (let i = 0; i < n; i += 1) {
    c1 += l1Series[i];
    c2 += l2Series[i];
    if (c2 < c1) return i + 1;
  }
  return null;
}

function indexBy(rows) {
  const map = new Map();
  for (const r of rows) map.set(`${r.arm}/${r.task}`, r);
  return map;
}

/**
 * 计算 H1/H2。
 * @param {Array<{arm:string,task:string,N:number,tokens_strict:number,tokens_with_cache:number,series:number[],checks_pass?:boolean}>} rows
 */
export function computeVerdict(rows) {
  const idx = indexBy(rows);
  const tasks = [...new Set(rows.map((r) => r.task))].sort();

  // ---- H1：L3 vs L1 ----
  const pairs = [];
  for (const task of tasks) {
    const l1 = idx.get(`L1/${task}`);
    const l3 = idx.get(`L3/${task}`);
    if (l1 === undefined || l3 === undefined) continue;
    const deltaN = l3.N - l1.N;
    const comparable = Math.abs(deltaN) <= 1;
    const reduction = l1.tokens_strict > 0 ? 1 - l3.tokens_strict / l1.tokens_strict : null;
    pairs.push({
      task,
      N_L1: l1.N,
      N_L3: l3.N,
      deltaN,
      comparable,
      strict_L1: l1.tokens_strict,
      strict_L3: l3.tokens_strict,
      reduction,
      meets15: comparable && reduction !== null && reduction >= H1_MIN_REDUCTION,
    });
  }
  const comparablePairs = pairs.filter((p) => p.comparable);
  const comparableStrictL1 = comparablePairs.reduce((s, p) => s + p.strict_L1, 0);
  const comparableStrictL3 = comparablePairs.reduce((s, p) => s + p.strict_L3, 0);
  const aggregateReduction = comparableStrictL1 > 0 ? 1 - comparableStrictL3 / comparableStrictL1 : null;
  const meeting = pairs.filter((p) => p.meets15).length;
  const h1Met =
    comparablePairs.length >= H1_MIN_TASKS &&
    aggregateReduction !== null &&
    aggregateReduction >= H1_MIN_REDUCTION &&
    meeting >= H1_MIN_TASKS;

  const h1 = {
    verdict: pairs.length === 0 ? '数据不足' : (h1Met ? '成立' : '证伪'),
    comparablePairs: comparablePairs.length,
    totalPairs: pairs.length,
    aggregateReduction,
    tasksMeeting15Pct: meeting,
    required: { minComparable: H1_MIN_TASKS, minReduction: H1_MIN_REDUCTION, minTasks: H1_MIN_TASKS },
    pairs,
  };

  // ---- H2：L2 斜率 vs L1 斜率 + 交叉点 ----
  const bothArms = tasks.filter((t) => idx.has(`L1/${t}`) && idx.has(`L2/${t}`));
  let h2Target = null;
  for (const task of bothArms) {
    const l1 = idx.get(`L1/${task}`);
    const l2 = idx.get(`L2/${task}`);
    const n = Math.min(l1.series?.length ?? 0, l2.series?.length ?? 0);
    if (h2Target === null || n > h2Target.n) h2Target = { task, l1, l2, n };
  }

  let h2;
  if (h2Target === null || h2Target.n < 3) {
    h2 = { verdict: '数据不足', reason: 'L1/L2 共同任务不足或逐请求序列过短（需 ≥3 个请求）' };
  } else {
    const toPoints = (s) => s.map((y, i) => ({ x: i + 1, y }));
    const s1 = slope(toPoints(h2Target.l1.series).slice(0, h2Target.n));
    const s2 = slope(toPoints(h2Target.l2.series).slice(0, h2Target.n));
    const cross = crossoverTurn(h2Target.l1.series, h2Target.l2.series);
    const slopeOk = s1 > 0 && s2 <= s1 * H2_SLOPE_RATIO;
    const crossOk = cross !== null && cross <= H2_MAX_CROSSOVER;
    h2 = {
      verdict: slopeOk && crossOk ? '成立' : '证伪',
      task: h2Target.task,
      slope_L1: s1,
      slope_L2: s2,
      slopeRatio: s1 > 0 ? s2 / s1 : null,
      crossoverTurn: cross,
      required: { maxSlopeRatio: H2_SLOPE_RATIO, maxCrossoverTurn: H2_MAX_CROSSOVER },
    };
  }

  return { h1, h2 };
}

// ---------------------------------------------------------------------------
// 自检：判据算术的回归（不依赖真机，任何环境可跑）
//   node eval/tools/four-arm-verdict.mjs --selftest
// ---------------------------------------------------------------------------

function synthetic(kind) {
  const rows = [];
  for (let i = 1; i <= 10; i += 1) {
    const task = `T${i}`;
    const base = 10_000;
    const seriesL1 = [1_000, 1_600, 2_200, 2_800, 3_400];
    const seriesL2 = kind === 'pass' ? [900, 1_100, 1_300, 1_500, 1_700] : [1_200, 2_400, 3_600, 4_800, 6_000];
    rows.push({ arm: 'L1', task, N: 5, tokens_strict: base, tokens_with_cache: base * 2, series: seriesL1 });
    rows.push({
      arm: 'L3', task,
      N: kind === 'pass' ? 5 : 6,
      tokens_strict: kind === 'pass' ? base * 0.7 : base * 1.1,
      tokens_with_cache: base,
      series: seriesL1,
    });
    rows.push({ arm: 'L2', task, N: 4, tokens_strict: base * 0.8, tokens_with_cache: base, series: seriesL2 });
  }
  return rows;
}

function selftest() {
  let failed = 0;
  const check = (name, cond) => {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}`);
    if (!cond) failed += 1;
  };

  const pass = computeVerdict(synthetic('pass'));
  check('H1 合成样本（30% 降幅、ΔN=0）→ 成立', pass.h1.verdict === '成立');
  check('H1 逐任务达标数 = 10', pass.h1.tasksMeeting15Pct === 10);
  check('H1 聚合降幅 ≈ 30%', Math.abs(pass.h1.aggregateReduction - 0.3) < 1e-9);
  check('H2 合成样本（L2 斜率约为 L1 的 1/3 且更早收敛）→ 成立', pass.h2.verdict === '成立');
  check('H2 交叉点 = 1', pass.h2.crossoverTurn === 1);

  const fail = computeVerdict(synthetic('fail'));
  check('H1 合成样本（ΔN=1 但 token 更高）→ 证伪', fail.h1.verdict === '证伪');
  check('H1 逐任务达标数 = 0', fail.h1.tasksMeeting15Pct === 0);
  check('H2 合成样本（L2 增长更快）→ 证伪', fail.h2.verdict === '证伪');

  check('数据不足：空输入 → H1/H2 均数据不足', computeVerdict([]).h1.verdict === '数据不足' && computeVerdict([]).h2.verdict === '数据不足');
  check('斜率：等差序列斜率 = 公差', Math.abs(slope([{ x: 1, y: 2 }, { x: 2, y: 5 }, { x: 3, y: 8 }]) - 3) < 1e-9);
  check('交叉点：L2 始终更高 → null', crossoverTurn([1, 1, 1], [2, 2, 2]) === null);

  console.log(failed === 0 ? '[selftest] 全部通过' : `[selftest] ${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv.includes('--selftest')) selftest();
