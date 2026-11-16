// test/control-bar.test.ts —— 控制栏（v0.2.1）
//
// 验收口径：
//   · 四个模式全部有中英双语字段，且 en 里不允许出现中文、zh 里必须有中文（防"翻译漏了"）；
//   · 面板/引导/帮助在 56-92 列下每一行的显示宽度完全一致（盒子不错位）；
//   · 结构字符只用 ASCII（· → ↑↓ … 这类东亚宽度不确定字符会让中英终端错位）；
//   · 按键语义：1-4 选模式、Up/Down 移动、Enter 应用、l 切语言、r 重置、? 帮助、q 退出；
//   · 状态落盘：读写往返、坏文件回默认且告警、env 覆盖、装配显式配置最高优先。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_MODE, MODES, getMode, isModeId, modeByOrder, modeConfig } from '../src/kernel/modes.ts';
import {
  DEFAULT_LANG,
  createControlState,
  displayWidth,
  interpretKey,
  isLang,
  modeSummary,
  moveFocus,
  otherLang,
  panelWidth,
  renderBanner,
  renderHelp,
  renderJson,
  renderPanel,
  renderStatusBar,
  t,
  textKeys,
  truncate,
  wrapText,
} from '../src/kernel/control-bar.ts';
import { controlFileOf, readPersistedControl, resolveControlState, writePersistedControl } from '../src/entry/control-state.ts';
import { ControlSession } from '../src/entry/control-session.ts';
import { splitKeys } from '../src/entry/control-bar-cli.ts';
import { VERSION } from '../src/version.ts';

const V = { version: VERSION, columns: 80 };

function uniformWidth(lines: readonly string[]): boolean {
  const widths = new Set(lines.map((line) => displayWidth(line)));
  return widths.size === 1;
}

test('模式目录：四个模式，id 与序号唯一，默认模式在目录里', () => {
  assert.equal(MODES.length, 4);
  assert.equal(new Set(MODES.map((m) => m.id)).size, 4);
  assert.deepEqual(MODES.map((m) => m.order), [1, 2, 3, 4]);
  assert.ok(isModeId(DEFAULT_MODE));
  assert.equal(modeByOrder(2)?.id, 'lean');
  assert.equal(modeByOrder(9), undefined);
  assert.equal(isModeId('nope'), false);
  assert.equal(getMode('nope').id, DEFAULT_MODE, '未知模式回落到默认');
});

test('模式双语：每一条面向用户的文案两种语言都有，且语言不串味', () => {
  const hasCjk = (s: string): boolean => /[\u4e00-\u9fff]/.test(s);
  const hasLatin = (s: string): boolean => /[A-Za-z]/.test(s);
  for (const mode of MODES) {
    for (const field of ['label', 'tagline', 'useWhen', 'tradeoff'] as const) {
      const zh = mode[field].zh;
      const en = mode[field].en;
      assert.ok(zh.trim() !== '' && en.trim() !== '', `${mode.id}.${field} 两种语言都不能为空`);
      assert.ok(hasCjk(zh), `${mode.id}.${field}.zh 必须包含中文`);
      assert.equal(hasCjk(en), false, `${mode.id}.${field}.en 不允许混入中文：${en}`);
      if (field === 'useWhen' || field === 'tradeoff') assert.ok(hasLatin(en), `${mode.id}.${field}.en 必须可读`);
    }
  }
});

test('模式只映射既有配置项：默认模式与 v0.2.0 出厂默认等价（除显式写死项）', () => {
  const balanced = modeConfig('balanced');
  assert.equal(balanced.selfReadFeedback, 'receipt');
  assert.equal(balanced.enableCode, 'auto', 'balanced 不改变"宿主有 PTC 就开"的既有语义');
  assert.equal(balanced.persistFallback, true);
  assert.equal(balanced.maxParallelToolCalls, 3);
  assert.equal(balanced.maxReentries, 8);
  assert.equal(balanced.budgetTokens, undefined);

  const lean = modeConfig('lean');
  assert.ok((lean.budgetTokens ?? 0) > 0, 'lean 必须真的更省：预算阶梯要能触发');
  assert.equal(lean.enableCode, false);

  const compat = modeConfig('compat');
  assert.equal(compat.selfReadFeedback, 'full', 'compat 恢复全文回灌');
  assert.equal(compat.maxParallelToolCalls, 1, 'compat 串行执行，便于对照');

  const power = modeConfig('power');
  assert.equal(power.enableCode, true, 'power 显式开启 tf-code');

  // 返回副本：调用方改它不得污染目录
  lean.maxReentries = 99;
  assert.notEqual(modeConfig('lean').maxReentries, 99);
});

test('文案表：每个 key 中英都非空（结构性一致）', () => {
  for (const key of textKeys()) {
    const zh = t(key, 'zh');
    const en = t(key, 'en');
    assert.ok(zh.trim() !== '', `${key}.zh 为空`);
    assert.ok(en.trim() !== '', `${key}.en 为空`);
    assert.equal(/[\u4e00-\u9fff]/.test(en), false, `${key}.en 混入中文：${en}`);
  }
});

test('渲染：面板 / 引导 / 帮助在 56-92 列下每行等宽（盒子不错位）', () => {
  for (const columns of [56, 60, 72, 80, 100, 120]) {
    for (const lang of ['zh', 'en'] as const) {
      for (const mode of ['balanced', 'lean', 'compat', 'power'] as const) {
        const state = createControlState({ mode, lang });
        const panel = renderPanel(state, { version: VERSION, columns });
        const banner = renderBanner(state, { version: VERSION, columns });
        const help = renderHelp(state, { version: VERSION, columns });
        assert.ok(uniformWidth(panel), `panel 行宽不一致 lang=${lang} mode=${mode} columns=${columns}`);
        assert.ok(uniformWidth(banner), `banner 行宽不一致 lang=${lang} mode=${mode} columns=${columns}`);
        assert.ok(uniformWidth(help), `help 行宽不一致 lang=${lang} mode=${mode} columns=${columns}`);
        assert.ok(panel.length > 8 && banner.length > 8 && help.length > 12);
      }
    }
  }
});

test('渲染：不出现东亚宽度不确定字符（· → ↑↓ … ①），结构只用 ASCII', () => {
  const banned = /[·→↑↓…①②③④]/;
  for (const lang of ['zh', 'en'] as const) {
    const state = createControlState({ lang });
    const text = [
      ...renderPanel(state, { version: VERSION }),
      ...renderBanner(state, { version: VERSION }),
      ...renderHelp(state, { version: VERSION }),
      renderStatusBar(state, { version: VERSION }),
    ].join('\n');
    assert.equal(banned.test(text), false, `渲染里出现了歧义宽度字符：${text.match(banned)?.[0]}`);
  }
});

test('渲染：中英切换后语言标记与文案都跟着变，模式信息保持不变', () => {
  const zh = createControlState({ mode: 'lean', lang: 'zh' });
  const en = createControlState({ mode: 'lean', lang: 'en' });
  const zhText = renderPanel(zh, { version: VERSION }).join('\n');
  const enText = renderPanel(en, { version: VERSION }).join('\n');

  assert.ok(zhText.includes('精简') && zhText.includes('语言: zh'));
  assert.ok(enText.includes('Lean') && enText.includes('Language: en'));
  assert.equal(/[\u4e00-\u9fff]/.test(enText.replace(/#[\w-]+/g, '')), false, 'en 面板不允许残留中文');
  assert.ok(zhText.includes('并行 2') && enText.includes('parallel 2'), '模式参数不随语言变化');
  assert.equal(modeSummary(getMode('lean'), 'zh').includes('预算'), true);
  assert.equal(modeSummary(getMode('lean'), 'en').includes('budget'), true);
});

test('渲染：状态条是单行且不超过面板宽度', () => {
  for (const lang of ['zh', 'en'] as const) {
    const state = createControlState({ lang });
    const line = renderStatusBar(state, { version: VERSION, columns: 60 });
    assert.equal(line.includes('\n'), false);
    assert.ok(displayWidth(line) <= panelWidth(60), `状态条超宽：${displayWidth(line)}`);
    assert.ok(line.includes(VERSION));
  }
});

test('渲染：--json 结构稳定，含四个模式与当前配置', () => {
  const parsed = JSON.parse(renderJson(createControlState({ mode: 'power', lang: 'en' }), { version: VERSION })) as {
    version: string; active: boolean; mode: { id: string; config: { enableCode: boolean } }; lang: string; modes: unknown[];
  };
  assert.equal(parsed.version, VERSION);
  assert.equal(parsed.active, true);
  assert.equal(parsed.mode.id, 'power');
  assert.equal(parsed.mode.config.enableCode, true);
  assert.equal(parsed.lang, 'en');
  assert.equal(parsed.modes.length, 4);
});

test('按键：1-4 / Up Down / Enter / l / r / ? / q 各自映射到正确意图', () => {
  assert.deepEqual(interpretKey('1'), { kind: 'select', mode: 'balanced' });
  assert.deepEqual(interpretKey('3'), { kind: 'select', mode: 'compat' });
  assert.deepEqual(interpretKey('\x1b[A'), { kind: 'move', delta: -1 });
  assert.deepEqual(interpretKey('\x1b[B'), { kind: 'move', delta: 1 });
  assert.deepEqual(interpretKey('k'), { kind: 'move', delta: -1 });
  assert.deepEqual(interpretKey('j'), { kind: 'move', delta: 1 });
  assert.deepEqual(interpretKey('\r'), { kind: 'apply' });
  assert.deepEqual(interpretKey('\n'), { kind: 'apply' });
  assert.deepEqual(interpretKey('l'), { kind: 'toggle-lang' });
  assert.deepEqual(interpretKey('r'), { kind: 'reset' });
  assert.deepEqual(interpretKey('?'), { kind: 'toggle-help' });
  assert.deepEqual(interpretKey('q'), { kind: 'quit' });
  assert.deepEqual(interpretKey('q', { helpOpen: true }), { kind: 'close-help' }, '帮助页里 q 是返回');
  assert.deepEqual(interpretKey('9'), { kind: 'none' });
  assert.deepEqual(interpretKey('z'), { kind: 'none' });
});

test('焦点移动：环状前进/后退，未知焦点从第一个开始', () => {
  assert.equal(moveFocus('balanced', 1), 'lean');
  assert.equal(moveFocus('power', 1), 'balanced');
  assert.equal(moveFocus('balanced', -1), 'power');
  assert.equal(moveFocus('power', -1), 'compat');
});

test('语言工具：otherLang / isLang / 默认值', () => {
  assert.equal(otherLang('zh'), 'en');
  assert.equal(otherLang('en'), 'zh');
  assert.equal(isLang('zh'), true);
  assert.equal(isLang('jp'), false);
  assert.equal(createControlState().lang, DEFAULT_LANG);
  assert.equal(createControlState({ mode: 'bad', lang: 'bad' }).mode, DEFAULT_MODE);
});

test('文本工具：truncate 与 wrapText 按显示列宽工作（CJK 记 2 列）', () => {
  assert.equal(displayWidth('中文'), 4);
  assert.equal(displayWidth('abc'), 3);
  assert.equal(truncate('abcdef', 4), 'a...');
  assert.equal(truncate('中文中文', 5), '中...');
  const wrapped = wrapText('中文中文中文', 4);
  assert.deepEqual(wrapped, ['中文', '中文', '中文']);
  assert.deepEqual(wrapText('short', 10), ['short']);
});

test('状态落盘：写入 → 读取往返（原子替换，字段齐全）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-control-'));
  const file = writePersistedControl(createControlState({ mode: 'lean', lang: 'en' }), dir);
  assert.equal(file, controlFileOf(dir));
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { mode: string; lang: string; schema: number; updatedAt: string };
  assert.equal(raw.mode, 'lean');
  assert.equal(raw.lang, 'en');
  assert.equal(raw.schema, 1);
  assert.ok(!Number.isNaN(Date.parse(raw.updatedAt)));

  const read = readPersistedControl(dir);
  assert.equal(read.found, true);
  assert.deepEqual(read.state, { mode: 'lean', lang: 'en' });
});

test('状态读取：坏 JSON / 未知字段回默认并告警，不抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-control-bad-'));
  writeFileSync(controlFileOf(dir), '{ not json', 'utf8');
  const warnings: string[] = [];
  const read = readPersistedControl(dir, (message) => warnings.push(message));
  assert.equal(read.found, false);
  assert.deepEqual(read.state, { mode: DEFAULT_MODE, lang: DEFAULT_LANG });
  assert.equal(warnings.length, 1);

  writeFileSync(controlFileOf(dir), JSON.stringify({ mode: 'unknown-mode', lang: 'fr' }), 'utf8');
  assert.deepEqual(readPersistedControl(dir).state, { mode: DEFAULT_MODE, lang: DEFAULT_LANG });

  const missing = readPersistedControl(mkdtempSync(join(tmpdir(), 'tf-control-none-')));
  assert.equal(missing.found, false);
});

test('状态解析优先级：装配显式 config > 环境变量 > control.json > 默认', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-control-prio-'));
  writePersistedControl(createControlState({ mode: 'compat', lang: 'zh' }), dir);

  const fromFile = resolveControlState({}, dir);
  assert.equal(fromFile.mode, 'compat');
  assert.equal(fromFile.modeSource, 'file');
  assert.equal(fromFile.langSource, 'file');
  assert.ok(Number.isFinite(Date.parse(readPersistedControl(dir).updatedAt ?? '')), '落盘必须带可解析的 updatedAt（桌面控制页的并发栅栏）');

  const previousMode = process.env.STREAM_AGENT_MODE;
  const previousLang = process.env.STREAM_AGENT_LANG;
  try {
    process.env.STREAM_AGENT_MODE = 'lean';
    process.env.STREAM_AGENT_LANG = 'en';
    assert.equal(resolveControlState({}, dir).mode, 'lean');
    assert.equal(resolveControlState({}, dir).modeSource, 'env');
    assert.equal(resolveControlState({}, dir).lang, 'en');
    assert.equal(resolveControlState({}, dir).langSource, 'env');

    const pinned = resolveControlState({ mode: 'power', lang: 'zh' }, dir);
    assert.equal(pinned.mode, 'power');
    assert.equal(pinned.modeSource, 'config');
    assert.equal(pinned.lang, 'zh');
    assert.equal(pinned.langSource, 'config');

    process.env.STREAM_AGENT_MODE = 'not-a-mode';
    assert.equal(resolveControlState({}, dir).mode, 'compat', '非法 env 不得覆盖落盘值');
  } finally {
    if (previousMode === undefined) delete process.env.STREAM_AGENT_MODE; else process.env.STREAM_AGENT_MODE = previousMode;
    if (previousLang === undefined) delete process.env.STREAM_AGENT_LANG; else process.env.STREAM_AGENT_LANG = previousLang;
  }
});

// ---------------------------------------------------------------------------
// 交互会话：把"按键 → 状态 → 画面 → 落盘"整条链路跑起来（不需要 pty）
// ---------------------------------------------------------------------------

test('交互会话：l 键在中英之间往返，画面与落盘同步（两个方向都验）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-session-lang-'));
  const session = new ControlSession(createControlState({ mode: 'balanced', lang: 'zh' }), {
    save: (next) => writePersistedControl(next, dir),
    columns: () => 80,
  });

  assert.ok(session.frame().includes('控制栏'));
  assert.equal(readPersistedControl(dir).state.lang, 'zh');

  session.handle('l');
  const enFrame = session.frame();
  assert.match(enFrame, /CONTROL BAR/);
  assert.equal(/[\u4e00-\u9fff]/.test(enFrame), false, '切到英文后画面不允许残留中文');
  assert.equal(readPersistedControl(dir).state.lang, 'en');
  assert.equal(session.state.lang, 'en');

  session.handle('l');
  const zhFrame = session.frame();
  assert.ok(zhFrame.includes('控制栏'));
  assert.ok(zhFrame.includes('语言: zh'));
  assert.equal(readPersistedControl(dir).state.lang, 'zh');
});

test('交互会话：数字键直接切模式并落盘，焦点跟随；画面显示对应语言的模式名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-session-mode-'));
  const session = new ControlSession(createControlState({ mode: 'balanced', lang: 'en' }), {
    save: (next) => writePersistedControl(next, dir),
    columns: () => 80,
  });

  session.handle('2');
  assert.equal(session.state.mode, 'lean');
  assert.equal(session.focus, 'lean');
  assert.equal(readPersistedControl(dir).state.mode, 'lean');
  assert.match(session.frame(), /Lean/);
  assert.ok(session.note.includes('saved'), '落盘成功要给一行回执');

  session.handle('l');
  assert.equal(session.state.lang, 'zh', 'l 从 en 切到 zh');
  session.handle('4');
  assert.equal(session.state.mode, 'power');
  assert.equal(readPersistedControl(dir).state.mode, 'power');
  assert.equal(readPersistedControl(dir).state.lang, 'zh');
  assert.match(session.frame(), /增强/);
  assert.match(session.frame(), /code 开/);
});

test('交互会话：Up/Down 只移动焦点，Enter 才应用；r 回默认但保留语言', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-session-focus-'));
  const session = new ControlSession(createControlState({ mode: 'balanced', lang: 'en' }), {
    save: (next) => writePersistedControl(next, dir),
    columns: () => 80,
  });

  session.handle('\x1b[B');
  assert.equal(session.focus, 'lean');
  assert.equal(session.state.mode, 'balanced', '移动焦点不得改模式');
  assert.equal(readPersistedControl(dir).state.mode, 'balanced');

  session.handle('\r');
  assert.equal(session.state.mode, 'lean');
  assert.equal(readPersistedControl(dir).state.mode, 'lean');

  session.handle('3');
  assert.equal(session.state.mode, 'compat');
  session.handle('r');
  assert.equal(session.state.mode, 'balanced', 'r 重置回默认模式');
  assert.equal(session.state.lang, 'en', '重置模式不应顺手改语言');
});

test('交互会话：? 打开全模式指南，q 先返回面板，再 q 才退出', () => {
  const session = new ControlSession(createControlState({ lang: 'zh' }), {
    save: (next) => writePersistedControl(next, mkdtempSync(join(tmpdir(), 'tf-session-help-'))),
    columns: () => 80,
  });

  assert.deepEqual(session.handle('?'), { quit: false, changed: true });
  assert.equal(session.helpOpen, true);
  assert.ok(session.frame().includes('全模式指南'));
  assert.ok(session.frame().includes('精简') && session.frame().includes('增强'), '指南要覆盖四个模式');

  assert.deepEqual(session.handle('q'), { quit: false, changed: true });
  assert.equal(session.helpOpen, false);
  assert.deepEqual(session.handle('q'), { quit: true, changed: false });
});

test('交互会话：未知键不产生重绘；落盘失败只提示不回滚内存状态', () => {
  const session = new ControlSession(createControlState({ lang: 'zh' }), {
    save: () => { throw new Error('disk full'); },
    columns: () => 80,
  });

  assert.deepEqual(session.handle('z'), { quit: false, changed: false });
  assert.deepEqual(session.handle('9'), { quit: false, changed: false });

  session.handle('3');
  assert.equal(session.state.mode, 'compat', '落盘失败不能回滚本次运行内的选择');
  assert.match(session.note, /状态写入失败/);
  assert.match(session.frame(), /compat/);
});

test('按键拆分：方向键三字节序列与普通键能被正确分开', () => {
  assert.deepEqual(splitKeys('\x1b[A1'), ['\x1b[A', '1']);
  assert.deepEqual(splitKeys('\x1b[B\x1b[A'), ['\x1b[B', '\x1b[A']);
  assert.deepEqual(splitKeys('q'), ['q']);
});
