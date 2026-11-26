// kernel/limits.ts —— 用户自定义行为上限（0.5.2）
//
// 设计前提（用户要求）：**插件不预设任何行为上限**。轮数上限、上下文 token 上限、
// 取回预算、压缩保留、换基次数、重入次数、tf-code 配额等"会截断/终止工作"的数值，
// 一律由用户显式定义；未定义 = 不限制（0）。
//
// 为什么不是"给一组更宽松的默认值"：任何默认值都是插件替用户决定"干到哪算够"，
// 在长任务上必然表现为"任务干到一半被硬杀"（0.4.x 真机 session-7fbfef8f/2079562e）。
// 因此这里只有两档语义：
//   · `0` = 不限制（该项不生效；压缩类阈值不触发，配额类不拦截）；
//   · `> 0` = 用户设定的硬上限。
//
// 三层来源（优先级由低到高，后层覆盖前层）：
//   参考档位（用户显式启用时） → control.json 的 limits → 装配显式 config.limits。
// 环境变量 `STREAM_AGENT_LIMITS="maxSteps=40;maxInputTokens=48000"` 插在
// control.json 之前（便于一次性试跑，不写盘）。
//
// 内核层纪律：纯函数、零 IO、无框架依赖。

/** 行为上限的键集合（全部可配；未列出的数值不是"行为上限"，见 §调度常量）。 */
export const LIMIT_KEYS = [
  // —— 预算（N/C 双旋钮）——
  'maxSteps',
  'maxInputTokens',
  'observeBudgetTokens',
  // —— 取回与回灌 ——
  'peekBudgetChars',
  'peekAnchorEvery',
  'maxReadChars',
  'readFeedbackLimit',
  'readFeedbackBudgetPerRequest',
  'codeValueInjectLimit',
  'nativeResultLimit',
  // —— 压缩 ——
  'keepRecent',
  'maxSummaryChars',
  'segmentMaxChars',
  'effectElisionKeepRecent',
  // —— 换基与重入 ——
  'maxRebasesPerTurn',
  'maxRebasesPerSession',
  'maxReentries',
  'stallReentries',
  'closeOutRequests',
  // —— 并行与执行 ——
  'maxParallelToolCalls',
  'maxParallelBindings',
  // —— 传输（wire；xuxiang-thinkflow 出厂预设为默认，用户可随时覆盖）——
  'maxTokens',
  'thinkingBudget',
  'streamUsage',
  'maxRetries',
  'retryBackoffMs',
  // —— tf-code 配额（PTC 对齐：默认交给宿主，用户可收紧）——
  'codeMaxSubcalls',
  'codeMaxOutputBytes',
  'codeMaxWallMs',
]         ;

                                                   

                                                                      

                            
                
                  
                        
                                                                                               
             
             
                        
                              
 

export const LIMIT_SPECS                       = [
  { key: 'maxSteps', unit: 'count', group: 'budget', zh: '单任务请求数上限（轮数）', en: 'Max requests per task (rounds)' },
  { key: 'maxInputTokens', unit: 'tokens', group: 'budget', zh: '单请求上下文上限（触顶压缩）', en: 'Max input tokens per request (compacts)' },
  { key: 'observeBudgetTokens', unit: 'tokens', group: 'budget', zh: '预算观测阈值（只告警）', en: 'Observed budget threshold (warn only)' },
  { key: 'peekBudgetChars', unit: 'chars', group: 'retrieval', zh: '每回合取回字符上限', en: 'Retrieval chars per turn' },
  // 0.6.0（PE-2）：行锚间隔（行）。未设 = 200（0.5.0 默认行为不变）；100 = 更密的锚。
  { key: 'peekAnchorEvery', unit: 'count', group: 'retrieval', zh: '索引行锚间隔（行，未设 = 200）', en: 'Read-index anchor spacing (lines; unset = 200)' },
  { key: 'maxReadChars', unit: 'chars', group: 'retrieval', zh: '单次读取字符上限', en: 'Chars per read' },
  { key: 'readFeedbackLimit', unit: 'chars', group: 'retrieval', zh: '回灌截断（0 = 不截断）', en: 'Feedback truncation (0 = none)' },
  { key: 'readFeedbackBudgetPerRequest', unit: 'chars', group: 'retrieval', zh: '单请求回灌预算', en: 'Per-request feedback budget' },
  { key: 'codeValueInjectLimit', unit: 'chars', group: 'retrieval', zh: 'tf-code 结果注入上限', en: 'tf-code value inject cap' },
  { key: 'nativeResultLimit', unit: 'chars', group: 'retrieval', zh: '原生工具结果注入上限', en: 'Native tool result cap' },
  { key: 'keepRecent', unit: 'count', group: 'compaction', zh: '压缩保留最近条数', en: 'Kept recent messages when compacting' },
  { key: 'maxSummaryChars', unit: 'chars', group: 'compaction', zh: '摘要总长上限', en: 'Summary length cap' },
  { key: 'segmentMaxChars', unit: 'chars', group: 'compaction', zh: '段投影字符上限', en: 'Segment projection cap' },
  { key: 'effectElisionKeepRecent', unit: 'count', group: 'compaction', zh: '效果折叠保留最近条数', en: 'Effects kept unfolded' },
  { key: 'maxRebasesPerTurn', unit: 'count', group: 'rebase', zh: '每回合换基上限', en: 'Rebases per turn' },
  { key: 'maxRebasesPerSession', unit: 'count', group: 'rebase', zh: '每会话换基上限', en: 'Rebases per session' },
  { key: 'maxReentries', unit: 'count', group: 'rebase', zh: '重入上限', en: 'Max re-entries' },
  { key: 'stallReentries', unit: 'count', group: 'rebase', zh: '停滞重入上限（未设 = 不限制）', en: 'Stall re-entries (unset = no cap)' },
  { key: 'closeOutRequests', unit: 'count', group: 'rebase', zh: '收束期请求数（未设 = 按事由去重）', en: 'Close-out requests (unset = dedup by reason)' },
  { key: 'maxParallelToolCalls', unit: 'count', group: 'execution', zh: '同批工具并行度', en: 'Parallel tool calls' },
  { key: 'maxParallelBindings', unit: 'count', group: 'execution', zh: 'tf-code 绑定并行度（未设 = 跟随宿主）', en: 'Parallel PTC bindings (unset = host default)' },
  { key: 'maxTokens', unit: 'tokens', group: 'transport', zh: '输出预算 max_tokens（0 = 委托给 provider）', en: 'Output budget max_tokens (0 = provider default)' },
  { key: 'thinkingBudget', unit: 'tokens', group: 'transport', zh: '思考预算 budget_tokens（0 = 关闭；≥1024 才生效）', en: 'Thinking budget_tokens (0 = off; ≥1024 to enable)' },
  { key: 'streamUsage', unit: 'count', group: 'transport', zh: 'stream_options.include_usage（0 = 关 1 = 开）', en: 'stream_options.include_usage (0 = off 1 = on)' },
  { key: 'maxRetries', unit: 'count', group: 'transport', zh: '请求建立重试次数（0 = 不重试）', en: 'Request setup retries (0 = no retry)' },
  { key: 'retryBackoffMs', unit: 'ms', group: 'transport', zh: '重试退避（毫秒）', en: 'Retry backoff (ms)' },
  { key: 'codeMaxSubcalls', unit: 'count', group: 'code', zh: 'tf-code 子调用次数上限', en: 'tf-code subcall cap' },
  { key: 'codeMaxOutputBytes', unit: 'bytes', group: 'code', zh: 'tf-code 输出字节上限', en: 'tf-code output bytes cap' },
  { key: 'codeMaxWallMs', unit: 'ms', group: 'code', zh: 'tf-code 墙钟上限（毫秒）', en: 'tf-code wall clock cap (ms)' },
];

const SPEC_BY_KEY = new Map                   ();
for (const spec of LIMIT_SPECS) {
  SPEC_BY_KEY.set(spec.key, spec);
  for (const alias of spec.aliases ?? []) SPEC_BY_KEY.set(alias, spec);
}

/** 历史字段/口语写法 → 规范键（复用 LoopEntryConfig 的旧名）。 */
const LIMIT_ALIASES                                     = {
  maxRequests: 'maxSteps',
  budgetTokens: 'observeBudgetTokens',
  maxRebases: 'maxRebasesPerSession',
  peekBudget: 'peekBudgetChars',
  maxSubcalls: 'codeMaxSubcalls',
  maxOutputBytes: 'codeMaxOutputBytes',
  maxWallMs: 'codeMaxWallMs',
};

export function limitSpecOf(key        )                        {
  return SPEC_BY_KEY.get(key);
}

export function isLimitKey(value         )                    {
  return typeof value === 'string' && LIMIT_SPECS.some((s) => s.key === value);
}

/** 用户显式设定的上限集合（缺省键 = 用户未定义 = 不限制）。 */
                                                            

                                      
                      
                     
 

/**
 * 校验并归一一份用户输入：接受对象（control.json / config）或字符串
 * （`"a=1;b=2"`）。未知键、非数值、负数一律丢弃并给出告警——绝不静默。
 */
export function sanitizeLimitPatch(input         , source = 'limits')                      {
  const values              = {};
  const warnings           = [];
  const assign = (rawKey        , rawValue         )       => {
    const key = (LIMIT_ALIASES[rawKey] ?? rawKey)            ;
    const spec = limitSpecOf(key);
    if (spec === undefined) {
      warnings.push(`${source}: 未知上限键 "${rawKey}"（已忽略；可用键见 dsh-stream-agent limits）`);
      return;
    }
    const num = typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string' && rawValue.trim() !== ''
        ? Number(rawValue.trim())
        : Number.NaN;
    if (!Number.isFinite(num) || !Number.isInteger(num) || num < 0) {
      warnings.push(`${source}: ${spec.key} 的值 ${JSON.stringify(rawValue)} 非法（需 ≥0 的整数；0 = 不限制），已忽略`);
      return;
    }
    values[spec.key] = num;
  };
  if (input === undefined || input === null) return { values, warnings };
  if (typeof input === 'string') {
    for (const chunk of input.split(/[;\n,]/)) {
      const trimmed = chunk.trim();
      if (trimmed === '') continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) {
        warnings.push(`${source}: 无法解析 "${trimmed}"（应为 key=value），已忽略`);
        continue;
      }
      assign(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1));
    }
    return { values, warnings };
  }
  if (typeof input !== 'object') {
    warnings.push(`${source}: 期望对象或 "k=v;k=v" 字符串，实际是 ${typeof input}，已忽略`);
    return { values, warnings };
  }
  for (const [key, value] of Object.entries(input                           )) {
    if (value === undefined || value === null) continue;
    assign(key, value);
  }
  return { values, warnings };
}

/** 合并多层（后层覆盖前层；后层的显式 0 也算覆盖）。 */
export function mergeLimits(...layers                                        )              {
  const merged              = {};
  for (const layer of layers) {
    if (layer === undefined) continue;
    for (const spec of LIMIT_SPECS) {
      const value = layer[spec.key];
      if (typeof value === 'number') merged[spec.key] = value;
    }
  }
  return merged;
}

/** 读取生效值：未定义 → 0（不限制）。 */
export function limitOf(values                         , key          )         {
  const value = values?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 是否用户显式设过（0 也算显式：用户明确选择"不限制"）。 */
export function hasLimit(values                         , key          )          {
  return typeof values?.[key] === 'number';
}

/**
 * 三项派生规则（只在用户未显式定义时使用，且只做"同一份用户意图"的换算，
 * 不引入新上限）：
 *   · stallReentries 缺省 = maxReentries（用户只设一个就够）；
 *   · codeMaxWallMs 缺省 = 宿主 PTC runtime.timeout.maxMs（跟随宿主，不预设）。
 */
export function deriveLimits(values             , hostMaxWallMs         )              {
  const out              = { ...values };
  if (out.stallReentries === undefined && out.maxReentries !== undefined) out.stallReentries = out.maxReentries;
  if (out.codeMaxWallMs === undefined && hostMaxWallMs !== undefined && Number.isFinite(hostMaxWallMs) && hostMaxWallMs > 0) {
    out.codeMaxWallMs = Math.floor(hostMaxWallMs);
  }
  return out;
}

                                   
                     
                   
 

/** CLI 参数解析：`['maxSteps=40', 'codeMaxWallMs=0']` → patch。 */
export function parseLimitAssignments(args                   )                   {
  const patch              = {};
  const errors           = [];
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq <= 0) {
      errors.push(`无法解析 "${arg}"（应为 key=value）`);
      continue;
    }
    const key = arg.slice(0, eq).trim();
    const raw = arg.slice(eq + 1).trim();
    const parsed = sanitizeLimitPatch({ [key]: raw }, 'cli');
    errors.push(...parsed.warnings);
    Object.assign(patch, parsed.values);
  }
  return { patch, errors };
}

/** 数值展示：0 = 不限制（用户视角：这项没设）。 */
export function formatLimitValue(key          , value                    )         {
  const spec = limitSpecOf(key);
  const unit = spec?.unit ?? 'count';
  if (value === undefined) return unit === 'ms' ? '—' : '—';
  if (value === 0) return '不限制';
  if (unit === 'ms') return value >= 60_000 ? `${Math.round(value / 1000)}s` : `${value}ms`;
  if (unit === 'bytes') return value >= 1024 * 1024 ? `${Math.round(value / (1024 * 1024))}MiB` : `${Math.round(value / 1024)}KiB`;
  if (unit === 'tokens') return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
  if (unit === 'chars') return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
  return String(value);
}

/** 一行摘要（控制栏/状态面/`limits` 子命令共用同一份投影）。 */
export function formatLimitsLine(values                         , lang              = 'zh')         {
  const parts           = [];
  const pick = (key          , label        )       => {
    const raw = values?.[key];
    const shown = raw === undefined ? (lang === 'zh' ? '未设' : 'unset') : formatLimitValue(key, raw);
    parts.push(`${label} ${shown}`);
  };
  pick('maxSteps', lang === 'zh' ? '轮数' : 'rounds');
  pick('maxInputTokens', lang === 'zh' ? '上下文' : 'context');
  pick('peekBudgetChars', lang === 'zh' ? '取回' : 'peek');
  return parts.join(' · ');
}

/** 结构化投影（CLI --json / 控制页 / 台账）。 */
export function publicLimitCatalog(values                         ) {
  return LIMIT_SPECS.map((spec) => ({
    key: spec.key,
    unit: spec.unit,
    group: spec.group,
    label: { zh: spec.zh, en: spec.en },
    /** undefined = 用户未定义（不限制）；0 = 用户显式选择不限制 */
    value: values?.[spec.key],
    configured: values?.[spec.key] !== undefined,
  }));
}

// ---------------------------------------------------------------------------
// thinkflow 对齐默认层：插件自带的唯一默认数值面。
//
// 来源 = xuxiang-thinkflow 出厂预设（config.example.json / provider.py），逐项映射：
//   · keepRecent: 30        ← compaction.keep_recent_messages: 30
//   · maxSummaryChars: 16000 ← compaction.max_summary_chars: 16000
//   · maxReadChars: 200000  ← max_read_chars: 200000
//   · maxReentries: 8       ← max_auto_continues: 8（stallReentries 由 deriveLimits 跟随）
//   —— wire 传输面（provider.py ProviderConfig / output_budget_options / openai_thinking_options）：
//   · maxTokens: 0          ← max_tokens: null（0 = 委托给 provider，不发 max_tokens 字段）
//   · thinkingBudget: 0     ← thinking_budget: 0（思考关闭；>0 时按 provider 语义组装 thinking 字段）
//   · streamUsage: 0        ← stream_options_include_usage: false
//   · maxRetries: 2         ← max_retries: 2
//   · retryBackoffMs: 1000  ← retry_backoff_seconds: 1
//
// 两个刻意的"不对齐"：
//   · **没有 maxSteps**——轮数上限一律不预设（0 = 不限制）；thinkflow 的
//     max_run_turns=40 只作用于一次性 run 命令，不进本插件默认面。
//   · **没有 maxInputTokens**——thinkflow 的 compaction.max_input_tokens=0（token
//     口径压缩关闭），本插件的压缩由 keepRecent/maxSummaryChars 字符口径承担。
//
// 层级：THINKFLOW_ALIGNED_LIMITS（本层）→ control.json 的 limits → 环境变量 →
// 装配 config.limits（后层覆盖前层）。用户显式写 0 = 主动选择"不限制"，同样压过本层。
// 传输五键随时可在控制面板 / `limits --set` / 装配里改——thinkflow 预设只是默认，不是锁。
// ---------------------------------------------------------------------------

export const THINKFLOW_ALIGNED_LIMITS              = {
  keepRecent: 30,
  maxSummaryChars: 16_000,
  maxReadChars: 200_000,
  maxReentries: 8,
  maxTokens: 0,
  thinkingBudget: 0,
  streamUsage: 0,
  maxRetries: 2,
  retryBackoffMs: 1_000,
};
