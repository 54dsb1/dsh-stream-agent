/**
 * kernel/parser.ts —— tf-* 单流协议解析器（M3 解析半边）
 *
 * 内核层纪律：零框架依赖、无 IO 副作用、不执行任何东西，只解析。
 *
 * 协议文本格式（README §5 的语义在此落成 wire format，写进系统提示）：
 *
 *   <tf-read path="src/app.ts" id="r1" depends_on="w1,w2"/>
 *   <tf-write path="src/app.ts" id="w1" depends_on="r1">
 *   文件正文（原文，直到闭合标签）
 *   </tf-write>
 *   <tf-edit path="src/app.ts" id="e1">
 *   <<<<<<< OLD
 *   被替换的原文（精确字面量，必须唯一）
 *   =======
 *   >>>>>>> NEW
 *   替换后的新文
 *   </tf-edit>
 *   <tf-append path="notes.md" id="a1" anchor="最后一节"/>
 *   追加正文（原文，直到闭合标签）
 *   </tf-append>
 *   <tf-grep pattern="TODO" path="src" include="*.ts" id="g1"/>
 *   <tf-glob pattern="src/**" id="gl1"/>
 *   <tf-bash cmd="npm test" id="b1"/>
 *   <tf-peek handle="obs:read:c3@v1" from_line="10" to_line="20" id="p1"/>
 *   <tf-final id="f1" summary="任务完成说明"/>
 *   <tf-call name="web_search" id="c1" depends_on="w1">{"query":"..."}</tf-call>
 *   <tf-ask q="选择哪种方案？" id="a1" options="方案A,方案B"/>
 *   <tf-skill name="skill-name" id="s1"/>
 *
 * 规则：
 * - 有正文的命令：tf-write / tf-edit / tf-append / tf-code；其余自闭合（`/>`）
 *   或空元素配对（`></...>`）；非 body 命令带非空正文 → malformed；
 * - 属性值用双引号，值内可含 `>`（如 shell 重定向）——头部扫描引号感知；
 * - id 可省略（自动编号 cmd1、cmd2...）；depends_on 是逗号分隔的命令 id
 *   列表，可空；重复依赖去重保序；
 * - `<tf-` 开头但命令名未知的标签按 malformed 上报（协议尝试失败，不静默）；
 *   非 tf- 前缀的 '<' 一律视为模型 prose 原样透传，绝不丢弃
 *   （代价：恰好以 "<tf-xxx" 开头且全文无 '>' 的 prose 会被判为 truncated，
 *   但内容仍在 raw 里，不丢失）；
 * - DSML 噪声（v0.3.1）：模型偶尔把原生调用格式 `<｜｜DSML｜｜ …>`（U+FF5C 全角竖线）
 *   混进文本流——协议里没有任何合法形式以 "<｜" 开头，一律按协议违规处理，
 *   绝不作为 prose 透传（透传会在桌面端渲染成乱码）。其中
 *   `<｜｜DSML｜｜ invoke name="tf-xxx" ...>` 形态改写回等价 tf-* 头部（命令不丢）；
 *   其余（calls 包装行等）以 malformed(dsml-wrapper) 上报后丢弃，只记台账不注入。
 * - 未闭合即流终止 → truncated 事件（loop 据此决定重入策略）；
 * - depends_on 环 → cycle 事件（路径首尾相同，如 [a, b, a]）。
 * - 孤立闭合标签（v0.3.1 截断修复）：ground 模式下出现的 `</tf-xxx>`（前面没有配对打开，
 *   典型是模型把自闭合命令又"关闭"了一次）一律按 malformed(stray-close-tag) 记账后丢弃，
 *   绝不作 prose 透传——0.3.1 真机证据：这类残片会以纯文本落进 assistant/message，
 *   桌面端正文里出现裸的 `</tf-bash>`。
 * - DSML 参数式调用（v0.3.2 截断修复）：模型原生调用格式还有"父标签 + parameter 子标签"
 *   形态（真机取证 session-e4b9a89c 第 6/9 步）：
 *     <｜｜DSML｜｜ invoke name="tf-read">
 *     <｜｜DSML｜｜ parameter name="path" string="true">README.md</｜｜DSML｜｜ parameter>
 *     </｜｜DSML｜｜ invoke>
 *   0.3.1 只认「invoke 头部内联属性」形态，parameter 子标签被逐条判 malformed，而标签之间的
 *   属性值（README.md / r10 / 命令行）作为 prose 漏进正文——用户侧看到的就是"截断的正文 +
 *   `README.md r10` 这种残片"，且命令根本没执行。本版把整个 invoke 块缓冲到闭合，按
 *   parameter 归集成属性后一次性发命令；块内文本不再作为 prose 透传。块未闭合即流终止时，
 *   非正文命令（属性已齐）照常发命令（能救则救），正文命令按 truncated 丢弃（不写半截文件）。
 * - 非正文命令的配对开标签（v0.3.2）：`<tf-read ...>` 少了 `/` 时，0.3.1 会进入 body 模式
 *   一直吞到流末尾（整个后续输出消失）。现在非正文命令一旦出现下一个 `<tf-` / `</tf-`
 *   即视为已闭合（命令照常派发），流末尾仍未闭合也发命令并把剩余文本按 prose 归还。
 * - 围栏（0.5.1，TF 对齐 2.1）：行首（≤3 空格缩进）的 ``` / ~~~ 围栏内的 `<tf-*>` 只是
 *   **散文**——模型在示例/补丁片段里写的命令不得被执行（真机最危险的形态：解释协议时
 *   顺手写一条 `tf-write` 示例，文件被覆盖）。围栏状态机覆盖缩进、不同标记字符、闭合行
 *   长度 ≥ 开启行；未闭合的围栏延续到流末（CommonMark 语义），整段按正文逐字节保留。
 *   围栏只在 ground 模式判定——命令正文（tf-write/tf-edit/... 的 body）里的围栏标记
 *   不改变状态（body 已由闭合标签界定）。
 *
 * 事件类型：text / command / malformed / truncated / cycle / done。
 * 命令闭合立即 emit，不等流结束；"当前可执行集合"用 readyCommands() 查询
 * （命令闭合 + markDone() 后依赖全部满足的命令）。
 */

// ---------------------------------------------------------------------------
// 协议 schema（显式定义；解析失败产出 malformed，绝不静默丢弃）
// ---------------------------------------------------------------------------

export type TfCommandName =
  | 'tf-write' | 'tf-read' | 'tf-edit' | 'tf-append' | 'tf-grep' | 'tf-glob'
  | 'tf-bash' | 'tf-peek' | 'tf-final' | 'tf-code' | 'tf-plan'
  | 'tf-call' | 'tf-ask' | 'tf-skill'
  | 'tf-changes' | 'tf-diff' | 'tf-revert';

interface CommandSchema {
  required: readonly string[];
  optional: readonly string[];
  hasBody: boolean;
}

/** id / depends_on / accepts 是所有命令的公共属性，不计入各命令 schema。
 *  accepts（F5）：逗号分隔的验收项 id 列表——命令成功（有回执）时对应验收项记为已验证。 */
const COMMON_ATTRS: readonly string[] = ['id', 'depends_on', 'accepts'];

const COMMAND_SCHEMAS: Readonly<Record<TfCommandName, CommandSchema>> = {
  'tf-write': { required: ['path'], optional: [], hasBody: true },
  'tf-read': { required: ['path'], optional: ['offset', 'limit'], hasBody: false },
  // F1：精确替换（body 用 OLD/NEW 标记行分隔两段字面量）与追加（body = 追加正文；
  // anchor 给出插入锚点字面量，缺省 = 追加到文件末尾）。两者都映射宿主 edit/apply_patch，
  // 不自建文件 IO。
  // v1.1.0（4.1）：offset 声明编辑目标起始行（配合 revision 守卫的范围读覆盖检查）。
  'tf-edit': { required: ['path'], optional: ['replace_all', 'offset'], hasBody: true },
  'tf-append': { required: ['path'], optional: ['anchor'], hasBody: true },
  // F2：搜索只回匹配行/路径（宿主 fs-search 的 grep/glob 映射），不回全文。
  'tf-grep': { required: ['pattern'], optional: ['path', 'include'], hasBody: false },
  'tf-glob': { required: ['pattern'], optional: ['path'], hasBody: false },
  'tf-bash': { required: ['cmd'], optional: [], hasBody: false },
  // v1.1.0（2.3）：offset=字符级起点、query=字面续搜串（对齐 thinkflow recall.py:34）。
  // from_line/to_line/symbol 仍为行/符号定位；offset/query 为字符级，二者可共存但以 offset 优先。
  'tf-peek': { required: ['handle'], optional: ['from_line', 'to_line', 'symbol', 'offset', 'query'], hasBody: false },
  'tf-final': { required: [], optional: ['summary'], hasBody: false },
  // F5：计划与验收——body 按行声明验收项（`- [id] 描述`）；计划状态在驱动器（宿主侧）持有，
  // 请求只注差分；tf-final 在存在未验证验收项时判定为过早。
  'tf-plan': { required: [], optional: [], hasBody: true },
  // 程序体 = PTC 的 async TS 函数体（可擦除语法）；description 只进台账，timeout 为毫秒数。
  // v1.2.0（b 通道 PTC 对齐）：format=function-body|repl|script；state=命名状态域；sandbox=策略名。
  // v1.3.0（0.5.3）：sandbox_permissions + justification = 单次提权（宿主 run_code 同构，必须成对）。
  'tf-code': { required: [], optional: ['timeout', 'description', 'format', 'state', 'sandbox', 'release', 'sandbox_permissions', 'justification'], hasBody: true },
  // v0.4.0 通用调用通道（G2：净增 1）：name = 本会话冻结工具面内的宿主工具名；
  // body = JSON 对象（参数原样透传给 ctx.tools.execute）。parser 只做 schema 校验，
  // 工具名/JSON 的语义校验在驱动器（unknown-tool / bad-json-arguments 结构化失败）。
  'tf-call': { required: ['name'], optional: [], hasBody: true },
  // v0.4.0 高频例外（§6.4，命令表 12→14）：阻塞式提问与技能装载值一条专用语法——
  // tf-ask 的回答要作为问句语义在流内可见（familyHint=ask）；tf-skill 是会话级状态变更。
  // 参数刻意极简（JSON 免转义）；复杂形状（多问题/选项描述）走 tf-call body。
  'tf-ask': { required: ['q'], optional: ['header', 'options'], hasBody: false },
  'tf-skill': { required: ['name'], optional: [], hasBody: false },
  // v1.5.0（0.6.0 正式版，changes 缺口修复）：私有变更回执与守卫式回滚
  //（对齐 [TF]/changes.py list_changes/diff/revert）。change = 回执 id（32 位十六进制）；
  // expected = 该回执的 after_hash（tf-changes 输出里给出）——双重校验防覆盖外部后续编辑。
  'tf-changes': { required: [], optional: ['path'], hasBody: false },
  'tf-diff': { required: ['change'], optional: [], hasBody: false },
  'tf-revert': { required: ['change', 'expected'], optional: [], hasBody: false },
};

const COMMAND_NAMES: readonly TfCommandName[] =
  ['tf-write', 'tf-read', 'tf-edit', 'tf-append', 'tf-grep', 'tf-glob', 'tf-bash', 'tf-peek', 'tf-final', 'tf-code', 'tf-plan', 'tf-call', 'tf-ask', 'tf-skill', 'tf-changes', 'tf-diff', 'tf-revert'];

export interface TfCommand {
  name: TfCommandName;
  /** 协议 id；缺省时自动编号（cmd1、cmd2...） */
  id: string;
  /** 除 depends_on 外的全部属性（path/cmd/handle/from_line/...） */
  attrs: Readonly<Record<string, string>>;
  /** 仅 tf-write / tf-code 有；原文，无转义还原（tf-code = PTC 程序体） */
  body?: string;
  /** 依赖命令 id 列表（去空、去重、保序） */
  depends_on: readonly string[];
  /** 闭合序号 */
  seq: number;
}

export type ParserEvent =
  | { type: 'text'; text: string }
  | { type: 'command'; command: TfCommand }
  | { type: 'malformed'; raw: string; reason: string }
  | { type: 'truncated'; raw: string; reason: string }
  | { type: 'cycle'; cycle: readonly string[] }
  | { type: 'done' };

// ---------------------------------------------------------------------------
// 流式解析器
// ---------------------------------------------------------------------------

type Mode = 'ground' | 'header' | 'body' | 'dsml' | 'fence';
type TagProbe = 'tag' | 'prose' | 'tf-unknown' | 'close-tag' | 'need-more' | 'dsml';

/** 围栏状态（0.5.1 / 2.1）：marker 字符 + 开启行长度（闭合行长度必须 ≥ 它）。 */
interface FenceState {
  ch: '`' | '~';
  len: number;
}

export class TfStreamParser {
  private buf = '';
  private mode: Mode = 'ground';
  private ended = false;

  /** 0.5.1（2.1）：围栏状态；null = 不在围栏内。 */
  private fence: FenceState | null = null;
  /** 开启行的剩余部分是否已消费（首个换行之后才开始判闭合行）。 */
  private fenceBodyStarted = false;
  /** 下一字符是否处于行首（围栏只在此位置开启；行首判定需要跨 chunk 保持）。 */
  private atLineStart = true;
  /** 0.5.2（审计 C-9）：是否处于行内代码（`…`）中——其中的 `<tf-*>` 是示例文本。 */
  private inlineCode = false;

  /** DSML 参数式调用块缓冲（v0.3.2）：从无内联属性的 invoke 开标签起，缓冲到块闭合。 */
  private dsmlBuf = '';
  private dsmlName: TfCommandName | null = null;

  // body 中间态
  private bodyName: TfCommandName | null = null;
  private bodyAttrs: Record<string, string> | null = null;
  private bodyDeps: readonly string[] | null = null;
  private bodyRawOpen = '';
  private bodyBuf = '';

  private readonly commands = new Map<string, TfCommand>();
  private readonly doneIds = new Set<string>();
  private readonly emittedCycleKeys = new Set<string>();
  private autoIdCounter = 0;
  private seqCounter = 0;

  /** 增量喂入；命令跨 chunk 边界闭合，闭合即产出事件。 */
  feed(delta: string): ParserEvent[] {
    if (this.ended) {
      throw new Error('parser already ended; create a new TfStreamParser for the next stream');
    }
    this.buf += delta;
    const events: ParserEvent[] = [];
    // 一种模式内的推进可能连锁（header 闭合 → body 打开 → 同一 buf 里 body 闭合）
    for (;;) {
      if (!this.step(events)) break;
    }
    return events;
  }

  /** 流终止：冲刷剩余文本；未闭合产出 truncated；最后必发 done。 */
  end(): ParserEvent[] {
    if (this.ended) return [];
    this.ended = true;
    const events: ParserEvent[] = [];
    if (this.mode === 'dsml') {
      // v0.3.2：DSML 参数式块未闭合即流终止。非正文命令只要属性齐全就照常发（能救则救）；
      // 正文命令（tf-write/tf-edit/tf-append/tf-code）不写半截内容——按 truncated 上报。
      const block = this.dsmlBuf + this.buf;
      const expected = this.dsmlName;
      this.dsmlBuf = '';
      this.dsmlName = null;
      this.buf = '';
      this.mode = 'ground';
      const parsed = parseDsmlBlock(block, expected, { allowIncompleteBody: false });
      for (const bad of parsed.malformed) {
        events.push({ type: 'malformed', raw: bad.raw, reason: bad.reason });
      }
      for (const cmd of parsed.commands) {
        this.emitCommand(events, cmd.name, cmd.attrs, cmd.dependsOn, cmd.body, cmd.raw);
      }
      events.push({ type: 'truncated', raw: block, reason: 'unclosed-dsml-invoke' });
    } else if (this.mode === 'header') {
      if (isDsmlTag(this.buf)) {
        // DSML 尾巴（feed 期间已进 header 模式但流终止）：malformed 上报，不进 prose
        events.push({ type: 'malformed', raw: this.buf, reason: 'dsml-wrapper' });
        this.buf = '';
      } else {
        events.push({ type: 'truncated', raw: this.buf, reason: 'unclosed-command-tag' });
      }
    } else if (this.mode === 'fence') {
      // 0.5.1（2.1）：围栏未闭合即流终止——CommonMark 语义：围栏延续到流末，
      // 剩余内容全部是正文（逐字节保留），不发 truncated（它不是命令截断）。
      if (this.buf !== '') events.push({ type: 'text', text: this.buf });
      this.buf = '';
      this.fence = null;
      this.mode = 'ground';
    } else if (this.mode === 'body') {
      if (!COMMAND_SCHEMAS[this.bodyName!].hasBody) {
        // v0.3.2：非正文命令的配对开标签缺闭合——命令本身是完整的（属性齐），
        // 不能因为模型少写一个 '/' 就把整条命令连同后续输出一起丢掉。
        const name = this.bodyName!;
        const attrs = this.bodyAttrs!;
        const deps = this.bodyDeps!;
        const rawOpen = this.bodyRawOpen;
        const trailing = this.bodyBuf + this.buf;
        this.buf = '';
        this.bodyName = null;
        this.bodyAttrs = null;
        this.bodyDeps = null;
        this.bodyRawOpen = '';
        this.bodyBuf = '';
        this.mode = 'ground';
        if (trailing.trim() !== '') {
          events.push({ type: 'malformed', raw: trailing, reason: 'unexpected-body' });
        }
        this.emitCommand(events, name, attrs, deps, undefined, rawOpen + trailing);
        if (trailing.trim() !== '') events.push({ type: 'text', text: trailing });
      } else {
        events.push({
          type: 'truncated',
          raw: this.bodyRawOpen + this.bodyBuf + this.buf,
          reason: `unclosed-command-body:${this.bodyName}`,
        });
      }
    } else {
      // ground：残留的 "<tf-" 片段（尚无法判定是否标签）→ truncated；
      // DSML 尾巴（协议违规，v0.3.1）→ malformed 上报后丢弃，不作为 prose 泄漏；
      // 其余（含普通 '<'）全部按 prose 透传
      const lt = this.buf.lastIndexOf('<');
      const tail = lt >= 0 ? this.buf.slice(lt) : '';
      const tailProbe = tail === '' ? 'prose' : probeTag(tail);
      if (tail.startsWith('<tf-') && tailProbe === 'need-more') {
        if (lt > 0) events.push({ type: 'text', text: this.buf.slice(0, lt) });
        events.push({ type: 'truncated', raw: tail, reason: 'unclosed-command-tag' });
      } else if (tailProbe === 'dsml') {
        if (lt > 0) events.push({ type: 'text', text: this.buf.slice(0, lt) });
        events.push({ type: 'malformed', raw: tail, reason: 'dsml-wrapper' });
      } else if (tail.startsWith('</tf-') && (tailProbe === 'close-tag' || tailProbe === 'need-more')) {
        // v0.3.1：孤立闭合标签（含被流截断的半截）——记账丢弃，不进 prose
        if (lt > 0) events.push({ type: 'text', text: this.buf.slice(0, lt) });
        events.push({ type: 'malformed', raw: tail, reason: `stray-close-tag:${closeTagName(tail)}` });
      } else if (this.buf !== '') {
        events.push({ type: 'text', text: this.buf });
      }
      this.buf = '';
    }
    events.push({ type: 'done' });
    return events;
  }

  /** 标记命令执行完成（由 loop 调用）；未注册的 id 忽略。 */
  markDone(id: string): void {
    this.doneIds.add(id);
  }

  /**
   * 当前可执行集合：已闭合、未完成、且 depends_on 全部完成的命令（按闭合序）。
   * 依赖指向未出现过的 id → 永不就绪（模型声明了不存在的依赖，交 loop 层处理）。
   */
  readyCommands(): TfCommand[] {
    const out: TfCommand[] = [];
    for (const cmd of this.commands.values()) {
      if (this.doneIds.has(cmd.id)) continue;
      if (cmd.depends_on.every((d) => this.doneIds.has(d))) out.push(cmd);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  // -------------------------------------------------------------------------

  /** 状态机推进一步；有进展返回 true（events 可能追加 0..n 条）。 */
  private step(events: ParserEvent[]): boolean {
    if (this.mode === 'ground') return this.stepGround(events);
    if (this.mode === 'header') return this.stepHeader(events);
    if (this.mode === 'dsml') return this.stepDsml(events);
    if (this.mode === 'fence') return this.stepFence(events);
    return this.stepBody(events);
  }

  /**
   * 推一块正文，并顺带维护"是否在行内代码里"（0.5.2 / 审计 C-9）。
   * 行内代码不跨行：遇到换行即重置；同一行里反引号奇偶翻转。
   * 围栏代码块走 fence 模式（不经过这里），两者互不干扰。
   */
  private pushText(events: ParserEvent[], text: string): void {
    if (text === '') return;
    events.push({ type: 'text', text });
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      const seg = nl === -1 ? text.slice(start) : text.slice(start, nl);
      if ((seg.match(/`/g)?.length ?? 0) % 2 === 1) this.inlineCode = !this.inlineCode;
      if (nl === -1) break;
      this.inlineCode = false; // 换行 = 行内代码边界（Markdown 行内代码不跨行）
      start = nl + 1;
    }
  }

  private stepGround(events: ParserEvent[]): boolean {    // 0.5.1（2.1）：围栏只在这一处判定（ground + 行首）。开启行整行是正文；
    // 进入围栏后 `<tf-*>` 不再进入 header 模式（示例命令 0 执行）。
    if (this.atLineStart) {
      const opened = matchFenceOpen(this.buf);
      if (opened === 'need-more') return false;
      if (opened !== null) {
        this.pushText(events, this.buf.slice(0, opened.end));
        this.buf = this.buf.slice(opened.end);
        this.fence = { ch: opened.ch, len: opened.len };
        this.fenceBodyStarted = false;
        this.mode = 'fence';
        this.atLineStart = false;
        this.inlineCode = false;
        return true;
      }
    }
    const lt = this.buf.indexOf('<');
    // 0.6.0 复查修复（P1）：正文前缀里的围栏开启行。matchFenceOpen 只判 buf 开头——
    // 同 chunk "正文 + 围栏 + 命令"（生产 SSE 大块/整段重放常见粒度）时，`<` 之前的
    // 围栏开启行被 pushText 整体吞掉，围栏从未开启、其中的 `<tf-*>` 被真实派发
    //（示例命令 0 执行的防线失效，且行为随 feed 分块粒度漂移）。在进入 tag 分派前
    // 先对 `<` 之前（无 `<` 时对全 buf）的完整行扫围栏开启行。
    const scanEnd = lt === -1 ? this.buf.length : lt;
    const fenceAt = this.#scanFenceOpenPrefix(scanEnd);
    if (fenceAt !== null) {
      this.pushText(events, this.buf.slice(0, fenceAt));
      this.buf = this.buf.slice(fenceAt);
      // buf 开头此时必然是完整围栏开启行（行首）——复用既有进入逻辑。
      const opened = matchFenceOpen(this.buf);
      if (opened === 'need-more') return false;
      if (opened !== null) {
        this.pushText(events, this.buf.slice(0, opened.end));
        this.buf = this.buf.slice(opened.end);
        this.fence = { ch: opened.ch, len: opened.len };
        this.fenceBodyStarted = false;
        this.mode = 'fence';
        this.atLineStart = false;
        this.inlineCode = false;
        return true;
      }
    }
    if (lt === -1) {
      if (this.buf !== '') {
        this.pushText(events, this.buf);
        this.atLineStart = this.buf.endsWith('\n');
      }
      this.buf = '';
      return false;
    }
    // 0.5.2（审计 C-9）：行内代码隔离——`<tf-read .../>` 写在反引号里是**示例文本**，
    // 不是命令。此前只隔离了围栏代码块，行内反引号里的文本照样被当成命令执行
    //（模型解释协议时会无意触发一次真实工具调用）。判据：本行当前位置之前的反引号
    // 个数为奇数 = 处于行内代码中（行内代码不跨行，遇换行即重置）。
    // 0.6.0 复查修复（P3）：this.inlineCode 只反映**已 emit** 的文本——同 chunk 中
    // 反引号与 `<` 相邻时前缀尚未经过 pushText，状态是旧值（行为随分块粒度漂移）。
    // 现按"当前位置"计算：跨过换行（重置后）取当前行前缀的奇偶；同一行内则翻转基值。
    const prefix = this.buf.slice(0, lt);
    const lastNl = prefix.lastIndexOf('\n');
    const linePrefix = lastNl === -1 ? prefix : prefix.slice(lastNl + 1);
    const oddTicks = (linePrefix.match(/`/g)?.length ?? 0) % 2 === 1;
    const inlineAtLt = lastNl >= 0 ? oddTicks : (oddTicks ? !this.inlineCode : this.inlineCode);
    if (inlineAtLt) {
      this.pushText(events, this.buf.slice(0, lt + 1));
      this.buf = this.buf.slice(lt + 1);
      this.atLineStart = false;
      return true;
    }
    const probe = probeTag(this.buf.slice(lt));
    if (probe === 'need-more') return false;
    if (probe === 'close-tag') {
      // v0.3.1：孤立闭合标签——前面没有配对打开（自闭合命令被多关一次、或模型手写了
      // 残片）。按协议违规记账后丢弃，绝不作为 prose 落进正文。
      // v0.4.0（自 0.3.3 回流）：token 端界用引号感知扫描——畸形闭合可能带属性，属性值里
      // 可含 '>'（如 `</tf-write cmd="a>b">`），裸 indexOf 会把 token 截半，剩余半截再次
      // 漏进正文。probe 与消费用同一 scanHeaderClose（同 buf 同切片），端界构造性一致。
      const close = scanHeaderClose(this.buf.slice(lt));
      const gt = close === null ? -1 : lt + close.end;
      const raw = gt === -1 ? this.buf.slice(lt) : this.buf.slice(lt, gt + 1);
      if (lt > 0) this.pushText(events, this.buf.slice(0, lt));
      this.buf = gt === -1 ? '' : this.buf.slice(gt + 1);
      events.push({ type: 'malformed', raw, reason: `stray-close-tag:${closeTagName(raw)}` });
      this.atLineStart = false;
      return true;
    }
    if (probe === 'prose') {
      // '<' 是普通文本的一部分：原样透传，从 '<' 之后继续扫
      this.pushText(events, this.buf.slice(0, lt + 1));
      this.buf = this.buf.slice(lt + 1);
      this.atLineStart = false;
      return true;
    }
    // tag / tf-unknown / dsml：都进入 header 模式（后两者闭合时判 malformed 或改写）
    if (lt > 0) this.pushText(events, this.buf.slice(0, lt));
    this.buf = this.buf.slice(lt);
    this.mode = 'header';
    this.atLineStart = false;
    return true;
  }

  /**
   * 0.6.0 复查修复（P1）：在正文前缀 [0, hardEnd) 内扫"行首围栏开启行"。
   * 返回第一个开启行的行首偏移；无则 null。只扫完整行（行末有 `\n` 才可信——
   * 未闭合的 ` ``` ` 片段可能还在跨 chunk 累积，留给 stepFence/need-more 处理）。
   * 行首定义：位置 0（且本 parser 处于行首）或任意 `\n` 之后。
   * 行级判定复用 matchFenceOpen（完整行必然可判定；need-more 只会来自
   * "仅 ≤3 空格"的空行形态，按非围栏跳过）。
   */
  #scanFenceOpenPrefix(hardEnd: number): number | null {
    let lineStart = 0;
    if (!this.atLineStart) {
      const nl = this.buf.indexOf('\n');
      if (nl === -1 || nl >= hardEnd) return null;   // 首行是续行且无完整行 → 无候选
      lineStart = nl + 1;
    }
    for (;;) {
      const nl = this.buf.indexOf('\n', lineStart);
      if (nl === -1 || nl >= hardEnd) return null;   // hardEnd 之后才换行的行不在扫描范围
      const line = this.buf.slice(lineStart, nl);
      const verdict = matchFenceOpen(line);
      if (verdict !== null && verdict !== 'need-more') return lineStart;
      lineStart = nl + 1;
    }
  }

  /**
   * 0.5.1（2.1）：围栏内推进。开启行的剩余部分先当正文消费（首个换行之后才可能闭合）；
   * 之后逐行找闭合行（≤3 空格缩进、同标记字符、长度 ≥ 开启行、行内无其它字符）。
   * 找不到闭合时把"看起来可能是闭合行前缀"的尾巴扣留下来（跨 chunk 的 ``` 不会被判成正文）。
   */
  private stepFence(events: ParserEvent[]): boolean {
    const fence = this.fence!;
    if (!this.fenceBodyStarted) {
      const nl = this.buf.indexOf('\n');
      if (nl === -1) {
        if (this.buf !== '') {
          events.push({ type: 'text', text: this.buf });
          this.buf = '';
        }
        return false;
      }
      events.push({ type: 'text', text: this.buf.slice(0, nl + 1) });
      this.buf = this.buf.slice(nl + 1);
      this.fenceBodyStarted = true;
      return true;
    }
    const close = findFenceClose(this.buf, fence);
    if (close === null) {
      const keep = fenceTailKeep(this.buf, fence);
      const emit = this.buf.slice(0, this.buf.length - keep);
      if (emit !== '') events.push({ type: 'text', text: emit });
      this.buf = this.buf.slice(this.buf.length - keep);
      return false;
    }
    events.push({ type: 'text', text: this.buf.slice(0, close.end) });
    this.buf = this.buf.slice(close.end);
    this.fence = null;
    this.mode = 'ground';
    this.atLineStart = true;
    return true;
  }

  private stepHeader(events: ParserEvent[]): boolean {
    const close = scanHeaderClose(this.buf);
    if (!close) return false; // 等更多数据
    const raw = this.buf.slice(0, close.end + 1);
    this.buf = this.buf.slice(close.end + 1);
    this.mode = 'ground';

    // DSML 噪声（v0.3.1）：先于普通解析处理——`invoke name="tf-xxx" ...` 形态改写回
    // 等价 tf-* 头部（命令不丢）；其余包装行按 malformed 上报后丢弃（不进 prose）。
    if (isDsmlTag(raw)) {
      // v0.3.2：参数式 invoke → 进入块缓冲，按 parameter 归集属性。
      // 0.3.1 只认内联属性形态，parameter 子标签之间的值会作为 prose 泄漏（真机残片
      // `README.md r10` / `Get-ChildItem ... b902` 均由此产生）。
      // v0.4.2 补充：带内联属性的 invoke 同样缓冲（parseDsmlBlock 本就合并内联属性与
      // parameter——parameter 覆盖同名内联键）。此前内联属性走 parseDsmlHeader 进 body
      // 模式，非正文命令的 DSML 包装残片会被吞到流末才以 malformed 露出
      // （真机 session-8f22c7a0 step 2：三条闭合标签残片）。
      const dsml = parseDsmlTag(raw, close.selfClosing);
      if (
        dsml !== null
        // v0.4.2：自闭合 invoke（`.../>`）同样走缓冲——mangled name 抢救后属性齐全的
        // 自闭合调用照常发命令（parseDsmlBlock 的 selfClosing 分支立即 flush）。
        && dsml.name === 'invoke'
        && !dsml.closing
        && dsml.commandName !== null
      ) {
        this.dsmlBuf = raw;
        this.dsmlName = dsml.commandName;
        this.mode = 'dsml';
        return true;
      }
      const inline = parseDsmlHeader(raw, close.selfClosing);
      if (inline === null) {
        events.push({ type: 'malformed', raw, reason: 'dsml-wrapper' });
        return true;
      }
      const parsed = parseHeader(inline.synthetic);
      if ('error' in parsed || parsed.name === null) {
        events.push({ type: 'malformed', raw, reason: 'dsml-wrapper' });
        return true;
      }
      if (close.selfClosing) {
        this.emitCommand(events, parsed.name, parsed.attrs, parsed.dependsOn, undefined, raw);
      } else {
        this.bodyName = parsed.name;
        this.bodyAttrs = parsed.attrs;
        this.bodyDeps = parsed.dependsOn;
        this.bodyRawOpen = raw;
        this.bodyBuf = '';
        this.mode = 'body';
      }
      return true;
    }

    const parsed = parseHeader(raw);
    if ('error' in parsed) {
      events.push({ type: 'malformed', raw, reason: parsed.error });
      return true;
    }
    if (parsed.name === null) {
      // <tf- 前缀但命令名未知（probeTag 已判定 tf-unknown）
      events.push({ type: 'malformed', raw, reason: 'unknown-command' });
      return true;
    }
    if (close.selfClosing) {
      this.emitCommand(events, parsed.name, parsed.attrs, parsed.dependsOn, undefined, raw);
      return true;
    }
    // 配对形式打开：进入 body 模式（body 内容是否合法在闭合时判定）
    this.bodyName = parsed.name;
    this.bodyAttrs = parsed.attrs;
    this.bodyDeps = parsed.dependsOn;
    this.bodyRawOpen = raw;
    this.bodyBuf = '';
    this.mode = 'body';
    return true;
  }

  private stepBody(events: ParserEvent[]): boolean {
    const name = this.bodyName!;
    const schema = COMMAND_SCHEMAS[name];
    const closeTag = `</${name}>`;
    // v0.4.0（自 0.3.3 回流）：闭合标签允许空白/属性——旧实现只认逐字 `</tf-write>`，
    // 模型写成 `</tf-write >` 或 `</tf-write path="x">` 时永远找不到闭合，整段正文缓冲到
    // 流末按 truncated 丢弃（用户侧就是"写到一半没了"，真机 session-d6cd0759）。
    const close = findBodyClose(name, this.buf);
    const closeIdx = close === null ? -1 : close.index;
    // v0.3.2：非正文命令的配对开标签（少写 '/'）不得吞掉后续输出——遇到下一个
    // `<tf-` / `</tf-` 即视为本命令结束，命令照常派发，剩余文本回到 ground 继续解析。
    // v0.4.2 补充：DSML 标签同样是边界（包装残片立即露出，不吞到流末）。
    if (!schema.hasBody) {
      const boundary = findNonBodyBoundaryWithDsml(this.buf);
      if (boundary !== -1 && (closeIdx === -1 || boundary < closeIdx)) {
        const body = this.bodyBuf + this.buf.slice(0, boundary);
        const raw = this.bodyRawOpen + body;
        this.buf = this.buf.slice(boundary);
        this.mode = 'ground';
        const attrs = this.bodyAttrs!;
        const deps = this.bodyDeps!;
        this.bodyName = null;
        this.bodyAttrs = null;
        this.bodyDeps = null;
        this.bodyRawOpen = '';
        this.bodyBuf = '';
        if (body.trim() !== '') {
          events.push({ type: 'malformed', raw: body, reason: 'unexpected-body' });
          // 非正文命令后面的文本是模型 prose（不是命令输入）——归还正文，避免"输出变少"。
          events.push({ type: 'text', text: body });
        }
        this.emitCommand(events, name, attrs, deps, undefined, raw);
        return true;
      }
    }
    if (close === null) {
      // 闭合标签可能被拆在 chunk 边界上：扣留末尾若干字符。
      // v0.4.0（自 0.3.3 回流）：闭合标签允许空白/属性（</tf-write > / </tf-write path="x">），
      // 扣留窗口取 64 字符，避免跨 chunk 的带属性闭合被截断后整条正文按 truncated 丢弃。
      const keep = Math.min(Math.max(closeTag.length - 1, 64), this.buf.length);
      this.bodyBuf += this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      return false;
    }
    const body = this.bodyBuf + this.buf.slice(0, close.index);
    const raw = this.bodyRawOpen + body + this.buf.slice(close.index, close.end);
    this.buf = this.buf.slice(close.end);
    this.mode = 'ground';
    const attrs = this.bodyAttrs!;
    const deps = this.bodyDeps!;
    this.bodyName = null;
    this.bodyAttrs = null;
    this.bodyDeps = null;
    this.bodyRawOpen = '';
    this.bodyBuf = '';

    if (!schema.hasBody && body !== '') {
      // 非正文命令带正文：命令本身仍有效（属性齐），正文只记账不当作命令输入。
      // v0.3.2 起不再丢弃命令——0.3.1 会整条判 malformed，模型侧表现为"命令没执行"。
      events.push({ type: 'malformed', raw, reason: 'unexpected-body' });
      this.emitCommand(events, name, attrs, deps, undefined, raw);
      return true;
    }
    this.emitCommand(events, name, attrs, deps, schema.hasBody ? body : undefined, raw);
    return true;
  }

  /**
   * v0.3.2：DSML 参数式 invoke 块。缓冲到块闭合后一次性归集为命令：
   * 块内 `<｜｜DSML｜｜ parameter name="k">value</...>` 的 value 归入属性 k，
   * 不再作为 prose 泄漏；块内裸文本按命令正文处理（hasBody 命令）。
   */
  private stepDsml(events: ParserEvent[]): boolean {
    if (this.buf !== '') {
      this.dsmlBuf += this.buf;
      this.buf = '';
    }
    const term = findDsmlInvokeEnd(this.dsmlBuf, this.dsmlName);
    if (term === null) return false;
    const block = this.dsmlBuf.slice(0, term.end);
    const rest = this.dsmlBuf.slice(term.end);
    const expected = this.dsmlName;
    this.dsmlBuf = '';
    this.dsmlName = null;
    this.mode = 'ground';
    this.buf = rest;
    const parsed = parseDsmlBlock(block, expected, { allowIncompleteBody: true });
    for (const bad of parsed.malformed) {
      events.push({ type: 'malformed', raw: bad.raw, reason: bad.reason });
    }
    for (const cmd of parsed.commands) {
      this.emitCommand(events, cmd.name, cmd.attrs, cmd.dependsOn, cmd.body, cmd.raw);
    }
    return true;
  }

  private emitCommand(
    events: ParserEvent[],
    name: TfCommandName,
    attrs: Record<string, string>,
    deps: readonly string[],
    body: string | undefined,
    raw: string,
  ): void {
    const seq = ++this.seqCounter;
    const id = attrs['id'] ?? `cmd${++this.autoIdCounter}`;
    // 重复 id 不在 parser 层拦截（v0.2 起移交驱动器裁决）：同 id 同内容 = 幂等返回原回执，
    // 同 id 不同内容 = 拒绝换新 id，被拒命令可用原 id 修正重发（上游 ThinkFlow 分层语义：
    // "parser 仅在语义校验成功后登记 id"，id 幂等是 context/账本层职责）。
    const isDuplicate = this.commands.has(id);
    const { id: _ignored, ...rest } = attrs;
    const command: TfCommand = { name, id, attrs: rest, body, depends_on: deps, seq };
    this.commands.set(id, command);
    events.push({ type: 'command', command });

    // 命令闭合后立即做环检测（depends_on 图只含已闭合命令）
    const cycle = this.findCycle();
    if (cycle) {
      const key = cycle.join('>');
      if (!this.emittedCycleKeys.has(key)) {
        this.emittedCycleKeys.add(key);
        events.push({ type: 'cycle', cycle });
      }
    }
  }

  /** 在已闭合命令的依赖图中找环（DFS 三色标记），返回路径 [a, ..., a] 或 null。 */
  private findCycle(): readonly string[] | null {
    const state = new Map<string, 0 | 1 | 2>();
    const path: string[] = [];
    let found: string[] | null = null;
    const dfs = (id: string): void => {
      if (found) return;
      const st = state.get(id) ?? 0;
      if (st === 1) {
        found = [...path.slice(path.indexOf(id)), id];
        return;
      }
      if (st === 2) return;
      state.set(id, 1);
      path.push(id);
      for (const d of this.commands.get(id)!.depends_on) {
        if (this.commands.has(d)) dfs(d);
        if (found) return;
      }
      path.pop();
      state.set(id, 2);
    };
    for (const id of this.commands.keys()) {
      if (found) break;
      dfs(id);
    }
    return found;
  }
}

// ---------------------------------------------------------------------------
// 围栏（0.5.1 / 2.1）
// ---------------------------------------------------------------------------

/**
 * 行首围栏开启判定。返回标记字符与长度（长度 ≥3）以及开启行的消费终点；
 * 'need-more' = 当前缓冲还不足以判定（只有 ≤3 个空格、或 <3 个同字符标记）；
 * null = 这一行不是围栏（普通正文）。
 *
 * 缩进规则对齐 CommonMark：0–3 个空格算围栏，4 个及以上是缩进代码块（不开启围栏）。
 * 反引号围栏的 info string 不得再含反引号（否则是行内代码的畸形写法，不当作围栏）。
 */
function matchFenceOpen(buf: string): { ch: '`' | '~'; len: number; end: number } | 'need-more' | null {
  let i = 0;
  while (i < 3 && buf[i] === ' ') i += 1;
  if (i === buf.length) return 'need-more'; // 只有 ≤3 个空格：可能还在围栏缩进里
  const ch = buf[i];
  if (ch !== '`' && ch !== '~') return null;
  let j = i;
  while (buf[j] === ch) j += 1;
  const len = j - i;
  if (len < 3) {
    // 只有标记字符（可能还在跨 chunk 累积）→ 等更多数据；出现其它字符 → 不是围栏
    const rest = buf.slice(i);
    return /^[`~]*$/.test(rest) ? 'need-more' : null;
  }
  if (ch === '`') {
    // 反引号围栏的 info string 不允许含反引号——含了就是行内代码的畸形写法
    const lineEnd = buf.indexOf('\n', j);
    const info = lineEnd === -1 ? buf.slice(j) : buf.slice(j, lineEnd);
    if (info.includes('`')) return null;
  }
  return { ch, len, end: j };
}

/** 围栏内找闭合行：≤3 空格缩进 + 同标记字符 + 长度 ≥ 开启行 + 行内无其它字符。 */
function findFenceClose(buf: string, fence: FenceState): { end: number } | null {
  let pos = 0;
  for (;;) {
    const nl = buf.indexOf('\n', pos);
    if (nl === -1) return null; // 未完整行：等更多数据（可能正是被拆开的闭合行）
    const line = buf.slice(pos, nl);
    if (isFenceCloseLine(line, fence)) return { end: nl + 1 };
    pos = nl + 1;
  }
}

function isFenceCloseLine(line: string, fence: FenceState): boolean {
  const m = /^( {0,3})([`~]+)[ \t]*$/.exec(line);
  if (m === null) return false;
  // 0.6.0 复查修复（P2，CommonMark 闭合规则）：闭合行的标记串必须**全部**由开启字符构成——
  // 此前 [`~]+ 允许混合串（` ```~~~ ` 整行被一次吃掉判闭合），围栏提前关闭、其后本应
  // 受保护的 `<tf-*>` 被真实执行。现在逐字符校验与开启字符一致。
  const run = m[2]!;
  return run[0] === fence.ch && run.length >= fence.len && run.split('').every((c) => c === fence.ch);
}

/**
 * 扣留可能是"闭合行前缀"的尾巴（跨 chunk 的 ``` 不被提前当作正文发出）。
 * 只扣留最后一行里 ≤3 空格 + 同标记字符（可带尾随空白）的形态；其余一律放行。
 */
function fenceTailKeep(buf: string, fence: FenceState): number {
  const nl = buf.lastIndexOf('\n');
  const tail = nl === -1 ? buf : buf.slice(nl + 1);
  if (tail === '') return 0;
  const m = /^ {0,3}([`~]*)[ \t]*$/.exec(tail);
  if (m === null) return 0;
  const markers = m[1]!;
  if (markers !== '' && markers[0] !== fence.ch) return 0;
  if (markers.length > fence.len + 3) return 0; // 明显不是闭合行，别无限扣留
  return tail.length;
}

// ---------------------------------------------------------------------------
// 头部扫描与属性解析
// ---------------------------------------------------------------------------

/**
 * 引号感知地找头部结束 '>'。
 * 属性值（如 cmd="a > b"）里的 '>' 不终止头部。返回 null 表示需要更多数据。
 */
function scanHeaderClose(buf: string): { end: number; selfClosing: boolean } | null {
  let inQuote = false;
  for (let i = 1; i < buf.length; i++) {
    const ch = buf[i];
    if (inQuote) {
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
    } else if (ch === '>') {
      return { end: i, selfClosing: buf[i - 1] === '/' };
    }
  }
  // v0.4.2：引号不成对（mangled DSML name 值，奇数个引号——真机 session-d6cd0759
  // seq 110）时严格扫描永不闭合，header 模式等死，整条命令在流末按 malformed 丢弃。
  // 退化通道：取**第一个**满足"前驱是 ""（属性收尾）或 /"（自闭合）"的 '>' 作为
  // 标签端界——不能取最后一个 '>'：mangled 开标签后面跟着命令正文（Python 代码含
  // '>'），取最后一个会把正文整段吞进标签再丢弃（真机 seq 104：整个 selfcheck 脚本
  // 被吞）。残片形态（无端界）仍返回 null 等更多数据；正常标签引号成对，严格扫描
  // 先行命中，退化通道不触发。
  for (let i = 1; i < buf.length; i++) {
    if (buf[i] !== '>') continue;
    const prev = buf[i - 1];
    if (prev === '"' || (prev === '/' && buf[i - 2] === '"')) {
      return { end: i, selfClosing: prev === '/' };
    }
  }
  return null;
}

/**
 * v0.4.0（自 0.3.3 回流）：正文/命令闭合标签查找（允许空白与属性）。
 *
 * 旧实现只认逐字 `</tf-write>`：模型写成 `</tf-write >` 或 `</tf-write path="x">` 时
 * 永远找不到闭合，整段正文缓冲到流末按 truncated 丢弃——用户侧就是"写到一半没了"。
 * 这里按标签名找起点，再用与 header 同一个引号感知扫描取端界：
 *   - 名字后必须是空白 / `>` / `/`（`</tf-writex>` 不算）；
 *   - 属性值里含 `>` 也不会截半；
 *   - 跨 chunk 未闭合返回 null（调用方扣留尾部继续等）。
 *
 * 返回 end = 闭合标签之后的切片终点（`</tf-write>` → index+11）。
 */
function findBodyClose(name: string, buf: string): { index: number; end: number } | null {
  const needle = `</${name}`;
  let from = 0;
  for (;;) {
    const index = buf.indexOf(needle, from);
    if (index === -1) return null;
    const next = buf[index + needle.length];
    if (next === undefined) return null; // 闭合标签被拆在 chunk 边界：等更多数据
    if (next === '>' || next === '/' || /\s/.test(next)) {
      const close = scanHeaderClose(buf.slice(index));
      if (close !== null) return { index, end: index + close.end + 1 };
    }
    from = index + needle.length;
  }
}

// ---------------------------------------------------------------------------
// DSML 噪声归一化（v0.3.1）
// ---------------------------------------------------------------------------

/** DSML 前缀："<" 后跟全角竖线（U+FF5C）串 + "DSML" + 全角竖线串。观察到的真机形态：
 *  `<｜｜DSML｜｜ calls>`、`<｜｜DSML｜｜ invoke name="tf-plan" id="p1">`。 */
const DSML_TAG_RE = /^<\/?｜+DSML｜*/;

/** 判定一段头部原文是否是 DSML 噪声标签（probeTag 'dsml' 的闭合侧复核）。 */
function isDsmlTag(raw: string): boolean {
  return DSML_TAG_RE.test(raw);
}

/** 从孤立闭合标签原文取命令名（`</tf-bash>` → `tf-bash`；通配 `</tf-*>` → `tf-*`；
 *  半截标签 → `?`）。v0.4.0：名字字符集含 `*`——通配闭合也要如实进台账。 */
function closeTagName(raw: string): string {
  const m = /^<\/\s*(tf-[a-z0-9*-]*)/.exec(raw);
  return m === null ? '?' : m[1]!;
}

/**
 * 尝试把 DSML 头部改写为等价 tf-* 头部。
 * 可改写形态：`<｜｜DSML｜｜ invoke name="tf-xxx" 其余属性/>`（或配对打开）——
 * 返回合成头部原文（`<tf-xxx 其余属性...>`）；包装行（calls 等）与无法解析的
 * 属性段返回 null（调用方按 malformed 上报丢弃，绝不作为 prose 透传）。
 */
function parseDsmlHeader(raw: string, selfClosing: boolean): { synthetic: string } | null {
  // 去掉 '<' 与结尾 '>'（或 '/>'），取 DSML 前缀之后的剩余段
  let inner = raw.slice(1);
  if (selfClosing && inner.endsWith('/>')) inner = inner.slice(0, -2);
  else if (inner.endsWith('>')) inner = inner.slice(0, -1);
  const rest = inner.replace(/^\/?｜+DSML｜*/, '');
  const invoke = rest.match(/^\s*invoke\s+name="(tf-[a-z]+)"([\s\S]*)$/);
  if (invoke === null) return null;
  const [, name, attrsPart] = invoke as unknown as [string, string, string];
  if (!COMMAND_NAMES.includes(name as TfCommandName)) return null;
  // 属性段原样拼接：dsml 属性语法与 tf 协议一致（key="value"），交 parseHeader 统一校验
  return { synthetic: `<${name}${attrsPart}${selfClosing ? '/>' : '>'}` };
}

// ---------------------------------------------------------------------------
// DSML 参数式 invoke（v0.3.2）
// ---------------------------------------------------------------------------

interface DsmlTag {
  /** 标签名（invoke / calls / parameter …，已去掉 DSML 前缀） */
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /** 标签内 key="value" 属性 */
  attrs: Record<string, string>;
  /** invoke 的 name 属性是合法 tf-* 命令名时给出 */
  commandName: TfCommandName | null;
}

/** 解析单个 DSML 标签原文（不含前后空白）。非 DSML 形态返回 null。 */
function parseDsmlTag(raw: string, selfClosing: boolean): DsmlTag | null {
  if (!isDsmlTag(raw)) return null;
  let inner = raw.slice(1);
  const closing = inner.startsWith('/');
  if (closing) inner = inner.slice(1);
  if (inner.endsWith('/>')) inner = inner.slice(0, -2);
  else if (inner.endsWith('>')) inner = inner.slice(0, -1);
  const m = inner.match(/^｜+DSML｜*\s*([a-zA-Z][a-zA-Z0-9_-]*)([\s\S]*)$/);
  if (m === null) return null;
  const name = m[1]!;
  // v0.4.2：mangled name 值抢救——模型把全部属性塞进了 name 值且忘了闭引号
  // （真机 session-d6cd0759 seq 110：`name="tf-peek handle="obs:bash:b3@v1"
  //  from_line="1" to_line="30" id="p3"/>`——整条 peek 丢失）。name 值以合法
  //  tf-* 命令名开头且带空格时，把 "name=\"tf-xxx " 改写为 "name=\"tf-xxx\" "，
  //  余段还原为正常属性对（引号结构本就完好）。
  let attrSegment = m[2]!;
  const nameAttr = /\sname\s*=\s*"(tf-[a-z]+)\s+/.exec(attrSegment);
  if (nameAttr !== null && COMMAND_NAMES.includes(nameAttr[1] as TfCommandName)) {
    attrSegment = attrSegment.replace(nameAttr[0], ` name="${nameAttr[1]}" `);
  }
  const attrs = parseAttrPairs(attrSegment);
  const commandName = attrs['name'] !== undefined && COMMAND_NAMES.includes(attrs['name'] as TfCommandName)
    ? (attrs['name'] as TfCommandName)
    : null;
  return { name, closing, selfClosing, attrs, commandName };
}

/** v0.4.2：属性值的 XML 实体解码。模型带 XML 习惯输出属性（真机 session-8f22c7a0
 *  step 5：`cmd="... Write-Output &quot;EXIT=$LASTEXITCODE&quot;"`——实体原样进了
 *  PowerShell，命令解析报错，白白烧一步）。只解码有界实体集 + 数字引用；`&` 本身
 *  不在实体里的原样保留（不猜）。单遍替换：&amp;quot; 还原为 &quot; 不二次展开。 */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => (
      name === 'lt' ? '<' : name === 'gt' ? '>' : name === 'quot' ? '"' : name === 'apos' ? '\'' : '&'
    ))
    // 0.6.0 复查修复（P4）：数字实体码点越界（&#x110000; 等）此前直接 String.fromCodePoint
    // 抛 RangeError——feed() 无兜底，整条流解析中断。解析器纪律是"绝不因畸形输入抛异常"：
    // 越界/代理区间的引用原样保留（实体不还原，无害不崩溃）。
    .replace(/&#x([0-9a-fA-F]+);/g, (whole: string, hex: string) => safeCodePoint(whole, parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (whole: string, dec: string) => safeCodePoint(whole, parseInt(dec, 10)));
}

function safeCodePoint(raw: string, code: number): string {
  return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF && !(code >= 0xD800 && code <= 0xDFFF)
    ? String.fromCodePoint(code)
    : raw;
}

/** 从 `k="v" k2="v2"` 属性段提取键值（引号内允许 '>'；重复键后者覆盖，交由 schema 兜底）。 */
function parseAttrPairs(segment: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    // v0.4.2：与 parseHeader 同款的内嵌引号容忍扫描。valueStart 是**绝对**下标
    // （m.index + m[0].length）——用相对偏移会把搜索起点挪回段首，re.lastIndex
    // 不前进 = 零进度死循环。
    const valueStart = m.index + m[0].length;
    let value = '';
    let next = valueStart;
    for (let q = segment.indexOf('"', valueStart); q !== -1; q = segment.indexOf('"', q + 1)) {
      const after = segment.slice(q + 1);
      if (/^\s+[a-zA-Z][a-zA-Z0-9_-]*\s*=/.test(after) || /^\/?>/.test(after) || after.trim() === '') {
        value = segment.slice(valueStart, q);
        next = q + 1;
        break;
      }
    }
    if (next === valueStart) {
      // 没找到合法闭引号：退化取到段尾（DSML 开标签段以标签结尾界定，段尾即值尾）。
      value = segment.slice(valueStart);
      next = segment.length;
    }
    attrs[m[1]!] = decodeXmlEntities(value);
    re.lastIndex = Math.max(next, m.index + m[0].length + 1);
  }
  return attrs;
}

/**
 * 非正文命令配对开标签的恢复边界（基础版，仅 tf 标签）：下一个 `<tf-` / `</tf-` 的
 * 位置（-1 = 没有）。DSML 块缓冲的消费（findDsmlInvokeEnd）也用它——缓冲块内部的
 * DSML 标签属于块本身，绝不能当边界（否则 `<｜` 即块结束 = 解析死循环）。
 */
function findNonBodyBoundary(buf: string): number {
  const a = buf.indexOf('<tf-');
  const b = buf.indexOf('</tf-');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

/**
 * v0.4.2：body 模式的扩展边界（tf 标签 + DSML 标签）。只在 stepBody 的非正文分支
 * 使用——真机（session-8f22c7a0 step 2）里 DSML invoke 走完内联路径后，parameter/
 * invoke/closes 包装残片被 body 模式整体吞掉、到流末才以 malformed 露出；DSML 标签
 * 出现即视为本命令结束（残片按既有 malformed 纪律处理，绝不作为 prose 透传）。
 */
function findNonBodyBoundaryWithDsml(buf: string): number {
  const base = findNonBodyBoundary(buf);
  const c = buf.indexOf('<｜');
  const d = buf.indexOf('</｜');
  let min = base;
  for (const v of [c, d]) {
    if (v === -1) continue;
    if (min === -1 || v < min) min = v;
  }
  return min;
}

/** DSML 段结束位置（含结束标签本身）：`</invoke>` / `</tf-name>` / （非正文）下一个 tf 标签。 */
function findDsmlInvokeEnd(buf: string, name: TfCommandName | null): { end: number } | null {
  // v0.4.2：缓冲分支现也接收**自闭合** invoke（mangled name 抢救后的形态）——开标签
  // 自身以 `/>` 结束时它就是块尾。end 约定 = 切片**含端点**（+1 跨过 `>` 本身，
  // 与 invokeClose/tagClose 分支的"一次过闭合标签"约定一致）。
  const selfEnd = scanHeaderClose(buf);
  if (selfEnd !== null && selfEnd.selfClosing && /^\s*<\s*｜+DSML｜*\s*invoke\b/.test(buf)) {
    return { end: selfEnd.end + 1 };
  }
  let end = -1;
  const invokeClose = /<\/\s*｜+DSML｜*\s*invoke\s*>/g;
  const m = invokeClose.exec(buf);
  if (m !== null) end = m.index + m[0].length;
  if (name !== null) {
    // v0.4.0（自 0.3.3 回流）：闭合标签允许空白/属性（`</tf-write >` / `</tf-write path="x">`）。
    const tagClose = findBodyClose(name, buf);
    if (tagClose !== null && (end === -1 || tagClose.end < end)) {
      end = tagClose.end;
    }
    if (!COMMAND_SCHEMAS[name].hasBody) {
      const boundary = findNonBodyBoundary(buf);
      if (boundary !== -1 && (end === -1 || boundary < end)) end = boundary;
    }
  }
  return end === -1 ? null : { end };
}

interface DsmlCommand {
  name: TfCommandName;
  attrs: Record<string, string>;
  dependsOn: readonly string[];
  body?: string;
  raw: string;
}

type DsmlToken =
  | { kind: 'tag'; tag: DsmlTag; raw: string }
  | { kind: 'text'; text: string };

/** 把 DSML 块切成「DSML 标签 / 文本」两类 token；非 DSML 的 '<' 留在文本里。 */
function tokenizeDsmlBlock(block: string): DsmlToken[] {
  const out: DsmlToken[] = [];
  let i = 0;
  while (i < block.length) {
    const lt = block.indexOf('<', i);
    if (lt === -1) {
      out.push({ kind: 'text', text: block.slice(i) });
      break;
    }
    if (lt > i) out.push({ kind: 'text', text: block.slice(i, lt) });
    const after = block.slice(lt);
    if (!/^<\/?｜/.test(after)) {
      out.push({ kind: 'text', text: '<' });
      i = lt + 1;
      continue;
    }
    const close = scanHeaderClose(after);
    if (close === null) {
      out.push({ kind: 'text', text: after });
      break;
    }
    const raw = after.slice(0, close.end + 1);
    const tag = parseDsmlTag(raw, close.selfClosing);
    if (tag === null) out.push({ kind: 'text', text: raw });
    else out.push({ kind: 'tag', tag, raw });
    i = lt + close.end + 1;
  }
  return out;
}

/**
 * 解析一个 DSML invoke 块（可能含 parameter 子标签）。
 *
 * - `parameter name="k"` 的标签间文本 → 属性 k（多行原样，去掉首尾各一个换行）；
 * - 正文类参数（content/body/code/text）→ 命令 body（hasBody 命令）；
 * - 块内裸文本 → hasBody 命令的 body；tf-final 无 summary 时兜底为最终答案；
 * - 非正文命令带正文 → malformed(unexpected-body) 但命令仍发（不丢工作）；
 * - `allowIncompleteBody=false` 时，未闭合的正文命令不回放（避免写半截文件）。
 */
function parseDsmlBlock(
  block: string,
  expected: TfCommandName | null,
  opts: { allowIncompleteBody: boolean },
): { commands: DsmlCommand[]; malformed: Array<{ raw: string; reason: string }> } {
  const commands: DsmlCommand[] = [];
  const malformed: Array<{ raw: string; reason: string }> = [];
  let cur: {
    name: TfCommandName | null;
    attrs: Record<string, string>;
    text: string;
    params: Record<string, string>;
    paramName: string | null;
    paramValue: string;
    raw: string;
    complete: boolean;
  } | null = null;

  const flush = (complete: boolean): void => {
    if (cur === null) return;
    const item = cur;
    cur = null;
    if (item.paramName !== null) item.params[item.paramName] = trimParamValue(item.paramValue);
    const name = item.name ?? expected;
    if (name === null) {
      malformed.push({ raw: item.raw, reason: 'dsml-unknown-invoke' });
      return;
    }
    const schema = COMMAND_SCHEMAS[name];
    const attrs: Record<string, string> = { ...item.attrs };
    const bodyKeys = ['content', 'body', 'code', 'text'];
    let bodyFromParam: string | undefined;
    for (const key of bodyKeys) {
      if (item.params[key] !== undefined) {
        bodyFromParam = item.params[key];
        delete item.params[key];
      }
    }
    for (const [k, v] of Object.entries(item.params)) attrs[k] = v;
    if (!complete && schema.hasBody && !opts.allowIncompleteBody) {
      malformed.push({ raw: item.raw + item.text, reason: 'unclosed-dsml-body' });
      return;
    }
    let body: string | undefined;
    if (schema.hasBody) {
      // v0.4.2：块以命令自身的配对闭合（</name>）终止时，闭合标签会被 tokenizer 当作
      // 块内文本累积——剥掉尾部闭合，正文才干净（与 body 模式的消费语义一致）。
      // v0.4.0（自 0.3.3 回流）：闭合允许空白/属性（`</tf-write >` / `</tf-write path="x">`）。
      let text = item.text;
      if (bodyFromParam === undefined) {
        const tailClose = new RegExp(`<\\/${name}\\s*(\\s[^>]*)?>\\s*$`).exec(text);
        if (tailClose !== null) text = text.slice(0, tailClose.index);
      }
      body = bodyFromParam ?? text.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    } else if (bodyFromParam !== undefined || item.text.trim() !== '') {
      malformed.push({ raw: item.raw + item.text, reason: 'unexpected-body' });
      if (name === 'tf-final' && attrs['summary'] === undefined) {
        attrs['summary'] = (bodyFromParam ?? item.text).trim();
      }
    }
    const validated = validateCommandAttrs(name, attrs);
    if ('error' in validated) {
      malformed.push({ raw: item.raw, reason: `dsml-invoke:${validated.error}` });
      return;
    }
    commands.push({ name, attrs: validated.attrs, dependsOn: validated.dependsOn, body, raw: item.raw });
  };

  for (const token of tokenizeDsmlBlock(block)) {
    if (token.kind === 'text') {
      if (cur === null) {
        if (token.text.trim() !== '') malformed.push({ raw: token.text, reason: 'dsml-text' });
        continue;
      }
      if (cur.paramName !== null) cur.paramValue += token.text;
      else cur.text += token.text;
      continue;
    }
    const tag = token.tag;
    if (tag.name === 'calls') continue;
    if (tag.name === 'invoke') {
      if (tag.closing) {
        flush(true);
        continue;
      }
      flush(true);
      if (tag.commandName === null) {
        malformed.push({ raw: token.raw, reason: 'dsml-unknown-invoke' });
        continue;
      }
      const { name: _n, ...rest } = tag.attrs;
      cur = {
        name: tag.commandName,
        attrs: rest,
        text: '',
        params: {},
        paramName: null,
        paramValue: '',
        raw: token.raw,
        complete: false,
      };
      if (tag.selfClosing) flush(true);
      continue;
    }
    if (tag.name === 'parameter') {
      if (tag.closing) {
        if (cur !== null && cur.paramName !== null) {
          cur.params[cur.paramName] = trimParamValue(cur.paramValue);
          cur.paramName = null;
          cur.paramValue = '';
        }
        continue;
      }
      if (cur === null) {
        malformed.push({ raw: token.raw, reason: 'dsml-stray-parameter' });
        continue;
      }
      const key = tag.attrs['name'];
      if (key === undefined) {
        malformed.push({ raw: token.raw, reason: 'dsml-parameter-without-name' });
        continue;
      }
      cur.paramName = key;
      cur.paramValue = '';
      if (tag.selfClosing) {
        cur.params[key] = '';
        cur.paramName = null;
      }
      continue;
    }
    malformed.push({ raw: token.raw, reason: `dsml-unknown-tag:${tag.name}` });
  }
  flush(false);
  return { commands, malformed };
}

/** parameter 值：去掉首尾各一个换行（模型习惯把值写在标签下一行）。 */
function trimParamValue(value: string): string {
  return value.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
}

/** 属性 schema 校验（parseHeader 与 DSML 块共用；校验失败返回结构化 error）。 */
function validateCommandAttrs(
  name: TfCommandName,
  attrs: Record<string, string>,
): { attrs: Record<string, string>; dependsOn: readonly string[] } | { error: string } {
  const schema = COMMAND_SCHEMAS[name];
  const allowed = new Set([...COMMON_ATTRS, ...schema.required, ...schema.optional]);
  // v0.4.2：未知属性**降级丢弃**而不是拒整条命令（真机 session-ec100f8a seq 91：
  // 模型写 `lines="1-20"`（schema 是 from_line/to_line），旧实现把整条 tf-peek 拒掉）。
  // `lines="N-M"` 识别为 from_line/to_line 的习惯写法并归一；其余未知属性原样丢弃。
  // 必需属性缺失仍然拒（缺 path 的 write 不能猜）。
  const kept: Record<string, string> = {};
  for (const key of Object.keys(attrs)) {
    if (!allowed.has(key)) continue;
    kept[key] = attrs[key]!;
  }
  const lines = attrs['lines'];
  if (lines !== undefined && (name === 'tf-peek' || name === 'tf-read')) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(lines);
    if (range !== null) {
      if (kept['from_line'] === undefined) kept['from_line'] = range[1]!;
      if (kept['to_line'] === undefined) kept['to_line'] = range[2]!;
    }
  }
  for (const req of schema.required) {
    if (kept[req] === undefined) return { error: `missing-attribute:${req}` };
  }
  for (const key of ['from_line', 'to_line']) {
    if (kept[key] !== undefined && !/^\d+$/.test(kept[key])) {
      return { error: `bad-integer-attribute:${key}` };
    }
  }
  return { attrs: kept, dependsOn: buildDependsOn(kept) };
}

/** depends_on：逗号分隔，去空、去重、保序。 */
function buildDependsOn(attrs: Record<string, string>): string[] {
  const dependsOn: string[] = [];
  if (attrs['depends_on'] === undefined) return dependsOn;
  const seen = new Set<string>();
  for (const part of attrs['depends_on'].split(',')) {
    const d = part.trim();
    if (d === '' || seen.has(d)) continue;
    seen.add(d);
    dependsOn.push(d);
  }
  return dependsOn;
}

type HeaderParse =
  | { name: TfCommandName; attrs: Record<string, string>; dependsOn: readonly string[] }
  | { name: null; attrs: Record<string, string>; dependsOn: readonly string[] }
  | { error: string };

/**
 * 解析头部原文（形如 `<tf-read path="a.ts" id="r1"/>`）。
 * 自闭合与否由调用方判定，这里只取名字与属性；schema 校验失败返回 error。
 */
function parseHeader(raw: string): HeaderParse {
  // 去掉 '<'、结尾的 '>' 或 '/>'
  let inner = raw.slice(1);
  if (inner.endsWith('/>')) inner = inner.slice(0, -2);
  else if (inner.endsWith('>')) inner = inner.slice(0, -1);

  const nameMatch = inner.match(/^tf-[a-z]+/);
  if (!nameMatch) return { error: 'bad-command-name' };
  const nameCandidate = nameMatch[0];
  const known = COMMAND_NAMES.find((n) => n === nameCandidate) ?? null;

  let rest = inner.slice(nameCandidate.length);
  const attrs: Record<string, string> = {};
  for (;;) {
    const ws = rest.match(/^\s+/);
    if (ws) {
      rest = rest.slice(ws[0].length);
      continue;
    }
    if (rest === '') break;
    // v0.4.2：属性值容忍内嵌引号。简单正则 `([^"]*)` 在值含 `"` 时撑破
    // （真机 session-ec100f8a seq 134：PowerShell cmd 内嵌引号 → 整条命令丢失）。
    // 闭引号判定：`"` 后面跟（下一段 `key="` 模式 | 标签结尾 `>`/`/>` | inner 末尾）。
    const attr = rest.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*"/);
    if (!attr) return { error: `bad-attribute-syntax:${rest.slice(0, 20)}` };
    const valueStart = attr[0].length;
    let scanned: { value: string; next: number } | null = null;
    for (let q = rest.indexOf('"', valueStart); q !== -1; q = rest.indexOf('"', q + 1)) {
      const after = rest.slice(q + 1);
      if (/^\s+[a-zA-Z][a-zA-Z0-9_-]*\s*=/.test(after) || /^\/?>/.test(after) || after.trim() === '') {
        scanned = { value: rest.slice(valueStart, q), next: q + 1 };
        break;
      }
    }
    if (scanned === null) return { error: `bad-attribute-syntax:${rest.slice(0, 20)}` };
    const key = attr[1];
    if (key in attrs) return { error: `duplicate-attribute:${key}` };
    attrs[key] = decodeXmlEntities(scanned.value);
    rest = rest.slice(scanned.next);
  }

  // depends_on：逗号分隔，去空、去重、保序
  const dependsOn = buildDependsOn(attrs);

  if (known === null) return { name: null, attrs, dependsOn };

  const validated = validateCommandAttrs(known, attrs);
  if ('error' in validated) return { error: validated.error };
  return { name: known, attrs: validated.attrs, dependsOn: validated.dependsOn };
}

/**
 * 判定 ground 模式下 '<' 起始的文本是否是协议标签的开始。
 * need-more：数据不足以判定，等待下一个 chunk。
 */
function probeTag(s: string): TagProbe {
  if (!s.startsWith('<')) return 'prose';
  if (s.length === 1) return 'need-more';
  // DSML 噪声（v0.3.1）："<" 后直接跟全角竖线（U+FF5C）——协议没有任何合法形式以
  // "<｜"（或 "</｜"）开头，无需等待更多数据即可判定（不再作为 prose 透传）。
  if (s[1] === '｜' || (s[1] === '/' && s[2] === '｜')) return 'dsml';
  // 孤立闭合标签（v0.3.1 截断修复）：'</tf-xxx>' 只在 body 模式由 stepBody 消费；
  // 出现在 ground = 没有配对打开。判 'close-tag' 后调用方记账丢弃（绝不落进 prose）。
  // 必须放在已知命令名扫描之前：'</tf-' 永远不匹配 '<tf-' 候选，留到最后会被误判 prose。
  if (s.startsWith('</')) {
    if ('</tf-'.startsWith(s)) return 'need-more'; // '</' / '</t' / '</tf' / '</tf-'：闭合标签开头
    if (/^<\/tf-[a-z0-9-]*\s*>/.test(s)) return 'close-tag';
    // v0.4.0（自 0.3.3 回流）：畸形闭合变体（协议命名空间内）——通配 `</tf-*>`、带属性
    // `</tf-write path="x">` 等。判别式：`</tf-` 紧跟非空白（与"正文里提到 </tf"区分，
    // 如 `</tf 不在标签位` 仍是 prose），且引号感知地存在 '>'（闭合尝试成形）。
    // 真机证据 2026-11-20（桌面端会话）：`</tf-*>` 两度作为 prose 落进 assistant 正文
    // ——0.3.1 治理只覆盖「合法闭合形态」，畸形变体全数漏网，且模型拿不到纠错信号，
    // 同一会话内重复犯错。引号感知 '>' 的存在使 `cmd="a>b"` 这类属性值不会被误判成
    // token 端界。>200 字符仍无 '>'：按 runaway 残片记账丢弃（与 DSML 同纪律），不无限缓冲。
    if (/^<\/tf-\S/.test(s)) {
      const close = scanHeaderClose(s);
      if (close !== null) return 'close-tag';
      return s.length > 200 ? 'close-tag' : 'need-more';
    }
    if (/^<\/tf-?[a-z0-9-]*$/.test(s)) return 'need-more'; // 还没等到 '>'
    return 'prose'; // '</div>' 之类：确属正文
  }
  for (const name of COMMAND_NAMES) {
    const open = `<${name}`;
    if (s.length <= open.length) {
      // 还没长过这个候选：仍是其前缀 → 待定；已分叉 → 换下一个候选
      if (open.startsWith(s)) return 'need-more';
      continue;
    }
    if (s.startsWith(open)) {
      const c = s[open.length];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '/' || c === '>') {
        return 'tag';
      }
      // 该候选名后跟了非法字符（如 '<tf-writex'）→ 换下一个候选（实际不会命中）
    }
  }
  if (s.startsWith('<tf-')) {
    // tf- 前缀但不是已知名，且已长到足以排除所有候选 → 协议尝试失败
    //（若仍是某个已知名的前缀，上面的循环已返回 need-more）
    return 'tf-unknown';
  }
  return 'prose';
}

// ---------------------------------------------------------------------------
// 便捷入口：AsyncIterable<string> → 事件列表
// ---------------------------------------------------------------------------

/** 整流解析（测试/重放用）。生产路径走 feed()/end() 以便闭合即派发。 */
export async function parseStream(src: AsyncIterable<string>): Promise<ParserEvent[]> {
  const parser = new TfStreamParser();
  const events: ParserEvent[] = [];
  for await (const delta of src) {
    events.push(...parser.feed(delta));
  }
  events.push(...parser.end());
  return events;
}

// ---------------------------------------------------------------------------
// tf-edit body 的标记切分（F1；纯函数，映射层与测试共用）
// ---------------------------------------------------------------------------

/** tf-edit body 的三行标记（各占一行；正文里恰好出现该行时按结构化失败处理，不猜测）。 */
export const TF_EDIT_MARKERS = { old: '<<<<<<< OLD', split: '=======', end: '>>>>>>> NEW' } as const;

export interface EditBodySplit {
  /** 待替换的精确字面量（宿主 edit 的 old_string）。 */
  old: string;
  /** 替换后的字面量（宿主 edit 的 new_string）。 */
  new: string;
}

/**
 * 切分 tf-edit body：`<<<<<<< OLD` 与 `>>>>>>> NEW` 两行之间以 `=======` 行为界，
 * 前段 = old、后段 = new。标记行必须各出现一次且顺序正确；正文换行结构原样保留。
 * 解析失败返回 null（调用方必须回结构化失败，不得静默改成全文重写）。
 *
 * 0.5.2（审计 C-8）：同时接受上游 thinkflow 的 `<old>…</old><new>…</new>` 写法——
 * 上游 47 模块移植过来的提示词与既有会话历史都是这个形状，只认三行标记等于把
 * 上游存量输入全判成"格式错误"。
 */
export function splitEditBody(body: string): EditBodySplit | null {
  return splitEditBodyByMarkers(body) ?? splitEditBodyByTags(body);
}

/** 三行标记形态（0.3.0 起的原生写法）。 */
export function splitEditBodyByMarkers(body: string): EditBodySplit | null {
  const lines = body.split('\n');
  const idxOld = lines.indexOf(TF_EDIT_MARKERS.old);
  const idxSplit = lines.indexOf(TF_EDIT_MARKERS.split);
  const idxEnd = lines.indexOf(TF_EDIT_MARKERS.end);
  if (idxOld === -1 || idxSplit === -1 || idxEnd === -1) return null;
  if (!(idxOld < idxSplit && idxSplit < idxEnd)) return null;
  if (lines.indexOf(TF_EDIT_MARKERS.old, idxOld + 1) !== -1) return null;
  if (lines.indexOf(TF_EDIT_MARKERS.split, idxSplit + 1) !== -1) return null;
  if (lines.indexOf(TF_EDIT_MARKERS.end, idxEnd + 1) !== -1) return null;
  const old = lines.slice(idxOld + 1, idxSplit).join('\n');
  const $new = lines.slice(idxSplit + 1, idxEnd).join('\n');
  return { old, new: $new };
}

/** 上游 tag 形态：`<old>…</old>` + `<new>…</new>`（各自恰好一次，顺序不限）。 */
export function splitEditBodyByTags(body: string): EditBodySplit | null {
  const grab = (tag: 'old' | 'new'): string | null => {
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    const from = body.indexOf(open);
    if (from === -1) return null;
    const to = body.indexOf(close, from + open.length);
    if (to === -1) return null;
    if (body.indexOf(open, from + open.length) !== -1) return null;
    return body.slice(from + open.length, to);
  };
  const old = grab('old');
  const $new = grab('new');
  if (old === null || $new === null) return null;
  return { old, new: $new };
}
