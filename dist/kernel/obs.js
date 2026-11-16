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
]);
const LOW_RECEIPT_FAMILIES                          = new Set([
  'write', 'append', 'mkdir', 'bash',
]);

/** 工具名 → 工具族。tf-* 命令名与其同族名一一对应；未知工具归 other。 */
export function classifyTool(tool        )             {
  const t = tool.toLowerCase();
  if (t === 'tf-read' || t === 'read' || t === 'read_file' || t === 'cat') return 'read';
  if (t === 'tf-write' || t === 'write' || t === 'write_file' || t === 'edit') return 'write';
  if (t === 'tf-peek' || t === 'peek') return 'read';
  if (t === 'tf-bash' || t === 'bash' || t === 'shell') return 'bash';
  if (t === 'tf-code' || t === 'run_code') return 'code';
  if (t === 'append') return 'append';
  if (t === 'mkdir') return 'mkdir';
  if (t === 'grep' || t === 'search' || t === 'grep_search') return 'grep';
  if (t === 'glob' || t === 'list' || t === 'ls') return 'glob';
  if (t.startsWith('web') || t === 'fetch' || t === 'http') return 'web';
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
 * 每个任务一个实例（reset() 或直接 new）。
 */
export class ObservationLedger {
                   threshold        ;
                   sink          ;

          seqCounter = 0;
                   contentByHandle = new Map                ();
                   lastHashByKey = new Map                ();
                   versionByKey = new Map                ();
                   handleByKey = new Map                ();
                   dirByKey = new Map                          ();
                   lowRecords              = [];
                   ledger                      = [];

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
  }

  /** 登记一条工具产出观测，返回三档结果（O1）。 */
  observe(input                  )                    {
    this.producedTotal++;
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
