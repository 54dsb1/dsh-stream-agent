// test/host-conformance.test.ts —— v0.4.1-beta.2：宿主一致性回归（历史加载失败 + UI 卡住两案；与 0.3.2 同一套补丁）
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

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

// ---------------------------------------------------------------------------
// HC6–HC8（0.4.1-beta.2 升级：宿主一致性面，设计见 docs/upgrade-v0.4.1-beta-host-conformance.md）
// ---------------------------------------------------------------------------

/** 宿主 known-event 清单本地镜像（dsh-session 0.2.2-rc.1 KNOWN_SESSION_EVENT_TYPES，62 项）。 */
const HOST_KNOWN_EVENT_TYPES = new Set([
  'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided', 'approval/policy',
  'assistant/attempt', 'assistant/message', 'command/done', 'command/run', 'compaction/end', 'compaction/prune',
  'compaction/start', 'compaction/summary', 'deliverables/presented', 'developer/message', 'feedback/message-delete',
  'feedback/message-put', 'feedback/record', 'goal/change', 'hook/invoked', 'hook/result', 'image/offload',
  'job/registered', 'job/settled', 'llm/retry', 'llm/retry-started', 'model/selection', 'permission/preset',
  'plan/mode', 'request/context', 'request/header', 'sandbox/mode', 'schedule/change',
  'session-log-deepseek/delivery-accepted', 'session/end-seed', 'session/title', 'session/title-llm-request',
  'step/end', 'step/start', 'subagent/catalog', 'subagent/descriptor', 'subagent/model-selection-policy',
  'system/message', 'team/member', 'team/message/delivered', 'team/message/queued', 'team/task', 'todo/write',
  'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/run-end', 'tool-workflow/run-start',
  'tool/call', 'tool/ptc-dispatch', 'tool/ptc-dispatch-start', 'tool/result', 'turn/end', 'turn/start',
  'user/message', 'web/deepseek-search-llm-request', 'working-directory/change', 'workspace/changes',
]);

/** 插件记录语法（dsh-session PLUGIN_RECORD_TYPE 的本地镜像；plugin record 必须 ignorable）。 */
const PLUGIN_RECORD_TYPE = /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u;

/** 插件全部 ledger 记录类型（src/entry/loop.ts TfAgentRecordType + beta 新增 surface）。 */
const PLUGIN_RECORD_TYPES = [
  'plugin:tf-agent/command', 'plugin:tf-agent/final', 'plugin:tf-agent/fault', 'plugin:tf-agent/step',
  'plugin:tf-agent/plan', 'plugin:tf-agent/intent', 'plugin:tf-agent/surface',
];

describe('HC6. 会话事件类型清单（未知/拼错类型 = 宿主拒整条日志）', () => {
  it('HC6a. 驱动器写出的每类事件都在宿主 known-event 集里，plugin record 语法合法', async () => {
    const session = createFakeSession();
    const model = createMockModel({ scenarios: [loadScenario('5-file-basic.json')], provider: 'mock-provider' });
    let driverRef: SingleStreamDriver | undefined;
    const driver = new SingleStreamDriver({
      stream: (options) => normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal })),
      executeTools: createHostLikeTools(session),
      events: createSessionEventWriter(session, () => driverRef!.modelSource()),
      onToolSettled: () => model.notifyToolResult(),
    }, { provider: 'mock-provider', model: 'mock-model', streamIdleTimeoutMs: 30_000 });
    driverRef = driver;
    driver.pushUserTask('请写五个文件：f1 到 f5。');
    await driver.runTurn();
    const written = new Set(session.events.map((e) => e.type));
    assert.ok(written.size >= 6, `应覆盖生命周期全类型，实际 ${written.size} 类：${[...written].join(',')}`);
    for (const type of written) {
      assert.ok(HOST_KNOWN_EVENT_TYPES.has(type), `驱动器写出未知事件类型 "${type}"（宿主读取时拒整条日志）`);
    }
    // 消息形状规则推广到全事件流（不只 assistant 消息）
    assertMessageEventShapes(session.events);
    // 插件记录类型：语法必须匹配宿主 PLUGIN_RECORD_TYPE（书写错 = appendPluginRecord 拒收）
    for (const record of PLUGIN_RECORD_TYPES) {
      assert.ok(PLUGIN_RECORD_TYPE.test(record), `插件记录类型 "${record}" 不匹配宿主 plugin record 语法`);
    }
  });

  it('HC6b. 类型清单自身健全：镜像不含 plugin:*（宿主 known 集只收 known-event），交集为空', () => {
    for (const type of HOST_KNOWN_EVENT_TYPES) {
      assert.ok(!type.startsWith('plugin:'), `宿主 known 集不应含 plugin:*（ignorable 记录走 plugin record 通道）：${type}`);
      assert.ok(!HOST_KNOWN_EVENT_TYPES.has(type) || type.length > 0);
      assert.match(type, /^[a-z][a-z0-9-]*(\/[a-z0-9][a-z0-9._-]*)*$/u, `镜像类型名 "${type}" 形态非法`);
    }
    assert.equal(HOST_KNOWN_EVENT_TYPES.size, 62, 'rc.1 known-event 清单应为 62 项（宿主升级时显式更新此镜像）');
  });
});

// ---------------------------------------------------------------------------
// HC7/HC8：修复脚本集成回归（fixture 驱动 CLI 全链路；脚本是用户数据写入者，必须有回归）
// ---------------------------------------------------------------------------

interface FixtureEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  surfaceOp?: string;
  sourceEventSeqs?: number[];
}

/** 最小完整 v4 日志（工具生命周期三段齐全），bareSource=true 时 assistant 消息缺 provider/model（0.3.2 事故形状）。 */
function buildFixtureRows(id: string, bareSource: boolean): Array<Record<string, unknown>> {
  const time = 1_792_000_000_000;
  const source = bareSource ? { kind: 'model' } : { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' };
  const header = { type: 'session', version: 4, id, createdAt: time, cwd: '.', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' };
  const events: FixtureEvent[] = [
    { type: 'user/message', seq: 0, time, data: { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'fixture task' }] }, surfaceOp: 'append' },
    { type: 'turn/start', seq: 1, time, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 3, time, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'tool-call', id: 'g1', name: 'glob', arguments: '{"pattern":"**/*"}' }], source }, stream: [] }, surfaceOp: 'append' },
    { type: 'tool/call', seq: 4, time, data: { turn: 1, step: 1, callId: 'g1', name: 'glob', arguments: '{"pattern":"**/*"}' } },
    { type: 'tool/result', seq: 5, time, data: { turn: 1, step: 1, message: { id: 't1', role: 'tool', source: { kind: 'tool', callId: 'g1' }, toolCallId: 'g1', content: [{ type: 'text', text: 'ok' }] } }, surfaceOp: 'append', sourceEventSeqs: [4] },
    { type: 'assistant/message', seq: 6, time, data: { turn: 1, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'done' }], source }, stream: [] }, surfaceOp: 'append' },
    { type: 'step/end', seq: 7, time, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 8, time, data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  return [header, ...events];
}

/** 建一个临时 dsh 状态根：<root>/sessions/<project>/session-<id>/session.v4.jsonl.zstd。 */
function createFixtureRoot(sessionId: string, bareSource: boolean): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), `tf-hc7-${bareSource ? 'broken' : 'healthy'}-`));
  const project = 'fixture-project';
  const dir = join(root, 'sessions', project, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(
    buildFixtureRows(sessionId, bareSource).map((row) => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  )));
  return { root, file: join(dir, 'session.v4.jsonl.zstd') };
}

function runRepair(root: string, sessionId: string, write: boolean): { status: number; stdout: string } {
  const result = spawnSync(process.execPath, [
    join(import.meta.dirname, '..', 'scripts', 'repair-session-logs.mjs'),
    ...(write ? ['--write'] : []),
    '--root', root,
    '--session', sessionId,
  ], {
    encoding: 'utf8',
    // 集成回归的契约 = 脚本本地复核（形状 + 生命周期）；宿主 v3-to-v4 关系校验要求
    // request/header 等宿主写事件，合成 fixture 不覆盖（HC8 用 validateStoredEvents
    // 单独走读取侧权威规则）——显式剥离 DSH_HOST_MODULES 保证测试不随宿主环境漂移。
    env: { ...process.env, DSH_HOST_MODULES: '' },
  });
  return { status: result.status ?? -1, stdout: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

describe('HC7. 修复脚本集成回归（三类 corrupt 的写入者必须有回归）', () => {
  it('HC7a. dry-run：报告损坏与修复条数，不落盘（原文件字节不变）', () => {
    const { root, file } = createFixtureRoot(`session-${randomUUID()}`, true);
    try {
      const before = readFileSync(file);
      const run = runRepair(root, 'session-', false);
      assert.equal(run.status, 0, `CLI 退出码非 0：${run.stdout}`);
      assert.match(run.stdout, /\[fix\]/, '损坏 fixture 必须被判定为需修复');
      assert.match(run.stdout, /补齐 2 条 model source/, '两条 bare source 的 assistant/message 都要被报告');
      assert.match(run.stdout, /dry-run 未写入/, 'dry-run 不得落盘');
      assert.doesNotMatch(run.stdout, /\[fail\]/, 'dry-run 前的本地复核必须通过');
      assert.deepEqual(readFileSync(file), before, 'dry-run 后原文件必须逐字节不变');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('HC7b. --write：备份出现、修复后日志过本地形状复核、完好 fixture 不被触碰', () => {
    const broken = createFixtureRoot(`session-${randomUUID()}`, true);
    const healthy = createFixtureRoot(`session-${randomUUID()}`, false);
    try {
      const healthyBefore = readFileSync(healthy.file);
      const run = runRepair(broken.root, 'session-', true);
      assert.equal(run.status, 0, `CLI 退出码非 0：${run.stdout}`);
      assert.match(run.stdout, /已写入 1 个/, '损坏 fixture 必须落盘（汇总行计数）');
      // 备份纪律：.bak-<时间戳> 必须出现在同一目录
      const sessionDir = broken.file.slice(0, broken.file.replace(/\\/g, '/').lastIndexOf('/'));
      const backups = readdirSync(sessionDir).filter((n) => n.startsWith('session.v4.jsonl.zstd.bak-'));
      assert.equal(backups.length, 1, '写前必须留一个备份');
      // 修复后形状：source 带缺省 provider/model，且过本地复核（脚本的 [fail] 不出现 = 复核过）
      assert.doesNotMatch(run.stdout, /\[fail\]/, '修复后本地复核必须通过');
      const repaired = zstdDecompressSync(readFileSync(broken.file)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) as Array<{ type: string; data: { message?: { source?: { kind?: string; provider?: string; model?: string } } } }>;
      const sources = repaired.filter((r) => r.type === 'assistant/message').map((r) => r.data.message?.source);
      assert.ok(sources.length >= 2);
      for (const source of sources) {
        assert.equal(source?.kind, 'model');
        assert.equal(source?.provider, 'deepseek-account');
        assert.equal(source?.model, 'deepseek-flash');
      }
      // 完好会话一个字节不动（--write 也不改完好日志）
      const runHealthy = runRepair(healthy.root, 'session-', true);
      assert.equal(runHealthy.status, 0);
      assert.match(runHealthy.stdout, /\[ok\]/, '完好 fixture 必须被判为无需修复');
      assert.match(runHealthy.stdout, /model source 完好/, '完好 source 不覆盖');
      assert.deepEqual(readFileSync(healthy.file), healthyBefore, '完好会话一个字节不动');
    } finally {
      rmSync(broken.root, { recursive: true, force: true });
      rmSync(healthy.root, { recursive: true, force: true });
    }
  });
});

describe('HC8. 宿主真校验器可选通道（DSH_HOST_MODULES 在位时启用）', () => {
  const hostModules = process.env.DSH_HOST_MODULES;
  const hostOk = hostModules !== undefined && hostModules.trim() !== '' && existsSync(hostModules.trim());
  const options = hostOk ? {} : { skip: 'DSH_HOST_MODULES 未设置（CI 纯离线；本地镜像已是 CI 权威，本通道为真机增强）' };

  it('HC8. 修复产物过宿主 validateStoredEvents（读取侧权威规则）', { skip: hostOk ? false : 'DSH_HOST_MODULES 未设置（CI 纯离线；本地镜像已是 CI 权威，本通道为真机增强）' }, async () => {
    const base = hostModules!.trim().replace(/\\/g, '/').replace(/\/$/, '');
    const persistMod = await import(`file:///${base}/dsh-session-persistence/lib/index.js`) as { validateStoredEvents(meta: { id: string }, events: unknown[], location?: unknown): unknown };
    const broken = createFixtureRoot(`session-${randomUUID()}`, true);
    try {
      const run = runRepair(broken.root, 'session-', true);
      assert.equal(run.status, 0, run.stdout);
      const rows = zstdDecompressSync(readFileSync(broken.file)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) as Array<{ type: string; data: Record<string, unknown>; id?: string }>;
      const header = rows[0] as unknown as { id: string };
      // 先证伪：bare source 的事故形状必须被宿主拒绝；再证修复产物通过
      const bare = buildFixtureRows(header.id, true).slice(1) as unknown[];
      assert.throws(() => persistMod.validateStoredEvents({ id: header.id }, structuredClone(bare), undefined), /model source/, '宿主校验器必须拒绝事故形状');
      persistMod.validateStoredEvents({ id: header.id }, structuredClone(rows.slice(1)), undefined);
    } finally {
      rmSync(broken.root, { recursive: true, force: true });
    }
  });
});
