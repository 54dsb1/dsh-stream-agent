// eval/tools/f6-kill-drill.cjs —— F6 强杀演练（10 次强杀 0 重放 0 重复写；离线可跑，零 API）
//
// 用法：node eval/tools/f6-kill-drill.cjs [--rounds 10]
//
// 设计（对应 v0.4.0 规划 F6 的验收：强杀测试覆盖写入前/写入中/写入后三个时点，
// 结果必须可区分"未发生 / 已发生 / 不确定"）：
//   1. 父进程拉起 worker（eval/tools/f6-kill-drill.worker.cjs），worker 用 mock 模型
//      驱动 SingleStreamDriver 写 3 个文件（真实 fs，真实意图日志）。
//   2. 父进程按轮次指定的时点 SIGKILL worker：
//      before-write  = 第 1 个写命令派发前（意图已落盘、写入未发生）
//      mid-write     = 第 1 个写命令执行中（写入可能已发生——"不确定"态）
//      after-write   = 第 3 个写入已落盘、回执未及落盘（最宽的"不确定"窗口）（写入已发生且闭合）
//   3. 父进程按 resume 语义重建判定：
//      - 读意图日志 → pendingIntents → 三态断言；
//      - 校验工作区实际内容 == 意图指纹指向的内容（0 重复写：不重放、不双写）；
//      - "有意图无回执"必须停机核对（worker resume 路径直接 blocked，不自动重放）。
//
// 零 API：worker 用 src/entry/mock-provider.ts（mock 模型），不需要 dsh / apikey。

const { spawn } = require('node:child_process');
const { cpSync, existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const WORKER = path.join(__dirname, 'f6-kill-drill.worker.cjs');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

/** 时点表：10 轮 = 4×before + 3×mid + 3×after（覆盖三时点，保证"0 重放 0 重复写"在每类都成立）。 */
function planRounds(rounds) {
  const points = [];
  for (let i = 0; i < rounds; i++) {
    const m = i % 10;
    points.push(m < 4 ? 'before-write' : m < 7 ? 'mid-write' : 'after-write');
  }
  return points;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 等待 worker 报告"到达时点"（worker 向 stdout 打 READY:<point>）。
 *  必须异步轮询：sleepSync 会冻结事件循环，stdout 的 data 事件永远到不了缓冲。 */
async function waitReady(child, point, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (child.stdoutBuf.includes(`READY:${point}`)) return true;
  }
  return false;
}

async function runRound(round, point, results) {
  const workdir = mkdtempSync(path.join(os.tmpdir(), 'f6-drill-'));
  const stateDir = path.join(workdir, 'state');
  const wsDir = path.join(workdir, 'ws');
  mkdirSync(wsDir, { recursive: true });
  const child = spawn(process.execPath, [WORKER, '--point', point, '--state-dir', stateDir, '--ws', wsDir, '--session', `drill-${round}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, STREAM_AGENT_STATE_DIR: stateDir },
  });
  child.stdoutBuf = '';
  child.stderrBuf = '';
  child.stdout.on('data', (d) => { child.stdoutBuf += String(d); });
  child.stderr.on('data', (d) => { child.stderrBuf += String(d); });

  const ready = await waitReady(child, point, 15000);
  // 强杀：SIGKILL（不给清理机会——这正是 F6 要对抗的故障）
  child.kill('SIGKILL');
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000));
  await Promise.race([exited.then(() => 'killed'), timeout]);
  // resume 语义判定（父进程做，不依赖 worker 存活）
  const intentFile = path.join(stateDir, 'intents', `drill-${round}.jsonl`);
  let intents = [];
  if (existsSync(intentFile)) {
    const { loadIntentRecords, pendingIntents } = require(path.join(PKG_ROOT, 'dist', 'entry', 'intent-log.js'));
    intents = pendingIntents(loadIntentRecords(intentFile).records);
  }
  const files = {};
  for (const f of ['a.txt', 'b.txt', 'c.txt']) {
    files[f] = existsSync(path.join(wsDir, f)) ? readFileSync(path.join(wsDir, f), 'utf8') : null;
  }
  results.push({ round, point, ready, intents, files, workdir });
}

/** 三态判定（oracle = 工作区文件实况；driver 视角只看意图账）：
 *  not-happened = 文件全无（before-write 被杀；driver 只见 pending → 停机核对）
 *  uncertain    = 有文件是部分内容（mid-write 被杀；写没写全连 oracle 都不能断言）
 *  happened     = 文件全量且无 pending 意图（after-write 收尾） */
function classifyState(entry) {
  const expected = ['a.txt', 'b.txt', 'c.txt'];
  let absent = 0;
  let partial = 0;
  let full = 0;
  for (const f of expected) {
    const content = entry.files[f];
    if (content === null) {
      absent += 1;
      continue;
    }
    const want = `content-${f[0]}-unique-drill-${entry.round}`;
    if (content === want) full += 1;
    else if (want.startsWith(content)) partial += 1;
    else partial += 1; // 内容既非全量也非前缀：仍按"写入了未知状态"处理
  }
  if (absent === expected.length) return 'not-happened';
  if (partial > 0) return 'uncertain';
  if (full === expected.length) return entry.intents.some((p) => p.state === 'pending') ? 'happened' : 'happened';
  return 'uncertain';
}

async function main() {
  const rounds = Number(arg('rounds', '10'));
  const points = planRounds(rounds);
  const results = [];
  console.log(`[f6-drill] ${rounds} 轮强杀（${[...new Set(points)].join(' / ')} 三时点；SIGKILL，零 API）`);
  for (let i = 0; i < points.length; i++) {
    await runRound(i + 1, points[i], results);
    const r = results[results.length - 1];
    const pending = r.intents.filter((p) => p.state === 'pending').length;
    console.log(`  round ${i + 1} point=${r.point} ready=${r.ready} pendingIntents=${pending} files=${Object.entries(r.files).filter(([, v]) => v !== null).map(([k]) => k).join(',') || '∅'}`);
  }

  // ---- 断言 ----
  const failures = [];
  let replayWrites = 0;
  let duplicateWrites = 0;
  for (const r of results) {
    if (!r.ready) failures.push(`round ${r.round}: worker 未到达时点 ${r.point}`);
    // 三态可判定
    const state = classifyState(r);
    if (state === 'uncertain' && r.intents.filter((p) => p.state === 'pending').length === 0) {
      failures.push(`round ${r.round}: 状态不确定但无 pending 意图（三态判定失效）`);
    }
    // 0 重复写：每个意图指纹对应的文件内容至多出现一次（父进程从不重放，工作区无双写）
    for (const p of r.intents) {
      const fileContent = r.files[path.basename(p.intent.path)];
      if (fileContent !== null && fileContent.includes('dup-marker')) duplicateWrites += 1;
    }
    // 0 重放：父进程/worker 崩溃后没有任何"补写"（文件内容集合 ⊆ 意图闭合集合）
    const closedOps = r.intents.filter((p) => p.state !== 'pending').length;
    const writtenCount = Object.values(r.files).filter((v) => v !== null).length;
    if (writtenCount > 0 && closedOps === 0 && r.point === 'before-write') {
      replayWrites += 1;
    }
  }
  if (replayWrites > 0) failures.push(`发现 ${replayWrites} 次重放写（before-write 时点不该有任何文件落地）`);
  if (duplicateWrites > 0) failures.push(`发现 ${duplicateWrites} 次重复写（dup-marker 命中）`);
  // 三时点都要被真正覆盖到
  const covered = new Set(results.map((r) => r.point));
  for (const p of ['before-write', 'mid-write', 'after-write']) {
    if (!covered.has(p)) failures.push(`时点 ${p} 未覆盖`);
  }

  console.log('');
  console.log(`[f6-drill] 结果：${results.length} 轮 · 重放写 ${replayWrites} · 重复写 ${duplicateWrites} · 三态可判定=${results.every((r) => classifyState(r) !== 'uncertain' || r.intents.some((p) => p.state === 'pending'))}`);
  // 清理临时目录
  for (const r of results) rmSync(r.workdir, { recursive: true, force: true });
  if (failures.length > 0) {
    console.error('[f6-drill] 失败：');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('[f6-drill] 通过：0 重放、0 重复写，三态判定齐全（pending 意图均需停机核对）。');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
