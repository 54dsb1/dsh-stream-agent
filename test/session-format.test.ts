// test/session-format.test.ts —— v0.3.0：会话日志的 v4 工具生命周期回归
//
// 背景（真机事故）：宿主的 v4 会话格式要求每个 tool/call 都能在同一 turn/step 的
// assistant/message 里找到同名同参的 tool-call 块，并且 step/end 时不得留下未解调用。
// 插件在 0.3.0 及更早版本里直接调 ctx.tools.execute（宿主管线负责落 tool/call +
// tool/result），却从未写过带 tool-call 块的 assistant/message → 读取时抛
// `tool/call <id> has no advertised tool lifecycle`，整条会话被判 corrupt，
// 桌面端表现为"历史加载失败"。
//
// 本测试用一个"宿主同款"的假工具管线（start → tool/call；commit → tool/result），
// 断言驱动器写出的会话事件满足生命周期约束。宿主的真实校验器在
// dsh-session-format-v3-to-v4；插件仓库不依赖宿主包，这里按同一规则本地复核。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SingleStreamDriver, normalizeStreamShim, createSessionEventWriter } from '../src/entry/loop.ts';
import type { ToolBatchInputLike, ToolBatchResultLike } from '../src/entry/loop.ts';
import { createMockModel } from '../src/entry/mock-provider.ts';
import type { MockModel, Scenario } from '../src/entry/mock-provider.ts';

interface FakeEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  surfaceOp?: string;
  sourceEventSeqs?: number[];
}

interface FakeSession {
  id: string;
  readonly seq: number;
  events: FakeEvent[];
  append(type: string, data: unknown, opts?: { surfaceOp?: string; sourceEventSeqs?: number[] }): FakeEvent;
  snapshotEvents(from?: number): FakeEvent[];
}

function createFakeSession(): FakeSession {
  const events: FakeEvent[] = [];
  let seq = 0;
  return {
    id: 'session-format-fixture',
    get seq() {
      return seq;
    },
    events,
    append(type, data, opts) {
      const event: FakeEvent = { type, seq: seq++, time: Date.now(), data: data as Record<string, unknown> };
      if (opts?.surfaceOp !== undefined) event.surfaceOp = opts.surfaceOp;
      if (opts?.sourceEventSeqs !== undefined) event.sourceEventSeqs = opts.sourceEventSeqs;
      events.push(event);
      return event;
    },
    snapshotEvents(from = 0) {
      return events.slice(from);
    },
  };
}

function loadScenario(name: string): Scenario {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'scenarios', name), 'utf8')) as Scenario;
}

/** 宿主同款工具管线（dsh-tools/lib/pipeline.js:BatchSettlement）：未落 result 时绝不返回。 */
function createHostLikeTools(session: FakeSession, options: { throwBeforeDispatch?: boolean } = {}) {
  return async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => {
    if (options.throwBeforeDispatch === true) throw new Error('host tool pipeline exploded before dispatch');
    const results = [];
    for (const call of input.calls) {
      const content = [{ type: 'text' as const, text: `ok:${call.name}` }];
      const callSeq = session.append('tool/call', {
        turn: input.log?.turn,
        step: input.log?.step,
        callId: call.id,
        name: call.name,
        arguments: call.arguments,
      }).seq;
      session.append('tool/result', {
        turn: input.log?.turn,
        step: input.log?.step,
        message: {
          id: `tool-result-${call.id}`,
          role: 'tool',
          source: { kind: 'tool', callId: call.id },
          toolCallId: call.id,
          content,
        },
      }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] });
      results.push({ callId: call.id, result: { content, isError: false } });
    }
    return { results };
  };
}

function createDriver(session: FakeSession, model: MockModel, tools: (input: ToolBatchInputLike) => Promise<ToolBatchResultLike>) {
  return new SingleStreamDriver({
    stream: (options) => normalizeStreamShim(model.adapter.stream({
      provider: options.provider,
      model: options.model,
      messages: options.messages,
      signal: options.signal,
    })),
    executeTools: tools,
    events: createSessionEventWriter(session),
    onToolSettled: () => model.notifyToolResult(),
  }, { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000 });
}

/**
 * 本地复核 v4 工具生命周期（与 dsh-session-format-v3-to-v4 的 tool()/closeTools 同规则）：
 *   ① assistant/message 的 tool-call 块登记 pending（id 不得重复）；
 *   ② tool/call 必须匹配 pending（同 name、同 arguments 字符串）；
 *   ③ tool/result 必须闭合 pending；
 *   ④ step/end 前不得有未闭合调用；
 *   ⑤ assistant/message 必须落在打开的 turn+step 内（不允许 step/end 之后写）。
 */
function assertToolLifecycle(events: readonly FakeEvent[]): void {
  const pending = new Map<string, { name: unknown; arguments: unknown; started: boolean }>();
  let turn: number | null = null;
  let step: number | null = null;
  for (const event of events) {
    const data = event.data as { turn?: number; step?: number };
    if (event.type === 'turn/start') {
      turn = data.turn ?? null;
      step = null;
      pending.clear();
      continue;
    }
    if (event.type === 'step/start') {
      assert.equal(data.turn, turn, 'step/start 必须属于当前 turn');
      step = data.step ?? null;
      continue;
    }
    if (event.type === 'step/end') {
      assert.equal(data.turn, turn, 'step/end 必须属于当前 turn');
      assert.equal(data.step, step, 'step/end 必须闭合当前 step');
      assert.equal(pending.size, 0, `step/end 不得留下未解工具调用（剩余 ${[...pending.keys()].join(',')}）`);
      step = null;
      continue;
    }
    if (event.type === 'turn/end') {
      turn = null;
      step = null;
      continue;
    }
    if (event.type === 'assistant/message') {
      assert.equal(data.turn, turn, `${event.type}#${event.seq} 必须属于当前 turn`);
      assert.equal(data.step, step, `${event.type}#${event.seq} 必须落在打开的 step 内（step/end 之后不得再写）`);
      const message = (event.data as { message?: { content?: Array<{ type?: string; id?: string; name?: unknown; arguments?: unknown }> } }).message;
      for (const block of message?.content ?? []) {
        if (block.type !== 'tool-call') continue;
        const id = String(block.id);
        assert.equal(pending.has(id), false, `assistant/message 不得重复广告 tool-call ${id}`);
        pending.set(id, { name: block.name, arguments: block.arguments, started: false });
      }
      continue;
    }
    if (event.type === 'tool/call') {
      const callId = String((event.data as { callId?: unknown }).callId);
      const entry = pending.get(callId);
      assert.notEqual(entry, undefined, `tool/call ${callId} 没有同步骤的 assistant/message 广告（v4 corrupt）`);
      assert.equal((event.data as { name?: unknown }).name, entry!.name, `tool/call ${callId} 的 name 必须与广告一致`);
      assert.equal((event.data as { arguments?: unknown }).arguments, entry!.arguments, `tool/call ${callId} 的 arguments 必须与广告逐字节一致`);
      entry!.started = true;
      continue;
    }
    if (event.type === 'tool/result') {
      const callId = String((event.data as { message?: { toolCallId?: unknown } }).message?.toolCallId);
      const entry = pending.get(callId);
      assert.notEqual(entry, undefined, `tool/result ${callId} 没有对应的广告/调用`);
      if (!entry!.started) {
        // 未开始的调用只接受宿主 TOOL_NOT_STARTED 修复形状
        const message = (event.data as { message?: { id?: string; isError?: boolean } }).message;
        const error = (event.data as { error?: { name?: string; code?: string } }).error;
        assert.ok(String(message?.id).startsWith(`interrupted-tool-result-${callId}-`), `未开始调用的 result 必须是 TOOL_NOT_STARTED 修复形状（id 前缀）`);
        assert.equal(message?.isError, true);
        assert.equal(error?.name, 'ToolNotStartedError');
        assert.equal(error?.code, 'TOOL_NOT_STARTED');
      }
      pending.delete(callId);
    }
  }
}

describe('S. 会话日志 v4 工具生命周期（v0.3.0 回归）', () => {
  it('S1. 正常回合：每个 tool/call 前都有同步骤广告，且 step/end 前全部闭合', async () => {
    const session = createFakeSession();
    const model = createMockModel({ scenarios: [loadScenario('5-file-basic.json')], provider: 'mock' });
    const driver = createDriver(session, model, createHostLikeTools(session));
    driver.pushUserTask('请写五个文件：f1 到 f5。');
    const reason = await driver.runTurn();
    assert.equal(reason.kind, 'completed');
    assertToolLifecycle(session.events);
    const calls = session.events.filter((e) => e.type === 'tool/call');
    assert.equal(calls.length, 5, '五个 tf-write 都应落到 tool/call');
    const ads = session.events.filter((e) => e.type === 'assistant/message'
      && (e.data as { message?: { content?: Array<{ type?: string }> } }).message?.content?.some((b) => b.type === 'tool-call'));
    assert.equal(ads.length, 5, '每个 tool/call 前应有一条只含 tool-call 块的 assistant/message');
    for (const call of calls) {
      const ad = ads.find((a) => a.seq < call.seq);
      assert.notEqual(ad, undefined, `tool/call#${call.seq} 之前必须有广告`);
    }
  });

  it('S2. 派发前异常：广告被 TOOL_NOT_STARTED 修复闭合，日志仍满足生命周期', async () => {
    const session = createFakeSession();
    const model = createMockModel({ scenarios: [loadScenario('5-file-basic.json')], provider: 'mock' });
    const driver = createDriver(session, model, createHostLikeTools(session, { throwBeforeDispatch: true }));
    driver.pushUserTask('请写五个文件：f1 到 f5。');
    await driver.runTurn();
    assertToolLifecycle(session.events);
    const ads = session.events.filter((e) => e.type === 'assistant/message'
      && (e.data as { message?: { content?: Array<{ type?: string }> } }).message?.content?.some((b) => b.type === 'tool-call'));
    const repairs = session.events.filter((e) => e.type === 'tool/result');
    assert.ok(ads.length > 0, '至少有一个调用被广告后再派发失败');
    assert.equal(repairs.length, ads.length, '每个广告都应在同步骤内被修复结果闭合');
  });

  it('S3. final 答案消息必须写在 step/end 之前（v4 要求打开的 turn+step）', async () => {
    const session = createFakeSession();
    const model = createMockModel({ scenarios: [loadScenario('5-file-basic.json')], provider: 'mock' });
    const driver = createDriver(session, model, createHostLikeTools(session));
    driver.pushUserTask('请写五个文件：f1 到 f5。');
    const reason = await driver.runTurn();
    assert.equal(reason.kind, 'completed');
    assertToolLifecycle(session.events);
    const lastAssistant = session.events.filter((e) => e.type === 'assistant/message').at(-1)!;
    const lastStepEnd = session.events.filter((e) => e.type === 'step/end').at(-1)!;
    assert.ok(lastAssistant.seq < lastStepEnd.seq, 'final answer 必须落在最后一个 step/end 之前');
  });
});
