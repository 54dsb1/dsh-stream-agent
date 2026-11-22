// kernel/compaction.ts —— 确定性上下文压缩（0.5.0 P3；计划书 §7.6）
//
// 硬约束（§7.6 表格末行）：摘要为**纯函数**，零 IO，不调模型。
// 摘要规则（对齐上游 thinkflow `_build_summary` 的确定性纪律；只做提取、截断、拼接，
// 不做语义归纳）：
//   · 每条消息压成一行，max_item_chars = 900，超出保留头尾；
//   · 工具消息保留 tool + 参数摘要 + 状态 + 字节数；失败保留 stderr 前 N 字符；
//   · write / edit 保留 path + 行数变化，不保留 diff 全文；
//   · 保留最近 keepRecent 条不压（档位设定：12 / 30 / 60）；
//   · 摘要总长 maxSummaryChars（8k / 16k / 32k），超出按"最旧先丢"收敛到上限内；
//   · 原文去向：OutputStore + handle（调用方负责句柄化；本模块只产出摘要文本）。
//
// 压缩前提（§5.4 K5）：本插件状态有宿主可寻址的名字（obs:<family>:<callId>@v<n>、
// path@v<n>、[a1] 计划项），删文本 ≠ 删状态——被压缩的原文可按句柄 tf-peek 取回。
// 摘要行携带 handle（有则带），保证"压缩后 handle 仍可取回"（G2）。
//
// 内核层纪律：零框架依赖、无 IO、确定性（同输入同字节）。

/** 压缩强度（档位值）：影响条目行内保留的尾部字符比例——aggressive 保留最少。 */
                                                                               

                                  
                                                  
                
                                             
                  
                                         
                  
              
                 
                                                  
                     
                                   
                      
                                       
                  
 

                              
                                      
                  
                         
 

                                 
                                
                     
                                      
                          
                                        
                                 
                        
                                     
                           
 

                                
                                                      
                      
                                     
                               
                 
                         
                                        
                       
 

/** 单条摘要行字符上限（§7.6：max_item_chars = 900）。 */
export const DEFAULT_MAX_ITEM_CHARS = 900;
/** 失败条目保留的 stderr 头部字符数。 */
export const DEFAULT_STDERR_HEAD_CHARS = 200;

/**
 * 压缩一批消息：前 (n − keepRecent) 条折叠为确定性摘要，最近 keepRecent 条原样保留。
 * 输入不足 keepRecent + 1 时不压缩（summaryText=''，compactedCount=0）。
 */
export function compactItems(items                        , opts                )                {
  const keepRecent = Math.max(0, Math.floor(opts.keepRecent));
  const maxItemChars = Math.max(80, opts.maxItemChars ?? DEFAULT_MAX_ITEM_CHARS);
  const stderrHead = Math.max(0, opts.stderrHeadChars ?? DEFAULT_STDERR_HEAD_CHARS);
  const compactableCount = items.length - keepRecent;
  if (compactableCount <= 0) {
    return { summaryText: '', kept: [...items], compactedCount: 0, summaryChars: 0 };
  }
  const toCompact = items.slice(0, compactableCount);
  const kept = items.slice(compactableCount);

  // aggressiveness 只影响条目行内"尾保留"比例：aggressive 尾部 10%，
  // balanced 20%，conservative 30%（头部恒 70% 基线内按剩余分配）。
  const tailRatio = opts.aggressiveness === 'aggressive' ? 0.1 : opts.aggressiveness === 'balanced' ? 0.2 : 0.3;

  const lines           = [];
  for (const item of toCompact) {
    lines.push(summaryLineFor(item, { maxItemChars, tailRatio, stderrHead }));
  }

  // 摘要总长收敛（§7.6）：超 maxSummaryChars 按"最旧先丢"删行，直到 ≤ 上限
  //（或只剩头部标记行）。被丢行的事实仍在句柄/台账里，摘要不承载全部历史。
  const header = `[tf-stream:summary] 已压缩 ${toCompact.length} 条旧消息（原文已句柄化，可 tf-peek 取回；只做提取截断拼接，无语义归纳）：`;
  let body = lines;
  const fits = (ls                   )         => (ls.length === 0 ? header.length : header.length + 1 + ls.join('\n').length);
  while (body.length > 0 && fits(body) > opts.maxSummaryChars) {
    body = body.slice(1); // 最旧先丢
  }
  const summaryText = body.length === 0
    ? `${header}（全部条目超出摘要上限；原文按句柄取回）`
    : `${header}\n${body.join('\n')}`;
  return {
    summaryText,
    kept,
    compactedCount: toCompact.length,
    summaryChars: summaryText.length,
  };
}

/** 单条消息 → 一行摘要（确定性；同输入同字节）。 */
function summaryLineFor(
  item             ,
  ctx                                                                 ,
)         {
  const meta = item.meta ?? {};
  const roleTag = item.role === 'assistant' ? 'assistant' : item.role === 'tool' ? 'tool' : 'user';
  const handle = meta.handle !== undefined && meta.handle !== '' ? ` handle=${meta.handle}` : '';
  // write/edit：保留 path + 行数变化，不保留 diff 全文（§7.6）
  if (meta.pathDelta !== undefined && meta.pathDelta !== '') {
    return `- ${roleTag}${handle} ${meta.tool ?? 'write'} ${meta.pathDelta}`;
  }
  // 工具消息：tool + 参数摘要 + 状态 + 字节数；失败保留 stderr 头部
  if (roleTag === 'tool' && (meta.tool !== undefined || meta.status !== undefined)) {
    const parts = [`- ${roleTag}${handle}`];
    if (meta.tool !== undefined) parts.push(meta.tool);
    if (meta.target !== undefined && meta.target !== '') parts.push(oneLine(meta.target, 120));
    if (meta.status !== undefined) parts.push(meta.status);
    if (meta.bytes !== undefined) parts.push(`${meta.bytes}B`);
    const head = meta.stderrHead !== undefined && meta.stderrHead !== ''
      ? ` stderr=${oneLine(meta.stderrHead, ctx.stderrHead)}`
      : '';
    return `${parts.join(' ')}${head}`;
  }
  // 其余：一行化 + 头尾保留（超出 maxItemChars 按 head 70% / tail ratio 切）
  return `- ${roleTag}${handle} ${clampHeadTail(oneLine(item.content, Number.POSITIVE_INFINITY), ctx.maxItemChars, ctx.tailRatio)}`;
}

/** 压成单行（换行/连续空白归一），超 max 按显示字符截断。 */
function oneLine(text        , max        )         {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max))}…`;
}

/** 头尾保留（head 70% 基线 + tail ratio；中段省略说明）。 */
function clampHeadTail(text        , maxChars        , tailRatio        )         {
  if (text.length <= maxChars) return text;
  const head = Math.max(1, Math.floor(maxChars * (1 - tailRatio)));
  const tail = Math.max(0, Math.floor(maxChars * tailRatio));
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}…（省略 ${omitted} 字符）…${tail > 0 ? text.slice(text.length - tail) : ''}`;
}

// ---------------------------------------------------------------------------
// 语义状态摘要（§5.6(2)）：一行 ~30 token，替代模型重读测试输出自行判断
// ---------------------------------------------------------------------------

                                   
                                   
                 
             
                    
                      
                                                     
              
                  
 

/**
 * 一行语义状态（[tf-stream:state]）：目标 N 项 · 已验证 x · 未验证 y（ids）· 失败 z。
 * 标准通道经回灌注入；代码通道经 S5 快照注入（systemPrompt.context，替换旧快照）。
 */
export function renderStateDigest(input                  )                {
  if (input.goals === undefined && input.verified === undefined && input.failed === undefined) return null;
  const goals = input.goals ?? 0;
  const verified = input.verified ?? 0;
  const open = input.open ?? [];
  const failed = input.failed ?? 0;
  const openIds = open.map((o) => o.id).join(', ');
  const parts = [
    `目标 ${goals} 项`,
    `已验证 ${verified}`,
    open.length > 0 ? `未验证 ${open.length}（${openIds}）` : '未验证 0',
    `失败 ${failed}`,
  ];
  return `[tf-stream:state] ${parts.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// 效果压缩（§5.6(1)）：动作生效且验证通过后，程序体 + 原始输出折叠为一行
// ---------------------------------------------------------------------------

                                    
                     
                   
                                     
                 
                              
                 
                           
                   
                         
                    
                                      
                                         
                           
                    
                       
                  
                                     
                                                                                            
 

/**
 * 效果行（§5.6 形态）：
 *   [applied p7] edit src/app.ts → v3 (+42/−8) · verify a1 pass · handle=obs:edit:p7@v3
 * 代码通道折叠单元是 run_code 整次调用：
 *   [applied p7] run_code → 3 calls · fs.edit src/app.ts → v3 (+42/−8) · pwsh test pass
 * 保留：目标、版本、diffstat、验证状态、句柄。丢弃：程序文本、原始 stdout。
 */
export function renderEffectLine(input                   )         {
  const head = `[applied ${input.effectId}]`;
  if (input.calls !== undefined && input.calls.length > 0) {
    const details = input.calls
      .map((c) => `${c.tool} ${c.target}${c.version === undefined ? '' : ` → v${c.version}`}${c.status === 'pass' || c.status === 'ok' ? '' : ` ${c.status}`}`)
      .join(' · ');
    return `${head} ${input.action} → ${input.calls.length} calls · ${details}`;
  }
  const target = input.version === undefined
    ? input.target
    : `${input.target} → v${input.version}`;
  const stat = input.diffstat !== undefined && input.diffstat !== '' ? ` (${input.diffstat})` : '';
  const verify = input.acceptId !== undefined ? `verify ${input.acceptId} ${input.verify}` : `verify ${input.verify}`;
  const handle = input.handle !== undefined && input.handle !== '' ? ` · handle=${input.handle}` : '';
  return `${head} ${input.action} ${target}${stat} · ${verify}${handle}`;
}

/**
 * 效果折叠判定（§5.6）：不折叠条件 = 未验证、失败、或最近 keepRecent=3 个程序内。
 * 入参为"该效果是否已验证"与"它距离最新效果的序差"。
 */
export function shouldElideEffect(verify                                , recencyFromNewest        , keepRecent        )          {
  if (verify !== 'pass') return false;
  return recencyFromNewest >= keepRecent;
}

// ---------------------------------------------------------------------------
// 跨回合工作集（§5.6(3)）
// ---------------------------------------------------------------------------

/**
 * [unchanged] 行（标准通道）：与某次请求投递的内容一致、未变化——不重投正文。
 * 代码通道退化形态用 renderSeenStamp。
 */
export function renderUnchangedLine(path        , range                              , version        , requestSeq        )         {
  return `[unchanged] ${path} L${range.from}-${range.to} @v${version}（与 req#${requestSeq} 投递内容一致，未变化）`;
}

/** 代码通道版本戳提示：只能提示"未变化"，不能代替内容。 */
export function renderSeenStamp(path        , version        )         {
  return `[seen] ${path} @v${version}`;
}
