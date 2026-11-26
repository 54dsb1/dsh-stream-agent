// test/v060-assembly.test.ts —— 0.6.0 §4 请求装配（RA-1..RA-5）。
//
// 判据来自计划 §4.4/§4.5：
//   RA-1 20 次投影逐字节一致；dry-run 与真实请求逐字段 diff，除允许字段外 0 差异；0 前缀违规
//   RA-2 >2,000 字符载荷同 sha 单请求 ≤1 次；重复载荷字节占比 ≤5%；压缩后句柄回取 20/20
//   RA-3 首请求 tools 为空、toolsChars=0；声明名 ≤7；未列出工具可按名调用
//   RA-4 超限发送 0 次；每次拒绝有 [budget] 与贡献项；无半截前缀
//   RA-5 回退后请求体与基线逐字节一致；20/20 回退；回退事件可检索

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, normalizeStreamShim } from '../src/entry/loop.ts';
import type { DriverPorts, StreamChunkLike, StreamDriverConfig, ToolBatchInputLike, ToolBatchResultLike, StreamRequestOptions } from '../src/entry/loop.ts';
import {
  ASSEMBLY_BLOCK_ORDER, DEFAULT_PAYLOAD_MIN_CHARS, MAX_DECLARED_TOOLS,
  budgetContributions, projectAssembly, serializeAssemblyPlan,
} from '../src/kernel/assembly.ts';
import type { AssemblyInput } from '../src/kernel/assembly.ts';

// ================================================================ 设施

type Chunk = StreamChunkLike;

async function* scripted(chunks: readonly Chunk[]): AsyncGenerator<Chunk, void, undefined> {
  for (const c of chunks) yield c;
}

const text = (t: string): Chunk => ({ type: 'text-delta', index: 1, text: t }) as Chunk;
const stop = (): Chunk => ({ type: 'finish', reason: { kind: 'stop' } }) as Chunk;

interface Wire {
  messages: StreamRequestOptions['messages'];
  tools?: unknown;
  /** 扁平化文本（断言用） */
  flat: string;
}

interface Harness {
  driver: SingleStreamDriver;
  wires: Wire[];
  ledger: Array<{ type: string; data: Record<string, unknown> }>;
  faults: (fault: string) => number;
  cleanup: () => void;
}

function makeHarness(
  responses: ReadonlyArray<readonly Chunk[]>,
  config: Partial<StreamDriverConfig> = {},
  toolsService?: DriverPorts['toolsService'],
  toolResult?: (name: string) => string,
): Harness {
  const sandbox = mkdtempSync(join(tmpdir(), 'tf-v060-asm-'));
  const wires: Wire[] = [];
  const ledger: Harness['ledger'] = [];
  let call = 0;
  const ports: DriverPorts = {
    stream: (options) => {
      wires.push({
        messages: options.messages,
        ...(options.tools === undefined ? {} : { tools: options.tools }),
        flat: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('')).join('\n'),
      });
      const chunks = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return normalizeStreamShim(scripted(chunks) as never) as AsyncIterable<Chunk>;
    },
    executeTools: async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => ({
      results: input.calls.map((c) => ({
        callId: c.id,
        result: { content: [{ type: 'text', text: toolResult === undefined ? `ok:${c.name}` : toolResult(c.name) }], isError: false },
      })),
    }),
    ...(toolsService === undefined ? {} : { toolsService }),
    events: {
      turnStart: () => {}, stepStart: () => {}, stepEnd: () => {}, turnEnd: () => {},
      assistantMessage: () => ({ eventType: 'assistant/message', seq: 0 }),
      toolLog: () => undefined,
      finalAnswer: () => {},
    },
  };
  const driver = new SingleStreamDriver(ports, { provider: 'mock', model: 'mock-v060-asm', requireFinal: true, ...config });
  driver.attachLedger({ record: (type, data) => ledger.push({ type, data: data as Record<string, unknown> }) });
  return {
    driver,
    wires,
    ledger,
    faults: (fault) => (driver.snapshot().records as Array<{ kind: string; fault?: string }>).filter((r) => r.kind === 'fault' && r.fault === fault).length,
    cleanup: () => rmSync(sandbox, { recursive: true, force: true }),
  };
}

const finishTurn: readonly Chunk[] = [
  text('收尾：示例内容已核对，无未完成项。\n'),
  text('<tf-final id="f1" summary="示例内容已核对：示例文件，约定一致，无未完成项。"/>\n'),
  stop(),
];

// ================================================================ RA-1

const kernelInput: AssemblyInput = {
  channel: 'CHANNEL-TEXT',
  protocol: 'PROTOCOL-TEXT',
  tools: [{ name: 'read', description: 'read file', parameters: { type: 'object' } }],
  invariants: 'INVARIANTS',
  state: 'STATE',
  history: [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'did something' },
  ],
  tail: [{ role: 'user', content: 'tail' }],
  budgetLimit: 0,
};

test('RA-1a. 纯函数：同一状态连续投影 20 次逐字节一致；块顺序固定 channel→protocol→tools→invariants→state', () => {
  const first = serializeAssemblyPlan(projectAssembly(kernelInput));
  for (let i = 0; i < 20; i += 1) {
    assert.equal(serializeAssemblyPlan(projectAssembly(kernelInput)), first, `第 ${i + 1} 次投影必须逐字节一致`);
  }
  const plan = projectAssembly(kernelInput);
  assert.deepEqual(plan.system.blocks.map((b) => b.id), [...ASSEMBLY_BLOCK_ORDER], '块顺序必须固定');
  assert.equal(plan.messages[0]!.role, 'system');
  assert.ok(plan.system.hash.length === 64, 'system.hash = sha256（可外部复算）');
});

test('RA-1b. plan 模式：dry-run 与真实请求逐字段一致（除 source 元数据），0 前缀违规', async () => {
  const h = makeHarness([finishTurn], { assemblyPolicy: 'plan' });
  try {
    h.driver.pushUserTask('直接收尾。');
    const reason = await h.driver.runTurn();
    assert.equal(reason.kind, 'completed', JSON.stringify(reason));
    assert.equal(h.wires.length, 1);
    const plan = h.driver.lastAssemblyPlan();
    assert.ok(plan !== null, 'plan 模式必须留下投影');
    const sent = h.wires[0]!;
    assert.equal(sent.messages.length, plan.messages.length, '消息条数必须与投影一致');
    for (const [i, m] of sent.messages.entries()) {
      const flat = m.content.map((b) => b.text ?? '').join('');
      assert.equal(flat, plan.messages[i]!.content, `第 ${i} 条消息逐字节一致`);
      assert.equal(m.role, plan.messages[i]!.role);
    }
    // 除允许字段（source 元数据）外逐字段一致：tools / reasoning / budget 也必须对上
    assert.deepEqual(sent.tools ?? null, plan.tools, 'tools 字段必须与投影一致（null = 不声明）');
    assert.equal(plan.reasoning, 'provider-required', 'reasoning 策略必须显式');
    // budget 必须能从**实际发送的内容**独立复算（不是自己跟自己比）
    const sentTokens = Math.ceil(sent.messages.reduce((n, m) => {
      const t = m.content.map((b) => b.text ?? '').join('');
      let ascii = 0;
      let wide = 0;
      for (const ch of t) {
        if (ch.codePointAt(0)! >= 0x2e80) wide += 1;
        else ascii += 1;
      }
      return n + ascii / 4 + wide * 0.7;
    }, 0));
    assert.equal(plan.budget.estimatedInputTokens, sentTokens, 'budget 估算必须与实发内容复算一致');
    assert.equal(plan.budget.overBy, 0, '未超预算时 overBy=0');
    assert.equal(h.faults('assembly-budget'), 0);
    // 标题承诺的"0 前缀违规"必须真的断言（此前只有 wire==plan，没有故障计数）
    assert.equal(h.faults('prefix-broken'), 0, 'plan 模式不得出现前缀破坏');
    assert.equal(h.faults('prefix-reset'), 0, 'plan 模式不得消耗 append-drift 放行预算');
    assert.equal(h.faults('assembly-fallback'), 0, 'plan 模式不得回退');
    assert.equal(h.faults('assembly-fallback'), 0, 'plan 模式正常情况下不得回退');
    // dry-run 同一状态两次逐字节一致
    const a = h.driver.assemblyDryRun();
    const b = h.driver.assemblyDryRun();
    assert.equal(serializeAssemblyPlan(a!), serializeAssemblyPlan(b!), 'dry-run 必须确定性');
  } finally {
    h.cleanup();
  }
});

test('RA-1c. host 模式（默认）不受影响：请求内容与 0.5.x 渲染一致（plan 不介入）', async () => {
  const h = makeHarness([finishTurn]);
  try {
    h.driver.pushUserTask('直接收尾。');
    await h.driver.runTurn();
    assert.equal(h.driver.lastAssemblyPlan(), null, 'host 模式不产生投影');
    assert.equal(h.wires.length, 1);
    assert.ok(h.wires[0]!.flat.includes('tf-final'), '协议文本仍在 system 前缀里');
  } finally {
    h.cleanup();
  }
});

// ================================================================ RA-2

test('RA-2a. 内容寻址去重：同一 >2,000 字符载荷在单请求内同 sha 只保留一份（第二次为 ref 行）', () => {
  const payload = `PAYLOAD-HEAD\n${'x'.repeat(DEFAULT_PAYLOAD_MIN_CHARS)}\nPAYLOAD-TAIL`;
  const input: AssemblyInput = {
    ...kernelInput,
    history: [
      { role: 'user', content: 'task' },
      { role: 'user', content: payload, id: 'obs1' },
      { role: 'assistant', content: 'ack' },
      { role: 'user', content: payload, id: 'obs2' },
    ],
    tail: [],
  };
  const plan = projectAssembly(input);
  const bodies = plan.messages.filter((m) => m.content === payload);
  assert.equal(bodies.length, 1, '同 sha 载荷正文只能出现 1 次');
  const refs = plan.messages.filter((m) => m.content.includes('[tf-payload ref=sha256:'));
  assert.equal(refs.length, 1, '重复载荷必须降级为引用行');
  assert.ok(refs[0]!.ref?.startsWith('sha256:'), '引用行携带内容寻址 ref');
  assert.ok(refs[0]!.content.includes('tf-peek'), '引用行必须指出取回通道（不是摘要）');
});

test('RA-2b. 重复载荷字节占比 ≤5%（20 块 × 3,000 字符，其中 1 块重复一次）', () => {
  const blocks: string[] = [];
  for (let i = 0; i < 19; i += 1) blocks.push(`BLOCK-${i}\n${String(i).repeat(3000)}`);
  blocks.push(blocks[0]!); // 第 20 块 = 第 1 块（真实会话里的"重复读同一文件"形态）
  const plan = projectAssembly({
    ...kernelInput,
    history: [{ role: 'user', content: 'task' }, ...blocks.map((content) => ({ role: 'user' as const, content }))],
    tail: [],
  });
  const totalBytes = plan.messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8'), 0);
  const refBytes = plan.messages
    .filter((m) => m.content.includes('[tf-payload ref='))
    .reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8'), 0);
  assert.equal(plan.messages.filter((m) => m.content === blocks[0]).length, 1, '同 sha 正文只出现 1 次');
  assert.ok(refBytes / totalBytes <= 0.05, `重复载荷字节占比 ${(refBytes / totalBytes * 100).toFixed(2)}% 必须 ≤5%`);
});

test('RA-2c. 去重不改写原文：句柄回取 20/20（引用行只是指针，原文仍完整可取回）', async () => {
  // 说明（口径）：端到端注入的**观测块是骨架/摘要形态**（不是 2200 字符原文），因此
  // "同 sha 正文只出现一份"的投影证明在内核层（RA-2a 直接对 projectAssembly 断言）。
  // 本用例证明端到端不丢原文：被去重引用的载荷，句柄仍能按原长度完整取回。
  const payload = `KEEP\n${'z'.repeat(2200)}`;
  for (let n = 0; n < 20; n += 1) {
    const h = makeHarness([
      [text('读两份相同内容。\n'), text(`<tf-read path="dup-a-${n}.txt" id="r1"/>\n`), text(`<tf-read path="dup-b-${n}.txt" id="r2"/>\n`), stop()],
      finishTurn,
    ], { assemblyPolicy: 'plan' }, undefined, () => payload);
    try {
      h.driver.pushUserTask('读两份相同内容。');
      await h.driver.runTurn();
      const handle = 'obs:read:r1@v1';
      const got = h.driver.peekHandle(handle);
      assert.ok(got !== null && got.includes('KEEP'), `用例 ${n}: 句柄必须可取回原文（含载荷头）`);
      assert.ok(got!.length >= 2200, `用例 ${n}: 取回正文长度必须与载荷一致（实际 ${got!.length}）`);
      // 同一份载荷在"投影层"只保留一份正文（内核层证据，与端到端取回并列）
      const plan = projectAssembly({
        ...kernelInput,
        history: [
          { role: 'user', content: 'task' },
          { role: 'user', content: payload, id: 'dup-a' },
          { role: 'user', content: payload, id: 'dup-b' },
        ],
        tail: [],
      });
      assert.equal(plan.messages.filter((m) => m.content === payload).length, 1, `用例 ${n}: 同 sha 正文只保留 1 份`);
      assert.equal(plan.messages.filter((m) => m.content.includes('[tf-payload ref=sha256:')).length, 1, `用例 ${n}: 第二份降级为引用行`);
    } finally {
      h.cleanup();
    }
  }
});

// ================================================================ RA-3

test('RA-3a. 首请求不声明工具（toolsChars=0）；后续声明名 ≤7', async () => {
  const schemas = Array.from({ length: 12 }, (_, i) => ({ name: `tool_${String(i).padStart(2, '0')}`, description: `d${i}`, parameters: { type: 'object' } }));
  const toolsService = {
    resolve: async () => ({ ok: true }),
    schemas: () => schemas,
  };
  const h = makeHarness([
    [text('读。\n'), text('<tf-read path="a.txt" id="r1"/>\n'), stop()],
    finishTurn,
  ], { assemblyPolicy: 'plan', nativeTools: true }, toolsService);
  try {
    h.driver.pushUserTask('读文件后收尾。');
    await h.driver.runTurn();
    assert.ok(h.wires.length >= 2, '至少两次请求');
    assert.equal(h.wires[0]!.tools, undefined, '首请求不得携带 tools（A2：0 schema）');
    const plan0 = h.driver.lastAssemblyPlan();
    assert.ok(plan0 !== null);
    const declared = h.wires[1]!.tools as Array<{ name: string }> | undefined;
    assert.ok(declared !== undefined, '后续请求可以声明工具');
    assert.ok(declared!.length <= MAX_DECLARED_TOOLS, `声明名 ≤${MAX_DECLARED_TOOLS}（实际 ${declared!.length}）`);
  } finally {
    h.cleanup();
  }
});

test('RA-3b. 未列出的工具仍可按名调用（声明面不是调用面）', async () => {
  // 12 个工具面成员，声明面上限 7 → 至少 5 个"未声明但在面内"的工具必须仍按名可调。
  const schemas = Array.from({ length: 12 }, (_, i) => ({ name: `tool_${String(i).padStart(2, '0')}`, description: `d${i}`, parameters: {} }));
  const toolsService = { resolve: async () => ({ ok: true }), schemas: () => schemas };
  const h = makeHarness([
    [text('读。\n'), text('<tf-read path="a.txt" id="r1"/>\n'), stop()],
    finishTurn,
  ], { assemblyPolicy: 'plan', nativeTools: true }, toolsService);
  try {
    h.driver.pushUserTask('读文件后收尾。');
    await h.driver.runTurn();
    const declared = (h.wires[1]!.tools as Array<{ name: string }>).map((d) => d.name);
    const undeclared = schemas.map((d) => d.name).filter((n) => !declared.includes(n));
    assert.ok(undeclared.length > 0, '本用例必须存在未声明的工具');
    for (const name of undeclared) {
      assert.equal(h.driver.toolReachable(name), true, `未声明的工具 ${name} 仍必须按名可调`);
    }
    assert.equal(h.driver.toolReachable('no-such-tool'), false, '未知工具必须被拒（结构化）');
    // 端到端：用 tf-call 调一个**未声明**工具，执行器必须真的收到该名字（声明面不是调用面）
    const target = undeclared[0]!;
    const h2 = makeHarness([
      [text('调用。\n'), text(`<tf-call name="${target}" id="c1">{}</tf-call>\n`), stop()],
      finishTurn,
    ], { assemblyPolicy: 'plan', nativeTools: true }, toolsService);
    try {
      h2.driver.pushUserTask('调用未声明工具。');
      await h2.driver.runTurn();
      const calls = (h2.driver.snapshot().records as Array<{ kind: string; name?: string; status?: string; detail?: string }>)
        .filter((r) => r.kind === 'command' && r.name === 'tf-call');
      assert.ok(calls.some((c) => c.status === 'ok'), `tf-call 必须成功（实际 ${JSON.stringify(calls).slice(0, 200)}）`);
    } finally {
      h2.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

// ================================================================ RA-4

test('RA-4. 50 组超限注入：超限发送 0 次；每次拒绝都有 [budget] 与贡献项', async () => {
  // 真实超限路径 = 回合内上下文增长（读回大载荷）越过上限：
  // 回合起始的下限保护看的是**初始**任务（小任务可通过），预算拒绝发生在后续装配。
  let sent = 0;
  let refusals = 0;
  for (let n = 0; n < 50; n += 1) {
    const limit = 9000 + (n % 5) * 100;
    const h = makeHarness(
      [
        [text('读大文件。\n'), text(`<tf-read path="big-${n}.txt" id="r1"/>\n`), stop()],
        finishTurn,
      ],
      { assemblyPolicy: 'plan', maxInputTokens: limit, keepRecent: 0 },
      undefined,
      // 每次注入不同体积的大载荷（46k + n*300 字符 ≈ 11.5k+ tokens）→ 第 2 个请求必然超限
      () => `BIG-${n}\n${'v'.repeat(46000 + n * 300)}`,
    );
    try {
      h.driver.pushUserTask('读大文件后收尾。');
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'blocked', `用例 ${n}: 超限必须 fail-closed（实际 ${JSON.stringify(reason).slice(0, 160)}）`);
      const detail = reason.kind === 'blocked' ? reason.detail : '';
      assert.ok(detail.includes('[budget]'), `用例 ${n}: 拒绝文案必须带 [budget]（实际：${detail.slice(0, 120)}）`);
      assert.ok(detail.includes('主要贡献'), `用例 ${n}: 必须列贡献项`);
      // 超限请求一次都不得发出：首个请求发出（合法），超限那个必须被拦在发送前
      sent += h.wires.length;
      refusals += h.faults('assembly-budget');
      assert.equal(h.faults('assembly-budget'), 1, `用例 ${n}: 每次拒绝恰落一条台账`);
      assert.ok(h.wires.length <= 1, `用例 ${n}: 超限请求不得发送（实际发送 ${h.wires.length}）`);
    } finally {
      h.cleanup();
    }
  }
  assert.equal(refusals, 50, `每次拒绝都必须落台账（实际 ${refusals}/50）`);
  assert.equal(sent, 50, `每个用例恰有 1 个合法请求被发送（${sent}/50），超限那次 0 发送`);
});

test('RA-4b. 贡献项可定位：最大项占比 ≥ 其它项，且给出 tokens/chars 双口径', () => {
  const plan = projectAssembly({ ...kernelInput, budgetLimit: 10 });
  assert.ok(plan.budget.overBy > 0);
  const contributions = budgetContributions(plan);
  assert.ok(contributions.length > 0);
  assert.ok(contributions[0]!.tokens >= contributions[contributions.length - 1]!.tokens, '按 tokens 降序');
  assert.ok(contributions.every((c) => c.chars >= 0 && c.tokens >= 0 && c.share >= 0 && c.share <= 1));
});

// ================================================================ RA-5

test('RA-5a. 投影失败 20/20 回退 host，且回退后请求体与纯 host 基线逐字节一致', async () => {
  const baseHarness = makeHarness([
    [text('读。\n'), text('<tf-read path="a.txt" id="r1"/>\n'), stop()],
    finishTurn,
  ]);
  const baseline: string[] = [];
  try {
    baseHarness.driver.pushUserTask('读文件后收尾。');
    await baseHarness.driver.runTurn();
    for (const w of baseHarness.wires) baseline.push(w.flat);
  } finally {
    baseHarness.cleanup();
  }

  for (let n = 0; n < 20; n += 1) {
    const h = makeHarness([
      [text('读。\n'), text('<tf-read path="a.txt" id="r1"/>\n'), stop()],
      finishTurn,
    ], { assemblyPolicy: 'plan', assemblyFaultInject: { project: true } });
    try {
      h.driver.pushUserTask('读文件后收尾。');
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed', `用例 ${n}: 回退后必须正常完成（${JSON.stringify(reason)}）`);
      assert.equal(h.faults('assembly-fallback'), 1, `用例 ${n}: 必须记录一次回退`);
      const fallbackEvents = h.ledger.filter((r) => r.type === 'plugin:tf-agent/fault' && r.data['fault'] === 'assembly-fallback');
      assert.equal(fallbackEvents.length, 1, `用例 ${n}: 回退事件必须可检索（台账）`);
      assert.equal(h.driver.runtimeStatus().assembly.policy, 'host', `用例 ${n}: 回退后固定 host`);
      assert.deepEqual(h.wires.map((w) => w.flat), baseline, `用例 ${n}: 回退后请求体必须与 host 基线逐字节一致`);
    } finally {
      h.cleanup();
    }
  }
});

test('RA-5b. plan 模式回退后不再来回抖动：同会话后续回合保持 host', async () => {
  const h = makeHarness([
    [text('读。\n'), text('<tf-read path="a.txt" id="r1"/>\n'), stop()],
    finishTurn,
    finishTurn,
  ], { assemblyPolicy: 'plan', assemblyFaultInject: { project: true } });
  try {
    h.driver.pushUserTask('第一回合。');
    await h.driver.runTurn();
    const after1 = h.faults('assembly-fallback');
    h.driver.pushUserTask('第二回合。');
    await h.driver.runTurn();
    assert.equal(h.faults('assembly-fallback'), after1, '回退只发生一次（后续回合不再尝试 plan）');
    assert.equal(h.driver.runtimeStatus().assembly.policy, 'host');
  } finally {
    h.cleanup();
  }
});
