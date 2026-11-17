// test/v031-display.test.ts —— v0.3.1 思考过程显示修复（electron 乱码 bug）
//
// 覆盖三条修复面：
//   - reasoning-delta 捕获：落盘 assistant/message 的 `{type:'reasoning'}` 内容块（桌面端
//     思考过程行的数据源；0.3.0 只计体积不落盘 → 思考区显示错误）
//   - 落盘正文纯 prose 化：tf-* 协议标记与 DSML 噪声不再进 assistant/message 文本
//     （0.3.0 落整段原文 → 桌面端过程区把标记渲染成乱码）
//   - agent/assistant-stream 实时帧：start → reasoning-delta chunks → end(committed+seq)，
//     revision/index 契约与宿主 SessionAssistantStreamAccumulator.accept 对齐；发射异常熔断
//
// 取证锚（宿主面）：dsh-client-ui-chat/src/client/conversation-nodes/{assistant,event-projection}.ts、
// dsh-api-session-controller/src/client/sessions/assistant-stream.ts。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, createSessionEventWriter } from '../src/entry/loop.ts';
import type {
  DriverPorts,
  StreamChunkLike,
  StreamDriverConfig,
  ToolBatchInputLike,
  ToolBatchResultLike,
} from '../src/entry/loop.ts';
import { TfStreamParser } from '../src/kernel/parser.ts';

// ---------------------------------------------------------------- 测试设施

interface FakeSessionEvent {
  type: string;
  data: Record<string, unknown>;
  opts?: unknown;
  seq: number;
}

function createFakeSession() {
  const events: FakeSessionEvent[] = [];
  return {
    id: 'session-display-test',
    header: { id: 'session-display-test' },
    events,
    append(type: string, data: unknown, opts?: unknown) {
      const seq = events.length + 1;
      events.push({ type, data: data as Record<string, unknown>, opts, seq });
      return { seq };
    },
    snapshotEvents(from = 0) {
      return events.slice(from);
    },
  };
}

type ChunkGen = AsyncGenerator<StreamChunkLike, void, undefined>;

/** 逐块吐出的假流：reasoning 块（index 0）→ 文本块（index 1）。 */
async function* scriptedStream(chunks: StreamChunkLike[]): ChunkGen {
  for (const c of chunks) yield c;
}

interface HarnessOpts {
  chunks: StreamChunkLike[];
  /** 沙箱工具执行器（缺省 = 空实现，全部 isError） */
  executor?: (input: ToolBatchInputLike) => Promise<ToolBatchResultLike>;
  /** 是否接线实时帧端口（缺省接线并记录帧） */
  wireFrames?: boolean;
  /** 实时帧发射行为覆写（熔断用例） */
  emit?: (event: string, payload: unknown) => void;
  signal?: AbortSignal;
}

function makeHarness(opts: HarnessOpts) {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v031-'));
  const session = createFakeSession();
  const frames: Array<{ agent: unknown; frame: Record<string, unknown> }> = [];
  const ports: DriverPorts = {
    stream: () => scriptedStream(opts.chunks),
    executeTools: opts.executor ?? (async (input) => ({
      results: input.calls.map((call) => ({
        callId: call.id,
        result: { content: [{ type: 'text', text: `sandbox: ${call.name}` }], isError: false },
      })),
      additionalContexts: [],
      concluded: false,
    })),
    ...(opts.wireFrames === false ? {} : {
      emitHostEvent: opts.emit ?? ((event: string, payload: unknown) => {
        frames.push({ agent: (payload as { agent: unknown }).agent, frame: (payload as { frame: Record<string, unknown> }).frame });
      }),
    }),
    events: createSessionEventWriter(session),
  };
  const config: StreamDriverConfig = { provider: 'mock', model: 'mock-display' };
  const driver = new SingleStreamDriver(ports, config);
  driver.setIdentity('session-display-test', 'task');
  const agent = { session, id: 'agent-1' };
  driver.setAgent(agent);
  driver.pushUserTask('测试任务');
  return {
    driver,
    session,
    frames,
    sandboxDir,
    cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }),
  };
}

function assistantMessages(session: ReturnType<typeof createFakeSession>) {
  return session.events
    .filter((e) => e.type === 'assistant/message')
    .map((e) => ({ seq: e.seq, message: e.data['message'] as { content: Array<{ type: string; text?: string }> } }));
}

/** 真机形态的块序列：思考 + prose + DSML 计划 + 命令（accepts 挂计划项）+ 收尾。 */
function realisticChunks(): StreamChunkLike[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' } as never,
    { type: 'reasoning-delta', index: 0, text: '先读文件，' } as never,
    { type: 'reasoning-delta', index: 0, text: '然后写结果。' } as never,
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先读文件，然后写结果。' } } as never,
    { type: 'block-start', index: 1, blockType: 'text' } as never,
    { type: 'text-delta', index: 1, text: '我先读取数据文件。\n' } as never,
    { type: 'text-delta', index: 1, text: '<｜｜DSML｜｜ calls>\n' } as never,
    { type: 'text-delta', index: 1, text: '<｜｜DSML｜｜ invoke name="tf-plan" id="p1">\n- [a1] 完成读取\n</tf-plan>\n' } as never,
    { type: 'text-delta', index: 1, text: '<tf-read path="data/x.md" id="r1" accepts="a1"/>\n' } as never,
    { type: 'text-delta', index: 1, text: '<tf-final id="f1" summary="已完成读取 data/x.md"/>' } as never,
    { type: 'block-end', index: 1, block: { type: 'text', text: 'full' } } as never,
    { type: 'finish', reason: { kind: 'stop' } } as never,
  ];
}

// ---------------------------------------------------------------- 用例

test('R1. reasoning-delta 落成 reasoning 内容块（桌面端思考过程数据源）', async () => {
  const h = makeHarness({ chunks: realisticChunks() });
  try {
    const reason = await h.driver.runTurn();
    assert.equal(reason.kind, 'completed');
    const msgs = assistantMessages(h.session);
    const streamMsg = msgs.find((m) => m.message.content.some((b) => b.type === 'reasoning'));
    assert.ok(streamMsg !== undefined, 'assistant/message 应携带 reasoning 块');
    const reasoning = streamMsg.message.content.find((b) => b.type === 'reasoning');
    assert.equal(reasoning?.text, '先读文件，然后写结果。', '同 index 的 delta 无缝拼接');
    // 块序：reasoning 在 text 前（镜像内建 BlockAssembler 流序）
    assert.equal(streamMsg.message.content[0]?.type, 'reasoning');
    assert.equal(streamMsg.message.content[1]?.type, 'text');
  } finally {
    h.cleanup();
  }
});

test('R2. 落盘正文纯 prose 化：协议标记与 DSML 噪声不进 assistant/message 文本', async () => {
  const h = makeHarness({ chunks: realisticChunks() });
  try {
    await h.driver.runTurn();
    const msgs = assistantMessages(h.session);
    const streamMsg = msgs.find((m) => m.message.content.some((b) => b.type === 'text'));
    const text = streamMsg?.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';
    assert.ok(text.includes('我先读取数据文件。'), 'prose 保留');
    assert.ok(!text.includes('<tf-read'), 'tf-* 命令标记不进落盘文本');
    assert.ok(!text.includes('DSML'), 'DSML 噪声不进落盘文本');
    assert.ok(!text.includes('tf-plan'), 'DSML 包装内的命令名不进落盘文本');
    // 命令事实仍在台账（驱动器记录）
    const snap = h.driver.snapshot();
    const cmdNames = snap.records.filter((r) => r.kind === 'command').map((r) => (r as { name?: string }).name);
    assert.ok(cmdNames.includes('tf-read') && cmdNames.includes('tf-plan') && cmdNames.includes('tf-final'), '命令照常登记');
    // DSML 包装行按 malformed 记账
    const malformed = snap.records.filter((r) => r.kind === 'malformed').map((r) => (r as { reason?: string }).reason);
    assert.ok(malformed.includes('dsml-wrapper'), 'dsml-wrapper 记账');
  } finally {
    h.cleanup();
  }
});

test('R3. 实时帧契约：start → 逐 delta chunk → end(committed, seq=落盘事件)', async () => {
  const h = makeHarness({ chunks: realisticChunks() });
  try {
    await h.driver.runTurn();
    assert.ok(h.frames.length >= 2, '至少 start + end 两帧');
    // payload 形状：agent 引用 + 帧
    for (const f of h.frames) {
      const agent = f.agent as { id?: string };
      assert.equal(agent?.id, 'agent-1');
    }
    // revision 全会话逐帧 +1（宿主 accumulator 契约：revision !== last+1 即整帧流失效）
    const revisions = h.frames.map((f) => f.frame['revision'] as number);
    for (let i = 1; i < revisions.length; i++) assert.equal(revisions[i], revisions[i - 1]! + 1);
    assert.equal(revisions[0], 1);
    // 首 attempt 分组：start → 全 chunk → end（重入产生的后续 attempt 各自成组）
    const endIdx = h.frames.findIndex((f) => f.frame['type'] === 'end');
    const firstAttempt = h.frames.slice(0, endIdx + 1);
    assert.equal(firstAttempt[0]!.frame['type'], 'start');
    assert.ok(firstAttempt.slice(1, -1).every((f) => f.frame['type'] === 'chunk'), 'attempt 内 start..end 之间全为 chunk 帧');
    // chunk 帧：只透传 reasoning-delta；index 逐 chunk +1
    const chunkFrames = firstAttempt.filter((f) => f.frame['type'] === 'chunk');
    chunkFrames.forEach((f, i) => assert.equal(f.frame['index'], i));
    const chunks = chunkFrames.map((f) => f.frame['chunk'] as { type: string; text: string });
    assert.ok(chunks.every((c) => c.type === 'reasoning-delta'), '正文不进实时帧（协议标记不闪现）');
    assert.deepEqual(chunks.map((c) => c.text), ['先读文件，', '然后写结果。']);
    // 首 attempt 收束：本流有工具广告（流中落盘 assistant/message）→ 广告前 abandoned 收束，
    // 避免广告条目滞留客户端 pending（会触发下一步 events.restart()）
    const end = firstAttempt[firstAttempt.length - 1]!.frame;
    assert.deepEqual(end['outcome'], { kind: 'abandoned' });
    // attemptId 会话内稳定且逐流唯一
    const attemptId = h.frames[0]!.frame['attemptId'];
    assert.equal(typeof attemptId, 'string');
    assert.ok((attemptId as string).startsWith('session-display-test:'));
  } finally {
    h.cleanup();
  }
});

test('R4. 无 reasoning 的流：空 attempt 帧（start→end）不产生 thinking 内容', async () => {
  const h = makeHarness({
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' } as never,
      { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="直接完成"/>' } as never,
      { type: 'finish', reason: { kind: 'stop' } } as never,
    ],
  });
  try {
    const reason = await h.driver.runTurn();
    assert.equal(reason.kind, 'completed');
    const types = h.frames.map((f) => f.frame['type']);
    assert.deepEqual(types, ['start', 'end'], '零 chunk 空 attempt 帧');
    // 无工具流 → attempt 存活到流末，end 帧与 durable 结算配对（committed + seq）
    // （本流无 prose 无原生调用 → 结算是 assistant/attempt；finalAnswer 的 message 在其后）
    const end = h.frames[h.frames.length - 1]!.frame;
    const settled = h.session.events.find((e) => e.type === 'assistant/attempt' || e.type === 'assistant/message');
    assert.ok(settled !== undefined);
    assert.deepEqual(end['outcome'], { kind: 'committed', eventType: settled.type, seq: settled.seq });
    const msgs = assistantMessages(h.session);
    const last = msgs[msgs.length - 1]!;
    assert.ok(!last.message.content.some((b) => b.type === 'reasoning'), '无 reasoning 块');
  } finally {
    h.cleanup();
  }
});

test('R5. 实时帧发射异常 → 熔断（fail-open），任务不受影响', async () => {
  let calls = 0;
  const h = makeHarness({
    chunks: realisticChunks(),
    emit: () => {
      calls += 1;
      throw new Error('host bus exploded');
    },
  });
  try {
    const reason = await h.driver.runTurn();
    assert.equal(reason.kind, 'completed', '熔断不影响任务收敛');
    assert.equal(calls, 1, '首帧抛错后不再发射（start 帧即熔断）');
    assert.ok(assistantMessages(h.session).length > 0, '落盘路径不受影响');
  } finally {
    h.cleanup();
  }
});

test('R6. 无 emitHostEvent 端口（headless/离线）：不发帧，其余行为不变', async () => {
  const h = makeHarness({ chunks: realisticChunks(), wireFrames: false });
  try {
    const reason = await h.driver.runTurn();
    assert.equal(reason.kind, 'completed');
    assert.equal(h.frames.length, 0);
    const msgs = assistantMessages(h.session);
    assert.ok(msgs.some((m) => m.message.content.some((b) => b.type === 'reasoning')), '落盘 reasoning 不依赖帧端口');
  } finally {
    h.cleanup();
  }
});

test('R7. 流中断（abort finish）：部分思考与 prose 如实落盘（interrupted 消息）', async () => {
  const h = makeHarness({
    chunks: [
      { type: 'block-start', index: 0, blockType: 'reasoning' } as never,
      { type: 'reasoning-delta', index: 0, text: '部分思考…' } as never,
      { type: 'block-start', index: 1, blockType: 'text' } as never,
      { type: 'text-delta', index: 1, text: '部分正文。' } as never,
      { type: 'finish', reason: { kind: 'aborted', message: 'cancelled' } } as never,
    ],
  });
  try {
    await h.driver.runTurn();
    const interrupted = h.session.events
      .filter((e) => e.type === 'assistant/message' && (e.data as { interrupted?: boolean }).interrupted === true);
    assert.ok(interrupted.length >= 1, '中断消息落盘（重入流可能产生多条，取首条断言）');
    const content = (interrupted[0]!.data as { message: { content: Array<{ type: string; text?: string }> } }).message.content;
    const reasoning = content.find((b) => b.type === 'reasoning');
    assert.equal(reasoning?.text, '部分思考…', '中断路径也携带部分思考');
    const text = content.find((b) => b.type === 'text');
    assert.equal(text?.text, '部分正文。', '中断正文纯 prose');
  } finally {
    h.cleanup();
  }
});

test('R8. DSML invoke 改写后的命令照常执行（命令事实不因噪声修复而丢）', async () => {
  const h = makeHarness({
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' } as never,
      { type: 'text-delta', index: 0, text: '<｜｜DSML｜｜ invoke name="tf-read" path="a.txt" id="r1"/>' } as never,
      { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="读取完成" depends_on="r1"/>' } as never,
      { type: 'finish', reason: { kind: 'stop' } } as never,
    ],
    executor: async (input) => ({
      results: input.calls.map((call) => ({
        callId: call.id,
        result: { content: [{ type: 'text', text: `read ok: ${call.name}` }], isError: false },
      })),
      additionalContexts: [],
      concluded: false,
    }),
  });
  try {
    const reason = await h.driver.runTurn();
    assert.equal(reason.kind, 'completed', '改写命令执行成功 → tf-final 依赖满足 → 收敛');
    const cmdNames = h.driver.snapshot().records.filter((r) => r.kind === 'command').map((r) => (r as { name?: string }).name);
    assert.ok(cmdNames.includes('tf-read'));
  } finally {
    h.cleanup();
  }
});

// parser 冒烟：确保 DSML 判定与 kernel 测试一致（防回归的独立锚点）
test('R9. parser 冒烟：DSML 前缀判定与驱动器使用同一内核', () => {
  const p = new TfStreamParser();
  const events = p.feed('<｜｜DSML｜｜ invoke name="tf-bash" cmd="echo hi" id="b1"/>');
  const cmds = events.filter((e) => e.type === 'command').map((e) => (e as { command: { name: string } }).command);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].name, 'tf-bash');
});
