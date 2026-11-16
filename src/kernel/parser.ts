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
 *   <tf-bash cmd="npm test" id="b1"/>
 *   <tf-peek handle="obs:read:c3@v1" from_line="10" to_line="20" id="p1"/>
 *   <tf-final id="f1" summary="任务完成说明"/>
 *
 * 规则：
 * - 只有 tf-write 有正文；其余命令自闭合（`/>`）或空元素配对（`></...>`）；
 *   非 body 命令带非空正文 → malformed；
 * - 属性值用双引号，值内可含 `>`（如 shell 重定向）——头部扫描引号感知；
 * - id 可省略（自动编号 cmd1、cmd2...）；depends_on 是逗号分隔的命令 id
 *   列表，可空；重复依赖去重保序；
 * - `<tf-` 开头但命令名未知的标签按 malformed 上报（协议尝试失败，不静默）；
 *   非 tf- 前缀的 '<' 一律视为模型 prose 原样透传，绝不丢弃
 *   （代价：恰好以 "<tf-xxx" 开头且全文无 '>' 的 prose 会被判为 truncated，
 *   但内容仍在 raw 里，不丢失）；
 * - 未闭合即流终止 → truncated 事件（loop 据此决定重入策略）；
 * - depends_on 环 → cycle 事件（路径首尾相同，如 [a, b, a]）。
 *
 * 事件类型：text / command / malformed / truncated / cycle / done。
 * 命令闭合立即 emit，不等流结束；"当前可执行集合"用 readyCommands() 查询
 * （命令闭合 + markDone() 后依赖全部满足的命令）。
 */

// ---------------------------------------------------------------------------
// 协议 schema（显式定义；解析失败产出 malformed，绝不静默丢弃）
// ---------------------------------------------------------------------------

export type TfCommandName = 'tf-write' | 'tf-read' | 'tf-bash' | 'tf-peek' | 'tf-final' | 'tf-code';

interface CommandSchema {
  required: readonly string[];
  optional: readonly string[];
  hasBody: boolean;
}

/** id / depends_on 是所有命令的公共属性，不计入各命令 schema */
const COMMON_ATTRS: readonly string[] = ['id', 'depends_on'];

const COMMAND_SCHEMAS: Readonly<Record<TfCommandName, CommandSchema>> = {
  'tf-write': { required: ['path'], optional: [], hasBody: true },
  'tf-read': { required: ['path'], optional: ['offset', 'limit'], hasBody: false },
  'tf-bash': { required: ['cmd'], optional: [], hasBody: false },
  'tf-peek': { required: ['handle'], optional: ['from_line', 'to_line'], hasBody: false },
  'tf-final': { required: [], optional: ['summary'], hasBody: false },
  // 程序体 = PTC 的 async TS 函数体（可擦除语法）；description 只进台账，timeout 为毫秒数
  'tf-code': { required: [], optional: ['timeout', 'description'], hasBody: true },
};

const COMMAND_NAMES: readonly TfCommandName[] =
  ['tf-write', 'tf-read', 'tf-bash', 'tf-peek', 'tf-final', 'tf-code'];

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

type Mode = 'ground' | 'header' | 'body';
type TagProbe = 'tag' | 'prose' | 'tf-unknown' | 'need-more';

export class TfStreamParser {
  private buf = '';
  private mode: Mode = 'ground';
  private ended = false;

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
    if (this.mode === 'header') {
      events.push({ type: 'truncated', raw: this.buf, reason: 'unclosed-command-tag' });
    } else if (this.mode === 'body') {
      events.push({
        type: 'truncated',
        raw: this.bodyRawOpen + this.bodyBuf + this.buf,
        reason: `unclosed-command-body:${this.bodyName}`,
      });
    } else {
      // ground：残留的 "<tf-" 片段（尚无法判定是否标签）→ truncated；
      // 其余（含普通 '<'）全部按 prose 透传
      const lt = this.buf.lastIndexOf('<');
      const tail = lt >= 0 ? this.buf.slice(lt) : '';
      if (tail.startsWith('<tf-') && probeTag(tail) === 'need-more') {
        if (lt > 0) events.push({ type: 'text', text: this.buf.slice(0, lt) });
        events.push({ type: 'truncated', raw: tail, reason: 'unclosed-command-tag' });
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
    return this.stepBody(events);
  }

  private stepGround(events: ParserEvent[]): boolean {
    const lt = this.buf.indexOf('<');
    if (lt === -1) {
      if (this.buf !== '') events.push({ type: 'text', text: this.buf });
      this.buf = '';
      return false;
    }
    const probe = probeTag(this.buf.slice(lt));
    if (probe === 'need-more') return false;
    if (probe === 'prose') {
      // '<' 是普通文本的一部分：原样透传，从 '<' 之后继续扫
      events.push({ type: 'text', text: this.buf.slice(0, lt + 1) });
      this.buf = this.buf.slice(lt + 1);
      return true;
    }
    // tag / tf-unknown：都进入 header 模式（后者闭合时判 malformed）
    if (lt > 0) events.push({ type: 'text', text: this.buf.slice(0, lt) });
    this.buf = this.buf.slice(lt);
    this.mode = 'header';
    return true;
  }

  private stepHeader(events: ParserEvent[]): boolean {
    const close = scanHeaderClose(this.buf);
    if (!close) return false; // 等更多数据
    const raw = this.buf.slice(0, close.end + 1);
    this.buf = this.buf.slice(close.end + 1);
    this.mode = 'ground';

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
    const closeTag = `</${name}>`;
    const closeIdx = this.buf.indexOf(closeTag);
    if (closeIdx === -1) {
      // 闭合标签可能被拆在 chunk 边界上：扣留末尾至多 closeTag.length-1 个字符
      const keep = Math.min(closeTag.length - 1, this.buf.length);
      this.bodyBuf += this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      return false;
    }
    const body = this.bodyBuf + this.buf.slice(0, closeIdx);
    const raw = this.bodyRawOpen + body + closeTag;
    this.buf = this.buf.slice(closeIdx + closeTag.length);
    this.mode = 'ground';
    const attrs = this.bodyAttrs!;
    const deps = this.bodyDeps!;
    this.bodyName = null;
    this.bodyAttrs = null;
    this.bodyDeps = null;
    this.bodyRawOpen = '';
    this.bodyBuf = '';

    if (!COMMAND_SCHEMAS[name].hasBody && body !== '') {
      events.push({ type: 'malformed', raw, reason: 'unexpected-body' });
      return true;
    }
    this.emitCommand(events, name, attrs, deps, COMMAND_SCHEMAS[name].hasBody ? body : undefined, raw);
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
  return null;
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
    const attr = rest.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*=\s*"([^"]*)"/);
    if (!attr) return { error: `bad-attribute-syntax:${rest.slice(0, 20)}` };
    const key = attr[1];
    if (key in attrs) return { error: `duplicate-attribute:${key}` };
    attrs[key] = attr[2];
    rest = rest.slice(attr[0].length);
  }

  // depends_on：逗号分隔，去空、去重、保序
  const dependsOn: string[] = [];
  if (attrs['depends_on'] !== undefined) {
    const seen = new Set<string>();
    for (const part of attrs['depends_on'].split(',')) {
      const d = part.trim();
      if (d === '') continue;
      if (!seen.has(d)) {
        seen.add(d);
        dependsOn.push(d);
      }
    }
  }

  if (known === null) return { name: null, attrs, dependsOn };

  const schema = COMMAND_SCHEMAS[known];
  const allowed = new Set([...COMMON_ATTRS, ...schema.required, ...schema.optional]);
  for (const key of Object.keys(attrs)) {
    if (!allowed.has(key)) return { error: `unknown-attribute:${key}` };
  }
  for (const req of schema.required) {
    if (attrs[req] === undefined) return { error: `missing-attribute:${req}` };
  }
  for (const key of ['from_line', 'to_line']) {
    if (attrs[key] !== undefined && !/^\d+$/.test(attrs[key])) {
      return { error: `bad-integer-attribute:${key}` };
    }
  }
  return { name: known, attrs, dependsOn };
}

/**
 * 判定 ground 模式下 '<' 起始的文本是否是协议标签的开始。
 * need-more：数据不足以判定，等待下一个 chunk。
 */
function probeTag(s: string): TagProbe {
  if (!s.startsWith('<')) return 'prose';
  if (s.length === 1) return 'need-more';
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
