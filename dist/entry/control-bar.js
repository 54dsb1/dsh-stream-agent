// entry/control-bar.ts —— 控制栏 entry（v0.2.1）
//
// 三件事，全部 fail-open：
//   ① 装载时把控制栏打到 stderr：接管状态 + 当前模式 + 上手四步 + 打开方式。
//      bundle 激活对 CLI 是静默的（v0.2.0 的教训：用户只看到一条 warning），
//      控制栏是插件"自证已装载 + 教怎么用"的唯一直观出口。
//   ② 提供 ctx.streamAgentControl 服务：其它 entry / 诊断脚本可读当前模式与语言。
//   ③ 状态与 loop 共用同一份 control.json（control-state.ts），改模式不需要重启。
//
// 红线：本 entry 不得因为"配置坏了"而装载失败。resolveControlState 全程 fail-open，
// 告警走 logger/stderr，绝不上抛（v0.2.1 事故链见 cordis-compat.ts）。

import { createControlState, renderBanner, renderStatusBar } from '../kernel/control-bar.js';
                                                             
import { getMode } from '../kernel/modes.js';
                                                           
import { VERSION } from '../version.js';
import { asPluginEffect } from './cordis-compat.js';
                                                    
import { resolveControlState, writePersistedControl } from './control-state.js';
import { isTakeoverActive, onTakeover } from './takeover-registry.js';

                                   
                                                   
                
                           
                
                                            
                     
                                                                                      
                    
                                
                   
 

                                    
                        
                   
                                                         
                                                                       
                                       
                    
               
 

export const name = 'stream-agent-control-bar';
export const inject           = [];

export default function apply(ctx             , config                   = {})                                   {
  const version = config.version ?? VERSION;
  const warn = (message        , detail          )       => {
    const logger = (ctx.get?.('logger') ?? null)                                     ;
    const text = `[control-bar] ${message}${detail === undefined ? '' : ` :: ${String(detail)}`}`;
    if (logger?.warn !== undefined) logger.warn(text);
    else console.error(text);
  };

  const resolved = resolveControlState({ mode: config.mode, lang: config.lang }, config.stateDir, warn);
  let state               = createControlState({ mode: resolved.mode, lang: resolved.lang });
  const file = resolved.file;

  const persist = ()       => {
    try {
      writePersistedControl(state, config.stateDir);
    } catch (error) {
      warn(`控制栏状态写入失败（本次运行内仍然生效）：${file}`, error);
    }
  };

  const service                    = {
    state: () => ({ ...state }),
    mode: () => getMode(state.mode),
    setMode: (mode, shouldPersist = true) => {
      state = { ...state, mode: getMode(mode).id };
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
  const printBanner = ()       => {
    if (printed) return;
    printed = true;
    const active = isTakeoverActive();
    for (const line of renderBanner(state, { version, active, columns: process.stderr.columns })) console.error(line);
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
