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

import { DEFAULT_CHANNEL, DEFAULT_TIER, getChannel, getTier } from '../kernel/modes.ts';
import type { ChannelId, TierId } from '../kernel/modes.ts';
import { createControlState, interpretKey, moveFocus, otherLang, renderHelp, renderPanel, t } from '../kernel/control-bar.ts';
import type { ControlState, FocusTarget, Lang } from '../kernel/control-bar.ts';
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
  focus: FocusTarget | undefined;
  helpOpen = false;
  note = '';
  readonly #deps: ControlSessionDeps;

  constructor(initial: ControlState, deps: ControlSessionDeps) {
    this.state = createControlState(initial);
    this.focus = { kind: 'channel', id: this.state.channel };
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

  /** 应用执行通道并落盘（区块 A）。 */
  applyChannel(channel: ChannelId): void {
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
  applyTier(tier: TierId): void {
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

  /** 重置：通道/档位回默认，语言保持不变（语言是阅读偏好，不该被"重置"带走）。 */
  reset(): void {
    this.state = { ...this.state, channel: DEFAULT_CHANNEL, tier: DEFAULT_TIER };
    this.focus = { kind: 'channel', id: this.state.channel };
    try {
      const file = this.#deps.save(this.state);
      this.note = `${t('saved', this.state.lang)}: ${file}`;
    } catch (error) {
      this.note = `${t('writeFailed', this.state.lang)}: ${String(error)}`;
    }
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
        const target = (['light', 'standard', 'deep'] as const)[next - 1]!;
        this.applyTier(target);
        return { quit: false, changed: true };
      }
      default:
        return { quit: false, changed: false };
    }
  }
}
