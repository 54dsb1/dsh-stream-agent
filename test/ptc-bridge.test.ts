// test/ptc-bridge.test.ts —— tf-code 程序化通道（PTC 桥接，0.2.0）
//
// 覆盖：
//   - parser：tf-code 命令（body = 程序体、timeout/description 属性）解析
//   - obs：tf-code → code 族（高增益：首个/变化结果注骨架；失败一律 high）
//   - ptc-bridge 适配器：resolve/run duck-type 装配、bindings 透传 executeTools、
//     错误 kind 映射、logs 展平、run() reject → 结构化失败
//   - 驱动器 E2E：tf-code 成功 → 句柄化 + 骨架注入；失败 → 结构化错误改道；
//     无 executeCode 端口 → no-code-channel 命令级失败；协议文本按通道可用性声明

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, normalizeStreamShim } from '../src/entry/loop.ts';
import type { DriverPorts, StreamRequestOptions, ToolBatchInputLike, ToolBatchResultLike, StreamDriverConfig } from '../src/entry/loop.ts';
import { createMockModel } from '../src/entry/mock-provider.ts';
import type { MockModel, Scenario } from '../src/entry/mock-provider.ts';
import { TfStreamParser } from '../src/kernel/parser.ts';
import { classifyTool, ObservationLedger } from '../src/kernel/obs.ts';
import { createCodeExecutor, looksLikePtcRuntime } from '../src/entry/ptc-bridge.ts';
import type { PtcRuntimeLike } from '../src/entry/ptc-bridge.ts';

// ---------------------------------------------------------------------------
// 测试设施
// ---------------------------------------------------------------------------

function createSandboxExecutor(sandboxDir: string) {
  return async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => {
    const results: ToolBatchResultLike['results'] = [];
    for (const call of input.calls) {
      const args = JSON.parse(call.arguments) as Record<string, unknown>;
      results.push({ callId: call.id, result: { content: [{ type: 'text', text: `${call.name}:${JSON.stringify(args)}` }], isError: false } });
    }
    return { results, additionalContexts: [], concluded: false };
  };
}

interface Harness {
  driver: SingleStreamDriver;
  model: MockModel;
  wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }>;
  cleanup: () => void;
}

function makeHarness(opts: {
  task: string;
  scenarios: Scenario[];
  executeCode?: DriverPorts['executeCode'];
  config?: Partial<StreamDriverConfig>;
}): Harness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-ptc-'));
  const model = createMockModel({ scenarios: opts.scenarios, provider: 'mock' });
  const wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }> = [];
  const ports: DriverPorts = {
    stream: (options) => {
      wireRequests.push({ ...options, contentTexts: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')) });
      return normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal }));
    },
    executeTools: createSandboxExecutor(sandboxDir),
    ...(opts.executeCode === undefined ? {} : { executeCode: opts.executeCode }),
    onToolSettled: () => model.notifyToolResult(),
  };
  const config: StreamDriverConfig = { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000, ...opts.config };
  const driver = new SingleStreamDriver(ports, config);
  driver.pushUserTask(opts.task);
  return { driver, model, wireRequests, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

function lastReasonOf(driver: SingleStreamDriver): string {
  const ends = driver.snapshot().records.filter((r) => r.kind === 'turn-end');
  const last = ends[ends.length - 1];
  assert.ok(last !== undefined && last.kind === 'turn-end', '必须有 turn-end 记录');
  return last.reason.kind;
}

// ---------------------------------------------------------------------------

describe('tf-code：parser 与 obs 内核层', () => {
  it('P1. parser：tf-code 带 body 与 timeout/description 属性，闭合即派发事件', () => {
    const parser = new TfStreamParser();
    const events = parser.feed('<tf-code id="c1" timeout="60000" description="统计">return { n: 1 }</tf-code>');
    const cmdEvent = events.find((e) => e.type === 'command');
    assert.ok(cmdEvent !== undefined && cmdEvent.type === 'command', 'tf-code 应正常闭合');
    const cmd = cmdEvent.command;
    assert.equal(cmd.name, 'tf-code');
    assert.equal(cmd.id, 'c1');
    assert.equal(cmd.body, 'return { n: 1 }');
    assert.equal(cmd.attrs['timeout'], '60000');
    assert.equal(cmd.attrs['description'], '统计');
  });

  it('P2. obs：tf-code → code 族，首个观测 high（注骨架），重复内容 none，失败一律 high', () => {
    assert.equal(classifyTool('tf-code'), 'code');
    const obs = new ObservationLedger();
    const first = obs.observe({ tool: 'tf-code', ok: true, key: 'code:统计', content: '{"n":1}', callId: 'c1' });
    assert.equal(first.info_gain, 'high', '首个 code 观测应 high');
    assert.ok(first.handle.startsWith('obs:code:c1@v'), `句柄族应为 code：${first.handle}`);
    const dup = obs.observe({ tool: 'tf-code', ok: true, key: 'code:统计', content: '{"n":1}', callId: 'c2' });
    assert.equal(dup.info_gain, 'none', '重复内容应 none');
    const fail = obs.observe({ tool: 'tf-code', ok: false, key: 'code:统计', content: 'exception: boom', callId: 'c3' });
    assert.equal(fail.info_gain, 'high', '失败一律 high');
  });
});

describe('tf-code：ptc-bridge 适配器', () => {
  const baseDeps = () => ({
    executeTools: async (input: { calls: readonly { type: 'tool-call'; id: string; name: string; arguments: string }[] }) => ({
      results: input.calls.map((c) => ({ callId: c.id, result: { content: [{ type: 'text', text: `${c.name}:ok(${c.arguments})` }], isError: false } })),
    }),
  });

  it('B1. 形状校验：resolve+run 在位才算 PtcRuntime', () => {
    assert.equal(looksLikePtcRuntime({ resolve: () => ({}), run: async () => ({}) }), true);
    assert.equal(looksLikePtcRuntime({ run: async () => ({}) }), false);
    assert.equal(looksLikePtcRuntime(undefined), false);
    assert.equal(looksLikePtcRuntime('ptc'), false);
  });

  it('B2. 成功路径：程序进 resolve.request.program；bindings 三件套；value 无损 JSON 出', async () => {
    const captured: Array<{ program: string; bindings: Array<{ global: string; functions: Record<string, (args: unknown) => Promise<unknown>> }> }> = [];
    const runtime: PtcRuntimeLike = {
      language: 'typescript',
      resolve(request: { program: string; bindings?: unknown[] }) {
        captured.push(request as never);
        return { spec: true };
      },
      async run() {
        return { value: { total: 10, hits: ['a'] }, logs: ['line1', 'line2'] };
      },
    };
    const executeCode = createCodeExecutor(runtime, baseDeps());
    const outcome = await executeCode({ callId: 'c1', code: 'return 1', signal: new AbortController().signal });
    assert.ok(outcome.ok);
    assert.equal(outcome.valueJson, '{"total":10,"hits":["a"]}');
    assert.equal(outcome.logs, 'line1\nline2');
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.program, 'return 1');
    const ns = captured[0]!.bindings[0]!;
    assert.equal(ns.global, 'tools');
    assert.deepEqual(Object.keys(ns.functions).sort(), ['pwsh', 'read', 'write']);
  });

  it('B3. bindings 走 executeTools；isError → 抛（对齐 ToolCallError 语义）', async () => {
    let lastInput: { calls: readonly { name: string; arguments: string }[] } | undefined;
    const runtime: PtcRuntimeLike = {
      resolve(request: { program: string; bindings?: Array<{ global: string; functions: Record<string, (args: unknown) => Promise<unknown>> }> }) {
        void runtime;
        return { request };
      },
      async run(spec) {
        const request = (spec as { request: { bindings: Array<{ global: string; functions: Record<string, (args: unknown) => Promise<unknown>> }> } }).request;
        lastInput = undefined;
        const written = await request.bindings[0]!.functions.write({ file_path: 'a.txt', content: 'hi' });
        assert.equal(written, 'write:ok({"file_path":"a.txt","content":"hi"})');
        try {
          await request.bindings[0]!.functions.pwsh({ command: 'boom' });
          assert.fail('isError 绑定必须抛');
        } catch (error) {
          assert.ok(error instanceof Error && error.message.includes('pwsh:failed'), `应抛宿主错误文本：${String(error)}`);
        }
        return { value: 'done' };
      },
    };
    const executeCode = createCodeExecutor(runtime, {
      executeTools: async (input) => {
        lastInput = input as never;
        const args = JSON.parse(input.calls[0]!.arguments) as Record<string, unknown>;
        const isFailure = input.calls[0]!.name === 'pwsh';
        return {
          results: input.calls.map((c) => ({ callId: c.id, result: { content: [{ type: 'text', text: isFailure ? `${c.name}:failed:denied` : `${c.name}:ok(${input.calls[0]!.arguments})` }], isError: isFailure } })),
        };
      },
    });
    const outcome = await executeCode({ callId: 'c9', code: 'x', signal: new AbortController().signal, agent: { id: 'agent-1' } });
    assert.ok(outcome.ok);
    assert.equal(outcome.valueJson, '"done"');
    assert.ok(lastInput !== undefined);
  });

  it('B4. 失败路径：result.error.kind 进 error 诊断；run() reject → ptc-runtime-misuse；logs 缺省 undefined', async () => {
    const failing: PtcRuntimeLike = {
      resolve: () => ({}),
      async run() {
        return { error: { kind: 'timeout', message: 'exceeded 120000ms' }, logs: { stdout: ['x'], stderr: [] } };
      },
    };
    const executeCode = createCodeExecutor(failing, baseDeps());
    const outcome = await executeCode({ callId: 'c1', code: 'x', signal: new AbortController().signal });
    assert.ok(!outcome.ok);
    assert.equal(outcome.error, 'timeout: exceeded 120000ms');
    assert.equal(outcome.logs, '{"stdout":["x"],"stderr":[]}');

    const misusing: PtcRuntimeLike = {
      resolve: () => ({}),
      async run() {
        throw new Error('disposed');
      },
    };
    const outcome2 = await createCodeExecutor(misusing, baseDeps())({ callId: 'c2', code: 'x', signal: new AbortController().signal });
    assert.ok(!outcome2.ok);
    assert.ok(outcome2.error.startsWith('ptc-runtime-misuse: disposed'));
    assert.equal(outcome2.logs, undefined);
  });
});

describe('tf-code：驱动器 E2E', () => {
  let harness: Harness | undefined;
  beforeEach(() => {
    harness?.cleanup();
    harness = undefined;
  });

  const codeScenario: Scenario = {
    name: 'code-basic',
    match: { promptIncludes: 'code 演练' },
    chunking: { charsPerChunk: 0, delayMs: 0 },
    steps: [
      { type: 'text', text: '用程序统计。\n' },
      { type: 'commands', commands: ['<tf-code id="c1" description="统计 ERROR">return { errorCount: 42 }</tf-code>', '<tf-final id="f1" summary="done"/>'] },
      { type: 'waitTools', count: 1, timeoutMs: 5000 },
      { type: 'finish', reason: 'stop' },
    ],
  };

  it('E1. 成功：命令 ok + code 族句柄 + 骨架注入下一请求；协议文本声明 tf-code', async () => {
    harness = makeHarness({
      task: 'code 演练：统计日志错误。',
      scenarios: [codeScenario],
      executeCode: async () => ({ ok: true, valueJson: '{"errorCount":42}' }),
    });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      const c1 = snap.records.find((r) => r.kind === 'command' && r.id === 'c1' && r.status === 'ok');
      assert.ok(c1 !== undefined, 'tf-code 应 ok');
      const observation = snap.records.find((r) => r.kind === 'observation' && r.handle !== null && r.handle.startsWith('obs:code:c1@v'));
      assert.ok(observation !== undefined, '应有 obs:code 句柄');
      // 通道启用 → 协议文本声明 tf-code（进请求 1 的 system 消息）
      assert.ok(harness.wireRequests[0]!.contentTexts[0]!.includes('tf-code 程序化工具调用'), '协议应声明 tf-code');
      // 高增益骨架注入下一请求
      const req2 = harness.wireRequests[1]!;
      assert.ok(
        req2.contentTexts.some((t) => t.includes('[tf-stream:observation handle=obs:code:c1@v')),
        '请求 2 应注入 code 观测骨架',
      );
    } finally {
      harness.cleanup();
    }
  });

  it('E2. 程序失败：结构化错误注入（kind + 建议改道），模型重发后收敛', async () => {
    let calls = 0;
    harness = makeHarness({
      task: 'code 演练：统计日志错误。',
      scenarios: [
        {
          name: 'code-retry',
          match: { promptIncludes: 'tf-stream:error id=c1' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '修复后重发。\n' },
            { type: 'commands', commands: ['<tf-code id="c2" description="统计 ERROR 修复版">return { errorCount: 42 }</tf-code>', '<tf-final id="f2" summary="done"/>'] },
            { type: 'waitTools', count: 1, timeoutMs: 5000 },
            { type: 'finish', reason: 'stop' },
          ],
        },
        codeScenario,
      ],
      executeCode: async (input) => {
        calls += 1;
        if (input.callId === 'c1') return { ok: false, error: 'exception: TypeError: x is not a function' };
        return { ok: true, valueJson: '{"errorCount":42}' };
      },
    });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      assert.equal(calls, 2, '失败一次 + 修复重发一次');
      const req2 = harness.wireRequests[1]!;
      const errBlock = req2.contentTexts.find((t) => t.includes('[tf-stream:error id=c1 cmd=tf-code]'));
      assert.ok(errBlock !== undefined, `应注入结构化错误：\n${req2.contentTexts.join('\n---\n').slice(0, 1500)}`);
      assert.ok(errBlock.includes('exception: TypeError'), '错误块应含 kind 与诊断');
      assert.ok(errBlock.includes('建议：'), '错误块应含改道建议');
    } finally {
      harness.cleanup();
    }
  });

  it('E3. 无 executeCode 端口 → no-code-channel 命令级失败；协议文本不声明 tf-code', async () => {
    harness = makeHarness({
      task: 'code 演练：统计日志错误。',
      scenarios: [
        {
          name: 'code-fallback',
          match: { promptIncludes: 'tf-stream:error id=c1' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '通道缺失，改道收尾。\n' },
            { type: 'commands', commands: ['<tf-final id="f2" summary="改道完成"/>'] },
            { type: 'finish', reason: 'stop' },
          ],
        },
        codeScenario,
      ],
      // 不提供 executeCode
    });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      assert.ok(!harness.wireRequests[0]!.contentTexts[0]!.includes('tf-code 程序化工具调用'), '通道关闭时协议不得声明 tf-code');
      const req2 = harness.wireRequests[1]!;
      const errBlock = req2.contentTexts.find((t) => t.includes('[tf-stream:error id=c1 cmd=tf-code]'));
      assert.ok(errBlock !== undefined && errBlock.includes('no-code-channel'), '应注入通道缺失错误');
      assert.ok(errBlock.includes('ptcRuntime'), '错误应指明缺失的服务缝');
    } finally {
      harness.cleanup();
    }
  });

  it('E4. enableCode=false → 强制关闭（端口在位也不声明、命令级失败）', async () => {
    harness = makeHarness({
      task: 'code 演练：统计日志错误。',
      scenarios: [
        {
          name: 'code-off',
          match: { promptIncludes: 'tf-stream:error id=c1' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '通道被配置关闭。\n' },
            { type: 'commands', commands: ['<tf-final id="f2" summary="off"/>'] },
            { type: 'finish', reason: 'stop' },
          ],
        },
        codeScenario,
      ],
      executeCode: async () => ({ ok: true, valueJson: '{}' }),
      config: { enableCode: false },
    });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      assert.ok(!harness.wireRequests[0]!.contentTexts[0]!.includes('tf-code 程序化工具调用'), '配置关闭时协议不得声明 tf-code');
      const errBlock = harness.wireRequests[1]!.contentTexts.find((t) => t.includes('no-code-channel'));
      assert.ok(errBlock !== undefined, '配置关闭应命令级失败');
    } finally {
      harness.cleanup();
    }
  });
});
