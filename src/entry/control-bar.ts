// entry/control-bar.ts —— 控制栏 entry（0.5.0：两区块）
//
// 三件事，全部 fail-open：
//   ① 装载时把控制栏打到 stderr：接管状态 + 当前通道/档位 + 上手四步 + 打开方式。
//      bundle 激活对 CLI 是静默的（v0.2.0 的教训：用户只看到一条 warning），
//      控制栏是插件"自证已装载 + 教怎么用"的唯一直观出口。
//   ② 提供 ctx.streamAgentControl 服务：其它 entry / 诊断脚本可读当前通道/档位与语言。
//   ③ 状态与 loop 共用同一份 control.json（control-state.ts），改通道/档位不需要重启。
//
// 红线：本 entry 不得因为"配置坏了"而装载失败。resolveControlState 全程 fail-open，
// 告警走 logger/stderr，绝不上抛（v0.2.1 事故链见 cordis-compat.ts）。

import { createControlState, renderBanner, renderStatusBar } from '../kernel/control-bar.ts';
import type { ControlState, Lang } from '../kernel/control-bar.ts';
import { getChannel, getTier, isChannelId, isLegacyModeId, isTierId, resolveLegacyMode } from '../kernel/modes.ts';
import type { ChannelId, TierId } from '../kernel/modes.ts';
import { VERSION } from '../version.ts';
import { asPluginEffect } from './cordis-compat.ts';
import type { HostCtxLike } from './adapter-kit.ts';
import { resolveControlState, writePersistedControl } from './control-state.ts';
import { isTakeoverActive, takeover, onTakeover } from './takeover-registry.ts';

export interface ControlBarConfig {
  /** 装配里写死的执行通道（优先于 control.json 与环境变量；一般留空交给控制栏） */
  channel?: string;
  /** 装配里写死的上下文档位（同上） */
  tier?: string;
  /** 旧模式值（0.5.x 别名；0.6.0 移除）——按 LEGACY_MODE_ALIAS 映射后作为 channel/tier 缺省 */
  mode?: string;
  /** 装配里写死的界面语言：zh | en */
  lang?: string;
  /** 打印装载横幅（默认 true；patch 里显式 false 可静音） */
  announce?: boolean;
  /** 状态根目录（与 loop 的 stateDir 保持一致；缺省 STREAM_AGENT_STATE_DIR → ~/.dsh-stream-agent） */
  stateDir?: string;
  /** 覆盖版本号（测试用；生产缺省 VERSION） */
  version?: string;
}

export interface ControlBarService {
  state(): ControlState;
  channel(): ReturnType<typeof getChannel>;
  tier(): ReturnType<typeof getTier>;
  setChannel(channel: ChannelId, persist?: boolean): ControlState;
  setTier(tier: TierId, persist?: boolean): ControlState;
  /** 0.5.x 别名（0.6.0 移除）：旧模式值 → (channel, tier) 两路应用 */
  setMode(mode: string, persist?: boolean): ControlState;
  setLang(lang: Lang, persist?: boolean): ControlState;
  statusLine(active?: boolean): string;
  active(): boolean;
  file: string;
}

export const name = 'stream-agent-control-bar';
export const inject: string[] = [];

export default function apply(ctx: HostCtxLike, config: ControlBarConfig = {}): ControlBarService & (() => void) {
  const version = config.version ?? VERSION;
  const warn = (message: string, detail?: unknown): void => {
    const logger = (ctx.get?.('logger') ?? null) as { warn?(m: string): void } | null;
    const text = `[control-bar] ${message}${detail === undefined ? '' : ` :: ${String(detail)}`}`;
    if (logger?.warn !== undefined) logger.warn(text);
    else console.error(text);
  };

  const resolved = resolveControlState(
    { channel: config.channel, tier: config.tier, lang: config.lang, mode: config.mode },
    config.stateDir,
    warn,
  );
  if (resolved.aliased) {
    // §4.4：旧配置读到旧 mode 字段时输出一行 warn（resolveControlState 已对 control.json
    // 来源告警；这里补装配显式 config.mode 的告警面）。
    warn(`control-bar 收到旧模式值 mode="${config.mode}"，已按别名映射为 channel=${resolved.channel}/tier=${resolved.tier}（0.5.x 保留别名，0.6.0 移除）`);
  }
  let state: ControlState = createControlState({ channel: resolved.channel, tier: resolved.tier, lang: resolved.lang });
  const file = resolved.file;

  const persist = (): void => {
    try {
      writePersistedControl(state, config.stateDir);
    } catch (error) {
      warn(`控制栏状态写入失败（本次运行内仍然生效）：${file}`, error);
    }
  };

  const service: ControlBarService = {
    state: () => ({ ...state }),
    channel: () => getChannel(state.channel),
    tier: () => getTier(state.tier),
    setChannel: (channel, shouldPersist = true) => {
      state = { ...state, channel: getChannel(channel).id };
      if (shouldPersist) persist();
      return { ...state };
    },
    setTier: (tier, shouldPersist = true) => {
      state = { ...state, tier: getTier(tier).id };
      if (shouldPersist) persist();
      return { ...state };
    },
    setMode: (mode, shouldPersist = true) => {
      if (!isLegacyModeId(mode)) {
        warn(`setMode("${String(mode)}") 不是旧模式值（可用: balanced|lean|compat|power）`);
        return { ...state };
      }
      const mapped = resolveLegacyMode(mode);
      warn(`setMode("${mode}") 是旧模式值，已按别名映射为 channel=${mapped.channel}/tier=${mapped.tier}（0.5.x 保留别名，0.6.0 移除）`);
      state = { ...state, channel: mapped.channel, tier: mapped.tier };
      if (shouldPersist) persist();
      return { ...state };
    },
    setLang: (lang, shouldPersist = true) => {
      state = { ...state, lang: lang === 'en' ? 'en' : 'zh' };
      if (shouldPersist) persist();
      return { ...state };
    },
    statusLine: (active) => renderStatusBar(state, {
      version,
      ...(active === undefined ? { active: isTakeoverActive() } : { active }),
      columns: process.stderr.columns,
    }),
    active: () => isTakeoverActive(),
    file,
  };

  // 横幅时机（不靠定时器猜）：控制栏排在 loop 之前挂载，因此先订阅"接管成立"事件；
  // 若 loop 已经接管（控制栏后挂载的组合），onTakeover 会立即回调。
  // 兜底：若 1.5s 内没有任何接管（bundle 只挂了一半），打印一次"未接管"，便于定位。
  let printed = false;
  const printBanner = (): void => {
    if (printed) return;
    printed = true;
    const fact = takeover();
    const active = isTakeoverActive();
    for (const line of renderBanner(state, { version, active, columns: process.stderr.columns })) console.error(line);
    // 0.5.0（§6.2）：降级（sidecar）必须可见——占位者具名显示，绝不静默覆盖。
    if (fact.state === 'degraded') {
      console.error(`[control-bar] 未接管：已被 ${fact.owner || '另一个 loop 插件'} 接管——本插件转 sidecar（仅控制栏状态与诊断，上下文治理关闭）`);
    }
  };
  const announce = config.announce !== false && process.env.STREAM_AGENT_NO_BANNER !== '1';
  const offTakeover = announce ? onTakeover(printBanner) : () => {};
  const fallbackTimer = announce
    ? setTimeout(printBanner, 1500)
    : undefined;
  fallbackTimer?.unref?.();

  // 服务提供是可选能力：宿主没有 provide（或已被占用）时只告警，不影响装载。
  try {
    if (typeof ctx.provide === 'function') ctx.provide('streamAgentControl', service);
  } catch (error) {
    warn('ctx.provide(streamAgentControl) 失败（其余功能不受影响）', error);
  }

  return asPluginEffect({
    ...service,
    dispose: () => {
      offTakeover();
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    },
  });
}

// isChannelId / isTierId 保留在导入面（ControlBarConfig 的运行时校验由 resolveControlState
// 完成；这里显式引用避免未用告警，同时给 CLI 复用）。
export { isChannelId, isTierId };
