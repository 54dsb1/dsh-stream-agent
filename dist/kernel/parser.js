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
 *   <tf-call name="web_search" id="c1" depends_on="w1">{"query":"..."}</tf-call>
 *   <tf-ask q="选择哪种方案？" id="a1" options="方案A,方案B"/>
 *   <tf-skill name="skill-name" id="s1"/>
 *   <tf-final id="f1" summary="任务完成说明"/>
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
 *
 * 事件类型：text / command / malformed / truncated / cycle / done。
 * 命令闭合立即 emit，不等流结束；"当前可执行集合"用 readyCommands() 查询
 * （命令闭合 + markDone() 后依赖全部满足的命令）。
 */

// ---------------------------------------------------------------------------
// 协议 schema（显式定义；解析失败产出 malformed，绝不静默丢弃）
// ---------------------------------------------------------------------------

                           
                                                                            
                                                              
                                      

                         
                              
                              
                   
 

/** id / depends_on / accepts 是所有命令的公共属性，不计入各命令 schema。
 *  accepts（F5）：逗号分隔的验收项 id 列表——命令成功（有回执）时对应验收项记为已验证。 */
const COMMON_ATTRS                    = ['id', 'depends_on', 'accepts'];

const COMMAND_SCHEMAS                                                 = {
  'tf-write': { required: ['path'], optional: [], hasBody: true },
  'tf-read': { required: ['path'], optional: ['offset', 'limit'], hasBody: false },
  // F1：精确替换（body 用 OLD/NEW 标记行分隔两段字面量）与追加（body = 追加正文；
  // anchor 给出插入锚点字面量，缺省 = 追加到文件末尾）。两者都映射宿主 edit/apply_patch，
  // 不自建文件 IO。
  'tf-edit': { required: ['path'], optional: ['replace_all'], hasBody: true },
  'tf-append': { required: ['path'], optional: ['anchor'], hasBody: true },
  // F2：搜索只回匹配行/路径（宿主 fs-search 的 grep/glob 映射），不回全文。
  'tf-grep': { required: ['pattern'], optional: ['path', 'include'], hasBody: false },
  'tf-glob': { required: ['pattern'], optional: ['path'], hasBody: false },
  'tf-bash': { required: ['cmd'], optional: [], hasBody: false },
  'tf-peek': { required: ['handle'], optional: ['from_line', 'to_line'], hasBody: false },
  'tf-final': { required: [], optional: ['summary'], hasBody: false },
  // F5：计划与验收——body 按行声明验收项（`- [id] 描述`）；计划状态在驱动器（宿主侧）持有，
  // 请求只注差分；tf-final 在存在未验证验收项时判定为过早。
  'tf-plan': { required: [], optional: [], hasBody: true },
  // 程序体 = PTC 的 async TS 函数体（可擦除语法）；description 只进台账，timeout 为毫秒数
  'tf-code': { required: [], optional: ['timeout', 'description'], hasBody: true },
  // v0.4.0 通用调用通道（G2：净增 1）：name = 本会话冻结工具面内的宿主工具名；
  // body = JSON 对象（参数原样透传给 ctx.tools.execute）。parser 只做 schema 校验，
  // 工具名/JSON 的语义校验在驱动器（unknown-tool / bad-json-arguments 结构化失败）。
  'tf-call': { required: ['name'], optional: [], hasBody: true },
  // v0.4.0 高频例外（§6.4，命令表 12→14）：阻塞式提问与技能装载值一条专用语法——
  // tf-ask 的回答要作为问句语义在流内可见（familyHint=ask）；tf-skill 是会话级状态变更。
  // 参数刻意极简（JSON 免转义）；复杂形状（多问题/选项描述）走 tf-call body。
  'tf-ask': { required: ['q'], optional: ['header', 'options'], hasBody: false },
  'tf-skill': { required: ['name'], optional: [], hasBody: false },
};

const COMMAND_NAMES                           =
  ['tf-write', 'tf-read', 'tf-edit', 'tf-append', 'tf-grep', 'tf-glob', 'tf-bash', 'tf-peek', 'tf-final', 'tf-code', 'tf-plan', 'tf-call', 'tf-ask', 'tf-skill'];

                            
                      
                                    
             
                                                           
                                          
                                                                                       
                
                             
                                
             
              
 

                         
                                  
                                           
                                                      
                                                      
                                               
                     

// ---------------------------------------------------------------------------
// 流式解析器
// ---------------------------------------------------------------------------

                                         
                                                                                    

export class TfStreamParser {
          buf = '';
          mode       = 'ground';
          ended = false;

  // body 中间态
          bodyName                       = null;
          bodyAttrs                                = null;
          bodyDeps                           = null;
          bodyRawOpen = '';
          bodyBuf = '';

                   commands = new Map                   ();
                   doneIds = new Set        ();
                   emittedCycleKeys = new Set        ();
          autoIdCounter = 0;
          seqCounter = 0;

  /** 增量喂入；命令跨 chunk 边界闭合，闭合即产出事件。 */
  feed(delta        )                {
    if (this.ended) {
      throw new Error('parser already ended; create a new TfStreamParser for the next stream');
    }
    this.buf += delta;
    const events                = [];
    // 一种模式内的推进可能连锁（header 闭合 → body 打开 → 同一 buf 里 body 闭合）
    for (;;) {
      if (!this.step(events)) break;
    }
    return events;
  }

  /** 流终止：冲刷剩余文本；未闭合产出 truncated；最后必发 done。 */
  end()                {
    if (this.ended) return [];
    this.ended = true;
    const events                = [];
    if (this.mode === 'header') {
      if (isDsmlTag(this.buf)) {
        // DSML 尾巴（feed 期间已进 header 模式但流终止）：malformed 上报，不进 prose
        events.push({ type: 'malformed', raw: this.buf, reason: 'dsml-wrapper' });
        this.buf = '';
      } else {
        events.push({ type: 'truncated', raw: this.buf, reason: 'unclosed-command-tag' });
      }
    } else if (this.mode === 'body') {
      events.push({
        type: 'truncated',
        raw: this.bodyRawOpen + this.bodyBuf + this.buf,
        reason: `unclosed-command-body:${this.bodyName}`,
      });
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
  markDone(id        )       {
    this.doneIds.add(id);
  }

  /**
   * 当前可执行集合：已闭合、未完成、且 depends_on 全部完成的命令（按闭合序）。
   * 依赖指向未出现过的 id → 永不就绪（模型声明了不存在的依赖，交 loop 层处理）。
   */
  readyCommands()              {
    const out              = [];
    for (const cmd of this.commands.values()) {
      if (this.doneIds.has(cmd.id)) continue;
      if (cmd.depends_on.every((d) => this.doneIds.has(d))) out.push(cmd);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  // -------------------------------------------------------------------------

  /** 状态机推进一步；有进展返回 true（events 可能追加 0..n 条）。 */
          step(events               )          {
    if (this.mode === 'ground') return this.stepGround(events);
    if (this.mode === 'header') return this.stepHeader(events);
    return this.stepBody(events);
  }

          stepGround(events               )          {
    const lt = this.buf.indexOf('<');
    if (lt === -1) {
      if (this.buf !== '') events.push({ type: 'text', text: this.buf });
      this.buf = '';
      return false;
    }
    const probe = probeTag(this.buf.slice(lt));
    if (probe === 'need-more') return false;
    if (probe === 'close-tag') {
      // v0.3.1：孤立闭合标签——前面没有配对打开（自闭合命令被多关一次、或模型手写了
      // 残片）。按协议违规记账后丢弃，绝不作为 prose 落进正文。
      const gt = this.buf.indexOf('>', lt);
      const raw = gt === -1 ? this.buf.slice(lt) : this.buf.slice(lt, gt + 1);
      if (lt > 0) events.push({ type: 'text', text: this.buf.slice(0, lt) });
      this.buf = gt === -1 ? '' : this.buf.slice(gt + 1);
      events.push({ type: 'malformed', raw, reason: `stray-close-tag:${closeTagName(raw)}` });
      return true;
    }
    if (probe === 'prose') {
      // '<' 是普通文本的一部分：原样透传，从 '<' 之后继续扫
      events.push({ type: 'text', text: this.buf.slice(0, lt + 1) });
      this.buf = this.buf.slice(lt + 1);
      return true;
    }
    // tag / tf-unknown / dsml：都进入 header 模式（后两者闭合时判 malformed 或改写）
    if (lt > 0) events.push({ type: 'text', text: this.buf.slice(0, lt) });
    this.buf = this.buf.slice(lt);
    this.mode = 'header';
    return true;
  }

          stepHeader(events               )          {
    const close = scanHeaderClose(this.buf);
    if (!close) return false; // 等更多数据
    const raw = this.buf.slice(0, close.end + 1);
    this.buf = this.buf.slice(close.end + 1);
    this.mode = 'ground';

    // DSML 噪声（v0.3.1）：先于普通解析处理——`invoke name="tf-xxx" ...` 形态改写回
    // 等价 tf-* 头部（命令不丢）；其余包装行按 malformed 上报后丢弃（不进 prose）。
    if (isDsmlTag(raw)) {
      const dsml = parseDsmlHeader(raw, close.selfClosing);
      if (dsml === null) {
        events.push({ type: 'malformed', raw, reason: 'dsml-wrapper' });
        return true;
      }
      const parsed = parseHeader(dsml.synthetic);
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

          stepBody(events               )          {
    const name = this.bodyName ;
    // v0.4.1：闭合标签允许尾随空白与属性（`</tf-write >` / `</tf-write path="x">`）。
    // 旧实现只认逐字 `</tf-write>`：模型写成带空白/属性的形式时永远找不到闭合，整段
    // 正文缓冲到流末按 truncated 丢弃——用户侧就是"写到一半没了"。
    const close = findBodyClose(name, this.buf);
    if (close === null) {
      // 闭合标签可能被拆在 chunk 边界上：扣留末尾至多（闭合标签长度-1）与 64 的较大者，
      // 保证带属性的闭合标签不会因跨 chunk 被切半。
      const keep = Math.min(Math.max(`</${name}>`.length - 1, 64), this.buf.length);
      this.bodyBuf += this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      return false;
    }
    const closeTag = this.buf.slice(close.index, close.end);
    const body = this.bodyBuf + this.buf.slice(0, close.index);
    const raw = this.bodyRawOpen + body + closeTag;
    this.buf = this.buf.slice(close.end);
    this.mode = 'ground';
    const attrs = this.bodyAttrs ;
    const deps = this.bodyDeps ;
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

          emitCommand(
    events               ,
    name               ,
    attrs                        ,
    deps                   ,
    body                    ,
    raw        ,
  )       {
    const seq = ++this.seqCounter;
    const id = attrs['id'] ?? `cmd${++this.autoIdCounter}`;
    // 重复 id 不在 parser 层拦截（v0.2 起移交驱动器裁决）：同 id 同内容 = 幂等返回原回执，
    // 同 id 不同内容 = 拒绝换新 id，被拒命令可用原 id 修正重发（上游 ThinkFlow 分层语义：
    // "parser 仅在语义校验成功后登记 id"，id 幂等是 context/账本层职责）。
    const isDuplicate = this.commands.has(id);
    const { id: _ignored, ...rest } = attrs;
    const command            = { name, id, attrs: rest, body, depends_on: deps, seq };
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
          findCycle()                           {
    const state = new Map                   ();
    const path           = [];
    let found                  = null;
    const dfs = (id        )       => {
      if (found) return;
      const st = state.get(id) ?? 0;
      if (st === 1) {
        found = [...path.slice(path.indexOf(id)), id];
        return;
      }
      if (st === 2) return;
      state.set(id, 1);
      path.push(id);
      for (const d of this.commands.get(id) .depends_on) {
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
/**
 * v0.4.1：正文命令的闭合标签查找（允许空白与属性）。
 *
 * 旧实现只认逐字 `</tf-write>`：模型写成 `</tf-write >` 或 `</tf-write path="x">`
 * 时永远找不到闭合，整段正文缓冲到流末按 truncated 丢弃——用户侧就是"写到一半没了"。
 * 这里按标签名找起点，再用与 header 同一个引号感知扫描取端界：
 *   - 名字后必须是空白 / `>` / `/`（`</tf-writex>` 不算）；
 *   - 属性值里含 `>` 也不会截半；
 *   - 跨 chunk 未闭合返回 null（调用方扣留尾部继续等）。
 */
function findBodyClose(name        , buf        )                                        {
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

function scanHeaderClose(buf        )                                               {
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
  // v0.4.1：引号不成对（mangled DSML name 值，奇数个引号——真机 session-d6cd0759
  // seq 110：`name="tf-peek handle="obs:...`）时严格扫描永不闭合，header 模式等死，
  // 整条命令在流末按 malformed 丢弃。退化通道：取**第一个**满足"前驱是 `"`（属性
  // 收尾）或 `/"`（自闭合）"的 '>' 作为标签端界——不能取最后一个 '>'：mangled 开标签
  // 后面跟着命令正文（Python 代码含 '>'），取最后一个会把正文整段吞进标签再丢弃
  // （真机 seq 104：整个 selfcheck 脚本被吞）。残片形态（无端界）仍返回 null 等更多
  // 数据；正常标签引号成对，严格扫描先行命中，退化通道不触发。
  for (let i = 1; i < buf.length; i++) {
    if (buf[i] !== '>') continue;
    const prev = buf[i - 1];
    if (prev === '"' || (prev === '/' && buf[i - 2] === '"')) {
      return { end: i, selfClosing: prev === '/' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DSML 噪声归一化（v0.3.1）
// ---------------------------------------------------------------------------

/** DSML 前缀："<" 后跟全角竖线（U+FF5C）串 + "DSML" + 全角竖线串。观察到的真机形态：
 *  `<｜｜DSML｜｜ calls>`、`<｜｜DSML｜｜ invoke name="tf-plan" id="p1">`。 */
const DSML_TAG_RE = /^<\/?｜+DSML｜*/;

/** 判定一段头部原文是否是 DSML 噪声标签（probeTag 'dsml' 的闭合侧复核）。 */
function isDsmlTag(raw        )          {
  return DSML_TAG_RE.test(raw);
}

/** 从孤立闭合标签原文取命令名（`</tf-bash>` → `tf-bash`；半截标签 → `?`）。 */
function closeTagName(raw        )         {
  const m = /^<\/\s*(tf-[a-z0-9-]*)/.exec(raw);
  return m === null ? '?' : m[1] ;
}

/**
 * 尝试把 DSML 头部改写为等价 tf-* 头部。
 * 可改写形态：`<｜｜DSML｜｜ invoke name="tf-xxx" 其余属性/>`（或配对打开）——
 * 返回合成头部原文（`<tf-xxx 其余属性...>`）；包装行（calls 等）与无法解析的
 * 属性段返回 null（调用方按 malformed 上报丢弃，绝不作为 prose 透传）。
 */
function parseDsmlHeader(raw        , selfClosing         )                               {
  // 去掉 '<' 与结尾 '>'（或 '/>'），取 DSML 前缀之后的剩余段
  let inner = raw.slice(1);
  if (selfClosing && inner.endsWith('/>')) inner = inner.slice(0, -2);
  else if (inner.endsWith('>')) inner = inner.slice(0, -1);
  const restRaw = inner.replace(/^\/?｜+DSML｜*/, '');
  // v0.4.1：mangled name 值抢救——模型把全部属性塞进 name 值且忘了闭引号（真机
  // session-d6cd0759 seq 110：`name="tf-peek handle="obs:bash:b2@v1" from_line="1" .../>`，
  // 整条命令丢失）。name 值以合法 tf-* 命令名开头且带空格时，把 `name="tf-xxx ` 改写为
  // `name="tf-xxx" `——余段就是正常属性对（引号结构本就完好）。
  const mangled = /^(\s*invoke\s+)name\s*=\s*"(tf-[a-z]+)\s+/.exec(restRaw);
  const rest = mangled !== null && COMMAND_NAMES.includes(mangled[2]                 )
    ? restRaw.replace(mangled[0], `${mangled[1]}name="${mangled[2]}" `)
    : restRaw;
  const invoke = rest.match(/^\s*invoke\s+name="(tf-[a-z]+)"([\s\S]*)$/);
  if (invoke === null) return null;
  const [, name, attrsPart] = invoke                                       ;
  if (!COMMAND_NAMES.includes(name                 )) return null;
  // 属性段原样拼接：dsml 属性语法与 tf 协议一致（key="value"），交 parseHeader 统一校验
  return { synthetic: `<${name}${attrsPart}${selfClosing ? '/>' : '>'}` };
}

                  
                                                                                        
                                                                               
                      

/**
 * 解析头部原文（形如 `<tf-read path="a.ts" id="r1"/>`）。
 * 自闭合与否由调用方判定，这里只取名字与属性；schema 校验失败返回 error。
 */
function parseHeader(raw        )              {
  // 去掉 '<'、结尾的 '>' 或 '/>'
  let inner = raw.slice(1);
  if (inner.endsWith('/>')) inner = inner.slice(0, -2);
  else if (inner.endsWith('>')) inner = inner.slice(0, -1);

  const nameMatch = inner.match(/^tf-[a-z]+/);
  if (!nameMatch) return { error: 'bad-command-name' };
  const nameCandidate = nameMatch[0];
  const known = COMMAND_NAMES.find((n) => n === nameCandidate) ?? null;

  let rest = inner.slice(nameCandidate.length);
  const attrs                         = {};
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
  const dependsOn           = [];
  if (attrs['depends_on'] !== undefined) {
    const seen = new Set        ();
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
function probeTag(s        )           {
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
export async function parseStream(src                       )                         {
  const parser = new TfStreamParser();
  const events                = [];
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
export const TF_EDIT_MARKERS = { old: '<<<<<<< OLD', split: '=======', end: '>>>>>>> NEW' }         ;

                                
                                         
              
                                       
              
 

/**
 * 切分 tf-edit body：`<<<<<<< OLD` 与 `>>>>>>> NEW` 两行之间以 `=======` 行为界，
 * 前段 = old、后段 = new。标记行必须各出现一次且顺序正确；正文换行结构原样保留。
 * 解析失败返回 null（调用方必须回结构化失败，不得静默改成全文重写）。
 */
export function splitEditBody(body        )                       {
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
