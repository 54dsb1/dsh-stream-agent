// entry/loop.ts —— 单流协议驱动器（分派 06，全项目核心命题：改地基）
//
// 本文件三层结构，边界即红线：
//   ① 流契约镜像 —— dsh-llm 流词汇的本地镜像（零 @deepseek-ai 静态 import，file:line 见注释）。
//      本地插件 bare import 不走宿主解析（results/01-micro-spike-results.md §0 实测），
//      因此适配层对上游一切依赖都是 duck-typed 注入，类型只做镜像。
//   ② SingleStreamDriver —— 单流协议驱动器（纯异步控制流，零宿主依赖）。
//      状态机：REQUEST → STREAMING（parser 事件循环，命令闭合即 gate.admit 派发）
//      → 流终止 → 等 drain（F8 普通异步等待）→ 收束判定 → FINISH 或 INJECTING。
//      重入条件仅三种：info_gain=high 观测 / need_result（tf-peek）/ 执行失败。
//      成功路径零注入，只写 ledger。
//   ③ StreamLoopAgent + createStreamAgentFactory + apply —— Cordis 适配壳。
//      createAgent/resume 按 dsh-agent-loop/lib/index.js:1668-1775（rc.3 实测行号，
//      rc.1 npm 副本一致）的机器 duck-type 复刻：sessions.prepare → persistence →
//      sessions.enter/announce → setup → agents.enter/announce。
//      AgentRegistry.enter/announce 无 brand 校验（dsh-agent/lib/index.js:641-719，
//      只查 agent.id === agent.session.id 与 store 唯一性），duck-typed agent 对象可通行。
//
// 业务逻辑全部在内核（parser/gate/render/obs/state），本文件只做编排（红线：插件里不写业务逻辑）。
//
// fail-open（红线 5）：驱动器自身异常 → 结构化 fault 记录 + 重新抛出清晰错误，绝不静默吞掉。
// 唯一例外是"账本/事件落盘失败"：内存 records 永远持有全量事实，onWarning 告警后继续
// （不因记账毁掉任务本身，但绝不无声）。

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { TfStreamParser } from '../kernel/parser.js';
                                                                  
import { ContextRenderer, renderHash } from '../kernel/render.js';
                                                         
import { ObservationLedger } from '../kernel/obs.js';
                                                          

// ---------------------------------------------------------------------------
// ① 流契约镜像（dsh-llm/lib/types/types.d.ts 与 dsh-tools/lib/types/executor.d.ts，rc.1 npm）
// ---------------------------------------------------------------------------

/**
 * 镜像 types.d.ts:138-156 FinishReasonMap。
 * 真实宿主的 error finish 把失败事实放在 `failure`（rc.3 实测：
 * {kind:'error', failure:{message, code}}）；mock 05 号用的是平铺 {message, code}。
 * 两种形状都接受，读取统一走 finishCode/finishMessage。
 */
                              
                    
                          
                          
                                                        
     
                    
                       
                    
                                                                   
      

/** error finish 的机器码（宿主形状 failure.code 优先，mock 平铺形状 code 兜底）。 */
export function finishCode(finish                  )         {
  if (finish.kind !== 'error') return finish.kind;
  return finish.failure?.code ?? finish.code ?? 'UNKNOWN';
}

/** error/aborted finish 的可读消息。 */
export function finishMessage(finish                  )         {
  if (finish.kind === 'error') return finish.failure?.message ?? finish.message ?? 'error';
  if (finish.kind === 'aborted') return finish.message ?? 'aborted';
  return finish.kind;
}

/** 镜像 types.d.ts:458-488 StreamChunk（本驱动消费的全部变体） */
                             
                                                             
                                                       
                                                            
                                                                                                 
                                                                                                                                
                                                                           
                                                 

/** 镜像 types.d.ts:538-580 GenerateOptions（驱动器发出的请求形状） */
                                       
                   
                
                           
                                                                                            
                       
                     
 

/** 镜像 executor.d.ts:16-45 ToolBatchInput（probe B 实测形状；单命令批 = calls 长度 1） */
                                     
                                                                                       
                      
                                
                                                           
                                                                                       
                  
                    
                                       
 

/** 镜像 executor.d.ts:47-56 ToolBatchResult（probe B 实测返回结构） */
                                      
                                                                                         
                                          
                      
 

// ---------------------------------------------------------------------------
// 驱动器配置与端口
// ---------------------------------------------------------------------------

/** tf-* 命令 → 原生工具的映射（信息型 read/bash 走原生阻塞通道，写类走单流通道） */
                              
                                                             
                                                                                          
 

export const DEFAULT_TOOL_MAPPING              = {
  toToolCall(cmd) {
    // 原生工具 schema：write(file_path, content)、read(file_path, ...)（dsh-tool-fs/lib/index.js:249-560）、
    // bash(command)（dsh-tool-bash/lib/index.js:493）。参数名以真连实测为准（results 文档记录）。
    switch (cmd.name) {
      case 'tf-write':
        return { name: 'write', arguments: { file_path: cmd.attrs['path'] ?? '', content: cmd.body ?? '' } };
      case 'tf-read': {
        // 行范围透传（上游 read-ranges 语义）：1 基 offset 与行数 limit，宿主 read 原生支持
        const offset = cmd.attrs['offset'];
        const limit = cmd.attrs['limit'];
        const args                          = { file_path: cmd.attrs['path'] ?? '' };
        if (offset !== undefined && /^\d+$/.test(offset)) args['offset'] = Number(offset);
        if (limit !== undefined && /^\d+$/.test(limit)) args['limit'] = Number(limit);
        return { name: 'read', arguments: args };
      }
      case 'tf-bash':
        // DSH Windows 宿主的 shell 工具是 pwsh（dsh-tool-pwsh：command 与 description 双必填，
        // lib/index.js:249-250 实证）——v0.1.0 映射到不存在的 'bash'，真连 R3/R4/C1 的
        // "unknown tool bash" 即此缺陷（2026-11-15 修复）。
        return {
          name: 'pwsh',
          arguments: {
            command: cmd.attrs['cmd'] ?? '',
            description: `tf-bash: ${(cmd.attrs['cmd'] ?? '').slice(0, 80)}`,
          },
        };
      default:
        return null; // tf-peek / tf-final 由驱动器内部处理
    }
  },
};

                                     
                   
                
                           
                                           
                                
                                                  
                        
                                                         
                               
                                                    
                        
                          
                               
                                                   
                             
                                         
                        
                        
                      
                            
 

                              
                                                                                  
                                                                        
                                                       
                                                                        
                                                                   
                             
                               
                           
                                                   
                  
                                       
                                                          
 

/**
 * 会话事件写入面（真实宿主路径专用；事件形状逐字段镜像 dsh-agent-loop/lib/index.js
 * 的 append 调用 :731/:757/:781/:819/:891-955，turn/end reason 形状镜像 :747-821）。
 */
                                  
                                
                                              
                                                                    
                             
                                                          
           
                                            
                                                     
                                                           
                                                                
                                                               
                                                                            
                                                                                  
 

/** kernel/gate.ts ActionGate.admit 的 duck-type 面（04 号对接面备忘） */
                           
                                                                            
                                                                                                     
    
 

                           
                         
                                        
                          
                                        
                                                                

// ---------------------------------------------------------------------------
// ledger 记录（探针 C 定案：tf-* 协议状态落 plugin:tf-agent/<record> 私有记录）
// ---------------------------------------------------------------------------

                          
                                                                                                                                                                                      
                                                                                           
                                                                                                                                                                                    
                                                                   
                                                                   
                                                            
                                                    
                                                                  
                                                                                                              
                                                             

/** plugin record 通道（真实宿主）。类型语法 plugin:tf-agent/<record>（dsh-session types.d.ts:527）。 */
                                                                                                                                       

                             
                                                       
 

                                                                

/**
 * 不可重试的流错误码（LLM 配置/凭据层故障）：重入必然重演，fail-fast 终止回合，
 * 不烧重入预算（探针 A 实测 MISSING_CREDENTIAL 即此层错误）。
 */
const NON_RETRYABLE_STREAM_CODES                      = new Set([
  'AUTH', 'MISSING_CREDENTIAL', 'NO_ADAPTER', 'INVALID_REQUEST', 'INVALID_PREPARED_CALL', 'NOT_FOUND', 'FORBIDDEN',
]);

// ---------------------------------------------------------------------------
// 默认协议文本（稳定前缀组成部分；逐字节确定性，禁止任何动态字段 —— O4）
// ---------------------------------------------------------------------------

export const DEFAULT_SYSTEM_PROMPT = '你是运行在 DeepSeek Harness 里的单流协议 agent。在一次回复流中完成任务：先简短思考，然后连续输出全部 tf-* 命令，最后输出 tf-final。';

export const DEFAULT_PROTOCOL_TEXT = `## tf-* 单流协议（本回合唯一工具语法）

<tf-write path="相对/绝对路径" id="w1" depends_on="r1">
文件正文原文（原样输出，直到闭合标签）
</tf-write>
<tf-read path="相对/绝对路径" id="r1" depends_on="w1,w2" offset="100" limit="50"/>
<tf-bash cmd="命令行" id="b1"/>
<tf-peek handle="obs:read:c3@v1" from_line="10" to_line="20" id="p1"/>
<tf-final id="f1" summary="一句话完成说明"/>

（tf-read 可选 offset/limit：1 基行号起点与行数，大文件按行段取，省 token。）

（收尾纪律：命令全部闭合后，本流必须以 tf-final 结束；写完文件、执行完命令不等于任务结束。）

## 结果获取（关键）
tf-read / tf-bash 成功时结果不回灌，只有句柄进句柄目录；失败才以 [tf-stream:error] 注入。
因此：需要看到内容（文件片段、命令输出、计算结果）时，必须用 tf-peek 按句柄取回——
handle 从 [tf-stream:observation] 与句柄目录增量中取。答案依赖命令输出时，先 peek 再收尾。

## 时序与重发规则
- 同 id 同内容重复声明 = 幂等：直接返回原回执（含句柄），不重复执行；同 id 不同内容会被
  拒绝（换新 id）；被拒绝（无副作用）的命令可用原 id 修正后重发。
- 同流内后续命令自动等待先闭合的 tf-write 完成（写序保证：先写后读不会读到旧内容）。
- tf-peek 的句柄由命令产出——同流内提前 peek 会被自动延迟到命令完成后重试，仍无此句柄才报错；
  要么给 peek 加 depends_on 挂到产出命令上（如 <tf-peek ... depends_on="r1"/>），
  要么等下一请求（句柄会出现在句柄目录增量里）再 peek。
- tf-bash 的命令在 Windows 宿主以 PowerShell（pwsh）执行：python3 通常不存在，优先 node -e 或
  PowerShell 原生命令（Select-String / Get-Content）。

tf-final 的 summary 必须包含任务要求的最终答案原文（数字、行内容、路径、结论），
不得写"已完成/占位"式描述；还没拿到答案就不要输出 tf-final。

规则：
1. 写文件一律用 tf-write（正文在标签体内原样输出）；不要用原生工具写文件。
2. id 建议显式给出且全任务唯一；depends_on 是逗号分隔的依赖 id 列表，可省略。
   依赖只能指向本任务里已出现或将要出现的命令 id。
3. 命令闭合即开始执行（独立命令并行，上限 3 个），不必等流结束再发后续命令。
4. tf-read / tf-bash 的产出默认只句柄化；tf-read 首次结果会以行骨架注入下一请求。
   需要某句柄的细节时发 tf-peek（handle 用句柄目录里的值，行段 1-based 闭区间）。
5. 上一请求若报告 [tf-stream:error]，先修复或改道该命令（换路径/换命令），再继续其余任务。
6. 全部命令成功且无需更多信息时输出 tf-final；收到 tf-final 后本任务收敛，不再有下一请求。`;

export const DEFAULT_INVARIANTS = '不变量：历史消息只增不改（任何"压缩/摘要历史"的请求都会被拒绝）；写文件成功不会有结果回灌（只记台账），失败一定会以 [tf-stream:error] 注入下一请求；不要用原生 tool_call 写文件。回合必须以 <tf-final .../> 收尾：所有命令输出完毕后立即输出 tf-final，不带 tf-final 的回合视为未完成——即使全部工作已做完。';

// ---------------------------------------------------------------------------
// ② SingleStreamDriver
// ---------------------------------------------------------------------------

                         
                 
                                                                  
                             
                     
                  
                  
                                            
                  
                               
                                  
 

                           
                
               
                 
                 
                     
 

                                 
             
                
                    
 

                                 
                                   
                                                                                                
                                                       
                       
                                  
 

let DRIVER_SEQ = 0;

export class SingleStreamDriver {
  #ports             ;
           #cfg   
                     
                  
                             
                                 
                         
                                
                          
                                                                        
                               
                             
   ;
           #renderer                 ;
           #obs                   ;
           #records                 = [];
           #commands = new Map                       ();
           #inFlight = new Set               ();
           #activeControllers = new Set                 ();
  /** 当前流内命令序号（隐式写序：后续命令等待先闭合的同流 tf-write —— 上游 ThinkFlow 语义） */
  #streamSeqCounter = 0;
  #streamWrites                                     = [];
  /** unknown-handle 的 peek（同流乐观 peek）：流末 drain 后重试一次，仍无此句柄才失败 */
  #deferredPeeks                                                            = [];

  #turnCounter = 0;
  #requestCount = 0;
  #reentryCount = 0;
  #finalNudges = 0;
  #finalOnlyRequests = 0;
  #deltaCursor = 0; // O3 directoryDelta 游标（obs seq 空间）
  #usage = { inputTokens: 0, outputTokens: 0 };
  #injectedChars = 0;
  #stableHashes           = [];
  #aborted = false;
  #abortReason         ;
  #ledger                        ;
  #warn                                             ;
  #gate                      ;
  #taskId = 'task';
  #sessionId                    ;
  /** 已上报的结构化问题（同一失败只注入一次） */
  #reportedIssues = new Set        ();
  /** 已注入骨架的观测 key（driver seq 空间，避免重复注入） */
  #reportedObservations = new Set        ();
  /** 已回灌结果的 peek 命令 id */
  #reportedPeeks = new Set        ();
  /** 当前 agent 引用（executeTools 带上 agent；fs 工具 session 解析依赖，见 ToolBatchInputLike） */
  #agentRef          = undefined;
  /** ok 的 tf-final 候选（解析序）；任务最终答案取最后一个（过早 final 可被后继覆盖） */
  #finalCandidates                                                                        = [];

  constructor(ports             , config                    , renderer                  , obs                    ) {
    this.#ports = ports;
    this.#cfg = {
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      maxParallelToolCalls: config.maxParallelToolCalls ?? 3,
      maxReentries: config.maxReentries ?? 8,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 30_000,
      budgetTokens: config.budgetTokens,
      toolMapping: config.toolMapping ?? DEFAULT_TOOL_MAPPING,
    };
    this.#renderer = renderer ?? new ContextRenderer({
      system: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      protocol: config.protocolText ?? DEFAULT_PROTOCOL_TEXT,
      toolSchemas: config.nativeToolSchemas ?? '（本回合未启用原生工具；一切文件与命令操作走 tf-* 协议）',
      invariants: config.invariants ?? DEFAULT_INVARIANTS,
    });
    this.#obs = obs ?? new ObservationLedger({ starvationThreshold: config.starvationThreshold });
    this.#warn = ports.onWarning ?? (() => {});
    this.#gate = ports.gate;
  }

  /** 注入 ledger 通道（探针 C 定案的 plugin:tf-agent/* 落盘口；缺省只进内存 records）。 */
  attachLedger(sink            )       {
    this.#ledger = sink;
  }

  /** 运行时模型路由切换（Agent.model.select 的落点）。 */
  applySelection(selection                                                                 )       {
    if (selection.provider !== undefined) this.#cfg.provider = selection.provider;
    if (selection.model !== undefined) this.#cfg.model = selection.model;
    if (selection.reasoningEffort !== undefined) this.#cfg.reasoningEffort = selection.reasoningEffort;
  }

  /** Agent 层接线：会话 id（请求路由 stamp）与任务 id（gate 凭据绑定）。 */
  setIdentity(sessionId                    , taskId        )       {
    this.#sessionId = sessionId;
    this.#taskId = taskId;
  }

  /** Agent 构造完成后回填引用：工具批的 agent 字段（fs 工具 session 解析依赖）。 */
  setAgent(agent         )       {
    this.#agentRef = agent;
  }

  /** Agent 作用域的工具执行器重绑（桌面端 preset 层）：
   *  web/desktop 组合把 tool-fs/tool-pwsh 从宿主平面挪进 agent preset 层（standard.patch.yml），
   *  entry 根 ctx 的 tools 服务解析不到 write/edit/bash → "unknown tool"。
   *  setup（preset 绑定）完成后用 agentCtx 的 tools 服务重绑；headless 回退根服务不变。 */
  setToolsExecutor(execute                                                             )       {
    this.#ports = { ...this.#ports, executeTools: execute };
  }

  snapshot()                 {
    const obs = this.#obs;
    return {
      records: [...this.#records],
      counters: () => {
        const c = obs.counters();
        return { injected: c.injected, produced: c.produced, peeked: c.peeked, injectedRatio: obs.injectedRatio() };
      },
      usage: { ...this.#usage },
      requestCount: this.#requestCount,
      stableHashes: [...this.#stableHashes],
    };
  }

  // ------------------------------------------------------------------ 评测 dump（08 号 METRICS.md M3）

  /**
   * env STREAM_LOOP_EVAL_DUMP 门控：turn 结束把 snapshot 落 JSON 文件（<prefix>-turn<N>.json）。
   * injected_ratio 权威口径的取证来源（07 号 §3.2 裁定：驱动器 snapshot 为准）；
   * 写入失败只告警不抛（fail-open，红线 5——记账不毁任务）。未设 env 时零开销直返。
   */
  #dumpEval(turn        , reason               )       {
    const prefix = process.env.STREAM_LOOP_EVAL_DUMP;
    if (prefix === undefined || prefix === '') return;
    try {
      const snap = this.snapshot();
      writeFileSync(
        `${prefix}-turn${turn}.json`,
        JSON.stringify({
          sessionId: this.#sessionId, taskId: this.#taskId, turn, turnEndReason: reason,
          requestCount: snap.requestCount, usage: snap.usage, stableHashes: snap.stableHashes,
          counters: snap.counters(), records: snap.records,
        }, null, 2),
      );
    } catch (error) {
      this.#warn('eval dump 写入失败（fail-open）', error);
    }
  }

  // ------------------------------------------------------------------ O5 阶梯

  /** 任务级 token 预算阶梯（README O5：<70% normal；70-90% high-only；>90% final-only）。 */
  budgetLevel()              {
    const budget = this.#cfg.budgetTokens;
    if (budget === undefined || budget <= 0) return 'normal';
    const spent = this.#usage.inputTokens + this.#usage.outputTokens + Math.ceil(this.#injectedChars / 4);
    if (spent >= budget * 0.9) return 'final-only';
    if (spent >= budget * 0.7) return 'high-only';
    return 'normal';
  }

  // ------------------------------------------------------------------ 任务入口

  /** 追加一条用户任务（Agent.followup 的驱动器侧入口：只进装配历史，不发请求）。 */
  pushUserTask(text        )       {
    this.#renderer.appendHistory({ role: 'user', content: text });
  }

  /** 外部取消（Agent.cancel 的入口）：中断当前流与在途请求。 */
  cancel(reason         )       {
    this.#aborted = true;
    this.#abortReason = reason;
    for (const controller of this.#activeControllers) {
      controller.abort(reason instanceof Error ? reason : new Error(String(reason)));
    }
  }

  /** 跑一个回合（从当前装配历史到 FINISH/blocked）。异常一律上抛（fail-open，红线 5）。 */
  async runTurn()                         {
    const turn = ++this.#turnCounter;
    debugTrace('turn.start', { turn });
    try {
      this.#ports.events?.turnStart(turn);
      const reason = await this.#turnLoop(turn);
      this.#dumpEval(turn, reason);
      return reason;
    } catch (error) {
      const failure                = {
        kind: 'error',
        error: { message: error instanceof Error ? error.message : String(error), code: 'DRIVER_ERROR' },
      };
      this.#dumpEval(turn, failure);
      this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'driver-error', detail: failure.error.message });
      this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'driver-error', detail: failure.error.message, turn });
      try {
        this.#ports.events?.turnEnd(turn, failure);
      } catch (eventError) {
        this.#warn('turn/end 事件写入失败', eventError);
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------ 回合主循环

  async #turnLoop(turn        )                         {
    let step = 0;
    let reason                = { kind: 'blocked', detail: 'turn loop exited without convergence' };

    while (true) {
      const level = this.budgetLevel();
      step += 1;
      try {
        this.#ports.events?.stepStart(turn, step);
      } catch (error) {
        this.#warn('step/start 事件写入失败', error);
      }

      // ---- REQUEST：装配 + O6 preflight（render() 内置断言，违反即抛 → fail-closed）----
      const messages = this.#renderer.render();
      const stableHash = this.#renderer.stableHash();
      this.#stableHashes.push(stableHash);
      const fullHash = renderHash(messages);
      this.#record({
        seq: ++DRIVER_SEQ, kind: 'request', turn, step,
        provider: this.#cfg.provider, model: this.#cfg.model,
        level, stableHash, renderHash: fullHash,
        injectionBlocks: 0,
      });

      // ---- STREAMING：逐 delta 消费；命令闭合即派发，不结束流 ----
      const streamOutcome = await this.#consumeStream(turn, step, messages, level);

      // 不可重试的流错误（凭据/配置层）：fail-fast 终止回合，不进重入循环
      if (streamOutcome.finish.kind === 'error' && NON_RETRYABLE_STREAM_CODES.has(finishCode(streamOutcome.finish))) {
        try {
          this.#ports.events?.stepEnd(turn, step);
        } catch (error) {
          this.#warn('step/end 事件写入失败', error);
        }
        reason = { kind: 'error', error: { message: finishMessage(streamOutcome.finish), code: finishCode(streamOutcome.finish) } };
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'stream-fatal', detail: finishDetail(streamOutcome.finish) });
        this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'stream-fatal', code: finishCode(streamOutcome.finish), detail: finishDetail(streamOutcome.finish), turn });
        break;
      }

      // ---- 等 drain（F8 普通异步等待）----
      await this.#drain();
      await this.#resolveDeferredPeeks(turn, step);
      try {
        this.#ports.events?.stepEnd(turn, step);
      } catch (error) {
        this.#warn('step/end 事件写入失败', error);
      }

      // ---- 收束判定（仅三种重入事由：失败/拒绝、high 观测、peek 需求）----
      const issues = this.#collectIssues();
      const injections = this.#buildInjections(issues, level);
      // 饥饿防线（07 号结果 §3.6 上报的断链，08 号评测前按其建议修复）：
      // 升格骨架接入注入通路（按 high 观测同款格式；final-only 档不注入——预算已枯竭）。
      const promoted = this.#obs.noteStep(injections.highInjected);
      if (promoted !== null && level !== 'final-only' && !this.#reportedObservations.has(promoted.seq)) {
        this.#reportedObservations.add(promoted.seq);
        injections.blocks.push({
          role: 'user',
          content: `[tf-stream:observation handle=${promoted.handle ?? ''} key=starvation-promoted]\n${(promoted.payload                         ).rendered ?? ''}\n（细节用 tf-peek handle="${promoted.handle}" from_line=.. to_line=.. 取回）`,
        });
      }

      if (streamOutcome.finish.kind === 'error' || streamOutcome.finish.kind === 'aborted') {
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: `stream-${streamOutcome.finish.kind}`, detail: finishDetail(streamOutcome.finish) });
        this.#ledgerWrite('plugin:tf-agent/fault', { fault: `stream-${streamOutcome.finish.kind}`, detail: finishDetail(streamOutcome.finish), turn });
      }

      // ---- 过早 final 检测（真连 R3/R4 教训）：占位 final 不算收敛，注入引导重发 ----
      const lastFinal = this.#finalCandidates.length > 0 ? this.#finalCandidates[this.#finalCandidates.length - 1] : undefined;
      let prematureFinal                    ;
      if (lastFinal !== undefined && level !== 'final-only') {
        const finalRec = this.#commands.get(lastFinal.cmdId);
        const unmetDeps = (finalRec?.cmd.depends_on ?? []).filter((d) => this.#commands.get(d)?.status !== 'ok');
        const unfinished = [...this.#commands.values()].filter((r) => r.cmd.name !== 'tf-final' && (r.status === 'pending' || r.status === 'dispatched'));
        prematureFinal = unmetDeps.length > 0
          ? `tf-final 过早：depends_on 未满足（${unmetDeps.join(', ')}）`
          : unfinished.length > 0
            ? 'tf-final 过早：仍有命令未完成'
            : undefined;
      }

      const finalSeen = this.#finalSeen && prematureFinal === undefined;
      const needsReentry = issues.length > 0 || injections.blocks.length > 0 || prematureFinal !== undefined;

      if (prematureFinal !== undefined && lastFinal !== undefined) {
        injections.blocks.push({
          role: 'user'         ,
          content: `[tf-stream:error id=${lastFinal.cmdId} cmd=tf-final] ${prematureFinal}\n建议：先取回所需结果（tf-peek）或补齐未完成命令，然后在流末尾用新 id 重发 tf-final；summary 必须包含最终答案原文（数字/行内容/路径/结论），不得占位。`,
        });
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'premature-final', detail: prematureFinal });
        this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'premature-final', detail: prematureFinal, turn });
      }

      if (finalSeen && !needsReentry) {
        // 成功路径：零注入，只写 ledger —— 分派 06 核心命题
        reason = { kind: 'completed' };
        // 最终答案落会话：headless 输出与评测 checks 消费最后一条 assistant 消息
        if (lastFinal !== undefined && lastFinal.summary.trim() !== '') {
          try {
            this.#ports.events?.finalAnswer?.(turn, step, lastFinal.summary);
          } catch (error) {
            this.#warn('final 答案消息写入失败', error);
          }
        }
        break;
      }

      const finalOnlyGate = level === 'final-only' && this.#finalOnlyRequests >= 1;
      const nudgeExhausted = !needsReentry && !finalSeen && this.#finalNudges >= 1;
      if (this.#aborted || finalOnlyGate || nudgeExhausted || this.#reentryCount >= this.#cfg.maxReentries) {
        if (this.#aborted) {
          reason = { kind: 'aborted', reason: this.#abortReason instanceof Error ? this.#abortReason.message : String(this.#abortReason ?? 'cancelled') };
        } else if (finalOnlyGate) {
          reason = { kind: 'blocked', detail: '预算进入 final-only 档：停止一切注入，降级交付（已完成/未完成见台账）' };
        } else if (nudgeExhausted) {
          reason = { kind: 'blocked', detail: '流终止且无 tf-final、无重入事由（提示一次后仍未收敛）' };
        } else {
          reason = { kind: 'blocked', detail: `重入次数达到上限 ${this.#cfg.maxReentries}` };
        }
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'turn-blocked', detail: reason.kind === 'blocked' ? reason.detail : reason.kind });
        break;
      }

      // ---- INJECTING：O3 句柄目录差分（追加区）+ 易变尾注入，发下一请求 ----
      const delta = this.#obs.directoryDelta(this.#deltaCursor);
      const maxSeq = [...delta.added, ...delta.changed, ...delta.stale].reduce((m, e) => Math.max(m, e.seq), this.#deltaCursor);
      this.#deltaCursor = maxSeq;
      this.#renderer.appendHandleDelta(delta);

      let tail = injections.blocks;
      if (tail.length === 0 && !finalSeen) {
        if (level === 'final-only') {
          // O5 >90% 档：停止一切注入，输出降级交付（已完成/未完成/已排除见台账），只收 tf-final
          tail = [{
            role: 'user'         ,
            content: `[tf-stream:degraded] 预算已进入 final-only 档：停止一切注入。请根据台账现状立即输出 tf-final 结束任务；未完成项将在交付说明中列为未完成。`,
          }];
          this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'degraded-delivery' });
          this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'degraded-delivery', turn });
        } else {
          // 无重入事由但也没 tf-final：一次性提示（护栏防无限循环）
          this.#finalNudges += 1;
          tail = [{ role: 'user'         , content: '[tf-stream:nudge] 输出已终止但未收到 tf-final。若任务已完成请输出 tf-final；否则继续输出剩余 tf-* 命令。' }];
          this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'missing-final-nudge' });
        }
      }
      this.#injectedChars += tail.reduce((n, b) => n + b.content.length, 0);
      if (level === 'final-only') this.#finalOnlyRequests += 1;
      this.#renderer.setTail(tail);
      this.#reentryCount += 1;
    }

    this.#record({ seq: ++DRIVER_SEQ, kind: 'turn-end', reason });
    try {
      this.#ports.events?.turnEnd(turn, reason);
    } catch (error) {
      this.#warn('turn/end 事件写入失败', error);
    }
    this.#ledgerWrite('plugin:tf-agent/step', { turn, steps: step, requests: this.#requestCount, usage: { ...this.#usage }, reason: reason.kind });
    return reason;
  }

  get #finalSeen()          {
    return this.#commands.size > 0 && [...this.#commands.values()].some((rec) => rec.cmd.name === 'tf-final' && rec.status === 'ok');
  }

  // ------------------------------------------------------------------ 流消费

  /** 诊断探针：会话对象的事件账面（内存事件数/末尾 seq）。 */
  #sessionProbe()          {
    const session = (this.#agentRef                                                                                                         )?.session;
    if (session === undefined || typeof session.snapshotEvents !== 'function') return 'no-session-probe';
    try {
      const all = session.snapshotEvents(0) ?? [];
      const last = all[all.length - 1];
      return {
        count: all.length,
        lastSeq: last?.seq,
        lastType: last?.type,
        types: all.slice(-6).map((e) => `${e.type ?? '?'}#${e.seq ?? '?'}`),
      };
    } catch (error) {
      return `probe-error: ${String(error)}`;
    }
  }

  async #consumeStream(
    turn        ,
    step        ,
    messages                          ,
    level             ,
  )                                        {
    // 新流：隐式写序的流内序号清零（跨流依赖仍由 depends_on 显式声明）
    this.#streamSeqCounter = 0;
    this.#streamWrites = [];
    const parser = new TfStreamParser();
    const controller = new AbortController();
    this.#activeControllers.add(controller);
    let textBuf = '';
    let reasoningChars = 0;
    const natives = new Map                               ();
    let finish                          = null;
    let usageSeen                                                           ;

    // 看门狗：流空闲超时 → abort（fault-timeout 路径；消费方掐断面）
    const idleMs = this.#cfg.streamIdleTimeoutMs;
    const armWatchdog = () => {
      if (idleMs <= 0) return undefined;
      return setTimeout(() => controller.abort(new Error(`stream idle beyond ${idleMs}ms (watchdog)`)), idleMs);
    };
    let watchdog = armWatchdog();
    const bump = () => {
      if (watchdog !== undefined) {
        clearTimeout(watchdog);
        watchdog = armWatchdog();
      }
    };

    const feed = (delta        ) => {
      const events                = parser.feed(delta);
      for (const event of events) this.#handleParserEvent(event, turn, step);
    };

    try {
      if (this.#cfg.provider === '' || this.#cfg.model === '') {
        // 无模型路由（桌面端未选择模型且无默认）：失败注入引导，不静默烧流
        return {
          finish: {
            kind: 'error'         ,
            message: '未解析到可用模型路由（provider/model 为空）：请先在界面选择模型后重试',
            code: 'NO_MODEL_ROUTE',
          },
        };
      }
      const stream = this.#ports.stream({
        provider: this.#cfg.provider,
        model: this.#cfg.model,
        reasoningEffort: this.#cfg.reasoningEffort,
        messages: toWireMessages(messages),
        signal: controller.signal,
        sessionId: this.#sessionId,
      });
      this.#requestCount += 1;
      debugTrace('stream.call', {
        turn,
        step,
        provider: this.#cfg.provider,
        model: this.#cfg.model,
        messages: messages.length,
        sessionProbe: this.#sessionProbe(),
      });

      for await (const chunk of stream) {
        bump();
        switch (chunk.type) {
          case 'text-delta':
            textBuf += chunk.text;
            feed(chunk.text);
            break;
          case 'reasoning-delta':
            reasoningChars += chunk.text.length; // 思维链不进协议解析，只计体积
            break;
          case 'tool-call-delta': {
            const acc = natives.get(chunk.id) ?? { id: chunk.id, arguments: '' };
            if (chunk.name !== undefined) acc.name = chunk.name;
            acc.arguments += chunk.argumentsDelta;
            natives.set(chunk.id, acc);
            break;
          }
          case 'block-end':
            if (chunk.block.type === 'tool-call' && chunk.block.id !== undefined) {
              const acc = natives.get(chunk.block.id) ?? { id: chunk.block.id, name: chunk.block.name, arguments: '' };
              if (chunk.block.name !== undefined) acc.name = chunk.block.name;
              if (chunk.block.arguments !== undefined && acc.arguments.length === 0) acc.arguments = chunk.block.arguments;
              natives.set(chunk.block.id, acc);
            } else if (chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
              // 完整性对账：block-end 全量文本 vs text-delta 拼接（不一致如实告警，不静默）
              if (chunk.block.text !== textBuf) {
                this.#warn('block-end 全量文本与 text-delta 拼接不一致', { expectedChars: textBuf.length, actualChars: chunk.block.text.length });
              }
            }
            break;
          case 'usage':
            usageSeen = chunk.usage;
            this.#usage.inputTokens += chunk.usage.inputTokens;
            this.#usage.outputTokens += chunk.usage.outputTokens;
            this.#record({ seq: ++DRIVER_SEQ, kind: 'usage', turn, inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens });
            break;
          case 'finish':
            finish = chunk.reason;
            break;
          default:
            break;
        }
      }
    } catch (error) {
      // 契约归一化（types.d.ts:456）：适配器异常 → 终止 error finish。
      // 真实宿主的 LlmRuntime 已归一化，这里兜底离线/直连适配器路径。
      if (finish === null) {
        finish = {
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
          code: 'ADAPTER_THROWN',
        };
      }
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      this.#activeControllers.delete(controller);
    }

    if (finish === null) {
      finish = { kind: 'error', message: 'stream ended without a finish chunk', code: 'NO_FINISH' };
      this.#warn('流未以 finish chunk 终止（按契约这是异常，已归一为 error）');
    }
    debugTrace('stream.finish', finish);

    // 流终止：冲刷 parser（truncated / done）
    for (const event of parser.end()) this.#handleParserEvent(event, turn, step);

    // 会话落盘：assistant 消息（成功 → assistant/message；error/aborted → attempt / 中断消息）
    try {
      this.#ports.events?.assistantMessage(turn, step, textBuf, { finish, usage: usageSeen });
    } catch (error) {
      this.#warn('assistant 事件写入失败', error);
    }
    if (reasoningChars > 0) {
      this.#ledgerWrite('plugin:tf-agent/step', { turn, step, reasoningChars });
    }

    // 原生 tool_call 通道（阻塞式回灌）：只在流正常终止时执行；中断/错误的残缺调用如实丢弃
    if (natives.size > 0) {
      if (finish.kind === 'stop' || finish.kind === 'tool-calls') {
        await this.#executeNativeCalls(turn, step, [...natives.values()], controller.signal, level);
      } else {
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'native-calls-discarded', detail: `finish=${finish.kind} calls=${natives.size}` });
      }
    }

    return { finish };
  }

  // ------------------------------------------------------------------ parser 事件处理

  #handleParserEvent(event             , turn        , step        )       {
    switch (event.type) {
      case 'text':
        // prose 原样透传：已随 textBuf 落 assistant/message，无需重复处理（不改写）
        break;
      case 'command':
        this.#onCommand(event.command, turn, step);
        break;
      case 'malformed':
        // fail-soft：记 ledger，流继续（分派 06 硬性要求 + 05 号故障剧本口径）
        this.#record({ seq: ++DRIVER_SEQ, kind: 'malformed', raw: event.raw, reason: event.reason });
        this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'malformed-command', reason: event.reason, raw: event.raw.slice(0, 200) });
        break;
      case 'truncated':
        this.#record({ seq: ++DRIVER_SEQ, kind: 'truncated', raw: event.raw, reason: event.reason });
        this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'truncated-command', reason: event.reason });
        break;
      case 'cycle':
        // 环上的命令永不就绪 → 收束判定以结构化错误重入
        this.#record({ seq: ++DRIVER_SEQ, kind: 'cycle', cycle: event.cycle });
        for (const id of event.cycle) {
          const rec = this.#commands.get(id);
          if (rec !== undefined && rec.status === 'pending') {
            rec.status = 'failed';
            rec.detail = `depends_on 环：${event.cycle.join(' -> ')}`;
            this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id, name: rec.cmd.name, status: 'failed', detail: rec.detail });
          }
        }
        break;
      case 'done':
        break;
    }
  }

  #onCommand(cmd           , turn        , step        )       {
    const prev = this.#commands.get(cmd.id);
    if (prev !== undefined) {
      // ---- 重复 id 语义（对齐上游 ThinkFlow DESIGN.md：重复 id 不能伪造成功）----
      // ① 同 id 同内容且已有回执 → 幂等返回原回执（含句柄），不重复执行；
      // ② 同 id 不同内容 → 明确拒绝（换新 id）；
      // ③ 原命令仍在执行 → 拒绝；
      // ④ 原命令被拒绝（无副作用）→ 允许同 id 修正重发（上游："拒绝的命令没有副作用，
      //    可用原 id 修正重发，不因无效输入制造第二次重复编号错误"）。
      const fp = commandFingerprint(cmd);
      if (prev.status === 'ok' && cmd.name === 'tf-final') {
        // tf-final 无副作用，且模型反复复用同一 id 更新答案（deepseek-flash 真连实证）：
        // 同 id 携带新 summary = 覆盖最终答案（last-wins）；同 summary = 幂等原回执。
        // "重复 id 不能伪造成功"不受影响——final 不产生副作用，只是声明。
        if (commandFingerprint(prev.cmd) === fp) {
          this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'ok', detail: 'duplicate-idempotent: 返回原回执' });
        } else {
          const summary = cmd.attrs['summary'] ?? '';
          const cand = this.#finalCandidates.find((c) => c.cmdId === cmd.id);
          if (cand !== undefined) cand.summary = summary;
          this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'ok', detail: summary });
          this.#record({ seq: ++DRIVER_SEQ, kind: 'final', summary });
          this.#ledgerWrite('plugin:tf-agent/final', { summary, turn, step, cmdId: cmd.id, superseded: true });
        }
        return;
      }
      if (prev.status === 'ok' || prev.status === 'failed') {
        if (commandFingerprint(prev.cmd) === fp) {
          this.#record({
            seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: prev.status,
            detail: `duplicate-idempotent: 返回原回执${prev.handle !== undefined ? `（handle=${prev.handle}）` : ''}`,
            handle: prev.handle,
          });
          this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'duplicate-idempotent' });
        } else {
          this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'rejected', detail: 'duplicate-id: 同 id 已被不同内容占用，请换新 id' });
        }
        return;
      }
      if (prev.status === 'pending' || prev.status === 'dispatched') {
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'rejected', detail: 'duplicate-id: 命令执行中' });
        return;
      }
      // prev.status === 'rejected'：登记位让给修正重发（记录历史保留在 #records）
      this.#commands.delete(cmd.id);
    }
    const record                = { cmd, status: 'pending' };
    record.streamSeq = ++this.#streamSeqCounter;
    this.#commands.set(cmd.id, record);
    if (cmd.name === 'tf-write') {
      // 同流写序（上游 DESIGN：信息工具先等之前的写入）——#dispatchReady 里的隐式依赖
      this.#streamWrites.push({ id: cmd.id, seq: record.streamSeq });
    }
    this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'pending' });
    if (cmd.name === 'tf-final') {
      // 终结命令：不派发工具，标记完成（推进依赖图）；台账同时落 command + final 两条。
      // 过早性在流末收束判定（#turnLoop）：依赖未满足/有命令未完成 → 注入 premature-final
      // 引导用新 id 重发（2026-11-15 真连 R3/R4 教训：占位 final 会永久占用 finalSeen）。
      record.status = 'ok';
      record.detail = cmd.attrs['summary'] ?? '';
      this.#finalCandidates.push({ cmdId: cmd.id, summary: record.detail, turn, step });
      this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'ok', detail: record.detail });
      this.#record({ seq: ++DRIVER_SEQ, kind: 'final', summary: record.detail });
      this.#ledgerWrite('plugin:tf-agent/final', { summary: record.detail, turn, step, cmdId: cmd.id });
    }
    this.#dispatchReady(turn, step);
  }

  /** 派发所有就绪命令（依赖全部 ok、未派发），并发上限 maxParallelToolCalls。
   *  隐式写序（上游 ThinkFlow 语义）：任何命令隐式等待同流内先闭合且尚未 ok 的 tf-write——
   *  先写后读不会读到旧内容；写族自身按 FIFO 排队（同流多写不再并发竞态）。 */
  #dispatchReady(turn        , step        )       {
    if (this.#aborted) return;
    for (const rec of this.#commands.values()) {
      if (rec.status !== 'pending') continue;
      if (this.#inFlight.size >= this.#cfg.maxParallelToolCalls) return;
      const depsMet = rec.cmd.depends_on.every((d) => this.#commands.get(d)?.status === 'ok');
      if (!depsMet) continue;
      const pendingWrites = rec.streamSeq !== undefined
        ? this.#streamWrites.filter((w) => w.seq < rec.streamSeq  && this.#commands.get(w.id)?.status !== 'ok')
        : [];
      if (pendingWrites.length > 0) continue;
      rec.status = 'dispatched';
      this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: rec.cmd.id, name: rec.cmd.name, status: 'dispatched' });
      const task                = this.#executeCommand(rec, turn, step)
        .catch((error) => {
          // 驱动器自身异常（fail-open）：结构化失败 + 告警，不静默吞
          rec.status = 'failed';
          rec.detail = error instanceof Error ? error.message : String(error);
          this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: rec.cmd.id, name: rec.cmd.name, status: 'failed', detail: rec.detail });
          this.#warn(`命令 ${rec.cmd.id} 执行异常`, error);
        })
        .finally(() => {
          this.#inFlight.delete(task);
          this.#ports.onToolSettled?.();
          this.#dispatchReady(turn, step);
        });
      this.#inFlight.add(task);
    }
  }

  async #executeCommand(rec               , turn        , step        )                {
    const cmd = rec.cmd;

    // ---- 准入（kernel/gate.ts 的 admit 面；缺省无门）----
    if (this.#gate !== undefined) {
      const verdict = await this.#gate.admit({
        action: cmd.name,
        taskId: this.#taskId,
        detail: cmd.name === 'tf-write' ? `path=${cmd.attrs['path'] ?? ''}` : cmd.attrs['cmd'] ?? cmd.attrs['path'] ?? '',
      });
      if (verdict.verdict === 'deny') {
        rec.status = 'rejected';
        rec.detail = `${verdict.reason}: ${verdict.detail}`;
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'rejected', detail: rec.detail });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'rejected', detail: rec.detail });
        return;
      }
    }

    // ---- tf-peek：内核 obs 直接取回（need_result 通道）----
    if (cmd.name === 'tf-peek') {
      const handle = cmd.attrs['handle'] ?? '';
      const from = Number(cmd.attrs['from_line'] ?? '1');
      const to = cmd.attrs['to_line'] === undefined ? Number.MAX_SAFE_INTEGER : Number(cmd.attrs['to_line']);
      const content = this.#obs.peek(handle, from, to);
      if (content === null) {
        // 同流乐观 peek（句柄所在命令还在执行）：延迟到流末 drain 后重试一次（上游语义
        // "信息工具先等之前的写入"的驱动器侧实现）；流末仍无此句柄才按失败注入。
        const workInFlight = [...this.#commands.values()].some(
          (r) => r.cmd.name !== 'tf-peek' && (r.status === 'pending' || r.status === 'dispatched'),
        );
        if (workInFlight) {
          rec.status = 'dispatched';
          rec.detail = 'deferred: handle 未就绪，流末重试';
          this.#deferredPeeks.push({ rec, turn, step });
          this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'dispatched', detail: rec.detail });
          return;
        }
        rec.status = 'failed';
        rec.detail = `unknown-handle:${handle}`;
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
        return;
      }
      rec.status = 'ok';
      rec.output = content;
      rec.detail = `${content.length} chars`;
      this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'ok', handle, detail: rec.detail });
      this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'ok', handle, chars: content.length });
      return;
    }

    // ---- tf-write / tf-read / tf-bash：映射原生工具，单命令批执行 ----
    const mapped = this.#cfg.toolMapping.toToolCall(cmd);
    if (mapped === null) {
      rec.status = 'failed';
      rec.detail = `no-tool-mapping:${cmd.name}`;
      this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
      return;
    }

    let result                     ;
    try {
      result = await this.#ports.executeTools({
        calls: [{ type: 'tool-call', id: cmd.id, name: mapped.name, arguments: JSON.stringify(mapped.arguments) }],
        signal: new AbortController().signal,
        maxParallelToolCalls: 1,
        ...(this.#agentRef === undefined ? {} : { agent: this.#agentRef }),
        log: safeToolLog(this.#ports, turn, step),
      });
    } catch (error) {
      rec.status = 'failed';
      rec.detail = describeToolError(error);
      this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
      this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail.slice(0, 200) });
      return;
    }

    const first = result.results[0];
    const contentText = blockTextOf(first?.result?.content);
    const isError = first?.result?.isError === true;

    // ---- 观测登记（O1 三档返回；失败一律 high）----
    const observation = this.#obs.observe({
      tool: cmd.name,
      ok: !isError,
      key: observationKey(cmd),
      content: contentText,
      callId: cmd.id,
    });
    rec.observation = observation;
    this.#record({
      seq: ++DRIVER_SEQ, kind: 'observation',
      handle: observation.handle, key: observationKey(cmd),
      infoGain: observation.info_gain, reason: observation.reason,
    });

    if (isError) {
      rec.status = 'failed';
      rec.detail = contentText.slice(0, 500);
      rec.handle = observation.handle ?? undefined;
      this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
      this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail.slice(0, 200) });
      return;
    }

    rec.status = 'ok';
    rec.detail = `${contentText.length} chars`;
    rec.handle = observation.handle ?? undefined;
    this.#record({
      seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'ok',
      handle: rec.handle, infoGain: observation.info_gain, detail: rec.detail,
    });
    this.#ledgerWrite('plugin:tf-agent/command', {
      cmdId: cmd.id, name: cmd.name, status: 'ok',
      handle: rec.handle, infoGain: observation.info_gain, chars: contentText.length,
    });
  }

  /** 原生 tool_call 通道：阻塞式执行 + 结果回灌下一请求（信息型工具的即时需求）。 */
  async #executeNativeCalls(
    turn        ,
    step        ,
    calls                         ,
    signal             ,
    level             ,
  )                {
    let result                                 ;
    try {
      result = await this.#ports.executeTools({
        calls: calls.map((c) => ({ type: 'tool-call'         , id: c.id, name: c.name ?? 'unknown', arguments: c.arguments || '{}' })),
        ...(this.#agentRef === undefined ? {} : { agent: this.#agentRef }),
        signal,
        log: safeToolLog(this.#ports, turn, step),
      });
    } catch (error) {
      this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'native-tool-batch-error', detail: error instanceof Error ? error.message : String(error) });
    }
    const results = (result?.results ?? []).map((r) => ({
      callId: r.callId,
      name: calls.find((c) => c.id === r.callId)?.name ?? 'unknown',
      content: blockTextOf(r.result?.content),
      isError: r.result?.isError === true,
    }));
    for (const _call of calls) this.#ports.onToolSettled?.();
    if (results.length === 0 || level === 'final-only') return;

    // 原生通道结果即需求（阻塞语义）：注入易变尾，下一请求立即可见
    const blocks = results.map((r) => ({
      role: 'user'         ,
      content: `[tf-stream:tool-result callId=${r.callId} tool=${r.name}${r.isError ? ' isError=true' : ''}]\n${r.content}`,
    }));
    this.#injectedChars += blocks.reduce((n, b) => n + b.content.length, 0);
    this.#pendingNativeBlocks.push(...blocks);
  }

  #pendingNativeBlocks                                           = [];

  // ------------------------------------------------------------------ drain / 收束

  async #drain()                {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
      // 全部落定后再开一轮派发（依赖在 drain 期间满足的命令）
      this.#dispatchReady(this.#turnCounter, 0);
    }
  }

  /** 流末重试延迟的 peek（同流乐观 peek；句柄已由 drain 期间完成的命令注册）。
   *  仍无此句柄才按失败注入——上游"信息工具先等之前的写入"的驱动器侧闭环。 */
  async #resolveDeferredPeeks(turn        , step        )                {
    const deferred = this.#deferredPeeks;
    this.#deferredPeeks = [];
    for (const { rec } of deferred) {
      if (rec.status !== 'dispatched') continue; // 已被其它路径终结
      const handle = rec.cmd.attrs['handle'] ?? '';
      const from = Number(rec.cmd.attrs['from_line'] ?? '1');
      const to = rec.cmd.attrs['to_line'] === undefined ? Number.MAX_SAFE_INTEGER : Number(rec.cmd.attrs['to_line']);
      const content = this.#obs.peek(handle, from, to);
      if (content === null) {
        rec.status = 'failed';
        rec.detail = `unknown-handle:${handle}`;
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: rec.cmd.id, name: rec.cmd.name, status: 'failed', detail: rec.detail });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: rec.cmd.id, name: rec.cmd.name, status: 'failed', detail: rec.detail });
        continue;
      }
      rec.status = 'ok';
      rec.output = content;
      rec.detail = `${content.length} chars`;
      rec.handle = handle;
      this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: rec.cmd.id, name: rec.cmd.name, status: 'ok', handle, detail: rec.detail });
      this.#ledgerWrite('plugin:tf-agent/command', { cmdId: rec.cmd.id, name: rec.cmd.name, status: 'ok', handle, chars: content.length });
    }
  }

  /**
   * 结构化重入事由收集（仅三种：失败/拒绝、依赖未满足）。
   * 收集即上报：同一命令只注入一次（模型修复与否由它自己负责，tf-final 是最终裁决）。
   */
  #collectIssues()                    {
    const issues                    = [];
    for (const rec of this.#commands.values()) {
      if (rec.status === 'failed' || rec.status === 'rejected') {
        if (this.#reportedIssues.has(rec.cmd.id)) continue;
        this.#reportedIssues.add(rec.cmd.id);
        issues.push({
          cmdId: rec.cmd.id,
          name: rec.cmd.name,
          target: rec.cmd.attrs['path'] ?? rec.cmd.attrs['cmd'] ?? rec.cmd.attrs['handle'] ?? '',
          reason: rec.detail ?? 'unknown',
          suggestion: suggestFor(rec.cmd),
        });
      } else if (rec.status === 'pending') {
        // drain 后仍 pending：依赖永不满足（依赖失败 / 依赖 id 不存在）
        const missing = rec.cmd.depends_on.filter((d) => {
          const dep = this.#commands.get(d);
          return dep === undefined || dep.status !== 'ok';
        });
        if (missing.length > 0) {
          rec.status = 'failed';
          rec.detail = `依赖未满足：${missing.join(', ')}`;
          if (this.#reportedIssues.has(rec.cmd.id)) continue;
          this.#reportedIssues.add(rec.cmd.id);
          this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: rec.cmd.id, name: rec.cmd.name, status: 'failed', detail: rec.detail });
          issues.push({
            cmdId: rec.cmd.id,
            name: rec.cmd.name,
            target: rec.cmd.attrs['path'] ?? rec.cmd.attrs['cmd'] ?? '',
            reason: rec.detail,
            suggestion: `依赖 ${missing.join(', ')} 未成功（失败或不存在）。请检查依赖 id 是否正确，或改道重发本命令。`,
          });
        }
      }
    }
    return issues;
  }

  /** 组装易变尾注入块（结构化错误 / high 骨架 / peek 结果 / 原生工具结果）。 */
  #buildInjections(issues                            , level             )                                                                              {
    const blocks                                           = [];
    let highInjected = false;

    // 1. 结构化失败/拒绝/依赖错误（三种重入事由之一；final-only 档除外——预算已枯竭）
    if (level !== 'final-only') {
      for (const issue of issues) {
        blocks.push({
          role: 'user',
          content: `[tf-stream:error id=${issue.cmdId} cmd=${issue.name}${issue.target ? ` target=${issue.target}` : ''}] ${issue.reason}\n建议：${issue.suggestion}`,
        });
      }
    }

    // 2. high 观测反馈（info_gain=high；none/low 永不注入；final-only 停止）
    //    v0.2 语义对齐上游 ThinkFlow："成功结果按序完整反馈一次"（省 token 的主因是消灭回合数，
    //    不是骨架——2026-11-15 真连证据：模型不 peek 直接幻觉确认，R2/R4/C1 因此失败）。
    //    tf-read 成功 → 注入完整原文；超过 READ_FEEDBACK_LIMIT 截断为中段省略 + 头尾保留，
    //    并提示 tf-peek 精确取回；骨架只作为超大文件的替代形态。
    if (level === 'normal' || level === 'high-only') {
      for (const rec of this.#commands.values()) {
        const obs = rec.observation;
        if (obs === undefined || obs.info_gain !== 'high') continue;
        // 失败命令的 obs 也是 high，但失败走结构化错误块，这里跳过（避免双重注入）
        if (rec.status !== 'ok') continue;
        if (obs.payload.kind !== 'skeleton') continue;
        if (this.#reportedObservations.has(obs.seq)) continue;
        this.#reportedObservations.add(obs.seq);
        let body        ;
        if (rec.cmd.name === 'tf-read') {
          const full = this.#obs.peek(obs.handle ?? '', 1, Number.MAX_SAFE_INTEGER);
          body = readFeedbackBody(full, obs.payload.rendered, this.#cfg.readFeedbackLimit ?? DEFAULT_READ_FEEDBACK_LIMIT);
        } else {
          body = obs.payload.rendered;
        }
        blocks.push({
          role: 'user',
          content: `[tf-stream:observation handle=${obs.handle ?? ''} key=${observationKey(rec.cmd)}]\n${body}\n（细节用 tf-peek handle="${obs.handle}" from_line=.. to_line=.. 取回）`,
        });
        highInjected = true;
      }
    }

    // 3. tf-peek 结果（need_result 通道；high-only/final-only 档暂停——预算紧张先保失败通道）
    if (level === 'normal') {
      for (const rec of this.#commands.values()) {
        if (rec.cmd.name !== 'tf-peek' || rec.status !== 'ok') continue;
        if (this.#reportedPeeks.has(rec.cmd.id)) continue;
        this.#reportedPeeks.add(rec.cmd.id);
        blocks.push({
          role: 'user',
          content: `[tf-stream:peek handle=${rec.cmd.attrs['handle'] ?? ''} lines=${rec.cmd.attrs['from_line'] ?? 1}-${rec.cmd.attrs['to_line'] ?? 'end'}]\n${rec.output ?? ''}`,
        });
      }
    }

    // 4. 原生 tool_call 结果（阻塞通道回灌，任意档都注入——它们是模型的即时需求）
    blocks.push(...this.#pendingNativeBlocks);
    this.#pendingNativeBlocks = [];

    return { blocks, highInjected };
  }

  // ------------------------------------------------------------------ 账本

  #record(record              )       {
    this.#records.push(record);
  }

  #ledgerWrite(type                   , data         )       {
    if (this.#ledger === undefined) return;
    try {
      this.#ledger.record(type, data);
    } catch (error) {
      // 账本落盘失败不毁任务：内存 records 已有全量事实，告警出口保证不静默（红线 5）
      this.#warn(`ledger 落盘失败（${type}），事实已保留在内存 records`, error);
    }
  }
}

function safeToolLog(ports             , turn        , step        )                                             {
  try {
    return ports.events?.toolLog(turn, step);
  } catch {
    return undefined;
  }
}

/** 命令指纹（重复 id 幂等判定）：名称 + 属性 + 正文（tf-write）。确定性序列化。 */
function commandFingerprint(cmd           )         {
  const attrs = Object.keys(cmd.attrs).sort().map((k) => `${k}=${cmd.attrs[k]}`).join('&');
  return `${cmd.name}|${attrs}|${cmd.body ?? ''}`;
}

/** tf-read 成功反馈的完整原文默认上限（字符）——超过则头尾保留、中段省略。
 *  8000 字符 ≈ 4k tokens：上游 ThinkFlow 实证"省 token 主因是消灭回合数"，完整反馈
 *  远省于基线的多回合重读；截断边界 lottery（恰好切掉答案行）在 2026-11-15 sanity 实测，
 *  故阈值取宽。 */
export const DEFAULT_READ_FEEDBACK_LIMIT = 8000;

function readFeedbackBody(full               , skeleton        , limit        )         {
  if (full === null) return `${skeleton}\n（原文不可取回，仅骨架；tf-peek 可按行段重试）`;
  if (full.length <= limit) return full;
  const headCut = Math.max(0, Math.floor(limit * 0.7));
  const tailCut = Math.max(0, Math.floor(limit * 0.2));
  const omitted = full.length - headCut - tailCut;
  return `${full.slice(0, headCut)}\n……（中段省略 ${omitted} 字符；tf-peek handle=<句柄> from_line=.. to_line=.. 精确取回）……\n${full.slice(full.length - tailCut)}`;
}

/** 工具批失败取因：ToolBatchExecutionError 把真实错误包在 cause/partial 里（dsh-tools
 *  shared-DTdn5dXO.js），只记 message 会把根因吞掉（2026-11-15 真连 W1 教训）。 */
function describeToolError(error         )         {
  const top = error instanceof Error ? error.message : String(error);
  const cause = (error                       )?.cause;
  const parts           = [top];
  let cur = cause;
  for (let depth = 0; cur !== undefined && depth < 4; depth += 1) {
    if (cur instanceof Error) {
      parts.push(`cause: ${cur.message}`);
      cur = (cur                       ).cause;
    } else if (cur !== null && typeof cur === 'object') {
      const partial = (cur                         ).partial ?? cur;
      parts.push(`cause: ${JSON.stringify(partial).slice(0, 400)}`);
      cur = (cur                       ).cause;
    } else {
      parts.push(`cause: ${String(cur)}`);
      cur = undefined;
    }
  }
  return parts.join(' | ').slice(0, 500);
}

function suggestFor(cmd           )         {
  if (cmd.name === 'tf-write') return '请换一个可写的路径重发（可换新 id 避免冲突），或修正文件内容后重试。';
  if (cmd.name === 'tf-bash') return '请检查命令本身（语法/依赖/工作目录），修正后重发，或改道用 tf-write 落地产物。';
  if (cmd.name === 'tf-read') return '请确认路径存在（可先用 tf-bash ls 查看），或改用其他来源。';
  if (cmd.name === 'tf-peek') return 'handle 必须来自句柄目录增量（obs:<family>:<callId>@v<version>），请核对后重发。';
  return '请根据失败原因修正后重发该命令（可换新 id）。';
}

function observationKey(cmd           )         {
  return cmd.attrs['path'] ?? cmd.attrs['cmd'] ?? cmd.attrs['handle'] ?? cmd.name;
}

function blockTextOf(content         )         {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'string') return block;
      if (block !== null && typeof block === 'object' && 'text' in block && typeof (block                      ).text === 'string') {
        return (block                    ).text;
      }
      return JSON.stringify(block);
    }).join('\n');
  }
  return String(content);
}

function finishDetail(finish                  )         {
  if (finish.kind === 'error') return `${finishCode(finish)}: ${finishMessage(finish)}`;
  return finishMessage(finish);
}

/** RenderMessage → GenerateOptions.messages 线格式（loop-built 请求：首条 system 携带系统提示）。 */
function toWireMessages(messages                          )                                   {
  return messages.map((m) => ({ role: m.role, content: [{ type: 'text'         , text: m.content }] }));
}

/**
 * 流归一化 shim（镜像 LlmRuntime.stream 的异常归一化契约，types.d.ts:456）。
 * 真实宿主路径不需要（ctx.llm.stream 已归一化）；离线直连适配器（mock）时使用。
 */
export function normalizeStreamShim(inner                                )                                  {
  let finished = false;
  async function* run()                                  {
    try {
      for await (const chunk of inner) {
        if (chunk.type === 'finish') finished = true;
        yield chunk;
      }
    } catch (error) {
      if (!finished) {
        finished = true;
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
            code: 'ADAPTER_THROWN',
          },
        };
      }
    }
  }
  return run();
}

// ---------------------------------------------------------------------------
// 会话事件写入器（真实宿主路径；形状镜像内建 loop 的 append 调用）
// ---------------------------------------------------------------------------

/**
 * 从 duck-typed Session 构造 TurnEventWriter。
 * 事件形状对照：turn/start {turn}（:731）、step/start {turn,step}（:757）、
 * step/end {turn,step}（:781）、turn/end {turn,reason}（:819）、
 * assistant/message {turn,step,message,usage?,stream}（:949，surfaceOp:'append'）、
 * assistant/attempt {turn,step,stream}（:924）。assistant message 形状镜像
 * dsh-llm createAssistantMessage（lib/types/message.js:64-73）：{id, role:'assistant',
 * content:[{type:'text',text}], source:{kind:'model', provider, model}}（探针 C 实测可写）。
 */
export function createSessionEventWriter(session         )                              {
  const s = session                                                                                     ;
  if (s === undefined || typeof s.append !== 'function') return undefined;
  const append = (type        , data         , opts          )       => {
    s.append (type, data, opts);
  };
  return {
    turnStart(turn) {
      append('turn/start', { turn });
    },
    stepStart(turn, step) {
      append('step/start', { turn, step });
    },
    assistantMessage(turn, step, text, info) {
      const usageField = info.usage === undefined ? {} : { usage: info.usage };
      if (info.finish.kind === 'error' || info.finish.kind === 'aborted') {
        if (text.length > 0) {
          // 中断但有部分正文：assistant/message + interrupted（镜像内建 :891-905）
          append('assistant/message', {
            turn, step,
            message: makeAssistantMessage(text),
            interrupted: true,
            ...usageField,
            stream: [],
          }, { surfaceOp: 'append' });
        } else {
          append('assistant/attempt', { turn, step, stream: [] });
        }
        return;
      }
      if (text.length === 0) {
        // 成功终止但无文本：assistant/attempt（镜像内建 :906-915 的空内容分支）
        append('assistant/attempt', { turn, step, stream: [] });
        return;
      }
      append('assistant/message', {
        turn, step,
        message: makeAssistantMessage(text),
        ...usageField,
        stream: [],
      }, { surfaceOp: 'append' });
    },
    stepEnd(turn, step) {
      append('step/end', { turn, step });
    },
    turnEnd(turn, reason) {
      append('turn/end', { turn, reason });
    },
    finalAnswer(turn, step, text) {
      append('assistant/message', {
        turn, step,
        message: makeAssistantMessage(text),
        stream: [],
      }, { surfaceOp: 'append' });
    },
    toolLog(turn, step) {
      return { turn, step };
    },
  };
}

function makeAssistantMessage(text        )                                                                                                          {
  return {
    id: randomUUID(),
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model' },
  };
}

// ---------------------------------------------------------------------------
// ③ StreamLoopAgent —— duck-typed Agent（dsh-agent/lib/types/runtime-types.d.ts 的运行面）
// ---------------------------------------------------------------------------

                                      
             
                                                                                 
                             
                                                               
                                                        
                                                                      
                                                                                 
                                                                        
                                                                       
                                                                 
                
                                                         
                                                                           
                                                                          
                                                                     
                             
                                                          
 

/**
 * StreamLoopAgent：headless 消费的最小运行面（dsh-headless/lib/index.js:336-376 实测）：
 *   .id / .session / .status / .model / .whenIdle() / .followup(message) /
 *   .cancel(cause, options?) / .ctx（工具管线用）。
 * 不是 Cordis Service（本地插件无 cordis 副本可用，见文件头）；生命周期由工厂的 dispose 承担。
 */
export class StreamLoopAgent {
           id        ;
           session         ;
           ctx         ;
           #driver                    ;
           #storedHandle                             ;
           #warning                                             ;
           #inbox                                            = [];
  #status                     = 'idle';
  #running                           ;
  #cancelCause                                                    ;
  #selection                                                               ;
  #disposeScope                                   ;
  #disposed = false;

  constructor(deps                     ) {
    this.id = deps.id;
    this.session = deps.session;
    this.#driver = deps.driver;
    this.#storedHandle = deps.storedHandle;
    this.#warning = deps.onWarning ?? (() => {});
    this.#selection = deps.modelSelection ?? { provider: '', model: '' };
    // 作用域 key = agent 实例本身（镜像内建 createScope(loopCtx, this)）。宿主工具执行器
    // selectExecutor(input.agent) 与守卫 chainLayers(exec.agent) 都按 scopeChainOf(agent)
    // 选层（dsh-tools / dsh-tools-guards rc.3）：key 用别的对象时永远解析到根层——
    // desktop/web 组合的根层没有 fs/shell 工具（standard.patch.yml 挪进了 preset 层）。
    if (deps.scopeModule !== undefined && deps.ctx !== undefined && deps.ctx !== null) {
      try {
        const scope = deps.scopeModule.createScope(deps.ctx, this);
        this.ctx = scope.ctx;
        this.#disposeScope = () => scope.dispose();
        debugTrace('agent.scope.minted', { id: this.id });
      } catch (error) {
        this.ctx = deps.ctx;
        this.#warning(`agent "${this.id}": dsh-scope.createScope 失败：回退 ownerCtx（桌面端 preset 绑定/工具解析可能失败）`, error);
      }
    } else {
      this.ctx = deps.ctx;
    }
  }

  get status()                     {
    return this.#status;
  }

  /** dsh-agent runtime-types.d.ts:46-64 Model 面。 */
  get model()   
                                                                                                   
                                                                                           
    {
    return {
      current: () => (this.#selection.provider === '' ? undefined : { ...this.#selection }),
      select: (selection) => {
        this.#selection = { ...selection };
        this.#driver.applySelection(selection);
        // model/selection 是 known-event 类型（dsh-session known-event-types.js）；shape = ModelSelection
        this.#appendSessionEvent('model/selection', { ...selection });
      },
    };
  }

  /** 提交一条用户消息（headless:361 的入口）。语义：入队 → 空闲时开新回合。 */
  followup(message                                                                                                       )       {
    if (this.#disposed) throw new Error(`agent "${this.id}": followup after dispose`);
    const text = message.content
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block && typeof (block                      ).text === 'string' ? (block                    ).text : ''))
      .join('\n');
    if (text.trim() === '') throw new Error(`agent "${this.id}": followup 消息没有文本内容`);
    debugTrace('followup', { id: this.id, chars: text.length });
    // 会话落盘（user/message 是 surface 事件，须 surfaceOp:'append'；镜像内建 :865）
    this.#appendSessionEvent('user/message', message, { surfaceOp: 'append' });
    this.#inbox.push({ text, message });
    if (this.#status === 'idle') this.#startNextTurn();
  }

  /** 桌面端 prompt(mode:'steer') 入口（dsh-api-session-controller prompt:38770）。
   *  单流语义偏离声明：内建 steer 注入运行中回合的下一步；本实现插队到队首，
   *  在下一回合边界生效（回合运行中不中途打断——与单流协议"流内不打断"一致）。 */
  steer(message                                                                                                       )       {
    if (this.#disposed) throw new Error(`agent "${this.id}": steer after dispose`);
    const text = message.content
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block && typeof (block                      ).text === 'string' ? (block                    ).text : ''))
      .join('\n');
    if (text.trim() === '') throw new Error(`agent "${this.id}": steer 消息没有文本内容`);
    debugTrace('steer', { id: this.id, chars: text.length });
    this.#appendSessionEvent('user/message', message, { surfaceOp: 'append' });
    this.#inbox.unshift({ text, message });
    if (this.#status === 'idle') this.#startNextTurn();
  }

  /** 桌面端空内容续跑路径读取的 inbox 面（prompt:37548）。单流无 step 级注入，
   *  恒为空队列——续跑请求按 session/agent-busy 语义被拒（如实降级，不伪造）。 */
  get inbox()                                               {
    return { nextTurn: [], nextStep: [] };
  }

  /** 桌面端维护包裹（prompt/agent 生命周期路径）。无独立维护面 → 直通透传。 */
  runMaintenance   (operation                      )                 {
    return operation();
  }

  /** dsh-agent runtime-types.d.ts:191 whenIdle：回合与队列全部落定后 resolve。 */
  whenIdle()                {
    if (this.#running !== undefined) return this.#running;
    return Promise.resolve();
  }

  /** dsh-agent runtime-types.d.ts:184 cancel。keepInbox 缺省 true（保留待处理输入）。 */
  cancel(cause         , options                          )       {
    const keepInbox = options?.keepInbox ?? true;
    this.#cancelCause = { cause, keepInbox };
    this.#driver.cancel(cause);
    if (!keepInbox) this.#inbox.length = 0;
  }

  /** 取消并释放（工厂 dispose 的内部路径）。 */
  async dispose()                {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#cancelCause === undefined) this.cancel(new Error(`agent "${this.id}" lifecycle disposed`), { keepInbox: true });
    try {
      await this.#running;
    } catch (error) {
      this.#warning(`agent "${this.id}": 回合协程退出异常（dispose 吸收并告警，不静默）`, error);
    }
    try {
      await this.#storedHandle?.close();
    } catch (error) {
      this.#warning(`agent "${this.id}": 持久化句柄关闭失败`, error);
    }
    try {
      await this.#disposeScope?.();
    } catch (error) {
      this.#warning(`agent "${this.id}": agent scope 释放失败（不阻断 dispose）`, error);
    }
  }

  /** 开下一回合（inbox 逐条串行驱动）。 */
  #startNextTurn()       {
    const next = this.#inbox.shift();
    if (next === undefined) return;
    this.#status = 'running';
    this.#running = (async () => {
      try {
        this.#driver.pushUserTask(next.text);
        await this.#driver.runTurn();
      } catch (error) {
        // fail-open：回合异常必须浮出（headless 靠 whenIdle 拒绝感知失败）；告警出口保证有日志
        this.#warning(`agent "${this.id}": 回合异常上抛`, error);
        throw error;
      } finally {
        this.#running = undefined;
        if (this.#cancelCause !== undefined) {
          this.#status = 'idle';
          if (!this.#cancelCause.keepInbox) this.#inbox.length = 0;
          this.#cancelCause = undefined;
          return;
        }
        if (this.#inbox.length > 0 && !this.#disposed) {
          this.#startNextTurn();
          return;
        }
        this.#status = 'idle';
      }
    })();
  }

  #appendSessionEvent(type        , data         , opts                           )       {
    const session = this.session                                                                            ;
    if (session === undefined || typeof session.append !== 'function') return;
    try {
      const appended = session.append(type, data, opts);
      debugTrace('session.append', { type, seq: (appended                                )?.seq });
    } catch (error) {
      this.#warning(`agent "${this.id}": 会话事件 ${type} 写入失败（fail-open 继续，事实见内存台账）`, error);
    }
  }
}

// ---------------------------------------------------------------------------
// ④ createStreamAgentFactory —— AgentFactory（dsh-agent/lib/types/index.d.ts:155-190）
// ---------------------------------------------------------------------------

                                      
                                                                                                                                         
                                       
                                    
 

/**
 * sessions.prepare() 返回原始 Session（rc.3 实测：内建 loop 用 SessionPreparation.create
 * 包一层才得到 {session, [dispose]}，dsh-session/lib/index.js:949-973）。这里归一化两种形态。
 */
function normalizePreparation(raw         )                                                      {
  if (raw !== null && typeof raw === 'object' && 'session' in (raw                           )) {
    return raw                                                       ;
  }
  return { session: raw };
}

                                     
                                                     
                                                                                 
 

                                   
                    
                 
                           
                     
 

                      
                                     
                      
 

                                         
                                                         
        
                                   
                                
                                   
                                                          
    
                                                                           
                                                                                                                               
                                                          
 

                                         
                    
                        
                 
                            
                               
                                  
                       
                                                                 
 

                                         
                          
                        
                                  
                       
                                                                 
 

                                  
                         
                           
 

function assertSessionId(id        )       {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`[stream-loop] sessionId must be a non-empty string, got ${String(id)}`);
  }
}

// ---------------------------------------------------------------------------
// dsh-scope 作用域获取（桌面端 Agent preset 绑定的硬要求）
// ---------------------------------------------------------------------------

                               
                                                                            
                 
                                       
                             
    
 

async function unwrapScopeModule(mod         )                                    {
  const m = mod                                                                  ;
  if (typeof m?.createScope === 'function') return m                ;
  if (typeof m?.default?.createScope === 'function') return m.default                ;
  return undefined;
}

let dshScopeCache                                               ;
const hostModuleCache = new Map                                      ();

/** 获取宿主同源的模块（bundle 形态下 bare import 不可达，必须走宿主 loader 的 internal 通道）：
 *  ① entry ctx 的 loader.import（bare 名走 loader 的 internal 通道 → 宿主副本）；
 *  ② loader.internal.import 直达；
 *  ③ 普通 dynamic import（本地 node_modules 形态可用；bundle 形态解析失败）。
 *  全部失败返回 undefined（调用方按需降级/fail-open）。 */
async function acquireHostModule(ctx         , specifier        )                               {
  const cached = hostModuleCache.get(specifier);
  if (cached !== undefined) return cached;
  const operation = (async ()                               => {
    const anyCtx = ctx     
                
                                              
                                                                                             
        
     ;
    const loader = anyCtx?.loader;
    if (typeof loader?.import === 'function') {
      try {
        return await loader.import(specifier);
      } catch { /* 降级下一路径 */ }
    }
    const internal = loader?.internal;
    if (typeof internal?.import === 'function') {
      try {
        return await internal.import(specifier, undefined, {});
      } catch { /* 降级下一路径 */ }
    }
    try {
      return await import(specifier);
    } catch { /* 全路径不可达 */ }
    return undefined;
  })();
  hostModuleCache.set(specifier, operation);
  return operation;
}

/** 获取宿主同源的 dsh-scope 模块（kScope Symbol 必须与宿主同一实例）。
 *  全部失败返回 undefined（调用方降级 ownerCtx——headless 不受影响，桌面端 preset 绑定会失败）。 */
async function acquireDshScope(ctx         )                                    {
  dshScopeCache ??= acquireHostModule(ctx, '@deepseek-ai/dsh-scope').then((mod) => unwrapScopeModule(mod));
  return dshScopeCache;
}

/**
 * AgentFactory 实现（F1 路线：全局 setFactory 槽位；内建 loop 用 profile patch 停用）。
 * 创建序列镜像 dsh-agent-loop/lib/index.js:1668-1703（createAgent）与 :1710-1775（resume）：
 *   sessions.prepare → persistence.create/open → enter/announce 双公告 → setup → {agent, dispose}。
 * 与内建实现的差异（如实记录，详见 results 文档）：
 *   - agentCtx = ownerCtx（无 cordis 副本，agent 级 scope 不可用）；
 *   - ReactLoopAgent 换成 StreamLoopAgent（无 cordis scope，生命周期由 dispose 显式承担）；
 *   - resume 的 interruptedTurnClosers 修复未复刻（全量 seed 重放，开放 turn 由缺失的 turn/end 呈现）。
 */
export function createStreamAgentFactory(deps                        )   
                                                                                            
                                                                                       
  {
  const warning = deps.onWarning ?? (() => {});

  async function initialize(ownerCtx         , args   
                      
                                                                                                                   
                                                                                  
                                                                                                                                                              
                                         
                                    
                                   
                                                                   
                                 
                          
                         
   )                           {
    const sessions = deps.ctx.sessions;
    if (sessions === undefined || typeof sessions.prepare !== 'function') {
      throw new Error('[stream-loop] ctx.sessions.prepare 不可用：无法创建 agent（需要 dsh-session 服务族在位）');
    }
    let preparation = normalizePreparation(sessions.prepare(args.sessionId, args.prepareOpts));
    let stored = args.stored;
    try {
      if (stored === undefined && args.persistence !== undefined) {
        try {
          stored = {
            handle: await args.persistence.create((preparation.session                        ).header, {
              ...(args.prepareOpts.inheritedEventCount === undefined ? {} : { inheritedEventCount: args.prepareOpts.inheritedEventCount }),
              ...(args.signal === undefined ? {} : { signal: args.signal }),
            }),
            storedCount: 0,
          };
        } catch (error) {
          // 桌面端 UI 对失败的草稿会话会以同一 sessionId 重试 create：冲突 → 转 resume 语义
          // 打开已有日志（seed 冷读），不让 "session already exists" 打死会话创建。
          if (!/already exists/i.test(detailString(error))) throw error;
          debugTrace('create.conflict.fallback-resume', { sessionId: args.sessionId });
          const open = (args.persistence     
                                                                                       
                                     
                                                                                                
                              
                                           
               
           ).open;
          if (open === undefined) throw error;
          const handle = await open.call(args.persistence, args.sessionId, 'write', args.signal === undefined ? {} : { signal: args.signal });
          try {
            const coldRead = await handle.read(0);
            const events = [...coldRead.events];
            preparation[Symbol.dispose]?.();
            preparation = normalizePreparation(sessions.prepare(args.sessionId, {
              ...args.prepareOpts,
              seed: events,
              ...(handle.header === undefined ? {} : { meta: handle.header }),
              ...(handle.inheritedEventCount === undefined ? {} : { inheritedEventCount: handle.inheritedEventCount }),
              ...(coldRead.eventState === undefined ? {} : { eventState: coldRead.eventState }),
            }));
            stored = { handle, storedCount: events.length };
          } catch (openError) {
            await handle.close().catch(() => {});
            throw openError;
          }
        }
      }

      debugTrace('createAgent.enter', { sessionId: args.sessionId, source: args.source });

      // Agent 级 scoped context：在 StreamLoopAgent 构造内以 agent 实例本身为 key 铸造
      // （镜像内建 createScope(loopCtx, this)——宿主工具执行器 selectExecutor(input.agent) 与
      // 守卫 chainLayers(exec.agent) 都按 scopeChainOf(agent) 选层，key 不是 agent 实例时
      // preset 层工具（desktop/web 组合的 write/edit/pwsh）永远解析不到）。此处只取同源模块。
      const dshScope = await acquireDshScope(deps.ctx);

      const { driver } = deps.createDriver({
        sessionId: args.sessionId,
        agentOptions: args.agentOptions,
        session: preparation.session,
      });
      debugTrace('driver.created');
      driver.setIdentity(args.sessionId, args.sessionId);
      // 探针 C 定案：ledger 走 plugin:tf-agent/* 私有记录（appendPluginRecord 自动 ignorable:true）。
      // 动态 import 失败（类身份/解析不可达）→ 降级内存台账，告警不静默。
      await attachSessionLedger(driver, preparation.session, warning);
      debugTrace('ledger.attached');

      const agent = new StreamLoopAgent({
        id: args.sessionId,
        session: preparation.session,
        driver,
        ctx: ownerCtx,
        scopeModule: dshScope,
        storedHandle: stored?.handle,
        modelSelection: {
          provider: args.agentOptions.provider ?? '',
          model: args.agentOptions.model ?? '',
          reasoningEffort: args.agentOptions.reasoningEffort,
        },
        onWarning: warning,
      });
      debugTrace('agent.constructed');
      driver.setAgent(agent);

      // 镜像内建 appendUnstoredSuffix（initializeAgent 进入公告前调用）：prepare 的 seed
      // 会在会话内补 session/end-seed 占位事件（seq = seed 长度）。这批内存 suffix 必须
      // 立刻落盘对齐 handle cursor，否则宿主 checkpoint flush（ctx.sessions.flush）从
      // 占位事件之后起批 → "append seq mismatch"（桌面端 resume 后首个模型请求即死）。
      if (stored !== undefined) {
        const snap = preparation.session                                                                   ;
        const suffix = typeof snap?.snapshotEvents === 'function' ? snap.snapshotEvents(stored.storedCount) : [];
        if (suffix.length > 0) {
          await stored.handle.append(suffix         );
          debugTrace('resume.suffix.flushed', { count: suffix.length });
        }
        stored.storedCount += suffix.length;
      }

      // 会话公告（镜像内建 :1571-1572）
      const detachSession = sessions.enter?.(preparation.session);
      sessions.announce?.(preparation.session);

      // setup（桌面端在此做 Agent preset 绑定与 model selection；镜像内建 :1574-1576 传 agent.ctx）
      // 工具解析说明：不重绑执行器——宿主 ToolsService.execute(input) 内部按
      // selectExecutor(input.agent) → scopeChainOf(agent 实例 = 作用域 key) 选 preset 层
      // 执行器（dsh-tools rc.3），工具批自带 agent 字段即可命中 preset 层的 write/edit/pwsh；
      // 直读 agentCtx.tools 会触发 cordis "cannot get property without inject"（2026-11-15
      // 桌面端实测教训）， entry 根服务与 agent 服务是同一实例，重绑无收益。
      const setupCommit = await args.setup?.(agent.ctx, agent);
      if (setupCommit !== undefined && setupCommit !== null && typeof (setupCommit                           ).commit === 'function') {
        (setupCommit                          ).commit();
      }

      // agent 公告（镜像内建 :1578-1579；AgentRegistry.enter/announce 无 brand 校验，duck-type 可通行）
      const agents = deps.ctx.agents;
      const detachAgent = agents?.enter?.(agent, args.parentAgent);
      if (agents?.announce !== undefined) {
        await agents.announce(agent, args.source, args.signal);
      }
      debugTrace('agent.announced');

      const dispose = async ()                => {
        try {
          await agent.dispose();
        } finally {
          try {
            detachAgent?.();
          } catch (error) {
            warning('[stream-loop] agents.detach 失败（不阻断 dispose）', error);
          }
          try {
            detachSession?.();
          } catch (error) {
            warning('[stream-loop] sessions.detach 失败（不阻断 dispose）', error);
          }
        }
      };
      return { agent, dispose };
    } catch (error) {
      // 回滚（镜像内建 finally：handle close + preparation dispose）
      try {
        await stored?.handle.close();
      } catch (closeError) {
        warning('[stream-loop] 持久化句柄回滚关闭失败', closeError);
      }
      try {
        preparation[Symbol.dispose]?.();
      } catch (disposeError) {
        warning('[stream-loop] session preparation 回滚失败', disposeError);
      }
      throw error;
    }
  }

  return {
    async createAgent(ownerCtx, options) {
      assertSessionId(options.sessionId);
      const persistence = deps.ctx.get?.('sessionPersistence')   
                                                                                                                                         
                   ;
      return initialize(ownerCtx, {
        sessionId: options.sessionId,
        prepareOpts: {
          ...(options.meta === undefined ? {} : { meta: options.meta }),
          ...(options.seed === undefined ? {} : { seed: options.seed }),
          ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
        },
        persistence,
        agentOptions: options.agentOptions ?? {},
        setup: options.setup,
        source: 'startup',
        parentAgent: options.parentAgent,
        signal: options.signal,
      });
    },

    async resume(ownerCtx, options) {
      assertSessionId(options.resumeSessionId);
      const persistence = deps.ctx.get?.('sessionPersistence')   
           
                                                                                      
                                     
                                                                                                
                              
                                           
               
           
                   ;
      if (persistence === undefined || typeof persistence.open !== 'function') {
        throw new Error('[stream-loop] cannot resume: session persistence is not configured（需要 dsh-session-persistence 后端）');
      }
      const id = options.resumeSessionId;
      const handle = await persistence.open(id, 'write', options.signal === undefined ? {} : { signal: options.signal });
      try {
        const coldRead = await handle.read(0);
        const events = [...coldRead.events];
        return await initialize(ownerCtx, {
          sessionId: id,
          prepareOpts: {
            seed: events,
            meta: handle.header,
            ...(handle.inheritedEventCount === undefined ? {} : { inheritedEventCount: handle.inheritedEventCount }),
            ...(coldRead.eventState === undefined ? {} : { eventState: coldRead.eventState }),
          },
          stored: { handle, storedCount: events.length },
          agentOptions: options.agentOptions ?? {},
          setup: options.setup,
          source: 'resume',
          parentAgent: options.parentAgent,
          signal: options.signal,
        });
      } catch (error) {
        await handle.close().catch(() => {});
        throw error;
      }
    },
  };
}

/** 探针 C 通道：经宿主同一模块副本调用 appendPluginRecord（动态 import；失败降级内存台账 + 告警）。 */
export async function attachSessionLedger(
  driver                    ,
  session         ,
  warn                                              ,
)                {
  try {
    const mod = (await import('@deepseek-ai/dsh-session'))     
                                                                                 
     ;
    if (typeof mod.appendPluginRecord !== 'function') throw new Error('appendPluginRecord 导出缺失');
    driver.attachLedger({
      record(type, data) {
        mod.appendPluginRecord (session, type, data);
      },
    });
  } catch (error) {
    // 类身份/解析失败 → 内存台账降级（driver 内存 records 永远有全量事实），告警不静默
    warn?.('[stream-loop] plugin:tf-agent ledger 落 plugin record 失败，降级内存台账（resume 后 tf-* 状态不可重放）', error);
  }
}

// ---------------------------------------------------------------------------
// ⑤ apply —— Cordis 函数插件入口（生产 preset 挂载；F1 路线接管）
// ---------------------------------------------------------------------------

                                  
                    
                 
                           
                                
                        
                               
                        
                             
                        
                        
                      
                                                                        
                             
 

/**
 * Cordis 插件名与服务依赖声明（镜像 dsh-headless/lib/index.js:100-107 的函数插件约定：
 * loader 等这些服务就绪后才调 apply，避免加载期 ctx.llm/ctx.tools 尚未挂载的时序问题）。
 */
export const name = 'stream-agent';
export const inject = ['llm', 'tools', 'agents', 'sessions'];

/**
 * 函数插件入口：
 *   ctx.agents.setFactory(factory)（F1 全局槽位；内建 agent-loop 必须已被 profile patch 停用，
 *   否则 setFactory 抛 "an agent factory is already registered"——fail-fast，不静默）。
 * 驱动器端口在 createDriver 闭包里从 ctx 现取（ctx.llm.stream / ctx.tools.execute），
 * 会话事件写入器按 session 构造（探针 C 定案的 surface 事件形状）。
 */
export default function apply(ctx   
                                                                              
                                                                                  
                                                                               
                                 
                                                        
 , config                  = {})                                                                                {
  const warning = (message        , detail          )       => {
    // 红线 5：告警走宿主 logger（可用时），否则 console.error —— 都不静默
    const logger = (ctx.get?.('logger') ?? null)                                           ;
    const text = `[stream-loop] ${message}${detail === undefined ? '' : ` :: ${detailString(detail)}`}`;
    if (logger?.warn !== undefined) logger.warn(text);
    else console.error(text);
  };

  const llm = ctx.llm ?? (ctx.get?.('llm')                                                                                         );
  const tools = ctx.tools ?? (ctx.get?.('tools')                                                                                    );
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new Error('[stream-loop] ctx.llm.stream 不可用：entry 挂载失败（需要 dsh-llm 服务在位）');
  }
  if (tools === undefined || typeof tools.execute !== 'function') {
    throw new Error('[stream-loop] ctx.tools.execute 不可用：entry 挂载失败（需要 dsh-tools 服务在位）');
  }

  // 默认模型三级回退：agentOptions（宿主 agentDefaultModel 惰性 getter）→ entry config →
  // 宿主 agentDefaultModel → 最后兜底。桌面端部署常只挂 deepseek-account 路由，
  // 硬编码 deepseek-official/deepseek-chat 会请求到无凭据的路由。
  const agentDefaultModel = (ctx.get?.('agentDefaultModel') ?? null)                                                                                                   ;
  const defaultSelection = agentDefaultModel?.currentSelection?.() ?? {};
  const factory = createStreamAgentFactory({
    ctx: ctx                                            ,
    createDriver({ agentOptions, session }) {
      const cfg                     = {
        provider: agentOptions.provider || config.provider || defaultSelection.provider || '',
        model: agentOptions.model || config.model || defaultSelection.model || '',
        reasoningEffort: agentOptions.reasoningEffort ?? config.reasoningEffort ?? defaultSelection.reasoningEffort,
        maxParallelToolCalls: config.maxParallelToolCalls,
        maxReentries: config.maxReentries,
        streamIdleTimeoutMs: config.streamIdleTimeoutMs,
        budgetTokens: config.budgetTokens,
        nativeToolSchemas: config.nativeToolSchemas,
        systemPrompt: config.systemPrompt,
        protocolText: config.protocolText,
        invariants: config.invariants,
      };
      const driver = new SingleStreamDriver(
        {
          stream: (options) => llm.stream(options),
          executeTools: (input) => tools.execute(input),
          events: createSessionEventWriter(session),
          onWarning: warning,
        },
        cfg,
      );
      return { driver };
    },
    onWarning: warning,
  });

  if (ctx.agents?.setFactory === undefined) {
    throw new Error('[stream-loop] ctx.agents.setFactory 不可用：无法接管 agent 创建（需要 dsh-agent 服务在位）');
  }
  const detachFactory = ctx.agents.setFactory(factory);
  if (config.announceTakeover === true) {
    console.error('[stream-loop] TAKEOVER-ACTIVE: agent factory registered via setFactory (built-in agent-loop must be disabled by profile patch)');
  }

  // 会话投影注册（桌面端硬依赖，内建 agent-loop 在 Service.init 注册——dsh-agent-loop rc.3:50110）：
  // 客户端模型选择器的 projected 数据面 = 服务端 modelSelection 投影；缺失时
  // dsh-client-ui-model-selection 的 syncInputs 永远停在 status:"loading"（"正在加载模型…"），
  // 会话列表/写作工具等也读该投影族。经宿主 loader 取同源 @deepseek-ai/dsh-agent 的导出注册。
  // fail-open（红线 5）：服务/模块/定义任一不可达 → 告警不静默，headless 行为不变。
  const sessionProjections = (ctx                                    ).sessionProjections
    ?? (ctx.get?.('sessionProjections')                                                                    );
  if (sessionProjections === undefined || typeof sessionProjections.register !== 'function') {
    warning('ctx.sessionProjections.register 不可达：跳过 modelSelection 投影注册（headless 不受影响；桌面端客户端模型选择器会停在加载态）');
  } else {
    acquireHostModule(ctx, '@deepseek-ai/dsh-agent')
      .then((mod) => {
        const definition = (mod                                                                )?.modelSelectionProjectionDefinition;
        if (definition === undefined) {
          warning('@deepseek-ai/dsh-agent.modelSelectionProjectionDefinition 不可达：跳过注册（同上，客户端模型选择器会停在加载态）');
          return;
        }
        return Promise.resolve(sessionProjections.register(definition)).then(() => {
          debugTrace('projection.modelSelection.registered');
        });
      })
      .catch((error) => {
        warning('modelSelection 投影注册失败（fail-open 继续）', error);
      });
  }

  const dispose = ()       => {
    try {
      detachFactory?.();
    } catch (error) {
      warning('[stream-loop] factory 卸载失败', error);
    }
  };
  ctx.effect?.(() => dispose, 'streamAgent.setFactory()');
  return { factory, dispose };
}

function detailString(detail         )         {
  if (detail instanceof Error) return detail.message;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/** 诊断追踪（STREAM_LOOP_DEBUG=1 时向 stderr 打里程碑；生产默认关闭，不产生噪音）。 */
export function debugTrace(milestone        , detail          )       {
  if (process.env.STREAM_LOOP_DEBUG !== '1') return;
  console.error(`[stream-loop:debug] ${milestone}${detail === undefined ? '' : ` :: ${detailString(detail)}`}`);
}
