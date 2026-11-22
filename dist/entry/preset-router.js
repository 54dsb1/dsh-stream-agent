/**
 * src/entry/preset-router.ts —— v0.4.0 模式切换（P4/G3）：agent preset 三向切换的唯一入口
 *
 * 设计：upgrade-plan/v0.4.0-stream-mode-design.md §7.3/§8。
 * 语义（宿主事实，rc.3 取证 dsh-agent-preset-registry/lib/index.js:766-775）：
 *   - 空白会话（lastTurn === 0 且无 open turn）可切：standard ↔ ptc ↔ stream；
 *   - 已开回合切换抛 RemoteError('agent-preset/locked')——**本模块不自行判断**、
 *     不 catch 包装：以宿主返回的错误为准（自己判空会和宿主语义漂移）；
 *   - 切换成功后宿主追加 `agent-preset/selected` 事件（投影到桌面会话页）。
 *
 * 暴露面：控制页（ui/）与 CLI 只提供两种态——"新建并选择"与"当前会话不可切"，
 * 不给已开始的会话一个必然失败的入口（§8.2）。
 */

/** 宿主 agentPresets 服务的 duck-type 面（dsh-agent-preset-registry rc.3）。 */
                                          
                                          
                                                                                                               
                                                
                                                               
                                      
                                                     
                          
                     
 

                                   
             
                
                       
                 
                                      
                  
 

                               
                                                      
                                               
                                                                          
                                                      
                                                                 
                                           
                                                              
                              
 

/** 从宿主 ctx 构造 PresetRouter；服务缺席（headless/旧宿主）返回 undefined——调用方按"无切换面"处理。 */
export function createPresetRouter(ctx         )                           {
  const get = (ctx                                                  )?.get;
  if (typeof get !== 'function') return undefined;
  let service                                     ;
  try {
    service = get('agentPresets')                                       ;
  } catch {
    return undefined; // cordis 未 inject 的裸读会抛——切换面缺席，不静默也不炸
  }
  if (service === undefined || typeof service.list !== 'function' || typeof service.select !== 'function') {
    return undefined;
  }
  return {
    async list()                                       {
      const raw = await service.list();
      return raw.map((d) => ({
        id: d.id,
        ...(d.name === undefined ? {} : { name: d.name }),
        ...(d.description === undefined ? {} : { description: d.description }),
        ...(d.order === undefined ? {} : { order: d.order }),
        ...(d.broken === undefined ? {} : { broken: d.broken }),
      }));
    },
    async select(agent         , id        )                  {
      // 不 try/catch：agent-preset/locked 必须原样上抛（G3 的具名失败用例依赖错误形状）
      return service.select(agent, id);
    },
    current(session         )                {
      if (typeof service.presetForSession !== 'function') return null;
      try {
        return service.presetForSession(session) ?? null;
      } catch {
        return null;
      }
    },
    get defaultId()                     {
      return service.defaultId;
    },
  };
}

/** locked 错误的具名识别（不包装、只识别——控制页据此渲染"当前会话不可切"态）。 */
export function isPresetLockedError(error         )          {
  return typeof error === 'object' && error !== null
    && (error                      ).code === 'agent-preset/locked';
}
