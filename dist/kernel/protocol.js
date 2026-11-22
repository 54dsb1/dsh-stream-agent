// kernel/protocol.ts —— 协议文本组件化（v0.4.1-beta.1）
//
// 把 DEFAULT_PROTOCOL_TEXT 拆成 7 个具名段，由 composeProtocolText 组装。三条红线：
//   1. 缺省组装 composeProtocolText() 与 0.4.0-beta.1 的 DEFAULT_PROTOCOL_TEXT **逐字节一致**
//      （full 段文本由 v040 src 程序化切分注入：FULL_* 占位符替换，不手抄；
//      test/v041-protocol.test.ts 用 test/golden/v040-protocol.txt 金样逐字节钉死——
//      稳定前缀字节不漂移 = 缓存零回归）；
//   2. 构造期冻结（O4）：组装在驱动器构造期完成，稳定前缀内无任何动态字段；
//   3. 内核零依赖、无 IO（与 modes.ts 同层纪律）。
//
// 组装规则：
//   - 档位（level）决定"默认含哪些段 + 各段用哪份文本"：full = 全 7 段原文（缺省）；
//     lean = 全 7 段压缩说明文字；minimal = 只含 syntax/plan/results/finalSummary/rules。
//   - sections 显式增删段：false = 落选；true = 本档未含的段也加回（canonical 段序不变）。
//   - enablePlan: false 硬联动去 plan 段（协议不声明一个会被拒的命令；sections.plan: true
//     不能复活——命令级失败兜底仍在驱动器里，构成防御纵深）。
//   - 某段在某档没有专属文本时回退用 full 文本（如 lean/minimal 的 plan、lean 的 finalSummary）。

export const PROTOCOL_SECTION_IDS = ['syntax', 'plan', 'results', 'selfread', 'timing', 'finalSummary', 'rules']         ;
                                                                      

export const PROTOCOL_LEVELS = ['full', 'lean', 'minimal']         ;
                                                             

/** 装配/请求面档位归一：未知值回 full（fail-open，档位写错不阻断装载；与 asSurfaceProfile 同风格）。 */
export function asProtocolLevel(value                    )                {
  return value === 'lean' || value === 'minimal' ? value : 'full';
}

/** 各档默认含哪些段（canonical 段序以 PROTOCOL_SECTION_IDS 为准，与这里排列无关）。 */
export const LEVEL_SECTIONS                                                      = {
  full: ['syntax', 'plan', 'results', 'selfread', 'timing', 'finalSummary', 'rules'],
  lean: ['syntax', 'plan', 'results', 'selfread', 'timing', 'finalSummary', 'rules'],
  minimal: ['syntax', 'plan', 'results', 'finalSummary', 'rules'],
};

// ---------------------------------------------------------------------------
// full 段文本（0.4.0-beta.1 DEFAULT_PROTOCOL_TEXT 的程序化切分，逐字节勿手改；
// 改前先跑 test/v041-protocol.test.ts 金样测试，确认是有意变更并更新金样）
// ---------------------------------------------------------------------------

/** full.syntax：语法表 + 改写/搜索/offset/收尾纪律（协议成本大头）。 */
const FULL_SYNTAX = `## tf-* 单流协议（本回合唯一工具语法）

<tf-write path="相对/绝对路径" id="w1" depends_on="r1">
文件正文原文（原样输出，直到闭合标签）
</tf-write>
<tf-read path="相对/绝对路径" id="r1" depends_on="w1,w2" offset="100" limit="50"/>
<tf-edit path="src/app.ts" id="e1" depends_on="r1">
<<<<<<< OLD
被替换的原文（精确字面量，全文唯一；不做模糊匹配）
=======
替换后的新文
>>>>>>> NEW
</tf-edit>
<tf-append path="notes.md" id="a1" anchor="锚点原文（可选；缺省=追加到文件末尾）">
追加正文（原样输出，直到闭合标签；不改既有内容）
</tf-append>
<tf-grep pattern="正则" path="src" include="*.ts" id="g1"/>
<tf-glob pattern="**/*.md" id="gl1"/>
<tf-bash cmd="命令行" id="b1"/>
<tf-peek handle="obs:read:c3@v1" from_line="10" to_line="20" id="p1"/>
<tf-final id="f1" summary="一句话完成说明"/>

（改既有文件用 tf-edit（精确替换）或 tf-append（只追加），不要整文件重写；
找内容用 tf-grep（回匹配行）/tf-glob（回路径），不要用 tf-bash 调 shell 搜索，
也不要把搜索当"读文件"用——grep 结果超长会截断并提示 tf-peek。）

（tf-read 可选 offset/limit：1 基行号起点与行数，大文件按行段取，省 token。）

（收尾纪律：命令全部闭合后，本流必须以 tf-final 结束；写完文件、执行完命令不等于任务结束。）`;

/** full.plan：计划与验收（enablePlan=false 时整段落选）。 */
const FULL_PLAN = `## 计划与验收（复合任务推荐）
<tf-plan id="p1">
- [a1] 验收项描述
- [a2] 验收项描述
</tf-plan>
- 计划只声明一次；修订时重发 tf-plan（新计划整体替换旧计划，请求里只注差分）。
- 完成某验收项对应的命令时，在该命令上加 accepts 属性，如 <tf-write path="out.md" id="w1" accepts="a1">...</tf-write>。
- 全部验收项都有命令成功回执后 tf-final 才会通过；缺项/未验证会被判为过早并注入提示——
  模型自述"已完成"不构成验收证据。`;

/** full.results：结果获取与句柄语义。 */
const FULL_RESULTS = `## 结果获取（关键）
tf-read 首次/内容变化的结果会完整注入下一请求（超长文件截断为中段省略，用 tf-peek 精确取回）；
tf-bash / tf-write / tf-edit / tf-append 成功只记台账（回执），不回灌输出。
失败一律以 [tf-stream:error] 注入，没有错误注入就是成功了。
因此：要看命令输出或计算结果时，用 tf-peek 按句柄取回——handle 从 [tf-stream:observation]
与句柄目录增量中取。答案依赖命令输出时，先 peek 再收尾。`;

/** full.selfread：自写文件回验纪律（receipt 语义）。 */
const FULL_SELFREAD = `## 回验纪律（省 token 的关键）
- 你 tf-write 的正文全文就在你的上下文里：不要为了"确认写成功"而 tf-read 自己刚写过的
  路径——那只会得到回执（行数 + 内容指纹，[tf-stream:receipt]），不会重复回灌全文。
  写失败一定会有 [tf-stream:error] 注入；没有错误注入就是写成功了。
- tf-read 留给"读不是你写的文件"（任务要求读的既有文件、命令产出的文件）。
- 确需局部比对自写文件时，用 tf-peek 按行段取回，不要全文重读。`;

/** full.timing：幂等/写序/peek 延迟/平台注意。 */
const FULL_TIMING = `## 时序与重发规则
- 同 id 同内容重复声明 = 幂等：直接返回原回执（含句柄），不重复执行；同 id 不同内容会被
  拒绝（换新 id）；被拒绝（无副作用）的命令可用原 id 修正后重发。
- 同流内后续命令自动等待先闭合的 tf-write 完成（写序保证：先写后读不会读到旧内容）。
- tf-peek 的句柄由命令产出——同流内提前 peek 会被自动延迟到命令完成后重试，仍无此句柄才报错；
  要么给 peek 加 depends_on 挂到产出命令上（如 <tf-peek ... depends_on="r1"/>），
  要么等下一请求（句柄会出现在句柄目录增量里）再 peek。
- tf-bash 的命令在 Windows 宿主以 PowerShell（pwsh）执行：python3 通常不存在，优先 node -e 或
  PowerShell 原生命令（Select-String / Get-Content）。`;

/** full.finalSummary：tf-final 答案原文纪律。 */
const FULL_FINALSUMMARY = `tf-final 的 summary 必须包含任务要求的最终答案原文（数字、行内容、路径、结论），
不得写"已完成/占位"式描述；还没拿到答案就不要输出 tf-final。`;

/** full.rules：规则 1-7（含 DSML/原生格式禁令）。 */
const FULL_RULES = `规则：
1. 写文件一律用 tf-write（正文在标签体内原样输出）；不要用原生工具写文件。
2. id 建议显式给出且全任务唯一；depends_on 是逗号分隔的依赖 id 列表，可省略。
   依赖只能指向本任务里已出现或将要出现的命令 id。
3. 命令闭合即开始执行（独立命令并行，上限 3 个），不必等流结束再发后续命令。
4. tf-read 首次/变化结果完整注入下一请求；其余成功产出只句柄化（见"结果获取"）。
   需要某句柄的细节时发 tf-peek（handle 用句柄目录里的值，行段 1-based 闭区间）。
   tf-edit 匹配失败（原文不唯一/不存在）会以结构化错误注入：核对后修正 OLD 段重发，
   不要扩大替换范围改全文。tf-grep/tf-glob 只回匹配行/路径，超长会截断并提示 tf-peek。
5. 上一请求若报告 [tf-stream:error]，先修复或改道该命令（换路径/换命令），再继续其余任务。
6. 全部命令成功且无需更多信息时输出 tf-final；收到 tf-final 后本任务收敛，不再有下一请求。
7. 调用工具只允许上表的 tf-* 标记：不要输出 <｜｜DSML｜｜…>、<think> 包裹、JSON tool_call
   等任何原生调用格式——它们不会被解析成命令，只会浪费输出 token 并在界面显示为乱码。`;

// ---------------------------------------------------------------------------
// lean 段文本（压缩说明文字；语法表与关键语义不减）
// ---------------------------------------------------------------------------

const LEAN_SYNTAX = `## tf-* 单流协议（本回合唯一工具语法）

<tf-write path="相对/绝对路径" id="w1" depends_on="r1">
文件正文原文（原样输出，直到闭合标签）
</tf-write>
<tf-read path="相对/绝对路径" id="r1" depends_on="w1,w2" offset="100" limit="50"/>
<tf-edit path="src/app.ts" id="e1" depends_on="r1">
<<<<<<< OLD
被替换的原文（精确字面量，全文唯一；不做模糊匹配）
=======
替换后的新文
>>>>>>> NEW
</tf-edit>
<tf-append path="notes.md" id="a1" anchor="锚点原文（可选；缺省=追加到文件末尾）">
追加正文（原样输出，直到闭合标签；不改既有内容）
</tf-append>
<tf-grep pattern="正则" path="src" include="*.ts" id="g1"/>
<tf-glob pattern="**/*.md" id="gl1"/>
<tf-bash cmd="命令行" id="b1"/>
<tf-peek handle="obs:read:c3@v1" from_line="10" to_line="20" id="p1"/>
<tf-final id="f1" summary="一句话完成说明"/>

（改既有文件用 tf-edit/tf-append，不整文件重写；找内容用 tf-grep/tf-glob，不要用 tf-bash 调 shell 搜索，也不要把搜索当"读文件"——grep 结果超长会截断并提示 tf-peek。）
（tf-read 可选 offset/limit，大文件按行段取，省 token。收尾纪律：命令全部闭合后，本流必须以 tf-final 结束。）`;

const LEAN_RESULTS = `## 结果获取（关键）
tf-read 首次/内容变化的结果完整注入下一请求；tf-bash / tf-write / tf-edit / tf-append 成功只记台账（回执）不回灌输出；失败一律以 [tf-stream:error] 注入——没有错误注入就是成功。
要看命令输出或计算结果时：用 tf-peek 按句柄取回（handle 从 [tf-stream:observation] 与句柄目录增量取）；答案依赖输出时，先 peek 再收尾。`;

const LEAN_SELFREAD = `## 回验纪律（省 token 的关键）
- tf-write 的正文全文就在你的上下文里：不要为了"确认写成功"而 tf-read 自己刚写过的路径——那只会得到回执（[tf-stream:receipt]，行数+指纹）不回灌全文；没有 [tf-stream:error] 注入就是写成功了。
- tf-read 留给"读不是你写的文件"；确需局部比对自写文件用 tf-peek 按行段取回，不要全文重读。`;

const LEAN_TIMING = `## 时序与重发规则
- 同 id 同内容重复声明 = 幂等（返回原回执不重复执行）；同 id 不同内容被拒（换新 id）；被拒的命令可用原 id 修正后重发。
- 后续命令自动等待先闭合的 tf-write（先写后读不会读到旧内容）；提前 tf-peek 会自动延迟到句柄产出，或加 depends_on 挂到产出命令上。
- tf-bash 在 Windows 宿主以 PowerShell（pwsh）执行：python3 通常不存在，优先 node -e 或 PowerShell 原生命令。`;

const LEAN_RULES = `规则：
1. 写文件一律用 tf-write（正文在标签体内原样输出）；不要用原生工具写文件。
2. id 全任务唯一；depends_on 是逗号分隔的依赖 id 列表，可省略，指向本任务内的命令 id。
3. 命令闭合即开始执行（独立命令并行，上限 3 个），不必等流结束再发后续命令。
4. tf-read 首次/变化结果完整注入；其余产出只句柄化，细节用 tf-peek（行段 1-based 闭区间）。
   tf-edit 匹配失败会以结构化错误注入：核对后修正 OLD 段重发，不要扩大范围改全文。
5. 见 [tf-stream:error] 先修复或改道该命令，再继续其余任务；全部命令成功且无需更多信息时输出 tf-final。
6. 只允许上表的 tf-* 标记：不要输出 <｜｜DSML｜｜…>、<think> 包裹、JSON tool_call 等原生调用格式——不会解析成命令，浪费输出 token 且界面显示为乱码。`;

// ---------------------------------------------------------------------------
// minimal 段文本（语法铁律面；解释性散文落选，harness 才是权威）
// ---------------------------------------------------------------------------

const MINIMAL_SYNTAX = `## tf-* 单流协议（本回合唯一工具语法）

<tf-write path="相对/绝对路径" id="w1" depends_on="r1">
文件正文原文（原样输出，直到闭合标签）
</tf-write>
<tf-read path="相对/绝对路径" id="r1" depends_on="w1,w2" offset="100" limit="50"/>
<tf-edit path="src/app.ts" id="e1" depends_on="r1">
<<<<<<< OLD
被替换的原文（精确字面量，全文唯一；不做模糊匹配）
=======
替换后的新文
>>>>>>> NEW
</tf-edit>
<tf-append path="notes.md" id="a1" anchor="锚点原文（可选；缺省=追加到文件末尾）">
追加正文（原样输出，直到闭合标签；不改既有内容）
</tf-append>
<tf-grep pattern="正则" path="src" include="*.ts" id="g1"/>
<tf-glob pattern="**/*.md" id="gl1"/>
<tf-bash cmd="命令行" id="b1"/>
<tf-peek handle="obs:read:c3@v1" from_line="10" to_line="20" id="p1"/>
<tf-final id="f1" summary="一句话完成说明"/>

（改既有文件用 tf-edit/tf-append，不整文件重写；找内容用 tf-grep/tf-glob，不要用 tf-bash 搜。）
（收尾纪律：命令全部闭合后，本流必须以 tf-final 结束。）`;

const MINIMAL_RESULTS = `## 结果获取（关键）
tf-read 首次/变化结果完整注入；tf-bash / tf-write / tf-edit / tf-append 成功只记台账（回执）不回灌；失败以 [tf-stream:error] 注入——没有错误注入就是成功。
要看输出用 tf-peek 按句柄取回；答案依赖输出时先 peek 再收尾。`;

const MINIMAL_FINALSUMMARY = `tf-final 的 summary 必须包含任务要求的最终答案原文（数字、行内容、路径、结论）；没拿到答案就不要输出 tf-final。`;

const MINIMAL_RULES = `规则：
1. 写文件一律用 tf-write；不要用原生工具写文件。
2. id 全任务唯一；depends_on 可省略。
3. 命令闭合即开始执行；见 [tf-stream:error] 先修复或改道。
4. 只允许上表的 tf-* 标记：不要输出 <｜｜DSML｜｜…>、<think>、JSON tool_call 等原生调用格式。`;

/** 各档各段文本；缺项回退 full（composeProtocolText 负责回退）。 */
export const SECTION_TEXTS                                                                    = {
  full: {
    syntax: FULL_SYNTAX,
    plan: FULL_PLAN,
    results: FULL_RESULTS,
    selfread: FULL_SELFREAD,
    timing: FULL_TIMING,
    finalSummary: FULL_FINALSUMMARY,
    rules: FULL_RULES,
  },
  lean: {
    syntax: LEAN_SYNTAX,
    plan: FULL_PLAN,
    results: LEAN_RESULTS,
    selfread: LEAN_SELFREAD,
    timing: LEAN_TIMING,
    finalSummary: FULL_FINALSUMMARY,
    rules: LEAN_RULES,
  },
  minimal: {
    syntax: MINIMAL_SYNTAX,
    plan: FULL_PLAN,
    results: MINIMAL_RESULTS,
    finalSummary: MINIMAL_FINALSUMMARY,
    rules: MINIMAL_RULES,
  },
};

                                         
                                            
                        
                                                                   
                                                         
                                                    
                       
 

/** 组装协议文本（段间空行连接，canonical 段序；缺省调用 = 0.4.0-beta.1 原文逐字节）。 */
export function composeProtocolText(opts                         = {})         {
  const level = opts.level ?? 'full';
  if (!(PROTOCOL_LEVELS                     ).includes(level)) {
    throw new Error(`[protocol] 未知协议档位: ${String(level)}（可用: ${PROTOCOL_LEVELS.join(', ')}）`);
  }
  const overrides = opts.sections ?? {};
  for (const key of Object.keys(overrides)) {
    if (!(PROTOCOL_SECTION_IDS                     ).includes(key)) {
      throw new Error(`[protocol] 未知协议段 id: ${String(key)}（可用: ${PROTOCOL_SECTION_IDS.join(', ')}）`);
    }
  }
  const included = new Set                   (LEVEL_SECTIONS[level]);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === true) included.add(key                     );
    else if (value === false) included.delete(key                     );
  }
  if (opts.enablePlan === false) included.delete('plan');
  return PROTOCOL_SECTION_IDS
    .filter((id) => included.has(id))
    .map((id) => SECTION_TEXTS[level][id] ?? SECTION_TEXTS.full[id] )
    .join('\n\n');
}

                                         
                        
                    
                    
                                        
                       
                                
                        
 

                                  
                       
               
                 
                
                              
                    
                                     
                     
                                     
 

/** 组装 + 逐段统计（CLI protocol 子命令与测试共用同一投影；纯函数，无 IO）。 */
export function protocolPreview(opts                         = {})                  {
  const level = opts.level ?? 'full';
  const text = composeProtocolText(opts);
  const overrides = opts.sections ?? {};
  const baseSet = new Set                   (LEVEL_SECTIONS[level]);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === true) baseSet.add(key                     );
    else if (value === false) baseSet.delete(key                     );
  }
  if (opts.enablePlan === false) baseSet.delete('plan');
  const sections = PROTOCOL_SECTION_IDS.map((id)                         => {
    if (!baseSet.has(id)) return { id, included: false, chars: null, source: level };
    const levelText = SECTION_TEXTS[level][id];
    // 来源如实标注：档位文本缺省回退、或与 full 同文（如 lean/minimal 的 plan）时标 full
    return {
      id,
      included: true,
      chars: (levelText ?? SECTION_TEXTS.full[id] ).length,
      source: level !== 'full' && levelText !== SECTION_TEXTS.full[id] ? level : 'full',
    };
  });
  const fullChars = composeProtocolText().length;
  return {
    level,
    text,
    chars: text.length,
    fullChars,
    savedChars: fullChars - text.length,
    sections,
  };
}
