// test/host-conformance.test.ts —— v0.3.2：宿主一致性回归（历史加载失败 + UI 卡住两案）
//
// 两起真机事故同源：插件的 duck-type 面缺了宿主侧的形状/事件契约——
// ① 会话日志：assistant/message 的 source 只写 `{kind:'model'}`，缺非空 provider/model。
//    宿主校验器（dsh-session assertMessageEventShape → hasProviderModel）读取时抛
//    `message must have model source`，整条会话判 corrupt → 桌面端"历史加载失败"。
// ② 事件面：StreamLoopAgent 从不发 `agent/status`（内建 loop 的 setPhase 语义）。
//    桌面端 dsh-api-session-controller 靠它转发 api-session/status 收起"运行中"指示——
//    不发 = 回合结束后 UI 永远转圈。缺 `agent.inject` 则让改审批策略的命令报
//    "agent.inject is not a function"。
//
// 本文件按宿主同款规则本地复核（仓库零宿主依赖红线）；宿主真实校验器的对照验证走
// scripts/repair-session-logs.mjs 的 DSH_HOST_MODULES 通道。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SingleStreamDriver, normalizeStreamShim, createSessionEventWriter, StreamLoopAgent } from '../src/entry/loop.ts';
import type { ToolBatchInputLike, ToolBatchResultLike, ModelSourceInfo } from '../src/entry/loop.ts';
import { createMockModel } from '../src/entry/mock-provider.ts';
import type { MockModel, Scenario } from '../src/entry/mock-provider.ts';

interface FakeEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  surfaceOp?: string;
}

interface FakeSession {
  id: string;
  readonly seq: number;
  events: FakeEvent[];
  append(type: string, data: unknown, opts?: { surfaceOp?: string }): FakeEvent;
  snapshotEvents(from?: number): FakeEvent[];
}

function createFakeSession(): FakeSession {
  const events: FakeEvent[] = [];
  let seq = 0;
  return {
    id: 'host-conformance-fixture',
    get seq() {
      return seq;
    },
    events,
    append(type, data, opts) {
      const event: FakeEvent = { type, seq: seq++, time: Date.now(), data: data as Record<string, unknown> };
      if (opts?.surfaceOp !== undefined) event.surfaceOp = opts.surfaceOp;
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

/** 宿主同款工具管线：任意调用都落 tool/call + tool/result（与 session-format.test.ts 同形）。 */
function createHostLikeTools(session: FakeSession) {
  return async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => {
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
      }, { surfaceOp: 'append' });
      results.push({ callId: call.id, result: { content, isError: false } });
    }
    return { results };
  };
}

/**
 * 宿主同款消息形状校验（dsh-session/lib/index.js assertMessageEventShape + hasProviderModel
 * 的本地镜像）：五类 message 事件逐条过规则，违规即整条日志 corrupt。
 */
function assertMessageEventShapes(events: readonly FakeEvent[]): void {
  const expectedRole: Record<string, string> = {
    'system/message': 'system',
    'developer/message': 'developer',
    'user/message': 'user',
    'assistant/message': 'assistant',
    'tool/result': 'tool',
  };
  for (const event of events) {
    const type = event.type;
    if (!(type in expectedRole)) continue;
    const data = event.data as { message?: { id?: unknown; role?: unknown; source?: { kind?: unknown; provider?: unknown; model?: unknown; callId?: unknown }; content?: unknown; toolCallId?: unknown } };
    const message = type === 'user/message' ? (event.data as Record<string, unknown>) : data.message;
    assert.ok(message !== null && typeof message === 'object', `${type}#${event.seq} 缺 message`);
    assert.equal(typeof message.id, 'string', `${type}#${event.seq} 缺非空 id`);
    assert.notEqual((message.id as string).length, 0, `${type}#${event.seq} id 不得为空`);
    assert.equal(message.role, expectedRole[type], `${type}#${event.seq} role 必须是 "${expectedRole[type]}"`);
    assert.ok(message.source !== null && typeof message.source === 'object', `${type}#${event.seq} 缺 source`);
    assert.equal(typeof message.source!.kind, 'string', `${type}#${event.seq} source.kind 缺失`);
    assert.notEqual(message.source!.kind, '', `${type}#${event.seq} source.kind 不得为空`);
    assert.ok(Array.isArray(message.content), `${type}#${event.seq} content 必须是数组`);
    if (type === 'assistant/message') {
      assert.equal(message.source!.kind, 'model', `assistant/message#${event.seq} source 必须是 model`);
      assert.equal(typeof message.source!.provider, 'string', `assistant/message#${event.seq} 缺 provider（历史加载失败根因）`);
      assert.notEqual(message.source!.provider, '', `assistant/message#${event.seq} provider 不得为空`);
      assert.equal(typeof message.source!.model, 'string', `assistant/message#${event.seq} 缺 model（历史加载失败根因）`);
      assert.notEqual(message.source!.model, '', `assistant/message#${event.seq} model 不得为空`);
    }
    if (type === 'tool/result') {
      assert.equal(message.source!.kind, 'tool', `tool/result#${event.seq} source 必须是 tool`);
      assert.equal(typeof message.source!.callId, 'string', `tool/result#${event.seq} 缺 source.callId`);
      assert.equal(message.toolCallId, message.source!.callId, `tool/result#${event.seq} toolCallId 与 source.callId 不一致`);
    }
  }
}

function createDriver(session: FakeSession, model: MockModel, modelInfo: () => ModelSourceInfo) {
  return new SingleStreamDriver({
    stream: (options) => normalizeStreamShim(model.adapter.stream({
      provider: options.provider,
      model: options.model,
      messages: options.messages,
      signal: options.signal,
    })),
    executeTools: createHostLikeTools(session),
    events: createSessionEventWriter(session, modelInfo),
    onToolSettled: () => model.notifyToolResult(),
  }, { provider: 'mock-provider', model: 'mock-model', streamIdleTimeoutMs: 30_000 });
}

// ---------------------------------------------------------------------------
// C1：会话日志 model source（历史加载失败根因）
// ---------------------------------------------------------------------------

describe('HC. 宿主一致性（v0.3.2 回归）', () => {
  it('HC1. assistant/message 的 source 必须带非空 provider/model（含广告消息），且整条日志过宿主形状校验', async () => {
    const session = createFakeSession();
    const model = createMockModel({ scenarios: [loadScenario('5-file-basic.json')], provider: 'mock-provider' });
    let driverRef: SingleStreamDriver | undefined;
    const driver = createDriver(session, model, () => driverRef!.modelSource());
    driverRef = driver;
    driver.pushUserTask('请写五个文件：f1 到 f5。');
    const reason = await driver.runTurn();
    assert.equal(reason.kind, 'completed');
    // 整条日志按宿主同款规则过一遍——任何一条不合规 = 桌面端"历史加载失败"。
    assertMessageEventShapes(session.events);
    const messages = session.events.filter((e) => e.type === 'assistant/message');
    assert.ok(messages.length >= 2, `至少有广告消息与正文消息，实际 ${messages.length}`);
    for (const message of messages) {
      const source = (message.data as { message?: { source?: { kind?: string; provider?: string; model?: string } } }).message?.source;
      assert.equal(source?.kind, 'model');
      assert.equal(source?.provider, 'mock-provider', 'provider 必须来自驱动器实时配置');
      assert.equal(source?.model, 'mock-model', 'model 必须来自驱动器实时配置');
    }
  });

  it('HC2. applySelection 运行时换模后，新写入的消息取实时 provider/model（写入时取，不缓存）', async () => {
    const session = createFakeSession();
    const scenario: Scenario = {
      name: 'hc2-switch',
      match: { promptIncludes: '换模演练' },
      chunking: { charsPerChunk: 0, delayMs: 0 },
      steps: [
        { type: 'text', text: '换模后收尾。\n' },
        { type: 'commands', commands: ['<tf-final id="f1" summary="switched-done"/>'] },
        { type: 'finish', reason: 'stop' },
      ],
    };
    const model = createMockModel({ scenarios: [scenario], provider: 'mock-provider' });
    let driverRef: SingleStreamDriver | undefined;
    const driver = createDriver(session, model, () => driverRef!.modelSource());
    driverRef = driver;
    driver.pushUserTask('换模演练：直接收尾。');
    await driver.runTurn();
    driver.applySelection({ provider: 'provider-b', model: 'model-b' });
    driver.pushUserTask('换模演练：第二回合直接收尾。');
    await driver.runTurn();
    assertMessageEventShapes(session.events);
    const messages = session.events.filter((e) => e.type === 'assistant/message');
    const lastSource = (messages.at(-1)!.data as { message?: { source?: { provider?: string; model?: string } } }).message?.source;
    assert.equal(lastSource?.provider, 'provider-b', '换模后的消息必须取实时 provider');
    assert.equal(lastSource?.model, 'model-b', '换模后的消息必须取实时 model');
    const firstSource = (messages[0].data as { message?: { source?: { provider?: string; model?: string } } }).message?.source;
    assert.equal(firstSource?.provider, 'mock-provider', '换模前的消息保留首请求路由');
  });

  it('HC3. 无模型路由信息（离线/缺省）时 source 落 unknown 兜底——日志形状仍过宿主校验', () => {
    const session = createFakeSession();
    const writer = createSessionEventWriter(session);
    assert.notEqual(writer, undefined);
    writer!.assistantMessage(1, 1, '离线正文', {
      finish: { kind: 'stop' },
    });
    assertMessageEventShapes(session.events);
    const source = (session.events[0].data as { message?: { source?: { provider?: string; model?: string } } }).message?.source;
    assert.equal(source?.provider, 'unknown');
    assert.equal(source?.model, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// C2：agent/status 事件面（UI 卡住根因）
// ---------------------------------------------------------------------------

describe('HC4. agent/status 转换事件（镜像内建 setPhase：只在变化时发）', () => {
  it('HC4a. followup → running，回合收敛 → idle，且序列精确（不重复、不遗漏）', async () => {
    const session = createFakeSession();
    const scenario: Scenario = {
      name: 'hc4-status',
      match: { promptIncludes: '状态演练' },
      chunking: { charsPerChunk: 0, delayMs: 0 },
      steps: [
        { type: 'text', text: '状态演练收尾。\n' },
        { type: 'commands', commands: ['<tf-final id="f1" summary="status-done"/>'] },
        { type: 'finish', reason: 'stop' },
      ],
    };
    const model = createMockModel({ scenarios: [scenario], provider: 'mock-provider' });
    const driver = new SingleStreamDriver({
      stream: (options) => normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal })),
      executeTools: createHostLikeTools(session),
      onToolSettled: () => model.notifyToolResult(),
    }, { provider: 'mock-provider', model: 'mock-model', streamIdleTimeoutMs: 30_000 });
    const transitions: Array<{ status: string }> = [];
    const agent = new StreamLoopAgent({
      id: 'hc4-agent',
      session,
      driver,
      modelSelection: { provider: 'mock-provider', model: 'mock-model' },
      emitStatus: (payload) => transitions.push({ status: payload.status as string }),
    });
    assert.equal(agent.status, 'idle');
    agent.followup({ role: 'user', content: [{ type: 'text', text: '状态演练：直接收尾。' }] });
    assert.equal(agent.status, 'running');
    assert.deepEqual(transitions, [{ status: 'running' }], '开始回合必须恰好发一次 running');
    await agent.whenIdle();
    assert.equal(agent.status, 'idle');
    assert.deepEqual(transitions, [{ status: 'running' }, { status: 'idle' }], '回合结束必须恰好发一次 idle');
    // 第二回合：再来一对 running/idle（转换才发，不做重复广播）
    agent.followup({ role: 'user', content: [{ type: 'text', text: '状态演练：第二回合直接收尾。' }] });
    await agent.whenIdle();
    assert.deepEqual(transitions, [
      { status: 'running' }, { status: 'idle' },
      { status: 'running' }, { status: 'idle' },
    ]);
  });

  it('HC4b. emitStatus 抛错不阻断回合（fail-open），回合照常收敛', async () => {
    const session = createFakeSession();
    const scenario: Scenario = {
      name: 'hc4b-boom',
      match: { promptIncludes: '熔断演练' },
      chunking: { charsPerChunk: 0, delayMs: 0 },
      steps: [
        { type: 'text', text: '熔断演练收尾。\n' },
        { type: 'commands', commands: ['<tf-final id="f1" summary="boom-done"/>'] },
        { type: 'finish', reason: 'stop' },
      ],
    };
    const model = createMockModel({ scenarios: [scenario], provider: 'mock-provider' });
    const driver = new SingleStreamDriver({
      stream: (options) => normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal })),
      executeTools: createHostLikeTools(session),
      onToolSettled: () => model.notifyToolResult(),
    }, { provider: 'mock-provider', model: 'mock-model', streamIdleTimeoutMs: 30_000 });
    const warnings: string[] = [];
    const agent = new StreamLoopAgent({
      id: 'hc4b-agent',
      session,
      driver,
      modelSelection: { provider: 'mock-provider', model: 'mock-model' },
      emitStatus: () => {
        throw new Error('bus exploded');
      },
      onWarning: (message) => warnings.push(message),
    });
    agent.followup({ role: 'user', content: [{ type: 'text', text: '熔断演练：直接收尾。' }] });
    await agent.whenIdle();
    assert.equal(agent.status, 'idle', '发射异常不得阻断回合收束');
    assert.ok(warnings.some((w) => w.includes('agent/status')), '发射异常必须走告警出口（不静默）');
    const finals = driver.snapshot().records.filter((r) => r.kind === 'final');
    assert.equal((finals.at(-1) as { summary?: string }).summary, 'boom-done');
  });
});

// ---------------------------------------------------------------------------
// C3：inject 事件面（改审批策略命令的报错根因）
// ---------------------------------------------------------------------------

describe('HC5. agent.inject（dsh-user-approval setPolicy 的依赖面）', () => {
  it('HC5a. 空闲 inject：落盘 user/message + 并入下一请求装配，但不唤醒回合', async () => {
    const session = createFakeSession();
    const scenario: Scenario = {
      name: 'hc5a-inject',
      match: { promptIncludes: '注入演练' },
      chunking: { charsPerChunk: 0, delayMs: 0 },
      steps: [
        { type: 'text', text: '注入演练收尾。\n' },
        { type: 'commands', commands: ['<tf-final id="f1" summary="inject-done"/>'] },
        { type: 'finish', reason: 'stop' },
      ],
    };
    const model = createMockModel({ scenarios: [scenario], provider: 'mock-provider' });
    const driver = new SingleStreamDriver({
      stream: (options) => normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal })),
      executeTools: createHostLikeTools(session),
      onToolSettled: () => model.notifyToolResult(),
    }, { provider: 'mock-provider', model: 'mock-model', streamIdleTimeoutMs: 30_000 });
    const agent = new StreamLoopAgent({
      id: 'hc5a-agent',
      session,
      driver,
      modelSelection: { provider: 'mock-provider', model: 'mock-model' },
    });
    agent.inject({
      id: 'notice-1',
      role: 'user',
      content: [{ type: 'text', text: 'The user changed the approval policy from "ask" to "never".' }],
      source: { kind: 'user-approval' },
    });
    assert.equal(agent.status, 'idle', '通知型注入不得自己开回合（镜像内建 send(...,false)）');
    assert.equal(session.events.filter((e) => e.type === 'user/message').length, 1, '注入必须落盘 user/message');
    assert.equal((driver.pendingSteerMessages as unknown[]).length, 1, '注入并入下一请求装配（next-step）');
    assert.equal(agent.inbox.nextStep.length, 1, 'inbox 面如实暴露待消费注入');
    // 下一回合首请求消费注入（runTurn 每次请求前 splice pendingSteers）
    agent.followup({ role: 'user', content: [{ type: 'text', text: '注入演练：直接收尾。' }] });
    await agent.whenIdle();
    assert.equal((driver.pendingSteerMessages as unknown[]).length, 0, '下一回合首请求消费注入');
  });

  it('HC5b. 运行中 inject：并入下一请求（不掐当前流），消费后清空', async () => {
    const session = createFakeSession();
    const scenario: Scenario = {
      name: 'hc5b-running',
      match: { promptIncludes: '运行中注入演练' },
      chunking: { charsPerChunk: 0, delayMs: 0 },
      steps: [
        { type: 'text', text: '先读 missing.txt。\n' },
        { type: 'commands', commands: ['<tf-read path="missing.txt" id="r1"/>'] },
        { type: 'waitTools', count: 1, timeoutMs: 5000 },
        { type: 'text', text: '读完了。\n' },
        { type: 'commands', commands: ['<tf-final id="f1" summary="running-inject-done"/>'] },
        { type: 'finish', reason: 'stop' },
      ],
    };
    const model = createMockModel({ scenarios: [scenario], provider: 'mock-provider' });
    let settled = false;
    let agentRef: StreamLoopAgent | undefined;
    const driver = new SingleStreamDriver({
      stream: (options) => normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal })),
      // 独立批不带 agent 的执行器（tf-read 对不存在文件返回错误结果，不碰 fs 会话解析）
      executeTools: async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => {
        const results = [];
        for (const call of input.calls) {
          const content = [{ type: 'text' as const, text: 'Error: file not found (fixture)' }];
          results.push({ callId: call.id, result: { content, isError: true } });
        }
        return { results };
      },
      onToolSettled: () => {
        model.notifyToolResult();
        if (!settled && agentRef !== undefined) {
          settled = true;
          agentRef.inject({ role: 'user', content: [{ type: 'text', text: '审批策略已改为 never。' }], source: { kind: 'user-approval' } });
        }
      },
    }, { provider: 'mock-provider', model: 'mock-model', streamIdleTimeoutMs: 30_000 });
    const fakeSession = { id: 'hc5b-agent', header: { id: 'hc5b-agent' }, events: [] as Array<{ type: string; data: unknown }>, append(type: string, data: unknown) { fakeSession.events.push({ type, data }); } };
    const agent = new StreamLoopAgent({ id: 'hc5b-agent', session: fakeSession, driver, modelSelection: { provider: 'mock-provider', model: 'mock-model' } });
    agentRef = agent;
    agent.followup({ role: 'user', content: [{ type: 'text', text: '运行中注入演练：读 missing.txt 后收尾。' }] });
    assert.equal(agent.status, 'running');
    await agent.whenIdle();
    assert.equal(agent.status, 'idle');
    assert.equal((driver.pendingSteerMessages as unknown[]).length, 0, '运行中注入在下一请求被消费');
    const finals = driver.snapshot().records.filter((r) => r.kind === 'final');
    assert.equal((finals.at(-1) as { summary?: string }).summary, 'running-inject-done', '注入不打断回合收敛');
  });

  it('HC5c. dispose 后 inject 拒绝（镜像 followup/steer 的 dispose 语义）', async () => {
    const session = createFakeSession();
    const model = createMockModel({
      scenarios: [{
        name: 'hc5c-unused',
        match: { promptIncludes: '永不匹配' },
        chunking: { charsPerChunk: 0, delayMs: 0 },
        steps: [{ type: 'finish', reason: 'stop' }],
      }],
      provider: 'mock-provider',
    });
    const driver = new SingleStreamDriver({
      stream: (options) => normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal })),
      executeTools: createHostLikeTools(session),
    }, { provider: 'mock-provider', model: 'mock-model', streamIdleTimeoutMs: 30_000 });
    const agent = new StreamLoopAgent({ id: 'hc5c-agent', session, driver, modelSelection: { provider: 'mock-provider', model: 'mock-model' } });
    await agent.dispose();
    assert.throws(() => agent.inject({ role: 'user', content: [{ type: 'text', text: 'late' }] }), /inject after dispose/);
  });
});
