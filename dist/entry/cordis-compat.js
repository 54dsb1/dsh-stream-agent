// entry/cordis-compat.ts —— Cordis 4.x 适配纪律（v0.2.1 修复：桌面端整层接管未激活）
//
// 事故（v0.2.0，dsh 桌面 profile 实测）：
//   warning: 1 entry did not activate stream-agent
//   cannot get property "ptcRuntime" without inject
//
// 两个独立的装载期缺陷叠在同一条路径上，第一个先炸、第二个被掩盖：
//
// 【缺陷 1｜属性裸读】Cordis 4.x 的 context 是 Proxy，get trap
// （cordis/lib/index.js:1251-1280）对「未在 inject 里声明的服务」做**裸属性读取**会直接抛：
//   `cannot get property "<name>" without inject`
// v0.2.0 的 loop entry 写的是
//   (ctx as { ptcRuntime?: unknown }).ptcRuntime ?? ctx.get?.('ptcRuntime')
// ——`??` 左侧先求值，属性读取先抛，右侧的 ctx.get 兜底永远到不了。ptcRuntime 是
// *可选* 服务（宿主不挂 PTC 时不存在），于是 apply() 在装载期抛错。
//
// 【缺陷 2｜effect 契约】同一个 apply 末尾 `return { factory, dispose }`。Cordis 的函数式
// 插件把**返回值当作 effect 收集**（cordis/lib/index.js:431-459 `_execute`）：
// 只有 function / null / thenable / iterator 合法，返回普通对象直接
// `TypeError: Invalid effect`（:460）。五个 entry 全都返回句柄对象，因此即使修好缺陷 1，
// 每个 entry 仍会失败——只是报错换成 "Invalid effect"，更难定位。
//
// 后果（两者相同）：fiber 进入 failed 态（state 3）→ apply 里的注册被回滚 →
// agent factory 没有注册 → bundle 里内建 agent-loop 已被停用 →
// 该 profile 里一个 agent 都创建不出来（插件"装了但完全不能用"）。
//
// 纪律（本文件即唯一出口）：
//   1. 可选服务只走 ctx.get(name)（reflect.get 明确无 inject 要求，
//      cordis/lib/index.js:1329-1349 的注释原文："Read a service from the store
//      without the inject requirement"）。
//   2. 兼容非 Cordis 的测试桩：桩对象把服务直接挂在 ctx 上，因此 ctx.get 未命中时
//      再试一次属性读取——但**必须**包在 try/catch 里，让 inject 守卫的抛错降级为
//      "服务不存在"，而不是毁掉整个 entry 的装载。
//   3. 绝不把可选服务写进 inject 数组：数组形式在 Cordis 里是「必需」，服务缺席时
//      fiber 会永远 pending（装载被挂起），比抛错更难排查。
//   4. entry 的返回值必须是**函数**（disposer）：句柄对象经 asPluginEffect() 包一层，
//      属性全部挂在函数上，测试与调用方照旧读 handle.xxx，Cordis 侧拿到的是合法 effect。

/** 探测所需的最小 context 面（Cordis 与测试桩的公共子集）。 */
                                  
                                 
 

/**
 * 读取一个可选服务；不存在、不可用或触发 inject 守卫时一律返回 undefined。
 *
 * @param ctx  宿主 context（Cordis Proxy 或测试桩）
 * @param name 服务名（如 'ptcRuntime' / 'sessionProjections' / 'loader'）
 */
export function getService   (ctx         , name        )                {
  const probe = ctx                               ;
  if (probe === undefined || probe === null) return undefined;
  // ① 正路：reflect.get，不需要 inject
  try {
    const value = probe.get?.(name);
    if (value !== undefined && value !== null) return value     ;
  } catch {
    // ctx.get 在极端桩上也可能抛：按缺失处理，继续 ②
  }
  // ② 兼容路：测试桩把服务挂在 ctx 上；Cordis 下这一步会被 inject 守卫拦下 →
  //    catch 掉，语义仍是"服务不存在"（绝不让它冒泡毁掉 entry）
  try {
    const value = (ctx                           )[name];
    if (value !== undefined && value !== null) return value     ;
  } catch {
    return undefined;
  }
  return undefined;
}

/** 服务存在且具备指定方法（鸭子类型校验，避免"服务在但形状不对"炸在半路）。 */
export function hasMethod(service         , method        )          {
  return service !== null && typeof service === 'object'
    && typeof (service                           )[method] === 'function';
}

/**
 * 把 entry 的句柄对象包成 Cordis 合法的 effect（返回函数 = disposer）。
 *
 * Cordis 的函数式插件契约：返回值只能是 function / null / thenable / iterator
 * （cordis/lib/index.js:431-459），普通对象会被判为 `Invalid effect` 并让 fiber 失败。
 * 本包五个 entry 都返回句柄对象（测试与调用方按对象读取），因此统一经此包装：
 * 函数本体负责卸载（调用句柄上的 dispose），句柄的全部属性照旧可直接读。
 *
 * @example
 *   const handle = { service, dispose };
 *   return asPluginEffect(handle);   // typeof 返回值 === 'function'
 */
export function asPluginEffect                  (handle   )                   {
  const disposer = ()       => {
    const dispose = (handle                         ).dispose;
    if (typeof dispose === 'function') (dispose              )();
  };
  return Object.assign(disposer, handle)                    ;
}
