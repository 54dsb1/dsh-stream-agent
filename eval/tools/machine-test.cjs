// eval/tools/machine-test.cjs —— 实机对照：默认模式下「关插件 / 开插件」各跑同一个项目一次
//
// 用法：
//   node eval/tools/machine-test.cjs --plan                     # 只打印计划，不调模型、不读 key
//   node eval/tools/machine-test.cjs --key <DEEPSEEK_API_KEY>   # 真跑（两臂串行）
//   node eval/tools/machine-test.cjs --key sk-xxx --task C1 --stamp 2026-11-17a --timeout 900
//
// 两臂（与 R3 评测矩阵同一套装置，控制变量不变）：
//   baseline = patches/eval-baseline.yml —— 停用本插件五个 entry + 恢复内建 agent-loop（插件关）
//   stream   = patches/eval-stream.yml   —— 本插件全量接管，默认配置（balanced，enableCode: false）
//   两臂同装 eval-probe（只读透传），任务文本 / seed / 判题器逐字节相同。
//
// 产物：eval/runs/<stamp>/{baseline,stream}/<TASK>/{ws,probe,metrics.json,session-log}
//       eval/runs/<stamp>/summary.json（M1 四分量）
//       eval/runs/<stamp>/RESULTS.md（逐任务对照，--out 写入，不覆盖 eval/RESULTS.md）
//       eval/runs/<stamp>/machine-test-report.md（本工具生成的单项目实机报告）
//
// 红线：key 只在子进程 env 里出现，不落盘、不打日志（只印后 4 位）；不写 eval/RESULTS.md。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const TASKS_FILE = path.join(PKG_ROOT, 'eval', 'tasks', 'tasks.json');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const flag = (name) => process.argv.includes(`--${name}`);
const today = () => new Date().toISOString().slice(0, 10);

// --runs：产物根目录（默认 eval/runs）；--report-only：只从既有 metrics 重出报告，不跑模型。
const RUNS = arg('runs') ? path.resolve(arg('runs')) : path.join(PKG_ROOT, 'eval', 'runs');
const reportOnly = flag('report-only');

const taskId = arg('task', 'R2');
const stamp = arg('stamp', `${today()}-machine`);
const timeout = Number(arg('timeout', '900'));
const key = arg('key', '') || process.env.DEEPSEEK_API_KEY || '';
const force = flag('force');
const planOnly = flag('plan');

function die(msg, code = 2) {
  console.error(`[machine-test] ${msg}`);
  process.exit(code);
}

function tail4(s) {
  return s ? `****${s.slice(-4)}` : '<unset>';
}

// ---- 任务与补丁 ----
const tasksDoc = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
const task = tasksDoc.tasks.find((t) => t.id === taskId);
if (!task) die(`未知任务 ${taskId}；可选：${tasksDoc.tasks.map((t) => t.id).join(', ')}`);

const PATCH = {
  baseline: path.join(PKG_ROOT, 'patches', 'eval-baseline.yml'),
  stream: path.join(PKG_ROOT, 'patches', 'eval-stream.yml'),
};

// ---- 计划输出 ----
const runDir = path.join(RUNS, stamp);
const steps = [
  `preflight：node ${process.version} / dsh 版本 / dist 在位 / key ${planOnly ? '<未读取>' : tail4(key)}`,
  `baseline：dsh --profile headless --patch patches/eval-baseline.yml headless "<${task.id} prompt>"（插件关）`,
  `stream  ：dsh --profile headless --patch patches/eval-stream.yml   headless "<${task.id} prompt>"（插件开，默认配置）`,
  `summarize：node eval/tools/summarize.cjs --stamp ${stamp} --md`,
  `report  ：node eval/tools/gen-results.cjs --stamp ${stamp} --out eval/runs/${stamp}/RESULTS.md`,
];

console.log('[machine-test] 任务:', `${task.id}（${task.type} / ${task.title}）`);
console.log('[machine-test] stamp:', stamp, '| 每臂超时:', timeout, 's | key:', planOnly ? '<plan 不读取>' : tail4(key));
console.log('[machine-test] 计划:');
steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

if (planOnly) {
  console.log(`[machine-test] --plan：只打印计划，未调用模型。真跑去掉 --plan 并给 --key（或设 DEEPSEEK_API_KEY）。`);
  console.log(`[machine-test] 预计花费：2 次单任务运行（本机 v02 批次同题 baseline 约 3.8 万 token、stream 约 1.5 万，仅供量级参考）。`);
  process.exit(0);
}

if (!reportOnly) {
  // ---- preflight ----
  if (!key) die('缺少 key：传 --key <KEY> 或设环境变量 DEEPSEEK_API_KEY');
  for (const [name, p] of Object.entries(PATCH)) if (!fs.existsSync(p)) die(`补丁缺失：${name} -> ${p}`);
  if (!fs.existsSync(path.join(PKG_ROOT, 'dist', 'entry', 'loop.js'))) die('dist 未构建：先 npm run build');

  const dshVersion = spawnSync('dsh', ['--version'], { shell: true, encoding: 'utf8', windowsHide: true });
  if (dshVersion.status !== 0) die(`dsh 不可用：${(dshVersion.stderr || dshVersion.error || '').toString().slice(0, 200)}`);
  console.log('[machine-test] dsh', (dshVersion.stdout || '').trim());

  if (fs.existsSync(runDir) && !force) {
    die(`eval/runs/${stamp} 已存在；换 --stamp，或加 --force 覆盖（会删掉该目录下同名两臂产物）`);
  }
}

// ---- 跑两臂 ----
function runArm(arm) {
  console.log(`\n[machine-test] ===== ${arm} 开始 =====`);
  const started = Date.now();
  const r = spawnSync(
    process.execPath,
    [path.join(__dirname, 'runner.cjs'), '--arm', arm, '--stamp', stamp, '--tasks', taskId, '--key', key, '--timeout', String(timeout)],
    { cwd: PKG_ROOT, stdio: 'inherit', windowsHide: true },
  );
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`[machine-test] ===== ${arm} 结束：exit=${r.status} 用时 ${seconds}s =====`);
  return { status: r.status, seconds };
}

const runs = reportOnly
  ? { baseline: { seconds: '—' }, stream: { seconds: '—' } }
  : { baseline: runArm('baseline'), stream: runArm('stream') };

// ---- 汇总（M1 四分量）----
if (!reportOnly) {
  const summarize = spawnSync(process.execPath, [path.join(__dirname, 'summarize.cjs'), '--stamp', stamp, '--md'], {
    cwd: PKG_ROOT, encoding: 'utf8', windowsHide: true,
  });
  if (summarize.status !== 0) console.error('[machine-test] summarize 失败：', (summarize.stderr || '').slice(-500));
  else process.stdout.write(summarize.stdout);

  // ---- 逐任务对照（写到 runs 目录，不碰 eval/RESULTS.md）----
  const genOut = path.join(runDir, 'RESULTS.md');
  const gen = spawnSync(process.execPath, [path.join(__dirname, 'gen-results.cjs'), '--stamp', stamp, '--out', genOut], {
    cwd: PKG_ROOT, encoding: 'utf8', windowsHide: true,
  });
  if (gen.status !== 0) console.error('[machine-test] gen-results 失败：', (gen.stderr || '').slice(-500));
}

// ---- 单项目报告 ----
function readMetrics(arm) {
  const p = path.join(runDir, arm, taskId, 'metrics.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const m = { baseline: readMetrics('baseline'), stream: readMetrics('stream') };
const total = (x) => (x ? x.M1_tokens.input + x.M1_tokens.cacheRead + x.M1_tokens.cacheWrite + x.M1_tokens.output : null);
const tb = total(m.baseline);
const ts = total(m.stream);
const ratio = tb && ts ? ((ts / tb) * 100).toFixed(1) : 'n/a';

const rows = [
  ['臂', 'exit', '请求数', '输入(未缓存)', '缓存读', '缓存写', '输出', '总 token', 'checks'],
  ['baseline（插件关）', m.baseline?.exitCode ?? '未跑', m.baseline?.M2_callCount.probe ?? '—',
    m.baseline?.M1_tokens.input ?? '—', m.baseline?.M1_tokens.cacheRead ?? '—', m.baseline?.M1_tokens.cacheWrite ?? '—',
    m.baseline?.M1_tokens.output ?? '—', tb ?? '—', m.baseline ? (m.baseline.checksPass ? 'PASS' : 'FAIL') : '—'],
  ['stream（插件开）', m.stream?.exitCode ?? '未跑', m.stream?.M2_callCount.probe ?? '—',
    m.stream?.M1_tokens.input ?? '—', m.stream?.M1_tokens.cacheRead ?? '—', m.stream?.M1_tokens.cacheWrite ?? '—',
    m.stream?.M1_tokens.output ?? '—', ts ?? '—', m.stream ? (m.stream.checksPass ? 'PASS' : 'FAIL') : '—'],
];

console.log('\n[machine-test] 单项目实机结果（四分量口径，与 eval/METRICS.md M1 一致）');
for (const r of rows) console.log('  ' + r.map((c) => String(c)).join(' | '));
console.log(`[machine-test] 对照/基线 总 token 比：${ratio}%`);

const report = [
  `# 实机对照报告（单项目 / 默认模式）：${task.id}`,
  '',
  `- 生成：\`eval/tools/machine-test.cjs\`，stamp \`${stamp}\`，${new Date().toISOString()}`,
  `- 任务：${task.id}（${task.type} / ${task.title}），题面见 \`eval/tasks/tasks.json\``,
  '- 两臂：baseline = 插件关（内建 agent-loop），stream = 插件开（默认配置，balanced，`enableCode: false`）',
  '- 口径：总 token = Σ(input + cacheRead + cacheWrite + output)，逐请求取 probe usage 原文；标题旁路请求两臂同剔',
  '',
  '| 臂 | exit | 请求数 | 输入(未缓存) | 缓存读 | 缓存写 | 输出 | 总 token | checks | 用时 |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---|---:|',
  ...['baseline', 'stream'].map((arm) => {
    const x = m[arm];
    return x
      ? `| ${arm} | ${x.exitCode} | ${x.M2_callCount.probe} | ${x.M1_tokens.input} | ${x.M1_tokens.cacheRead} | ${x.M1_tokens.cacheWrite} | ${x.M1_tokens.output} | ${total(x)} | ${x.checksPass ? 'PASS' : 'FAIL'} | ${runs[arm].seconds}s |`
      : `| ${arm} | 未跑 | — | — | — | — | — | — | — | ${runs[arm].seconds}s |`;
  }),
  '',
  `**对照/基线总 token 比：${ratio}%**`,
  '',
  '## 如实说明',
  '',
  '- 单样本只作方向参考：一次运行受模型采样、缓存命中与网络波动影响，**不能替代 R3 十题矩阵**，也不能据此改写 README 的 28.9%。',
  '- `exit=1` 若同时 `checks=PASS`，多半是重入预算护栏耗尽（见 docs/limitations.md 第 2 条），不是任务失败；报告里如实保留原始 exit。',
  '- 两臂 model/provider 若不一致，本报告无效（gen-results 会在逐任务表标注「作废重跑」）。',
  '- 证据链：`eval/runs/' + stamp + '/{baseline,stream}/' + task.id + '/{probe,metrics.json,session-log}`。',
  '',
  `逐任务对照（含 injected_ratio / prefix 取证）：[RESULTS.md](./RESULTS.md)`,
].join('\n');

const reportPath = path.join(runDir, 'machine-test-report.md');
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(reportPath, report, 'utf8');
console.log(`[machine-test] 报告：${path.relative(PKG_ROOT, reportPath) || reportPath}`);

const missing = !m.baseline || !m.stream;
if (missing) {
  console.error('[machine-test] 有一臂没有产出 metrics.json，报告不完整；请看上面各臂的 stderr。');
  process.exit(1);
}
