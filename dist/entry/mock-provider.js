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
//   - 只挂测试 preset（test-preset.yml）；生产 preset.yml 不得引用本 entry。

// ---------------------------------------------------------------------------
// 流契约镜像（勿改语义；来源 file:line 见注释）
// ---------------------------------------------------------------------------

/** 镜像 dsh-llm/lib/types/types.d.ts:33-51（本 mock 只用子集） */
                                 
                           
                        
                           
 

/**
 * 镜像 dsh-llm/lib/types/types.d.ts:458-488 的 StreamChunk。
 * mock 只会吐：block-start / text-delta / block-end / usage / finish。
 */
                         
                                                             
                                                       
                                                                               
                                                                           
     
                     
                                                                                              
      

/** 镜像 dsh-llm/lib/types/types.d.ts:538-580 的 GenerateOptions（mock 只读子集） */
                                      
                   
                
                      
                 
                                                        
      
                       
 

// ---------------------------------------------------------------------------
// 剧本 DSL
// ---------------------------------------------------------------------------

/** 五种步骤类型（分派 05 硬性要求 1） */
                          
                                  
                                                           
                                                     
                                                  
                                                                                                 
     
                   
                                                                                      
                                         
                    
                                                                           
                       
                                                                                     
                        
     
                                                       

                           
               
                           
           
                                   
                   
                                     
                            
    
                                                          
                                                          
                                 
 

export class MockScenarioError extends Error {}
export class MockStreamAbortError extends Error {}

const FAIL_MODES = new Set(['midstream_abort', 'timeout', 'malformed_command', 'saturating_output']);

/** 剧本全量校验（fail-fast：任何非法字段立即抛 MockScenarioError，绝不静默修正） */
export function validateScenario(raw         , source        )           {
  const fail = (msg        )        => {
    throw new MockScenarioError(`[mock-provider] 剧本非法（${source}）：${msg}`);
  };
  if (typeof raw !== 'object' || raw === null) fail('顶层必须是对象');
  const s = raw                           ;
  if (typeof s.name !== 'string' || s.name.length === 0) fail('name 必须是非空字符串');
  if (!Array.isArray(s.steps) || s.steps.length === 0) fail('steps 必须是非空数组');
  if (s.chunking !== undefined) {
    if (typeof s.chunking !== 'object' || s.chunking === null) fail('chunking 必须是对象');
    const c = s.chunking                           ;
    if (c.charsPerChunk !== undefined && (typeof c.charsPerChunk !== 'number' || c.charsPerChunk < 0 || !Number.isInteger(c.charsPerChunk)))
      fail('chunking.charsPerChunk 必须是非负整数');
    if (c.delayMs !== undefined && (typeof c.delayMs !== 'number' || c.delayMs < 0)) fail('chunking.delayMs 必须是非负数');
  }
  let hasFinish = false;
  let lastFailTerminal = false; // fail(midstream_abort|timeout|saturating_output) 本身就是流的终止，不强制要求 finish 步骤
  const steps = s.steps.map((step, i) => {
    if (typeof step !== 'object' || step === null) fail(`steps[${i}] 必须是对象`);
    const st = step                           ;
    switch (st.type) {
      case 'text':
        if (typeof st.text !== 'string') fail(`steps[${i}] text.text 必须是字符串`);
        return { type: 'text', text: st.text }         ;
      case 'commands': {
        if (!Array.isArray(st.commands) || st.commands.length === 0) fail(`steps[${i}] commands.commands 必须是非空数组`);
        for (const c of st.commands) if (typeof c !== 'string' || c.length === 0) fail(`steps[${i}].commands 每项必须是非空字符串`);
        return { type: 'commands', commands: [...st.commands] }         ;
      }
      case 'waitTools': {
        if (typeof st.count !== 'number' || !Number.isInteger(st.count) || st.count < 1) fail(`steps[${i}] waitTools.count 必须是正整数`);
        if (st.timeoutMs !== undefined && (typeof st.timeoutMs !== 'number' || st.timeoutMs < 0)) fail(`steps[${i}] waitTools.timeoutMs 必须是非负数`);
        return { type: 'waitTools', count: st.count, timeoutMs: st.timeoutMs }         ;
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
        return { type: 'fail', mode: st.mode, text: st.text, delayMs: st.delayMs, maxChars: st.maxChars }         ;
      }
      case 'finish':
        if (st.reason !== undefined && st.reason !== 'stop' && st.reason !== 'max-tokens') fail(`steps[${i}] finish.reason 只支持 stop|max-tokens`);
        hasFinish = true;
        return { type: 'finish', reason: st.reason ?? 'stop' }         ;
      default:
        fail(`steps[${i}] type 必须是 text|commands|waitTools|fail|finish，实际 ${String(st.type)}`);
    }
  });
  if (!hasFinish && !lastFailTerminal) fail('缺少 finish 步骤（流必须以 finish chunk 终止）');
  const match = s.match                                 ;
  if (match !== undefined) {
    if (typeof match !== 'object' || match === null) fail('match 必须是对象');
    if (match.model !== undefined && typeof match.model !== 'string') fail('match.model 必须是字符串');
    if (match.promptIncludes !== undefined && typeof match.promptIncludes !== 'string') fail('match.promptIncludes 必须是字符串');
    if (match.model === undefined && match.promptIncludes === undefined) fail('match 至少声明 model 或 promptIncludes 之一');
  }
  return { name: s.name          , match, chunking: s.chunking                        , steps };
}

// ---------------------------------------------------------------------------
// MockModel
// ---------------------------------------------------------------------------

                                  
                                 
                                   
                    
                              
                                                               
 

/** 每次 stream 调用的记录（供调用次数断言与 08 号重放比对） */
                                 
              
                
                   
                         
                       
                    
                      
                    
                      
 

                            
                            
                                                                     
                     
                                                                 
                                                     
                                                                    
                                                                                                     
                                                                                  
                       
                 
                   
                                         
       
                                                                     
    
                                                       
                           
                       
                       
                                            
 

const DEFAULT_CHUNKING = { charsPerChunk: 8, delayMs: 20 };

export function createMockModel(config                 )            {
  if (!Array.isArray(config.scenarios) || config.scenarios.length === 0) {
    throw new MockScenarioError('[mock-provider] config.scenarios 不能为空');
  }
  const provider = config.provider ?? 'mock';
  const calls                   = [];
  let toolCompletions = 0;
  let callSeq = 0;

  const model            = {
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

  function selectScenario(options                     )           {
    const prompt = options.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content)
      .map((b) => b.text ?? '')
      .join('\n');
    const matched = config.scenarios.find((s) => {
      if (!s.match) return false;
      if (s.match.model !== undefined && s.match.model !== options.model) return false;
      if (s.match.promptIncludes !== undefined && !prompt.includes(s.match.promptIncludes)) return false;
      return true;
    });
    return matched ?? config.scenarios[0] ; // 无 match 的首个剧本作兜底
  }

  function* chunkify(text        , charsPerChunk        )                    {
    if (charsPerChunk <= 0) {
      yield text;
      return;
    }
    for (let i = 0; i < text.length; i += charsPerChunk) {
      yield text.slice(i, i + charsPerChunk);
    }
  }

  const sleep = (ms        , signal              ) =>
    new Promise                  ((resolve) => {
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

  const waitToolCompletions = (count        , timeoutMs        , signal              ) =>
    new Promise                              ((resolve) => {
      if (toolCompletions >= count) return resolve('ok');
      const timer = setTimeout(done, timeoutMs);
      function settle(v                              ) {
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

  async function* runScenario(options                     )                              {
    const scenario = selectScenario(options);
    const chunking = { ...DEFAULT_CHUNKING, ...config.defaultChunking, ...scenario.chunking };
    const record                 = {
      seq: callSeq++,
      model: options.model,
      scenario: scenario.name,
      chunkTypes: [],
      emittedText: '',
      finished: false,
    };
    calls.push(record);
    const push = (chunk             ) => {
      record.chunkTypes.push(chunk.type);
      if (chunk.type === 'text-delta') record.emittedText += chunk.text;
      return chunk;
    };
    const abortedFinish = ()              => {
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
      const openBlock = function* ()                         {
        if (!opened) {
          opened = true;
          yield push({ type: 'block-start', index: 0, blockType: 'text' });
        }
      };
      const emitText = async function* (text        )                              {
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

  function promptCharsOf(options                     )         {
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
export default function apply(ctx   
         
                                                                    
                                                                        
    
                                 
                                                        
                                                    
 , config                                                        )                        {
  const provider = config?.provider ?? 'mock';
  const scenarios = (config?.scenarios ?? []).map((s, i) => validateScenario(s, `config.scenarios[${i}]`));
  const model = createMockModel({ scenarios, provider });

  const llm = ctx.llm ?? (ctx.get?.('llm')                                                                                      );
  if (!llm || typeof (llm                                 ).registerAdapter !== 'function') {
    console.error('[mock-provider] ctx.llm 不可用或缺少 registerAdapter——entry 挂载失败（fail-fast）');
    return undefined;
  }
  const disposeAdapter = (llm                                                            ).registerAdapter([provider], model.adapter);
  // 设置目录条目仅在有该 API 的宿主上登记（离线桩环境可没有）
  if (typeof (llm                                               ).registerConfigurableProviders === 'function') {
    (llm                                                                        ).registerConfigurableProviders([
      {
        provider,
        displayName: 'Mock Scenario Model',
        settingsNs: ctx.fiber?.entry?.options?.id ?? 'mock-provider',
        settingsPath: [],
      },
    ]);
  }
  (ctx                             ).mockModel = model;
  ctx.effect?.(
    () => () => {
      disposeAdapter?.();
    },
    'mock-provider.registerAdapter()',
  );
  return model;
}
