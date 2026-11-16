// entry/ptc-bridge.ts —— PTC 桥接（tf-code 执行通道，0.2.0）
//
// 把宿主 PTC runtime（@deepseek-ai/dsh-ptc-runtime 0.1.6-alpha.1，ctx.ptcRuntime 服务缝）
// 收编为单流协议的一个执行通道：模型在流里写 <tf-code> 程序（可擦除 TS 的 async 函数体），
// 驱动器闭合即派发到 runtime 沙箱执行，返回值/日志句柄化进 obs 账本——中间结果不进上下文。
//
// 宿主依赖全部 duck-type（红线：零 @deepseek-ai 静态 import），形状以官方 README 为锚：
//   const spec = ctx.ptcRuntime.resolve({ program, bindings: [{ global, functions }], timeoutMs? })
//   const result = await ctx.ptcRuntime.run(spec)   // result.value / result.logs / result.error
// 程序失败 resolve 在 result.error（kind: exception/timeout/abort/worker-exit/invalid-output/
// output-limit/protocol/sandbox-unavailable）；run() reject 只表示调用方误用。
//
// 安全面：程序本身不做任何 IO——唯一的绑定命名空间 tools（write/read/pwsh）走驱动器同一条
// executeTools 通道，宿主 guard/工作区策略/凭据全部生效。runtime 沙箱能力按宿主装配为准。
//
// fail-open（红线 5）：runtime 形状不符 → 通道关闭并告警；命令级失败 → 结构化错误注入，
// 绝不静默。

/** 镜像 dsh-ptc-runtime 的 PtcRuntime 服务面（resolve + run 两段式；timeout 描述符可选）。 */
                                 
                    
                    
                                                                                                                 
                              
                         
                 
              
                                                
                                                 
                    
                                                          
 

/** 镜像 PtcRunResult：无损 JSON 值 / 逐通道日志 / 正交错误 kind。 */
                                   
                  
                 
                                                    
                    
 

/** 最小工具批形状（与 loop.ts 的 ToolBatchInputLike 结构兼容，避免模块环） */
                                 
                                                                                       
                      
                                
                  
 

                                  
                                                                                         
 

/** tf-code 的执行器面（驱动器经 DriverPorts.executeCode 调用）。 */
                                    
                 
                                                 
               
                                      
                     
                      
                                                    
                  
                           

                         
                                                                                   
                                                                 

/** 形状校验：resolve + run 双函数在位才算 PtcRuntime（防止同名服务形状漂移时误接）。 */
export function looksLikePtcRuntime(candidate         )                              {
  if (candidate === null || typeof candidate !== 'object') return false;
  const c = candidate                                        ;
  return typeof c.resolve === 'function' && typeof c.run === 'function';
}

/** logs 通道展平：string 原样 / 数组逐项递归拼接 / 对象 JSON（形状以官方 README 为锚，防御式）。 */
function flattenLogs(logs         , depth = 0)                     {
  if (logs === undefined || logs === null) return undefined;
  if (typeof logs === 'string') return logs === '' ? undefined : logs;
  if (depth >= 3) return JSON.stringify(logs);
  if (Array.isArray(logs)) {
    const parts = logs.map((item) => flattenLogs(item, depth + 1)).filter((s)              => s !== undefined);
    return parts.length === 0 ? undefined : parts.join('\n');
  }
  return JSON.stringify(logs);
}

/** 错误诊断：kind + message（message 字段防御式提取）。 */
function describeRunError(error                                        )         {
  const message = typeof (error                         ).message === 'string' ? (error                       ).message : JSON.stringify(error);
  return `${error.kind}: ${message}`.slice(0, 500);
}

/** 单条工具绑定调用：走宿主同一条 executeTools 通道；isError → 抛（对齐 PTC 的 ToolCallError 语义，
 *  程序内可 try/catch 继续或让程序失败 resolve 到 result.error）。 */
async function runOneBinding(
  deps                                                                                 ,
  name        ,
  args         ,
  callId        ,
  signal             ,
  agent         ,
)                   {
  const result = await deps.executeTools({
    calls: [{ type: 'tool-call', id: `${callId}:ptc:${name}`, name, arguments: JSON.stringify(args ?? {}) }],
    signal,
    maxParallelToolCalls: 1,
    ...(agent === undefined ? {} : { agent }),
  });
  const first = result.results[0];
  const content = first?.result?.content;
  const text = content === undefined || content === null
    ? ''
    : typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((block) => (typeof block === 'object' && block !== null && 'text' in (block                      ) && typeof (block                     ).text === 'string' ? (block                    ).text : JSON.stringify(block))).join('\n')
        : String(content);
  if (first?.result?.isError === true) throw new Error(text === '' ? `${name} failed` : text);
  return text;
}

/**
 * 构造 tf-code 执行器：resolve（校验 + 默认值）→ run（沙箱执行）→ CodeOutcome。
 * 绑定命名空间固定为 tools（write/read/pwsh——与 tf-write/tf-read/tf-bash 同映射），
 * 让程序具备文件与命令能力，且全部走宿主管线。
 */
export function createCodeExecutor(
  runtime                ,
  deps                                                                                 ,
)               {
  return async (input) => {
    const bindings = [
      {
        global: 'tools',
        functions: {
          write: (args         ) => runOneBinding(deps, 'write', args, input.callId, input.signal, input.agent),
          read: (args         ) => runOneBinding(deps, 'read', args, input.callId, input.signal, input.agent),
          pwsh: (args         ) => runOneBinding(deps, 'pwsh', args, input.callId, input.signal, input.agent),
        },
      },
    ];
    let result                  ;
    try {
      const spec = runtime.resolve({
        program: input.code,
        bindings,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        signal: input.signal,
      });
      result = await runtime.run(spec);
    } catch (error) {
      // run() reject = 调用方误用（形状不符/已 dispose 等），如实失败不静默
      return { ok: false, error: `ptc-runtime-misuse: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500) };
    }
    const logs = flattenLogs(result.logs);
    if (result.error !== undefined && result.error !== null) {
      return { ok: false, error: describeRunError(result.error), ...(logs === undefined ? {} : { logs }) };
    }
    // value = 无损 JSON（seam 契约）；undefined 视为程序无返回值
    const valueJson = result.value === undefined ? 'undefined' : JSON.stringify(result.value) ?? 'undefined';
    return { ok: true, valueJson, ...(logs === undefined ? {} : { logs }) };
  };
}
