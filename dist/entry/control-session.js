// entry/control-session.ts —— 交互栏的会话状态机（0.5.0：两区块）
//
// 把"按键 → 状态 → 画面"从终端 IO 里剥出来：runInteractive 只负责 raw mode 与写 stdout，
// 状态机本身可被 node --test 直接驱动（无需 pty），中英切换与落盘行为因此可被钉死。
//
// 一次 handle() 的返回值：
//   { quit: true }        调用方收尾退出
//   { changed: true }     画面需要重绘（状态变了）
//   { changed: false }    按键无副作用（未知键）
//
// 0.5.0 键位（§3.3 两区块）：1-2 选执行通道，3-5 选上下文档位；c/t 快切；
// ↑↓/jk 在扁平五选项间移动焦点，Enter 应用焦点。

import { DEFAULT_CHANNEL, DEFAULT_TIER, getChannel, getTier } from '../kernel/modes.js';
                                                            
import { createControlState, interpretKey, moveFocus, otherLang, renderHelp, renderPanel, t } from '../kernel/control-bar.js';
                                                                                
import { formatLimitsLine, mergeLimits, sanitizeLimitPatch } from '../kernel/limits.js';
                                                       
import { VERSION } from '../version.js';

                                     
                                      
                                    
                                     
                                
                   
 

export class ControlSession {
  state              ;
  focus                         ;
  helpOpen = false;
  note = '';
  /** 0.5.3：区块 C 的行内输入缓冲（null = 未在编辑）。非 null 时所有按键先进缓冲。 */
  limitsBuffer                = null;
           #deps                    ;

  constructor(initial              , deps                    ) {
    this.state = createControlState(initial);
    this.focus = { kind: 'channel', id: this.state.channel };
    this.#deps = deps;
  }

  get version()         {
    return this.#deps.version ?? VERSION;
  }

  /** 整屏文本（含清屏序列），直接 write 即可。 */
  frame()         {
    const columns = this.#deps.columns();
    const body = this.helpOpen
      ? renderHelp(this.state, { version: this.version, columns })
      : renderPanel(this.state, { version: this.version, columns, focus: this.focus });
    const footer           = [];
    if (this.limitsBuffer !== null) {
      const lang = this.state.lang;
      footer.push('', `  ${t('limitsEditing', lang)} > ${this.limitsBuffer}█`);
      footer.push(`  ${t('limitsEditingHint', lang)}`);
    }
    if (this.note !== '') footer.push('', `  ${this.note}`);
    return `\x1b[2J\x1b[H${[...body, ...footer].join('\n')}\n`;
  }

  /** 应用执行通道并落盘（区块 A）。 */
  applyChannel(channel           )       {
    this.state = { ...this.state, channel: getChannel(channel).id };
    this.focus = { kind: 'channel', id: this.state.channel };
    const lang = this.state.lang;
    try {
      const file = this.#deps.save(this.state);
      const spec = getChannel(channel);
      this.note = `${t('saved', lang)}: ${t('blockA', lang)} ${spec.label[lang]} (${spec.id}) | ${file}`;
    } catch (error) {
      this.note = `${t('writeFailed', lang)}: ${String(error)}`;
    }
  }

  /** 应用上下文档位并落盘（区块 B）。 */
  applyTier(tier        )       {
    this.state = { ...this.state, tier: getTier(tier).id };
    this.focus = { kind: 'tier', id: this.state.tier };
    const lang = this.state.lang;
    try {
      const file = this.#deps.save(this.state);
      const spec = getTier(tier);
      this.note = `${t('saved', lang)}: ${t('blockB', lang)} ${spec.label[lang]} (${spec.id}) | ${file}`;
    } catch (error) {
      this.note = `${t('writeFailed', lang)}: ${String(error)}`;
    }
  }

  /** 0.6.0：切换上下文折叠开关并落盘（区块 D）。 */
  toggleContextFold()       {
    const next = this.state.contextFold === false;
    this.state = { ...this.state, contextFold: next };
    this.#saveSwitch('fold', next);
  }

  /** 0.6.0：切换流末验收开关并落盘（区块 D）。 */
  toggleFinalCheck()       {
    const next = this.state.finalCheck === false;
    this.state = { ...this.state, finalCheck: next };
    this.#saveSwitch('final', next);
  }

  /** 0.6.0 正式版：切换上下文"完全不处理"（区块 D）。开启时折叠在生效面强制关。 */
  toggleContextRaw()       {
    const next = this.state.contextRaw !== true;
    this.state = { ...this.state, contextRaw: next };
    this.#saveSwitch('raw', next);
  }

  #saveSwitch(label                          , on         )       {
    const lang = this.state.lang;
    try {
      const file = this.#deps.save(this.state);
      this.note = `${t('saved', lang)}: ${label}=${on ? t('switchOn', lang) : t('switchOff', lang)} | ${file}`;
    } catch (error) {
      this.note = `${t('writeFailed', lang)}: ${String(error)}`;
    }
  }

  /** 切语言并落盘：中英两个方向都必须即时反映到画面与盘上。 */
  toggleLang()       {
    this.state = { ...this.state, lang: otherLang(this.state.lang)         };
    try {
      this.#deps.save(this.state);
      this.note = t(this.state.lang === 'zh' ? 'noteLangZh' : 'noteLangEn', this.state.lang);
    } catch (error) {
      this.note = `${t('writeFailed', this.state.lang)}: ${String(error)}`;
    }
  }

  /** 重置：通道/档位回默认，语言保持不变（语言是阅读偏好，不该被"重置"带走）。
   *  0.5.3：用户上限也一起清空——"重置"的语义是回到插件初始状态，而初始状态就是"一项上限都没有"。 */
  reset()       {
    // 开关不是"上限"，重置保留（用户关掉折叠/验收是有意的行为选择，不该被 r 键抹掉）。
    // 预设标记清除：limits 已清空，不再等于任何预设的数值面。
    this.state = {
      channel: DEFAULT_CHANNEL,
      tier: DEFAULT_TIER,
      lang: this.state.lang,
      ...(this.state.contextFold === undefined ? {} : { contextFold: this.state.contextFold }),
      ...(this.state.finalCheck === undefined ? {} : { finalCheck: this.state.finalCheck }),
      ...(this.state.contextRaw === undefined ? {} : { contextRaw: this.state.contextRaw }),
    };
    this.focus = { kind: 'channel', id: this.state.channel };
    try {
      const file = this.#deps.save(this.state);
      this.note = `${t('saved', this.state.lang)}: ${file}`;
    } catch (error) {
      this.note = `${t('writeFailed', this.state.lang)}: ${String(error)}`;
    }
  }

  /** 应用一行上限输入（`k=v;k=v` / `reset`）：校验 → 合并 → 落盘。 */
  applyLimits(input        )       {
    const lang = this.state.lang;
    const text = input.trim();
    if (text === '') {
      this.note = t('limitsCancelled', lang);
      return;
    }
    if (text === 'reset' || text === 'clear') {
      this.state = {
        channel: this.state.channel,
        tier: this.state.tier,
        lang,
        ...(this.state.contextFold === undefined ? {} : { contextFold: this.state.contextFold }),
        ...(this.state.finalCheck === undefined ? {} : { finalCheck: this.state.finalCheck }),
        ...(this.state.contextRaw === undefined ? {} : { contextRaw: this.state.contextRaw }),
      };
      try {
        const file = this.#deps.save(this.state);
        this.note = `${t('limitsCleared', lang)} | ${file}`;
      } catch (error) {
        this.note = `${t('writeFailed', lang)}: ${String(error)}`;
      }
      return;
    }
    const parsed = sanitizeLimitPatch(text, 'control-bar');
    if (Object.keys(parsed.values).length === 0) {
      this.note = `${t('limitsRejected', lang)}: ${parsed.warnings.join('; ') || text}`;
      return;
    }
    const merged              = mergeLimits(this.state.limits, parsed.values);
    this.state = { ...this.state, limits: merged };
    try {
      const file = this.#deps.save(this.state);
      const warn = parsed.warnings.length > 0 ? ` (${parsed.warnings.join('; ')})` : '';
      this.note = `${t('limitsApplied', lang)}: ${formatLimitsLine(merged, lang)}${warn} | ${file} ${t('limitsNeedRuntime', lang)}`;
    } catch (error) {
      this.note = `${t('writeFailed', lang)}: ${String(error)}`;
    }
  }

  /** 行内编辑模式的按键处理：可打印字符进缓冲，回车提交，Esc 取消。 */
  #handleBuffer(key        )                                      {
    if (key === '\x1b') {
      this.limitsBuffer = null;
      this.note = t('limitsCancelled', this.state.lang);
      return { quit: false, changed: true };
    }
    if (key === '\r' || key === '\n') {
      const input = this.limitsBuffer;
      this.limitsBuffer = null;
      this.applyLimits(input);
      return { quit: false, changed: true };
    }
    if (key === '\x7f' || key === '\b') {
      this.limitsBuffer = this.limitsBuffer !== null ? this.limitsBuffer.slice(0, -1) : null;
      return { quit: false, changed: true };
    }
    if (key === '\x03') {
      this.limitsBuffer = null;
      return { quit: true, changed: false };
    }
    // 只收单字符可打印键（方向键等转义序列整体忽略）
    if ([...key].length === 1 && key >= ' ' && this.limitsBuffer !== null && this.limitsBuffer.length < 300) {
      this.limitsBuffer += key;
      return { quit: false, changed: true };
    }
    return { quit: false, changed: false };
  }

  handle(key        )                                      {
    if (this.limitsBuffer !== null) return this.#handleBuffer(key);
    const action = interpretKey(key, { helpOpen: this.helpOpen });
    switch (action.kind) {
      case 'quit':
        return { quit: true, changed: false };
      case 'toggle-help':
        this.helpOpen = !this.helpOpen;
        this.note = '';
        return { quit: false, changed: true };
      case 'close-help':
        this.helpOpen = false;
        this.note = '';
        return { quit: false, changed: true };
      case 'toggle-lang':
        this.toggleLang();
        return { quit: false, changed: true };
      case 'reset':
        this.reset();
        return { quit: false, changed: true };
      case 'edit-limits':
        this.limitsBuffer = '';
        this.helpOpen = false;
        this.note = '';
        return { quit: false, changed: true };
      case 'toggle-context-fold':
        this.toggleContextFold();
        return { quit: false, changed: true };
      case 'toggle-final-check':
        this.toggleFinalCheck();
        return { quit: false, changed: true };
      case 'toggle-context-raw':
        this.toggleContextRaw();
        return { quit: false, changed: true };
      case 'move':
        if (this.focus !== undefined) {
          this.focus = moveFocus(this.focus, action.delta);
        } else {
          this.focus = { kind: 'channel', id: this.state.channel };
        }
        this.note = '';
        return { quit: false, changed: true };
      case 'apply': {
        if (this.focus === undefined) return { quit: false, changed: false };
        if (this.focus.kind === 'channel') this.applyChannel(this.focus.id);
        else this.applyTier(this.focus.id);
        return { quit: false, changed: true };
      }
      case 'select-channel':
        this.applyChannel(action.channel);
        return { quit: false, changed: true };
      case 'select-tier':
        this.applyTier(action.tier);
        return { quit: false, changed: true };
      case 'cycle-channel':
        this.applyChannel(this.state.channel === 'standard' ? 'code' : 'standard');
        return { quit: false, changed: true };
      case 'cycle-tier': {
        const order = getTier(this.state.tier).order;
        const next = order >= 3 ? 1 : order + 1;
        const target = (['light', 'standard', 'deep']         )[next - 1] ;
        this.applyTier(target);
        return { quit: false, changed: true };
      }
      default:
        return { quit: false, changed: false };
    }
  }
}
