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
//   2. freezeDynamics（O4）出口：内核 ContextRenderer 的动态冻结语义对非 loop 装配路径
//      开放（volatile-tail / turn-freeze；稳定前缀结构性禁入）。
// fail-open（红线 5）：断言器自身异常 → 放行 + ledger 记 preflight_error；
//   前缀破坏是策略违规不是自身异常——fail-closed 上抛，两者严格区分。

import { assertPrefixStable, PrefixBrokenError, renderHash, ContextRenderer } from '../kernel/render.ts';
import type { RenderMessage, DynamicPlacement } from '../kernel/render.ts';
import { makeWarn, EntryLedger, wireMessageText } from './adapter-kit.ts';
import type { HostCtxLike, Warn } from './adapter-kit.ts';

/** 镜像 dsh-llm GenerateOptions（读子集；types.d.ts:538-580） */
interface WireOptions {
  messages?: readonly { role?: string; content: unknown }[];
  sessionId?: string;
}
type StreamListener = (options: WireOptions, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>;

/** 线格式消息 → 内核 RenderMessage（content text 块拼接）。 */
function toRenderMessage(m: { role?: string; content: unknown }): RenderMessage {
  const text = wireMessageText(m as { content: readonly { type: string; text?: string }[] });
  return { role: (m.role ?? 'user') as RenderMessage['role'], content: text };
}

export interface ContextRenderHandle {
  /** O6 断言器本体（宿主 waterfall 之外的调用方也可显式调用）。 */
  preflight(messages: readonly RenderMessage[], sessionId: string): { request: number; stableHash: string; fullHash: string };
  /** O4 动态冻结出口（内核 ContextRenderer 语义；见 kernel/render.ts :267-288）。 */
  freezeDynamics(dynamics: Record<string, string>, placement: DynamicPlacement): void;
  faults: EntryLedger;
  dispose: () => void;
}

export interface ContextRenderConfig {
  /** freezeDynamics 的载体 renderer（默认内置空 renderer，仅承载动态冻结语义） */
  system?: string;
  /** 测试注错位：断言体抛非前缀异常（fail-open 验证用；生产不得设置） */
  faultInjection?: boolean;
  /** 装载自证横幅（排障用；preset/patch 激活对 CLI 静默，探针 A 惯例） */
  announce?: boolean;
}

export const name = 'stream-agent-context-render';
export const inject = [];

export default function apply(ctx: HostCtxLike, config: ContextRenderConfig = {}): ContextRenderHandle {
  const warn = makeWarn(ctx, 'context-render');
  const faults = new EntryLedger();
  /** 会话 → 首请求快照（首条消息 = 稳定前缀 system；逐字节冻结）。 */
  const sessions = new Map<string, { first: RenderMessage; requests: number }>();
  const freezeRenderer = new ContextRenderer({
    system: config.system ?? '（stream-agent context-render：动态冻结载体，稳定前缀无业务内容）',
    protocol: '', toolSchemas: '', invariants: '',
  });

  const preflight = (messages: readonly RenderMessage[], sessionId: string): { request: number; stableHash: string; fullHash: string } => {
    if (messages.length === 0) throw new PrefixBrokenError(0, '非空消息序列', '空序列', '：preflight 拒绝空请求');
    const first = messages[0];
    const state = sessions.get(sessionId);
    if (state === undefined) {
      sessions.set(sessionId, { first, requests: 1 });
    } else {
      // O6 fail-closed：稳定前缀逐字节断言（内核校验器原样使用，不静默修复）
      assertPrefixStable([state.first], [first]);
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
    });
    return { request: state?.requests ?? 1, stableHash, fullHash };
  };

  const onStream: StreamListener = (options, next) => {
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
  ctx.on('llm/stream', onStream as unknown as (...args: never[]) => unknown);
  if (config.announce === true) console.error('[context-render] mounted: llm/stream O6 preflight asserter');

  return {
    preflight,
    freezeDynamics: (dynamics, placement) => freezeRenderer.freezeDynamics(dynamics, placement),
    faults,
    dispose: () => {},
  };
}
