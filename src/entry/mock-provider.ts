// entry/mock-provider.ts —— 离线假模型适配器（分派 05）
//
// 按剧本（scenario）吐 StreamChunk 的假模型，注册进 ctx.llm，
// 让 单流协议链路（loop → parser → gate → blob → ledger → 重入）零 API 成本完成 E2E。
//
// 上游契约（全部镜像自 npm @deepseek-ai/dsh@0.2.2-rc.1 的 .d.ts，file:line 见各类型注释）：
//   - 流以 finish chunk 终止；adapter 可抛错，LlmRuntime.stream() 把异常归一为
//     终止 error/aborted finish（types.d.ts:456 注释原文）。
//   - adapter 经 ctx.llm.registerAdapter(providers, adapter) 注册（index.d.ts:262）；
//     registerConfigurableProviders 只登记设置目录条目（index.d.ts:290），
//     真正的流路由走 registerAdapter（dsh-llm-deepseek/lib/index.js:2735 实证）。
//
// 纪律（红线）：
//   - 零运行时依赖：不 import 任何 @deepseek-ai/*（本地插件 bare import 不走宿主解析，
//     见 results/01-micro-spike-results.md §0），也不 import 生产 entry（loop.ts）——
//     mock 只依赖 llm 流契约，谁被测都一样。
//   - fail-fast：剧本非法、waitTools 等不到信号、消费方从不 abort 一律快速抛清晰错误，
//     绝不挂死（红线 5 的反面）。
//   - 只挂测试 preset（patches/test-preset.yml）；生产 preset.yml 不得引用本 entry。

// ---------------------------------------------------------------------------
// 流契约镜像（勿改语义；来源 file:line 见注释）
// ---------------------------------------------------------------------------

/** 镜像 dsh-llm/lib/types/types.d.ts:33-51（本 mock 只用子集） */
export interface LlmFailureLike {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
}

/**
 * 镜像 dsh-llm/lib/types/types.d.ts:458-488 的 StreamChunk。
 * mock 只会吐：block-start / text-delta / block-end / usage / finish。
 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'block-end'; index: number; block: { type: 'text'; text: string } }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | {
      type: 'finish';
      reason: { kind: 'stop' | 'max-tokens' | 'aborted' | 'error' } & Partial<LlmFailureLike>;
    };

/** 镜像 dsh-llm/lib/types/types.d.ts:538-580 的 GenerateOptions（mock 只读子集） */
export interface GenerateOptionsLike {
  provider: string;
  model: string;
  messages: readonly {
    role: string;
    content: readonly { type: string; text?: string }[];
  }[];
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// 剧本 DSL
// ---------------------------------------------------------------------------

/** 五种步骤类型（分派 05 硬性要求 1） */
export type ScenarioStep =
  | { type: 'text'; text: string }
  /** tf-* 协议文本行；渲染为多行文本后逐 chunk 喂出（设计注释："跨多个 chunk 喂出"） */
  | { type: 'commands'; commands: readonly string[] }
  /** 挂起吐流，等 count 个工具完成信号后继续（loop 挂起-重入的直接测试面） */
  | { type: 'waitTools'; count: number; /** 等不到信号即 fail-fast 抛错；缺省 5000ms */ timeoutMs?: number }
  | {
      type: 'fail';
      mode: 'midstream_abort' | 'timeout' | 'malformed_command' | 'saturating_output';
      /** malformed_command：要喂出的畸形协议文本 */
      text?: string;
      /** timeout：挂起时长（ms）；期间消费方 abort 则吐 aborted finish，否则 fail-fast 抛错 */
      delayMs?: number;
      /** saturating_output：累计吐出上限（chars）；到顶吐 max-tokens finish。被 abort 则吐 aborted */
      maxChars?: number;
    }
  | { type: 'finish'; reason?: 'stop' | 'max-tokens' };

export interface Scenario {
  name: string;
  /** 省略 = 兜底剧本；多个匹配取第一个 */
  match?: {
    /** 匹配 GenerateOptions.model */
    model?: string;
    /** 匹配最后一条 user 消息的拼接文本（包含即命中） */
    promptIncludes?: string;
  };
  /** 逐 token 粒度：默认 8 字符/chunk、20ms 间隔；测试置 0 加速（硬性要求 2） */
  chunking?: { charsPerChunk?: number; delayMs?: number };
  steps: readonly ScenarioStep[];
}

export class MockScenarioError extends Error {}
export class MockStreamAbortError extends Error {}

const FAIL_MODES = new Set(['midstream_abort', 'timeout', 'malformed_command', 'saturating_output']);

/** 剧本全量校验（fail-fast：任何非法字段立即抛 MockScenarioError，绝不静默修正） */
export function validateScenario(raw: unknown, source: string): Scenario {
  const fail = (msg: string): never => {
    throw new MockScenarioError(`[mock-provider] 剧本非法（${source}）：${msg}`);
  };
  if (typeof raw !== 'object' || raw === null) fail('顶层必须是对象');
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== 'string' || s.name.length === 0) fail('name 必须是非空字符串');
  if (!Array.isArray(s.steps) || s.steps.length === 0) fail('steps 必须是非空数组');
  if (s.chunking !== undefined) {
    if (typeof s.chunking !== 'object' || s.chunking === null) fail('chunking 必须是对象');
    const c = s.chunking as Record<string, unknown>;
    if (c.charsPerChunk !== undefined && (typeof c.charsPerChunk !== 'number' || c.charsPerChunk < 0 || !Number.isInteger(c.charsPerChunk)))
      fail('chunking.charsPerChunk 必须是非负整数');
    if (c.delayMs !== undefined && (typeof c.delayMs !== 'number' || c.delayMs < 0)) fail('chunking.delayMs 必须是非负数');
  }
  let hasFinish = false;
  let lastFailTerminal = false; // fail(midstream_abort|timeout|saturating_output) 本身就是流的终止，不强制要求 finish 步骤
  const steps = s.steps.map((step, i) => {
    if (typeof step !== 'object' || step === null) fail(`steps[${i}] 必须是对象`);
    const st = step as Record<string, unknown>;
    switch (st.type) {
      case 'text':
        if (typeof st.text !== 'string') fail(`steps[${i}] text.text 必须是字符串`);
        return { type: 'text', text: st.text } as const;
      case 'commands': {
        if (!Array.isArray(st.commands) || st.commands.length === 0) fail(`steps[${i}] commands.commands 必须是非空数组`);
        for (const c of st.commands) if (typeof c !== 'string' || c.length === 0) fail(`steps[${i}].commands 每项必须是非空字符串`);
        return { type: 'commands', commands: [...st.commands] } as const;
      }
      case 'waitTools': {
        if (typeof st.count !== 'number' || !Number.isInteger(st.count) || st.count < 1) fail(`steps[${i}] waitTools.count 必须是正整数`);
        if (st.timeoutMs !== undefined && (typeof st.timeoutMs !== 'number' || st.timeoutMs < 0)) fail(`steps[${i}] waitTools.timeoutMs 必须是非负数`);
        return { type: 'waitTools', count: st.count, timeoutMs: st.timeoutMs } as const;
      }
      case 'fail': {
        if (typeof st.mode !== 'string' || !FAIL_MODES.has(st.mode)) {
          fail(`steps[${i}] fail.mode 必须是 midstream_abort|timeout|malformed_command|saturating_output`);
        }
        if (st.text !== undefined && typeof st.text !== 'string') fail(`steps[${i}] fail.text 必须是字符串`);
        if (st.delayMs !== undefined && (typeof st.delayMs !== 'number' || st.delayMs < 0)) fail(`steps[${i}] fail.delayMs 必须是非负数`);
        if (st.maxChars !== undefined && (typeof st.maxChars !== 'number' || !Number.isInteger(st.maxChars) || st.maxChars < 1))
          fail(`steps[${i}] fail.maxChars 必须是正整数`);
        lastFailTerminal = st.mode === 'midstream_abort' || st.mode === 'timeout' || st.mode === 'saturating_output';
        return { type: 'fail', mode: st.mode, text: st.text, delayMs: st.delayMs, maxChars: st.maxChars } as const;
      }
      case 'finish':
        if (st.reason !== undefined && st.reason !== 'stop' && st.reason !== 'max-tokens') fail(`steps[${i}] finish.reason 只支持 stop|max-tokens`);
        hasFinish = true;
        return { type: 'finish', reason: st.reason ?? 'stop' } as const;
      default:
        fail(`steps[${i}] type 必须是 text|commands|waitTools|fail|finish，实际 ${String(st.type)}`);
    }
  });
  if (!hasFinish && !lastFailTerminal) fail('缺少 finish 步骤（流必须以 finish chunk 终止）');
  const match = s.match as Scenario['match'] | undefined;
  if (match !== undefined) {
    if (typeof match !== 'object' || match === null) fail('match 必须是对象');
    if (match.model !== undefined && typeof match.model !== 'string') fail('match.model 必须是字符串');
    if (match.promptIncludes !== undefined && typeof match.promptIncludes !== 'string') fail('match.promptIncludes 必须是字符串');
    if (match.model === undefined && match.promptIncludes === undefined) fail('match 至少声明 model 或 promptIncludes 之一');
  }
  return { name: s.name as string, match, chunking: s.chunking as Scenario['chunking'], steps };
}

// ---------------------------------------------------------------------------
// MockModel
// ---------------------------------------------------------------------------

export interface MockModelConfig {
  scenarios: readonly Scenario[];
  /** 注册的 provider 路由（缺省 'mock'） */
  provider?: string;
  /** 剧本未声明 chunking 时的缺省粒度 */
  defaultChunking?: { charsPerChunk: number; delayMs: number };
}

/** 每次 stream 调用的记录（供调用次数断言与 08 号重放比对） */
export interface MockCallRecord {
  seq: number;
  model: string;
  scenario: string;
  /** 喂出的全部 chunk 类型序列 */
  chunkTypes: string[];
  /** 喂出的全部文本增量拼接 */
  emittedText: string;
  finished: boolean;
  finishKind?: string;
}

export interface MockModel {
  readonly provider: string;
  /** 传给 ctx.llm.registerAdapter 的适配器对象（duck-type LlmAdapter 所需子集） */
  readonly adapter: {
    providerInfo(provider: string): { id: string; name: string };
    providerRetryPolicy(provider: string): undefined;
    imageRequestPricing(provider: string, model: string): undefined;
    listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<{
      provider: string;
      id: string;
      name: string;
      context: { contextWindow: number };
    }>;
    stream(options: GenerateOptionsLike): AsyncIterable<StreamChunk>;
  };
  /** 工具完成信号源：loop 每完成一个工具调用一次（waitTools 挂起-重入的回灌通道） */
  notifyToolResult(): void;
  resetSignals(): void;
  /** 已发起的模型调用（含进行中） */
  readonly calls: readonly MockCallRecord[];
}

const DEFAULT_CHUNKING = { charsPerChunk: 8, delayMs: 20 };

export function createMockModel(config: MockModelConfig): MockModel {
  if (!Array.isArray(config.scenarios) || config.scenarios.length === 0) {
    throw new MockScenarioError('[mock-provider] config.scenarios 不能为空');
  }
  const provider = config.provider ?? 'mock';
  const calls: MockCallRecord[] = [];
  let toolCompletions = 0;
  let callSeq = 0;

  const model: MockModel = {
    provider,
    calls,
    notifyToolResult() {
      toolCompletions += 1;
    },
    resetSignals() {
      toolCompletions = 0;
    },
    adapter: {
      providerInfo(p) {
        return { id: p, name: 'Mock Scenario Model' };
      },
      providerRetryPolicy() {
        return undefined;
      },
      imageRequestPricing() {
        return undefined;
      },
      async listModels() {
        return config.scenarios.map((s) => ({ provider, id: s.name, name: `mock:${s.name}` }));
      },
      async resolveModel(_p, id) {
        return { provider, id, name: `mock:${id}`, context: { contextWindow: 131072 } };
      },
      stream(options) {
        return runScenario(options);
      },
    },
  };

  function selectScenario(options: GenerateOptionsLike): Scenario {
    const prompt = options.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content)
      .map((b) => b.text ?? '')
      .join('\n');
    // v0.4.1：按 marker 在提示中的**最后出现位置**选剧本（等价于"响应最新注入"）。
    // 0.4.0 取首个匹配；历史观测转正进追加区后旧 marker 会留在历史里，首匹配会让同一个
    // 剧本无限重演（0.3.2 的 G1/D1 假失败就是这么来的）。
    let best: (typeof config.scenarios)[number] | undefined;
    let bestAt = -1;
    for (const s of config.scenarios) {
      if (!s.match) continue;
      if (s.match.model !== undefined && s.match.model !== options.model) continue;
      const at = s.match.promptIncludes === undefined ? 0 : prompt.lastIndexOf(s.match.promptIncludes);
      if (s.match.promptIncludes !== undefined && at === -1) continue;
      if (at > bestAt) {
        bestAt = at;
        best = s;
      }
    }
    return best ?? config.scenarios[0]!; // 无 match 的首个剧本作兜底
  }

  function* chunkify(text: string, charsPerChunk: number): Generator<string> {
    if (charsPerChunk <= 0) {
      yield text;
      return;
    }
    for (let i = 0; i < text.length; i += charsPerChunk) {
      yield text.slice(i, i + charsPerChunk);
    }
  }

  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<'ok' | 'aborted'>((resolve) => {
      if (ms <= 0) return resolve(signal?.aborted ? 'aborted' : 'ok');
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(signal?.aborted ? 'aborted' : 'ok');
      }
      function onAbort() {
        done();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  const waitToolCompletions = (count: number, timeoutMs: number, signal?: AbortSignal) =>
    new Promise<'ok' | 'timeout' | 'aborted'>((resolve) => {
      if (toolCompletions >= count) return resolve('ok');
      const timer = setTimeout(done, timeoutMs);
      function settle(v: 'ok' | 'timeout' | 'aborted') {
        clearInterval(poll);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      }
      function done() {
        settle('timeout');
      }
      function onAbort() {
        settle('aborted');
      }
      // 轮询信号计数（notifyToolResult 是同步计数器，无需事件系统）
      const poll = setInterval(() => {
        if (toolCompletions >= count) settle('ok');
      }, 1);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  async function* runScenario(options: GenerateOptionsLike): AsyncGenerator<StreamChunk> {
    const scenario = selectScenario(options);
    const chunking = { ...DEFAULT_CHUNKING, ...config.defaultChunking, ...scenario.chunking };
    const record: MockCallRecord = {
      seq: callSeq++,
      model: options.model,
      scenario: scenario.name,
      chunkTypes: [],
      emittedText: '',
      finished: false,
    };
    calls.push(record);
    const push = (chunk: StreamChunk) => {
      record.chunkTypes.push(chunk.type);
      if (chunk.type === 'text-delta') record.emittedText += chunk.text;
      return chunk;
    };
    const abortedFinish = (): StreamChunk => {
      record.finished = true;
      record.finishKind = 'aborted';
      return {
        type: 'finish',
        reason: { kind: 'aborted', message: 'mock scenario aborted by consumer signal', code: 'MOCK_ABORTED' },
      };
    };

    try {
      let opened = false; // text block 只开一次，全程 index=0
      let fullText = '';
      const openBlock = function* (): Generator<StreamChunk> {
        if (!opened) {
          opened = true;
          yield push({ type: 'block-start', index: 0, blockType: 'text' });
        }
      };
      const emitText = async function* (text: string): AsyncGenerator<StreamChunk> {
        yield* openBlock();
        for (const piece of chunkify(text, chunking.charsPerChunk)) {
          if (options.signal?.aborted) {
            yield abortedFinish();
            return;
          }
          const idle = await sleep(chunking.delayMs, options.signal);
          if (idle === 'aborted') {
            yield abortedFinish();
            return;
          }
          fullText += piece;
          yield push({ type: 'text-delta', index: 0, text: piece });
        }
      };

      for (const step of scenario.steps) {
        switch (step.type) {
          case 'text': {
            yield* emitText(step.text);
            if (record.finished) return;
            break;
          }
          case 'commands': {
            yield* emitText(`${step.commands.join('\n')}\n`);
            if (record.finished) return;
            break;
          }
          case 'waitTools': {
            const v = await waitToolCompletions(step.count, step.timeoutMs ?? 5000, options.signal);
            if (v === 'aborted') {
              yield abortedFinish();
              return;
            }
            if (v === 'timeout') {
              // fail-fast：等不到回灌信号绝不挂死
              const msg = `[mock-provider] waitTools(${step.count}) 超时：剧本 "${scenario.name}" 等待 ${step.timeoutMs ?? 5000}ms 内未收到工具完成信号`;
              record.finished = true;
              record.finishKind = 'error';
              yield { type: 'finish', reason: { kind: 'error', message: msg, code: 'MOCK_WAITTOOLS_TIMEOUT' } };
              return;
            }
            break;
          }
          case 'fail': {
            switch (step.mode) {
              case 'midstream_abort': {
                // 适配器抛错 → 上层（LlmRuntime / 测试 shim）归一为终止 error finish
                throw new MockStreamAbortError(`[mock-provider] 剧本 "${scenario.name}" 注入 midstream_abort`);
              }
              case 'timeout': {
                const v = await sleep(step.delayMs ?? 30000, options.signal);
                if (v === 'aborted') {
                  yield abortedFinish();
                  return;
                }
                // fail-fast：消费方从不 abort → 快速抛错而非无限挂起
                throw new MockScenarioError(
                  `[mock-provider] 剧本 "${scenario.name}" timeout 注入未被消费方 abort（delayMs=${step.delayMs ?? 30000} 已耗尽）——消费方缺少超时处理路径`,
                );
              }
              case 'malformed_command': {
                yield* emitText(step.text ?? 'tf-frobnicate x\n');
                if (record.finished) return;
                break;
              }
              case 'saturating_output': {
                yield* openBlock();
                const maxChars = step.maxChars ?? 4_000_000;
                const filler = 'x'.repeat(Math.max(chunking.charsPerChunk, 64));
                let sent = 0;
                while (sent < maxChars) {
                  if (options.signal?.aborted) {
                    yield abortedFinish();
                    return;
                  }
                  const idle = await sleep(chunking.delayMs, options.signal);
                  if (idle === 'aborted') {
                    yield abortedFinish();
                    return;
                  }
                  const piece = filler.slice(0, Math.min(filler.length, maxChars - sent));
                  fullText += piece;
                  sent += piece.length;
                  yield push({ type: 'text-delta', index: 0, text: piece });
                }
                record.finished = true;
                record.finishKind = 'max-tokens';
                yield { type: 'finish', reason: { kind: 'max-tokens' } };
                return;
              }
            }
            break;
          }
          case 'finish': {
            yield push({ type: 'block-end', index: 0, block: { type: 'text', text: fullText } });
            yield push({ type: 'usage', usage: { inputTokens: Math.ceil(promptCharsOf(options) / 4), outputTokens: Math.ceil(fullText.length / 4) } });
            record.finished = true;
            record.finishKind = step.reason ?? 'stop';
            yield push({ type: 'finish', reason: { kind: step.reason ?? 'stop' } });
            return;
          }
        }
      }
      // 剧本走完没有触发 finish 步骤（validateScenario 保证存在 finish，防御性兜底）
      throw new MockScenarioError(`[mock-provider] 剧本 "${scenario.name}" 步骤耗尽仍未 finish（校验漏洞，请报告）`);
    } catch (error) {
      // fail-open 开关（红线 5 反面）：mock 自身异常快速失败，绝不挂死。
      // 已发过 finish 后不再重复发。
      if (!record.finished) {
        record.finished = true;
        record.finishKind = 'error';
        const message = error instanceof Error ? error.message : String(error);
        yield { type: 'finish', reason: { kind: 'error', message, code: 'MOCK_ADAPTER_THROWN' } };
      }
      throw error;
    } finally {
      // 宿主提前退出迭代（消费方 break/return）也如实记录
      if (!record.finished) {
        record.finished = true;
        record.finishKind = 'consumer-early-exit';
      }
    }
  }

  function promptCharsOf(options: GenerateOptionsLike): number {
    return options.messages.reduce((n, m) => n + m.content.reduce((k, b) => k + (b.text?.length ?? 0), 0), 0);
  }

  return model;
}

// ---------------------------------------------------------------------------
// Cordis entry（只挂测试 preset）
// ---------------------------------------------------------------------------

/**
 * 函数插件入口。挂载后：
 *   1. ctx.llm.registerAdapter(['mock'], adapter) —— 流路由；
 *   2. ctx.llm.registerConfigurableProviders([...]) —— 设置目录条目（F10，deepseek-account:136 同款）；
 *   3. ctx.mockModel = model —— 06/07 号 loop 的工具完成信号源（notifyToolResult）。
 *
 * config: { scenarios?: Scenario[]（或 JSON 数组）, provider?: string }
 * 剧本文件放 test/scenarios/*.json，代码与数据分离（红线）。
 */
export default function apply(ctx: {
  llm?: {
    registerAdapter(providers: string[], adapter: unknown): unknown;
    registerConfigurableProviders(entries: readonly unknown[]): unknown;
  };
  get?(service: string): unknown;
  effect?(fn: () => () => void, name?: string): unknown;
  fiber?: { entry?: { options?: { id?: string } } };
}, config?: { scenarios?: readonly unknown[]; provider?: string }): MockModel | undefined {
  const provider = config?.provider ?? 'mock';
  const scenarios = (config?.scenarios ?? []).map((s, i) => validateScenario(s, `config.scenarios[${i}]`));
  const model = createMockModel({ scenarios, provider });

  const llm = ctx.llm ?? (ctx.get?.('llm') as { registerAdapter?: unknown; registerConfigurableProviders?: unknown } | undefined);
  if (!llm || typeof (llm as { registerAdapter?: unknown }).registerAdapter !== 'function') {
    console.error('[mock-provider] ctx.llm 不可用或缺少 registerAdapter——entry 挂载失败（fail-fast）');
    return undefined;
  }
  const disposeAdapter = (llm as { registerAdapter(p: string[], a: unknown): () => void }).registerAdapter([provider], model.adapter);
  // 设置目录条目仅在有该 API 的宿主上登记（离线桩环境可没有）
  if (typeof (llm as { registerConfigurableProviders?: unknown }).registerConfigurableProviders === 'function') {
    (llm as { registerConfigurableProviders(e: readonly unknown[]): () => void }).registerConfigurableProviders([
      {
        provider,
        displayName: 'Mock Scenario Model',
        settingsNs: ctx.fiber?.entry?.options?.id ?? 'mock-provider',
        settingsPath: [],
      },
    ]);
  }
  (ctx as { mockModel?: MockModel }).mockModel = model;
  ctx.effect?.(
    () => () => {
      disposeAdapter?.();
    },
    'mock-provider.registerAdapter()',
  );
  return model;
}
