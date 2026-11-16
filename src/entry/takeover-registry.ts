// entry/takeover-registry.ts —— 接管状态的最小进程内登记（v0.2.1）
//
// 为什么需要：控制栏要在装载横幅上如实写"接管生效 / 未接管"。接管发生在 loop entry 的
// setFactory 成功之后，而 bundle 的装载顺序是 sidecar → loop → control-bar；两个 entry
// 之间没有服务依赖（控制栏注入空数组，不能为了读状态把 loop 变成硬依赖）。
// 于是用同进程的模块级单例做登记：同一份 bundle 内 ESM 只求值一次，读到的是实时事实，
// 不引入任何 cordis 依赖，也不会跨进程泄漏。
//
// 语义边界：
//   · markTakeover —— loop.apply 里 setFactory 成功之后调用；
//   · clearTakeover —— factory 卸载（dispose）时调用，控制栏随即显示"未接管"；
//   · isTakeoverActive —— 只表示"本进程内工厂已注册"，不表示"任务正在跑"。

export interface TakeoverFact {
  active: boolean;
  mode: string;
  at: string;
}

const state: TakeoverFact = { active: false, mode: '', at: '' };
let listeners: Array<() => void> = [];

export function markTakeover(mode: string): void {
  state.active = true;
  state.mode = mode;
  state.at = new Date().toISOString();
  // 一次性通知：控制栏据此打印"接管生效"横幅（与装载先后无关，不靠定时器猜时序）
  const pending = listeners;
  listeners = [];
  for (const listener of pending) listener();
}

export function clearTakeover(): void {
  state.active = false;
  state.mode = '';
  state.at = '';
}

/**
 * 订阅"接管成立"这一刻：已接管则立即回调，否则等 markTakeover。
 * 返回退订函数（entry 卸载时调用，避免悬挂回调）。
 */
export function onTakeover(listener: () => void): () => void {
  if (state.active) {
    listener();
    return () => {};
  }
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((item) => item !== listener);
  };
}

export function takeover(): TakeoverFact {
  return { ...state };
}

export function isTakeoverActive(): boolean {
  return state.active;
}
