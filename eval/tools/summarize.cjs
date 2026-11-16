// eval/tools/summarize.cjs —— M1 四分量计量汇总（输入/缓存读/缓存写/输出；README 数字由此出）
//
// 用法：
//   node eval/tools/summarize.cjs --stamp <2026-11-15> [--arm baseline|stream|all] [--md]
//
// 输出：
//   eval/runs/<stamp>/summary.json —— 逐任务 + 汇总的四分量原始数（可复算的权威形态）
//   --md 时同时打印 Markdown 表（贴进 eval/RESULTS.md 用）
//
// 口径（eval/METRICS.md M1）：
//   单位任务 token = Σ 请求 [inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens]
//   · 逐请求取 probe.jsonl 的 usage chunk（eval-probe 抓原文，留存可复算）；
//   · 会话标题旁路请求剔除（识别特征见 isTitleRequest，两臂同剔）；
//   · 缓存分量缺失标 "不可得"（按 0 计会系统性低估，禁止）；
//   · 二分量（输入+输出）只作参考并显式标注 "非全量口径"。

const fs = require('node:fs');
const path = require('node:path');

const PKG_ROOT = path.resolve(__dirname, '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

/** 标题旁路请求识别（METRICS.md E5；两臂同剔） */
function isTitleRequest(optionsText) {
  try {
    const o = JSON.parse(optionsText);
    const msgs = o.messages || [];
    if (o.maxTokens === 64 && msgs.length <= 2) return true;
    const text = JSON.stringify(msgs);
    return text.includes('Generate the session title') || text.includes('Create a concise title');
  } catch {
    return false;
  }
}

/** 单任务四分量汇总：逐请求 usage 原文求和；缺失分量如实标 null（"不可得"）。 */
function summarizeTask(probePath) {
  if (!fs.existsSync(probePath)) return null;
  const components = {
    inputTokens: { sum: 0, seen: false },
    cacheReadTokens: { sum: 0, seen: false },
    cacheWriteTokens: { sum: 0, seen: false },
    outputTokens: { sum: 0, seen: false },
  };
  let requests = 0;
  let excludedTitle = 0;
  const currentSeqTitle = new Set();
  const lines = fs.readFileSync(probePath, 'utf8').split('\n');
  // 先扫一遍 request 行标出标题请求的 seq（usage chunk 与 request 同 seq）
  for (const line of lines) {
    if (line === '') continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.kind === 'request' && isTitleRequest(rec.options)) currentSeqTitle.add(rec.seq);
  }
  for (const line of lines) {
    if (line === '') continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.kind === 'request' && !currentSeqTitle.has(rec.seq)) requests += 1;
    if (rec.kind === 'request' && currentSeqTitle.has(rec.seq)) excludedTitle += 1;
    if (rec.kind !== 'chunk' || currentSeqTitle.has(rec.seq)) continue;
    let chunk;
    try { chunk = JSON.parse(rec.chunk); } catch { continue; }
    if (chunk.type !== 'usage' || chunk.usage === undefined) continue;
    for (const key of Object.keys(components)) {
      const v = chunk.usage[key];
      if (typeof v === 'number') {
        components[key].sum += v;
        components[key].seen = true;
      }
    }
  }
  const pick = (key) => (components[key].seen ? components[key].sum : null);
  const input = pick('inputTokens');
  const cacheRead = pick('cacheReadTokens');
  const cacheWrite = pick('cacheWriteTokens');
  const output = pick('outputTokens');
  const unavailable = [cacheRead, cacheWrite].filter((v) => v === null).length;
  const four = input === null || output === null
    ? null
    : input + (cacheRead ?? 0) + (cacheWrite === null ? 0 : cacheWrite) + output;
  return {
    requests,
    excludedTitleRequests: excludedTitle,
    inputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    fourComponentTotal: four,
    twoComponentTotal: input === null || output === null ? null : input + output,
    cacheComponentsUnavailable: unavailable > 0,
    note: unavailable > 0 ? '缓存分量不可得（未按 0 计）' : undefined,
  };
}

function main() {
  const stamp = arg('stamp');
  if (stamp === undefined) {
    console.error('用法：node eval/tools/summarize.cjs --stamp <2026-11-15> [--arm all] [--md]');
    process.exit(2);
  }
  const runDir = path.join(PKG_ROOT, 'eval', 'runs', stamp);
  if (!fs.existsSync(runDir)) {
    console.error(`[summarize] 目录不存在：${runDir}`);
    process.exit(2);
  }
  const armArg = arg('arm', 'all');
  const arms = armArg === 'all' ? ['baseline', 'stream'] : [armArg];
  const tasks = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'eval', 'tasks', 'tasks.json'), 'utf8')).tasks;

  const out = { stamp, arms: {} };
  for (const arm of arms) {
    const rows = {};
    let reqTotal = 0;
    let checksPass = 0;
    let checksTotal = 0;
    for (const task of tasks) {
      const metricsPath = path.join(runDir, arm, task.id, 'metrics.json');
      const probePath = path.join(runDir, arm, task.id, 'probe', 'probe.jsonl');
      const row = summarizeTask(probePath);
      if (row === null) {
        rows[task.id] = { missing: true };
        continue;
      }
      if (fs.existsSync(metricsPath)) {
        const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
        const checks = metrics.checks ?? [];
        checksTotal += checks.length;
        checksPass += checks.filter((c) => c.pass === true).length;
      }
      rows[task.id] = row;
      reqTotal += row.requests;
    }
    const totals = {};
    for (const key of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']) {
      const vals = Object.values(rows).filter((r) => !r.missing && r[key] !== null);
      totals[key] = vals.length === Object.keys(rows).filter((r) => !r.missing).length
        ? vals.reduce((s, r) => s + r[key], 0)
        : null; // 任一任务缺该分量 → 汇总也不可加总（不得补 0）
    }
    const t2 = Object.values(rows).filter((r) => !r.missing && r.twoComponentTotal !== null);
    const t2Sum = t2.reduce((s, r) => s + r.twoComponentTotal, 0);
    const full = totals.inputTokens !== null && totals.outputTokens !== null
      && totals.cacheReadTokens !== null && totals.cacheWriteTokens !== null;
    out.arms[arm] = {
      tasks: rows,
      totals: { ...totals, fourComponentTotal: full ? totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens : null },
      requests: reqTotal,
      checks: { pass: checksPass, total: checksTotal },
      twoComponentReference: { sum: t2Sum, note: '非全量口径，只作参考（METRICS.md M1）' },
    };
  }

  const outPath = path.join(runDir, 'summary.json');
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  console.log(`[summarize] 写出 ${outPath}`);

  if (process.argv.includes('--md')) {
    for (const arm of arms) {
      const a = out.arms[arm];
      console.log(`\n### ${arm}\n`);
      console.log('| 任务 | 请求数 | 输入 | 缓存读 | 缓存写 | 输出 | 全量合计 |');
      console.log('|---|---|---|---|---|---|---|');
      for (const task of tasks) {
        const r = a.tasks[task.id];
        if (r === undefined || r.missing) {
          console.log(`| ${task.id} | - | - | - | - | - | - |`);
          continue;
        }
        const cell = (v) => (v === null ? '不可得' : String(v));
        console.log(`| ${task.id} | ${r.requests} | ${cell(r.inputTokens)} | ${cell(r.cacheReadTokens)} | ${cell(r.cacheWriteTokens)} | ${cell(r.outputTokens)} | ${cell(r.fourComponentTotal)} |`);
      }
      const t = a.totals;
      console.log(`| 合计 | ${a.requests} | ${t.inputTokens ?? '不可得'} | ${t.cacheReadTokens ?? '不可得'} | ${t.cacheWriteTokens ?? '不可得'} | ${t.outputTokens ?? '不可得'} | ${t.fourComponentTotal ?? '不可得（缺失分量未按 0 计）'} |`);
      console.log(`\nchecks：${a.checks.pass}/${a.checks.total}；二分量参考（非全量口径）：${a.twoComponentReference.sum}`);
    }
  }
}

main();
