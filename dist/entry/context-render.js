// entry/context-render.ts —— 装配器接入（M5 适配，分派 07）
//
// 形态判定（任务书："若 06 号 loop 完整接管装配，本 entry 退化为 pre-request 断言器
// （只跑 O6 preflight）——以 06 的实际形态为准"）：06 驱动器经内核 ContextRenderer
// 全权装配（稳定前缀/追加区/易变尾、O3 差分、O5 阶梯、O6 内置断言），本插件请求路径上
// 不存在 SystemPromptProjection 注入（dsh-agent-loop/lib/types/runtime-context.d.ts 的
// 前缀稳定设计目标与本 entry 方向一致，但不适用于 loop-built 请求）。因此本 entry 是：
//   1. llm/stream waterfall 上的 O6 pre-request 断言器（宿主边界的第二道独立见证）：
//      逐会话断言首条消息（稳定前缀 system）逐字节不变——凡有逐请求动态字段漏进稳定前缀
//      （O4 破坏），第二次请求必在此被拒；违反 → 内核 PrefixBrokenError 原样上抛（fail-closed，
//      拒绝发送，宁可任务失败不烧缓存）；逐请求落 prefix 台账（08 号 prefix_hash 序列数据源）。
//      v0.4.3（P0-6②）第二见证升级为**整条序列**：保留上一请求全文，逐请求落首差异位
//      （firstDiffIndex）与长度收缩（shrunk）事实——只记账不 fail-closed（wire 层无法区分
//      段边界的合法收缩与改写；强制收口在驱动器 #lastRequest 承诺前缀断言，那里有显式基线
//      重置通道）。旧形态"只看 messages[0]"的两个盲区（升级清单 §2.7）由此补齐可观测面。
//   2. freezeDynamics（O4）出口：内核 ContextRenderer 的动态冻结语义对非 loop 装配路径
//      开放（volatile-tail / turn-freeze；稳定前缀结构性禁入）。
// fail-open（红线 5）：断言器自身异常 → 放行 + ledger 记 preflight_error；
//   前缀破坏是策略违规不是自身异常——fail-closed 上抛，两者严格区分。

import { assertPrefixStable, PrefixBrokenError, renderHash, ContextRenderer } from '../kernel/render.js';
                                                                           
import { makeWarn, EntryLedger, wireMessageText } from './adapter-kit.js';
                                                          
import { asPluginEffect } from './cordis-compat.js';

/** 镜像 dsh-llm GenerateOptions（读子集；types.d.ts:538-580） */
                       
                                                            
                     
 
                                                                                                           

/** 线格式消息 → 内核 RenderMessage（content text 块拼接）。 */
function toRenderMessage(m                                     )                {
  const text = wireMessageText(m                                                           );
  return { role: (m.role ?? 'user')                         , content: text };
}

                                      
                                             
                                                                                                                              
                                                                      
                                                                                      
                      
                      
 

                                      
                                                              
                  
                                              
                           
                                                    
                     
 

export const name = 'stream-agent-context-render';
export const inject = [];

export default function apply(ctx             , config                      = {})                      {
  const warn = makeWarn(ctx, 'context-render');
  const faults = new EntryLedger();
  /** 会话 → 上一请求快照（首条消息逐字节冻结；v0.4.3 起保留整条序列做第二见证）。 */
  const sessions = new Map                                                                           ();
  const freezeRenderer = new ContextRenderer({
    system: config.system ?? '（stream-agent context-render：动态冻结载体，稳定前缀无业务内容）',
    protocol: '', toolSchemas: '', invariants: '',
  });

  const preflight = (messages                          , sessionId        )                                                            => {
    if (messages.length === 0) throw new PrefixBrokenError(0, '非空消息序列', '空序列', '：preflight 拒绝空请求');
    const first = messages[0];
    const state = sessions.get(sessionId);
    // v0.4.3（P0-6②）：整条序列第二见证的事实采集——与上一请求逐条 diff，首条断言之外
    // 的事实（首差异位 / 长度收缩）全部落台账。fail-closed 只守首条：wire 层无法区分
    // 段边界的合法收缩（dropAppendHead 重置基线）与改写，强制收口在驱动器的
    // #lastRequest 承诺前缀断言（那里有显式基线重置通道）；本见证的职责是"逐请求可对账的
    // 完整 diff 事实 + 独立于驱动器的首条守卫"。
    let firstDiffIndex = -1;
    let shrunk = false;
    if (state !== undefined) {
      const n = Math.min(state.last.length, messages.length);
      for (let i = 0; i < n; i++) {
        const p = state.last[i] ;
        const q = messages[i] ;
        if (p.role !== q.role || p.content !== q.content) {
          firstDiffIndex = i;
          break;
        }
      }
      shrunk = messages.length < state.last.length;
    }
    if (state === undefined) {
      sessions.set(sessionId, { first, last: [...messages], requests: 1 });
    } else {
      // O6 fail-closed：稳定前缀逐字节断言（内核校验器原样使用，不静默修复）
      assertPrefixStable([state.first], [first]);
      state.last = [...messages];
      state.requests += 1;
    }
    const stableHash = renderHash([first]);
    const fullHash = renderHash(messages);
    faults.push('prefix', {
      session: sessionId,
      request: state?.requests ?? 1,
      stableHash,
      fullHash,
      messages: messages.length,
      // v0.4.3：整条序列 diff 事实（首请求两值皆空——无上一请求可比）
      ...(state === undefined ? {} : { firstDiffIndex, shrunk }),
    });
    return { request: state?.requests ?? 1, stableHash, fullHash };
  };

  const onStream                 = (options, next) => {
    try {
      if (config.faultInjection === true) throw new Error('injected preflight fault');
      if (options.messages !== undefined && options.messages.length > 0) {
        preflight(options.messages.map(toRenderMessage), options.sessionId ?? '');
      }
    } catch (error) {
      if (error instanceof PrefixBrokenError) {
        // 策略违规：fail-closed，拒绝发送（宁可任务失败不烧缓存——README O6 原文语义）
        faults.push('prefix-broken', { session: options.sessionId ?? '', error: error.message });
        throw error;
      }
      // 断言器自身异常：fail-open，放行不静默（红线 5）
      faults.push('preflight_error', { error: error instanceof Error ? error.message : String(error) });
      warn('preflight 异常：请求放行（fail-open）', error);
    }
    return next();
  };

  if (typeof ctx.on !== 'function') throw new Error('[context-render] ctx.on 不可用：无法挂载 llm/stream 断言器');
  ctx.on('llm/stream', onStream                                            );
  if (config.announce === true) console.error('[context-render] mounted: llm/stream O6 preflight asserter');

  return asPluginEffect({
    preflight,
    freezeDynamics: (dynamics, placement) => freezeRenderer.freezeDynamics(dynamics, placement),
    faults,
    dispose: () => {},
  });
}
