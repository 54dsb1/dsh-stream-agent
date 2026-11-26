// test/v062-wire.test.ts —— wire 传输面与推理策略（对齐 xuxiang-thinkflow provider.py）
//
// 覆盖：
//   W1 thinkflow 出厂预设为默认传输面（maxRetries=2 / retryBackoffMs=1000 来自对齐层；
//      max_tokens/stream_options/thinking 缺省不发字段——0 = 委托给 provider）；
//   W2 用户随时可覆盖：limits 传输组逐项落到每个请求（maxTokens / streamUsage / thinkingBudget）；
//   W3 thinking 形态：disabled = 不发字段；enabled = thinking + effort 默认 high（xuxiang）；
//   W4 原生工具声明 → tool_choice='auto'（xuxiang：tools 且 enable_native_tools）；
//   W5 推理回传策略两实值都真实生效：drop-stale 剥离 replayState（保留 source 壳——宿主
//      LlmRuntime 硬要求），provider-required 原样携带；
//   W6 建立重试（maxRetries）：同步建连失败在预算内重试，耗尽如实报错；流中途错误不重试。
//
// 断言全部对着**线格式请求**（ports.stream 收到的完整 options），不看驱动器内部字段。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, toWireMessages, normalizeStreamShim } from '../src/entry/loop.ts';
import type {
  DriverPorts,
  RenderMessage,
  StreamChunkLike,
  StreamDriverConfig,
  StreamRequestOptions,
  ToolBatchInputLike,
  ToolBatchResultLike,
} from '../src/entry/loop.ts';
import { THINKFLOW_ALIGNED_LIMITS } from '../src/kernel/limits.ts';

// ---------------------------------------------------------------- 基建

type ChunkGen = AsyncGenerator<StreamChunkLike, void, undefined>;

async function* scriptedStream(chunks: readonly StreamChunkLike[]): ChunkGen {
  for (const chunk of chunks) yield chunk;
}

function textDelta(text: string, index = 1): StreamChunkLike {
  return { type: 'text-delta', index, text } as StreamChunkLike;
}

function finishStop(): StreamChunkLike {
  return { type: 'finish', reason: { kind: 'stop' } } as StreamChunkLike;
}

const FINAL_OK: readonly StreamChunkLike[] = [
  textDelta('收尾。\n'),
  textDelta('<tf-final id="f1" summary="传输面演练完成：约定一致，无未完成项。"/>\n'),
  finishStop(),
];

interface WireHarness {
  driver: SingleStreamDriver;
  /** 每请求收到的完整 options（含传输字段） */
  wire: StreamRequestOptions[];
  warnings: string[];
  cleanup: () => void;
}

function makeWireHarness(
  config: Partial<StreamDriverConfig>,
  options: { streamThrows?: number; toolsService?: unknown } = {},
): WireHarness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v062-'));
  const wire: StreamRequestOptions[] = [];
  const warnings: string[] = [];
  let throwLeft = options.streamThrows ?? 0;
  const ports: DriverPorts = {
    stream: (req) => {
      wire.push({ ...req, messages: [...req.messages] } as StreamRequestOptions);
      if (throwLeft > 0) {
        throwLeft -= 1;
        throw new Error('ECONNREFUSED（探针模拟建连失败）');
      }
      return normalizeStreamShim(scriptedStream(FINAL_OK) as never) as AsyncIterable<StreamChunkLike>;
    },
    executeTools: async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => ({
      results: input.calls.map((call) => ({ callId: call.id, result: { content: [{ type: 'text', text: 'ok' }], isError: false } })),
    }),
    onWarning: (m) => warnings.push(m),
    ...(options.toolsService === undefined ? {} : { toolsService: options.toolsService as never }),
  };
  const driver = new SingleStreamDriver(ports, {
    provider: 'mock',
    model: 'mock-v062',
    requireFinal: true,
    ...config,
  });
  driver.setIdentity('s-v062', 't-v062');
  driver.setAgent({
    id: 'a-v062',
    session: { id: 's-v062', header: { id: 's-v062' }, append: () => ({ seq: 1 }) },
  });
  driver.pushUserTask('传输面演练。');
  return { driver, wire, warnings, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

/** 最小宿主 tools 服务面（schemas 在面内 → nativeTools 声明走 wire.tools）。 */
function fakeToolsService(): { resolve(context: unknown): Promise<unknown>; schemas(): Array<{ name: string; description: string; parameters: Record<string, unknown> }> } {
  return {
    resolve() { return Promise.resolve({ dispose() {}, view() { return new Map(); } }); },
    schemas() {
      return [
        { name: 'read', description: '读文件', parameters: { file_path: { type: 'string', required: true } } },
        { name: 'pwsh', description: '执行命令', parameters: { command: { type: 'string', required: true } } },
      ];
    },
  };
}

// ---------------------------------------------------------------- W1 默认预设

test('W1. thinkflow 出厂预设 = 默认传输面：maxRetries=2/retryBackoffMs=1000，max_tokens/stream_options/thinking 缺省不发', async () => {
  const h = makeWireHarness({});
  try {
    const reason = await h.driver.runTurn();
    assert.equal(reason.kind, 'completed', JSON.stringify(reason));
    assert.equal(h.wire.length, 1);
    const req = h.wire[0]!;
    // 预设数值面（xuxiang 出厂）：重试两项随每个请求给出
    assert.equal(req.maxRetries, THINKFLOW_ALIGNED_LIMITS.maxRetries);
    assert.equal(req.retryBackoffMs, THINKFLOW_ALIGNED_LIMITS.retryBackoffMs);
    assert.equal(THINKFLOW_ALIGNED_LIMITS.maxRetries, 2, 'xuxiang: max_retries=2');
    assert.equal(THINKFLOW_ALIGNED_LIMITS.retryBackoffMs, 1_000, 'xuxiang: retry_backoff_seconds=1');
    // 0 值 = 委托给 provider：三个字段一律不发（xuxiang: max_tokens=null / stream_options_include_usage=false / thinking_budget=0）
    assert.equal('maxTokens' in req, false, 'max_tokens 缺省不进请求');
    assert.equal('streamOptions' in req, false, 'stream_options 缺省不进请求');
    assert.equal('thinking' in req, false, 'thinking 缺省不进请求');
    assert.equal('toolChoice' in req, false, '未声明原生工具不发 tool_choice');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------- W2 用户覆盖

test('W2. 用户随时可覆盖传输设置：limits 传输组逐项落到请求（maxTokens / streamUsage / thinkingBudget）', async () => {
  const h = makeWireHarness({
    limits: { maxTokens: 2048, streamUsage: 1, thinkingBudget: 1024 },
  });
  try {
    await h.driver.runTurn();
    const req = h.wire[0]!;
    assert.equal(req.maxTokens, 2048, 'max_tokens：用户显式输出预算');
    assert.deepEqual(req.streamOptions, { includeUsage: true }, 'stream_options.include_usage：用户开启');
    assert.deepEqual(req.thinking, { mode: 'disabled', budgetTokens: 1024 }, '思考预算 >0 → thinking 字段带预算（形态默认 disabled）');
    assert.equal(req.maxRetries, 2, '未覆盖的键仍取 thinkflow 预设层');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------- W3 thinking 形态

test('W3. thinking 形态：enabled + 未显式 effort → reasoningEffort 默认 high（xuxiang）；disabled+0 预算 → 不发字段', async () => {
  const enabled = makeWireHarness({ thinkingMode: 'enabled' });
  try {
    await enabled.driver.runTurn();
    const req = enabled.wire[0]!;
    assert.deepEqual(req.thinking, { mode: 'enabled' });
    assert.equal(req.reasoningEffort, 'high', 'xuxiang reasoning_effort 默认 high');
    assert.equal('budgetTokens' in (req.thinking ?? {}), false, '预算 0 不带 budgetTokens');
  } finally {
    enabled.cleanup();
  }
  const off = makeWireHarness({});
  try {
    await off.driver.runTurn();
    assert.equal('thinking' in off.wire[0]!, false);
  } finally {
    off.cleanup();
  }
});

// ---------------------------------------------------------------- W4 tool_choice

test('W4. 原生工具声明在面内 → tools + tool_choice="auto"（xuxiang 语义）；无声明 → 不发', async () => {
  const withTools = makeWireHarness({ nativeTools: true }, { toolsService: fakeToolsService() });
  try {
    await withTools.driver.runTurn();
    assert.ok(
      withTools.wire.some((r) => r.toolChoice === 'auto' && Array.isArray(r.tools) && r.tools.length > 0),
      `声明了 schema 的请求必须携带 tools + tool_choice=auto（实际 ${withTools.wire.map((r) => String(r.toolChoice)).join(',')}）`,
    );
  } finally {
    withTools.cleanup();
  }
  const noTools = makeWireHarness({});
  try {
    await noTools.driver.runTurn();
    for (const req of noTools.wire) {
      assert.equal('tools' in req, false);
      assert.equal('toolChoice' in req, false);
    }
  } finally {
    noTools.cleanup();
  }
});

// ---------------------------------------------------------------- W5 推理回传策略

test('W5. reasoning 策略两实值都真实生效：drop-stale 剥离 replayState（source 壳保留）；provider-required 原样', () => {
  const withState = (m: RenderMessage): RenderMessage => ({
    ...m,
    source: { kind: 'model', provider: 'p', model: 'm', replayState: { thread: 't-1' } },
  });
  const messages: RenderMessage[] = [
    { role: 'system', content: 'sys' },
    withState({ role: 'assistant', content: '上一步结论' }),
    { role: 'user', content: '下一步' },
  ];
  // provider-required：原样携带（宿主 provider 会话续传状态按宿主语义回传）
  const kept = toWireMessages(messages, 'provider-required');
  assert.deepEqual((kept[1]!.source as { replayState?: unknown }).replayState, { thread: 't-1' });
  // drop-stale：replayState 剥离，source 壳保留（宿主 LlmRuntime.forAdapter 硬要求 source 存在）
  const dropped = toWireMessages(messages, 'drop-stale');
  assert.equal((dropped[1]!.source as { replayState?: unknown }).replayState, undefined);
  assert.equal(dropped[1]!.source!.provider, 'p');
  assert.equal(dropped[1]!.source!.model, 'm');
  // 无 source 的消息不受策略影响
  assert.equal('source' in dropped[0]!, false);
  // 默认 = provider-required（宿主兼容优先；装配可切 drop-stale 获得完全无状态语义）
  const defaulted = toWireMessages(messages);
  assert.deepEqual((defaulted[1]!.source as { replayState?: unknown }).replayState, { thread: 't-1' });
});

test('W5b. 驱动器装配 config.reasoningStrategy=drop-stale → 线上 assistant 消息不带 replayState', async () => {
  // 回合 1 产生带 model source 的 assistant 历史；回合 2 的请求按策略投影。
  const h = makeWireHarness({ reasoningStrategy: 'drop-stale' });
  try {
    const first = await h.driver.runTurn();
    assert.equal(first.kind, 'completed');
    h.driver.pushUserTask('再来一步。');
    await h.driver.runTurn();
    assert.ok(h.wire.length >= 2);
    for (const req of h.wire) {
      for (const m of req.messages) {
        if (m.source !== undefined) {
          assert.equal('replayState' in m.source, false, 'drop-stale：回放状态不回传');
          assert.equal(m.source.kind, 'model');
        }
      }
    }
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------- W6 建立重试

test('W6. 建连失败在 maxRetries 预算内重试后成功；耗尽如实报错（不静默）', async () => {
  // 预设 maxRetries=2：两次失败后第三次成功
  const retry = makeWireHarness({}, { streamThrows: 2 });
  try {
    const reason = await retry.driver.runTurn();
    assert.equal(reason.kind, 'completed', `预算内重试后完成：${JSON.stringify(reason)}`);
    assert.ok(retry.warnings.some((w) => w.includes('请求建立失败')), '重试过程有可诊断告警');
    assert.equal(retry.wire.length, 3, '每次尝试都计一次 ports.stream 调用');
  } finally {
    retry.cleanup();
  }
  const exhausted = makeWireHarness({ limits: { maxRetries: 1 } }, { streamThrows: 5 });
  try {
    const reason = await exhausted.driver.runTurn();
    // 收场不静默：重试耗尽后回合以 blocked 收场（错误进了告警，不重试到无限）
    assert.notEqual(reason.kind, 'completed', `耗尽后不得假装完成：${JSON.stringify(reason)}`);
    // 重试预算是**每请求**的（xuxiang: max_retries 是 HTTP 请求级语义）：首个请求耗尽
    // 预算 → error finish → requireFinal 收束 nudge 一次 → 第二请求同样耗尽 → blocked。
    // 总调用 = 2 请求 × (1 + 1 重试) = 4，重试不会跨请求累积。
    assert.equal(exhausted.wire.length, 4, '每请求各自耗尽自身预算（首次+1 重试）×2 请求');
    assert.ok(exhausted.warnings.some((w) => w.includes('请求建立失败')), '重试过程有可诊断告警');
  } finally {
    exhausted.cleanup();
  }
});
