/**
 * kernel/final.ts —— tf-final summary 质量闸（v0.3.1「任务半途截断」修复的内核半边；
 * v0.4.0 原样继承——0.4 是在 0.3.1 基线上长出来的能力面，截断面同一套契约）
 *
 * 背景（0.3.1 真机证据，会话 `session-84274277`）：
 *   模型在任务只走到第 4 步时输出 `<tf-final id="f1" summary="placeholder"/>`，
 *   驱动器照单全收；随后模型又继续跑了 3 步，而这条**过期**的 final 仍是"最后一个
 *   ok 的 final"，回合结束时被当作最终答案落盘——用户侧看到的就是"任务做一半被截断，
 *   答案是一句 placeholder"。
 *
 * 本模块只做一件事：判定 summary 是否**根本不含最终答案**（空 / 占位词）。
 * 判定刻意保守——只抓明确的占位形态，不猜"答案够不够详细"：
 *   - 空 → 'empty'
 *   - placeholder / 占位 / TODO / TBD / N/A / 待补 / …… 之类 → 'placeholder'
 *   - 其它一律放行（"done"、"已完成" 这类短答案不在拒绝面内：宁可放过，
 *     也不把合法短答案判死——协议文本负责引导，驱动器只拦"根本没写答案"的形态）。
 *
 * 内核层纪律：纯函数、零 IO、无框架依赖。
 */

                                                            

                                    
                              
                                                    
                 
 

/** 明确的占位形态（整串匹配；大小写不敏感）。故意不含 done/已完成/null/none——
 *  这些既可能是占位也可能是任务的真实短答案，判定权留给协议与人工。 */
const PLACEHOLDER_SUMMARY_RE =
  /^(?:placeholder|placeholders|占位符?|todo|tbd|tba|n\/a|xxx+|待补充|待补|待填|待定|待完善|\.{2,}|…+|-+|—+|\?+|？+)$/i;

/** 去掉包裹引号/括号与尾部标点，得到用于判定的规范形（不改动原 summary）。 */
function normalizeSummary(summary        )         {
  return summary
    .replace(/^[\s"'`「『（([]+/, '')
    .replace(/[\s"'`」』）)\]。，,、!！?？~～:：;；]+$/, '');
}

/**
 * 检查 tf-final 的 summary。
 * 返回 null = 可以收敛（内容是否足够好不是驱动器该判的事）；否则给出可注入的结构化原因。
 */
export function checkFinalSummary(summary                    )                           {
  const raw = summary ?? '';
  const norm = normalizeSummary(raw.trim());
  if (norm === '') {
    return {
      kind: 'empty',
      detail: raw.trim() === ''
        ? 'summary 为空：tf-final 必须携带最终答案原文（数字/行内容/路径/结论）'
        : `summary 只有标点或空白（${JSON.stringify(raw)}）：tf-final 必须携带最终答案原文`,
    };
  }
  if (PLACEHOLDER_SUMMARY_RE.test(norm)) {
    return {
      kind: 'placeholder',
      detail: `summary 是占位内容（${JSON.stringify(raw)}）：占位 final 不能作为交付答案，必须写出最终答案原文（数字/行内容/路径/结论）；任务没做完就不要输出 tf-final`,
    };
  }
  return null;
}
