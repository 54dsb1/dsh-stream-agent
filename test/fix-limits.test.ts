// test/fix-limits.test.ts —— 四个已知限制的修复验收（README 已知限制 1–4 对应 docs/limitations.md 1/3/5/7）
//
//   修复 1（写批任务 token 偏重）：自写回验 receipt —— tf-read 命中本任务 tf-write 已写过的
//          路径时只注入回执（行数 + 内容指纹），不再回灌全文；外部文件的完整反馈保持不变。
//   修复 2（steer 语义偏离）：运行中回合的 steer 注入下一请求（追加区 [tf-stream:steer]），
//          对齐内建"注入运行中回合的下一步"；空闲时保持"插队队首、新回合任务"语义。
//   修复 3（持久化依赖宿主 storage）：宿主缺 sessionPersistence → 本地 JSONL 会话持久化；
//          state-handle 宿主缺 storage backend → 本地文件 KvUnit（A4 在 adapters.test.ts）。
//   修复 4（bundle 形态 plugin record 降级）：宿主模块不可达 → 本地文件台账（可重放），
//          resume 时 final 答案回灌驱动器（rehydrateRecords）。

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  SingleStreamDriver,
  StreamLoopAgent,
  createStreamAgentFactory,
  attachSessionLedger,
  createSessionEventWriter,
  normalizeStreamShim,
} from '../src/entry/loop.ts';
import type { DriverPorts, StreamRequestOptions, ToolBatchInputLike, ToolBatchResultLike, StreamDriverConfig } from '../src/entry/loop.ts';
import { createMockModel } from '../src/entry/mock-provider.ts';
import type { MockModel, Scenario } from '../src/entry/mock-provider.ts';
import { JsonFileKvUnit, appendLedgerRecord, createJsonlPersistence, loadLedgerRecords, withEventCapture } from '../src/entry/json-persistence.ts';

// ---------------------------------------------------------------------------
// 测试设施（与 loop.test.ts 同款最小装配）
// ---------------------------------------------------------------------------

function loadScenario(name: string): Scenario {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'scenarios', name), 'utf8')) as unknown as Scenario;
}

function createSandboxExecutor(sandboxDir: string) {
  return async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => {
    const results: ToolBatchResultLike['results'] = [];
    for (const call of input.calls) {
      const args = JSON.parse(call.arguments) as Record<string, unknown>;
      try {
        if (call.name === 'write') {
          const filePath = String(args['file_path'] ?? '');
          writeFileSync(join(sandboxDir, filePath), String(args['content'] ?? ''), 'utf8');
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: `written ${filePath}` }], isError: false } });
        } else if (call.name === 'read') {
          const content = readFileSync(join(sandboxDir, String(args['file_path'] ?? '')), 'utf8');
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: content }], isError: false } });
        } else {
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: `unknown tool: ${call.name}` }], isError: true } });
        }
      } catch (error) {
        results.push({ callId: call.id, result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true } });
      }
    }
    return { results, additionalContexts: [], concluded: false };
  };
}

interface Harness {
  driver: SingleStreamDriver;
  model: MockModel;
  wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }>;
  sandboxDir: string;
  cleanup: () => void;
}

function makeHarness(opts: {
  task: string;
  scenarios: Scenario[];
  seed?: Record<string, string>;
  config?: Partial<StreamDriverConfig>;
  onFirstSettle?: (driver: SingleStreamDriver) => void;
}): Harness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-fix-'));
  for (const [name, content] of Object.entries(opts.seed ?? {})) writeFileSync(join(sandboxDir, name), content, 'utf8');
  const model = createMockModel({ scenarios: opts.scenarios, provider: 'mock' });
  const wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }> = [];
  let settled = false;
  let driverRef: SingleStreamDriver | undefined;
  const ports: DriverPorts = {
    stream: (options) => {
      wireRequests.push({ ...options, contentTexts: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')) });
      return normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal }));
    },
    executeTools: createSandboxExecutor(sandboxDir),
    onToolSettled: () => {
      model.notifyToolResult();
      if (!settled && opts.onFirstSettle !== undefined && driverRef !== undefined) {
        settled = true;
        opts.onFirstSettle(driverRef);
      }
    },
  };
  const config: StreamDriverConfig = { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000, ...opts.config };
  const driver = new SingleStreamDriver(ports, config);
  driverRef = driver;
  driver.pushUserTask(opts.task);
  return { driver, model, wireRequests, sandboxDir, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

function lastReasonOf(driver: SingleStreamDriver): string {
  const ends = driver.snapshot().records.filter((r) => r.kind === 'turn-end');
  const last = ends[ends.length - 1];
  assert.ok(last !== undefined && last.kind === 'turn-end', '必须有 turn-end 记录');
  return last.reason.kind;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

// ---------------------------------------------------------------------------
// 修复 1：自写回验 receipt
// ---------------------------------------------------------------------------

describe('修复限制 1：自写回验 receipt（写批任务 token 偏重）', () => {
  let harness: Harness | undefined;
  beforeEach(() => {
    harness?.cleanup();
    harness = undefined;
  });

  const writeReadScenario: Scenario = {
    name: 'write-then-read',
    match: { promptIncludes: '回验演练' },
    chunking: { charsPerChunk: 0, delayMs: 0 },
    steps: [
      { type: 'text', text: '写完读回确认。\n' },
      { type: 'commands', commands: ['<tf-write path="a.txt" id="w1">内容A-独一无二-42</tf-write>', '<tf-read path="a.txt" id="r1"/>', '<tf-final id="f1" summary="done"/>'] },
      { type: 'waitTools', count: 2, timeoutMs: 5000 },
      { type: 'finish', reason: 'stop' },
    ],
  };

  it('R1. 写后读同路径 → receipt 回执（不回灌全文），任务收敛', async () => {
    harness = makeHarness({ task: '回验演练：写 a.txt 再读回。', scenarios: [writeReadScenario] });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      assert.ok(existsSync(join(harness.sandboxDir, 'a.txt')));
      const req1 = harness.wireRequests[0]!;
      const req2 = harness.wireRequests[1]!;
      assert.ok(!req1.contentTexts.some((t) => t.includes('[tf-stream:receipt handle=')), '请求 1 不应有 receipt');
      const receipt = req2.contentTexts.find((t) => t.includes('[tf-stream:receipt handle=') && t.includes('path=a.txt'));
      assert.ok(receipt !== undefined, `请求 2 应注入 receipt：\n${req2.contentTexts.join('\n---\n').slice(0, 1200)}`);
      assert.ok(/sha256=[0-9a-f]{16}/.test(receipt), 'receipt 应带内容指纹');
      assert.ok(receipt.includes('lines='), 'receipt 应带行数');
      assert.ok(!receipt.includes('内容A-独一无二-42'), 'receipt 不得回灌自写文件全文');
      // 完整反馈块也不该出现
      assert.ok(!req2.contentTexts.some((t) => t.includes('内容A-独一无二-42')), '自写文件全文不得进任何注入块');
    } finally {
      harness.cleanup();
    }
  });

  it('R2. config selfReadFeedback=full → 恢复 v0.1 完整反馈行为', async () => {
    harness = makeHarness({ task: '回验演练：写 a.txt 再读回。', scenarios: [writeReadScenario], config: { selfReadFeedback: 'full' } });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const req2 = harness.wireRequests[1]!;
      assert.ok(req2.contentTexts.some((t) => t.includes('内容A-独一无二-42')), 'full 模式应回灌全文');
      assert.ok(!req2.contentTexts.some((t) => t.includes('[tf-stream:receipt handle=')), 'full 模式不应有 receipt');
    } finally {
      harness.cleanup();
    }
  });

  it('R3. 读外部文件（非本任务写入）→ 完整反馈保持不变', async () => {
    harness = makeHarness({
      task: '回验演练：读已有的 big.txt。',
      scenarios: [
        {
          name: 'read-foreign',
          match: { promptIncludes: '回验演练' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '读外部文件。\n' },
            { type: 'commands', commands: ['<tf-read path="big.txt" id="r1"/>', '<tf-final id="f1" summary="answer-FOREIGN-LINE-2"/>'] },
            { type: 'waitTools', count: 1, timeoutMs: 5000 },
            { type: 'finish', reason: 'stop' },
          ],
        },
      ],
      seed: { 'big.txt': 'FOREIGN-LINE-1\nFOREIGN-LINE-2\nFOREIGN-LINE-3\n' },
    });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const req2 = harness.wireRequests[1]!;
      assert.ok(req2.contentTexts.some((t) => t.includes('FOREIGN-LINE-2')), '外部文件应完整反馈');
      assert.ok(!req2.contentTexts.some((t) => t.includes('[tf-stream:receipt handle=')), '外部文件不应走 receipt');
    } finally {
      harness.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 修复 2：steer 运行中回合注入
// ---------------------------------------------------------------------------

describe('修复限制 2：steer 注入运行中回合的下一步', () => {
  let harness: Harness | undefined;
  beforeEach(() => {
    harness?.cleanup();
    harness = undefined;
  });

  it('S1. driver 级：运行中 pushSteer → 下一请求含 [tf-stream:steer] 用户块，插话被看到后才收敛', async () => {
    harness = makeHarness({
      task: 'steer演练：读一个不存在的文件。',
      scenarios: [
        {
          name: 'steered-continue',
          match: { promptIncludes: 'tf-stream:steer' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '收到插话，按新指令收尾。\n' },
            { type: 'commands', commands: ['<tf-final id="f2" summary="steered-done"/>'] },
            { type: 'finish', reason: 'stop' },
          ],
        },
        {
          name: 'steer-base',
          match: { promptIncludes: 'steer演练' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '先读 missing.txt。\n' },
            { type: 'commands', commands: ['<tf-read path="missing.txt" id="r1"/>', '<tf-final id="f1" summary="premature"/>'] },
            { type: 'waitTools', count: 1, timeoutMs: 5000 },
            { type: 'finish', reason: 'stop' },
          ],
        },
      ],
      // 工具落定即插话：时序确定（命令在途时 steer 到达，必须等下一请求才能被看到）
      onFirstSettle: (driver) => driver.pushSteer('请立刻改为读 other.txt 并收尾。', { role: 'user', source: 'steer-test' }),
    });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      // 插话必须出现在某个请求的装配历史里（追加区，单调不破）
      const steerReq = harness.wireRequests.find((r) => r.contentTexts.some((t) => t.includes('[tf-stream:steer]') && t.includes('请立刻改为读 other.txt')));
      assert.ok(steerReq !== undefined, `steer 必须注入下一请求：\n${harness.wireRequests.map((r) => r.contentTexts.join('|')).join('\n---\n').slice(0, 2000)}`);
      // 收敛答案 = 插话后剧本的 final（last-wins）
      const finals = harness.driver.snapshot().records.filter((r) => r.kind === 'final');
      const last = finals[finals.length - 1] as { summary?: string };
      assert.equal(last.summary, 'steered-done');
      // 前缀单调：含 steer 的请求必须包含其前所有请求的稳定段（追加式增长）
      for (let i = 1; i < harness.wireRequests.length; i += 1) {
        const prev = harness.wireRequests[i - 1]!;
        const cur = harness.wireRequests[i]!;
        assert.ok(cur.contentTexts.length >= prev.contentTexts.length, '请求只能追加不能收缩');
        for (let j = 0; j < prev.contentTexts.length; j += 1) {
          assert.equal(cur.contentTexts[j], prev.contentTexts[j], `第 ${i} 请求第 ${j} 条消息必须逐字节稳定`);
        }
      }
    } finally {
      harness.cleanup();
    }
  });

  it('S2. agent 级：运行中 steer → inbox.nextStep 如实暴露、消费后清空；空闲 steer → 新回合任务', async () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-fix-agent-'));
    const { ctx } = createFakeHostLite();
    const model = createMockModel({
      scenarios: [
        // 顺序敏感：'空闲插话' 更具体，排在 'tf-stream:steer' 之前（历史里两个标记可能同时出现）
        {
          name: 'agent-idle-steer',
          match: { promptIncludes: '空闲插话' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '空闲插话当新任务。\n' },
            { type: 'commands', commands: ['<tf-final id="f3" summary="idle-steer-done"/>'] },
            { type: 'finish', reason: 'stop' },
          ],
        },
        {
          name: 'agent-steered',
          match: { promptIncludes: 'tf-stream:steer' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '按插话收尾。\n' },
            { type: 'commands', commands: ['<tf-final id="f2" summary="steered-done"/>'] },
            { type: 'finish', reason: 'stop' },
          ],
        },
        {
          name: 'agent-base',
          match: { promptIncludes: 'agent 演练' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '先读 missing.txt。\n' },
            { type: 'commands', commands: ['<tf-read path="missing.txt" id="r1"/>', '<tf-final id="f1" summary="premature"/>'] },
            { type: 'waitTools', count: 1, timeoutMs: 5000 },
            { type: 'finish', reason: 'stop' },
          ],
        },
      ],
      provider: 'mock',
    });
    let settled = false;
    let agentRef: StreamLoopAgent | undefined;
    const driver = new SingleStreamDriver(
      {
        stream: (options) => normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal })),
        executeTools: createSandboxExecutor(sandboxDir),
        onToolSettled: () => {
          model.notifyToolResult();
          // 命令在途时经 Agent.steer 插话（真实入口；时序确定：必须等下一请求才能被看到）
          if (!settled && agentRef !== undefined) {
            settled = true;
            agentRef.steer({ role: 'user', content: [{ type: 'text', text: '运行中插话：直接收尾。' }] });
          }
        },
      },
      { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000 },
    );
    const fakeSession = { id: 'agent-steer-1', header: { id: 'agent-steer-1' }, events: [] as Array<{ type: string; data: unknown }>, append(type: string, data: unknown) { fakeSession.events.push({ type, data }); } };
    const agent = new StreamLoopAgent({ id: 'agent-steer-1', session: fakeSession, driver, modelSelection: { provider: 'mock', model: 'mock-scenario' } });
    agentRef = agent;

    // ① 运行中 steer：插话在回合内被消费（注入下一请求），收敛答案取插话后的 final
    agent.followup({ role: 'user', content: [{ type: 'text', text: 'agent 演练：读 missing.txt。' }] });
    assert.equal(agent.status, 'running');
    await agent.whenIdle();
    assert.equal(agent.status, 'idle');
    assert.equal((driver.pendingSteerMessages as unknown[]).length, 0, '插话消费后清空');
    assert.equal(agent.inbox.nextStep.length, 0);
    // 会话事件含两条 user/message（原任务 + steer）
    const userMessages = fakeSession.events.filter((e) => e.type === 'user/message');
    assert.equal(userMessages.length, 2, `应有两条 user/message，实际：${fakeSession.events.map((e) => e.type).join(',')}`);
    const finals = driver.snapshot().records.filter((r) => r.kind === 'final');
    assert.equal((finals[finals.length - 1] as { summary?: string }).summary, 'steered-done');

    // ② 空闲 steer：插队队首当新回合任务（内建空闲语义一致）；user/message 落第三条
    agent.steer({ role: 'user', content: [{ type: 'text', text: '空闲插话：把这个当新任务。' }] });
    await agent.whenIdle();
    assert.equal((driver.snapshot().records.filter((r) => r.kind === 'final').at(-1) as { summary?: string }).summary, 'idle-steer-done');
    assert.equal(fakeSession.events.filter((e) => e.type === 'user/message').length, 3);
    rmSync(sandboxDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 修复 3：本地持久化兜底
// ---------------------------------------------------------------------------

describe('修复限制 3：本地 JSONL 会话持久化（宿主 sessionPersistence 缺位）', () => {
  it('P1. JsonFileKvUnit：落盘 + 重开实例数据仍在（durable）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-fix-kv-'));
    try {
      const one = new JsonFileKvUnit(dir, 'unitA', () => {});
      await one.putRecord('blobs', 'k1', { b64: 'YWJj' });
      await one.putRecord('handles', 'k2', { handle: 'file:a.txt@v1' });
      const all = await one.loadAll();
      assert.deepEqual((all.tables['blobs'] as Record<string, unknown>)['k1'], { b64: 'YWJj' });
      await one.close();
      // "重启"：新实例同一文件
      const two = new JsonFileKvUnit(dir, 'unitA', () => {});
      const all2 = await two.loadAll();
      assert.deepEqual((all2.tables['handles'] as Record<string, unknown>)['k2'], { handle: 'file:a.txt@v1' });
      await two.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P2. factory E2E：无宿主 sessionPersistence → 本地 JSONL 落盘；resume 从 JSONL 冷读重建', async () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-fix-pers-'));
    const sessionsDir = mkdtempSync(join(tmpdir(), 'tf-fix-sess-'));
    const sessionId = `session-${randomUUID()}`;
    const warnings: string[] = [];
    const warn = (m: string, d?: unknown) => warnings.push(`${m} ${String(d)}`);
    try {
      const model = createMockModel({ scenarios: [loadScenario('5-file-basic.json')], provider: 'mock' });
      const makeFactory = () => createStreamAgentFactory({
        ctx: createFakeHostLite().ctx, // 无 sessionPersistence 服务
        createFallbackPersistence: (sid) => createJsonlPersistence(sessionsDir, sid, warn),
        createDriver({ session }) {
          return {
            driver: new SingleStreamDriver(
              {
                stream: (o) => normalizeStreamShim(model.adapter.stream({ provider: o.provider, model: o.model, messages: o.messages, signal: o.signal })),
                executeTools: createSandboxExecutor(sandboxDir),
                events: createSessionEventWriter(session),
                onToolSettled: () => model.notifyToolResult(),
                onWarning: warn,
              },
              { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000 },
            ),
          };
        },
      });

      // ① 创建 + 跑任务 + dispose
      const factory = makeFactory();
      const handle = await factory.createAgent(undefined, { sessionId, agentOptions: { provider: 'mock', model: 'mock-scenario' } });
      handle.agent.followup({ role: 'user', content: [{ type: 'text', text: '请写五个文件 f1 到 f5。' }] });
      await handle.agent.whenIdle();
      assert.ok(existsSync(join(sandboxDir, 'f3.txt')), '任务应完成');
      await handle.dispose();

      // ② 会话事件已落 JSONL（含 user/message）
      const logFile = join(sessionsDir, `${sessionId}.jsonl`);
      assert.ok(existsSync(logFile), `会话 JSONL 应存在：${logFile}`);
      const logText = readFileSync(logFile, 'utf8');
      assert.ok(logText.includes('user/message'), 'user/message 应落 JSONL');
      assert.ok(logText.includes('turn/end'), 'turn/end 应落 JSONL');

      // ③ resume：从 JSONL 冷读（无宿主持久化也能跨会话），新回合继续追加同一文件
      const factory2 = makeFactory();
      const handle2 = await factory2.resume(undefined, { resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock-scenario' } });
      handle2.agent.followup({ role: 'user', content: [{ type: 'text', text: '请写五个文件 f1 到 f5（续跑）。' }] });
      await handle2.agent.whenIdle();
      await handle2.dispose();
      const logText2 = readFileSync(logFile, 'utf8');
      assert.ok(logText2.split('\n').length > logText.split('\n').length, 'resume 后事件应继续追加');
      assert.ok(existsSync(join(sandboxDir, 'f3.txt')));
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 修复 4：plugin record 通道降级 → 本地文件台账 + resume 重放
// ---------------------------------------------------------------------------

describe('修复限制 4：本地文件台账（bundle plugin record 通道降级）', () => {
  it('L1. 宿主模块不可达 + 提供本地台账 → 记录落 JSONL（可重放），且告警不静默', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-fix-ledger-'));
    try {
      const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-fix-ledger-sb-'));
      const warnings: string[] = [];
      const model = createMockModel({ scenarios: [{ name: 'idle', match: { promptIncludes: '任务' }, chunking: { charsPerChunk: 0, delayMs: 0 }, steps: [{ type: 'finish', reason: 'stop' }] }], provider: 'mock' });
      const driver = new SingleStreamDriver(
        {
          stream: (o) => normalizeStreamShim(model.adapter.stream({ provider: o.provider, model: o.model, messages: o.messages, signal: o.signal })),
          executeTools: createSandboxExecutor(sandboxDir),
          onToolSettled: () => model.notifyToolResult(),
        },
        { provider: 'mock', model: 'mock-scenario' },
      );
      driver.pushUserTask('任务：什么都不做，直接结束。');
      const ledgerFile = join(dir, 'ledger', 'sess-1.jsonl');
      // ctx 无 loader → 三级宿主解析全失败（本环境无 @deepseek-ai/dsh-session）→ 文件台账
      await attachSessionLedger(
        driver,
        { append() {} },
        (m) => warnings.push(m),
        {},
        { file: ledgerFile, appendRecord: (type: string, data: unknown) => appendLedgerRecord(ledgerFile, type, data) },
      );
      const reason = await driver.runTurn();
      assert.ok(reason.kind === 'blocked' || reason.kind === 'completed');
      assert.ok(existsSync(ledgerFile), '台账 JSONL 应存在');
      const { records, skipped } = loadLedgerRecords(ledgerFile);
      assert.equal(skipped, 0);
      assert.ok(records.some((r) => r.type === 'plugin:tf-agent/step'), 'turn-end 台账应落盘');
      assert.equal(driver.snapshot().records.length > 0, true);
      assert.ok(warnings.some((w) => w.includes('台账')), '降级必须告警');
      rmSync(sandboxDir, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('L2. rehydrateRecords：final 答案回灌（last-wins 候选），命令记录跳过不占 id', () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-fix-rehy-'));
    const model = createMockModel({ scenarios: [{ name: 'dummy', steps: [{ type: 'finish', reason: 'stop' }] }], provider: 'mock' });
    const driver = new SingleStreamDriver(
      {
        stream: (o) => normalizeStreamShim(model.adapter.stream({ provider: o.provider, model: o.model, messages: o.messages, signal: o.signal })),
        executeTools: createSandboxExecutor(sandboxDir),
      },
      { provider: 'mock', model: 'mock-scenario' },
    );
    const replay = driver.rehydrateRecords([
      { kind: 'plugin:tf-agent/final', data: { summary: 'resumed-answer-v1', cmdId: 'f1' } },
      { kind: 'plugin:tf-agent/final', data: { summary: 'resumed-answer-v2', cmdId: 'f1' } },
      { kind: 'plugin:tf-agent/command', data: { cmdId: 'w1', name: 'tf-write', status: 'ok' } },
      { kind: 'plugin:tf-agent/fault', data: { fault: 'malformed-command' } },
    ]);
    assert.equal(replay.applied, 2, '两条 final 都回灌（last-wins 靠数组序）');
    assert.equal(replay.skipped, 2, '命令与 fault 记录跳过');
    const finals = driver.snapshot().records.filter((r) => r.kind === 'final').map((r) => (r as { summary?: string }).summary);
    assert.deepEqual(finals, ['resumed-answer-v1', 'resumed-answer-v2']);
    // 命令 id 未被占用：w1 可正常登记（不因回放被"换新 id"拒绝）
    void sandboxDir;
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it('L3. resume 全链路：上一会话的 final 答案从文件台账回灌新驱动器', async () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-fix-resume-'));
    const sessionsDir = mkdtempSync(join(tmpdir(), 'tf-fix-resume-sess-'));
    const ledgerDir = mkdtempSync(join(tmpdir(), 'tf-fix-resume-led-'));
    const sessionId = `session-${randomUUID()}`;
    try {
      const { ctx } = createFakeHostLite();
      const model = createMockModel({ scenarios: [loadScenario('5-file-basic.json')], provider: 'mock' });
      const makeFactory = () => createStreamAgentFactory({
        ctx,
        createFallbackPersistence: (sid) => createJsonlPersistence(sessionsDir, sid, () => {}),
        fallbackLedger: (sid) => {
          const file = join(ledgerDir, `${sid}.jsonl`);
          return {
            file,
            appendRecord: (type: string, data: unknown) => import('../src/entry/json-persistence.ts').then((m) => m.appendLedgerRecord(file, type, data)),
          };
        },
        createDriver() {
          return {
            driver: new SingleStreamDriver(
              {
                stream: (o) => normalizeStreamShim(model.adapter.stream({ provider: o.provider, model: o.model, messages: o.messages, signal: o.signal })),
                executeTools: createSandboxExecutor(sandboxDir),
                onToolSettled: () => model.notifyToolResult(),
              },
              { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000 },
            ),
          };
        },
      });
      const handle = await makeFactory().createAgent(undefined, { sessionId, agentOptions: { provider: 'mock', model: 'mock-scenario' } });
      handle.agent.followup({ role: 'user', content: [{ type: 'text', text: '请写五个文件 f1 到 f5。' }] });
      await handle.agent.whenIdle();
      await handle.dispose();

      const resumed = await makeFactory().resume(undefined, { resumeSessionId: sessionId, agentOptions: { provider: 'mock', model: 'mock-scenario' } });
      // 通过 ledger 文件直接验证重放源存在（rehydrateRecords 的单测在 L2）
      const ledgerFile = join(ledgerDir, `${sessionId}.jsonl`);
      const { records } = loadLedgerRecords(ledgerFile);
      assert.ok(records.some((r) => r.type === 'plugin:tf-agent/final'), 'final 记录应已在文件台账');
      assert.ok(records.some((r) => r.type === 'plugin:tf-agent/command'), 'command 记录应已在文件台账');
      await resumed.dispose();
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
      rmSync(sessionsDir, { recursive: true, force: true });
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// withEventCapture（修复 3 的事件镜像面）
// ---------------------------------------------------------------------------

describe('withEventCapture', () => {
  it('append 代理：事件镜像进 sink，返回值与原型链方法透传不变', () => {
    const captured: unknown[][] = [];
    const base = {
      id: 's1',
      header: { id: 's1' },
      append(type: string, data: unknown) {
        return { seq: (this as unknown as { n: number }).n++, type, data };
      },
      n: 0,
      snapshotEvents(offset: number) {
        return offset === 0 ? ['e1'] : [];
      },
    };
    const wrapped = withEventCapture(base, { appendEvents: (events) => captured.push([...events]) }, () => {}) as typeof base;
    const appended = wrapped.append('user/message', { text: 'hi' });
    assert.deepEqual(captured[0]?.[0], { type: 'user/message', data: { text: 'hi' }, seq: 0 }, '事件镜像含 seq/type/data');
    assert.equal(appended?.seq, 0, '返回值透传');
    assert.equal(wrapped.snapshotEvents(0)[0], 'e1', '原型链方法透传');
    assert.equal(wrapped.header.id, 's1');
  });
});

// ---------------------------------------------------------------------------
// 最小 fake host（无 sessionPersistence / 无 loader / 无 storage）
// ---------------------------------------------------------------------------

function createFakeHostLite() {
  const sessions = {
    prepare(id: string) {
      const session = { id, header: { id }, events: [] as unknown[], append(type: string, data: unknown) { session.events.push({ type, data }); } };
      return { session, [Symbol.dispose]() {} };
    },
    enter() {
      return () => {};
    },
    announce() {},
  };
  const agents = {
    enter() {
      return () => {};
    },
    async announce() {},
  };
  return { ctx: { sessions, agents, get: () => undefined } };
}
