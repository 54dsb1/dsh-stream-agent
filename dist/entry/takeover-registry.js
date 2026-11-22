// entry/takeover-registry.ts —— 接管状态的最小进程内登记（0.5.0：增 owner 字段）
//
// 为什么需要：控制栏要在装载横幅上如实写"接管生效 / 未接管"。接管发生在 loop entry 的
// setFactory 成功之后，而 bundle 的装载顺序是 sidecar → loop → control-bar；两个 entry
// 之间没有服务依赖（控制栏注入空数组，不能为了读状态把 loop 变成硬依赖）。
// 于是用同进程的模块级单例做登记：同一份 bundle 内 ESM 只求值一次，读到的是实时事实，
// 不引入任何 cordis 依赖，也不会跨进程泄漏。
//
// 语义边界：
//   · markTakeover —— loop.apply 里 setFactory 成功之后调用（owner = 接管者标识）；
//   · markDegrade —— takeoverOnConflict:'degrade' 且 setFactory 抛错时调用（侧挂模式：
//     只提供控制栏状态与诊断，上下文治理全部关闭，§6.2）；
//   · clearTakeover —— factory 卸载（dispose）时调用，控制栏随即显示"未接管"；
//   · isTakeoverActive —— 只表示"本进程内工厂已注册"，不表示"任务正在跑"。
//
// 0.5.0（§6.2）：owner 字段记录接管者/让位对象，控制栏显示"接管生效"或
// "未接管：已被 <X> 接管"——冲突必须可见（兼容矩阵：无静默覆盖）。

                               
                  
                                                       
               
             
                                                  
                
                                                                        
                               
 

const state               = { active: false, mode: '', at: '', owner: '', state: 'active' };
let listeners                    = [];

function notify()       {
  const pending = listeners;
  listeners = [];
  for (const listener of pending) listener();
}

export function markTakeover(mode        , owner = 'stream-agent')       {
  state.active = true;
  state.mode = mode;
  state.at = new Date().toISOString();
  state.owner = owner;
  state.state = 'active';
  // 一次性通知：控制栏据此打印"接管生效"横幅（与装载先后无关，不靠定时器猜时序）
  notify();
}

/** degrade 侧挂登记（§6.2）：不接管 loop，只留控制栏状态与诊断；owner = 占位者。 */
export function markDegrade(owner        )       {
  state.active = false;
  state.mode = 'sidecar';
  state.at = new Date().toISOString();
  state.owner = owner;
  state.state = 'degraded';
  notify();
}

export function clearTakeover()       {
  state.active = false;
  state.mode = '';
  state.at = '';
  state.owner = '';
  state.state = 'active';
}

/**
 * 订阅"接管成立"这一刻：已接管/已降级则立即回调，否则等 markTakeover/markDegrade。
 * 返回退订函数（entry 卸载时调用，避免悬挂回调）。
 */
export function onTakeover(listener            )             {
  if (state.active || state.state === 'degraded') {
    listener();
    return () => {};
  }
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((item) => item !== listener);
  };
}

export function takeover()               {
  return { ...state };
}

export function isTakeoverActive()          {
  return state.active;
}
