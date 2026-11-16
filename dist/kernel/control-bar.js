// kernel/control-bar.ts —— 控制栏的纯渲染 + 按键状态机（v0.2.1）
//
// 三块职责，全部无副作用：
//   ① 文案表：中文/英文成对出现（TextKey 由表自身推导）；运行期缺 key 回退为 key 本身。
//      两个语言的输出必须结构性一致——同一份面板，只换文字。
//   ② 渲染：状态条（单行）、面板（交互）、引导（首次装载）、帮助（全模式指南）、JSON。
//   ③ 按键：把一次按键解释成意图（选模式 / 切语言 / 帮助 / 退出），由调用方落盘。
//
// 宽度纪律（终端排版的坑，实测踩过）：
//   · CJK 记 2 列；结构分隔符一律用 ASCII（| > -> * ），因为 · → ① … 这些
//     "东亚宽度不确定字符"在 CJK 字体里是 2 列、在 Latin 字体里是 1 列，
//     同一份输出在两种终端会错位。盒子只用 ─│╭╮╰╯（公认 1 列）。
//   · 长文案按显示列宽换行，不截断——中文没有空格，逐字符折行。
//
// 与宿主无关：本文件不 import 任何东西，node --test 直接可测。

import { DEFAULT_MODE, MODES, getMode, isModeId, modeByOrder } from './modes.js';
                                                   

                               
export const LANGS                  = ['zh', 'en'];
export const DEFAULT_LANG       = 'zh';

export function isLang(value         )                {
  return value === 'zh' || value === 'en';
}

/** 另一门语言（用于 l 键与"切换语言"提示）。 */
export function otherLang(lang      )       {
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
  mode: { zh: '模式', en: 'Mode' },
  current: { zh: '当前', en: 'Current' },
  fits: { zh: '适合', en: 'Use when' },
  cost: { zh: '代价', en: 'Trade-off' },
  steps: { zh: '上手', en: 'Start' },
  keys: { zh: '按键', en: 'Keys' },
  commands: { zh: '命令', en: 'Commands' },
  docs: { zh: '文档', en: 'Docs' },
  status: { zh: '状态', en: 'Status' },
  openBar: { zh: '打开控制栏', en: 'Open control bar' },
  langLabel: { zh: '语言', en: 'Language' },
  helpTitle: {
    zh: '全模式指南（选错模式的代价比选错命令更高）',
    en: 'Mode guide (picking the wrong mode costs more than the wrong command)',
  },
  helpHint: {
    zh: '1-4 切模式，l 切语言，q 返回',
    en: '1-4 pick mode, l language, q back',
  },
  panelHint: {
    zh: '1-4 切模式 | Up/Down 移动 | Enter 应用 | l 中/英 | ? 帮助 | r 重置 | q 退出',
    en: '1-4 mode | Up/Down move | Enter apply | l language | ? help | r reset | q quit',
  },
  bannerKeys: {
    zh: '交互栏支持 1-4 切模式、l 切语言、? 看全模式指南',
    en: 'Interactive bar: 1-4 mode, l language, ? full guide',
  },
  stepTitle: { zh: '上手四步', en: 'Four steps' },
  step1: {
    zh: '1 安装   dsh plugin --profile desktop add <包名或本地路径>',
    en: '1 Install   dsh plugin --profile desktop add <package or local path>',
  },
  step2: {
    zh: '2 选模式 dsh-stream-agent mode lean（或在控制栏按 1-4）',
    en: '2 Pick mode  dsh-stream-agent mode lean (or press 1-4 in the bar)',
  },
  step3: {
    zh: '3 下任务 直接说需求，模型在一次流里跑完 tf-* 命令',
    en: '3 Ask   describe the task; the model runs tf-* in one stream',
  },
  step4: {
    zh: '4 核对   dsh-stream-agent status',
    en: '4 Verify   dsh-stream-agent status',
  },
  receipt: { zh: '回执', en: 'receipt' },
  full: { zh: '全文', en: 'full' },
  codeAuto: { zh: 'code 跟随宿主', en: 'code auto' },
  codeOn: { zh: 'code 开', en: 'code on' },
  codeOff: { zh: 'code 关', en: 'code off' },
  parallel: { zh: '并行', en: 'parallel' },
  budget: { zh: '预算', en: 'budget' },
  saved: { zh: '已保存', en: 'saved' },
  writeFailed: { zh: '状态写入失败（本次运行内仍生效）', en: 'state write failed (still active in this run)' },
  noteLangZh: { zh: '已切换到中文（按 l 切回英文）', en: 'Switched to Chinese (press l for English)' },
  noteLangEn: { zh: '已切换到英文（按 l 切回中文）', en: 'Switched to English (press l for Chinese)' },
  notTty: {
    zh: '当前不是交互终端，已输出一次性面板（--once 可强制）',
    en: 'Not an interactive terminal; printed the one-shot panel (--once forces it)',
  },
  unknownMode: {
    zh: '未知模式，可选值：balanced / lean / compat / power',
    en: 'Unknown mode; valid: balanced / lean / compat / power',
  },
  unknownLang: { zh: '未知语言，可选值：zh / en', en: 'Unknown language; valid: zh / en' },
  usage: { zh: '用法', en: 'Usage' },
  stateFile: { zh: '状态文件', en: 'State file' },
}                                                     ;

                                        

/** 取一条文案；缺 key 时回退为 key 本身（绝不渲染出 undefined）。 */
export function t(key         , lang      )         {
  const entry = TEXT[key]                                            ;
  if (entry === undefined) return key;
  const value = entry[lang];
  return typeof value === 'string' && value !== '' ? value : entry.zh ?? entry.en ?? key;
}

export function textKeys()            {
  return Object.keys(TEXT)             ;
}

// ---------------------------------------------------------------------------
// ② 宽度 / 换行 / 盒子
// ---------------------------------------------------------------------------

/** 东亚宽字符记 2 列（与主流终端一致）。 */
export function charWidth(ch        )         {
  const code = ch.codePointAt(0) ?? 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6);
  return wide ? 2 : 1;
}

export function displayWidth(text        )         {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

/** 按显示列宽截断，超出以 ... 收尾（ASCII，避免歧义宽度）。 */
export function truncate(text        , max        )         {
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

export function padRight(text        , width        )         {
  const gap = width - displayWidth(text);
  return gap <= 0 ? text : `${text}${' '.repeat(gap)}`;
}

/** 按显示列宽折行：优先在空格处断（英文），中文逐字符断。 */
export function wrapText(text        , width        )           {
  if (width <= 0) return [text];
  if (displayWidth(text) <= width) return [text];
  const lines           = [];
  let line = '';
  let lineWidth = 0;
  let lastSpace = -1;
  for (const ch of text) {
    const w = charWidth(ch);
    if (lineWidth + w > width) {
      if (lastSpace > 0) {
        lines.push(line.slice(0, lastSpace));
        line = line.slice(lastSpace + 1);
        lineWidth = displayWidth(line);
      } else {
        lines.push(line);
        line = '';
        lineWidth = 0;
      }
      lastSpace = -1;
    }
    line += ch;
    lineWidth += w;
    if (ch === ' ') lastSpace = line.length - 1;
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** 终端列数 → 面板宽度（留 2 列边距；窄终端保底 56，宽终端最多 92）。 */
export function panelWidth(columns         )         {
  if (columns === undefined || !Number.isFinite(columns) || columns <= 0) return 78;
  return Math.max(56, Math.min(92, Math.floor(columns) - 2));
}

/** 画一个盒子：title 进顶边，lines 逐行补白（超宽才截断）。 */
export function box(title        , lines                   , width        )           {
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

/** 标签块：label + 折行正文（首行带标签，续行对齐缩进）。 */
function labeled(label        , value        , width        )           {
  const prefix = `${label}  `;
  const room = Math.max(12, width - displayWidth(prefix));
  const parts = wrapText(value, room);
  const indent = ' '.repeat(displayWidth(prefix));
  return parts.map((part, index) => (index === 0 ? `${prefix}${part}` : `${indent}${part}`));
}

// ---------------------------------------------------------------------------
// ③ 状态
// ---------------------------------------------------------------------------

                               
               
             
 

export function createControlState(partial                        = {})               {
  return {
    mode: isModeId(partial.mode) ? partial.mode : DEFAULT_MODE,
    lang: isLang(partial.lang) ? partial.lang : DEFAULT_LANG,
  };
}

/** 模式的关键参数一句话（面板与状态条共用，中英一致）。 */
export function modeSummary(mode          , lang      )         {
  const feedback = mode.config.selfReadFeedback === 'receipt' ? t('receipt', lang) : t('full', lang);
  const code = mode.config.enableCode === 'auto'
    ? t('codeAuto', lang)
    : mode.config.enableCode === true ? t('codeOn', lang) : t('codeOff', lang);
  const parts = [feedback, code, `${t('parallel', lang)} ${mode.config.maxParallelToolCalls}`];
  if (mode.config.budgetTokens !== undefined) {
    parts.push(`${t('budget', lang)} ${Math.round(mode.config.budgetTokens / 1000)}k`);
  }
  return parts.join(' | ');
}

/** 模式选择条：[1]*均衡  [2] 精简  [3] 兼容  [4] 增强（* = 已应用，> = 焦点） */
export function modeStrip(state              , focus         )         {
  return MODES.map((m) => {
    const mark = m.id === state.mode ? '*' : focus === m.id ? '>' : ' ';
    return `[${m.order}]${mark}${m.label[state.lang]}`;
  }).join(' ');
}

// ---------------------------------------------------------------------------
// ④ 渲染
// ---------------------------------------------------------------------------

                                
                  
                                                               
                   
                                               
                   
                      
                 
 

/** 单行状态条：贴在任何输出上方都不喧哗。非 TTY（无 columns）不截断，交给调用方重定向。 */
export function renderStatusBar(state              , options               )         {
  const { lang } = state;
  const mode = getMode(state.mode);
  const status = options.active === undefined
    ? undefined
    : options.active ? t('active', lang) : t('inactive', lang);
  const parts = [`dsh-stream-agent ${options.version}`];
  if (status !== undefined) parts.push(status);
  parts.push(`${t('mode', lang)} ${mode.order} ${mode.label[lang]}`, modeSummary(mode, lang));
  const line = parts.join(' | ');
  const limit = options.columns === undefined ? Number.POSITIVE_INFINITY : panelWidth(options.columns);
  return truncate(line, limit);
}

/** 首次装载的引导面板（stderr，一次性）。 */
export function renderBanner(state              , options               )           {
  const { lang } = state;
  const width = panelWidth(options.columns);
  const mode = getMode(state.mode);
  const colon = lang === 'zh' ? '：' : ': ';
  const statusLine = options.active === undefined
    ? undefined
    : options.active
      ? `* ${t('active', lang)}${colon}${t('activeHint', lang)}`
      : `* ${t('inactive', lang)}${colon}${t('inactiveHint', lang)}`;
  const lines = [
    ...(statusLine === undefined ? [] : [statusLine]),
    `${t('mode', lang)}: ${mode.order} ${mode.label[lang]} (${mode.id}) | ${modeSummary(mode, lang)}`,
    ...labeled(t('fits', lang), mode.useWhen[lang], width - 4),
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

/** 交互面板：模式条 + 当前模式详情 + 键位 + 命令。 */
export function renderPanel(state              , options               )           {
  const { lang } = state;
  const width = panelWidth(options.columns);
  const mode = getMode(state.mode);
  const focus = options.focus === undefined ? mode : getMode(options.focus);
  const statusLine = options.active === undefined
    ? []
    : [`${t('status', lang)}: ${options.active ? t('active', lang) : t('inactive', lang)}`];
  const lines = [
    ...statusLine,
    `${t('mode', lang)}: ${modeStrip(state, options.focus)}`,
    ...labeled(t('current', lang), `${focus.order} ${focus.label[lang]} (${focus.id}) | ${modeSummary(focus, lang)}`, width - 4),
    ...labeled(t('fits', lang), focus.useWhen[lang], width - 4),
    ...labeled(t('cost', lang), focus.tradeoff[lang], width - 4),
    '',
    ...labeled(t('commands', lang), 'dsh-stream-agent bar | status | mode <id> | lang <zh|en>', width - 4),
    '',
    ...labeled(t('keys', lang), t('panelHint', lang), width - 4),
    `${t('langLabel', lang)}: ${state.lang} | ${t('docs', lang)}: README.md#control-bar`,
  ];
  return box(`dsh-stream-agent v${options.version} - ${t('barTitle', lang)}`, lines, width);
}

/** 全模式指南：四个模式逐一给出"适合 / 代价"，并标出当前模式。 */
export function renderHelp(state              , options               )           {
  const { lang } = state;
  const width = panelWidth(options.columns);
  const inner = width - 4;
  const lines           = [t('helpTitle', lang), ''];
  for (const mode of MODES) {
    const mark = mode.id === state.mode ? '*' : ' ';
    lines.push(`[${mode.order}]${mark}${mode.label[lang]} (${mode.id}) | ${modeSummary(mode, lang)}`);
    lines.push(...labeled('', mode.tagline[lang], inner).map((line) => `  ${line.trimStart()}`));
    lines.push(...labeled(`  ${t('fits', lang)}`, mode.useWhen[lang], inner));
    lines.push(...labeled(`  ${t('cost', lang)}`, mode.tradeoff[lang], inner));
    lines.push('');
  }
  lines.push(t('helpHint', lang));
  return box(`dsh-stream-agent v${options.version} - ${t('barTitle', lang)}`, lines, width);
}

/** 机器可读状态（--json / status --json）。 */
export function renderJson(state              , options               )         {
  const mode = getMode(state.mode);
  return JSON.stringify({
    version: options.version,
    active: options.active !== false,
    mode: { id: mode.id, order: mode.order, label: mode.label[state.lang], config: mode.config },
    lang: state.lang,
    modes: MODES.map((m) => ({ id: m.id, order: m.order, label: m.label, tagline: m.tagline })),
  }, null, 2);
}

// ---------------------------------------------------------------------------
// ⑤ 按键 → 意图
// ---------------------------------------------------------------------------

                       
                    
                           
                          
                           
                     
                                   
                     
                                    
                     

/** 把一次按键（原始终端序列）解释为控制栏意图。q 在帮助页是"返回"，在面板是"退出"。 */
export function interpretKey(raw        , context                         = {})            {
  const key = raw;
  if (key === 'q' || key === 'Q' || key === '\x03' /* Ctrl-C */ || key === '\x1b' /* Esc */) {
    return context.helpOpen === true ? { kind: 'close-help' } : { kind: 'quit' };
  }
  if (key === '?' || key === 'h' || key === 'H') return { kind: 'toggle-help' };
  if (key === 'l' || key === 'L') return { kind: 'toggle-lang' };
  if (key === 'r' || key === 'R') return { kind: 'reset' };
  if (key === '\x1b[A' || key === 'k' || key === 'K') return { kind: 'move', delta: -1 };
  if (key === '\x1b[B' || key === 'j' || key === 'J') return { kind: 'move', delta: 1 };
  if (/^[1-4]$/.test(key)) {
    const mode = modeByOrder(Number(key));
    if (mode !== undefined) return { kind: 'select', mode: mode.id };
  }
  if (key === '\r' || key === '\n' || key === ' ') return { kind: 'apply' };
  return { kind: 'none' };
}

/** 焦点移动（↑↓）：在 MODES 里环状移动。 */
export function moveFocus(focus        , delta        )         {
  const index = MODES.findIndex((m) => m.id === focus);
  const base = index < 0 ? 0 : index;
  return MODES[(base + delta + MODES.length) % MODES.length].id;
}

/** "应用焦点"的落点（Enter）：返回焦点模式（越界回默认）。 */
export function selectFocus(focus        )         {
  return getMode(focus).id;
}

/** 渲染成可直接 write 的文本（CLI 与测试共用）。 */
export function renderToText(lines                   )         {
  return `${lines.join('\n')}\n`;
}
