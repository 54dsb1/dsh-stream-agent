/**
 * kernel/obs.ts —— 观测登记与信息增益分类（M2）
 *
 * 内核层纪律：零框架依赖（不 import 任何 @deepseek-ai/*）、无 IO 副作用、
 * 全部依赖走构造注入（BlobSink 是唯一 IO 出口，默认内存实现）。
 * 本文件不 import 任何模块（连 node:crypto 都不用）——内容寻址（sha256）
 * 归 state.ts 管，这里只需要一个"内容是否变化"的判定哈希（FNV-1a 足够）。
 *
 * info_gain 三档规则表（写死，规则式分类，禁止调用模型）：
 * | info_gain | 触发条件                                       | 处理                     |
 * |-----------|-----------------------------------------------|--------------------------|
 * | high      | read/grep/glob/web/test/build 的首次输出；      | 放行注入（行骨架）        |
 * |           | 一切执行失败                                   |                          |
 * | low       | write/append/mkdir（含 bash）的成功回执         | 句柄化，不注入            |
 * | none      | 重复观测、内容哈希未变、空输出                   | 连句柄目录都不更新，只记 ledger |
 *
 * 计数器口径（对齐 08 号任务书 eval/METRICS.md：injected_ratio = injected / produced）：
 * - produced：observe() 收到的每一条观测（含 none）；
 * - injected：实际交给装配器进入模型上下文的观测负载条数——
 *   high 首次骨架、饥饿升级骨架、tf-peek 取回片段、以及 none 时回灌的
 *   "内容未变化"字面量（它同样占请求体积，如实计入）；
 * - peeked：peek() 调用次数（peek 的产出同时计入 injected，见上）。
 * 口径若变，只改上报层，不改本文件逻辑。
 */

/** 工具族：分类器的输入粒度 */
                        
                                                                   
                                                                                          
                                                                                             
                                                                   
                                                                                       
                                                                                             
                                                          // 未识别工具：默认按 low（默认不回灌）

                                               

                                   
                                                          
               
                              
              
                                                  
              
                  
                  
                                                     
                  
 

                                 
                      
                              
                 
 

                                        
                                        
                    
 

// ---------------------------------------------------------------------------
// 分类器（纯函数）
// ---------------------------------------------------------------------------

const HIGH_GAIN_FAMILIES                          = new Set([
  'read', 'grep', 'glob', 'web', 'test', 'build', 'code',
  'skill', 'agent', 'job', 'ask',
]);
const LOW_RECEIPT_FAMILIES                          = new Set([
  'write', 'append', 'mkdir', 'bash', 'office', 'goal',
]);

/** 工具名 → 工具族。tf-* 命令名与其同族名一一对应；未知工具归 other。 */
export function classifyTool(tool        )             {
  const t = tool.toLowerCase();
  if (t === 'tf-read' || t === 'read' || t === 'read_file' || t === 'cat' || t === 'read_image') return 'read';
  if (t === 'tf-write' || t === 'write' || t === 'write_file' || t === 'edit' || t === 'tf-edit' || t === 'apply_patch') return 'write';
  if (t === 'tf-peek' || t === 'peek') return 'read';
  if (t === 'tf-bash' || t === 'bash' || t === 'shell') return 'bash';
  if (t === 'tf-code' || t === 'run_code') return 'code';
  if (t === 'tf-append' || t === 'append') return 'append';
  if (t === 'mkdir') return 'mkdir';
  if (t === 'tf-grep' || t === 'grep' || t === 'search' || t === 'grep_search') return 'grep';
  if (t === 'tf-glob' || t === 'glob' || t === 'list' || t === 'ls') return 'glob';
  if (t.startsWith('web') || t === 'fetch' || t === 'http') return 'web';
  // v0.4.0：tf-call 透传的宿主工具名归类（standard/ptc 面的对等工具）。familyHint 优先级
  // 高于前缀猜测：ask_user_question 是阻塞交互，回答必须可见（high）；skill 装载改变会话
  // 行为；subagent 的产出就是报告本体；job/schedule 的 listing/output 是内容型。
  if (t === 'ask_user_question' || t.startsWith('ask')) return 'ask';
  if (t === 'skill' || t.endsWith('_skill')) return 'skill';
  if (t === 'subagent' || t === 'subagent_fork' || t === 'workflow' || t === 'task' || t === 'agent') return 'agent';
  if (t.startsWith('job_')) return 'job';
  if (t.startsWith('schedule_')) return 'job';
  if (t.startsWith('office_') || t === 'present') return 'office';
  if (t.startsWith('goal') || t.endsWith('_goal')) return 'goal';
  if (t === 'todo_write') return 'write';
  if (t === 'exit_plan_mode') return 'ask';
  if (t === 'test' || t === 'run_tests') return 'test';
  if (t === 'build' || t === 'compile') return 'build';
  return 'other';
}

/**
 * 规则式分类。规则表见文件头注释，顺序即优先级：
 * 失败 > 空输出 > 族别（high 族结合"是否首次/内容是否变化"判定）。
 */
export function classify(input                  , ctx                        )                 {
  if (!input.ok) {
    return { info_gain: 'high', reason: 'execution-failure' };
  }
  if (input.content === '') {
    return { info_gain: 'none', reason: 'empty-output' };
  }
  const family = classifyTool(input.tool);
  if (LOW_RECEIPT_FAMILIES.has(family)) {
    return family === 'bash'
      ? { info_gain: 'low', reason: 'successful-exec-receipt' }
      : { info_gain: 'low', reason: 'successful-write-receipt' };
  }
  if (HIGH_GAIN_FAMILIES.has(family)) {
    const hash = hashContent(input.content);
    // 首次（无历史）或内容已变化（新版本）→ high；重复且哈希未变 → none
    if (ctx?.lastHash === undefined) {
      return { info_gain: 'high', reason: `first-observation:${family}` };
    }
    if (ctx.lastHash === hash) {
      return { info_gain: 'none', reason: 'duplicate-observation' };
    }
    return { info_gain: 'high', reason: `content-changed:${family}` };
  }
  // other：未知工具，保守处理为低增益回执（默认不回灌哲学）
  return { info_gain: 'low', reason: 'unknown-tool-receipt' };
}

// ---------------------------------------------------------------------------
// 行骨架（O1：观测三档返回）
// ---------------------------------------------------------------------------

                                                                          

                          
               
               
                  
 

                               
                     
                                 
                                                           
                                   
 

// 关键行匹配规则。同一行命中多类时按 error > class > def > import > heading 取主标签。
const KEY_LINE_RULES                                               = [
  ['error', /error|fail/i],
  ['class', /^\s*(export\s+)?(abstract\s+)?class\b|\bclass\b/],
  ['def', /^\s*(export\s+)?(async\s+)?function\b|^\s*(pub\s+|pub(?:\(crate\))?\s+)?def\s|^\s*(export\s+)?(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/],
  ['import', /^\s*(import\b|from\s+\S+\s+import\b)|\brequire\s*\(|^\s*#include\b|^\s*using\s+/],
  ['heading', /^#{1,6}\s+/],
];

function matchKeyLine(line        )                    {
  for (const [tag, re] of KEY_LINE_RULES) {
    if (re.test(line)) return tag;
  }
  return null;
}

/** 行骨架渲染：信息密度优先于字符截断（O1）。 */
export function renderSkeleton(text        )               {
  const lines = text.split('\n');
  // 去掉末尾因换行产生的空行（"a\n" → ['a', ''] 的最后一个空行不计入总行数）
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const nonEmptyRanges                          = [];
  let start                = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      if (start === null) start = i + 1;
    } else if (start !== null) {
      nonEmptyRanges.push([start, i]);
      start = null;
    }
  }
  if (start !== null) nonEmptyRanges.push([start, lines.length]);
  const keyLines            = [];
  for (let i = 0; i < lines.length; i++) {
    const tag = matchKeyLine(lines[i]);
    if (tag !== null) keyLines.push({ line: i + 1, text: lines[i], tag });
  }
  return { totalLines: lines.length, nonEmptyRanges, keyLines };
}

/** 骨架 → 确定性文本（装配器注入用；同一骨架渲染结果逐字节一致）。 */
export function skeletonToText(s              )         {
  const ranges = s.nonEmptyRanges
    .map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`))
    .join(', ');
  const keys = s.keyLines
    .map((k) => `  L${k.line} [${k.tag}] ${k.text}`)
    .join('\n');
  return `[骨架] 共 ${s.totalLines} 行\n非空区间: ${ranges || '(空)'}\n关键行:\n${keys || '  (无)'}`;
}

// ---------------------------------------------------------------------------
// 句柄目录与差分（O3）
// ---------------------------------------------------------------------------

                                                      

                              
                 
              
                  
                                           
              
                    
 

                                 
                       
                         
                       
 

/** 自 sinceSeq 以来的目录增量（O3：装配器只注入增量，不重注入整段目录）。 */
                                    
                 
              
                     
                  
              
                      
                 
 

                                
                                                                  
                                                        
                                         

                                    
                        
                      
                 
                                                     
              
                              
 

                              
                   
                   
                 
 

/** none 档回灌的字面量（README O1：返回字面量"内容未变化"） */
export const UNCHANGED_TEXT = '内容未变化'         ;

/**
 * BlobSink：唯一 IO 出口（红线）。与 state.ts 的 BlobSink 结构兼容——
 * 02 号工作包落地后由适配层（07）把它的实现注入进来；缺省用内存实现。
 */
                           
                                          
 

export class InMemoryBlobSink                     {
          map = new Map                ();
  put(ref        , content        )       {
    this.map.set(ref, content);
  }
  get(ref        )                     {
    return this.map.get(ref);
  }
}

                                   
                                                     
                               
                         
                  
     
                                                   
                                                   
     
                       
 

                            
                 
              
                  
                   
                  
                 
 

                     
                 
              
                  
              
 

const DEFAULT_STARVATION_THRESHOLD = 5;

/**
 * 观测账本：登记 + 分类 + 骨架 + 目录差分 + 计数器 + 饥饿防线。
 * 0.5.0 增：已投递 span 账本（§7.3(2)，D5 修复——重复取回同一区间不再重复付费）、
 * request:N 句柄别名（§7.6）、取回度量（§7.4）。
 * 每个任务一个实例（reset() 或直接 new）。
 */
export class ObservationLedger {
                   threshold        ;
                   sink          ;
                   spanLedgerEnabled         ;

          seqCounter = 0;
                   contentByHandle = new Map                ();
                   lastHashByKey = new Map                ();
                   versionByKey = new Map                ();
                   handleByKey = new Map                ();
                   dirByKey = new Map                          ();
                   lowRecords              = [];
                   ledger                      = [];

  // ---- 0.5.0：span 账本与取回度量（§7.3/§7.4）----
  /** 已投递区间账本：handle → [{from,to,req,contentHash}]。spanLedger=false 时不写入（回退点）。 */
                   deliveredSpans = new Map                         ();
  /** handle → 最近一次投递时的全文哈希（变化检测：正文变了就不能说 [unchanged]）。 */
                   hashByHandle = new Map                ();
  /** request:N → 该请求句柄化的段句柄（长上下文压缩段的取回别名）。 */
                   handlesByRequest = new Map                  ();
  /** 取回请求计数（tf-peek 语义的调用数；§7.4 peek_requests_per_task 分子）。 */
          peekRequestTotal = 0;
  /** 命中已投递且未变化的取回数（redundant_peek_ratio 分子；命中即省一次正文投递）。 */
          redundantHits = 0;
  /** 取回原文累计字节（deref_bytes）。 */
          derefBytes = 0;
  /** 产出原文累计字节（produced_bytes：observe() 收到的内容字节合计）。 */
          producedBytes = 0;
  /** 每 handle 取回次数（k_mean 用）。 */
                   peekCountByHandle = new Map                ();

          injectedTotal = 0;
          producedTotal = 0;
          peekedTotal = 0;
          drySteps = 0;

  constructor(options                   = {}) {
    const t = options.starvationThreshold ?? DEFAULT_STARVATION_THRESHOLD;
    if (!Number.isInteger(t) || t < 1) {
      throw new RangeError(`starvationThreshold must be an integer >= 1, got ${options.starvationThreshold}`);
    }
    this.threshold = t;
    this.sink = options.sink ?? new InMemoryBlobSink();
    this.spanLedgerEnabled = options.spanLedger !== false;
  }

  // ------------------------------------------------------------------
  // 0.5.0 span 账本（§7.3(2)）：已投递区间去重（D5 修复）
  // ------------------------------------------------------------------

  /**
   * 登记一次"已投递"（read/peek 的正文进入模型上下文时调用）。
   * spanLedger=false（回退点）时只计数不记账（行为等价 0.4.0）。
   */
  recordDelivered(handle        , fromLine        , toLine        , requestSeq        )       {
    if (!this.spanLedgerEnabled) return;
    const content = this.contentByHandle.get(handle);
    if (content === undefined) return;
    const lines = content.split('\n');
    const from = Math.max(1, Math.floor(fromLine));
    const to = Math.min(lines.length, Math.floor(toLine));
    if (from > to) return;
    const contentHash = this.hashByHandle.get(handle) ?? hashContent(content);
    const spans = this.deliveredSpans.get(handle) ?? [];
    spans.push({ from, to, req: requestSeq, contentHash });
    this.deliveredSpans.set(handle, spans);
  }

  /** 查询某句柄的已投递区间（账本只读视图；测试/审计用）。 */
  deliveredSpanList(handle        )                           {
    return this.deliveredSpans.get(handle) ?? [];
  }

  /**
   * span 感知取回（§7.3(2)）：tf-peek 与回灌通道共用。
   *  - 命中已投递且内容哈希未变 → { kind:'unchanged', line }（一行 ~20 token，不返回正文）；
   *  - 部分重叠（同内容哈希的已投递段与请求区间相交但不覆盖）→ 只返回**新增**区间正文 + 一行说明；
   *  - 无重叠（或账本关闭）→ 正常返回正文；
   *  - 未知句柄 → null（调用方上报，内核不静默吞）。
   */
  peekWithLedger(handle        , fromLine        , toLine        , requestSeq        , options                             )                        {
    const content = this.contentByHandle.get(handle);
    if (content === undefined) return null;
    this.peekedTotal++;
    // countRequest=false：自动完整反馈（非模型主动取回）不进取回度量——§7.4 的
    // peek_requests_per_task / k_mean 度量的是"由取回引起的"请求（模型 tf-peek）。
    if (options?.countRequest !== false) {
      this.peekRequestTotal++;
      this.peekCountByHandle.set(handle, (this.peekCountByHandle.get(handle) ?? 0) + 1);
    }
    const lines = content.split('\n');
    const from = Math.max(1, Math.floor(fromLine));
    const to = Math.min(lines.length, Math.floor(toLine));
    if (from > to) return { kind: 'content', handle, from, to, text: '', note: '空区间' };
    const currentHash = this.hashByHandle.get(handle) ?? hashContent(content);
    // 有效账本 = 同内容哈希的投递记录（正文已变化的历史投递不算数）
    const spans = this.spanLedgerEnabled
      ? (this.deliveredSpans.get(handle) ?? []).filter((s) => s.contentHash === currentHash)
      : [];
    const fullyCovered = spans.some((s) => s.from <= from && s.to >= to);
    if (fullyCovered) {
      this.redundantHits++;
      const lastReq = spans
        .filter((s) => s.from <= from && s.to >= to)
        .reduce((m, s) => Math.max(m, s.req), 0);
      return {
        kind: 'unchanged',
        handle,
        from,
        to,
        line: `[unchanged] ${handle} L${from}-${to}（与 req#${lastReq} 投递内容一致，未变化）`,
      };
    }
    const missing = subtractSpans(from, to, spans);
    const overlapChars = spans.reduce((n, s) => n + (Math.min(s.to, to) - Math.max(s.from, from) + 1 > 0 ? Math.min(s.to, to) - Math.max(s.from, from) + 1 : 0), 0);
    if (missing.length > 0 && overlapChars > 0) {
      // 部分重叠：仅返回新增区间并附一行说明（§7.3(2)）
      const text = missing.map(([a, b]) => lines.slice(a - 1, b).join('\n')).join('\n');
      const missingDesc = missing.map(([a, b]) => (a === b ? `L${a}` : `L${a}-${b}`)).join(', ');
      this.derefBytes += Buffer.byteLength(text, 'utf8');
      this.injectedTotal++;
      return { kind: 'partial', handle, from, to, text, note: `已投递区间不重发（${overlapChars} 字符省略）；新增区间 ${missingDesc}` };
    }
    // 无重叠：正常返回正文
    const text = lines.slice(from - 1, to).join('\n');
    this.derefBytes += Buffer.byteLength(text, 'utf8');
    this.injectedTotal++; // peek 产出进入上下文，按口径计入 injected
    return { kind: 'content', handle, from, to, text };
  }

  /**
   * request:N 句柄别名（§7.6 长上下文取回）：压缩段句柄化后按请求序号登记，
   * `resolveHandleRef('request:12')` → 该请求句柄化的段句柄列表。
   */
  registerRequestHandle(requestSeq        , handle        )       {
    const list = this.handlesByRequest.get(requestSeq) ?? [];
    if (!list.includes(handle)) list.push(handle);
    this.handlesByRequest.set(requestSeq, list);
  }

  /** 解析 handle 引用：'request:N' → 段句柄数组；普通句柄 → 原样单元素。 */
  resolveHandleRef(ref        )           {
    const m = /^request:(\d+)$/.exec(ref.trim());
    if (m !== null) return [...(this.handlesByRequest.get(Number(m[1])) ?? [])];
    return [ref];
  }

  /** 取回度量（§7.4）：peek_requests_per_task / redundant_peek_ratio / deref/produced / k_mean。 */
  peekMetrics()              {
    let kSum = 0;
    for (const n of this.peekCountByHandle.values()) kSum += n;
    const kHandles = this.peekCountByHandle.size;
    return {
      peekRequests: this.peekRequestTotal,
      redundantHits: this.redundantHits,
      redundantPeekRatio: this.peekRequestTotal > 0 ? this.redundantHits / this.peekRequestTotal : 0,
      derefBytes: this.derefBytes,
      producedBytes: this.producedBytes,
      derefRatio: this.producedBytes > 0 ? this.derefBytes / this.producedBytes : 0,
      kMean: kHandles > 0 ? kSum / kHandles : 0,
    };
  }

  /** 登记一条工具产出观测，返回三档结果（O1）。 */
  observe(input                  )                    {
    this.producedTotal++;
    this.producedBytes += Buffer.byteLength(input.content, 'utf8');
    const family = classifyTool(input.tool);
    const cls = classify(input, { lastHash: this.lastHashByKey.get(input.key) });
    const seq = ++this.seqCounter;

    if (cls.info_gain === 'none') {
      // none：连句柄目录都不更新，只记 ledger。回灌字面量计入 injected（占请求体积）。
      this.ledger.push({
        handle: this.handleByKey.get(input.key) ?? '',
        key: input.key,
        family,
        version: this.versionByKey.get(input.key) ?? 0,
        seq,
        info_gain: 'none',
        reason: cls.reason,
      });
      this.injectedTotal++;
      return {
        handle: this.handleByKey.get(input.key) ?? null,
        info_gain: 'none',
        reason: cls.reason,
        seq,
        payload: { kind: 'unchanged', text: UNCHANGED_TEXT },
      };
    }

    // high / low：新版本入库（内容哈希变化才到这里）
    const version = (this.versionByKey.get(input.key) ?? 0) + 1;
    const callId = input.callId ?? `c${seq}`;
    const handle = `obs:${family}:${callId}@v${version}`;
    const hash = hashContent(input.content);

    this.contentByHandle.set(handle, input.content);
    this.sink.put(handle, input.content);
    this.hashByHandle.set(handle, hash);
    this.versionByKey.set(input.key, version);
    this.lastHashByKey.set(input.key, hash);
    this.handleByKey.set(input.key, handle);

    const prev = this.dirByKey.get(input.key);
    if (prev) {
      prev.handle = handle;
      prev.version = version;
      prev.lastSeq = seq;
      prev.stale = false;
    } else {
      this.dirByKey.set(input.key, {
        handle, key: input.key, version, firstSeq: seq, lastSeq: seq, stale: false,
      });
    }

    this.ledger.push({
      handle, key: input.key, family, version, seq,
      info_gain: cls.info_gain, reason: cls.reason,
    });

    if (cls.info_gain === 'high') {
      const skeleton = renderSkeleton(input.content);
      this.injectedTotal++;
      return {
        handle,
        info_gain: 'high',
        reason: cls.reason,
        seq,
        payload: { kind: 'skeleton', skeleton, rendered: skeletonToText(skeleton) },
      };
    }

    // low：句柄化，不注入；登记进 lowRecords 供饥饿防线升级
    this.lowRecords.push({ handle, key: input.key, content: input.content, seq });
    return {
      handle,
      info_gain: 'low',
      reason: cls.reason,
      seq,
      payload: { kind: 'receipt', handle, note: '句柄化，不注入' },
    };
  }

  /**
   * tf-peek：按行段取回句柄内容（O2 内核侧支持）。1-based 闭区间，越界收敛。
   * 未知句柄返回 null（调用方决定如何上报，内核不静默吞）。
   */
  peek(handle        , fromLine        , toLine        )                {
    const content = this.contentByHandle.get(handle);
    if (content === undefined) return null;
    this.peekedTotal++;
    this.injectedTotal++; // peek 产出进入上下文，按口径计入 injected
    const lines = content.split('\n');
    const from = Math.max(1, Math.floor(fromLine));
    const to = Math.min(lines.length, Math.floor(toLine));
    if (from > to) return '';
    return lines.slice(from - 1, to).join('\n');
  }

  /** 标记句柄失效（如文件被外部删除/覆盖）。返回新 seq 供装配器推进游标；未知 key 返回 null。 */
  markStale(key        )                {
    const entry = this.dirByKey.get(key);
    if (!entry) return null;
    entry.stale = true;
    entry.lastSeq = ++this.seqCounter;
    return entry.lastSeq;
  }

  /** 句柄目录差分（O3）：added / changed / stale 三列表，按 seq 升序。 */
  directoryDelta(sinceSeq        )                 {
    const delta                 = { added: [], changed: [], stale: [] };
    const entries = [...this.dirByKey.values()].sort((a, b) => a.lastSeq - b.lastSeq);
    for (const e of entries) {
      if (e.lastSeq <= sinceSeq) continue;
      const out              = {
        handle: e.handle, key: e.key, version: e.version, seq: e.lastSeq,
        status: e.stale ? 'stale' : e.version === 1 ? 'added' : 'changed',
      };
      if (e.stale) delta.stale.push(out);
      else if (e.version === 1) delta.added.push(out);
      else delta.changed.push(out);
    }
    return delta;
  }

  /**
   * 饥饿防线（M2 关键防线）：每个 step 结束时由 loop 调用。
   * 连续 threshold 步没有任何 high 注入 → 把最近一条 low 观测的骨架
   * 升格注入，防止模型在信息真空中瞎猜。触发后计数清零（再连续 N 步可再次触发）。
   * 无 low 观测可升级时不触发、不清零（继续等待）。
   */
  noteStep(highInjectedThisStep         )                           {
    if (highInjectedThisStep) {
      this.drySteps = 0;
      return null;
    }
    this.drySteps++;
    if (this.drySteps < this.threshold || this.lowRecords.length === 0) return null;
    this.drySteps = 0;
    const rec = this.lowRecords[this.lowRecords.length - 1];
    const skeleton = renderSkeleton(rec.content);
    this.injectedTotal++;
    return {
      handle: rec.handle,
      info_gain: 'high',
      reason: 'starvation-promotion',
      seq: rec.seq,
      payload: { kind: 'skeleton', skeleton, rendered: skeletonToText(skeleton) },
    };
  }

  counters()              {
    return { injected: this.injectedTotal, produced: this.producedTotal, peeked: this.peekedTotal };
  }

  /** injected_ratio = injected / produced（08 号 METRICS.md 口径；produced=0 时为 0） */
  injectedRatio()         {
    if (this.producedTotal === 0) return 0;
    return this.injectedTotal / this.producedTotal;
  }

  /** 追加只读的观测流水（审计用，最旧在前） */
  records()                               {
    return this.ledger;
  }

  /** 任务结束/新任务开始：清空全部状态（计数器一并清零，口径为"每任务"） */
  reset()       {
    this.seqCounter = 0;
    this.contentByHandle.clear();
    this.lastHashByKey.clear();
    this.versionByKey.clear();
    this.handleByKey.clear();
    this.dirByKey.clear();
    this.lowRecords.length = 0;
    this.ledger.length = 0;
    this.injectedTotal = 0;
    this.producedTotal = 0;
    this.peekedTotal = 0;
    this.drySteps = 0;
    // 0.5.0：span 账本与取回度量同口径清零（每任务）
    this.deliveredSpans.clear();
    this.hashByHandle.clear();
    this.handlesByRequest.clear();
    this.peekRequestTotal = 0;
    this.redundantHits = 0;
    this.derefBytes = 0;
    this.producedBytes = 0;
    this.peekCountByHandle.clear();
  }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * FNV-1a 64bit，仅用于"内容是否变化"判定（碰撞概率对去重场景足够）。
 * 不做内容寻址——那归 state.ts 的 sha256。
 */
function hashContent(s        )         {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

// ---------------------------------------------------------------------------
// 0.5.0 span 账本类型与区间运算（§7.3(2)，D5 修复）
// ---------------------------------------------------------------------------

/** 已投递区间（1-based 闭区间；contentHash = 投递时的全文哈希，变化检测用）。 */
                                
               
             
                                                     
              
                      
 

/** span 感知取回结果（peekWithLedger 的返回；kind 决定调用方注入形态）。 */
                            
                                                                                 
                                                                                             
                                                                                               

/** 取回度量（§7.4 指标表）。 */
                              
                             
                       
                      
                        
                                       
                             
                 
                     
                 
                        
                                               
                     
                                    
                
 

/** 从 [from,to] 中减去已覆盖区间（区间并集裁剪；结果为未覆盖子区间，升序）。 */
function subtractSpans(from        , to        , covered                          )                          {
  const sorted = [...covered].filter((s) => s.to >= from && s.from <= to).sort((a, b) => a.from - b.from);
  const out                          = [];
  let cursor = from;
  for (const s of sorted) {
    if (s.from > cursor) out.push([cursor, Math.min(s.from - 1, to)]);
    cursor = Math.max(cursor, s.to + 1);
    if (cursor > to) break;
  }
  if (cursor <= to) out.push([cursor, to]);
  return out.filter(([a, b]) => a <= b);
}

// ---------------------------------------------------------------------------
// 0.5.0 read 索引（§7.3(1)）：截断改为"索引 + 请求窗 + 覆盖图"（D4 修复）
// ---------------------------------------------------------------------------

/** 行锚（每 anchorEvery 行一个；含顶层符号）。 */
                             
               
               
 

/** 顶层符号判定（索引锚点的"含顶层符号"要求；规则式，不调模型）。 */
const TOP_LEVEL_SYMBOL_RE = /^\s*(?:export\s+)?(?:abstract\s+)?(?:class|function|def|const|let|var|interface|type|enum|async\s+function|public|private|protected)\b|^#{1,6}\s+/;

                                   
                                
                       
                                    
                         
                          
                                                          
 

/**
 * 生成 read 索引（头信息 + 行锚 + 未投递区间）。索引成本约为文件体积的 1–3%；
 * 未投递区间显式列出，模型无需推断已读范围。
 */
export function renderReadIndex(content        , opts                   = {})         {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const anchorEvery = Math.max(1, opts.anchorEvery ?? 200);
  const maxIndexChars = Math.max(200, opts.maxIndexChars ?? 2000);
  const bytes = Buffer.byteLength(content, 'utf8');
  const kb = bytes >= 1024 ? `${Math.round(bytes / 1024)}KB` : `${bytes}B`;
  const head = `[tf-stream:read] ${lines.length.toLocaleString('en-US')} 行 / ${kb}`;

  // 已投递覆盖图
  const delivered = opts.delivered ?? [];
  const deliveredDesc = delivered
    .map((s) => `L${s.from}-${s.to}`)
    .join(' + ');

  // 行锚：每 anchorEvery 行一个，且优先含顶层符号的行（若该窗口内有）
  const anchors               = [];
  for (let start = 0; start < lines.length; start += anchorEvery) {
    const window = lines.slice(start, Math.min(start + anchorEvery, lines.length));
    let picked = -1;
    for (let i = 0; i < window.length; i++) {
      if (TOP_LEVEL_SYMBOL_RE.test(window[i] )) {
        picked = start + i;
        break;
      }
    }
    if (picked === -1 && window.length > 0) picked = start;
    if (picked >= 0) anchors.push({ line: picked + 1, text: lines[picked] .trim().slice(0, 120) });
  }

  // 未投递区间 = [1, total] − 已投递
  const undelivered = subtractSpans(1, lines.length, delivered.map((s) => ({ from: s.from, to: s.to, req: 0, contentHash: '' })));
  const undeliveredDesc = undelivered.map(([a, b]) => (a === b ? `L${a}` : `L${a}-${b}`)).join(', ');

  // R9：索引本身超预算 → 只给符号名（丢锚文本，保留行号）
  let body = anchors.map((a) => `  L${a.line} ${a.text}`).join('\n');
  if (head.length + 1 + body.length > maxIndexChars) {
    body = anchors.map((a) => `  L${a.line} ${symbolNameOf(a.text)}`).join('\n');
  }

  const parts = [head];
  if (deliveredDesc !== '') parts.push(`已投递 ${deliveredDesc}`);
  if (body !== '') parts.push(`索引（每 ${anchorEvery} 行一个锚，含顶层符号）：\n${body}`);
  if (undeliveredDesc !== '') {
    parts.push(`未投递区间：${undeliveredDesc} → 用 tf-peek handle=... from_line=.. to_line=.. 取回`);
  }
  return parts.join('\n');
}

/** 从锚文本提取符号名（R9 降级形态：只给符号名不给行内容）。 */
function symbolNameOf(text        )         {
  const m = /(?:class|function|def|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(text);
  return m !== null ? m[1]  : text.split(/\s+/)[0]?.slice(0, 40) ?? '(空)';
}

/**
 * §7.5 双旋钮的读取侧投影：maxReadChars 之内投正文（带覆盖图），超出只投索引。
 * maxReadChars ≤ 0 = 关闭索引化（回退点：0.4.x 头部截断行为）。
 */
export function readFeedbackPlan(
  content        ,
  maxReadChars        ,
  delivered                                              = [],
)                                                                     {
  if (maxReadChars > 0 && content.length > maxReadChars) {
    return { kind: 'index', text: renderReadIndex(content, { delivered }) };
  }
  return { kind: 'inline', text: content };
}
