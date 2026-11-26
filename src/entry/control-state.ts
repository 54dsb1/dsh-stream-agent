// entry/control-state.ts —— 控制栏状态的落盘与解析（0.5.2：channel + tier + lang + limits）
//
// state 只有一个文件：<stateDir>/control.json（默认 ~/.dsh-stream-agent/control.json，
// STREAM_AGENT_STATE_DIR 可改）。内容刻意极小，便于用户手改与排障：
//   { "schema": 4, "channel": "standard", "tier": "standard", "lang": "zh",
//     "limits": { "maxSteps": 40, "maxInputTokens": 48000 },
//     "contextFold": true, "finalCheck": true,
//     "updatedAt": "2026-11-22T13:00:00.000Z" }
//
// 读写纪律：
//   · 读：任何异常（不存在 / 坏 JSON / 未知值）一律 fail-open 回默认值，并给出可选告警。
//     插件装载期不能因为一个"配置文件坏了"而失败——v0.2.0 事故的直接教训。
//   · 旧值迁移（0.5.0 计划书 §4.4）：读到旧字段 `mode`（balanced/lean/compat/power）时按
//     LEGACY_MODE_ALIAS 映射为 (channel, tier)，输出一行 warn；映射在 0.5.x 保留，
//     0.6.0 移除。
//   · limits（0.5.2）：用户自定义行为上限。未出现的键 = 不限制；非法键/值丢弃并告警
//     （绝不静默）；0 = 用户显式选择"不限制"。
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
import { mergeLimits, sanitizeLimitPatch, THINKFLOW_ALIGNED_LIMITS } from '../kernel/limits.ts';
import type { LimitValues } from '../kernel/limits.ts';
import { resolveStateDir } from './json-persistence.ts';

/** 0.5.0：schema 升 2（channel/tier 取代 mode）；0.5.2：schema 升 3（新增 limits）；
 *  0.6.0-beta：schema 升 4（新增 contextFold / finalCheck）；
 *  0.6.0 正式版：schema 升 5（新增 contextRaw / preset）；
 *  0.6.1：行为预设系统移除（preset 字段停写，读取时忽略并告警）。 */
export const CONTROL_SCHEMA = 5;
export const CONTROL_FILE = 'control.json';

export interface PersistedControl {
  schema: number;
  channel: ChannelId;
  tier: TierId;
  lang: Lang;
  /** 用户定义的行为上限（未出现的键 = 不限制） */
  limits?: LimitValues;
  /** 0.6.0：上下文折叠总开关（缺省 = true） */
  contextFold?: boolean;
  /** 0.6.0：流末验收开关（缺省 = true） */
  finalCheck?: boolean;
  /** 0.6.0 正式版：上下文完全不处理（缺省 = false） */
  contextRaw?: boolean;
  /** 旧字段（0.6.1 起废弃）：行为预设标记已随预设系统移除；读取时忽略，写入时不再产生 */
  preset?: string;
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
  /** 0.5.2：上限来源（config/env/file 三层合并后，取"至少一层定义过"的诊断） */
  limitsSource: 'config' | 'env' | 'file' | 'default';
  /** 0.6.0：两个行为开关的来源诊断（0.6.0 复查修复：运行期 applySwitches 会写 'runtime'——
   *  类型联合此前漏了该值，脏值直通展示层；与 channelSource/tierSource/langSource 对齐） */
  contextFoldSource: 'config' | 'env' | 'file' | 'default' | 'runtime';
  finalCheckSource: 'config' | 'env' | 'file' | 'default' | 'runtime';
  /** 0.6.0 正式版：原样开关的来源诊断（'runtime' 为运行期写入值） */
  contextRawSource: 'config' | 'env' | 'file' | 'default' | 'runtime';
  /** true = 值来自旧 mode 字段的别名映射（调用方负责输出 warn；红线 5 不静默） */
  aliased: boolean;
  /** 别名来源（aliased=true 时是旧模式 id） */
  legacyMode?: LegacyModeId;
  file: string;
}

export function controlFileOf(stateDir?: string): string {
  return join(resolveStateDir(stateDir), CONTROL_FILE);
}

/** 0.6.0：布尔开关的宽松解析。只接受明确的 on/off 词；其他值返回 undefined（调用方告警）。 */
export function parseSwitchValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(normalized)) return true;
  if (['off', 'false', '0', 'no'].includes(normalized)) return false;
  return undefined;
}

function readSwitchEnv(name: string, onWarning?: (message: string, detail?: unknown) => void): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const parsed = parseSwitchValue(raw);
  if (parsed === undefined) {
    onWarning?.(`[control] 环境变量 ${name}="${raw}" 不是 on/off，已忽略（可用: on|off|true|false|1|0）`);
  }
  return parsed;
}

/** 读取落盘状态；文件缺失/损坏/字段非法一律回默认（不抛错）。 */
export function readPersistedControl(
  stateDir?: string,
  onWarning?: (message: string, detail?: unknown) => void,
): {
  state: ControlState;
  found: boolean;
  file: string;
  updatedAt?: string;
  aliased: boolean;
  legacyMode?: LegacyModeId;
  limits: LimitValues;
} {
  const file = controlFileOf(stateDir);
  const fallback: ControlState = { channel: DEFAULT_CHANNEL, tier: DEFAULT_TIER, lang: DEFAULT_LANG };
  if (!existsSync(file)) return { state: fallback, found: false, file, aliased: false, limits: {} };
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
        + `（建议改写为 channel/tier 字段）`,
      );
    }
    const sanitized = sanitizeLimitPatch(raw.limits, `control.json:${file}`);
    for (const message of sanitized.warnings) onWarning?.(`[control] ${message}`);
    const contextFold = parseSwitchValue(raw.contextFold);
    if (raw.contextFold !== undefined && contextFold === undefined) {
      onWarning?.(`[control] control.json 的 contextFold=${JSON.stringify(raw.contextFold)} 不是布尔值，已按默认 true 处理`);
    }
    const finalCheck = parseSwitchValue(raw.finalCheck);
    if (raw.finalCheck !== undefined && finalCheck === undefined) {
      onWarning?.(`[control] control.json 的 finalCheck=${JSON.stringify(raw.finalCheck)} 不是布尔值，已按默认 true 处理`);
    }
    const contextRaw = parseSwitchValue(raw.contextRaw);
    if (raw.contextRaw !== undefined && contextRaw === undefined) {
      onWarning?.(`[control] control.json 的 contextRaw=${JSON.stringify(raw.contextRaw)} 不是布尔值，已按默认 false 处理`);
    }
    // 0.6.1：行为预设已移除——旧文件的 preset 标记不再有语义，如实告警后忽略。
    if (raw.preset !== undefined) {
      onWarning?.(`[control] control.json 的 preset=${JSON.stringify(raw.preset)} 来自已移除的行为预设系统（0.6.1），已忽略；上限请直接写 limits`);
    }
    const state: ControlState = {
      channel: channel ?? fallback.channel,
      tier: tier ?? fallback.tier,
      lang: isLang(raw.lang) ? raw.lang : fallback.lang,
      ...(Object.keys(sanitized.values).length === 0 ? {} : { limits: sanitized.values }),
      ...(contextFold === undefined ? {} : { contextFold }),
      ...(finalCheck === undefined ? {} : { finalCheck }),
      ...(contextRaw === undefined ? {} : { contextRaw }),
    };
    return {
      state,
      found: true,
      file,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
      aliased,
      ...(legacyMode === undefined ? {} : { legacyMode }),
      limits: sanitized.values,
    };
  } catch (error) {
    // 坏文件不阻断装载，也不静默：告警后回默认值（下次写入会修复它）
    onWarning?.(`控制栏状态文件不可解析，已回默认通道/档位/语言：${file}`, error);
    return { state: fallback, found: false, file, aliased: false, limits: {} };
  }
}

/** 原子写入（tmp + rename）；返回落盘路径。失败抛错由 CLI 呈现给用户。 */
export function writePersistedControl(state: ControlState, stateDir?: string): string {
  const file = controlFileOf(stateDir);
  mkdirSync(resolveStateDir(stateDir), { recursive: true });
  // 0.6.0：保留未知字段（外部工具/未来版本写入的键不因本插件写回而丢失）。
  const known = new Set(['schema', 'channel', 'tier', 'lang', 'limits', 'contextFold', 'finalCheck', 'contextRaw', 'preset', 'mode', 'updatedAt']);
  const extras: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      for (const [key, value] of Object.entries(raw)) {
        if (!known.has(key)) extras[key] = value;
      }
    } catch {
      // 坏文件不阻断写回；下一次写入修复它。
    }
  }
  // 回滚兼容（§4.4）：保留旧 mode 字段一个 minor——0.4.x 代码读 control.json 不炸。
  const legacy = reverseLegacyMode(state.channel, state.tier);
  const payload: PersistedControl = {
    schema: CONTROL_SCHEMA,
    ...extras,
    channel: state.channel,
    tier: state.tier,
    lang: state.lang,
    ...(state.limits === undefined || Object.keys(state.limits).length === 0 ? {} : { limits: state.limits }),
    contextFold: state.contextFold !== false,
    finalCheck: state.finalCheck !== false,
    contextRaw: state.contextRaw === true,
    ...(legacy === undefined ? {} : { mode: legacy }),
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
  return file;
}

/**
 * 只改写 limits（读-合并-写），保留 channel/tier/lang 与非本函数负责的字段。
 * CLI `dsh-stream-agent limits --set ...` 与桌面控制页共用。
 */
export function updatePersistedLimits(
  patch: LimitValues,
  options: { stateDir?: string; replace?: boolean } = {},
  onWarning?: (message: string, detail?: unknown) => void,
): { file: string; limits: LimitValues } {
  const current = readPersistedControl(options.stateDir, onWarning);
  const base = options.replace === true ? {} : current.limits;
  const limits = mergeLimits(base, patch);
  // 0.6.1（与 limits.ts 契约对齐）：手工修改上限 = 用户自定义，覆盖 thinkflow 对齐默认层。
  const file = writePersistedControl({ ...current.state, limits }, options.stateDir);
  return { file, limits };
}

/**
 * 解析生效状态：显式 config → 环境变量 → 落盘 → 默认。
 *
 * 装配里写旧模式值（mode: 'lean'）也走别名映射（aliased=true，调用方 warn）；
 * 新轴字段（channel/tier）永远压过旧 mode 字段。
 *
 * limits（0.6.1）四层合并：thinkflow 对齐默认层 → 落盘 → 环境变量 → 显式 config.limits。
 * 默认层来源 = THINKFLOW_ALIGNED_LIMITS（kernel/limits.ts；无 maxSteps——轮数不设上限）。
 *
 * @param explicit 装配里写死的值（LoopEntryConfig.channel / .tier / .lang / .mode / .limits；undefined = 没写）
 * @param stateDir 状态根目录（与 loop 的 stateDir 配置保持一致）
 */
export function resolveControlState(
  explicit: {
    channel?: string; tier?: string; lang?: string; mode?: string; limits?: unknown;
    contextFold?: unknown; finalCheck?: unknown; contextRaw?: unknown;
    /** 旧装配字段（0.6.1 起无语义）：行为预设已移除，读到即告警 + 忽略（红线 5 不静默） */
    preset?: unknown;
  } = {},
  stateDir?: string,
  onWarning?: (message: string, detail?: unknown) => void,
): ControlStateWithSource {
  const persisted = readPersistedControl(stateDir, onWarning);
  const envChannel = process.env.STREAM_AGENT_CHANNEL;
  const envTier = process.env.STREAM_AGENT_TIER;
  const envLang = process.env.STREAM_AGENT_LANG;
  const envMode = process.env.STREAM_AGENT_MODE;
  const envContextFold = readSwitchEnv('STREAM_AGENT_CONTEXT_FOLD', onWarning);
  const envFinalCheck = readSwitchEnv('STREAM_AGENT_FINAL_CHECK', onWarning);
  const envContextRaw = readSwitchEnv('STREAM_AGENT_CONTEXT_RAW', onWarning);
  // 0.6.1：行为预设系统已移除（STREAM_AGENT_PRESET 环境变量与 config.preset 不再被读取）；
  // 默认数值面 = THINKFLOW_ALIGNED_LIMITS（kernel/limits.ts），用户 limits 逐层覆盖。
  if (explicit.preset !== undefined) {
    onWarning?.(`[control] 装配 config.preset=${JSON.stringify(explicit.preset)} 来自已移除的行为预设系统（0.6.1），已忽略；默认面 = thinkflow 对齐层，上限请写 config.limits`);
  }

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
  // 修复（0.6.0 复查）：旧模式 env 在"无落盘文件"（全新安装，source=default）时同样生效——
  // 此前只在 source==='file' 时映射，fresh install 下 STREAM_AGENT_MODE 被静默忽略
  // （既不映射也不告警，违反红线 5 不静默）。显式 STREAM_AGENT_CHANNEL（source=env）仍压过旧值。
  if ((channelSource === 'file' || channelSource === 'default') && isLegacyModeId(envMode)) {
    const mapped = resolveLegacyMode(envMode);
    channel = mapped.channel;
    aliased = true;
    legacyMode = envMode;
    channelSource = 'env';
    onWarning?.(`[control] 环境变量 STREAM_AGENT_MODE="${envMode}" 是旧模式值，已按别名映射为 channel=${mapped.channel}/tier=${mapped.tier}`);
    if (tierSource === 'file' || tierSource === 'default') {
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
    onWarning?.(`[control] 装配 config.mode="${explicit.mode}" 是旧模式值，已按别名映射为 channel=${mapped.channel}/tier=${mapped.tier}（建议改用 config.channel/config.tier）`);
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

  // —— 0.6.0 行为开关：落盘 → 环境变量 → 装配显式（默认 true）——
  let contextFold = persisted.state.contextFold ?? true;
  let contextFoldSource: ControlStateWithSource['contextFoldSource'] = persisted.state.contextFold === undefined
    ? 'default'
    : 'file';
  if (envContextFold !== undefined) {
    contextFold = envContextFold;
    contextFoldSource = 'env';
  }
  const explicitFold = parseSwitchValue(explicit.contextFold);
  if (explicit.contextFold !== undefined && parseSwitchValue(explicit.contextFold) === undefined) {
    onWarning?.(`[control] 装配 config.contextFold=${JSON.stringify(explicit.contextFold)} 不是 on/off，已按落盘值处理`);
  }
  if (explicitFold !== undefined) {
    contextFold = explicitFold;
    contextFoldSource = 'config';
  }

  let finalCheck = persisted.state.finalCheck ?? true;
  let finalCheckSource: ControlStateWithSource['finalCheckSource'] = persisted.state.finalCheck === undefined
    ? 'default'
    : 'file';
  if (envFinalCheck !== undefined) {
    finalCheck = envFinalCheck;
    finalCheckSource = 'env';
  }
  const explicitFinal = parseSwitchValue(explicit.finalCheck);
  if (explicit.finalCheck !== undefined && parseSwitchValue(explicit.finalCheck) === undefined) {
    onWarning?.(`[control] 装配 config.finalCheck=${JSON.stringify(explicit.finalCheck)} 不是 on/off，已按落盘值处理`);
  }
  if (explicitFinal !== undefined) {
    finalCheck = explicitFinal;
    finalCheckSource = 'config';
  }

  // —— 0.6.0 正式版：上下文原样（默认 false）——
  let contextRaw = persisted.state.contextRaw ?? false;
  let contextRawSource: ControlStateWithSource['contextRawSource'] = persisted.state.contextRaw === undefined
    ? 'default'
    : 'file';
  if (envContextRaw !== undefined) {
    contextRaw = envContextRaw;
    contextRawSource = 'env';
  }
  const explicitRaw = parseSwitchValue(explicit.contextRaw);
  if (explicit.contextRaw !== undefined && parseSwitchValue(explicit.contextRaw) === undefined) {
    onWarning?.(`[control] 装配 config.contextRaw=${JSON.stringify(explicit.contextRaw)} 不是 on/off，已按落盘值处理`);
  }
  if (explicitRaw !== undefined) {
    contextRaw = explicitRaw;
    contextRawSource = 'config';
  }
  // 原样开启时折叠强制关（与驱动器同一口径；状态面不显示"开了但被强制关"的歧义）。
  if (contextRaw) contextFold = false;

  // —— limits：落盘 → 环境变量 → 装配显式（后层覆盖前层；纯用户层）——
  // 0.6.1：THINKFLOW_ALIGNED_LIMITS（thinkflow 对齐默认层）**不进本函数**——control.json
  // 只存用户显式定义的键（默认层随版本更新可传播，不被物化进文件）；默认层的注入点在
  // 驱动器 #limitsFor（loop.ts）与桌面降级视图的 effective 投影。
  const envLimits = sanitizeLimitPatch(process.env.STREAM_AGENT_LIMITS, 'env:STREAM_AGENT_LIMITS');
  const explicitLimits = sanitizeLimitPatch(explicit.limits, 'config.limits');
  for (const message of [...envLimits.warnings, ...explicitLimits.warnings]) onWarning?.(`[control] ${message}`);
  const limits = mergeLimits(persisted.limits, envLimits.values, explicitLimits.values);
  const limitsSource: ControlStateWithSource['limitsSource'] = Object.keys(explicitLimits.values).length > 0
    ? 'config'
    : Object.keys(envLimits.values).length > 0
      ? 'env'
      : Object.keys(persisted.limits).length > 0
        ? 'file'
        : 'default';

  return {
    channel,
    tier,
    lang,
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
    contextFold,
    finalCheck,
    contextRaw,
    channelSource,
    tierSource,
    langSource,
    limitsSource,
    contextFoldSource,
    finalCheckSource,
    contextRawSource,
    aliased,
    ...(legacyMode === undefined ? {} : { legacyMode }),
    file: persisted.file,
  };
}
