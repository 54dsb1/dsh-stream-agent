// eval/tools/runner.cjs ���� ���� 08 ���� runner���������������ִ�� + ȡ֤ + ָ�����
//
// �÷���
//   node eval/tools/runner.cjs --arm baseline|stream [--stamp <2026-11-14>] [--tasks W1,R1] [--timeout 600]
//     --stamp 2026-11-14a   ��ȱʡ = �������ڣ�ͬ stamp ���ܸ���ͬ����Ŀ¼������ͬ�ո��ܣ�
//     --key  <DEEPSEEK_API_KEY>��ȱʡ͸�� process.env������ͬһ key = ���Ʊ������� 4��
//
// ÿ������� eval/runs/<stamp>/<arm>/<TASK>/��
//   ws/            ����������seed ��ʵ�ܣ�������ԭ�� + manifest.json��
//   probe/         eval-probe ���̣�probe.jsonl�������� options ԭ�� + �� chunk usage ԭ�ģ�
//   driver-*.json  ���ձۣ�06 ������ turn-end snapshot��STREAM_LOOP_EVAL_DUMP��
//   session-log/session.v4.jsonl.zstd  ԭ���浵���ط� oracle�����ߣ�zstd ԭ��������
//   metrics.json   ��Ԫ�� + prefix ���� + checks + �浵·����gen-results �����룩

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { newestSessionDir, parseSessionLog, summarizeSession, workspaceManifest } = require('./session-log.cjs');

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const PATCH_BASELINE = path.join(PKG_ROOT, 'patches', 'eval-baseline.yml');
const PATCH_STREAM = path.join(PKG_ROOT, 'patches', 'eval-stream.yml');
const TASKS_FILE = path.join(PKG_ROOT, 'eval', 'tasks', 'tasks.json');
const FIXTURES = path.join(PKG_ROOT, 'eval', 'tasks', 'fixtures');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

/** ̽�������Ƿ�Ϊ������·��METRICS.md M1/M2 �޳��ʶ�������� E5�� */
function isTitleRequest(optionsText) {
  try {
    const o = JSON.parse(optionsText);
    const msgs = o.messages || [];
    if (o.maxTokens === 64 && msgs.length <= 2) return true;
    const text = JSON.stringify(msgs);
    return text.includes('Generate the session title') || text.includes('Create a concise title');
  } catch { return false; }
}

/** �������󹫹�ǰ׺���ֽڼ���M4������ probe ��� options ���л��ı�Ϊ׼ */
function prefixSequence(requests) {
  const out = [];
  let prev = null;
  for (const r of requests) {
    const messages = r.messages; // probe request options ԭ�ģ�JSON �ַ�����
    const hash = crypto.createHash('sha256').update(messages).digest('hex').slice(0, 16);
    let common = 0;
    if (prev !== null) {
      const n = Math.min(prev.length, messages.length);
      while (common < n && prev[common] === messages[common]) common += 1;
    }
    out.push({ seq: r.seq, fullHash: hash, commonPrefixBytesWithPrev: prev === null ? null : common, identicalToPrev: prev !== null && prev === messages });
    prev = messages;
  }
  return out;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runTask(task, arm, runDir, apiKey, timeoutSec) {
  const taskDir = path.join(runDir, arm, task.id);
  const wsDir = path.join(taskDir, 'ws');
  const probeDir = path.join(taskDir, 'probe');
  fs.rmSync(taskDir, { recursive: true, force: true });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(probeDir, { recursive: true });

  // seed���������ֽ�ͬһ�� fixtures��
  for (const s of task.seed || []) {
    const dst = path.join(wsDir, s.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(FIXTURES, s.fixture), dst);
  }

  const patch = arm === 'baseline' ? PATCH_BASELINE : PATCH_STREAM;
  const env = { ...process.env, DSH_EVAL_PROBE_DIR: probeDir };
  if (arm === 'stream') env.STREAM_LOOP_EVAL_DUMP = path.join(taskDir, 'driver-');
  if (apiKey) env.DEEPSEEK_API_KEY = apiKey;
  else delete env.DEEPSEEK_API_KEY;

  const started = new Date().toISOString();
  const res = spawnSync('dsh', ['--profile', 'headless', '--patch', patch, 'headless', task.prompt],
    { cwd: wsDir, env, timeout: timeoutSec * 1000, shell: true, encoding: 'utf8', windowsHide: true });
  const finished = new Date().toISOString();
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';

  // ---- ȡ֤ ----
  // session log �ڽ����˳����������ӳ٣�ʵ�⣩����ѯ��� 30s ֱ������
  let session = newestSessionDir(wsDir);
  for (let waited = 0; session === undefined && waited < 30000; waited += 2000) {
    sleepSync(2000);
    session = newestSessionDir(wsDir);
  }
  let archived = { archived: false };
  if (session !== undefined) {
    const archDir = path.join(taskDir, 'session-log');
    fs.mkdirSync(archDir, { recursive: true });
    fs.copyFileSync(session.logPath, path.join(archDir, 'session.v4.jsonl.zstd')); // ԭ���ֽ�
    archived = { archived: true, sessionDir: session.sessionDir, copiedBytes: fs.statSync(path.join(archDir, 'session.v4.jsonl.zstd')).size };
  }
  const manifest = workspaceManifest(wsDir);
  fs.writeFileSync(path.join(wsDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // ---- session log ��ʵ ----
  let sessionFacts = { error: 'session log δ�ҵ���archived=false ʱ�����񲻿ɸ��㣬��ʵ��ע��' };
  if (session !== undefined) {
    sessionFacts = summarizeSession(parseSessionLog(session.logPath));
  }

  // ---- probe ��ʵ��M1 ���ھ� / M2 v1.1 ���ھ� / M4��----
  const probeFile = path.join(probeDir, 'probe.jsonl');
  const probeLines = fs.existsSync(probeFile)
    ? fs.readFileSync(probeFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { kind: 'PARSE_ERROR' }; } })
    : [];
  const probeRequestsRaw = probeLines.filter((l) => l.kind === 'request');
  const titleExcluded = probeRequestsRaw.filter((r) => isTitleRequest(r.options)).length;
  const probeRequests = probeRequestsRaw
    .filter((r) => !isTitleRequest(r.options))
    .map((r) => ({ seq: r.seq, at: r.at, messages: r.options, usage: [] }));
  const usageBySeq = new Map(probeRequests.map((r) => [r.seq, r]));
  for (const l of probeLines) {
    if (l.kind === 'chunk') {
      try {
        const c = JSON.parse(l.chunk);
        if (c.type === 'usage' && usageBySeq.has(l.seq)) usageBySeq.get(l.seq).usage.push(c.usage);
      } catch { /* ԭ�ı����� probe.jsonl������ʧ����ʵ��¼ PARSE_ERROR */ }
    }
  }

  // ---- M1 ���ܣ�E3 �ھ���input = uncached + cacheRead + cacheWrite��----
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cachedFieldsSeen = false;
  const usageOriginal = [];
  for (const r of probeRequests) {
    for (const u of r.usage) {
      usageOriginal.push({ seq: r.seq, usage: u });
      tokens.input += (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
      tokens.output += u.outputTokens || 0;
      tokens.cacheRead += u.cacheReadTokens || 0;
      tokens.cacheWrite += u.cacheWriteTokens || 0;
      if (u.cacheReadTokens !== undefined || u.cacheWriteTokens !== undefined) cachedFieldsSeen = true;
    }
  }

  // ---- M3�������� snapshot�����ձۣ�----
  let driverDump = null;
  if (arm === 'stream') {
    const dumps = fs.readdirSync(taskDir).filter((n) => n.startsWith('driver-') && n.endsWith('.json'));
    if (dumps.length > 0) driverDump = JSON.parse(fs.readFileSync(path.join(taskDir, dumps[dumps.length - 1]), 'utf8'));
  }

  // ---- checks ----
  const checks = (task.checks || []).map((c) => {
    if (c.kind === 'exists') {
      return { ...c, pass: fs.existsSync(path.join(wsDir, c.path)) };
    }
    if (c.kind === 'contains') {
      const p = path.join(wsDir, c.path);
      const pass = fs.existsSync(p) && fs.readFileSync(p, 'utf8').includes(c.text);
      return { ...c, pass };
    }
    if (c.kind === 'final-contains') {
      const finalText = sessionFacts.finalMessages ? sessionFacts.finalMessages.map((m) => m.text).join('\n') : '';
      return { ...c, pass: finalText.includes(c.text), evidence: finalText.slice(0, 400) };
    }
    return { ...c, pass: false, note: 'unknown check kind' };
  });

  const metrics = {
    task: task.id, arm, type: task.type,
    started, finished, exitCode: res.status, timedOut: timedOut === true, signal: res.signal || null,
    stdoutTail: (res.stdout || '').slice(-800), stderrTail: (res.stderr || '').slice(-1500),
    M2_callCount: { main: sessionFacts.requestHeaderCount, probe: probeRequests.length, probeRaw: probeRequestsRaw.length, titleExcluded, note: 'v1.1�����ھ�=probe ������main(session log request/header) �����߱ۿɵã�������' },
    M1_tokens: { ...tokens, unitTaskToken: tokens.input + tokens.output, cachedFieldsSeen, usageOriginal, sourceNote: 'E3 �ھ���input=uncached+cacheRead+cacheWrite��usage ԭ����������' },
    M3_injectedRatio: driverDump
      ? { injected: driverDump.counters.injected, produced: driverDump.counters.produced, injectedRatio: driverDump.counters.injectedRatio, source: 'driver snapshot��Ȩ����' }
      : (arm === 'baseline' ? { note: 'n/a�����߱���ע����' } : { note: 'driver dump ȱʧ' }),
    M4_prefix: {
      sequence: prefixSequence(probeRequests),
      monotonicNote: '������ fullHash Ӧ������ͬ��׷��ʽ��ʷ����commonPrefixBytesWithPrev ��ӳǰ׺����Ǳ��',
      cachedFieldsEvidence: cachedFieldsSeen ? 'probe usage ԭ�ĺ� cache �ֶ�' : 'provider usage δ�� cache �ֶΣ���ʵ��ע���� usageOriginal��',
    },
    modelConfig: sessionFacts.providers || [],
    checks, checksPass: checks.every((c) => c.pass),
    sessionArchived: archived,
    sessionFactsNote: sessionFacts.error ? sessionFacts.error : undefined,
    replay: { pending: true, note: '�� replay-check.cjs ����' },
  };
  fs.writeFileSync(path.join(taskDir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8');
  console.log(`[${arm}/${task.id}] exit=${res.status} calls=${metrics.M2_callCount.probe}(recon:${metrics.M2_callCount.main}) tokens=${metrics.M1_tokens.unitTaskToken} checks=${metrics.checksPass ? 'PASS' : 'FAIL'} archived=${archived.archived}`);
  return metrics;
}

function main() {
  const arm = arg('arm', '');
  if (arm !== 'baseline' && arm !== 'stream') {
    console.error('--arm ������ baseline �� stream');
    process.exit(2);
  }
  const all = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  const picked = arg('tasks', 'all') === 'all' ? all.tasks : all.tasks.filter((t) => arg('tasks', '').split(',').includes(t.id));
  const stamp = arg('stamp', new Date().toISOString().slice(0, 10));
  const runDir = path.join(PKG_ROOT, 'eval', 'runs', stamp);
  fs.mkdirSync(runDir, { recursive: true });
  const timeoutSec = Number(arg('timeout', '600'));
  const apiKey = arg('key', '') || process.env.DEEPSEEK_API_KEY || '';

  console.log(`runner: arm=${arm} tasks=${picked.map((t) => t.id).join(',')} stamp=${stamp} key=${apiKey ? 'SET(****' + apiKey.slice(-4) + ')' : 'NOT SET'}`);
  const results = picked.map((t) => runTask(t, arm, runDir, apiKey, timeoutSec));
  fs.writeFileSync(path.join(runDir, `${arm}-summary.json`), JSON.stringify({ arm, stamp, startedAt: new Date().toISOString(), results }, null, 2), 'utf8');
  console.log(`summary -> ${path.join(runDir, arm + '-summary.json')}`);
}

if (require.main === module) main();
