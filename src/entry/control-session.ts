// entry/control-session.ts —— 交互栏的会话状态机（v0.2.1）
//
// 把"按键 → 状态 → 画面"从终端 IO 里剥出来：runInteractive 只负责 raw mode 与写 stdout，
// 状态机本身可被 node --test 直接驱动（无需 pty），中英切换与落盘行为因此可被钉死。
//
// 一次 handle() 的返回值：
//   { quit: true }        调用方收尾退出
//   { changed: true }     画面需要重绘（状态变了）
//   { changed: false }    按键无副作用（未知键）

import { DEFAULT_MODE, getMode } from '../kernel/modes.ts';
import type { ModeId } from '../kernel/modes.ts';
import { createControlState, interpretKey, moveFocus, otherLang, renderHelp, renderPanel, t } from '../kernel/control-bar.ts';
import type { ControlState, Lang } from '../kernel/control-bar.ts';
import { VERSION } from '../version.ts';

export interface ControlSessionDeps {
  /** 落盘当前状态；返回文件路径（失败抛错，由会话转成一行提示） */
  save(state: ControlState): string;
  /** 终端列数（undefined = 未知，按默认宽度排版） */
  columns(): number | undefined;
  version?: string;
}

export class ControlSession {
  state: ControlState;
  focus: ModeId;
  helpOpen = false;
  note = '';
  readonly #deps: ControlSessionDeps;

  constructor(initial: ControlState, deps: ControlSessionDeps) {
    this.state = createControlState(initial);
    this.focus = this.state.mode;
    this.#deps = deps;
  }

  get version(): string {
    return this.#deps.version ?? VERSION;
  }

  /** 整屏文本（含清屏序列），直接 write 即可。 */
  frame(): string {
    const columns = this.#deps.columns();
    const body = this.helpOpen
      ? renderHelp(this.state, { version: this.version, columns })
      : renderPanel(this.state, { version: this.version, columns, focus: this.focus });
    const footer = this.note === '' ? [] : ['', `  ${this.note}`];
    return `\x1b[2J\x1b[H${[...body, ...footer].join('\n')}\n`;
  }

  /** 应用一个模式并落盘（digit / Enter / r 共用）。 */
  applyMode(mode: ModeId): void {
    this.state = { ...this.state, mode: getMode(mode).id };
    this.focus = this.state.mode;
    const lang = this.state.lang;
    try {
      const file = this.#deps.save(this.state);
      const spec = getMode(mode);
      this.note = `${t('saved', lang)}: ${t('mode', lang)} ${spec.order} ${spec.label[lang]} | ${file}`;
    } catch (error) {
      this.note = `${t('writeFailed', lang)}: ${String(error)}`;
    }
  }

  /** 切语言并落盘：中英两个方向都必须即时反映到画面与盘上。 */
  toggleLang(): void {
    this.state = { ...this.state, lang: otherLang(this.state.lang) as Lang };
    try {
      this.#deps.save(this.state);
      this.note = t(this.state.lang === 'zh' ? 'noteLangZh' : 'noteLangEn', this.state.lang);
    } catch (error) {
      this.note = `${t('writeFailed', this.state.lang)}: ${String(error)}`;
    }
  }

  /** 重置：模式回默认，语言保持不变（语言是阅读偏好，不该被"重置模式"带走）。 */
  reset(): void {
    this.applyMode(DEFAULT_MODE);
  }

  handle(key: string): { quit: boolean; changed: boolean } {
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
      case 'move':
        this.focus = moveFocus(this.focus, action.delta);
        this.note = '';
        return { quit: false, changed: true };
      case 'apply':
        this.applyMode(this.focus);
        return { quit: false, changed: true };
      case 'select':
        this.applyMode(action.mode);
        return { quit: false, changed: true };
      default:
        return { quit: false, changed: false };
    }
  }
}
