// entry/obs-broker.ts —— 观测过滤（M2 适配，分派 07）
//
// 挂点（06 号 loop 完整接管装配后的实际形态，任务书"以 06 的实际形态为准"）：
//   1. tools/post-execute waterfall（工具结果出口，dsh-tools/lib/types/events.d.ts:40）：
//      结果全文 → 共享 BlobSink（ctx.state，接 DSH storage）落盘 → kernel/obs 登记（audit）。
//      失败结果原样放行且 info_gain=high（内核 classify：ok=false 一律 high，模型必须看到失败）；
//      结果内容绝不改写（decision 走 next() 原样 accept——驱动器 tf-peek 依赖原文，改写会毁 O2）。
//   2. llm/stream waterfall（F4，dsh-llm/lib/types/index.d.ts:45）：逐请求泄漏扫描——
//      已登记 blob 全文若原样出现在任一请求消息（含骨架单行不算，须全文逐字节包含），
//      记 leak 台账（证据流，不阻断——阻断属"只记账不改流"的反面，且会误伤非本插件装配的请求）；
//      并逐请求落指标（08 号 METRICS.md 口径：produced/injected/peeked/injectedRatio）。
//   3. fail-open（红线 5）：任一挂点自身异常 → 全量放行 + ledger 记 broker_error，绝不静默。
//
// 注入决策（O1 三档 / O2 peek / O3 差分 / 饥饿升格）由 06 驱动器经其内核 ObservationLedger
// 落实（loop.ts #executeCommand → observe / #buildInjections）；本 entry 的 ledger 是
// ToolsService 通道的全量旁证口径（含驱动器映射命令与原生 tool_call，供 08 号对账）。

import { ObservationLedger } from '../kernel/obs.js';
                                                                    
import { makeWarn, EntryLedger, contentTextOf, wireMessageText } from './adapter-kit.js';
                                                    
import { asPluginEffect } from './cordis-compat.js';

/** 镜像 dsh-tools/lib/types/contracts.d.ts:163-191 ToolExecution（读子集） */
                        
                 
               
                      
 
/** 镜像 contracts.d.ts:289-311 ToolExecutionResult（读子集） */
                          
                   
                   
 
/** 镜像 events.d.ts:40 tools/post-execute 监听器面 */
                                                                                                                                    
/** 镜像 dsh-llm/lib/types/index.d.ts:45 llm/stream waterfall 监听器面 */
                                                                                                                                                                  
/** 镜像 state-handle.ts 提供的 StateService（duck-type，只读 sink） */
                            
                      
                   
 

                                  
                                                 
                               
                                         
                        
                                                  
                                    
                                                    
                     
 

                                  
                            
                      
                                                                                            
                      
 

/** 内核 obs 的 BlobSink 面（put(ref, string)）→ state BlobSink 面（write(key, bytes)）桥接 */
function obsSinkBridge(inner               )                                                                                        {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    put(ref, content) {
      inner.write(ref, encoder.encode(content));
    },
    readRaw(ref) {
      const data = inner.read(ref);
      return data === undefined ? undefined : decoder.decode(data);
    },
  };
}

/** 观测 key：稳定目标优先（同文件重复读被内核识别为 none），退化到 工具:callId。 */
function observationKeyOf(exec              )         {
  const args = (exec.arguments ?? {})                           ;
  const target = args['file_path'] ?? args['path'] ?? args['command'] ?? args['url'];
  return typeof target === 'string' && target !== '' ? `${exec.name}:${target}` : `${exec.name}:${exec.callId}`;
}

export const name = 'stream-agent-obs-broker';
export const inject = ['tools', 'state'];

export default function apply(ctx             , config                  = {})                  {
  const warn = makeWarn(ctx, 'obs-broker');
  const faults = new EntryLedger();
  const state = ctx.get?.('state')                                ;
  if (state === undefined) warn('ctx.state 服务不可用：blob 落盘降级为进程内存（resume 后不可重放）');
  const bridge = obsSinkBridge(state?.sink ?? { write: () => {}, read: () => undefined });
  const ledger = new ObservationLedger({ sink: { put: (ref, content) => bridge.put(ref, content) }, starvationThreshold: config.starvationThreshold });

  // ---- 工具结果出口：登记（audit）+ 原样放行 ----------------------------------
  const onPostExecute                      = (exec, result, next) => {
    try {
      if (config.faultInjection === 'audit') throw new Error('injected broker fault (audit)');
      const content = contentTextOf(result.content);
      const observation = ledger.observe({
        tool: exec.name,
        ok: !result.isError,
        key: observationKeyOf(exec),
        content,
        callId: exec.callId,
      });
      faults.push('audit', {
        callId: exec.callId,
        tool: exec.name,
        isError: result.isError,
        chars: content.length,
        handle: observation.handle,
        info_gain: observation.info_gain, // 失败必为 high（内核规则）；模型必须看到失败
        reason: observation.reason,
      });
    } catch (error) {
      // fail-open：登记异常不影响工具结果放行；broker_error 留痕（红线 5）
      faults.push('broker_error', { at: 'post-execute', error: error instanceof Error ? error.message : String(error) });
      warn('观测登记异常：结果原样放行', error);
    }
    return next(); // 原样放行（成功与失败同权；改写会毁驱动器的 tf-peek 原文依赖）
  };

  // ---- llm/stream：泄漏扫描 + 指标落账（只读，不阻断不改写）-------------------
  let requestSeq = 0;
  const onStream                 = (options, next) => {
    try {
      if (config.faultInjection === 'scan') throw new Error('injected broker fault (scan)');
      const messages = options.messages ?? [];
      const leaks                                             = [];
      if (messages.length > 0) {
        const texts = messages.map((m) => wireMessageText(m                                                           ));
        for (const record of ledger.records()) {
          if (record.handle === '') continue;
          const blob = bridge.readRaw(record.handle);
          if (blob === undefined || blob.length < (config.leakMinChars ?? 64)) continue;
          texts.forEach((text, index) => {
            if (text.includes(blob)) leaks.push({ handle: record.handle, message: index });
          });
        }
      }
      for (const leak of leaks) faults.push('leak', { ...leak, session: options.sessionId ?? '' });
      requestSeq += 1;
      const counters = ledger.counters();
      faults.push('metrics', {
        session: options.sessionId ?? '',
        request: requestSeq,
        messages: messages.length,
        leaks: leaks.length,
        produced: counters.produced,
        injected: counters.injected,
        peeked: counters.peeked,
        injectedRatio: ledger.injectedRatio(),
      });
    } catch (error) {
      // fail-open：扫描异常 → 全量放行 + broker_error 留痕
      faults.push('broker_error', { at: 'llm/stream', error: error instanceof Error ? error.message : String(error) });
      warn('泄漏扫描异常：请求全量放行', error);
    }
    return next();
  };

  if (typeof ctx.on !== 'function') throw new Error('[obs-broker] ctx.on 不可用：无法挂载 tools/llm 事件');
  ctx.on('tools/post-execute', onPostExecute                                            );
  ctx.on('llm/stream', onStream                                            );
  if (config.announce === true) console.error('[obs-broker] mounted: tools/post-execute + llm/stream listeners');

  return asPluginEffect({
    ledger,
    faults,
    counters() {
      const c = ledger.counters();
      return { ...c, injectedRatio: ledger.injectedRatio() };
    },
    dispose: () => {},
  });
}
