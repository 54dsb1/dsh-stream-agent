// eval/tools/run-four-arm.mjs —— 四臂 benchmark 离线跑批（0.5.0 P7）
//
// 四臂定义（计划书 §12.1）：
//   L0 原生      无插件，standard preset            —— 真机臂（离线不可跑：无宿主/无模型）
//   L1 PTC       仅 PTC preset，无本插件            —— 真机臂（对照：code-as-action）
//   L2 标准通道  本插件 + standard preset，通道=标准 —— 离线可跑（mock 流；结构指标）
//   L3 代码通道  本插件 + PTC preset，通道=代码      —— 离线可跑（bridge 来源；结构指标）
//
// 离线跑批产出的是**结构指标**（N / tokens 估算 / C_max / 换基计数 / channel_source），
// 用 mock 流驱动真实驱动器代码路径——验证四臂的装配与度量管线可用；
// H1/H2 的**结论**（省 token ≥15%、交叉点 ≤6 回合）必须来自真机四臂（§12.3），
// 本脚本不伪造。用法：node eval/tools/run-four-arm.mjs [--out eval/runs/<id>/four-arm.json]

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 动态加载构建产物（stripTypeScriptTypes 已由 npm run build 产出 dist/）
const { SingleStreamDriver, normalizeStreamShim } = await import('file://' + join(pkgRoot, 'dist', 'entry', 'loop.js'));

// ---------------------------------------------------------------------------
// 任务集（§12.1：10 短任务 + 4 长任务 + 2 大文件任务；离线用 3 个代表性结构任务演示）
// ---------------------------------------------------------------------------

const TASKS = [
  {
    id: 'T1-single-read',
    kind: 'short',
    prompt: '单文件问答：读 notes.txt 并回答第三行内容。',
    files: { 'notes.txt': 'alpha\nbeta\ngamma-three\ndelta\n' },
    stream: (req) => [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: req === 0 ? '读。\n<tf-read path="notes.txt" id="r1"/>\n' : '<tf-final id="f1" summary="第三行：gamma-three"/>\n' },
      { type: 'usage', usage: { inputTokens: 600, outputTokens: 40, cacheReadTokens: req === 0 ? 0 : 500 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    code: (req) => req === 0
      ? [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: '直接调工具。\n' },
          { type: 'tool-call-delta', index: 1, id: 'nc1', name: 'run_code', argumentsDelta: '{"program":"read notes.txt"}' },
          { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'nc1', name: 'run_code', arguments: '{"program":"read notes.txt"}' } },
          { type: 'usage', usage: { inputTokens: 600, outputTokens: 60, cacheReadTokens: 0 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ]
      : [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: '结果已核对：第三行 gamma-three。' },
          { type: 'usage', usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 550 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ],
  },
  {
    id: 'T2-write-verify',
    kind: 'short',
    prompt: '写文件并收尾。',
    files: {},
    stream: (req) => [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: req === 0 ? '写。\n<tf-write path="out.txt" id="w1">结果正文</tf-write>\n' : '<tf-final id="f1" summary="已写 out.txt（结果正文）"/>\n' },
      { type: 'usage', usage: { inputTokens: 500, outputTokens: 60, cacheReadTokens: req === 0 ? 0 : 450 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    code: (req) => req === 0
      ? [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: '程序写。\n' },
          { type: 'tool-call-delta', index: 1, id: 'nc1', name: 'run_code', argumentsDelta: '{"program":"write out.txt"}' },
          { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'nc1', name: 'run_code', arguments: '{"program":"write out.txt"}' } },
          { type: 'usage', usage: { inputTokens: 500, outputTokens: 80, cacheReadTokens: 0 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ]
      : [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: '写入完成。' },
          { type: 'usage', usage: { inputTokens: 150, outputTokens: 15, cacheReadTokens: 480 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ],
  },
  {
    id: 'T3-multi-step',
    kind: 'long',
    prompt: '多步任务：读三个文件后逐个核对并收尾。',
    files: {
      'a.txt': 'A1\nA2\nA3\n',
      'b.txt': 'B1\nB2\nB3\n',
      'c.txt': 'C1\nC2\nC3\n',
    },
    stream: (req) => {
      const reads = ['a', 'b', 'c'];
      if (req < reads.length) {
        return [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: `读 ${reads[req]}。\n<tf-read path="${reads[req]}.txt" id="r${req}"/>\n` },
          { type: 'usage', usage: { inputTokens: 400, outputTokens: 30, cacheReadTokens: req * 300 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ];
      }
      return [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="A/B/C 均为示例文件，逐行核对完成：A1 A2 A3 B1 B2 B3 C1 C2 C3"/>\n' },
        { type: 'usage', usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 900 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ];
    },
    code: (req) => {
      if (req < 1) {
        return [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: '一个程序读三个文件。\n' },
          { type: 'tool-call-delta', index: 1, id: 'nc1', name: 'run_code', argumentsDelta: '{"program":"read a,b,c"}' },
          { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'nc1', name: 'run_code', arguments: '{"program":"read a,b,c"}' } },
          { type: 'usage', usage: { inputTokens: 400, outputTokens: 60, cacheReadTokens: 0 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ];
      }
      return [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: '核对完成：A1 A2 A3 B1 B2 B3 C1 C2 C3。' },
        { type: 'usage', usage: { inputTokens: 150, outputTokens: 25, cacheReadTokens: 380 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ];
    },
  },
];

// ---------------------------------------------------------------------------
// 跑批
// ---------------------------------------------------------------------------

function makePorts(task, streamFactory, sink) {
  const wireRequests = [];
  return {
    ports: {
      stream: (options) => {
        const req = wireRequests.length;
        wireRequests.push(options);
        sink.wireRequests.push({
          request: req + 1,
          promptChars: options.messages.reduce((n, m) => n + m.content.reduce((k, b) => k + (b.text ?? '').length, 0), 0),
        });
        return normalizeStreamShim((async function* () { for (const c of streamFactory(req)) yield c; })());
      },
      executeTools: async (input) => ({
        results: input.calls.map((c) => {
          const args = JSON.parse(c.arguments || '{}');
          if (c.name === 'read') {
            return { callId: c.id, result: { content: [{ type: 'text', text: task.files[String(args.file_path ?? '')] ?? '(missing)' }], isError: false } };
          }
          if (c.name === 'write') {
            task.files[String(args.file_path ?? '')] = String(args.content ?? '');
            return { callId: c.id, result: { content: [{ type: 'text', text: `written ${args.file_path}` }], isError: false } };
          }
          return { callId: c.id, result: { content: [{ type: 'text', text: `${c.name}:ok(run_code)` }], isError: false } };
        }),
      }),
      onToolSettled: () => {},
    },
    wireRequests,
  };
}

async function runArm(armId, task, streamFactory, config) {
  const sink = { wireRequests: [] };
  const { ports } = makePorts(task, streamFactory, sink);
  const driver = new SingleStreamDriver(ports, config);
  driver.pushUserTask(task.prompt);
  const started = Date.now();
  const reason = await driver.runTurn();
  const snap = driver.snapshot();
  const requests = snap.records.filter((r) => r.kind === 'request');
  const tokensStrict = requests.reduce((n, r) => n + (r.providerInputTokens !== undefined ? 0 : 0), 0)
    + snap.records.filter((r) => r.kind === 'usage').reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
  const cacheRead = snap.records.filter((r) => r.kind === 'usage').reduce((n, r) => n + (r.cacheReadTokens ?? 0), 0);
  const cMax = Math.max(0, ...requests.map((r) => r.prefixTokensEst ?? 0));
  const rebases = snap.rebaseCounts();
  return {
    arm: armId,
    task: task.id,
    channel: snap.channel(),
    outcome: reason.kind,
    N: snap.requestCount,
    tokens_total_strict: tokensStrict,
    tokens_total_with_cache: tokensStrict + cacheRead,
    C_max: cMax,
    rebase_count: { planned: rebases.planned, appendDrift: rebases.appendDrift },
    channel_source: snap.channel().codeSource ?? 'standard',
    verify_pass_rate: null, // 离线 mock 无真实验收语义；真机臂回填
    durationMs: Date.now() - started,
  };
}

const results = [];
for (const task of TASKS) {
  // L2 标准通道（离线 mock：无宿主工具面 → 协议独占路径）
  results.push(await runArm('L2', task, task.stream, {
    provider: 'mock', model: 'four-arm', channel: 'standard', tier: 'standard',
    maxInputTokens: 0, surfaceCompaction: false, observeBudgetTokens: 0,
  }));
  // L3 代码通道（bridge 来源；本插件窄桥执行 run_code 由 mock 原生通道承接）
  results.push(await runArm('L3', task, task.code, {
    provider: 'mock', model: 'four-arm', channel: 'code', codeSource: 'bridge',
    tier: 'standard', maxInputTokens: 0, surfaceCompaction: false, observeBudgetTokens: 0,
  }));
}

const outPath = process.argv.includes('--out')
  ? resolve(process.argv[process.argv.indexOf('--out') + 1])
  : join(pkgRoot, 'eval', 'runs', 'four-arm-offline.json');
mkdirSync(dirname(outPath), { recursive: true });
const payload = {
  schema: 'four-arm-offline/1',
  generatedAt: new Date().toISOString(),
  note: '离线结构跑批（mock 流驱动真实驱动器）：验证四臂装配与度量管线。H1/H2 结论须来自真机四臂（§12.3）——本文件不含也不得被引用为省 token 结论。',
  arms: {
    L0: { runnable: 'real-machine-only', config: '无插件，standard preset' },
    L1: { runnable: 'real-machine-only', config: '仅 PTC preset，无本插件' },
    L2: { runnable: 'offline-structural', config: '本插件 standard preset，channel=standard' },
    L3: { runnable: 'offline-structural', config: '本插件 PTC preset，channel=code（bridge）' },
  },
  metrics: results,
  paired: results.reduce((acc, r, i, arr) => {
    if (r.arm === 'L2') {
      const l3 = arr[i + 1];
      if (l3 !== undefined && l3.task === r.task) {
        acc.push({
          task: r.task,
          pairComparable: Math.abs(l3.N - r.N) <= 1,
          deltaN: l3.N - r.N,
          L2_strict: r.tokens_total_strict,
          L3_strict: l3.tokens_total_strict,
          L3_C_max: l3.C_max,
          L2_C_max: r.C_max,
        });
      }
    }
    return acc;
  }, []),
};
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`[four-arm] wrote ${outPath} (${results.length} runs)`);
for (const r of results) {
  console.log(`  ${r.arm}/${r.task}: N=${r.N} strict=${r.tokens_total_strict} C_max=${r.C_max} outcome=${r.outcome} source=${r.channel_source}`);
}
