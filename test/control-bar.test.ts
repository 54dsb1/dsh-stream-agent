// test/control-bar.test.ts —— 控制栏（0.5.0 两区块）
//
// 验收口径：
//   · 两轴目录（channel × tier）全部有中英双语字段，且 en 里不允许出现中文、zh 里必须有
//     中文（防"翻译漏了"）；
//   · 面板/引导/帮助在 56-92 列下每一行的显示宽度完全一致（盒子不错位）；
//   · 结构字符只用 ASCII（· → ↑↓ … 这类东亚宽度不确定字符会让中英终端错位）；
//   · 按键语义：1-2 选通道、3-5 选档位、c/t 快切、Up/Down 移动、Enter 应用、l 切语言、
//     r 重置、? 帮助、q 退出；
//   · 状态落盘：读写往返、坏文件回默认且告警、env 覆盖、装配显式配置最高优先；
//   · 旧模式值（balanced/lean/compat/power）走 LEGACY_MODE_ALIAS 别名映射 + warn（§4.4）；
//   · control.json 迁移：旧 mode 字段 → (channel, tier)，写回保留 mode 一个 minor。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHANNELS,
  CHANNEL_SPECS,
  TIERS,
  TIER_SPECS,
  DEFAULT_CHANNEL,
  DEFAULT_TIER,
  LEGACY_MODE_ALIAS,
  LEGACY_MODE_IDS,
  getChannel,
  getTier,
  isChannelId,
  isLegacyModeId,
  isTierId,
  resolveLegacyMode,
  reverseLegacyMode,
  publicChannelCatalog,
  publicTierCatalog,
  publicLegacyModeCatalog,
} from '../src/kernel/modes.ts';
import {
  DEFAULT_LANG,
  createControlState,
  displayWidth,
  interpretKey,
  isLang,
  tierValuesLine,
  moveFocus,
  otherLang,
  panelWidth,
  renderBanner,
  renderHelp,
  renderJson,
  renderPanel,
  renderStatusBar,
  limitsSummaryLine,
  statsLine,
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

// ---------------------------------------------------------------- 两轴目录

test('两轴目录：通道 2 条、档位 3 条，id 与序号唯一，默认在目录里', () => {
  assert.equal(CHANNELS.length, 2);
  assert.equal(TIERS.length, 3);
  assert.deepEqual([...CHANNELS], ['standard', 'code']);
  assert.deepEqual([...TIERS], ['light', 'standard', 'deep']);
  assert.equal(new Set(CHANNEL_SPECS.map((c) => c.id)).size, 2);
  assert.equal(new Set(TIER_SPECS.map((x) => x.id)).size, 3);
  assert.equal(DEFAULT_CHANNEL, 'standard');
  assert.equal(DEFAULT_TIER, 'standard');
  assert.ok(isChannelId('code') && !isChannelId('mode'));
  assert.ok(isTierId('light') && !isTierId('lean'));
});

test('档位数值（0.5.2）：生效值全部未设置（不限制）；0.6.1 参考值对齐 thinkflow 且无 maxSteps', () => {
  const [light, standard, deep] = TIER_SPECS;
  const unset = { maxSteps: 0, maxInputTokens: 0, compactAggressiveness: 'balanced', peekBudgetChars: 0, keepRecent: 0, maxSummaryChars: 0 };
  assert.deepEqual(light!.values, unset);
  assert.deepEqual(standard!.values, unset);
  assert.deepEqual(deep!.values, unset);
  // 0.6.1：参考值对齐 thinkflow 对齐层——轮数一律 0（不限制），保留/摘要 = thinkflow 数值
  for (const tier of TIER_SPECS) {
    assert.equal(tier.reference.maxSteps, 0, `${tier.id} 参考值不得携带轮数上限`);
    assert.equal(tier.reference.keepRecent, 30);
    assert.equal(tier.reference.maxSummaryChars, 16_000);
  }
  assert.deepEqual(light!.reference.compactAggressiveness, 'aggressive');
  assert.deepEqual(deep!.reference.compactAggressiveness, 'conservative');
});

test('双语字段完整性：通道/档位 en 无中文、zh 有中文', () => {
  for (const spec of [...CHANNEL_SPECS, ...TIER_SPECS]) {
    for (const [, text] of Object.entries(spec)) {
      if (text === null || typeof text !== 'object') continue;
      const pair = text as { zh?: string; en?: string };
      if (typeof pair.zh !== 'string' || typeof pair.en !== 'string') continue;
      assert.ok(/[\u4e00-\u9fff]/.test(pair.zh), `${spec.id} 的中文文案必须有中文`);
      assert.ok(!/[\u4e00-\u9fff]/.test(pair.en), `${spec.id} 的英文文案不得出现中文`);
    }
  }
});

test('区块 B 数值行：生效值（未设=不限制）+ thinkflow 对齐默认说明（不做定性宣传）', () => {
  const line = tierValuesLine('zh');
  assert.ok(line.includes('未设'), line);
  assert.ok(line.includes('thinkflow'), line);
  const withLimits = tierValuesLine('zh', { maxSteps: 40, maxInputTokens: 48_000 });
  assert.ok(withLimits.includes('40'), withLimits);
  assert.ok(withLimits.includes('48k'), withLimits);
  const unlimited = tierValuesLine('zh', { maxSteps: 0, maxInputTokens: 0 });
  assert.ok(unlimited.includes('不限制'), unlimited);
});

// ---------------------------------------------------------------- 别名（§4.4）

test('LEGACY_MODE_ALIAS：四模式映射正确；compat 不再关工具面（D2 修复的语义保证）', () => {
  assert.deepEqual(LEGACY_MODE_ALIAS.balanced, { channel: 'standard', tier: 'standard' });
  assert.deepEqual(LEGACY_MODE_ALIAS.lean, { channel: 'standard', tier: 'light' });
  assert.deepEqual(LEGACY_MODE_ALIAS.compat, { channel: 'standard', tier: 'deep' });
  assert.deepEqual(LEGACY_MODE_ALIAS.power, { channel: 'code', tier: 'standard' });
  // 别名只映射 (channel, tier)——不携带任何工具面副作用（D2/D3 的成因正是旧预设顺手改工具面）
  for (const mapped of Object.values(LEGACY_MODE_ALIAS)) {
    assert.ok(!('toolSurface' in mapped));
    assert.ok(!('enableCode' in mapped));
  }
  assert.ok(isLegacyModeId('lean') && !isLegacyModeId('light'));
  assert.equal(resolveLegacyMode('lean').tier, 'light');
  assert.equal(resolveLegacyMode('lean').aliased, true);
  assert.equal(resolveLegacyMode('nope').aliased, false);
});

test('反向别名（回滚兼容）：可精确表达的组合写回 mode 字段', () => {
  assert.equal(reverseLegacyMode('standard', 'standard'), 'balanced');
  assert.equal(reverseLegacyMode('standard', 'light'), 'lean');
  assert.equal(reverseLegacyMode('standard', 'deep'), 'compat');
  assert.equal(reverseLegacyMode('code', 'standard'), 'power');
  assert.equal(reverseLegacyMode('code', 'deep'), undefined, '不可精确表达的组合省略 mode 字段');
});

test('对外目录投影：channels/tiers/legacyModes（别名映射目录，无版本标注）', () => {
  assert.equal(publicChannelCatalog().length, 2);
  assert.equal(publicTierCatalog().length, 3);
  const legacy = publicLegacyModeCatalog();
  assert.deepEqual(legacy.map((m) => m.id), [...LEGACY_MODE_IDS]);
  for (const m of legacy) {
    assert.equal('deprecated' in m, false, '目录不带弃用标注（版本痕迹已清）');
    assert.equal('removal' in m, false, '目录不带移除版本（版本痕迹已清）');
    assert.ok('aliasTarget' in m);
  }
});

// ---------------------------------------------------------------- 渲染纪律

test('文案表：中英成对，缺 key 回退 key 本身', () => {
  for (const key of textKeys()) {
    assert.ok(isLang('zh') && isLang('en'));
    assert.notEqual(t(key, 'zh'), '');
    assert.notEqual(t(key, 'en'), '');
  }
  assert.equal(t('definitely-not-a-key' as never), 'definitely-not-a-key');
});

test('状态条：通道与档位都在单行里', () => {
  const state = createControlState({ channel: 'code', tier: 'deep' });
  const line = renderStatusBar(state, V);
  assert.ok(line.includes('code') && line.includes('deep'), line);
});

test('面板：两个区块都在（① 执行通道 / ② 上下文档位），来源行存在；预设条已移除', () => {
  const state = createControlState({ channel: 'standard', tier: 'standard' });
  const lines = renderPanel(state, V);
  const text = lines.join('\n');
  assert.ok(text.includes('① 执行通道'), text);
  assert.ok(text.includes('② 上下文档位'), text);
  assert.ok(text.includes('来源'), text);
  assert.ok(text.includes('thinkflow'), text);
  assert.ok(!text.includes('[p]'), 'p 键预设条已随预设系统移除');
});

test('面板盒子：56-92 列逐行等宽（盒子不错位）', () => {
  for (const columns of [56, 64, 72, 80, 92]) {
    const state = createControlState({});
    for (const render of [renderBanner, renderHelp, renderPanel]) {
      const lines = render(state, { version: VERSION, columns });
      assert.ok(uniformWidth(lines), `${render.name} @${columns} 列宽度不齐`);
    }
  }
});

test('renderJson：channels/tiers/legacyModes 三份目录 + channel/tier/values', () => {
  const state = createControlState({ channel: 'code', tier: 'light' });
  const payload = JSON.parse(renderJson(state, V)) as {
    channel: { id: string };
    tier: { id: string; values: Record<string, number>; reference: Record<string, number> };
    channels: unknown[];
    tiers: unknown[];
    legacyModes: unknown[];
  };
  assert.equal(payload.channel.id, 'code');
  assert.equal(payload.tier.id, 'light');
  assert.equal(payload.tier.values.maxSteps, 0);
  assert.equal(payload.tier.reference.maxSteps, 0, '0.6.1：参考值轮数 = 不限制');
  assert.equal('preset' in payload, false, '行为预设字段已移除');
  assert.equal('presets' in payload, false, '行为预设目录已移除');
  assert.equal(payload.channels.length, 2);
  assert.equal(payload.tiers.length, 3);
  assert.equal(payload.legacyModes.length, 4);
});

test('运行状态行（§3.3 底部）：本任务 N · 换基 · 重复取回 · 摘要；缺省渲染 0 占位', () => {
  const empty = statsLine(undefined, 'zh');
  assert.ok(empty.includes('N=0'), empty);
  assert.ok(empty.includes('重复取回 0/0'), empty);
  const full = statsLine({
    requests: 5,
    rebases: 1,
    redundantPeeks: { hits: 3, total: 4 },
    summaries: 2,
  }, 'zh');
  assert.ok(full.includes('N=5') && full.includes('重复取回 3/4') && full.includes('摘要 2 段'), full);
});

// ---------------------------------------------------------------- 按键

test('按键：1-2 选通道，3-5 选档位，c/t 快切，方向键移动，Enter 应用', () => {
  assert.deepEqual(interpretKey('1'), { kind: 'select-channel', channel: 'standard' });
  assert.deepEqual(interpretKey('2'), { kind: 'select-channel', channel: 'code' });
  assert.deepEqual(interpretKey('3'), { kind: 'select-tier', tier: 'light' });
  assert.deepEqual(interpretKey('4'), { kind: 'select-tier', tier: 'standard' });
  assert.deepEqual(interpretKey('5'), { kind: 'select-tier', tier: 'deep' });
  assert.deepEqual(interpretKey('c'), { kind: 'cycle-channel' });
  assert.deepEqual(interpretKey('t'), { kind: 'cycle-tier' });
  assert.deepEqual(interpretKey('l'), { kind: 'toggle-lang' });
  assert.deepEqual(interpretKey('r'), { kind: 'reset' });
  assert.deepEqual(interpretKey('?'), { kind: 'toggle-help' });
  assert.deepEqual(interpretKey('q'), { kind: 'quit' });
  assert.deepEqual(interpretKey('q', { helpOpen: true }), { kind: 'close-help' });
  assert.deepEqual(interpretKey('\x1b[B'), { kind: 'move', delta: 1 });
  assert.deepEqual(interpretKey('\r'), { kind: 'apply' });
  // 0.6.0 正式版：x = 上下文原样开关；0.6.1：p 键已随预设系统移除（回落为未知键）
  assert.deepEqual(interpretKey('x'), { kind: 'toggle-context-raw' });
  assert.deepEqual(interpretKey('p'), { kind: 'none' });
  assert.deepEqual(interpretKey('z'), { kind: 'none' });
});

test('焦点移动：扁平五选项环状移动', () => {
  const first = moveFocus({ kind: 'channel', id: 'standard' }, -1);
  assert.deepEqual(first, { kind: 'tier', id: 'deep' }, '环状：头往上 = 尾（deep）');
  const next = moveFocus({ kind: 'channel', id: 'code' }, 1);
  assert.deepEqual(next, { kind: 'tier', id: 'light' });
});

test('交互会话（ControlSession）：1/2 切通道、4 切档位、c/t 快切、语言切换、重置只动轴不动语言', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-cb-'));
  const file = join(dir, 'control.json');
  const session = new ControlSession(createControlState({ lang: 'zh' }), {
    save: (next) => {
      writeFileSync(file, JSON.stringify(next), 'utf8');
      return file;
    },
    columns: () => 80,
  });
  try {
    session.handle('2');
    assert.equal(session.state.channel, 'code');
    session.handle('4');
    assert.equal(session.state.tier, 'standard');
    session.handle('t');
    assert.equal(session.state.tier, 'deep', 't 循环 light→standard→deep');
    session.handle('c');
    assert.equal(session.state.channel, 'standard', 'c 在 standard↔code 之间切换');
    session.handle('l');
    assert.equal(session.state.lang, 'en');
    session.handle('r');
    assert.equal(session.state.channel, 'standard');
    assert.equal(session.state.tier, 'standard');
    assert.equal(session.state.lang, 'en', '重置不带走语言');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { channel: string; tier: string; lang: string };
    assert.equal(saved.channel, 'standard');
    assert.equal(saved.tier, 'standard');
  } finally {
    session.handle('q');
  }
});

// ---------------------------------------------------------------- 状态落盘与别名迁移

test('control.json 往返：channel/tier/lang 写读一致；写回保留旧 mode 字段一个 minor（回滚兼容）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-cs-'));
  try {
    writePersistedControl({ channel: 'code', tier: 'deep', lang: 'en' }, dir);
    const raw = JSON.parse(readFileSync(controlFileOf(dir), 'utf8')) as { channel: string; tier: string; lang: string; mode?: string; schema: number };
    assert.equal(raw.channel, 'code');
    assert.equal(raw.tier, 'deep');
    assert.equal(raw.lang, 'en');
    assert.equal(raw.schema, 5, '0.6.0 正式版 schema 升 5（新增 contextRaw / preset）');
    assert.equal(raw.mode, undefined, 'code+deep 无可精确表达的旧模式 → mode 字段省略');
    const round = readPersistedControl(dir);
    assert.equal(round.state.channel, 'code');
    assert.equal(round.state.tier, 'deep');
    assert.equal(round.state.lang, 'en');
    assert.equal(round.aliased, false);

    writePersistedControl({ channel: 'standard', tier: 'light', lang: 'zh' }, dir);
    const withLegacy = JSON.parse(readFileSync(controlFileOf(dir), 'utf8')) as { mode?: string };
    assert.equal(withLegacy.mode, 'lean', '可精确表达 → 写回 mode 一个 minor（0.4.x 回滚可读）');
  } finally {
    // cleanup
  }
});

test('旧字段迁移：control.json 只有 mode 字段 → 别名映射 + 告警（不静默）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-cs2-'));
  writeFileSync(controlFileOf(dir), JSON.stringify({ schema: 1, mode: 'lean', lang: 'zh', updatedAt: '2026-11-22T00:00:00.000Z' }), 'utf8');
  const warnings: string[] = [];
  const read = readPersistedControl(dir, (m) => warnings.push(m));
  assert.equal(read.state.channel, 'standard');
  assert.equal(read.state.tier, 'light');
  assert.equal(read.aliased, true);
  assert.equal(read.legacyMode, 'lean');
  assert.ok(warnings.some((w) => w.includes('lean') && w.includes('别名')), warnings.join('\n'));
});

test('优先级：显式 config > env > control.json > 默认；旧 STREAM_AGENT_MODE 走别名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-cs3-'));
  writePersistedControl({ channel: 'code', tier: 'deep', lang: 'en' }, dir);
  const savedChannel = process.env.STREAM_AGENT_CHANNEL;
  const savedTier = process.env.STREAM_AGENT_TIER;
  const savedMode = process.env.STREAM_AGENT_MODE;
  try {
    // env 旧值走别名
    process.env.STREAM_AGENT_MODE = 'lean';
    const warnings: string[] = [];
    const fromEnv = resolveControlState({}, dir, (m) => warnings.push(m));
    assert.equal(fromEnv.channel, 'standard');
    assert.equal(fromEnv.tier, 'light');
    assert.equal(fromEnv.aliased, true);
    assert.ok(warnings.length >= 1);
    delete process.env.STREAM_AGENT_MODE;
    // 显式 config（新轴值）压过 env 与文件
    const fromConfig = resolveControlState({ channel: 'standard', tier: 'deep' }, dir);
    assert.equal(fromConfig.channel, 'standard');
    assert.equal(fromConfig.tier, 'deep');
    assert.equal(fromConfig.aliased, false);
    // 装配旧 mode 值也走别名（channel/tier 显式值压过 mode）
    const legacyConfig = resolveControlState({ mode: 'compat' }, dir, () => {});
    assert.equal(legacyConfig.channel, 'standard');
    assert.equal(legacyConfig.tier, 'deep');
    assert.equal(legacyConfig.aliased, true);
    // 无 env 无 config → 文件值
    delete process.env.STREAM_AGENT_MODE;
    const fromFile = resolveControlState({}, dir);
    assert.equal(fromFile.channel, 'code');
    assert.equal(fromFile.tier, 'deep');
  } finally {
    if (savedChannel === undefined) delete process.env.STREAM_AGENT_CHANNEL; else process.env.STREAM_AGENT_CHANNEL = savedChannel;
    if (savedTier === undefined) delete process.env.STREAM_AGENT_TIER; else process.env.STREAM_AGENT_TIER = savedTier;
    if (savedMode === undefined) delete process.env.STREAM_AGENT_MODE; else process.env.STREAM_AGENT_MODE = savedMode;
  }
});

test('坏文件 fail-open：坏 JSON 回默认并告警；未知轴值忽略', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-cs4-'));
  writeFileSync(controlFileOf(dir), '{oops', 'utf8');
  const warnings: string[] = [];
  const read = readPersistedControl(dir, (m) => warnings.push(m));
  assert.equal(read.found, false);
  assert.equal(read.state.channel, 'standard');
  assert.ok(warnings.length >= 1);
  writeFileSync(controlFileOf(dir), JSON.stringify({ channel: 'nope', tier: 'nope', lang: 'fr' }), 'utf8');
  const bad = readPersistedControl(dir);
  assert.equal(bad.state.channel, 'standard');
  assert.equal(bad.state.tier, 'standard');
  assert.equal(bad.state.lang, 'zh');
});

test('STREAM_AGENT_MODE 在无落盘文件（全新安装）时同样走别名映射，不静默忽略', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-cs5-')); // 不写 control.json
  const savedMode = process.env.STREAM_AGENT_MODE;
  const savedChannel = process.env.STREAM_AGENT_CHANNEL;
  const savedTier = process.env.STREAM_AGENT_TIER;
  try {
    delete process.env.STREAM_AGENT_CHANNEL;
    delete process.env.STREAM_AGENT_TIER;
    process.env.STREAM_AGENT_MODE = 'lean';
    const warnings: string[] = [];
    const resolved = resolveControlState({}, dir, (m) => warnings.push(m));
    assert.equal(resolved.channel, 'standard');
    assert.equal(resolved.tier, 'light');
    assert.equal(resolved.aliased, true);
    assert.equal(resolved.channelSource, 'env');
    assert.equal(resolved.tierSource, 'env');
    assert.ok(warnings.some((w) => w.includes('STREAM_AGENT_MODE') && w.includes('lean')), warnings.join('\n'));
    // 显式 STREAM_AGENT_CHANNEL 仍压过旧 mode 值
    process.env.STREAM_AGENT_CHANNEL = 'code';
    const resolved2 = resolveControlState({}, dir);
    assert.equal(resolved2.channel, 'code');
    assert.equal(resolved2.tier, 'standard');
    assert.equal(resolved2.aliased, false);
  } finally {
    if (savedMode === undefined) delete process.env.STREAM_AGENT_MODE; else process.env.STREAM_AGENT_MODE = savedMode;
    if (savedChannel === undefined) delete process.env.STREAM_AGENT_CHANNEL; else process.env.STREAM_AGENT_CHANNEL = savedChannel;
    if (savedTier === undefined) delete process.env.STREAM_AGENT_TIER; else process.env.STREAM_AGENT_TIER = savedTier;
  }
});

// ---------------------------------------------------------------- CLI 拆键

test('splitKeys：方向键三字节成组（不拆散）', () => {
  assert.deepEqual(splitKeys('a\x1b[Bb'), ['a', '\x1b[B', 'b']);
  assert.deepEqual(splitKeys('\x1b[A'), ['\x1b[A']);
});

test('truncate / wrapText：宽度截断与折行纪律', () => {
  assert.equal(truncate('abcdef', 4), 'a...');
  assert.equal(displayWidth('中'), 2);
  const lines = wrapText('一二三四五 six seven', 8);
  assert.ok(lines.every((l) => displayWidth(l) <= 8), lines.join('|'));
});

// ---------------------------------------------------------------- 区块 C 用户上限（0.5.3）

test('C1. 面板区块 C：未设上限时显式声明"不限制"，设了则逐项列出生效值', () => {
  const bare = createControlState({ channel: 'standard', tier: 'standard' });
  const lines = renderPanel(bare, { version: '0.0.0-test', columns: 100 }).join('\n');
  assert.ok(lines.includes('③ 用户上限'), '面板必须有区块 C');
  assert.ok(lines.includes('全部未设') && lines.includes('不限制'), `未设时必须写明不限制：${lines.slice(0, 80)}`);
  assert.ok(!/轮数 \d/.test(lines), '未设上限时不得凭空渲染出数字（不预设）');

  assert.equal(limitsSummaryLine(undefined, 'zh'), t('limitsUnsetAll', 'zh'));
  assert.equal(limitsSummaryLine({}, 'en'), t('limitsUnsetAll', 'en'));

  const withLimits = createControlState({ limits: { maxSteps: 40, maxInputTokens: 48_000, codeMaxSubcalls: 8 } });
  const line = limitsSummaryLine(withLimits.limits, 'zh');
  assert.ok(line.includes('maxSteps 40'), line);
  assert.ok(line.includes('48k'), `token 上限按 k 展示：${line}`);
  assert.ok(line.includes('已定义 3'), `必须报已定义项数：${line}`);
  const panelText = renderPanel(withLimits, { version: '0.0.0-test', columns: 100 }).join('\n');
  assert.ok(panelText.includes('maxSteps 40'), '面板必须显示生效值');
});

test('C2. u 键进入上限编辑：键入 key=value → 回车生效并落盘（含 limits）', () => {
  const saved: ControlState[] = [];
  const session = new ControlSession(createControlState({ channel: 'code', tier: 'deep' }), {
    save: (next) => { saved.push(next); return '/tmp/control.json'; },
    columns: () => 100,
    version: '0.0.0-test',
  });
  assert.deepEqual(interpretKey('u'), { kind: 'edit-limits' });
  assert.deepEqual(interpretKey('U'), { kind: 'edit-limits' });

  // 1) 帧里没有任何数字上限
  assert.ok(!session.frame().includes('maxSteps 40'));
  // 2) 按 u 进入编辑，逐字符输入
  assert.equal(session.handle('u').changed, true);
  assert.equal(session.limitsBuffer, '');
  for (const ch of 'maxSteps=40;maxInputTokens=48000') assert.equal(session.handle(ch).changed, true);
  assert.equal(session.limitsBuffer, 'maxSteps=40;maxInputTokens=48000');
  assert.ok(session.frame().includes('上限编辑'), '编辑态必须在帧里可见（含缓冲回显）');
  // 3) 回车生效
  const committed = session.handle('\r');
  assert.equal(committed.changed, true);
  assert.equal(session.limitsBuffer, null, '提交后退出编辑态');
  assert.deepEqual(session.state.limits, { maxSteps: 40, maxInputTokens: 48_000 });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0]!.limits, { maxSteps: 40, maxInputTokens: 48_000 }, '落盘必须带 limits（否则改通道就被抹掉）');
  assert.equal(saved[0]!.channel, 'code', '通道不能被上限编辑带走');
  assert.ok(session.note.includes('已写入上限'));

  // 4) 再编辑一项：合并而不是替换
  session.handle('u');
  for (const ch of 'codeMaxSubcalls=8') session.handle(ch);
  session.handle('\r');
  assert.deepEqual(session.state.limits, { maxSteps: 40, maxInputTokens: 48_000, codeMaxSubcalls: 8 });
});

test('C3. 非法输入不落盘；Esc 取消；reset 清空为"全部不限制"', () => {
  const saved: ControlState[] = [];
  const session = new ControlSession(createControlState({ limits: { maxSteps: 24 } }), {
    save: (next) => { saved.push(next); return '/tmp/control.json'; },
    columns: () => 100,
    version: '0.0.0-test',
  });
  session.handle('u');
  for (const ch of 'nosuchKey=3') session.handle(ch);
  session.handle('\r');
  assert.deepEqual(session.state.limits, { maxSteps: 24 }, '未知键必须被拒，且不得改动已有值');
  assert.equal(saved.length, 0, '被拒的输入不得落盘');
  assert.ok(session.note.includes('未通过校验'), session.note);

  session.handle('u');
  for (const ch of 'maxSteps=-1') session.handle(ch);
  session.handle('\r');
  assert.deepEqual(session.state.limits, { maxSteps: 24 }, '负数被拒');
  assert.equal(saved.length, 0);

  session.handle('u');
  assert.equal(session.handle('\x1b').changed, true);
  assert.equal(session.limitsBuffer, null, 'Esc 退出编辑态');
  assert.deepEqual(session.state.limits, { maxSteps: 24 }, '取消不改值');

  session.handle('u');
  for (const ch of 'reset') session.handle(ch);
  session.handle('\r');
  assert.equal(session.state.limits, undefined, 'reset 后必须完全没有 limits（= 全部不限制）');
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.limits, undefined);

  // reset 键（r）也把上限一起清掉：初始状态 = 一项上限都没有
  const second = new ControlSession(createControlState({ channel: 'code', limits: { maxSteps: 24 } }), {
    save: () => '/tmp/control.json',
    columns: () => 100,
    version: '0.0.0-test',
  });
  second.handle('r');
  assert.equal(second.state.limits, undefined);
  assert.equal(second.state.channel, 'standard');
});
