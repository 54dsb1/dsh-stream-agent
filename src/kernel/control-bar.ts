// kernel/control-bar.ts —— 控制栏的纯渲染 + 按键状态机（0.5.0：两区块）
//
// 三块职责，全部无副作用：
//   ① 文案表：中文/英文成对出现（TextKey 由表自身推导）；运行期缺 key 回退为 key 本身。
//      两个语言的输出必须结构性一致——同一份面板，只换文字。
//   ② 渲染：状态条（单行）、面板（两区块交互）、引导（首次装载）、帮助、JSON。
//   ③ 按键：把一次按键解释成意图（选通道 / 选档位 / 切语言 / 帮助 / 退出），由调用方落盘。
//
// 0.5.0 两区块设计（计划书 §3.3）：
//   区块 A「执行通道」：standard / code——用户选择的是模型看到什么（原生工具 / 单一入口），
//     "依赖 PTC"是探测结果不是选项（区块 A 不出现"PTC 模式"字样）。
//   区块 B「上下文档位」：light / standard / deep——只改数值，不改工具面、并行度、执行器。
//   两个区块都可回退：A→standard 即 0.4.0 balanced 行为面；B→standard 即 0.4.0 数值面。
//
// 宽度纪律（终端排版的坑，实测踩过）：
//   · CJK 记 2 列；结构分隔符一律用 ASCII（| > -> * ），因为 · → ① … 这些
//     "东亚宽度不确定字符"在 CJK 字体里是 2 列、在 Latin 字体里是 1 列，
//     同一份输出在两种终端会错位。盒子只用 ─│╭╮╰╯（公认 1 列）。
//   · 长文案按显示列宽换行，不截断——中文没有空格，逐字符折行。
//
// 与宿主无关：本文件不 import 任何宿主模块，node --test 直接可测。

import {
  CHANNEL_SPECS,
  TIER_SPECS,
  DEFAULT_CHANNEL,
  DEFAULT_TIER,
  getChannel,
  getTier,
  isChannelId,
  isTierId,
  publicChannelCatalog,
  publicTierCatalog,
  publicLegacyModeCatalog,
} from './modes.ts';
import type { ChannelId, ChannelSpec, TierId, TierSpec } from './modes.ts';

export type Lang = 'zh' | 'en';
export const LANGS: readonly Lang[] = ['zh', 'en'];
export const DEFAULT_LANG: Lang = 'zh';

export function isLang(value: unknown): value is Lang {
  return value === 'zh' || value === 'en';
}

/** 另一门语言（用于 l 键与"切换语言"提示）。 */
export function otherLang(lang: Lang): Lang {
  return lang === 'zh' ? 'en' : 'zh';
}

// ---------------------------------------------------------------------------
// ① 文案表
// ---------------------------------------------------------------------------

const TEXT = {
  barTitle: { zh: '控制栏', en: 'CONTROL BAR' },
  active: { zh: '接管生效', en: 'TAKEOVER ACTIVE' },
  inactive: { zh: '未接管', en: 'NOT TAKEN OVER' },
  activeHint: {
    zh: '单流协议已接管 agent 创建',
    en: 'single-stream protocol owns agent creation',
  },
  inactiveHint: {
    zh: '内建 agent-loop 仍在工作，检查 bundle 是否装载',
    en: 'built-in agent-loop still running; check whether the bundle is mounted',
  },
  blockA: { zh: '① 执行通道', en: '(1) Execution channel' },
  blockB: { zh: '② 上下文档位', en: '(2) Context tier' },
  channel: { zh: '通道', en: 'Channel' },
  tier: { zh: '档位', en: 'Tier' },
  current: { zh: '当前', en: 'Current' },
  focus: { zh: '焦点', en: 'Focus' },
  source: { zh: '来源', en: 'Source' },
  sourcePreset: { zh: 'preset 完整兼容', en: 'preset: full compatibility' },
  sourceBridge: { zh: '内置窄桥（受限）', en: 'built-in narrow bridge (limited)' },
  sourceNone: { zh: '不可用', en: 'unavailable' },
  sourceStandard: { zh: '不适用（标准通道）', en: 'n/a (standard channel)' },
  sourceUnavailableDetail: {
    zh: '代码通道不可用：未检测到 PTC 预设或 ptcRuntime',
    en: 'code channel unavailable: no PTC preset or ptcRuntime detected',
  },
  fits: { zh: '适合', en: 'Use when' },
  cost: { zh: '代价', en: 'Trade-off' },
  tierValues: { zh: '数值', en: 'Values' },
  tierAdvanced: { zh: '高级', en: 'Advanced' },
  advancedHint: {
    zh: '取回预算 / 前缀策略 / 重复抑制（peekBudgetChars / prefixPolicy / spanLedger）',
    en: 'peek budget / prefix policy / dup suppression (peekBudgetChars / prefixPolicy / spanLedger)',
  },
  keys: { zh: '按键', en: 'Keys' },
  commands: { zh: '命令', en: 'Commands' },
  docs: { zh: '文档', en: 'Docs' },
  status: { zh: '状态', en: 'Status' },
  openBar: { zh: '打开控制栏', en: 'Open control bar' },
  langLabel: { zh: '语言', en: 'Language' },
  helpTitle: {
    zh: '两区块指南（选错通道的代价比选错档位更高）',
    en: 'Two-block guide (picking the wrong channel costs more than the wrong tier)',
  },
  helpHint: {
    zh: '1-5 选通道/档位，c 切通道，t 切档位，l 切语言，q 返回',
    en: '1-5 pick channel/tier, c channel, t tier, l language, q back',
  },
  panelHint: {
    zh: '1-5 选通道/档位 | Up/Down 移动 | Enter 应用 | c 通道 | t 档位 | l 中/英 | ? 帮助 | r 重置 | q 退出',
    en: '1-5 pick | Up/Down move | Enter apply | c channel | t tier | l language | ? help | r reset | q quit',
  },
  bannerKeys: {
    zh: '交互栏支持 1-5 选通道/档位、c/t 快切、l 切语言、? 看指南',
    en: 'Interactive bar: 1-5 pick, c/t quick switch, l language, ? guide',
  },
  stepTitle: { zh: '上手四步', en: 'Four steps' },
  step1: {
    zh: '1 安装   dsh plugin --profile desktop add <包名或本地路径>',
    en: '1 Install   dsh plugin --profile desktop add <package or local path>',
  },
  step2: {
    zh: '2 选通道/档位 dsh-stream-agent channel standard（或 tier deep / 按 1-5）',
    en: '2 Pick   dsh-stream-agent channel standard (or tier deep / press 1-5)',
  },
  step3: {
    zh: '3 下任务 直接说需求，模型在一次流里跑完 tf-* 命令（或写 run_code 程序）',
    en: '3 Ask   describe the task; the model runs tf-* (or run_code) in one stream',
  },
  step4: {
    zh: '4 核对   dsh-stream-agent status',
    en: '4 Verify   dsh-stream-agent status',
  },
  executor: { zh: '执行器', en: 'executor' },
  surface: { zh: '工具面', en: 'surface' },
  passthrough: { zh: '透传', en: 'passthrough' },
  reservedOnly: { zh: '透传（tf-* 保留）', en: 'passthrough (tf-* reserved)' },
  tfCodeOnly: { zh: '仅 tf-code', en: 'tf-code only' },
  protocolOnly: { zh: '协议独占', en: 'protocol-only' },
  taskN: { zh: '本任务 N', en: 'task N' },
  rebase: { zh: '换基', en: 'rebase' },
  redundant: { zh: '重复取回', en: 'redundant peek' },
  summaries: { zh: '摘要', en: 'summaries' },
  seg: { zh: '段', en: 'blocks' },
  saved: { zh: '已保存', en: 'saved' },
  writeFailed: { zh: '状态写入失败（本次运行内仍生效）', en: 'state write failed (still active in this run)' },
  noteLangZh: { zh: '已切换到中文（按 l 切回英文）', en: 'Switched to Chinese (press l for English)' },
  noteLangEn: { zh: '已切换到英文（按 l 切回中文）', en: 'Switched to English (press l for Chinese)' },
  notTty: {
    zh: '当前不是交互终端，已输出一次性面板（--once 可强制）',
    en: 'Not an interactive terminal; printed the one-shot panel (--once forces it)',
  },
  unknownChannel: {
    zh: '未知通道，可选值：standard / code',
    en: 'Unknown channel; valid: standard / code',
  },
  unknownTier: {
    zh: '未知档位，可选值：light / standard / deep',
    en: 'Unknown tier; valid: light / standard / deep',
  },
  legacyAliased: {
    zh: '（旧模式值已按别名映射：0.5.x 保留别名，0.6.0 移除）',
    en: '(legacy mode value mapped via alias: kept in 0.5.x, removed in 0.6.0)',
  },
  unknownLang: { zh: '未知语言，可选值：zh / en', en: 'Unknown language; valid: zh / en' },
  usage: { zh: '用法', en: 'Usage' },
  stateFile: { zh: '状态文件', en: 'State file' },
} satisfies Record<string, { zh: string; en: string }>;

export type TextKey = keyof typeof TEXT;

/** 取一条文案；缺 key 时回退为 key 本身（绝不渲染出 undefined）。 */
export function t(key: TextKey, lang: Lang): string {
  const entry = TEXT[key] as { zh?: string; en?: string } | undefined;
  if (entry === undefined) return key;
  const value = entry[lang];
  return typeof value === 'string' && value !== '' ? value : entry.zh ?? entry.en ?? key;
}

export function textKeys(): TextKey[] {
  return Object.keys(TEXT) as TextKey[];
}

// ---------------------------------------------------------------------------
// ② 宽度 / 换行 / 盒子（与 0.4.0 逐字节一致的排版原语）
// ---------------------------------------------------------------------------

/** 东亚宽字符记 2 列（与主流终端一致）。 */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xffe6);
  return wide ? 2 : 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

/** 按显示列宽截断，超出以 ... 收尾（ASCII，避免歧义宽度）。 */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;
  const ellipsis = max >= 3 ? '...' : '';
  const room = max - ellipsis.length;
  let out = '';
  let width = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (width + w > room) break;
    out += ch;
    width += w;
  }
  return out + ellipsis;
}

export function padRight(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap <= 0 ? text : `${text}${' '.repeat(gap)}`;
}

/**
 * 断行单位：宽字符（CJK/全角）逐字可断；ASCII 连续非空白算一个整体，不切开单词。
 */
const CLOSING_PUNCT = new Set([...'。，、；：！？）〕］｝》」』〉】,.;:!?)]}']);

function breakUnits(text: string): string[] {
  const units: string[] = [];
  let word = '';
  for (const ch of text) {
    // 闭合标点必须先判：中文标点本身也是宽字符，放到下面会被当成独立单位。
    if (CLOSING_PUNCT.has(ch)) {
      if (word !== '') {
        // 英文标点本来就贴着单词，直接并进 word。
        word += ch;
        continue;
      }
      const last = units.length > 0 ? units[units.length - 1] : undefined;
      if (last !== undefined && last !== ' ') {
        units[units.length - 1] = last + ch;
        continue;
      }
      units.push(ch);
      continue;
    }
    if (ch === ' ' || charWidth(ch) > 1) {
      if (word !== '') {
        units.push(word);
        word = '';
      }
      units.push(ch);
      continue;
    }
    word += ch;
  }
  if (word !== '') units.push(word);
  return units;
}

/** 按显示列宽折行：中文逐字断，英文按词断，行尾不留空白，末行不留孤字。 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  if (displayWidth(text) <= width) return [text];
  const lines: string[][] = [];
  let current: string[] = [];
  let lineWidth = 0;
  const flush = (): void => {
    if (current.length > 0) lines.push(current);
    current = [];
    lineWidth = 0;
  };
  for (const unit of breakUnits(text)) {
    const w = displayWidth(unit);
    if (unit === ' ') {
      if (lineWidth === 0) continue; // 行首空格丢掉（上一条已 trimEnd）
      current.push(unit);
      lineWidth += w;
      continue;
    }
    if (lineWidth > 0 && lineWidth + w > width) flush();
    if (w > width) {
      // 单个单位比整行还宽（超长路径/无空格长串）：按列硬切，避免撑破盒子。
      let piece = '';
      let pieceWidth = 0;
      for (const ch of unit) {
        const cw = charWidth(ch);
        if (pieceWidth > 0 && pieceWidth + cw > width) {
          current.push(piece);
          flush();
          piece = '';
          pieceWidth = 0;
        }
        piece += ch;
        pieceWidth += cw;
      }
      if (piece !== '') {
        current.push(piece);
        lineWidth += pieceWidth;
      }
      continue;
    }
    current.push(unit);
    lineWidth += w;
  }
  flush();
  // 末行只剩一个单位时从上一行借一个下来。
  if (lines.length >= 2) {
    const last = lines[lines.length - 1];
    const prev = lines[lines.length - 2];
    const borrow = prev[prev.length - 1];
    if (last.length === 1 && prev.length > 2 && borrow !== undefined
      && displayWidth(borrow) + displayWidth(last[0]) <= width) {
      prev.pop();
      last.unshift(borrow);
    }
  }
  return lines
    .map((line) => line.join('').replace(/\s+$/, ''))
    .filter((line) => line !== '');
}

/** 终端列数 → 面板宽度（留 2 列边距；窄终端保底 56，宽终端最多 92）。 */
export function panelWidth(columns?: number): number {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return 78;
  return Math.max(56, Math.min(92, Math.floor(columns) - 2));
}

/** 画一个盒子：title 进顶边，lines 逐行补白（超宽才截断）。 */
export function box(title: string, lines: readonly string[], width: number): string[] {
  const inner = Math.max(8, width - 4);
  const titleText = truncate(` ${title} `, inner - 2);
  const headFill = Math.max(0, width - 3 - displayWidth(titleText));
  const out = [`╭─${titleText}${'─'.repeat(headFill)}╮`];
  for (const line of lines) {
    if (line === '') {
      out.push(`│ ${' '.repeat(inner)} │`);
      continue;
    }
    out.push(`│ ${padRight(truncate(line, inner), inner)} │`);
  }
  out.push(`╰${'─'.repeat(width - 2)}╯`);
  return out;
}

/** 渲染"标签 + 值"的行，超宽按词折行，续行与首行的值列左对齐。 */
function labeled(label: string, value: string, width: number, labelWidth?: number): string[] {
  const pad = labelWidth === undefined ? 0 : Math.max(0, labelWidth - displayWidth(label));
  const prefix = `${label}${' '.repeat(pad)}  `;
  const room = Math.max(12, width - displayWidth(prefix));
  const parts = wrapText(value, room);
  const indent = ' '.repeat(displayWidth(prefix));
  return parts.map((part, index) => (index === 0 ? `${prefix}${part}` : `${indent}${part}`));
}

// ---------------------------------------------------------------------------
// ③ 状态（0.5.0：channel + tier + lang 两轴三字段）
// ---------------------------------------------------------------------------

export interface ControlState {
  channel: ChannelId;
  tier: TierId;
  lang: Lang;
}

export function createControlState(partial: Partial<ControlState> = {}): ControlState {
  return {
    channel: isChannelId(partial.channel) ? partial.channel : DEFAULT_CHANNEL,
    tier: isTierId(partial.tier) ? partial.tier : DEFAULT_TIER,
    lang: isLang(partial.lang) ? partial.lang : DEFAULT_LANG,
  };
}

/**
 * 运行时状态（控制栏底部状态行的数据源；全部可选——缺省渲染 0 占位，不臆断）。
 * 数据由 loop 的 controlStatus 服务回填（ControlStatsFace）。
 */
export interface ControlStats {
  /** 执行器来源：native / ptc-preset / ptc-bridge / degraded-sidecar */
  executor?: string;
  /** 工具面：透传 / 仅 tf-code / 协议独占 */
  surface?: string;
  /** 代码通道来源判定（undefined = 标准通道，不判定） */
  codeSource?: 'preset' | 'bridge' | 'none';
  /** 本任务请求数（N） */
  requests?: number;
  /** 换基次数（本会话） */
  rebases?: number;
  /** 重复取回：命中已投递且未变化 / 取回总数 */
  redundantPeeks?: { hits: number; total: number };
  /** 摘要段数（压缩产生的摘要块数） */
  summaries?: number;
}

/** 档位数值行（控制栏区块 B）：只展示实际数值，不做定性宣传（§4.2）。 */
export function tierValuesLine(lang: Lang): string {
  const steps = TIER_SPECS.map((x) => x.values.maxSteps).join('/');
  const input = TIER_SPECS.map((x) => `${Math.round(x.values.maxInputTokens / 1000)}k`).join('/');
  const compaction = TIER_SPECS.map((x) => x.values.compactAggressiveness).join('/');
  return lang === 'zh'
    ? `maxSteps ${steps} · maxInputTokens ${input} · 压缩 ${compaction}`
    : `maxSteps ${steps} · maxInputTokens ${input} · compaction ${compaction}`;
}

/** 通道选择条：[1]*标准  [2] 代码（* = 已应用，> = 焦点） */
export function channelStrip(state: ControlState, focus?: ChannelId): string {
  return CHANNEL_SPECS.map((c) => {
    const mark = c.id === state.channel ? '*' : focus === c.id ? '>' : ' ';
    return `[${c.order}]${mark}${c.label[state.lang]}`;
  }).join(' ');
}

/** 档位选择条：[3] 轻 [4]*标准 [5] 深（序号与 1-5 直选键位一致） */
export function tierStrip(state: ControlState, focus?: TierId): string {
  return TIER_SPECS.map((x) => {
    const mark = x.id === state.tier ? '*' : focus === x.id ? '>' : ' ';
    return `[${x.order + 2}]${mark}${x.label[state.lang]}`;
  }).join(' ');
}

/** 代码通道来源说明行（探测结果由调用方注入；undefined = 标准通道不判定）。 */
export function codeSourceLine(source: ControlStats['codeSource'], lang: Lang): string {
  if (source === 'preset') return t('sourcePreset', lang);
  if (source === 'bridge') return t('sourceBridge', lang);
  if (source === 'none') return `${t('sourceNone', lang)}（${t('sourceUnavailableDetail', lang)}）`;
  return t('sourceStandard', lang);
}

/** 运行时状态行（面板底部）：缺省字段渲染 0 占位。 */
export function statsLine(stats: ControlStats | undefined, lang: Lang): string {
  const s = stats ?? {};
  const redundant = s.redundantPeeks === undefined
    ? '0/0'
    : `${s.redundantPeeks.hits}/${s.redundantPeeks.total}`;
  const parts = [
    `${t('taskN', lang)}=${s.requests ?? 0}`,
    `${t('rebase', lang)} ${s.rebases ?? 0}`,
    `${t('redundant', lang)} ${redundant}`,
    `${t('summaries', lang)} ${s.summaries ?? 0} ${t('seg', lang)}`,
  ];
  return `${t('status', lang)}：${parts.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// ④ 焦点（扁平五选项：两个通道 + 三个档位；1-5 直选）
// ---------------------------------------------------------------------------

export type FocusTarget =
  | { kind: 'channel'; id: ChannelId }
  | { kind: 'tier'; id: TierId };

export const FOCUSABLE: readonly FocusTarget[] = [
  ...CHANNEL_SPECS.map((c) => ({ kind: 'channel' as const, id: c.id })),
  ...TIER_SPECS.map((x) => ({ kind: 'tier' as const, id: x.id })),
];

function focusIndex(focus: FocusTarget | undefined): number {
  if (focus === undefined) return -1;
  return FOCUSABLE.findIndex((f) => f.kind === focus.kind && f.id === focus.id);
}

/** 渲染成可直接 write 的文本（CLI 与测试共用）。 */
export function renderToText(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// ⑤ 渲染
// ---------------------------------------------------------------------------

export interface RenderOptions {
  version: string;
  /** true = 接管生效；false = 未接管；undefined = 无从得知（CLI 独立进程：不臆断） */
  active?: boolean;
  /** 终端列数（process.stdout.columns）；缺省 80 列布局 */
  columns?: number;
  /** 交互栏的焦点选项（未应用） */
  focus?: FocusTarget;
  /** 运行时状态（控制栏底部状态行；CLI 独立进程不注入） */
  stats?: ControlStats;
}

/** 单行状态条：贴在任何输出上方都不喧哗。非 TTY（无 columns）不截断，交给调用方重定向。 */
export function renderStatusBar(state: ControlState, options: RenderOptions): string {
  const { lang } = state;
  const status = options.active === undefined
    ? undefined
    : options.active ? t('active', lang) : t('inactive', lang);
  const parts = [`dsh-stream-agent ${options.version}`];
  if (status !== undefined) parts.push(status);
  parts.push(`${t('channel', lang)} ${state.channel}`, `${t('tier', lang)} ${state.tier}`);
  const line = parts.join(' | ');
  const limit = options.columns === undefined ? Number.POSITIVE_INFINITY : panelWidth(options.columns);
  return truncate(line, limit);
}

/** 首次装载的引导面板（stderr，一次性）。 */
export function renderBanner(state: ControlState, options: RenderOptions): string[] {
  const { lang } = state;
  const width = panelWidth(options.columns);
  const channel = getChannel(state.channel);
  const tier = getTier(state.tier);
  const colon = lang === 'zh' ? '：' : ': ';
  const statusLine = options.active === undefined
    ? undefined
    : options.active
      ? `* ${t('active', lang)}${colon}${t('activeHint', lang)}`
      : `* ${t('inactive', lang)}${colon}${t('inactiveHint', lang)}`;
  const lines = [
    ...(statusLine === undefined ? [] : [statusLine]),
    `${t('blockA', lang)}: ${channelStrip(state)} | ${t('current', lang)} ${channel.id} (${channel.label[lang]})`,
    `${t('blockB', lang)}: ${tierStrip(state)} | ${t('current', lang)} ${tier.id} | ${tierValuesLine(lang)}`,
    ...labeled(t('fits', lang), `${channel.useWhen[lang]} / ${tier.useWhen[lang]}`, width - 4),
    '',
    t('stepTitle', lang),
    `  ${t('step1', lang)}`,
    `  ${t('step2', lang)}`,
    `  ${t('step3', lang)}`,
    `  ${t('step4', lang)}`,
    '',
    ...labeled(t('openBar', lang), 'dsh-stream-agent bar', width - 4),
    ...labeled(t('keys', lang), t('bannerKeys', lang), width - 4),
    `${t('docs', lang)}: README.md#control-bar`,
  ];
  return box(`dsh-stream-agent v${options.version} - ${t('barTitle', lang)}`, lines, width);
}

/** 交互面板：区块 A（执行通道）+ 区块 B（上下文档位）+ 键位 + 命令 + 运行状态。 */
export function renderPanel(state: ControlState, options: RenderOptions): string[] {
  const { lang } = state;
  const width = panelWidth(options.columns);
  const channel = getChannel(state.channel);
  const tier = getTier(state.tier);
  const focusChannel = options.focus?.kind === 'channel' ? getChannel(options.focus.id) : undefined;
  const focusTier = options.focus?.kind === 'tier' ? getTier(options.focus.id) : undefined;
  const statusLine = options.active === undefined
    ? []
    : [`${t('status', lang)}: ${options.active ? t('active', lang) : t('inactive', lang)}`];
  // 整块共用同一标签宽度。
  const labelWidth = Math.max(
    displayWidth(t('current', lang)),
    displayWidth(t('source', lang)),
    displayWidth(t('fits', lang)),
    displayWidth(t('cost', lang)),
    displayWidth(t('tierValues', lang)),
    displayWidth(t('tierAdvanced', lang)),
    displayWidth(t('commands', lang)),
    displayWidth(t('keys', lang)),
  );
  const lines = [
    ...statusLine,
    t('blockA', lang),
    `  ${channelStrip(state, options.focus?.kind === 'channel' ? options.focus.id : undefined)}`,
    ...labeled(t('current', lang), `${channel.label[lang]} (${channel.id}) — ${channel.tagline[lang]}`, width - 4, labelWidth),
    ...labeled(t('fits', lang), channel.useWhen[lang], width - 4, labelWidth),
    ...labeled(t('cost', lang), channel.tradeoff[lang], width - 4, labelWidth),
    ...labeled(t('source', lang), codeSourceLine(options.stats?.codeSource, lang), width - 4, labelWidth),
    ...(focusChannel !== undefined && focusChannel.id !== state.channel
      ? labeled(t('focus', lang), `> ${focusChannel.label[lang]} (${focusChannel.id}) — ${focusChannel.tagline[lang]}`, width - 4, labelWidth)
      : []),
    t('blockB', lang),
    `  ${tierStrip(state, options.focus?.kind === 'tier' ? options.focus.id : undefined)}`,
    ...labeled(t('current', lang), `${tier.label[lang]} (${tier.id}) — ${tier.useWhen[lang]}`, width - 4, labelWidth),
    ...labeled(t('tierValues', lang), tierValuesLine(lang), width - 4, labelWidth),
    ...labeled(t('cost', lang), tier.tradeoff[lang], width - 4, labelWidth),
    ...labeled(t('tierAdvanced', lang), t('advancedHint', lang), width - 4, labelWidth),
    '',
    ...labeled(t('commands', lang), 'dsh-stream-agent bar | status | channel <standard|code> | tier <light|standard|deep> | lang <zh|en>', width - 4, labelWidth),
    '',
    ...labeled(t('keys', lang), t('panelHint', lang), width - 4, labelWidth),
    statsLine(options.stats, lang),
    `${t('langLabel', lang)}: ${state.lang} | ${t('docs', lang)}: README.md#control-bar`,
  ];
  return box(`dsh-stream-agent v${options.version} - ${t('barTitle', lang)}`, lines, width);
}

/** 两区块指南：通道与档位逐一给出"适合 / 代价"，并标出当前选择。 */
export function renderHelp(state: ControlState, options: RenderOptions): string[] {
  const { lang } = state;
  const width = panelWidth(options.columns);
  const inner = width - 4;
  const lines: string[] = [t('helpTitle', lang), '', t('blockA', lang)];
  for (const c of CHANNEL_SPECS) {
    const mark = c.id === state.channel ? '*' : ' ';
    lines.push(`[${c.order}]${mark}${c.label[lang]} (${c.id})`);
    lines.push(...labeled(`  ${t('fits', lang)}`, c.useWhen[lang], inner));
    lines.push(...labeled(`  ${t('cost', lang)}`, c.tradeoff[lang], inner));
    lines.push(...labeled(`  0.4.0`, c.legacyBehavior[lang], inner));
  }
  lines.push('', t('blockB', lang));
  for (const x of TIER_SPECS) {
    const mark = x.id === state.tier ? '*' : ' ';
    lines.push(`[${x.order + 2}]${mark}${x.label[lang]} (${x.id}) | ${tierValuesLine(lang).replace(/ · /g, ` / `)}`);
    lines.push(...labeled(`  ${t('fits', lang)}`, x.useWhen[lang], inner));
    lines.push(...labeled(`  ${t('cost', lang)}`, x.tradeoff[lang], inner));
  }
  lines.push('', t('helpHint', lang));
  return box(`dsh-stream-agent v${options.version} - ${t('barTitle', lang)}`, lines, width);
}

/** 机器可读状态（--json / status --json）。 */
export function renderJson(state: ControlState, options: RenderOptions): string {
  return JSON.stringify({
    version: options.version,
    active: options.active !== false,
    channel: { id: state.channel, label: getChannel(state.channel).label[state.lang] },
    tier: { id: state.tier, label: getTier(state.tier).label[state.lang], values: getTier(state.tier).values },
    lang: state.lang,
    channels: publicChannelCatalog(),
    tiers: publicTierCatalog(),
    legacyModes: publicLegacyModeCatalog(),
  }, null, 2);
}

// ---------------------------------------------------------------------------
// ⑥ 按键 → 意图
// ---------------------------------------------------------------------------

export type KeyAction =
  | { kind: 'quit' }
  | { kind: 'toggle-help' }
  | { kind: 'close-help' }
  | { kind: 'toggle-lang' }
  | { kind: 'reset' }
  | { kind: 'move'; delta: 1 | -1 }
  | { kind: 'apply' }
  | { kind: 'select-channel'; channel: ChannelId }
  | { kind: 'select-tier'; tier: TierId }
  | { kind: 'cycle-channel' }
  | { kind: 'cycle-tier' }
  | { kind: 'none' };

/** 把一次按键（原始终端序列）解释为控制栏意图。q 在帮助页是"返回"，在面板是"退出"。 */
export function interpretKey(raw: string, context: { helpOpen?: boolean } = {}): KeyAction {
  const key = raw;
  if (key === 'q' || key === 'Q' || key === '\x03' /* Ctrl-C */ || key === '\x1b' /* Esc */) {
    return context.helpOpen === true ? { kind: 'close-help' } : { kind: 'quit' };
  }
  if (key === '?' || key === 'h' || key === 'H') return { kind: 'toggle-help' };
  if (key === 'l' || key === 'L') return { kind: 'toggle-lang' };
  if (key === 'r' || key === 'R') return { kind: 'reset' };
  // 1-5 直选（与面板标注一致）：1-2 通道，3-5 档位
  if (/^[1-5]$/.test(key)) {
    const target = FOCUSABLE[Number(key) - 1];
    if (target !== undefined) {
      return target.kind === 'channel'
        ? { kind: 'select-channel', channel: target.id }
        : { kind: 'select-tier', tier: target.id };
    }
  }
  // 快捷切换：c 通道（standard↔code），t 档位（light→standard→deep→light）
  if (key === 'c' || key === 'C') return { kind: 'cycle-channel' };
  if (key === 't' || key === 'T') return { kind: 'cycle-tier' };
  if (key === '\x1b[A' || key === 'k' || key === 'K') return { kind: 'move', delta: -1 };
  if (key === '\x1b[B' || key === 'j' || key === 'J') return { kind: 'move', delta: 1 };
  if (key === '\r' || key === '\n' || key === ' ') return { kind: 'apply' };
  return { kind: 'none' };
}

/** 焦点移动（↑↓）：在扁平五选项里环状移动。 */
export function moveFocus(focus: FocusTarget, delta: 1 | -1): FocusTarget {
  const index = focusIndex(focus);
  const base = index < 0 ? 0 : index;
  return FOCUSABLE[(base + delta + FOCUSABLE.length) % FOCUSABLE.length]!;
}

/** "应用焦点"的落点（Enter）：返回焦点选项（未聚焦 = 当前值）。 */
export function applyFocus(focus: FocusTarget | undefined, state: ControlState): ControlState {
  if (focus === undefined) return state;
  return focus.kind === 'channel' ? { ...state, channel: focus.id } : { ...state, tier: focus.id };
}
