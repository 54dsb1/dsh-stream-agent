/**
 * kernel/render.ts —— 三段式上下文装配 + 前缀校验器（04 号任务书目标 B）。
 *
 * 装配模型：
 *   [ 稳定前缀 ]  system 提示 + tf-* 协议说明 + 工具 schema + 任务不变量
 *                 —— 构造期冻结，逐请求字节不变（结构性保证：只读，无任何写入路径）
 *   [ 追加区   ]  历史 assistant 消息 + 句柄目录增量（O3 差分注入）+ 回合冻结动态段（O4）
 *                 —— 只追加，永不改写（唯一的例外是显式记录的整块尾部丢弃）
 *   [ 易变尾   ]  高增益观测注入 + tf-peek 结果 + 动态上下文 + 失败结构化错误
 *                 —— 每请求整块重建，允许整块丢弃
 *
 * 前缀校验器（README 优化点 O6，fail-closed）：
 * - assertPrefixStable(prev, next)：逐消息逐字节比较，违反抛 PrefixBrokenError，不做静默修复；
 * - 只允许整块丢弃尾部（显式调用 truncateAppendTail，内部逐字节验证"只有尾部被丢弃"）；
 * - "压缩历史"请求 → 拒绝 + 降级为尾部截断 + 记录（红线 4：禁止智能压缩/摘要）；
 * - render() 内置 preflight：发送前对上一请求的稳定段做逐字节断言，违反直接抛错拒绝发送。
 *
 * 内核层纪律：零框架依赖、无 IO（时钟注入）。
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// 基础类型
// ---------------------------------------------------------------------------

                                                                   

/** v0.3.2：assistant 消息的宿主来源元数据。宿主 LlmRuntime.forAdapter（dsh-llm
 *  lib/index.js:2277；GitHub master packages/llm/llm/src/index.ts 同源无防护）对请求里的
 *  每条 assistant 消息读 `message.source.replayState`——source 缺失 = TypeError
 *  "Cannot read properties of undefined (reading 'replayState')"，流以 error finish 收场，
 *  回合中断（真机 session-8f22c7a0 seq 121 实证：正文首次落追加区后的下一请求必崩）。
 *  replayState 本身可选（dsh-llm types.d.ts:15），缺失时宿主按"无原生回放"处理。 */
                                      
                
                   
                
 

                                
                    
                  
                                                    
                               
 

/** 与 03 号分派 obs.ts 的 directoryDelta(sinceSeq) 返回结构兼容（结构化类型，不 import）。 */
                                       
                            
                              
                            
 

                                   
                                    
                 
                
 

                                                               

/** 策略事件记录（红线：不许静默）。compress-history-request = 违规拒绝（accepted:false）；
 *  segment-drop = F7 显式段边界（accepted:true——整块丢弃、前缀基线重置并记录）。 */
                                        
             
                                                    
                  
                    
                                         
                        
                 
 

                              
                
 

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

export class PrefixBrokenError extends Error {
           index        ;
           expected        ;
           actual        ;
  constructor(index        , expected        , actual        , why        ) {
    super(
      `前缀校验失败（fail-closed，拒绝发送不做静默修复）：第 ${index} 条消息${why}。` +
        ` 期望: ${truncate(expected)} 实际: ${truncate(actual)}`,
    );
    this.name = 'PrefixBrokenError';
    this.index = index;
    this.expected = expected;
    this.actual = actual;
  }
}

export class DynamicInPrefixError extends Error {
  constructor(key        ) {
    super(
      `动态字段 "${key}" 不允许进入稳定前缀（O4）：请用 freezeDynamics 归入易变尾或回合冻结`,
    );
    this.name = 'DynamicInPrefixError';
  }
}

function truncate(text        , max = 120)         {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

function bytesEqual(a        , b        )          {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')) === 0;
}

// ---------------------------------------------------------------------------
// assertPrefixStable / renderHash（可独立使用，08 号实测用它算 prefix_hash 序列）
// ---------------------------------------------------------------------------

/**
 * 逐消息逐字节比较：next 的前 prev.length 条消息必须与 prev 完全一致。
 * - 中间任何一条不一致 → PrefixBrokenError（不做静默修复）；
 * - next 比 prev 长：允许（追加区只追加）；
 * - next 比 prev 短：默认抛错（稳定段收缩=历史被销毁）；仅在显式 allowTailDrop 下允许，
 *   且此时必须逐字节证明 next 是 prev 的严格前缀（即只发生了整块尾部丢弃）。
 */
export function assertPrefixStable(
  prev                          ,
  next                          ,
  opts                              = {},
)                           {
  const n = Math.min(prev.length, next.length);
  for (let i = 0; i < n; i++) {
    const p = prev[i];
    const q = next[i];
    if (p.role !== q.role || !bytesEqual(p.content, q.content)) {
      throw new PrefixBrokenError(
        i,
        `${p.role}: ${p.content}`,
        `${q.role}: ${q.content}`,
        p.role !== q.role ? 'role 不一致' : '内容逐字节不一致',
      );
    }
  }
  if (next.length < prev.length) {
    if (!opts.allowTailDrop) {
      throw new PrefixBrokenError(
        next.length,
        `共 ${prev.length} 条`,
        `只剩 ${next.length} 条`,
        '：稳定段收缩（尾部被丢弃但未声明 allowTailDrop）',
      );
    }
    // allowTailDrop：走到这里说明前 n 条逐字节相等，即只发生了整块尾部丢弃
  }
  return { prefixLength: next.length };
}

/** 确定性哈希：同一组消息永远得到同一 hash（供实测对账 / prefix_hash 序列）。 */
export function renderHash(messages                          )         {
  const canonical = JSON.stringify(
    messages.map((m) => ({ role: m.role, content: m.content })),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// ContextRenderer
// ---------------------------------------------------------------------------

                                                                  

                       
                        
                    
                  
                                                             
                               
 

                     
                    
                  
 

                                         
              
                 
                                  
                   
                   
                      
               
                     
                      
                                                  
                                                       
 

function renderHandleDelta(delta                      )                {
  const lines           = [];
  for (const e of delta.added) {
    lines.push(`+ ${e.handle}${e.note ? ` — ${e.note}` : ''}`);
  }
  for (const e of delta.changed) {
    lines.push(`~ ${e.handle}${e.note ? ` — ${e.note}` : ''}`);
  }
  for (const e of delta.stale) {
    lines.push(`- ${e.handle}（已失效，tf-peek 将拒绝）${e.note ? ` — ${e.note}` : ''}`);
  }
  if (lines.length === 0) return null; // 空增量不产生块（前缀逐字节不变）
  return ['[句柄目录增量 O3：只追加，历史目录见上文]', ...lines].join('\n');
}

export class ContextRenderer {
  // 稳定前缀：构造期冻结。语言层面只读（readonly + Object.freeze），不存在任何写入路径。
           #prefix                          ;
  #appendBlocks                = [];
  #tailBlocks              = [];
  /** O4：逐请求变化的动态字段（时间戳等），归易变尾，每请求重建。 */
  #volatileDynamics = new Map                ();
  #lastStable                         = null;
           #clock             ;
           #policySink                                          ;
           #policyLog                          = [];

  constructor(opts                        ) {
    // 稳定前缀内容：四段确定性拼接，构造后字节冻结
    const content = [
      opts.system,
      opts.protocol,
      opts.toolSchemas,
      opts.invariants,
    ].join('\n\n');
    this.#prefix = Object.freeze([
      Object.freeze({ role: 'system'         , content }),
    ]);
    this.#clock = opts.clock ?? { now: () => Date.now() };
    this.#policySink = opts.policySink;
  }

  /** 稳定前缀（只读）。动态内容有任何路径想进来都过不去——这是 O4 的结构性保证。 */
  get prefixMessages()                           {
    return this.#prefix;
  }

  /** 策略违规内部台账。 */
  get policyLog()                                   {
    return this.#policyLog;
  }

  // ------------------------------------------------------------------ 追加区

  /** 追加历史消息（assistant / user / tool）。system 归稳定前缀所有，此处禁止。 */
  appendHistory(msg               )       {
    if (msg.role === 'system') {
      throw new Error('appendHistory 不接受 system 消息：system 属于稳定前缀');
    }
    // v0.3.2：source 必须保留（assistant 块不带 source = 请求在宿主 forAdapter 崩溃）。
    this.#appendBlocks.push({ kind: 'history', role: msg.role, content: msg.content, ...(msg.source === undefined ? {} : { source: msg.source }) });
  }

  /**
   * O3 句柄目录差分注入：obs.ts 的 directoryDelta(sinceSeq) 结果只追加进追加区。
   * 空增量（三列皆空）不产生任何块。返回是否追加了块。
   */
  appendHandleDelta(delta                      )          {
    const content = renderHandleDelta(delta);
    if (content === null) return false;
    this.#appendBlocks.push({
      kind: 'handle-delta',
      role: 'user',
      content,
    });
    return true;
  }

  /**
   * freezeDynamics —— O4 动态上下文冻结的统一入口。
   * - 'volatile-tail'：动态字段归易变尾，每请求重建（推荐给时间戳、目录快照等）；
   * - 'turn-freeze'：按回合冻结为追加区块，本回合取值此后字节不变。
   * 不提供把动态内容写进稳定前缀的选项（结构性禁止）。
   */
  freezeDynamics(
    dynamics                        ,
    placement                  ,
  )       {
    for (const [key, value] of Object.entries(dynamics)) {
      if (this.#prefix[0].content.includes(value)) {
        throw new DynamicInPrefixError(key);
      }
    }
    if (placement === 'volatile-tail') {
      for (const [key, value] of Object.entries(dynamics)) {
        this.#volatileDynamics.set(key, value);
      }
    } else {
      const keys = Object.keys(dynamics).sort();
      const content = [
        '[回合冻结动态段 O4：取值于本回合，此后字节不变]',
        ...keys.map((k) => `${k}: ${dynamics[k]}`),
      ].join('\n');
      this.#appendBlocks.push({ kind: 'turn-frozen', role: 'user', content });
    }
  }

  // ------------------------------------------------------------------ 易变尾

  /** 易变尾整块替换（每请求重建，允许整块丢弃）。 */
  setTail(blocks                                                )       {
    this.#tailBlocks = blocks.map((b) => ({
      role: b.role ?? 'user',
      content: b.content,
    }));
  }

  /** 丢弃整个易变尾。 */
  clearTail()       {
    this.#tailBlocks = [];
  }

  // ------------------------------------------------------------------- 装配

  /** 追加区块数（F7 段边界判定用）。 */
  get appendBlockCount()         {
    return this.#appendBlocks.length;
  }

  /** 追加区总字符数（段边界只看增长部分；system 前缀恒定不计入）。 */
  get appendChars()         {
    return this.#appendBlocks.reduce((n, b) => n + b.content.length, 0);
  }

  // ------------------------------------------------------------------- 装配

  /** 稳定段 = 稳定前缀 ++ 追加区（不含易变尾）。v0.3.2：assistant 块的 source 随装配
   *  透传（宿主 forAdapter 读 assistant 消息的 source.replayState，缺失即崩）。 */
  stableMessages()                  {
    return [
      ...this.#prefix,
      ...this.#appendBlocks.map((b) => (
        b.source === undefined
          ? { role: b.role, content: b.content }
          : { role: b.role, content: b.content, source: b.source }
      )),
    ];
  }

  /** 稳定段哈希（O4/O6 单调性证明与 08 号 prefix_hash 序列都用它）。 */
  stableHash()         {
    return renderHash(this.stableMessages());
  }

  /**
   * 装配一次请求的完整 messages（稳定段 ++ 易变尾）。
   * 内置 O6 preflight（fail-closed）：与上一请求的稳定段做逐字节断言，
   * 违反直接抛 PrefixBrokenError 拒绝发送——宁可任务失败不烧缓存。
   */
  render()                  {
    const stable = this.stableMessages();
    if (this.#lastStable !== null) {
      assertPrefixStable(this.#lastStable, stable);
    }
    this.#lastStable = stable;
    const tail = this.renderTail();
    return [...stable, ...tail];
  }

          renderTail()                  {
    const out                  = [];
    if (this.#volatileDynamics.size > 0) {
      const keys = [...this.#volatileDynamics.keys()].sort();
      out.push({
        role: 'user',
        content: [
          '[动态上下文（易变尾，每请求重建）]',
          ...keys.map((k) => `${k}: ${this.#volatileDynamics.get(k)}`),
        ].join('\n'),
      });
    }
    for (const b of this.#tailBlocks) out.push({ role: b.role, content: b.content });
    return out;
  }

  // --------------------------------------------------------------- 降级通道

  /**
   * 整块尾部丢弃（唯一被允许的历史收缩方式）。
   * 只从追加区末尾丢弃整块；内部逐字节验证"被保留部分与丢弃前完全一致"，
   * 基线显式推进（有 policyLog 记录，绝非静默修复）。
   */
  truncateAppendTail(dropCount        )         {
    const before = this.stableMessages();
    const actual = Math.max(0, Math.min(dropCount, this.#appendBlocks.length));
    if (actual === 0) return 0;
    this.#appendBlocks = this.#appendBlocks.slice(
      0,
      this.#appendBlocks.length - actual,
    );
    const after = this.stableMessages();
    // fail-closed：必须逐字节证明 after 是 before 的严格前缀（只有整块尾部被丢弃）
    assertPrefixStable(after, before, { allowTailDrop: true });
    this.#lastStable = after;
    return actual;
  }

  /**
   * F7 段边界：从追加区**头部**整块丢弃 n 个块（只落在完整回合边界上——调用方保证；
   * 块不拆开，工具调用与结果同块进出）。被丢弃内容整块返回，调用方负责句柄化登记
   * （原文可按句柄 tf-peek 回取，绝不做摘要改写）。
   *
   * 这是"整块丢弃"路线的显式缓存重置点：下一请求的稳定段与上一请求不再共享前缀，
   * 因此本方法重置前缀基线（#lastStable = null）并写入 policyLog——未记录的前缀
   * 不一致仍会被 render() preflight fail-closed 拦下，这条通道是唯一合法入口。
   */
  dropAppendHead(dropCount        , opts                    )                                                       {
    const n = Math.max(0, Math.min(dropCount, this.#appendBlocks.length));
    const dropped = this.#appendBlocks.slice(0, n).map((b) => b.content);
    this.#appendBlocks = this.#appendBlocks.slice(n);
    this.#lastStable = null;
    const record                        = {
      at: this.#clock.now(),
      kind: 'segment-drop',
      request: opts.reason,
      accepted: true,
      degradedTo: 'none',
      droppedBlocks: n,
      detail: `F7 段边界：整块丢弃 ${n} 块（${dropped.reduce((s, t) => s + t.length, 0)} 字符），前缀基线重置（显式缓存重置点；被丢弃原文已句柄化，不做摘要改写）`,
    };
    this.#policyLog.push(record);
    if (this.#policySink) this.#policySink(record);
    return { dropped, record };
  }

  /**
   * 模型请求"压缩历史"：一律拒绝（红线 4 禁止智能压缩/摘要/改写中间内容），
   * 降级为整块尾部截断并记录。绝不静默。
   */
  requestHistoryCompression(req   
                    
                                                
                              
   )                        {
    const dropped =
      req.fallbackTailDrop !== undefined
        ? this.truncateAppendTail(req.fallbackTailDrop)
        : 0;
    const record                        = {
      at: this.#clock.now(),
      kind: 'compress-history-request',
      request: req.request,
      accepted: false,
      degradedTo: dropped > 0 ? 'tail-truncation' : 'none',
      droppedBlocks: dropped,
      detail:
        '压缩历史请求被拒绝（禁止摘要/改写中间历史，会摧毁前缀缓存）' +
        (dropped > 0
          ? `；降级为整块尾部截断 ${dropped} 块`
          : '；未做任何丢弃'),
    };
    this.#policyLog.push(record);
    if (this.#policySink) this.#policySink(record);
    return record;
  }
}
