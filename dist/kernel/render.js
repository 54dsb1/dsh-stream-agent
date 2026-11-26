/**
 * kernel/render.ts —— 三段式上下文装配 + 前缀校验器（04 号任务书目标 B）。
 *
 * 装配模型：
 *   [ 稳定前缀 ]  system 提示 + tf-* 协议说明 + 工具 schema + 任务不变量
 *                 —— 构造期冻结，逐请求字节不变（结构性保证：只读，无任何写入路径）
 *   [ 追加区   ]  历史 assistant 消息 + 句柄目录增量（O3 差分注入）+ 回合冻结动态段（O4）
 *                 —— 只追加，永不改写（唯一的例外是显式记录的整块尾部丢弃 / 计划性换基）
 *   [ 易变尾   ]  高增益观测注入 + tf-peek 结果 + 动态上下文 + 失败结构化错误
 *                 —— 每请求整块重建，允许整块丢弃
 *
 * 前缀校验器（README 优化点 O6，fail-closed）：
 * - assertPrefixStable(prev, next)：逐消息逐字节比较，违反抛 PrefixBrokenError，不做静默修复；
 * - 只允许整块丢弃尾部（显式调用 truncateAppendTail，内部逐字节验证"只有尾部被丢弃"）；
 * - "压缩历史"请求 → 拒绝 + 降级为尾部截断 + 记录（红线 4：禁止智能压缩/摘要——
 *   0.5.0 P3 起压缩走 kernel/compaction.ts 的确定性摘要 + dropAppendHead 合法通道）；
 * - render() 内置 preflight：发送前对上一请求的稳定段做逐字节断言，违反直接抛错拒绝发送；
 * - 0.5.0（§8.3 K8）：前缀非单调按三类分别处置，新增**计划性换基**（planned-rebase）
 *   合法通道——整块压缩（dropAppendHead）/ 段边界 / 通道切换产生的前缀断裂走 rebase()，重置基线
 *   + 记账 + 模型侧可见（[tf-stream:context-rebased]），不采用"报错/重发"二分。
 *
 * 内核层纪律：零框架依赖、无 IO（时钟注入）。
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// 基础类型
// ---------------------------------------------------------------------------

                                                                   

/** v0.4.2：assistant 消息的宿主来源元数据（宿主 LlmRuntime.forAdapter 无防护读
 *  message.source.replayState——缺失 = TypeError → 流 error → 回合中断；
 *  真机 session-8f22c7a0 seq 121 实证；GitHub master 同源）。replayState 可选。 */
                                      
                
                   
                
 

                                
                    
                  
                                                    
                               
 

/** 与 03 号分派 obs.ts 的 directoryDelta(sinceSeq) 返回结构兼容（结构化类型，不 import）。 */
                                       
                            
                              
                            
 

                                   
                                    
                 
                
 

                                                               

/** 策略事件记录（红线：不许静默）。compress-history-request = 违规拒绝（accepted:false）；
 *  segment-drop = F7 显式段边界（accepted:true——整块丢弃、前缀基线重置并记录）；
 *  planned-rebase = 0.5.0 计划性换基（§8.3：dropAppendHead / 段边界 / 通道切换
 *  产生的合法换基——重置基线、记账、模型侧可见，accepted:true）。 */
                                        
             
                                                                       
                  
                    
                                         
                        
                 
 

                              
                
 

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/** v0.4.3（P0-6③）：前缀破坏的三类成因 + 0.5.0 计划性换基（§8.3 判定表）。
 *  判定式：error.index < error.stablePrefixLen → 'stable-drift'（稳定段漂移——装配被改写，
 *  最严重）；否则 'append-drift'（追加区/转正块漂移——转正纪律被破坏）；长度收缩不匹配
 *  时为 'shrink'（历史被销毁且未走段边界通道）。
 *  'planned-rebase' 永不作为断言失败抛出——计划性换基（整块压缩 / 段边界 /
 *  通道切换）走 ContextRenderer.rebase() 显式通道：重置基线 + 记账 + 模型侧可见
 *  （§8.3 K8：不采用"报错/重发"二分；压缩走整块丢弃，未使用 surfaceOp:replace）。 */
                                                                                              

/** 0.5.0（§8.6 实现要求 1）：换基后的模型可见一行。 */
export function contextRebasedLine(reason        )         {
  return `[tf-stream:context-rebased] 本请求上下文已重建（原因：${reason}），缓存已重置，行为不变。`;
}

export class PrefixBrokenError extends Error {
           index        ;
           expected        ;
           actual        ;
  /** v0.4.3（P0-6③）：成因分类与上一请求稳定段长度（判定依据；缺省按稳定漂移处理）。 */
           prefixCause                   ;
           stablePrefixLen        ;
  constructor(
    index        ,
    expected        ,
    actual        ,
    why        ,
    opts                                                                = {},
  ) {
    super(
      `前缀校验失败（fail-closed，拒绝发送不做静默修复）：第 ${index} 条消息${why}。` +
        ` 期望: ${truncate(expected)} 实际: ${truncate(actual)}`,
    );
    this.name = 'PrefixBrokenError';
    this.index = index;
    this.expected = expected;
    this.actual = actual;
    this.prefixCause = opts.prefixCause ?? 'stable-drift';
    this.stablePrefixLen = opts.stablePrefixLen ?? index;
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
        // v0.4.3：稳定段断言的比较范围全部在稳定段内——任何断点都是 stable-drift
        { prefixCause: 'stable-drift', stablePrefixLen: prev.length },
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
        { prefixCause: 'shrink', stablePrefixLen: prev.length },
      );
    }
    // allowTailDrop：走到这里说明前 n 条逐字节相等，即只发生了整块尾部丢弃
  }
  return { prefixLength: next.length };
}

// ---------------------------------------------------------------------------
// v0.4.3（P0-6①②）：wire 边界承诺前缀断言（上一请求收尾后的 stable vs 本次请求）
// ---------------------------------------------------------------------------

/** wire 断言的基线（v0.4.3.1 修正，核查 §2.5）：
 *  - promised：**上一请求收尾后的稳定段**（#commitDeliveredTail 转正之后的 stableMessages()
 *    逐字节快照）——转正纪律保证它必须逐字节出现在下一请求头部；transient 尾块
 *    （nudge/error/degraded）不转正、不在承诺里，与易变尾的块序完全解耦。
 *  - stableLen：上一请求**装配时**的稳定段长度（转正前）——分类锚点。 */
                                  
                                     
                    
 

/**
 * v0.4.3（P0-6②）：wire 边界承诺前缀断言——修复旧断言的两个盲区（升级清单 §2.7）：
 *  ① 转正块与已发文本是否逐字节一致（旧断言只比 stable，从不覆盖）；
 *  ② 追加区被代码改写（旧断言只保护它被调用那一刻的 stable，不保护"上一请求"这个外部事实）。
 * 比较"next 的前 promised.length 条"与 promised；按断点位置分类（P0-6③）：
 *  - index < stableLen → 'stable-drift'（稳定段被改写——0 重发，fail-closed）；
 *  - stableLen ≤ index < promised.length → 'append-drift'（转正块/追加区漂移——预算内放行一次）；
 *  - next 比 promised 短 → 'shrink'（承诺前缀收缩；仅 allowTailDrop 且 next 是 promised 的
 *    严格字节前缀时合法——段边界必须走 dropAppendHead 通道并重置基线，不走本断言）。
 * v0.4.3.1：基线从"上一请求前 N 条（horizon）"改为"转正后的 stable"。旧 horizon 公式
 * 隐含"durable 尾块连续排在易变尾最前"——混合尾（error 在 observation 前，核查 §2 的
 * 反例）会误报 append-drift；promised 与尾序解耦后该误判不可能发生。
 */
export function assertRequestPrefix(
  prev                 ,
  next                          ,
  opts                              = {},
)                           {
  const stableLen = Math.min(prev.stableLen, prev.promised.length);
  const n = Math.min(prev.promised.length, next.length);
  for (let i = 0; i < n; i++) {
    const p = prev.promised[i] ;
    const q = next[i] ;
    if (p.role !== q.role || !bytesEqual(p.content, q.content)) {
      throw new PrefixBrokenError(
        i,
        `${p.role}: ${p.content}`,
        `${q.role}: ${q.content}`,
        p.role !== q.role ? 'role 不一致' : '内容逐字节不一致',
        {
          prefixCause: i < stableLen ? 'stable-drift' : 'append-drift',
          stablePrefixLen: stableLen,
        },
      );
    }
  }
  if (next.length < prev.promised.length) {
    if (opts.allowTailDrop === true) {
      // 允许整块尾部丢弃：必须逐字节证明 next 是 promised 的严格前缀（前 n 条已相等）
      return { prefixLength: next.length };
    }
    throw new PrefixBrokenError(
      next.length,
      `共 ${prev.promised.length} 条（承诺前缀）`,
      `只剩 ${next.length} 条`,
      '：承诺前缀收缩（历史被销毁；段边界必须走 dropAppendHead 通道并重置基线）',
      { prefixCause: 'shrink', stablePrefixLen: stableLen },
    );
  }
  return { prefixLength: prev.promised.length };
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
  // 0.5.0：唯一的改写入口是 rebase()（计划性换基，§8.3——记账 + 显式，绝非静默）。
  #prefix                          ;
  /** 前缀四段（rebase 的缺省来源：未提供的段沿用当前值；rebase 是唯一改写口）。 */
  #prefixParts                                                                               ;
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
    this.#prefixParts = {
      system: opts.system,
      protocol: opts.protocol,
      toolSchemas: opts.toolSchemas,
      invariants: opts.invariants,
    };
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
    // v0.4.2：source 必须保留（assistant 块不带 source = 请求在宿主 forAdapter 崩溃）。
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
      // 0.6.0 复查修复（R1）：空串不可能被"写进"前缀造成漂移，但 ''.includes('') === true
      // 会让任何空值动态字段误抛 DynamicInPrefixError、合法装配中断——跳过空值。
      if (value !== '' && this.#prefix[0].content.includes(value)) {
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

  /** 稳定段 = 稳定前缀 ++ 追加区（不含易变尾）。v0.4.2：assistant 块的 source 随装配
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
   * 0.6.0（RA-1）：装配投影快照——只读，供 AssemblyPlan 纯函数投影使用。
   * 不改变任何渲染状态（不 render、不推进基线）；返回的是当前四段 + 追加块 + 易变尾的
   * 逐字节副本，调用方可以连续调用 20 次得到完全一致的结果。
   */
  assemblySnapshot()   
                                                                                         
                                                                                                              
                                                                
    {
    return {
      parts: { ...this.#prefixParts },
      append: this.#appendBlocks.map((b) => ({
        kind: b.kind,
        role: b.role,
        content: b.content,
        ...(b.source === undefined ? {} : { source: b.source }),
      })),
      // 与 renderTail 逐块对齐：易变动态块（每请求重建）排在易变尾最前面。
      tail: [
        ...(this.#volatileDynamics.size === 0
          ? []
          : [{
              role: 'user'               ,
              content: [
                '[动态上下文（易变尾，每请求重建）]',
                ...[...this.#volatileDynamics.keys()].sort().map((k) => `${k}: ${this.#volatileDynamics.get(k)}`),
              ].join('\n'),
            }]),
        ...this.#tailBlocks.map((b) => ({ role: b.role, content: b.content })),
      ],
    };
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
   * 模型请求"压缩历史"：0.4.x 一律拒绝（红线 4 禁止智能压缩/摘要/改写中间内容），
   * 降级为整块尾部截断并记录。绝不静默。
   * 0.5.0 P3：合法压缩走 dropAppendHead + kernel/compaction.ts 的确定性摘要——
   * 摘要替换被丢弃块（compression 后追加，原文句柄化），本方法保留为"模型侧主动
   * 请求压缩"的拒绝面（模型不能自己触发换基）。
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

  // ------------------------------------------------------------- 0.5.0 计划性换基

  /**
   * 0.5.0（§8.3 K8）：计划性换基——前缀非单调的第三类处置（合法路径，不是报错也不是
   * 重发）。适用：整块压缩（dropAppendHead）/ 段边界 / **通道切换**（工具面与协议段同时变化，
   * 必然破前缀；切换在任务边界执行，换基一次）。
   *
   * 行为：
   *  1. 提供了新前缀组件（system/protocol/toolSchemas/invariants 任一）→ 重建稳定前缀
   *     （通道切换 = 协议段变化，新前缀从此请求起生效）；
   *  2. 重置 preflight 基线（#lastStable = null）——下一请求是新时代第一条；
   *  3. policyLog 记 planned-rebase（accepted:true，绝不静默）。
   *
   * 调用方负责：重置 wire 承诺基线（loop #lastRequest = null）、注入
   * [tf-stream:context-rebased]（contextRebasedLine）、cache-reset 台账事件
   * （cause / contextTokens / estimatedColdCost，§8.6 实现要求 2）。
   */
  rebase(req   
                   
                    
                      
                         
                        
                              
                           
   )                        {
    const parts = {
      system: req.system ?? this.#prefixParts.system,
      protocol: req.protocol ?? this.#prefixParts.protocol,
      toolSchemas: req.toolSchemas ?? this.#prefixParts.toolSchemas,
      invariants: req.invariants ?? this.#prefixParts.invariants,
    };
    const changed = parts.system !== this.#prefixParts.system
      || parts.protocol !== this.#prefixParts.protocol
      || parts.toolSchemas !== this.#prefixParts.toolSchemas
      || parts.invariants !== this.#prefixParts.invariants;
    if (changed) {
      this.#prefixParts = parts;
      const content = [parts.system, parts.protocol, parts.toolSchemas, parts.invariants].join('\n\n');
      this.#prefix = Object.freeze([Object.freeze({ role: 'system'         , content })]);
    }
    this.#lastStable = null;
    const record                        = {
      at: this.#clock.now(),
      kind: 'planned-rebase',
      request: req.reason,
      accepted: true,
      degradedTo: 'none',
      droppedBlocks: 0,
      detail: `计划性换基（${req.reason}）：稳定前缀基线重置${changed ? '（前缀组件已更新）' : ''}${req.contextTokens !== undefined ? `，contextTokens≈${req.contextTokens}` : ''}——记账 + 模型侧可见（[tf-stream:context-rebased]），非静默`,
    };
    this.#policyLog.push(record);
    if (this.#policySink) this.#policySink(record);
    return record;
  }
}
