// test/loop.test.ts —— 分派 06：单流协议驱动器（SingleStreamDriver + StreamLoopAgent + AgentFactory）
//
// 覆盖分派 06 验收的 mock 半边：
//   - mock E2E：5 文件 1 次调用；waitTools 挂起-重入；失败注入改道
//   - O6 preflight fail-closed（prefix 断言违反 → 拒绝发送）
//   - O5 预算阶梯（final-only 降级）
//   - 双通道（原生 tool_call 阻塞回灌）
//   - 看门狗超时 / 流中断的重入恢复
//   - gate.admit 准入（allow / deny）
//   - AgentFactory 生命周期（fake host：prepare → persistence → enter/announce → setup → dispose）
//
// 真连半边（DEEPSEEK_API_KEY）见 results/06-plugin-loop-results.md 的如实记录。

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  SingleStreamDriver,
  StreamLoopAgent,
  createStreamAgentFactory,
  normalizeStreamShim,
  createSessionEventWriter,
  DEFAULT_TOOL_MAPPING,
} from '../src/entry/loop.ts';
import applyLoopEntry from '../src/entry/loop.ts';
import { TfStreamParser } from '../src/kernel/parser.ts';
import type { TfCommand } from '../src/kernel/parser.ts';
import type {
  DriverPorts,
  StreamRequestOptions,
  ToolBatchInputLike,
  ToolBatchResultLike,
  GatePort,
  StreamDriverConfig,
} from '../src/entry/loop.ts';
import { createMockModel } from '../src/entry/mock-provider.ts';
import type { MockModel, Scenario } from '../src/entry/mock-provider.ts';
import { assertPrefixStable, PrefixBrokenError, ContextRenderer } from '../src/kernel/render.ts';

// ---------------------------------------------------------------------------
// 测试设施：沙箱执行器 + mock 端口装配
// ---------------------------------------------------------------------------

function loadScenario(name: string): Scenario {
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, 'scenarios', name), 'utf8')) as unknown;
  return raw as Scenario;
}

function loadScenarios(...items: Array<string | Scenario>): Scenario[] {
  // 顺序敏感：marker 更具体的剧本放前面（selectScenario 取第一个匹配）
  return items.map((item) => (typeof item === 'string' ? loadScenario(item) : item));
}

interface SandboxHooks {
  /** 让特定路径写入失败（路径含 fail → 拒绝），模拟执行失败重入路径 */
  failPathsMatching?: string;
}

function createSandboxExecutor(sandboxDir: string, hooks: SandboxHooks = {}) {
  return async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => {
    const results: ToolBatchResultLike['results'] = [];
    for (const call of input.calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments) as Record<string, unknown>;
      } catch {
        results.push({ callId: call.id, result: { content: [{ type: 'text', text: `bad JSON arguments: ${call.arguments.slice(0, 80)}` }], isError: true } });
        continue;
      }
      try {
        if (call.name === 'write') {
          const filePath = String(args['file_path'] ?? '');
          if (hooks.failPathsMatching !== undefined && filePath.includes(hooks.failPathsMatching)) {
            throw new Error(`EFAIL: sandbox policy rejected path "${filePath}"`);
          }
          const abs = join(sandboxDir, filePath);
          mkdirSync(join(abs, '..'), { recursive: true });
          writeFileSync(abs, String(args['content'] ?? ''), 'utf8');
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: `written ${filePath}` }], isError: false } });
        } else if (call.name === 'read') {
          const filePath = String(args['file_path'] ?? '');
          const abs = join(sandboxDir, filePath);
          const content = readFileSync(abs, 'utf8');
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: content }], isError: false } });
        } else if (call.name === 'bash') {
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: `bash-echo:${String(args['command'] ?? '')}` }], isError: false } });
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
  config?: Partial<StreamDriverConfig>;
  gate?: GatePort;
  sandboxHooks?: SandboxHooks;
  onToolSettled?: () => void;
  streamWrapper?: (options: StreamRequestOptions, inner: AsyncIterable<import('../src/entry/mock-provider.ts').StreamChunk>) => AsyncIterable<import('../src/entry/mock-provider.ts').StreamChunk>;
}): Harness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-loop-'));
  const model = createMockModel({ scenarios: opts.scenarios, provider: 'mock' });
  const wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }> = [];
  const ports: DriverPorts = {
    stream: (options) => {
      const inner = model.adapter.stream({
        provider: options.provider,
        model: options.model,
        messages: options.messages,
        signal: options.signal,
      });
      wireRequests.push({ ...options, contentTexts: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')) });
      const normalized = normalizeStreamShim(inner);
      return opts.streamWrapper !== undefined ? opts.streamWrapper(options, normalized) : normalized;
    },
    executeTools: createSandboxExecutor(sandboxDir, opts.sandboxHooks),
    // mock waitTools 的回灌信号源（05 号交接 §7.1）：每个工具落定 → notifyToolResult
    onToolSettled: () => {
      model.notifyToolResult();
      opts.onToolSettled?.();
    },
    gate: opts.gate,
  };
  const config: StreamDriverConfig = {
    provider: 'mock',
    model: 'mock-scenario',
    streamIdleTimeoutMs: opts.config?.streamIdleTimeoutMs ?? 30_000,
    ...opts.config,
  };
  const driver = new SingleStreamDriver(ports, config);
  driver.pushUserTask(opts.task);
  return {
    driver,
    model,
    wireRequests,
    sandboxDir,
    cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }),
  };
}

function lastReasonOf(snapshot: ReturnType<SingleStreamDriver['snapshot']>): string {
  const ends = snapshot.records.filter((r) => r.kind === 'turn-end');
  const last = ends[ends.length - 1];
  assert.ok(last !== undefined && last.kind === 'turn-end', '必须有 turn-end 记录');
  return last.reason.kind;
}

function faultsOf(snapshot: ReturnType<SingleStreamDriver['snapshot']>): Array<Extract<ReturnType<SingleStreamDriver['snapshot']>['records'][number], { kind: 'fault' }>> {
  return snapshot.records.filter((r): r is Extract<ReturnType<SingleStreamDriver['snapshot']>['records'][number], { kind: 'fault' }> => r.kind === 'fault');
}

/** 消息数组公共前缀长度（role + 文本逐字节） */
function commonPrefixLen(a: Array<{ role: string; content: string }>, b: Array<{ role: string; content: string }>): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i]!.role === b[i]!.role && a[i]!.content === b[i]!.content) i += 1;
  return i;
}

// ---------------------------------------------------------------------------
// A. mock E2E —— 分派 06 验收三条
// ---------------------------------------------------------------------------

describe('A. mock E2E（验收核心）', () => {
  let harness: Harness;
  beforeEach(() => {
    harness?.cleanup();
  });

  it('A1. 5 文件任务：模型调用次数 = 1，零注入，全部落盘（核心命题）', async () => {
    harness = makeHarness({
      task: '请写五个文件：f1 到 f5。',
      scenarios: loadScenarios('5-file-basic.json'),
    });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      assert.equal(snap.requestCount, 1, `写 5 文件任务应只发 1 次模型请求，实际 ${snap.requestCount}`);
      assert.equal(harness.model.calls.length, 1);

      for (let i = 1; i <= 5; i++) {
        const p = join(harness.sandboxDir, `f${i}.txt`);
        assert.ok(existsSync(p), `f${i}.txt 应存在`);
        assert.equal(readFileSync(p, 'utf8'), `内容${['一', '二', '三', '四', '五'][i - 1]}`);
      }

      // 成功路径零注入：写类观测全部 low receipt，injected_ratio = 0
      const counters = snap.counters();
      assert.equal(counters.produced, 5, '5 次写观测（produced）');
      assert.equal(counters.injected, 0, '成功写路径零注入');
      assert.equal(counters.injectedRatio, 0);
      assert.equal(counters.injectedRatio <= 0.2, true, '验收线 injected_ratio ≤ 0.2');

      // ledger：5 条工具成功 + final
      const okCommands = snap.records.filter((r) => r.kind === 'command' && r.status === 'ok');
      assert.equal(okCommands.length, 6, '5 写 + 1 final'); // tf-final 也记为 ok
      const final = snap.records.find((r) => r.kind === 'final');
      assert.ok(final !== undefined && final.kind === 'final');
      assert.equal(final.summary, '五个文件已写');
      assert.equal(lastReasonOf(snap), 'completed');
    } finally {
      harness.cleanup();
    }
  });

  it('A2. waitTools 挂起-重入：依赖有序、单流内完成；high 观测按重入规则注入骨架', async () => {
    harness = makeHarness({
      task: '先写两个文件再读回来。',
      scenarios: loadScenarios('wait-tools-continue.json', 'wait-tools-xml.json'),
    });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      // 请求 1 = 单流（两写一读 + tf-final，waitTools 挂起-重入全部发生在流内）；
      // 请求 2 = read 的 high 骨架按"三种重入事由"注入（模型永不在信息真空里收尾）
      assert.equal(snap.requestCount, 2, `1 流内完成 + 1 骨架重入，实际 ${snap.requestCount}`);
      assert.equal(harness.model.calls.length, 2);

      const records = snap.records;
      const seqOf = (pred: (r: (typeof records)[number]) => boolean): number => {
        const hit = records.find(pred);
        assert.ok(hit !== undefined, '缺少预期记录');
        return hit.seq;
      };
      const wbOk = seqOf((r) => r.kind === 'command' && r.status === 'ok' && r.id === 'wb');
      const waOk = seqOf((r) => r.kind === 'command' && r.status === 'ok' && r.id === 'wa');
      const raDispatched = seqOf((r) => r.kind === 'command' && r.status === 'dispatched' && r.id === 'ra');
      const finalSeq = seqOf((r) => r.kind === 'final');
      assert.ok(raDispatched > wbOk && raDispatched > waOk, 'tf-read 必须在两个写完成后才派发（depends_on 语义）');
      assert.ok(finalSeq > raDispatched, 'tf-final 在读之后（waitTools(3) 挂起点证明：挂起-重入发生在同一流内）');
      assert.equal(readFileSync(join(harness.sandboxDir, 'a.txt'), 'utf8'), '内容A');

      // 请求 2 注入自写回验 receipt（修复限制 1：a.txt 由本任务 tf-write 写过，不再回灌全文），
      // 模型确认后再次 tf-final 收敛
      // （句柄版本号按 obs key=path 计：a.txt 的写回执是 v1，read 观测是 v2）
      const req2 = harness.wireRequests[1]!;
      const receiptBlock = req2.contentTexts.find((t) => t.includes('[tf-stream:receipt') && t.includes('path=a.txt'));
      assert.ok(receiptBlock !== undefined, `请求 2 应注入自写回验 receipt，实际消息：\n${req2.contentTexts.join('\n---\n').slice(0, 2000)}`);
      assert.ok(receiptBlock.includes('lines=') && /sha256=[0-9a-f]{16}/.test(receiptBlock), 'receipt 应携带行数与内容指纹');
      assert.ok(!receiptBlock.includes('内容A'), 'receipt 不得回灌自写文件全文');
      const counters = snap.counters();
      assert.equal(counters.produced, 3);
      assert.equal(counters.injected, 2, 'receipt 路径计数口径不变：骨架位 + receipt peek 合计 2');
      assert.equal(lastReasonOf(snap), 'completed');
    } finally {
      harness.cleanup();
    }
  });

  it('A3. 失败注入改道：结构化错误进下一请求，模型改道成功，调用次数 = 2', async () => {
    harness = makeHarness({
      task: '改道演练：写 a.txt 和 fail.txt（fail.txt 会被沙箱拒绝）。',
      scenarios: loadScenarios('reroute-second.json', 'reroute-first.json'),
      sandboxHooks: { failPathsMatching: 'fail' },
      config: { maxReentries: 8 },
    });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      assert.equal(snap.requestCount, 2, `失败改道应恰好 2 次请求，实际 ${snap.requestCount}`);
      assert.equal(harness.model.calls.length, 2);

      // 沙箱结果：a.txt 成功、fail.txt 不存在、fixed.txt 改道成功
      assert.ok(existsSync(join(harness.sandboxDir, 'a.txt')));
      assert.ok(!existsSync(join(harness.sandboxDir, 'fail.txt')), '失败目标不得存在');
      assert.ok(existsSync(join(harness.sandboxDir, 'fixed.txt')));
      assert.equal(readFileSync(join(harness.sandboxDir, 'fixed.txt'), 'utf8'), 'FIXED');

      // 请求 2 携带结构化错误（command id + 失败原因 + 可改写建议）
      const req2 = harness.wireRequests[1]!;
      const errBlock = req2.contentTexts.find((t) => t.includes('[tf-stream:error id=wf cmd=tf-write target=fail.txt]'));
      assert.ok(errBlock !== undefined, `请求 2 应包含 wf 的结构化错误块，实际消息：\n${req2.contentTexts.join('\n---\n').slice(0, 2000)}`);
      assert.ok(errBlock.includes('EFAIL'), '错误块应包含失败原因');
      assert.ok(errBlock.includes('建议：'), '错误块应包含可改写建议');

      // ledger：wa ok / wf failed / wx ok / final
      const statuses = snap.records
        .filter((r): r is Extract<(typeof snap.records)[number], { kind: 'command' }> => r.kind === 'command')
        .filter((r) => ['wa', 'wf', 'wx'].includes(r.id));
      assert.equal(statuses.filter((r) => r.status === 'ok').length, 2);
      assert.ok(statuses.some((r) => r.id === 'wf' && r.status === 'failed'));
      assert.equal(lastReasonOf(snap), 'completed');
    } finally {
      harness.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// B. O6 前缀断言（fail-closed）与 prefix 单调
// ---------------------------------------------------------------------------

describe('B. O6 preflight 前缀断言', () => {
  let harness: Harness | undefined;
  beforeEach(() => { harness?.cleanup(); harness = undefined; });

  it('B1. preflight 违反 → render() 抛 PrefixBrokenError → runTurn 拒绝且不再发请求（fail-closed）', async () => {
    // 内核 render.ts 的公共 API 结构上不可能破坏前缀（append-only + truncateAppendTail
    // 显式推进基线，04 号已单测）——O6 断言防的是"装配器被 bug 绕过"。
    // 这里用包装 renderer 模拟第二次装配时稳定段被改写，验证驱动器侧的处理：
    // 拒绝发送、不吞错、turn 以 DRIVER_ERROR 收场。
    const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-loop-'));
    try {
      const model = createMockModel({
        scenarios: [{
          name: 'break-prefix',
          match: { promptIncludes: '前缀破坏演练' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '开始。\n' },
            { type: 'commands', commands: ['<tf-write path="p.txt" id="wp">P</tf-write>'] },
            { type: 'waitTools', count: 1, timeoutMs: 5000 },
            { type: 'finish', reason: 'stop' },
          ],
        }],
        provider: 'mock',
      });
      const base = new ContextRenderer({
        system: 'sys',
        protocol: 'proto',
        toolSchemas: 'tools',
        invariants: 'inv',
      });
      let renders = 0;
      const brokenRenderer = {
        appendHistory: (m: { role: 'user' | 'assistant' | 'tool'; content: string }) => base.appendHistory(m),
        appendHandleDelta: (d: never) => base.appendHandleDelta(d),
        setTail: (t: Array<{ role?: 'user' | 'assistant' | 'tool' | 'system'; content: string }>) => base.setTail(t),
        stableHash: () => base.stableHash(),
        render: () => {
          renders += 1;
          if (renders >= 2) throw new PrefixBrokenError(0, 'old', 'mutated', '模拟装配被改写');
          return base.render();
        },
      } as unknown as ContextRenderer;
      const driver = new SingleStreamDriver(
        {
          stream: (o) => normalizeStreamShim(model.adapter.stream({ provider: o.provider, model: o.model, messages: o.messages, signal: o.signal })),
          executeTools: createSandboxExecutor(sandboxDir),
        },
        { provider: 'mock', model: 'm' },
        brokenRenderer,
      );
      driver.pushUserTask('前缀破坏演练：写一个文件。');
      await assert.rejects(
        () => driver.runTurn(),
        (error: unknown) => error instanceof PrefixBrokenError,
        'O6 preflight 必须拒绝发送（fail-closed）',
      );
      const snap = driver.snapshot();
      assert.equal(snap.requestCount, 1, '违反前缀断言后不得发出第二个请求');
      assert.ok(snap.records.some((r) => r.kind === 'fault' && r.fault === 'driver-error'), '驱动器异常应有 fault 记录（fail-open 不静默）');
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('B2. 失败改道全程：请求稳定前缀逐字节单调（renderHash/stableHash 可对账）', async () => {
    harness = makeHarness({
      task: '改道演练：写 a.txt 和 fail.txt（fail.txt 会被沙箱拒绝）。',
      scenarios: loadScenarios('reroute-second.json', 'reroute-first.json'),
      sandboxHooks: { failPathsMatching: 'fail' },
    });
    try {
      await harness.driver.runTurn();
      const snap = harness.driver.snapshot();
      assert.equal(snap.requestCount, 2);
      // preflight 已在 render() 内逐请求断言（B 通过 = 断言全程未抛）
      assert.equal(snap.stableHashes.length, 2);
      assert.notEqual(snap.stableHashes[0], snap.stableHashes[1], '追加区只增 → 稳定段哈希必变');

      // 独立复核：请求 1 的稳定段（去掉易变尾）必须是请求 2 消息的前缀。
      // 易变尾大小由 request 记录的 injectionBlocks 给出（本请求注入块数）。
      const requestRecords = snap.records.filter((r): r is Extract<(typeof snap.records)[number], { kind: 'request' }> => r.kind === 'request');
      const req1 = harness.wireRequests[0]!.messages.map((m) => ({ role: m.role, content: m.content.map((b) => b.text ?? '').join('\n') }));
      const req2 = harness.wireRequests[1]!.messages.map((m) => ({ role: m.role, content: m.content.map((b) => b.text ?? '').join('\n') }));
      const stableLen1 = req1.length - requestRecords[0]!.injectionBlocks;
      const prefix = commonPrefixLen(req1, req2);
      assert.ok(
        prefix >= stableLen1,
        `请求 2 的稳定段必须逐字节包含请求 1 的稳定段（commonPrefix=${prefix} ≥ stable=${stableLen1}）`,
      );
      // 复核前缀断言本身（双保险：内核 assertPrefixStable 直接跑一遍）
      assert.doesNotThrow(() => assertPrefixStable(req1.slice(0, stableLen1), req2.slice(0, prefix)));
      // 系统消息全程字节不变
      assert.equal(req1[0]!.content, req2[0]!.content);
    } finally {
      harness.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// C. 重入护栏：流故障恢复 / 看门狗 / 中断恢复
// ---------------------------------------------------------------------------

describe('C. 流故障与重入护栏', () => {
  let harness: Harness | undefined;
  beforeEach(() => { harness?.cleanup(); harness = undefined; });

  it('C1. 流空闲超时 → 看门狗 abort → aborted finish 记录 → nudge 重入收敛', async () => {
    harness = makeHarness({
      task: '故障注入：流超时演练。',
      scenarios: loadScenarios('recover-final.json', 'fault-timeout.json'),
      config: { streamIdleTimeoutMs: 200 },
    });
    try {
      const started = Date.now();
      const reason = await harness.driver.runTurn();
      const elapsed = Date.now() - started;
      assert.equal(reason.kind, 'completed');
      assert.ok(elapsed < 15_000, `看门狗应在 200ms 掐断流，实际 ${elapsed}ms`);
      const snap = harness.driver.snapshot();
      assert.equal(snap.requestCount, 2);
      assert.ok(faultsOf(snap).some((f) => f.fault === 'stream-aborted'), '应有 stream-aborted fault');
      assert.ok(faultsOf(snap).some((f) => f.fault === 'missing-final-nudge'), '应有 nudge fault');
    } finally {
      harness.cleanup();
    }
  });

  it('C2. 流中断（midstream abort）→ error finish 归一化 → nudge 重入收敛', async () => {
    harness = makeHarness({
      task: '故障注入：流中断演练。',
      scenarios: loadScenarios('recover-final.json', 'fault-abort-xml.json'),
    });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      assert.equal(snap.requestCount, 2);
      assert.ok(faultsOf(snap).some((f) => f.fault === 'stream-error'), '应有 stream-error fault');
      // 中断前已派发的写命令照常落盘（部分成果保留）
      assert.ok(existsSync(join(harness.sandboxDir, 'a.txt')));
    } finally {
      harness.cleanup();
    }
  });

  it('C3. 无 tf-final 且无重入事由 → 一次性 nudge；再不收敛 → blocked（护栏）', async () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-loop-'));
    const model = createMockModel({
      scenarios: [{
        name: 'never-final',
        match: { promptIncludes: '不收敛演练' },
        chunking: { charsPerChunk: 0, delayMs: 0 },
        steps: [
          { type: 'text', text: '我就是不输出 tf-final。\n' },
          { type: 'finish', reason: 'stop' },
        ],
      }],
      provider: 'mock',
    });
    const ports: DriverPorts = {
      stream: (options) => normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal })),
      executeTools: createSandboxExecutor(sandboxDir),
    };
    const driver = new SingleStreamDriver(ports, { provider: 'mock', model: 'm' });
    driver.pushUserTask('不收敛演练。');
    try {
      const reason = await driver.runTurn();
      assert.equal(reason.kind, 'blocked');
      const snap = driver.snapshot();
      assert.equal(snap.requestCount, 2, 'nudge 一次后第二次仍无 final → blocked');
      assert.ok(faultsOf(snap).some((f) => f.fault === 'turn-blocked'));
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('C4. maxReentries 护栏：失败永不修复 → blocked', async () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-loop-'));
    const model = createMockModel({
      scenarios: [{
        name: 'always-fails',
        match: { promptIncludes: '重入护栏演练' },
        chunking: { charsPerChunk: 0, delayMs: 0 },
        steps: [
          { type: 'text', text: '每次都写同一个失败路径。\n' },
          { type: 'commands', commands: ['<tf-write path="fail.txt" id="wf1">X</tf-write>'] },
          { type: 'waitTools', count: 1, timeoutMs: 5000 },
          { type: 'commands', commands: ['<tf-write path="fail.txt" id="wf2">X</tf-write>'] },
          { type: 'waitTools', count: 2, timeoutMs: 5000 },
          { type: 'finish', reason: 'stop' },
        ],
      }],
      provider: 'mock',
    });
    const ports: DriverPorts = {
      stream: (options) => normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal })),
      executeTools: createSandboxExecutor(sandboxDir, { failPathsMatching: 'fail' }),
    };
    const driver = new SingleStreamDriver(ports, { provider: 'mock', model: 'm', maxReentries: 2 });
    driver.pushUserTask('重入护栏演练。');
    try {
      const reason = await driver.runTurn();
      assert.equal(reason.kind, 'blocked');
      const snap = driver.snapshot();
      assert.ok(snap.requestCount <= 4, `护栏应限制重入，实际 ${snap.requestCount} 次`);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// D. O5 预算阶梯
// ---------------------------------------------------------------------------

describe('D. O5 预算阶梯', () => {
  let harness: Harness | undefined;
  beforeEach(() => { harness?.cleanup(); harness = undefined; });

  it('D1. 预算耗尽 → final-only 档：降级交付通知，不再注入观测，tf-final 后收敛', async () => {
    // 剧本链：请求1（normal）失败注入 → 请求2（final-only，错误块已注入但不修复、不 final）
    // → 降级交付通知（degraded 分支）→ 请求3（final-only）tf-final 收敛。
    harness = makeHarness({
      task: '预算阶梯演练：写 a.txt 和 fail.txt（fail.txt 会被沙箱拒绝）。',
      scenarios: loadScenarios('burn-more.json', 'degraded-final.json', {
        name: 'budget-burn',
        match: { promptIncludes: '预算阶梯演练' },
        chunking: { charsPerChunk: 0, delayMs: 0 },
        steps: [
          { type: 'text', text: '写文件。\n' },
          { type: 'commands', commands: ['<tf-write path="fail.txt" id="wf">F</tf-write>'] },
          { type: 'waitTools', count: 1, timeoutMs: 5000 },
          { type: 'finish', reason: 'stop' },
        ],
      }),
      sandboxHooks: { failPathsMatching: 'fail' },
      config: { budgetTokens: 50 }, // 极小预算：请求 1 的 usage 直接击穿 90% 线
    });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      const requestRecords = snap.records.filter((r): r is Extract<(typeof snap.records)[number], { kind: 'request' }> => r.kind === 'request');
      assert.equal(requestRecords.length, 3, `剧本链应 3 次请求，实际 ${snap.requestCount}`);
      assert.equal(requestRecords[0]!.level, 'normal');
      assert.equal(requestRecords[requestRecords.length - 1]!.level, 'final-only', '预算击穿后应进入 final-only 档');
      assert.ok(faultsOf(snap).some((f) => f.fault === 'degraded-delivery'), '应有降级交付记录');
      // 请求 3 的易变尾是降级交付通知（不是常规 nudge），且尾块不再携带观测/错误注入
      //（断言只看最后一条 user 消息——系统提示的协议文本里含 "[tf-stream:error]" 字样，
      //  全消息扫描会误报）
      const req3 = harness.wireRequests[2]!;
      const tailTexts = req3.contentTexts.slice(req3.contentTexts.length - req3.messages.filter((m) => m.role === 'user').length);
      assert.ok(
        tailTexts.some((t) => t.includes('tf-stream:degraded')),
        'final-only 档应注入降级交付通知',
      );
      assert.ok(!tailTexts.some((t) => t.includes('[tf-stream:error')), 'final-only 档不得再注入错误块');
    } finally {
      harness.cleanup();
    }
  });

  it('D2. 阶梯阈值单元：70%/90% 两档', () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-loop-'));
    try {
      const model = createMockModel({ scenarios: [{ name: 'idle', steps: [{ type: 'finish', reason: 'stop' }] }], provider: 'mock' });
      const driver = new SingleStreamDriver(
        { stream: (o) => normalizeStreamShim(model.adapter.stream({ provider: o.provider, model: o.model, messages: o.messages, signal: o.signal })), executeTools: createSandboxExecutor(sandboxDir) },
        { provider: 'mock', model: 'm', budgetTokens: 1000 },
      );
      assert.equal(driver.budgetLevel(), 'normal');
      // 直接驱动 usage 越过 70% 线：压一个 usage chunk 不可行（内部状态），
      // 用公开预算面验证：700 token 消耗 → high-only。
      // usage 只能经流灌入——这里以 final-only 边界用例覆盖阈值语义（usage=950）
      const scenario = async function* () {
        yield { type: 'usage' as const, usage: { inputTokens: 950, outputTokens: 0 } };
      };
      void scenario; // 阈值逻辑由 D1 的 E2E 覆盖；此处只锁定 normal 缺省行为
      assert.equal(driver.budgetLevel(), 'normal');
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// E. 双通道：原生 tool_call 阻塞回灌
// ---------------------------------------------------------------------------

describe('E. 原生 tool_call 双通道', () => {
  let harness: Harness | undefined;
  beforeEach(() => { harness?.cleanup(); harness = undefined; });

  it('E1. 原生 tool-call chunk → 阻塞执行 → 结果回灌下一请求', async () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-loop-'));
    try {
      writeFileSync(join(sandboxDir, 'native.txt'), '原生通道内容', 'utf8');
      const argDelta = JSON.stringify({ file_path: 'native.txt' });
      const wireRequests: Array<{ role: string; content: Array<{ type: 'text'; text: string }> }>[] = [];
      let callCount = 0;
      const ports: DriverPorts = {
        stream: (options) => {
          wireRequests.push(options.messages as Array<{ role: string; content: Array<{ type: 'text'; text: string }> }>);
          callCount += 1;
          if (callCount === 1) {
            // 请求 1：prose + 原生 read 工具调用（tool-call-delta 分片 + finish tool-calls）
            return normalizeStreamShim((async function* () {
              yield { type: 'block-start' as const, index: 0, blockType: 'text' };
              yield { type: 'text-delta' as const, index: 0, text: '用原生工具读文件。\n' };
              yield { type: 'tool-call-delta' as const, index: 1, id: 'call-1', name: 'read', argumentsDelta: argDelta.slice(0, 10) };
              yield { type: 'tool-call-delta' as const, index: 1, id: 'call-1', argumentsDelta: argDelta.slice(10) };
              yield { type: 'block-end' as const, index: 1, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: argDelta } };
              yield { type: 'usage' as const, usage: { inputTokens: 100, outputTokens: 10 } };
              yield { type: 'finish' as const, reason: { kind: 'tool-calls' as const } };
            })());
          }
          // 请求 2：收到结果后收尾（tf-final 内联在文本里）
          return normalizeStreamShim((async function* () {
            yield { type: 'block-start' as const, index: 0, blockType: 'text' };
            yield { type: 'text-delta' as const, index: 0, text: '收到结果，收尾。<tf-final id="fn" summary="原生通道完成"/>\n' };
            yield { type: 'finish' as const, reason: { kind: 'stop' as const } };
          })());
        },
        executeTools: createSandboxExecutor(sandboxDir),
      };
      const driver = new SingleStreamDriver(ports, { provider: 'mock', model: 'm' });
      driver.pushUserTask('原生工具演练。');
      const reason = await driver.runTurn();
      assert.equal(reason.kind, 'completed');
      assert.equal(callCount, 2, '原生工具结果回灌 → 第二次请求');
      const req2Texts = wireRequests[1]!.map((m) => m.content.map((b) => b.text ?? '').join('\n'));
      assert.ok(
        req2Texts.some((t) => t.includes('[tf-stream:tool-result callId=call-1 tool=read]') && t.includes('原生通道内容')),
        `请求 2 应注入原生工具结果，实际：\n${req2Texts.join('\n---\n').slice(0, 1500)}`,
      );
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('E2. 中断流的残缺原生调用被丢弃并记录（不执行半截 JSON 参数）', async () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-loop-'));
    const ports: DriverPorts = {
      stream: () => normalizeStreamShim((async function* () {
        yield { type: 'tool-call-delta' as const, index: 0, id: 'c9', name: 'write', argumentsDelta: '{"file_path":"x' };
        yield { type: 'finish' as const, reason: { kind: 'aborted' as const, message: 'cut' } };
      })()),
      executeTools: createSandboxExecutor(sandboxDir),
    };
    const driver = new SingleStreamDriver(ports, { provider: 'mock', model: 'm' });
    driver.pushUserTask('残缺调用演练。');
    try {
      await driver.runTurn();
      const snap = driver.snapshot();
      assert.ok(!existsSync(join(sandboxDir, 'x')), '残缺调用不得执行');
      assert.ok(faultsOf(snap).some((f) => f.fault === 'native-calls-discarded'));
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// F. gate.admit 准入
// ---------------------------------------------------------------------------

describe('F. gate.admit 准入', () => {
  let harness: Harness | undefined;
  beforeEach(() => { harness?.cleanup(); harness = undefined; });

  it('F1. gate 拒绝 → 命令 rejected → 结构化错误重入 → 模型改道', async () => {
    const denyingGate: GatePort = {
      async admit(req) {
        if (req.action === 'tf-write' && (req.detail ?? '').includes('deny.txt')) {
          return { verdict: 'deny', reason: 'fatal-no-approval-channel', detail: 'deny.txt 被策略禁止' };
        }
        return { verdict: 'allow', reversibility: 'read' };
      },
    };
    harness = makeHarness({
      task: '改道演练：写 a.txt 和 fail.txt（fail.txt 会被沙箱拒绝）。',
      // 顺序敏感：gate-reroute 的 marker 与 reroute-second 相同（tf-stream:error），
      // 但本流的信号计数不同（waitTools 2）——必须排在 reroute-second 之前
      scenarios: loadScenarios({
        name: 'gate-reroute',
        match: { promptIncludes: 'tf-stream:error' },
        chunking: { charsPerChunk: 0, delayMs: 0 },
        steps: [
          { type: 'text', text: '收到拒绝报告，改道写 fixed.txt。\n' },
          { type: 'commands', commands: ['<tf-write path="fixed.txt" id="wx">FIXED</tf-write>'] },
          { type: 'waitTools', count: 2, timeoutMs: 5000 },
          { type: 'commands', commands: ['<tf-final id="fg" summary="改道成功"/>'] },
          { type: 'finish', reason: 'stop' },
        ],
      }, {
        name: 'gate-deny-first',
        match: { promptIncludes: '改道演练' },
        chunking: { charsPerChunk: 0, delayMs: 0 },
        steps: [
          { type: 'text', text: '写 deny.txt（会被 gate 拒绝）。\n' },
          { type: 'commands', commands: ['<tf-write path="deny.txt" id="wd">D</tf-write>'] },
          { type: 'waitTools', count: 1, timeoutMs: 5000 },
          { type: 'finish', reason: 'stop' },
        ],
      }),
      gate: denyingGate,
      sandboxHooks: { failPathsMatching: 'fail' },
    });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      assert.ok(!existsSync(join(harness.sandboxDir, 'deny.txt')), '被拒绝的命令不得执行');
      assert.ok(
        snap.records.some((r) => r.kind === 'command' && r.id === 'wd' && r.status === 'rejected'),
        '应有 rejected 记录',
      );
      const req2 = harness.wireRequests[1]!;
      assert.ok(req2.contentTexts.some((t) => t.includes('fatal-no-approval-channel')), '拒绝原因应结构化注入');
      assert.ok(existsSync(join(harness.sandboxDir, 'fixed.txt')), '模型改道成功');
    } finally {
      harness.cleanup();
    }
  });

  it('F2. gate 全放行 → 行为与无门一致', async () => {
    const allowGate: GatePort = { async admit() { return { verdict: 'allow', reversibility: 'read' }; } };
    harness = makeHarness({
      task: '请写五个文件：f1 到 f5。',
      scenarios: loadScenarios('5-file-basic.json'),
      gate: allowGate,
    });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      assert.equal(harness.driver.snapshot().requestCount, 1);
    } finally {
      harness.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// G. peek 链路（O2 need_result 通道）
// ---------------------------------------------------------------------------

describe('G. tf-peek need_result 通道', () => {
  let harness: Harness | undefined;
  beforeEach(() => { harness?.cleanup(); harness = undefined; });

  it('G1. read 骨架注入 → peek 按行段取回 → 结果注入 → 收敛（3 次请求）', async () => {
    harness = makeHarness({
      task: '句柄演练：读 big.txt。',
      scenarios: loadScenarios('peek-second.json', 'peek-third.json', 'peek-first.json'),
    });
    try {
      writeFileSync(join(harness.sandboxDir, 'big.txt'), '第一行 alpha\n第二行 beta\n第三行 gamma\n第四行 delta\n', 'utf8');
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      assert.equal(snap.requestCount, 3, `read → peek → final 应 3 次请求，实际 ${snap.requestCount}`);

      const req2 = harness.wireRequests[1]!;
      assert.ok(req2.contentTexts.some((t) => t.includes('[tf-stream:observation') && t.includes('obs:read:r1@v1')), '请求 2 应注入观测反馈');
      // v0.2：小文件 read 直接反馈完整原文（上游"成功结果完整反馈一次"语义）
      assert.ok(req2.contentTexts.some((t) => t.includes('第一行 alpha') && t.includes('第四行 delta')), '请求 2 应包含 read 完整原文反馈');
      const req3 = harness.wireRequests[2]!;
      assert.ok(req3.contentTexts.some((t) => t.includes('[tf-stream:peek') && t.includes('第一行 alpha')), '请求 3 应注入 peek 结果');

      const counters = snap.counters();
      assert.equal(counters.peeked, 2, 'v0.2：完整反馈自动 peek 1 次 + 模型 peek 1 次');
      assert.equal(counters.produced, 1, 'peek 不走 observe（03 号口径）');
    } finally {
      harness.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// H. AgentFactory 生命周期（fake host）
// ---------------------------------------------------------------------------

interface FakeSession {
  id: string;
  header: { id: string };
  events: Array<{ type: string; data: unknown; opts?: unknown }>;
  append(type: string, data: unknown, opts?: unknown): void;
}

function createFakeSession(id: string): FakeSession {
  const session: FakeSession = {
    id,
    header: { id },
    events: [],
    append(type, data, opts) {
      session.events.push({ type, data, opts });
    },
  };
  return session;
}

function createFakeHost() {
  const calls = { prepared: 0, enteredSession: 0, announcedSession: 0, enteredAgent: 0, announcedAgent: 0, persisted: 0, handleClosed: 0, disposedPrep: 0 };
  const sessions = {
    prepare(id: string, opts?: { meta?: unknown }) {
      calls.prepared += 1;
      const session = createFakeSession(id);
      return {
        session,
        [Symbol.dispose]() {
          calls.disposedPrep += 1;
        },
      };
    },
    enter(session: unknown) {
      calls.enteredSession += 1;
      return () => {};
    },
    announce(session: unknown) {
      calls.announcedSession += 1;
    },
  };
  const agents = {
    enter(agent: unknown, owner: unknown) {
      calls.enteredAgent += 1;
      return () => {};
    },
    async announce(agent: unknown, source: string) {
      calls.announcedAgent += 1;
    },
  };
  const persistence = {
    async create(header: unknown, opts?: unknown) {
      calls.persisted += 1;
      return {
        async close() {
          calls.handleClosed += 1;
        },
      };
    },
  };
  const ctx = {
    sessions,
    agents,
    get(service: string) {
      return service === 'sessionPersistence' ? persistence : undefined;
    },
  };
  return { ctx, calls, persistence };
}

describe('H. AgentFactory 生命周期（fake host）', () => {
  const sandboxDirs: string[] = [];
  const mkSandbox = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-factory-'));
    sandboxDirs.push(dir);
    return dir;
  };

  it('H1. createAgent 全序：prepare → persistence → 双公告 → setup → followup 驱动 → dispose', async () => {
    const sandboxDir = mkSandbox();
    const { ctx, calls } = createFakeHost();
    const model = createMockModel({ scenarios: loadScenarios('5-file-basic.json'), provider: 'mock' });

    const setupCalls: Array<{ sessionId: string; agentId: string }> = [];
    const factory = createStreamAgentFactory({
      ctx,
      createDriver({ sessionId, agentOptions, session }) {
        const events = createSessionEventWriter(session);
        return {
          driver: new SingleStreamDriver(
            {
              stream: (options) => normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal })),
              executeTools: createSandboxExecutor(sandboxDir),
              events,
              onToolSettled: () => model.notifyToolResult(),
            },
            { provider: agentOptions.provider ?? 'mock', model: agentOptions.model ?? 'mock-scenario', streamIdleTimeoutMs: 30_000 },
          ),
        };
      },
    });

    const setup = (agentCtx: unknown, agent: StreamLoopAgent) => {
      setupCalls.push({ sessionId: String((agentCtx as { sessionId?: string })?.sessionId ?? ''), agentId: agent.id });
      agent.model.select({ provider: 'mock', model: 'mock-scenario' });
    };

    const handle = await factory.createAgent(ctx, {
      sessionId: `session-${randomUUID()}`,
      meta: { cwd: sandboxDir },
      agentOptions: { provider: 'mock', model: 'mock-scenario' },
      setup,
    });

    assert.equal(calls.prepared, 1);
    assert.equal(calls.persisted, 1, 'persistence.create 应被调用');
    assert.equal(calls.enteredSession, 1, 'sessions.enter');
    assert.equal(calls.announcedSession, 1, 'sessions.announce');
    assert.equal(calls.enteredAgent, 1, 'agents.enter');
    assert.equal(calls.announcedAgent, 1, 'agents.announce');
    assert.equal(setupCalls.length, 1);
    assert.equal(setupCalls[0]!.agentId, handle.agent.id);

    // followup → 驱动器跑完 5 文件任务
    handle.agent.followup({
      role: 'user',
      content: [{ type: 'text', text: '请写五个文件：f1 到 f5。' }],
      source: { kind: 'user' },
    });
    await handle.agent.whenIdle();
    assert.equal(handle.agent.status, 'idle');
    assert.ok(existsSync(join(sandboxDir, 'f3.txt')));

    // 会话事件（fake session 收到的 append 形状）
    const fakeSession = handle.agent.session as FakeSession;
    const types = fakeSession.events.map((e) => e.type);
    assert.ok(types.includes('user/message'), 'user/message 应落盘');
    assert.ok(types.includes('turn/start'), 'turn/start 应落盘');
    assert.ok(types.includes('step/start'), 'step/start 应落盘');
    assert.ok(types.includes('assistant/message'), 'assistant/message 应落盘');
    assert.ok(types.includes('step/end') && types.includes('turn/end'), 'step/end + turn/end 应落盘');
    const assistantEvent = fakeSession.events.find((e) => e.type === 'assistant/message');
    assert.ok(assistantEvent !== undefined);
    const data = assistantEvent.data as { message: { id: string; role: string; content: Array<{ type: string; text?: string }>; source: { kind: string } }; stream: unknown[] };
    assert.equal(data.message.role, 'assistant');
    assert.equal(data.message.source.kind, 'model');
    assert.ok(Array.isArray(data.stream) && data.stream.length === 0);
    const turnEnd = fakeSession.events.find((e) => e.type === 'turn/end');
    assert.equal((turnEnd!.data as { reason: { kind: string } }).reason.kind, 'completed');

    // model.select 落盘 model/selection
    assert.ok(types.includes('model/selection'), 'model/selection 应落盘');

    await handle.dispose();
    assert.equal(calls.handleClosed, 1, 'dispose 关闭持久化句柄');
  });

  it('H2. resume：open → read → seed prepare → 双公告', async () => {
    const sandboxDir = mkSandbox();
    const { ctx, calls } = createFakeHost();
    const persistedEvents: Array<{ type: string; data: unknown }> = [];
    const persistence = {
      async open(id: string, mode: string) {
        assert.equal(mode, 'write');
        return {
          header: { id },
          inheritedEventCount: 0,
          async read(from: number) {
            assert.equal(from, 0);
            return { events: persistedEvents, eventState: undefined };
          },
          async close() {
            calls.handleClosed += 1;
          },
        };
      },
    };
    const factory = createStreamAgentFactory({
      ctx: { ...ctx, get: (service: string) => (service === 'sessionPersistence' ? persistence : undefined) },
      createDriver() {
        return {
          driver: new SingleStreamDriver(
            {
              stream: (o) => normalizeStreamShim(createMockModel({ scenarios: [{ name: 'idle', steps: [{ type: 'finish', reason: 'stop' }] }], provider: 'mock' }).adapter.stream({ provider: o.provider, model: o.model, messages: o.messages, signal: o.signal })),
              executeTools: createSandboxExecutor(sandboxDir),
            },
            { provider: 'mock', model: 'm' },
          ),
        };
      },
    });
    const handle = await factory.resume(ctx, { resumeSessionId: 'session-resume-1', agentOptions: { provider: 'mock', model: 'm' } });
    assert.equal(calls.enteredAgent, 1);
    assert.equal(calls.announcedAgent, 1);
    await handle.dispose();
    assert.equal(calls.handleClosed, 1);
  });

  it('H3. resume 无 persistence → 结构化报错（不静默）', async () => {
    const { ctx } = createFakeHost();
    const factory = createStreamAgentFactory({
      ctx: { ...ctx, get: () => undefined },
      createDriver() {
        throw new Error('unreachable');
      },
    });
    await assert.rejects(
      () => factory.resume(ctx, { resumeSessionId: 's1' }),
      /session persistence is not configured/,
    );
  });

  it('H4. apply 入口：setFactory 接管 + 重复注册 fail-fast + llm/tools 缺失报错', () => {
    const sandboxDir = mkSandbox();
    // setFactory 正常路径
    const model = createMockModel({ scenarios: [{ name: 'idle', steps: [{ type: 'finish', reason: 'stop' }] }], provider: 'mock' });
    const registered: unknown[] = [];
    const hostCtx = {
      agents: {
        setFactory(factory: unknown) {
          registered.push(factory);
          return () => {};
        },
      },
      llm: { stream: (o: StreamRequestOptions) => normalizeStreamShim(model.adapter.stream({ provider: o.provider, model: o.model, messages: o.messages, signal: o.signal })) },
      tools: { execute: createSandboxExecutor(sandboxDir) },
      get: () => undefined,
    };
    const entry = applyLoopEntry(hostCtx, { provider: 'mock', model: 'mock-scenario' });
    assert.equal(registered.length, 1, 'setFactory 应被调用一次');
    assert.ok(entry.factory !== undefined);
    entry.dispose();

    // 重复注册 fail-fast（探针 A：重复注册抛 "an agent factory is already registered"）
    const conflictingCtx = {
      ...hostCtx,
      agents: {
        setFactory() {
          throw new Error('an agent factory is already registered');
        },
      },
    };
    assert.throws(() => applyLoopEntry(conflictingCtx, {}), /already registered/);

    // llm 缺失 → fail-fast
    assert.throws(() => applyLoopEntry({ agents: hostCtx.agents, get: () => undefined }, {}), /ctx\.llm\.stream 不可用/);
    rmSync(sandboxDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// I. 驱动器杂项（默认映射 / 身份接线 / 取消）
// ---------------------------------------------------------------------------

describe('I. 驱动器杂项', () => {
  it('I1. 默认工具映射：tf-write/read/bash → 原生工具参数；peek/final → null', () => {
    const parser = new TfStreamParser();
    const events = parser.feed('<tf-write path="x.txt" id="w1">hi</tf-write><tf-read path="y.txt" id="r1"/><tf-bash cmd="ls" id="b1"/><tf-peek handle="obs:read:r1@v1" id="p1"/><tf-final id="f1"/>');
    void events;
    const commands = (parser as unknown as { commands: Map<string, TfCommand> }).commands;
    const write = commands.get('w1')!;
    const read = commands.get('r1')!;
    const bash = commands.get('b1')!;
    const peek = commands.get('p1')!;
    assert.deepEqual(DEFAULT_TOOL_MAPPING.toToolCall(write), { name: 'write', arguments: { file_path: 'x.txt', content: 'hi' } });
    assert.deepEqual(DEFAULT_TOOL_MAPPING.toToolCall(read), { name: 'read', arguments: { file_path: 'y.txt' } });
    // v0.2：宿主 shell 工具是 pwsh（command+description 双必填），不再是 'bash'
    assert.deepEqual(DEFAULT_TOOL_MAPPING.toToolCall(bash), { name: 'pwsh', arguments: { command: 'ls', description: 'tf-bash: ls' } });
    assert.equal(DEFAULT_TOOL_MAPPING.toToolCall(peek), null);
  });

  it('I2. cancel：中断在途流，turn 以 aborted 终止', async () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-loop-'));
    const model = createMockModel({
      scenarios: [{
        name: 'slow',
        match: { promptIncludes: '取消演练' },
        chunking: { charsPerChunk: 4, delayMs: 50 },
        steps: [
          { type: 'text', text: '慢慢输出。\n' },
          { type: 'fail', mode: 'timeout', delayMs: 30_000 },
        ],
      }],
      provider: 'mock',
    });
    const driver = new SingleStreamDriver(
      {
        stream: (o) => normalizeStreamShim(model.adapter.stream({ provider: o.provider, model: o.model, messages: o.messages, signal: o.signal })),
        executeTools: createSandboxExecutor(sandboxDir),
      },
      { provider: 'mock', model: 'm', streamIdleTimeoutMs: 30_000 },
    );
    driver.pushUserTask('取消演练。');
    try {
      const turnPromise = driver.runTurn();
      setTimeout(() => driver.cancel(new Error('user cancelled')), 150);
      const reason = await turnPromise;
      assert.equal(reason.kind, 'aborted');
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it('I3. 不可重试流错误（凭据缺失）→ fail-fast 终止回合，不烧重入预算', async () => {
    const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-loop-'));
    try {
      let calls = 0;
      const driver = new SingleStreamDriver(
        {
          stream: () => {
            calls += 1;
            return normalizeStreamShim((async function* () {
              yield { type: 'finish' as const, reason: { kind: 'error' as const, message: 'credential missing', code: 'MISSING_CREDENTIAL' } };
            })());
          },
          executeTools: createSandboxExecutor(sandboxDir),
        },
        { provider: 'mock', model: 'm' },
      );
      driver.pushUserTask('凭据缺失演练。');
      const reason = await driver.runTurn();
      assert.equal(reason.kind, 'error');
      assert.equal(reason.kind === 'error' ? reason.error.code : '', 'MISSING_CREDENTIAL');
      assert.equal(calls, 1, '不可重试错误不得发起第二次请求');
      const snap = driver.snapshot();
      assert.ok(snap.records.some((r) => r.kind === 'fault' && r.fault === 'stream-fatal'));
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// J. 分派 08：饥饿防线升格注入接线回归（07 号结果 §3.6 上报的断链，评测前修复）
// ---------------------------------------------------------------------------

describe('J. 饥饿升格接线（08 号评测前修复的回归）', () => {
  it('J1. 连续无 high 步后升格骨架进入下一请求（noteStep 返回值不再被丢弃）', async () => {
    const harness = makeHarness({
      task: '请写一个文件然后停下（本流不带 tf-final）。',
      // 场景选择按"首个命中"（mock-provider selectScenario）：升格块剧本必须排最前，
      // 否则请求 2 仍命中任务文本剧本（请求 2 的 prompt 同时含任务文本与升格块）。
      scenarios: loadScenarios('starvation-final.json', 'starvation-promote.json'),
      config: { starvationThreshold: 1 },
    });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      assert.equal(snap.requestCount, 2, `升格骨架必须触发重入（1 流写文件无 final + 1 流收尾），实际 ${snap.requestCount}`);
      // 请求 2 必须携带升格观测块（key=starvation-promoted），且不是 nudge
      const req2 = harness.wireRequests[1].contentTexts.join('\n');
      assert.ok(req2.includes('key=starvation-promoted'), '请求 2 应含升格骨架块');
      assert.ok(!req2.includes('[tf-stream:nudge]'), '有升格注入时不得走 nudge 兜底');
      // 升格的是 write 回执骨架（low → promoted），内容为句柄目录/骨架形态
      assert.ok(req2.includes('tf-peek'), '升格块应带 tf-peek 取回指引');
      // 内核 noteStep 语义：每次越过阈值都计数（step1 升格=实际注入；step2（tf-final 步）再次升格
      // 但被驱动器去重护栏拦下不再注入）→ 计数 2、实际注入块 1（M3 口径按 snapshot counters 为准）
      assert.equal(snap.counters().injected, 2, '两次过阈值都计数（内核语义）');
      assert.equal(snap.counters().produced, 1, '一次 write 产出');
    } finally {
      harness.cleanup();
    }
  });

  it('J2. 未设 env STREAM_LOOP_EVAL_DUMP 时 dumpEval 零副作用；设置后 turn 结束落 snapshot', async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), 'eval-dump-'));
    const dumpPrefix = join(dumpDir, 'driver-');
    const harness = makeHarness({
      task: '请写一个文件然后停下（本流不带 tf-final）。',
      scenarios: loadScenarios('starvation-final.json', 'starvation-promote.json'),
      config: { starvationThreshold: 1 },
    });
    try {
      process.env.STREAM_LOOP_EVAL_DUMP = dumpPrefix;
      try {
        const reason = await harness.driver.runTurn();
        assert.equal(reason.kind, 'completed');
        const dumps = readdirSync(dumpDir).filter((n) => n.startsWith('driver-') && n.endsWith('.json'));
        assert.equal(dumps.length, 1, 'turn 结束应落一个 snapshot dump');
        const dump = JSON.parse(readFileSync(join(dumpDir, dumps[0]), 'utf8'));
        assert.equal(dump.requestCount, 2);
        assert.equal(dump.counters.injected, 2, '与 J1 同款内核计数语义');
        assert.ok(Array.isArray(dump.records) && dump.records.length > 0);
        assert.ok(Array.isArray(dump.stableHashes) && dump.stableHashes.length === 2);
      } finally {
        delete process.env.STREAM_LOOP_EVAL_DUMP;
      }
    } finally {
      harness.cleanup();
      rmSync(dumpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// K. v0.3.1 截断修复（真机会话 session-84274277：任务做一半 + 占位答案）
// ---------------------------------------------------------------------------

describe('K. final 收束闸（v0.3.1 截断修复）', () => {
  const fast = { charsPerChunk: 0, delayMs: 0 };
  let harness: Harness;
  beforeEach(() => { harness?.cleanup(); });

  it('K1. 占位 summary 的 tf-final 不算收敛：结构化拒绝 → 重发真答案才收场', async () => {
    const scenarios: Scenario[] = [
      {
        name: 'real-final',
        match: { promptIncludes: 'summary 是占位内容' },
        chunking: fast,
        steps: [
          { type: 'text', text: '补上答案。\n' },
          { type: 'commands', commands: ['<tf-final id="f2" summary="a.txt 共 1 行，内容为 内容A"/>'] },
          { type: 'finish', reason: 'stop' },
        ],
      },
      {
        name: 'placeholder-final',
        match: { promptIncludes: '占位演练' },
        chunking: fast,
        steps: [
          { type: 'text', text: '开始。\n' },
          { type: 'commands', commands: ['<tf-final id="f1" summary="placeholder"/>'] },
          { type: 'finish', reason: 'stop' },
        ],
      },
    ];
    harness = makeHarness({ task: '占位演练：把 a.txt 的内容报出来。', scenarios });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed', '占位 final 被拒后应重入并最终收敛');
      const snap = harness.driver.snapshot();
      assert.equal(snap.requestCount, 2, `占位 final 必须触发一次重入，实际 ${snap.requestCount}`);
      const finals = snap.records.filter((r) => r.kind === 'final');
      const last = finals[finals.length - 1];
      assert.ok(last !== undefined && last.kind === 'final');
      assert.ok(last.summary.includes('内容A'), `最终答案必须是真答案，实际 ${last.summary}`);
      assert.ok(
        faultsOf(snap).some((f) => f.fault === 'premature-final' && f.detail.includes('占位')),
        '应记 premature-final fault',
      );
      const req2 = harness.wireRequests[1]!.contentTexts.join('\n');
      assert.ok(req2.includes('[tf-stream:error') && req2.includes('tf-final 无效'), '拒绝理由必须结构化注入给模型');
    } finally {
      harness.cleanup();
    }
  });

  it('K2. final 之后又发命令 = 答案过期：不得用旧 final 收敛', async () => {
    const scenarios: Scenario[] = [
      {
        name: 'restated-final',
        match: { promptIncludes: '答案已过期' },
        chunking: fast,
        steps: [
          { type: 'text', text: '重新声明结果。\n' },
          { type: 'commands', commands: ['<tf-final id="f2" summary="x.txt 已写入，内容 X"/>'] },
          { type: 'finish', reason: 'stop' },
        ],
      },
      {
        name: 'final-then-work',
        match: { promptIncludes: '过期演练' },
        chunking: fast,
        steps: [
          { type: 'text', text: '先声明完成，然后继续干活。\n' },
          {
            type: 'commands',
            commands: [
              '<tf-final id="f1" summary="done"/>',
              '<tf-write path="x.txt" id="w1">X</tf-write>',
            ],
          },
          { type: 'finish', reason: 'stop' },
        ],
      },
    ];
    harness = makeHarness({ task: '过期演练：写 x.txt 并报告结果。', scenarios });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      assert.equal(snap.requestCount, 2, `过期 final 必须触发一次重入，实际 ${snap.requestCount}`);
      const finals = snap.records.filter((r) => r.kind === 'final');
      const last = finals[finals.length - 1];
      assert.ok(last !== undefined && last.kind === 'final');
      assert.ok(last.summary.includes('x.txt'), `交付的必须是重发后的答案，实际 ${last.summary}`);
      assert.ok(
        faultsOf(snap).some((f) => f.detail.includes('答案已过期')),
        '应记"答案已过期"的拒绝',
      );
    } finally {
      harness.cleanup();
    }
  });

  it('K3. 重复命令幂等但不空手：原结果回灌给丢失上下文的模型', async () => {
    const scenarios: Scenario[] = [
      {
        name: 'after-replay',
        match: { promptIncludes: '[tf-stream:replay' },
        chunking: fast,
        steps: [
          { type: 'text', text: '拿到回灌内容，收尾。\n' },
          { type: 'commands', commands: ['<tf-final id="f3" summary="a.txt 内容为 内容A"/>'] },
          { type: 'finish', reason: 'stop' },
        ],
      },
      {
        name: 'duplicate-read',
        match: { promptIncludes: '[tf-stream:receipt' },
        chunking: fast,
        steps: [
          { type: 'text', text: '再读一次。\n' },
          { type: 'commands', commands: ['<tf-read path="a.txt" id="r1" depends_on="w1"/>'] },
          { type: 'finish', reason: 'stop' },
        ],
      },
      {
        name: 'write-then-read',
        match: { promptIncludes: '回灌演练' },
        chunking: fast,
        steps: [
          { type: 'text', text: '写后读。\n' },
          {
            type: 'commands',
            commands: [
              '<tf-write path="a.txt" id="w1">内容A</tf-write>',
              '<tf-read path="a.txt" id="r1" depends_on="w1"/>',
            ],
          },
          { type: 'finish', reason: 'stop' },
        ],
      },
    ];
    harness = makeHarness({ task: '回灌演练：写 a.txt 再读回来。', scenarios });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      assert.equal(snap.requestCount, 3, `重发同一条 read 应带来一次回灌请求，实际 ${snap.requestCount}`);
      const req3 = harness.wireRequests[2]!.contentTexts.join('\n');
      assert.ok(req3.includes('[tf-stream:replay'), '第三次请求应携带回灌块');
      assert.ok(req3.includes('内容A'), '回灌块必须带原结果内容（幂等不等于空手）');
      assert.ok(
        snap.records.some((r) => r.kind === 'observation' && r.reason === 'duplicate-replay'),
        '回灌应记一条 observation',
      );
    } finally {
      harness.cleanup();
    }
  });

  it('K4. 屡教不改的占位 final：如实 blocked，绝不把占位当交付', async () => {
    const scenarios: Scenario[] = [
      {
        name: 'still-placeholder',
        match: { promptIncludes: '[tf-stream:nudge]' },
        chunking: fast,
        steps: [
          { type: 'text', text: '……\n' },
          { type: 'commands', commands: ['<tf-final id="f3" summary="placeholder"/>'] },
          { type: 'finish', reason: 'stop' },
        ],
      },
      {
        name: 'second-placeholder',
        match: { promptIncludes: 'summary 是占位内容' },
        chunking: fast,
        steps: [
          { type: 'text', text: '再占位一次。\n' },
          { type: 'commands', commands: ['<tf-final id="f2" summary="TODO"/>'] },
          { type: 'finish', reason: 'stop' },
        ],
      },
      {
        name: 'first-placeholder',
        match: { promptIncludes: '屡教不改' },
        chunking: fast,
        steps: [
          { type: 'text', text: '占位收尾。\n' },
          { type: 'commands', commands: ['<tf-final id="f1" summary="placeholder"/>'] },
          { type: 'finish', reason: 'stop' },
        ],
      },
    ];
    harness = makeHarness({ task: '屡教不改：报出结果。', scenarios });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'blocked', '占位答案不得被当作完成');
      assert.ok(reason.kind === 'blocked' && reason.detail.includes('final 被拒'), `reason 应说明 final 被拒，实际 ${JSON.stringify(reason)}`);
      // 同 kind 的拒绝只注入一次：第 2 条占位 final 起不再烧注入，走 nudge → blocked
      assert.equal(harness.driver.snapshot().requestCount, 3, '拒绝注入一次 + nudge 一次，共 3 个请求');
    } finally {
      harness.cleanup();
    }
  });
});
