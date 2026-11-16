// entry/control-state.ts —— 控制栏状态的落盘与解析（v0.2.1）
//
// 状态只有一个文件：<stateDir>/control.json（默认 ~/.dsh-stream-agent/control.json，
// STREAM_AGENT_STATE_DIR 可改）。内容刻意极小，便于用户手改与排障：
//   { "mode": "balanced", "lang": "zh", "updatedAt": "2026-11-16T13:00:00.000Z", "schema": 1 }
//
// 读写纪律：
//   · 读：任何异常（不存在 / 坏 JSON / 未知模式）一律 fail-open 回默认值，并给出可选告警。
//     插件装载期不能因为一个"配置文件坏了"而失败——这是 v0.2.0 事故的直接教训。
//   · 写：先写临时文件再 rename（原子替换），避免半截文件。
//   · 优先级（高 → 低）：装配显式 config > 环境变量 > control.json > 内置默认。
//     显式配置永远压过控制栏，模式只是"给没写配置的人一个好默认"。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_LANG, isLang } from '../kernel/control-bar.ts';
import type { ControlState, Lang } from '../kernel/control-bar.ts';
import { DEFAULT_MODE, isModeId } from '../kernel/modes.ts';
import type { ModeId } from '../kernel/modes.ts';
import { resolveStateDir } from './json-persistence.ts';

export const CONTROL_SCHEMA = 1;
export const CONTROL_FILE = 'control.json';

export interface PersistedControl {
  schema: number;
  mode: ModeId;
  lang: Lang;
  updatedAt: string;
}

export interface ControlStateWithSource extends ControlState {
  /** 值从哪来：排障时一眼看出"为什么是这个模式"（runtime = 本次进程内改过但没落盘） */
  modeSource: 'config' | 'env' | 'file' | 'default' | 'runtime';
  /** 语言同源诊断（桌面控制页据此判断"能不能在界面里改"） */
  langSource: 'config' | 'env' | 'file' | 'default' | 'runtime';
  file: string;
}

export function controlFileOf(stateDir?: string): string {
  return join(resolveStateDir(stateDir), CONTROL_FILE);
}

/** 读取落盘状态；文件缺失/损坏/字段非法一律回默认（不抛错）。 */
export function readPersistedControl(
  stateDir?: string,
  onWarning?: (message: string, detail?: unknown) => void,
): { state: ControlState; found: boolean; file: string; updatedAt?: string } {
  const file = controlFileOf(stateDir);
  const fallback: ControlState = { mode: DEFAULT_MODE, lang: DEFAULT_LANG };
  if (!existsSync(file)) return { state: fallback, found: false, file };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedControl>;
    const state: ControlState = {
      mode: isModeId(raw.mode) ? raw.mode : fallback.mode,
      lang: isLang(raw.lang) ? raw.lang : fallback.lang,
    };
    return {
      state,
      found: true,
      file,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    };
  } catch (error) {
    // 坏文件不阻断装载，也不静默：告警后回默认值（下次写入会修复它）
    onWarning?.(`控制栏状态文件不可解析，已回默认模式/语言：${file}`, error);
    return { state: fallback, found: false, file };
  }
}

/** 原子写入（tmp + rename）；返回落盘路径。失败抛错由 CLI 呈现给用户。 */
export function writePersistedControl(state: ControlState, stateDir?: string): string {
  const file = controlFileOf(stateDir);
  mkdirSync(resolveStateDir(stateDir), { recursive: true });
  const payload: PersistedControl = {
    schema: CONTROL_SCHEMA,
    mode: state.mode,
    lang: state.lang,
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
 * @param explicit 装配里写死的值（LoopEntryConfig.mode / .lang；undefined 表示没写）
 * @param stateDir 状态根目录（与 loop 的 stateDir 配置保持一致）
 */
export function resolveControlState(
  explicit: { mode?: string; lang?: string } = {},
  stateDir?: string,
  onWarning?: (message: string, detail?: unknown) => void,
): ControlStateWithSource {
  const persisted = readPersistedControl(stateDir, onWarning);
  const envMode = process.env.STREAM_AGENT_MODE;
  const envLang = process.env.STREAM_AGENT_LANG;

  let mode = persisted.state.mode;
  let modeSource: ControlStateWithSource['modeSource'] = persisted.found ? 'file' : 'default';
  if (isModeId(envMode)) {
    mode = envMode;
    modeSource = 'env';
  }
  if (isModeId(explicit.mode)) {
    mode = explicit.mode;
    modeSource = 'config';
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

  return { mode, lang, modeSource, langSource, file: persisted.file };
}
