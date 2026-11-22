// entry/control-state.ts —— 控制栏状态的落盘与解析（0.5.0：channel + tier + lang）
//
// 状态只有一个文件：<stateDir>/control.json（默认 ~/.dsh-stream-agent/control.json，
// STREAM_AGENT_STATE_DIR 可改）。内容刻意极小，便于用户手改与排障：
//   { "channel": "standard", "tier": "standard", "lang": "zh", "mode": "balanced",
//     "updatedAt": "2026-11-22T13:00:00.000Z", "schema": 2 }
//
// 读写纪律：
//   · 读：任何异常（不存在 / 坏 JSON / 未知值）一律 fail-open 回默认值，并给出可选告警。
//     插件装载期不能因为一个"配置文件坏了"而失败——v0.2.0 事故的直接教训。
//   · 旧值迁移（0.5.0 计划书 §4.4）：读到旧字段 `mode`（balanced/lean/compat/power）时按
//     LEGACY_MODE_ALIAS 映射为 (channel, tier)，输出一行 warn；映射在 0.5.x 保留，
//     0.6.0 移除。
//   · 写：先写临时文件再 rename（原子替换）；同时写 `mode` 反向别名一个 minor 供回滚
//     （升级到 0.5.0 后回滚到 0.4.x，control.json 仍可被旧代码读取）。
//   · 优先级（高 → 低）：装配显式 config > 环境变量 > control.json > 内置默认。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LANG, isLang } from '../kernel/control-bar.ts';
import type { ControlState, Lang } from '../kernel/control-bar.ts';
import {
  DEFAULT_CHANNEL,
  DEFAULT_TIER,
  isChannelId,
  isLegacyModeId,
  isTierId,
  LEGACY_MODE_ALIAS,
  reverseLegacyMode,
  resolveLegacyMode,
} from '../kernel/modes.ts';
import type { ChannelId, LegacyModeId, TierId } from '../kernel/modes.ts';
import { resolveStateDir } from './json-persistence.ts';

/** 0.5.0：schema 升 2（channel/tier 取代 mode）。 */
export const CONTROL_SCHEMA = 2;
export const CONTROL_FILE = 'control.json';

export interface PersistedControl {
  schema: number;
  channel: ChannelId;
  tier: TierId;
  lang: Lang;
  /** 旧字段（回滚兼容；0.6.0 移除）：写入时按 reverseLegacyMode 回填，读取时只作别名来源 */
  mode?: LegacyModeId;
  updatedAt: string;
}

export interface ControlStateWithSource extends ControlState {
  /** 值从哪来：排障时一眼看出"为什么是这个通道/档位"（runtime = 本次进程内改过但没落盘） */
  channelSource: 'config' | 'env' | 'file' | 'default' | 'runtime';
  tierSource: 'config' | 'env' | 'file' | 'default' | 'runtime';
  /** 语言同源诊断（桌面控制页据此判断"能不能在界面里改"） */
  langSource: 'config' | 'env' | 'file' | 'default' | 'runtime';
  /** true = 值来自旧 mode 字段的别名映射（调用方负责输出 warn；红线 5 不静默） */
  aliased: boolean;
  /** 别名来源（aliased=true 时是旧模式 id） */
  legacyMode?: LegacyModeId;
  file: string;
}

export function controlFileOf(stateDir?: string): string {
  return join(resolveStateDir(stateDir), CONTROL_FILE);
}

/** 读取落盘状态；文件缺失/损坏/字段非法一律回默认（不抛错）。 */
export function readPersistedControl(
  stateDir?: string,
  onWarning?: (message: string, detail?: unknown) => void,
): { state: ControlState; found: boolean; file: string; updatedAt?: string; aliased: boolean; legacyMode?: LegacyModeId } {
  const file = controlFileOf(stateDir);
  const fallback: ControlState = { channel: DEFAULT_CHANNEL, tier: DEFAULT_TIER, lang: DEFAULT_LANG };
  if (!existsSync(file)) return { state: fallback, found: false, file, aliased: false };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedControl>;
    let channel: ChannelId | undefined = isChannelId(raw.channel) ? raw.channel : undefined;
    let tier: TierId | undefined = isTierId(raw.tier) ? raw.tier : undefined;
    let aliased = false;
    let legacyMode: LegacyModeId | undefined;
    // 旧字段迁移（§4.4）：channel/tier 缺位而 mode 在位 → 别名映射 + warn（不静默）。
    // 只在轴字段缺位时映射——显式写的新轴值永远压过旧字段。
    if ((channel === undefined || tier === undefined) && isLegacyModeId(raw.mode)) {
      const mapped = LEGACY_MODE_ALIAS[raw.mode];
      legacyMode = raw.mode;
      aliased = true;
      if (channel === undefined) channel = mapped.channel;
      if (tier === undefined) tier = mapped.tier;
      onWarning?.(
        `[control] control.json 使用旧模式字段 mode="${raw.mode}"，已按别名映射为 channel=${channel}/tier=${tier}`
        + `（0.5.x 保留别名，0.6.0 移除；建议改写为 channel/tier 字段）`,
      );
    }
    const state: ControlState = {
      channel: channel ?? fallback.channel,
      tier: tier ?? fallback.tier,
      lang: isLang(raw.lang) ? raw.lang : fallback.lang,
    };
    return {
      state,
      found: true,
      file,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
      aliased,
      ...(legacyMode === undefined ? {} : { legacyMode }),
    };
  } catch (error) {
    // 坏文件不阻断装载，也不静默：告警后回默认值（下次写入会修复它）
    onWarning?.(`控制栏状态文件不可解析，已回默认通道/档位/语言：${file}`, error);
    return { state: fallback, found: false, file, aliased: false };
  }
}

/** 原子写入（tmp + rename）；返回落盘路径。失败抛错由 CLI 呈现给用户。 */
export function writePersistedControl(state: ControlState, stateDir?: string): string {
  const file = controlFileOf(stateDir);
  mkdirSync(resolveStateDir(stateDir), { recursive: true });
  // 回滚兼容（§4.4）：保留旧 mode 字段一个 minor——0.4.x 代码读 control.json 不炸。
  const legacy = reverseLegacyMode(state.channel, state.tier);
  const payload: PersistedControl = {
    schema: CONTROL_SCHEMA,
    channel: state.channel,
    tier: state.tier,
    lang: state.lang,
    ...(legacy === undefined ? {} : { mode: legacy }),
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return file;
}

/**
 * 解析生效状态：显式 config → 环境变量 → 落盘 → 默认。
 *
 * 装配里写旧模式值（mode: 'lean'）也走别名映射（aliased=true，调用方 warn）；
 * 新轴字段（channel/tier）永远压过旧 mode 字段。
 *
 * @param explicit 装配里写死的值（LoopEntryConfig.channel / .tier / .lang / .mode；undefined = 没写）
 * @param stateDir 状态根目录（与 loop 的 stateDir 配置保持一致）
 */
export function resolveControlState(
  explicit: { channel?: string; tier?: string; lang?: string; mode?: string } = {},
  stateDir?: string,
  onWarning?: (message: string, detail?: unknown) => void,
): ControlStateWithSource {
  const persisted = readPersistedControl(stateDir, onWarning);
  const envChannel = process.env.STREAM_AGENT_CHANNEL;
  const envTier = process.env.STREAM_AGENT_TIER;
  const envLang = process.env.STREAM_AGENT_LANG;
  const envMode = process.env.STREAM_AGENT_MODE;

  // —— 落盘值为基线（含旧字段别名迁移）——
  let channel = persisted.state.channel;
  let tier = persisted.state.tier;
  let aliased = persisted.aliased;
  let legacyMode = persisted.legacyMode;
  let channelSource: ControlStateWithSource['channelSource'] = persisted.found ? 'file' : 'default';
  let tierSource: ControlStateWithSource['tierSource'] = persisted.found ? 'file' : 'default';

  // —— 环境变量（旧 STREAM_AGENT_MODE 走别名；新轴变量优先）——
  if (isChannelId(envChannel)) {
    channel = envChannel;
    channelSource = 'env';
  }
  if (isTierId(envTier)) {
    tier = envTier;
    tierSource = 'env';
  }
  if (channelSource === 'file' && isLegacyModeId(envMode)) {
    const mapped = resolveLegacyMode(envMode);
    channel = mapped.channel;
    aliased = true;
    legacyMode = envMode;
    channelSource = 'env';
    onWarning?.(`[control] 环境变量 STREAM_AGENT_MODE="${envMode}" 是旧模式值，已按别名映射为 channel=${mapped.channel}/tier=${mapped.tier}（0.6.0 移除）`);
    if (tierSource === 'file') {
      tier = mapped.tier;
      tierSource = 'env';
    }
  }

  // —— 装配显式 config（永远最高；旧 mode 值同样走别名）——
  if (isLegacyModeId(explicit.mode) && !isChannelId(explicit.channel)) {
    const mapped = resolveLegacyMode(explicit.mode);
    channel = mapped.channel;
    aliased = true;
    legacyMode = explicit.mode;
    channelSource = 'config';
    onWarning?.(`[control] 装配 config.mode="${explicit.mode}" 是旧模式值，已按别名映射为 channel=${mapped.channel}/tier=${mapped.tier}（0.5.x 保留别名，0.6.0 移除；建议改用 config.channel/config.tier）`);
    if (tierSource !== 'config' && !isTierId(explicit.tier)) {
      tier = mapped.tier;
      tierSource = 'config';
    }
  }
  if (isChannelId(explicit.channel)) {
    channel = explicit.channel;
    channelSource = 'config';
  }
  if (isTierId(explicit.tier)) {
    tier = explicit.tier;
    tierSource = 'config';
  }

  let lang = persisted.state.lang;
  let langSource: ControlStateWithSource['langSource'] = persisted.found ? 'file' : 'default';
  if (isLang(envLang)) {
    lang = envLang;
    langSource = 'env';
  }
  if (isLang(explicit.lang)) {
    lang = explicit.lang;
    langSource = 'config';
  }

  return {
    channel,
    tier,
    lang,
    channelSource,
    tierSource,
    langSource,
    aliased,
    ...(legacyMode === undefined ? {} : { legacyMode }),
    file: persisted.file,
  };
}
