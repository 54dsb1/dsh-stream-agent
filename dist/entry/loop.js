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

import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TfStreamParser, splitEditBody } from '../kernel/parser.js';
                                                                  
import { ContextRenderer, assertRequestPrefix, PrefixBrokenError, renderHash, contextRebasedLine } from '../kernel/render.js';
                                                                          
import { ObservationLedger, renderReadIndex } from '../kernel/obs.js';
                                                          
import { checkFinalSummary } from '../kernel/final.js';
import {
  compactItems,
  renderStateDigest,
  renderEffectLine,
  shouldElideEffect,
} from '../kernel/compaction.js';
                                                                     
import {
  checkTaskBudgetFloor,
  observeBudget,
  shouldCompact,
  shouldStopForSteps,
} from '../kernel/governor.js';
import {
  CHANNELS,
  TIERS,
  DEFAULT_CHANNEL,
  DEFAULT_TIER,
  DEFAULT_BUDGET_TOKENS_OBSERVE,
  getChannel,
  getTier,
  isChannelId,
  isTierId,
  isLegacyModeId,
  resolveLegacyMode,
  publicChannelCatalog,
  publicTierCatalog,
  publicLegacyModeCatalog,
} from '../kernel/modes.js';
                                                                        
import { isLang } from '../kernel/control-bar.js';
import {
  appendLedgerRecord,
  createJsonlPersistence,
  ledgerFileOf,
  loadLedgerRecords,
  resolveStateDir,
  withEventCapture,
} from './json-persistence.js';
                                                                
import { createCodeExecutor, DEFAULT_CODE_QUOTA, looksLikePtcRuntime } from './ptc-bridge.js';
                                                                             
import { asPluginEffect, getService } from './cordis-compat.js';
import { readPersistedControl, resolveControlState, writePersistedControl } from './control-state.js';
                                                                 
import { appendIntentRecord, intentFileOf, loadIntentRecords, pendingIntents, reconcilePendingIntents } from './intent-log.js';
import { clearTakeover, markTakeover, markDegrade, takeover } from './takeover-registry.js';
import { ToolSurfaceHolder, degradedLine } from './tool-surface.js';
                                                                                                      
import { composeProtocolText, asProtocolLevel, PROTOCOL_SECTION_IDS } from '../kernel/protocol.js';
                                                                              
import { VERSION } from '../version.js';

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
    // edit(file_path, old_string, new_string, replace_all?)（dsh-tool-fs/lib/index.js，0.3.0 F1 映射）、
    // apply_patch(input)（同上，*** End of File 锚实现 EOF 追加）、
    // grep(pattern, path?, include?) / glob(pattern, path?)（dsh-tool-fs-search/lib/index.js，F2 映射）、
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
      case 'tf-edit': {
        // F1：精确替换映射宿主 edit（old → new；replace_all=false 时宿主要求恰好出现一次）。
        // body 用 OLD/NEW 标记行分隔两段字面量；解析失败回结构化失败，绝不静默改成全文重写。
        const split = splitEditBody(cmd.body ?? '');
        if (split === null) return null;
        const args                          = {
          file_path: cmd.attrs['path'] ?? '',
          old_string: split.old,
          new_string: split.new,
        };
        if (cmd.attrs['replace_all'] === 'true') args['replace_all'] = true;
        return { name: 'edit', arguments: args };
      }
      case 'tf-append': {
        // F1：只追加，不修改既有内容。
        // - anchor 属性给定时：映射宿主 edit，在唯一锚点字面量之后插入（锚点行末补一个换行；
        //   换行规则确定：new_string = anchor + '\n' + body）。
        // - 无 anchor：EOF 追加映射宿主 apply_patch 的 `*** End of File` 锚（宿主原生支持，
        //   不自建文件 IO）；正文逐行加 '+' 前缀成补丁。
        const body = cmd.body ?? '';
        if (body === '') return null;
        const anchor = cmd.attrs['anchor'];
        if (anchor !== undefined && anchor !== '') {
          return {
            name: 'edit',
            arguments: { file_path: cmd.attrs['path'] ?? '', old_string: anchor, new_string: `${anchor}\n${body}` },
          };
        }
        const lines = body.split('\n');
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // 末尾换行不产生空补丁行
        const patch = ['*** Begin Patch', `*** Update File: ${cmd.attrs['path'] ?? ''}`, '*** End of File', ...lines.map((l) => `+${l}`), '*** End Patch'].join('\n');
        return { name: 'apply_patch', arguments: { input: patch } };
      }
      case 'tf-grep': {
        // F2：搜索只回匹配行（宿主 grep 自带行号与按文件分组），不回全文；
        // 权限与工作区边界由宿主决定（不自建遍历）。
        const args                          = { pattern: cmd.attrs['pattern'] ?? '' };
        if (cmd.attrs['path'] !== undefined && cmd.attrs['path'] !== '') args['path'] = cmd.attrs['path'];
        if (cmd.attrs['include'] !== undefined && cmd.attrs['include'] !== '') args['include'] = cmd.attrs['include'];
        return { name: 'grep', arguments: args };
      }
      case 'tf-glob': {
        const args                          = { pattern: cmd.attrs['pattern'] ?? '' };
        if (cmd.attrs['path'] !== undefined && cmd.attrs['path'] !== '') args['path'] = cmd.attrs['path'];
        return { name: 'glob', arguments: args };
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
      case 'tf-skill': {
        // v0.4.0（§6.4 高频例外）：技能装载专用语法 → 宿主 skill（{name} 单必填）。
        return { name: 'skill', arguments: { name: cmd.attrs['name'] ?? '' } };
      }
      case 'tf-ask': {
        // v0.4.0（§6.4）：阻塞式提问专用语法 → 宿主 ask_user_question。
        // {questions:[{id,question,header?,options?:[{label}]}]}；选项逗号分隔取标签
        // （带描述的复杂选项走 tf-call body JSON）。options="A,B" → [{label:'A'},{label:'B'}]。
        const options = (cmd.attrs['options'] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '')
          .map((label) => ({ label }));
        const question                          = {
          id: cmd.id,
          question: cmd.attrs['q'] ?? '',
        };
        if (cmd.attrs['header'] !== undefined && cmd.attrs['header'] !== '') question['header'] = cmd.attrs['header'];
        if (options.length > 0) question['options'] = options;
        return { name: 'ask_user_question', arguments: { questions: [question] } };
      }
      default:
        return null; // tf-peek / tf-final / tf-code 由驱动器内部处理（tf-code 走 executeCode 端口）
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

/**
 * v0.4.3（P0-7①）：request 事件的尺子字段。聚合三元组 **ΣproviderInput / N / resetCount**
 * 全部可从 request 记录外部复算：
 *  - ΣproviderInput = Σ providerInputTokens（计费输入 = 未命中 input + cacheRead + cacheWrite，
 *    口径对齐 dsh-llm Usage；适配器未上报的请求该字段缺省——不写 0 噪声）；
 *  - N = kind==='request' 的记录数（= requestCount）；
 *  - resetCount = 记录序列里 resetSeq 相对上一条递增的次数（= 最后一条的 resetSeq）。
 * 命名映射：cacheRead = dsh-llm Usage.cacheReadTokens；cacheWrite = cacheWriteTokens；
 * output = outputTokens；providerInputTokens = inputTokens + cacheRead + cacheWrite。
 * prefixTokensEst 是本地估算（Σcontent 字符 / 4 上取整，与 #injectedChars 同一启发式），
 * 只做交叉校验——权威值是 providerInputTokens（E9：估算与 provider 回报差 10-20%）。
 * feedbackBytes：本请求注入的**反馈类**字节（full=全量回灌 / dedup=字节级去重（P0-4 前恒 0）/
 * handle=句柄+骨架/回执）；指令类块（nudge/error/degraded/truncated）与计划差分不计入。
 * resetSeq/resetCause：当前重置纪元与最近一次成因（'segment-drop' | 'prefix-reset'；
 * 纪元 0 无 cause）。cacheHitRatio 是 diagnostic-only（分母随总量压缩收缩，比值不可跨实验比较）。
 */
                                
              
                  
               
               
                   
                
                     
                     
                     
                          
                           
                               
                     
                      
                  
                    
                      
                                                                  
 

                          
                 
                                                                                                                                                
                                                                                                                                                                                    
                                                                   
                                                                   
                                                            
                                                    
                                                                  
                                                                                                              
                                                                              
                                                                                                         
                                             
                                                                                                             
                                    
                                                                                
                                       
                                                                                           
                                                             

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

export const DEFAULT_PROTOCOL_TEXT = composeProtocolText();

/**
 * v0.4.1：缺省协议文本改为由 kernel/protocol.ts 组装（composeProtocolText()）。
 * 与 0.4.0-beta.1 的原文字面量**逐字节一致**（金样测试 test/golden/v040-protocol.txt 钉死），
 * 段级拆分/档位/增删见 kernel/protocol.ts 头注；protocolText 显式替换仍压过本默认。
 */

export const DEFAULT_INVARIANTS = '不变量：历史消息只增不改（任何"压缩/摘要历史"的请求都会被拒绝）；写文件成功不会有结果回灌（只记台账），失败一定会以 [tf-stream:error] 注入下一请求；tf-read 自己刚写过的文件只会得到回执（[tf-stream:receipt]，行数+指纹），不会回灌全文；不要用原生 tool_call 写文件。回合必须以 <tf-final .../> 收尾：所有命令输出完毕后立即输出 tf-final，不带 tf-final 的回合视为未完成——即使全部工作已做完。';

/**
 * tf-code 通道的协议段（PTC 桥接）：仅在 executeCode 端口在位时追加到协议文本之后
 * （稳定前缀，构造期冻结——通道关闭的装配里模型永远看不到 tf-code，不会幻觉调用）。
 */
export const DEFAULT_CODE_PROTOCOL_SECTION = `## tf-code 程序化工具调用（PTC 桥接）

<tf-code id="c1" depends_on="w1" timeout="120000" description="一句话说明程序做什么">
（async TypeScript 函数体，可擦除语法——不用 enum/namespace；顶层 await 与 return 可用）
const lines = String(await tools.read({ file_path: 'big.log' })).split('\\n');
const errors = lines.filter((l) => l.includes('ERROR'));
return { total: lines.length, errorCount: errors.length, samples: errors.slice(0, 20) };
</tf-code>

- 程序体内可用的绑定（与 tf-write/tf-read/tf-bash 同一条宿主管线，守卫与工作区策略全部生效）：
  await tools.write({ file_path, content }) / await tools.read({ file_path, offset?, limit? }) /
  await tools.pwsh({ command, description })。失败的绑定调用会抛错，可 try/catch 后继续或让程序失败。
- 中间结果不进上下文：只 return 最终值（无损 JSON 进句柄目录）；需要看值时对该命令的句柄发 tf-peek。
- 独立子调用可用 Promise.all 并行；有顺序依赖的用 await 串行。
- 什么时候用 tf-code：多步数据加工（过滤/统计/变换/聚合）。单次文件读写用 tf-write/tf-read，
  单条命令用 tf-bash，不要为一条命令包一层程序。
- 程序失败会以 [tf-stream:code-error] 注入（kind + 可重试结论，kind: exception/timeout/abort/
  worker-exit/invalid-output/output-limit/protocol/sandbox-unavailable/quota-exceeded），
  修复代码后换新 id 重发；timeout 属性为毫秒数，可省略（用宿主默认）。
- 每次运行的子调用次数、输出字节、墙钟有插件级配额（超限结构化终止 kind: quota-exceeded）；
  沙箱事实（mode/enforcement）逐次记账，enforcement=partial 只覆盖文件效果、不是隔离。`;

/** v0.4.0（G2/P2）：tf-call 通用调用通道的协议段——命令表净增 1 的全部协议成本（§6.2 方案 C）。
 *  规则刻意短：一条语法 + 一条判断规则 + 一条失败处置；不逐工具展开说明（工具描述由宿主
 *  面给出，unknown-tool 的建议注入里带前缀匹配，不回灌全表）。 */
export const DEFAULT_CALL_PROTOCOL_SECTION = `## tf-call 通用调用（映射面之外的一切宿主工具）
<tf-call name="工具名" id="c1" depends_on="w1">{"参数名": "值"}</tf-call>
- body 是一个 JSON 对象（参数原样透传）；name 必须是本会话工具面里的工具名，写错会收到
  unknown-tool 注入（附相近工具名建议），核对后换新 id 重发。
- 两条高频专用语法（不走 JSON）：提问 <tf-ask q="问题" id="a1" header="标题" options="选项1,选项2"/>；
  装载技能 <tf-skill name="skill-name" id="s1"/>。
- 何时用：要用的工具不在上表 tf-* 里时（搜网页、查后台任务、委派子代理、写任务清单、office/present 等）。
  tf-* 覆盖到的操作继续用 tf-*（更短）；两者可混用，depends_on/accepts 语义一致。
- 结果按工具类型分族处理（读类结果注入、写类只记回执），与 tf-* 同一套规则；JSON 引号
  转义错误会收到 bad-json-arguments 注入，修正 body 重发即可。`;

// ---------------------------------------------------------------------------
// 0.5.0 执行通道的协议面（§3.2 能力矩阵）
// ---------------------------------------------------------------------------

/** 0.5.0（§7.5 双旋钮·读取侧）：单次 read 返回上限（字符）。超出转行锚索引（§7.3(1)）。 */
export const DEFAULT_MAX_READ_CHARS = 32_000;

/** 代码通道（preset 来源）的系统提示：不引导 tf-*（协议段 0 字符；§5.3 完全让位——
 *  "对 system prompt 的贡献为 0 字符"的让位清单不含 system 措辞本身，但引导模型输出
 *  tf-* 命令会造成幻觉调用，故整条换为通道措辞）。 */
export const DEFAULT_CODE_CHANNEL_SYSTEM_PROMPT = '你是运行在 DeepSeek Harness 里的 agent（代码通道）：像通常一样直接调用会话内的工具（数据加工用 run_code 程序）。上下文治理（压缩、状态摘要、度量）由 stream-agent 提供，不改变你的工具面。';

/** 代码通道（bridge 来源，受限窄桥）的协议段：约 200 字符，只写 tf-code 用法；
 *  不传 stateOwner / programFormat / sandboxPolicy（§5.2 第二分支）。 */
export const DEFAULT_CODE_BRIDGE_PROTOCOL_SECTION = `## tf-code（内置窄桥）
<tf-code id="c1">（async TS 函数体）</tf-code>
程序内：await tools.read({file_path}) / tools.write({file_path, content}) / tools.pwsh({command, description})。
只 return 最终值（中间结果不进上下文）；失败会以 [tf-stream:code-error] 注入。`;

/** F3：tf-code 首成功/变化结果完整注入的默认上限（字符）。4000 ≈ 2k tokens：
 *  上限内值直接可见（省一次 tf-peek 往返），超限转骨架 + 句柄（中间结果不回灌的红线不破）。 */
export const DEFAULT_CODE_VALUE_INJECT_LIMIT = 4000;

/** F4：原生 tool_call 结果单块注入的默认上限（字符），仅声明 nativeToolSchemas 时生效。
 *  6000 ≈ 3k tokens：首成功/短结果完整注入，超限转骨架 + 句柄，杜绝原生通道全量回灌。 */
export const DEFAULT_NATIVE_RESULT_LIMIT = 6000;

/** F7：长会话段边界阈值（追加区字符数）。160k 字符 ≈ 40k tokens：超过即在新回合开始处
 *  整块丢弃旧段（ADR-001：整块丢弃路线，显式缓存重置点，原文句柄化可回取）。 */
export const DEFAULT_SEGMENT_MAX_CHARS = 160_000;

/** v0.3.2：单步正文落追加区的上限（字符）。prose 通常很短；超长只截断历史摘要，
 *  当期 assistant/message 仍完整落盘（不改变可读输出）。 */
export const STEP_PROSE_COMMIT_LIMIT = 4000;

/** v0.3.2：同一回合内"输出被截断 → 要求续写"的最大次数。超过即如实 blocked，
 *  不无限重试（真机 max-tokens 截断的恢复路径需要重发完整命令，次数有界）。 */
export const MAX_TRUNCATION_RETRIES = 4;

/** v0.4.2：可转正进追加区的易变尾前缀（事实类）。瞬态指令（nudge/degraded/error）不转正。
 *  v0.4.2 新增 plan / plan-diff / receipt：计划清单与验证回执都是"发生过的事实"，
 *  必须跨请求可见——真机取证（session-6b61cb4d）：计划只在创建那一步出现一次，随后
 *  彻底消失，模型丢上下文后反复 premature-final（连续 6 步被拒）直到重入上限，任务中断；
 *  同时每请求重看计划区全是 cache miss（命中率被压到 ~64%）。 */
const DURABLE_TAIL_PREFIXES                    = [
  '[tf-stream:observation',
  '[tf-stream:peek',
  '[tf-stream:tool-result',
  '[tf-stream:replay',
  '[tf-stream:plan',
  '[tf-stream:receipt',
];

/** v0.4.0：尾块是否会在下一请求转正进追加区（同 DURABLE_TAIL_PREFIXES 判定，单点定义）。
 *  转正集合与排序集合必须是同一个谓词——否则排序后仍会有 transient 块被"夹"在中间。 */
function isDurableBlock(block                     )          {
  return DURABLE_TAIL_PREFIXES.some((prefix) => block.content.startsWith(prefix));
}

/** v0.3.2：正文归一化（连续空行压成一个；去首尾空白）——避免 "\n\n\n\n" 的空消息污染正文。 */
export function normalizeProse(text        )         {
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * v0.4.3（P0-7①）：prompt token 本地估算——Σ 消息 content 字符数 / 4 上取整。
 * 与 #injectedChars 折算（Math.ceil(chars/4)，budgetLevel O5 阶梯）同一启发式，确定性好
 * （同输入同字节）；只做交叉校验，权威值是 providerInputTokens（升级清单 E9：估算与
 * provider 回报差 10-20%，跨 provider 不可比）。
 */
export function estimatePromptTokens(messages                          )         {
  let chars = 0;
  for (const m of messages) chars += m.content.length;
  return Math.ceil(chars / 4);
}

/**
 * v0.4.0（自 0.3.3 回流）：畸形/通配闭合标签的定向纠错注入。
 *
 * 真机形态：模型把协议通配当闭合标签输出 `</tf-*>`，或给闭合标签加属性
 * `</tf-write path="x">`。parser 已把它们判 malformed(stray-close-tag) 丢弃（不进 prose），
 * 但 fail-soft 只记台账时模型全程不知道错在哪，同一会话重复犯错、无产出收场。
 * 一次注入讲清合法语法的两种形态 + 收尾方式，把"猜语法"变成"照抄正确形态"。
 */
export function malformedCloserNudge(raw        )         {
  const shown = raw.length <= 40 ? raw : `${raw.slice(0, 40)}…`;
  return [
    `[tf-stream:error cmd=protocol] 检测到无效的协议闭合标签 \`${shown}\`——已丢弃：不执行、不进入对话正文。`,
    'tf-* 协议没有通配或独立的闭合标签形态（`</tf-*>`、`</tf-命令名 属性…>` 都不是合法语法）：',
    '- 有正文的命令（tf-write/tf-edit/tf-append/tf-code/tf-plan）用配对闭合，闭合标签必须与命令名逐字一致：',
    '  `<tf-write path="a.txt" id="w1">正文</tf-write>`；',
    '- 其余命令一律自闭合：`<tf-read path="a.txt" id="r1"/>`；',
    '- 任务收束用 `<tf-final id="f1" summary="最终答案原文"/>`——不存在 `</tf-*>` 这样的流级闭合。',
    '请继续用正确的 tf-* 命令完成剩余工作，最后以 tf-final 收尾。',
  ].join('\n');
}

/** 截断到上限（保留尾部标记，便于台账核对）。 */
function capText(text        , limit        )         {
  return text.length <= limit ? text : `${text.slice(0, limit)}…（截断 ${text.length - limit} 字符）`;
}

/**
 * v0.3.2：输出截断的续写注入。带已生成内容尾部（≤800 字符）——正文命令被 max-tokens
 * 截断时，模型可以从断点继续，而不是从头重写整个文件。
 */
function truncationNudge(truncation                                 )         {
  const tail = truncation.raw.length <= 800
    ? truncation.raw
    : `…${truncation.raw.slice(truncation.raw.length - 800)}`;
  const head = truncation.reason === 'max-tokens'
    ? '上一条请求的输出触及 max tokens 上限，在句子/命令中途被截断。'
    : `上一条请求的输出在命令中途被截断（${truncation.reason}）。`;
  return [
    `[tf-stream:truncated reason=${truncation.reason}] ${head}`,
    '已完整闭合的命令都已执行，不要重复执行；未闭合的命令没有被执行。',
    '请从断点继续：把被截断的命令用**新 id**完整重发（正文命令必须给出完整内容，不能只给片段），',
    '然后继续未完成的工作；任务确实已完成则输出 tf-final（summary 写最终答案原文）。',
    tail !== '' ? `已生成部分的尾部（供续写定位）：\n${tail}` : '',
  ].filter((line) => line !== '').join('\n');
}

// ---------------------------------------------------------------------------
// 0.5.0：按执行通道组装稳定前缀四段（§3.2 能力矩阵；构造期冻结）
// ---------------------------------------------------------------------------

function composeChannelTexts(
  channel           ,
  codeSource                                          ,
  cfg                                                                                           ,
  config                    ,
)                                                                                {
  // 显式覆盖（测试注入）永远压过通道缺省
  const system = config.systemPrompt;
  const invariants = config.invariants === false ? '' : config.invariants ?? DEFAULT_INVARIANTS;
  const toolSchemas = config.nativeToolSchemas
    ?? (config.nativeTools
      ? '（本请求的原生工具 schema 见 tools 字段；未列出的宿主工具一律走 tf-call）'
      : undefined);
  if (channel === 'code') {
    // 代码通道：preset 来源协议段 0 字符（§5.3 完全让位）；bridge 来源只写 tf-code 用法
    const base = codeSource === 'bridge'
      ? (config.protocolText ?? config.codeProtocolText ?? DEFAULT_CODE_BRIDGE_PROTOCOL_SECTION)
      : (config.protocolText ?? '');
    return {
      system: system ?? DEFAULT_CODE_CHANNEL_SYSTEM_PROMPT,
      protocol: base,
      toolSchemas: toolSchemas ?? (codeSource === 'bridge'
        ? '（本通道只声明 tf-code 程序体；其余操作走会话原生工具）'
        : '（工具面由会话 preset 决定；本插件不注册、不裁剪任何工具）'),
      invariants: config.invariants === false ? '' : config.invariants
        ?? '不变量：工具面由会话 preset 决定，本插件不注册不裁剪；上下文压缩（surface replace）可能替换旧消息为摘要，原文按句柄保留可取回。',
    };
  }
  // 标准通道：0.4.x 组装 + 0.5.0 peek 段（kernel/protocol.ts LEVEL_SECTIONS 已含）
  const baseProtocol = config.protocolText
    ?? composeProtocolText({
      level: config.protocolLevel ?? 'full',
      sections: config.protocolSections,
      enablePlan: cfg.enablePlan,
    });
  const protocolText = baseProtocol
    + (cfg.codeEnabled ? `\n\n${config.codeProtocolText ?? DEFAULT_CODE_PROTOCOL_SECTION}` : '')
    + (cfg.callCommand ? `\n\n${config.callProtocolText ?? DEFAULT_CALL_PROTOCOL_SECTION}` : '')
    + (config.protocolAppend ? `\n\n${config.protocolAppend}` : '');
  return {
    system: system ?? DEFAULT_SYSTEM_PROMPT,
    protocol: protocolText,
    toolSchemas: toolSchemas ?? '（本回合未启用原生工具；一切文件与命令操作走 tf-* 协议）',
    invariants,
  };
}

// ---------------------------------------------------------------------------
// ② SingleStreamDriver
// ---------------------------------------------------------------------------

                         
                 
                                                                  
                             
                     
                  
                  
                                            
                  
                               
                                  
 

/** F5：验收项（计划状态放驱动器=宿主侧；请求只注差分）。 */
                          
               
                              
                                             
                    
 

/** F5：解析 tf-plan body 的验收项行（`- [id] 描述`；无有效行时调用方判结构化失败）。 */
export function parsePlanItems(body        )                                      {
  const items                                      = [];
  const seen = new Set        ();
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*[-*]?\s*\[([A-Za-z0-9_-]{1,64})\]\s+(.+?)\s*$/);
    if (m === null) continue;
    const id = m[1] ;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, text: m[2]  });
  }
  return items;
}

                           
                
               
                 
                 
                     
 

                                 
             
                
                    
 

                                 
                                   
                                                                                                
                                                       
                       
                                  
                                                                
                                                                                                                                                                              
                             
                                                                  
                                                  
                                                                                
 

let DRIVER_SEQ = 0;

/** 0.5.0（§5.6(1)）：效果账条目（效果压缩的数据源）。 */
                       
                   
                
                 
                 
                   
                    
                                         
                    
                  
                      
 

export class SingleStreamDriver {
  #ports             ;
  /** 0.5.0：装配 config 原样保留（通道切换重组协议面时取显式覆盖项）。 */
  #configRef                    ;
           #cfg   
                     
                  
                             
                                 
                         
                                              
                           
                                                                            
                     
                                       
                           
                          
                                                 
                              
                       
                               
                            
                                   
                            
                                                
                           
                                  
                                    
                                    
                         
                                                                
                               
                                                    
                        
                                                     
                       
                                       
                         
                              
                                             
                                      
                              
                              
                              
                              
                                 
                                        
                                 
                                    
                       
                                           
                 
                                               
                           
                                           
                                
                                
                             
                                                
                                         
                                
                                      
                          
                                                                   
                              
                                               
                                         
                                                                          
                         
                                                      
                           
                             
                                   
                                  
                                 
                            
                              
                                                           
                                    
                                                                    
                      
                                 
                          
                           
                                                         
                       
                                   
                       
                                                                      
                               
                           
                                                                      
                                                                          
   ;
           #renderer                 ;
           #obs                   ;
  /** v0.4.0 工具面（P1）：会话首请求冻结；tf-call 校验面 + nativeTools 声明面。 */
           #surface                   ;
  /** 本请求冻结的工具面快照（undefined = L2 protocol-only / toolSurface=off）。 */
  #currentSurface                          = undefined;
  /** 上一次注入的降级级别（同级别不重复注入；级别变化或恢复时重新注入）。 */
  #lastSurfaceDegraded                                            = 'ok';
  // ---- 0.5.0 执行通道（§3.2/§5.2）：请求值 + 生效值 + 来源判定 + 回退原因 ----
  /** 用户/装配请求的通道（可能因来源不可用被拒绝）。 */
  #requestedChannel           ;
  /** 生效通道（代码通道来源皆无时回退 standard——不静默，原因在 #channelFallback）。 */
  #channel           ;
  /** 代码通道来源（undefined = 标准通道）。preset=完全让位 / bridge=受限窄桥。 */
  #codeSource                                          ;
  /** 代码通道被拒原因（undefined = 无回退）。控制栏与 status 展示。 */
  #channelFallback                     = undefined;
  /** 任务边界待切换的通道（§3.3 约束 5：切换在下一个用户任务生效；任务中排队）。 */
  #pendingChannel                   = null;
  /** 任务边界待切换的档位（同上；只改数值，不换前缀——无需换基）。 */
  #pendingTier                = null;
  /** 本会话换基次数（maxRebasesPerSession 限流 + 控制栏展示）。 */
  #rebasesSession = 0;
  /** 本回合换基次数（maxRebasesPerTurn 限流）。 */
  #rebasesTurn = 0;
  /** 本回合取回字符累计（peekBudgetChars 预算；回合开始清零）。 */
  #peekBudgetUsed = 0;
  /** 本任务请求数（控制栏"本任务 N"；pushUserTask 清零）。 */
  #taskRequestCount = 0;
  /** 本任务换基次数（控制栏"换基"；pushUserTask 清零）。 */
  #rebasesTask = 0;
  /** 装配层探测到的代码通道可用来源（null = 不可用；setChannel('code') 的判据）。 */
  #availableCodeSource                             = null;
  /** 任务起点取回度量快照（重复取回 0/0 的任务级口径）。 */
  #peekMetricsBase = { hits: 0, total: 0 };
  /** 本任务起点计量快照（D1 修复：budgetLevel 用任务级差值，不再用会话累计）。 */
  #usageBase = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  #injectedCharsBase = 0;
  /** 任务级预算指令（[tf-budget: 8steps/20k] 解析结果；只覆盖本任务的 N/C 两旋钮）。 */
  #taskBudget                                                        = null;
  /** 本任务预算下限检查结果（runTurn 启动时判定一次）。 */
  #taskBudgetBlocked                = null;
  /** 任务级观测告警已发（同任务只告警一次）。 */
  #budgetWarned = false;
  /** 效果账（§5.6(1)：效果压缩的数据源；按时间序，最新在尾）。 */
           #effects                = [];
  /** 效果序号（p1、p2…）。 */
  #effectCounter = 0;
  /** 摘要段数（压缩产生的摘要块数；控制栏 stats 用）。 */
  #summaryBlocks = 0;
  /** S5 快照贡献端口（apply() 注入 systemPrompt.context；代码通道的状态摘要注入通道）。 */
  #runtimeContextPort                                       = undefined;
  /** 最近一次 S5 状态摘要文本（去重：同文本不重发）。 */
  #lastDigestSent                = null;
  /** 最近一次随回灌注入的状态摘要（去重：同文本不重复占请求体积）。 */
  #lastDigestInjected                = null;
           #records                 = [];
           #commands = new Map                       ();
           #inFlight = new Set               ();
           #activeControllers = new Set                 ();
  /** 当前流内命令序号（隐式写序：后续命令等待先闭合的同流 tf-write —— 上游 ThinkFlow 语义） */
  #streamSeqCounter = 0;
  #streamWrites                                     = [];
  /** unknown-handle 的 peek（同流乐观 peek）：流末 drain 后重试一次，仍无此句柄才失败 */
  #deferredPeeks                                                            = [];
  /** 本任务内 tf-write 已成功写过的路径（规范化分隔符；修复限制 1 的自写回验判定） */
           #writtenPaths = new Set        ();
  /** F5 计划与验收：计划状态放驱动器（宿主侧）；请求只注差分。
   *  items 为当前 revision 的验收项全集；announced 保存上次注入时各验收项的状态，
   *  差分 = 两次状态之差（新增 / 变已验证 / 移除）。 */
  #plan                                                                  = null;
  #planAnnounced                                               = null;
  /** 运行中回合收到的 steer（修复限制 2：下一请求装配时进追加区，对齐内建"注入运行中回合的下一步"） */
  #pendingSteers                                            = [];

  #turnCounter = 0;
  /** K4 取消链路：回合级 signal（runTurn 创建，cancel 时 abort）。所有工具派发
   *  （executeTools / executeCode）共用它——不再用独立且永不触发的 AbortController。 */
  #turnController                         = null;
  #requestCount = 0;
  #reentryCount = 0;
  #finalNudges = 0;
  /** v0.4.2：上次 nudge 时的 ok 命令数（进度感知护栏的基准点；null = 本回合尚未 nudge）。 */
  #nudgeMark                = null;
  // ---- v0.4.0（自 0.3.3 回流的收束改造）：停滞预算 / 请求硬上限 / 收束期 ----
  /** 连续零产出重入数（本步没有新增生产性 ok 命令 → +1；有产出 → 清零）。 */
  #stallReentries = 0;
  /** 产出水位基准（#productiveOkCount 的历史最高值）。 */
  #progressOkMark = 0;
  /** 收束期是否已开启（撞墙后先给"立即交付"指令，而不是直接砍）。 */
  #closeOutActive = false;
  /** 本回合已用掉的收束请求数。 */
  #closeOutRequests = 0;
  #finalOnlyRequests = 0;
  #deltaCursor = 0; // O3 directoryDelta 游标（obs seq 空间）
  /** v0.4.2：口径对齐宿主 dsh-llm Usage（types.d.ts:160-179）——inputTokens 只是**未命中缓存的
   *  输入**；cacheRead/cacheWrite 单列（计费输入 = 三者之和）。缺省 0 = 适配器未上报缓存字段
   *  （离线 mock / 旧宿主），此时行为与旧版完全一致。 */
  #usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
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
  /** K2：会话工作区（factory 从 session header / workingDirectory 服务解析后回填；
   *  tf-code resolve 透传，与 tf-write/tf-read 的路径解析语义一致）。 */
  #sessionCwd                     = undefined;
  /** F6：resume 停机核对标记（"有意图无回执"时由 factory 置位；置位后 runTurn 直接 blocked，
   *  不发任何请求、零注入——由用户核对后重启/清除意图，不自动重放）。 */
  #resumeHalt                = null;
  /** F7：当前任务块在追加区的起始下标（pushUserTask 时刻的块数）——段丢弃只丢它之前的旧段。 */
  #segmentKeepFrom = 0;
  /** ok 的 tf-final 候选（解析序）；任务最终答案取最后一个（过早 final 可被后继覆盖） */
  #finalCandidates                                                                        = [];
  /** v0.3.1 截断修复：回合级命令序（跨请求单调递增）。
   *  final 之后又发过命令 → 这条 final 已被后续工作作废，必须在流末重发（#lastNonFinalOrder > #lastFinalOrder）。 */
  #cmdOrder = 0;
  #lastFinalOrder = 0;
  #lastNonFinalOrder = 0;
  /** 已提示过的 final 拒绝（key = 拒绝 kind）；同类问题只注入一次，二次不放行也不重复烧注入 */
  #reportedFinalRejects = new Set        ();
  /** 重复命令的原结果回灌队列（幂等重发不重执行，但把内容回灌给丢失上下文的模型） */
  #pendingReplays                                                         = [];
  #replays = 0;
  #replayCapped = false;
  /**
   * v0.3.2 连续性问题（真机 session-e4b9a89c）：请求之间模型看不到自己上一步的正文、
   * 命令与命令结果——0.3.x 只把观测注入"易变尾"一次（#reportedObservations 永不重放），
   * 易变尾每请求重建、从不进追加区。于是第 2 个请求之后模型看到的只有 system + 任务 +
   * 句柄目录行，模型侧原话"history is truncated / I don't have their content in context"，
   * 随后重复读同一文件、用占位 final 收场。修复：每步的正文 + 命令摘要落进追加区
   *（assistant/message 语义），已发出的易变尾在下一请求装配后转正为历史（只追加，前缀单调）。
   */
  #lastStepDigest   
                 
                 
                  
                              
                                                         
           = null;
  /** 已随请求发出、尚未转正进追加区的易变尾（含 step 归属，跨回合不转正）。 */
  #deliveredTail                                                                 = null;
  // ---- v0.4.3 P0-6：wire 边界承诺前缀断言（升级清单 §2.7 两个盲区的修复）----
  /** 上一请求收尾后的稳定段基线（承诺前缀快照 + stableLen 分类锚点）。
   *  render() 内置 preflight 只守装配时的 stable；本基线把守卫延伸到"上一请求收尾后的
   *  stable"——转正块逐字节一致性与追加区不被改写由此断言兜底，且与易变尾块序完全
   *  解耦（v0.4.3.1：混合尾 error 前置不再误报 append-drift，核查 §2）。
   *  段边界（dropAppendHead）显式重置为 null（唯一合法的历史收缩通道）。 */
  #lastRequest                         = null;
  /** P0-6④：append-drift 一次放行预算——每回合 1 次、每会话 3 次；超限降级 stable-drift 处置。
   *  （断言在发送前，"放行"= 记账后照常发送同一份 next，0 额外请求——核查 §4.2 用词。） */
  #prefixResendsTurn = 0;
  #prefixResendsSession = 0;
  /** P0-6⑤：兜底交付一次性标记（同回合只写一次；零产出回合不写——不伪造"已完成"）。 */
  #fallbackFinalDelivered = false;
  /** P0-6⑤：本回合命令 id 集（兜底交付的"台账事实"清单来源；回合开始清零）。 */
           #turnCommandIds = new Set        ();
  // ---- v0.4.3 P0-7①：尺子（request 记录的 resetSeq/resetCause/feedbackBytes）----
  /** 重置纪元（显式缓存重置点的单调计数）；resetCause = 最近一次成因。 */
  #resetSeq = 0;
  #resetCause                     = undefined;
  /** 本请求的反馈字节分类累计（注入位点累计；request 记录写入时快照并清零）。 */
  #feedbackBytes = { full: 0, dedup: 0, handle: 0 };
  /** 探针（faultPrefixDrift）已注入的回合集（oncePerTurn 语义）。 */
           #faultDriftTurns = new Set        ();
  /** 本步被截断的事实（parser truncated 事件 / finish=max-tokens）；非空即强制续写一次。 */
  #truncation                                         = null;
  /** v0.4.0（自 0.3.3 回流）：畸形闭合标签（stray-close-tag）的定向纠错注入（一次性；
   *  见 malformedCloserNudge）。只注入一次：同一会话重复犯错不重复烧注入。 */
  #strayCloseNudge                = null;
  #strayCloseGuided = false;
  #truncationRetries = 0;
  /** 本步命令 id 与原生调用（摘要用；流开始时重置） */
  #stepCommandIds           = [];
  #stepNatives                                      = [];
  /** v0.3.1：当前流内的 prose 累积（parser 的 text 事件拼接；落盘 assistant/message 的正文）。
   *  0.3.0 落盘的是整段原文（含 tf-* 标记与 DSML 噪声）——桌面端过程区把协议标记渲染成乱码，
  *  本版起落盘纯 prose：命令事实在台账（plugin:tf-agent/*），会话日志只留用户可读内容。 */
  #streamProse = '';
  /** v0.3.1 实时帧状态：agent 生命周期内的 attempt 序号与帧序号（revision 逐帧 +1，
   *  契约见 dsh-api-session-controller SessionAssistantStreamAccumulator.accept）。 */
  #attemptCounter = 0;
  #frameRevision = 0;
  #frameChunkIndex = 0;
  #frameAttemptId                     = undefined;
  /** 实时帧熔断：发射抛错（无监听器异常/宿主总线异常）后本会话不再发（fail-open）。 */
  #frameBroken = false;

  // ---------------------------------------------------------- v0.3.1 实时帧（agent/assistant-stream）

  /**
   * 思考过程实时帧（桌面端 live 显示的数据源）。契约对齐宿主两端的 fold：
   * dsh-api-session-controller SessionAssistantStreamAccumulator.accept（服务端，要求
   * revision 逐帧 +1、chunk index 逐块 +1）与客户端 ClientAssistantStream.acceptFrame
   * （start 只在无活跃 attempt 时接受）。发射异常即熔断（本会话不再发，fail-open）。
   */
  #frameEmit(frame                         )       {
    if (this.#frameBroken || this.#ports.emitHostEvent === undefined || this.#agentRef === undefined) return;
    try {
      this.#ports.emitHostEvent('agent/assistant-stream', { agent: this.#agentRef, frame });
    } catch (error) {
      this.#frameBroken = true;
      this.#warn('assistant-stream 实时帧发射失败（已熔断，本会话不再发）', error);
    }
  }

  /** 流开始帧：分配 attemptId（session 内唯一），index 清零。 */
  #frameStartAttempt(turn        , step        )       {
    if (this.#ports.emitHostEvent === undefined || this.#agentRef === undefined || this.#sessionId === undefined) return;
    this.#frameAttemptId = `${this.#sessionId}:${++this.#attemptCounter}`;
    this.#frameChunkIndex = 0;
    this.#frameEmit({ type: 'start', attemptId: this.#frameAttemptId, revision: ++this.#frameRevision, turn, step });
  }

  /** 思考 delta 帧（正文不逐帧透传：流文本是协议标记，实时显示会闪现乱码）。 */
  #frameReasoningDelta(index        , text        )       {
    if (this.#frameAttemptId === undefined) return;
    this.#frameEmit({
      type: 'chunk',
      attemptId: this.#frameAttemptId,
      revision: ++this.#frameRevision,
      index: this.#frameChunkIndex++,
      time: Date.now(),
      chunk: { type: 'reasoning-delta', index, text },
    });
  }

  /** 流末结算帧：durable 结算已落（有 seq）才发 committed，否则 abandoned。 */
  #frameEndAttempt(settlement                                                 )       {
    if (this.#frameAttemptId === undefined) return;
    this.#frameEmit({
      type: 'end',
      attemptId: this.#frameAttemptId,
      revision: ++this.#frameRevision,
      index: this.#frameChunkIndex,
      outcome: settlement !== undefined && settlement.seq !== undefined
        ? { kind: 'committed', eventType: settlement.eventType, seq: settlement.seq }
        : { kind: 'abandoned' },
    });
    this.#frameAttemptId = undefined;
  }

  /**
   * 工具广告前的 attempt 收束（abandoned）。客户端 fold 会把活跃 attempt 期间到达的
   * assistant/message（广告消息）暂存进 pending，而 end 帧只消费一条结算——不先收束，
   * 广告条目会永久滞留 pending，下一步的 start 帧触发 events.restart()（整窗重建）。
   * 先收束：广告与后续 tool/call、落盘消息全部直接 publish，零 restart。
   */
  #frameEndAbandonedIfOpen()       {
    this.#frameEndAttempt(undefined);
  }

  constructor(ports             , config                    , renderer                  , obs                    ) {
    this.#ports = ports;
    this.#configRef = config;
    // ---- 0.5.0 档位数值（§4.2 表；tier 只改数值）----
    const tierSpec = getTier(config.tier ?? DEFAULT_TIER);
    const tv = tierSpec.values;
    // ---- 0.5.0 代码通道三来源判定（§5.2）：装配层探测结果经 config.codeSource 注入；
    // 显式 codeChannelSource 绕过探测；来源皆无 → 拒绝进入，回退标准（不静默降级）。----
    let requestedChannel            = config.channel ?? DEFAULT_CHANNEL;
    let codeSource                                          ;
    if (requestedChannel === 'code') {
      if (config.codeChannelSource === 'preset' || config.codeChannelSource === 'bridge') {
        codeSource = config.codeChannelSource;
      } else if (config.codeSource !== undefined) {
        codeSource = config.codeSource;
      } else {
        codeSource = 'none';
      }
      if (codeSource === 'none') {
        // §5.2 第三分支：拒绝进入代码通道，回退标准通道（warn + 台账 + 控制栏状态，
        // 绝不静默降级）。控制状态由 takeover/控制页读取 runtimeChannel 看到回退事实。
        const reason = '代码通道不可用：未检测到 PTC 预设或 ptcRuntime（来源判定 none）——回退标准通道';
        (ports.onWarning ?? (() => {}))(`[stream-loop] ${reason}`);
        this.#channelFallback = reason;
        requestedChannel = DEFAULT_CHANNEL;
        codeSource = undefined;
      }
    }
    this.#requestedChannel = config.channel ?? DEFAULT_CHANNEL;
    this.#channel = requestedChannel;
    this.#codeSource = codeSource;
    // 装配层探测结果（apply() 注入）：setChannel('code') 的可用性判据。
    this.#availableCodeSource = config.codeSource === 'preset' || config.codeSource === 'bridge'
      ? config.codeSource
      : null;
    const codeChannel = requestedChannel === 'code';
    this.#cfg = {
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      maxParallelToolCalls: config.maxParallelToolCalls ?? 3,
      // v0.4.2：兜底值与 balanced 模式默认一致（12）——直构驱动器的调用方
      // （离线评测/测试）与桌面装配保持一致上限。
      maxReentries: config.maxReentries ?? 12,
      // v0.4.0（自 0.3.3 回流）：生产性重入与停滞重入分账——旧实现把"继续干活"和"原地
      // 打转"都算进 maxReentries，13 步的真实任务（读文件/改文件/跑检查）会在干到一半时
      // 被硬杀，桌面端只剩最后一句 prose（真机 session-6bb805db / 27876fd9）。
      stallReentries: config.stallReentries ?? config.maxReentries ?? 12,
      // 0.5.0（§4.5.2）：maxSteps 接管 maxRequests（N 上限，档位值 16/24/40）。
      // 显式 maxReentries（无 maxSteps/maxRequests）时保留旧派生 max(4, maxReentries*2)，
      // 兼容 0.4.x 装配；0 = 无上限（仅观测）。
      maxSteps: config.maxSteps
        ?? config.maxRequests
        ?? (config.maxReentries !== undefined ? Math.max(4, config.maxReentries * 2) : tv.maxSteps),
      maxInputTokens: config.maxInputTokens ?? tv.maxInputTokens,
      compactAggressiveness: config.compactAggressiveness ?? tv.compactAggressiveness,
      keepRecent: config.keepRecent ?? tv.keepRecent,
      maxSummaryChars: config.maxSummaryChars ?? tv.maxSummaryChars,
      peekBudgetChars: config.peekBudgetChars ?? tv.peekBudgetChars,
      effectElision: config.effectElision !== false,
      effectElisionKeepRecent: Math.max(0, config.effectElisionKeepRecent ?? 3),
      stateDigest: config.stateDigest !== false,
      surfaceCompaction: config.surfaceCompaction !== false,
      spanLedger: config.spanLedger !== false,
      peekIndex: config.peekIndex !== false,
      maxReadChars: config.maxReadChars ?? DEFAULT_MAX_READ_CHARS,
      prefixPolicy: config.prefixPolicy ?? 'auto',
      rebaseBudgetRatio: config.rebaseBudgetRatio ?? 1.5,
      maxRebasesPerTurn: Math.max(0, config.maxRebasesPerTurn ?? 2),
      maxRebasesPerSession: Math.max(0, config.maxRebasesPerSession ?? 8),
      surfacePolicy: config.surfacePolicy ?? 'reserved-only',
      channel: requestedChannel,
      tier: config.tier ?? DEFAULT_TIER,
      tierValues: tv,
      observeBudgetTokens: config.observeBudgetTokens ?? config.budgetTokens ?? DEFAULT_BUDGET_TOKENS_OBSERVE,
      closeOutRequests: Math.max(0, config.closeOutRequests ?? 2),
      readFeedbackBudgetPerRequest: config.readFeedbackBudgetPerRequest
        ?? DEFAULT_READ_FEEDBACK_BUDGET_PER_REQUEST,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 30_000,
      budgetTokens: config.budgetTokens,
      // 0.5.0（§7.5 双旋钮）：回灌侧默认 0 = 不截断（读取侧 maxReadChars 已控住）；
      // 8000 = 0.4.x 行为回退点。
      readFeedbackLimit: config.readFeedbackLimit ?? 0,
      selfReadFeedback: config.selfReadFeedback ?? 'receipt',
      // 0.5.0：tf-code 通道 = channel==='code'（bridge 来源，本插件执行）或显式 enableCode。
      // preset 来源下执行器是宿主 tool-executor-ptc，本插件不执行 tf-code（让位，§5.3）。
      codeEnabled: ((codeChannel && codeSource === 'bridge') || config.enableCode === true)
        && ports.executeCode !== undefined,
      codeTimeoutMs: config.codeTimeoutMs,
      codeQuota: { ...DEFAULT_CODE_QUOTA, ...(config.codeQuota ?? {}) },
      codeValueInjectLimit: config.codeValueInjectLimit ?? DEFAULT_CODE_VALUE_INJECT_LIMIT,
      nativeResultLimit: config.nativeResultLimit ?? DEFAULT_NATIVE_RESULT_LIMIT,
      nativeToolSchemasEnabled: config.nativeToolSchemas !== undefined,
      enablePlan: config.enablePlan ?? true,
      segmentMaxChars: config.segmentMaxChars ?? DEFAULT_SEGMENT_MAX_CHARS,
      toolMapping: config.toolMapping ?? DEFAULT_TOOL_MAPPING,
      nativeTools: config.nativeTools === true,
      callCommand: config.callCommand !== false && ports.toolsService !== undefined,
      strictAdmission: config.strictAdmission === true,
      // v0.4.3（P0-6 探针）：离线探针专用（生产不得设置）；undefined = 关闭，零开销。
      ...(config.faultPrefixDrift === undefined ? {} : { faultPrefixDrift: config.faultPrefixDrift }),
    };
    // ---- 0.5.0 协议面按通道组装（§3.2 能力矩阵；稳定前缀构造期冻结）----
    // standard：基座协议（full/lean/minimal）+ code 段（bridge 时）+ call 段 + append；
    // code+preset：协议段 0 字符（§5.3 完全让位）；system 也换成代码通道措辞（不引导 tf-*）；
    // code+bridge：只写 tf-code 用法（约 200 字符；不传 stateOwner/programFormat/sandboxPolicy）。
    const texts = composeChannelTexts(requestedChannel, codeSource, this.#cfg, config);
    this.#renderer = renderer ?? new ContextRenderer({
      system: texts.system,
      protocol: texts.protocol,
      toolSchemas: texts.toolSchemas,
      invariants: texts.invariants,
    });
    this.#surface = new ToolSurfaceHolder(ports.toolsService, {
      policy: this.#cfg.surfacePolicy,
      profile: config.toolSurface ?? 'standard',
      nativeTools: this.#cfg.nativeTools,
      callCommand: this.#cfg.callCommand,
      // 代码通道让位：模型侧无 tf-call（§5.3——"本插件对 ctx.tools 的注册数为 0，
      // 对 system prompt 的贡献为 0 字符"的可验证面之一）。
      callReserved: codeChannel,
    });
    this.#obs = obs ?? new ObservationLedger({
      starvationThreshold: config.starvationThreshold,
      spanLedger: this.#cfg.spanLedger,
    });
    this.#warn = ports.onWarning ?? (() => {});
    this.#gate = ports.gate;
    // 0.5.0（附录 A）：taskBudget 配置 = 会话级预算初始值（任务指令可收窄，不可突破装配上限）
    if (config.taskBudget !== undefined && config.taskBudget !== null) {
      if (typeof config.taskBudget.maxSteps === 'number') this.#sessionBudget.maxSteps = config.taskBudget.maxSteps;
      if (typeof config.taskBudget.maxInputTokens === 'number') this.#sessionBudget.maxInputTokens = config.taskBudget.maxInputTokens;
    }
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

  /** v0.4.2：assistant 消息宿主来源的实时值（写入时取，不缓存；applySelection 后随动）。
   *  会话日志与请求装配共用；kind 固定 'model'。空串由 makeAssistantMessage 兜底为
   *  'unknown'（宿主校验拒绝空字符串）。 */
  modelSource()                  {
    return { kind: 'model', provider: this.#cfg.provider, model: this.#cfg.model };
  }

  /** v0.4.2：运行时缓存口径快照（控制页/对账用）。口径与 dsh-llm Usage 一致：
   *  计费输入 = 未命中输入 + 缓存读 + 缓存写。适配器从未上报缓存字段（离线 mock /
   *  旧宿主）时 cacheHitRatio 为 null——不把缺数据渲染成 0%。
   *  v0.4.3（P0-7①）：cacheHitRatio 是 **diagnostic-only**（分母随总量压缩收缩，比值
   *  不可跨实验比较——升级清单 §0.5）；对账主口径是聚合三元组 providerInputSum / requests /
   *  resetCount，全部可从 request 记录外部复算（providerInputSum = Σ providerInputTokens，
   *  requests = request 记录数，resetCount = 最后一条记录的 resetSeq）。 */
  cacheStats()   
                        
                         
                            
                             
                        
                                 
                                                                         
                             
                     
                       
    {
    const billedInput = this.#usage.inputTokens + this.#usage.cacheReadTokens + this.#usage.cacheWriteTokens;
    const cacheHitRatio = this.#usage.cacheReadTokens > 0 && billedInput > 0
      ? Math.round((this.#usage.cacheReadTokens / billedInput) * 100) / 100
      : null;
    let providerInputSum = 0;
    let requests = 0;
    let resetCount = 0;
    for (const rec of this.#records) {
      if (rec.kind !== 'request') continue;
      requests += 1;
      providerInputSum += rec.providerInputTokens ?? 0;
      resetCount = Math.max(resetCount, rec.resetSeq ?? 0);
    }
    return {
      inputTokens: this.#usage.inputTokens,
      outputTokens: this.#usage.outputTokens,
      cacheReadTokens: this.#usage.cacheReadTokens,
      cacheWriteTokens: this.#usage.cacheWriteTokens,
      billedInput,
      cacheHitRatio,
      providerInputSum,
      requests,
      resetCount,
    };
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

  /** K2：回填会话工作区（tf-code resolve 透传用；factory 在 createDriver 闭包里解析）。 */
  setSessionCwd(cwd                    )       {
    this.#sessionCwd = cwd;
  }

  /** F6：置位 resume 停机核对（"有意图无回执"；零注入——只阻断，不进上下文）。 */
  setResumeHalt(detail        )       {
    this.#resumeHalt = detail;
  }

  /** F6：清除停机核对（人工核对完成后的出口）。 */
  clearResumeHalt()       {
    this.#resumeHalt = null;
  }

  // ------------------------------------------------ 0.5.0 会话级控制（§4.6 优先级：任务指令 > 会话默认 > 装配上限）

  /**
   * 会话级通道切换（§4.6）。排队到下一个用户任务边界生效（§3.3 约束 5：任务进行中提交
   * 的切换请求排队，不中断当前任务）。切换 = 工具面 + 协议段变化 = 计划性换基（§8.3），
   * 受 maxRebasesPerSession 限流（超限拒绝并要求确认——R1）。
   * 代码通道需要装配层探测到来源（preset/bridge）；皆无时拒绝进入并如实返回原因。
   */
  setChannel(channel           )                                                  {
    if (!isChannelId(channel)) return { ok: false, code: 'invalid-channel' };
    if (channel === this.#channel && this.#pendingChannel === null) return { ok: true };
    if (channel === 'code' && this.#availableCodeSource === null) {
      const detail = '代码通道不可用：未检测到 PTC 预设或 ptcRuntime——拒绝进入，不静默降级（§5.2）';
      this.#warn(`[stream-loop] setChannel('code') 被拒：${detail}`);
      this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'channel-refused', detail });
      return { ok: false, code: 'code-unavailable', detail };
    }
    if (this.#rebasesSession >= this.#cfg.maxRebasesPerSession && channel !== this.#cfg.channel) {
      const detail = `本会话换基已达上限 ${this.#cfg.maxRebasesPerSession}（maxRebasesPerSession）：通道切换需要确认（R1）`;
      this.#warn(`[stream-loop] setChannel 排队被拒：${detail}`);
      return { ok: false, code: 'rebase-limit', detail };
    }
    this.#pendingChannel = channel;
    return { ok: true };
  }

  /** 会话级档位切换（只改数值，不换前缀不换基）。排队到任务边界生效。 */
  setTier(tier        )                                 {
    if (!isTierId(tier)) return { ok: false, code: 'invalid-tier' };
    this.#pendingTier = tier;
    return { ok: true };
  }

  /**
   * 会话级预算调整（§4.6 runtime.setBudget）。maxSteps/maxInputTokens 两旋钮；
   * undefined = 恢复档位默认；0 = 无上限（仅观测）。装配级显式上限（config）优先——
   * 这里只能收窄，不能突破装配上限（§4.6：装配级作为不可逾越上限）。
   */
  setBudget(budget                                                )                                                  {
    if (budget.maxSteps !== undefined) {
      const ceiling = this.#configRef.maxSteps ?? this.#configRef.maxRequests ?? this.#cfg.tierValues.maxSteps;
      if (ceiling > 0 && budget.maxSteps > ceiling) {
        return { ok: false, code: 'exceeds-assembly-limit', detail: `maxSteps ${budget.maxSteps} 超过装配上限 ${ceiling}` };
      }
      this.#sessionBudget.maxSteps = budget.maxSteps;
    }
    if (budget.maxInputTokens !== undefined) {
      const ceiling = this.#configRef.maxInputTokens ?? this.#cfg.tierValues.maxInputTokens;
      if (ceiling > 0 && budget.maxInputTokens > ceiling) {
        return { ok: false, code: 'exceeds-assembly-limit', detail: `maxInputTokens ${budget.maxInputTokens} 超过装配上限 ${ceiling}` };
      }
      this.#sessionBudget.maxInputTokens = budget.maxInputTokens;
    }
    return { ok: true };
  }

  /** 会话级预算（setBudget 落点；与档位值合成生效值）。构造时从 config.taskBudget 初始化。 */
  #sessionBudget                                                 = {};

  /** 旧模式别名（0.5.x 保留，0.6.0 移除）：legacy mode → (channel, tier) 两路排队。 */
  setMode(mode        )                                                                     {
    if (!isLegacyModeId(mode)) return { ok: false, code: 'invalid-mode' };
    const mapped = resolveLegacyMode(mode);
    this.#warn(`[stream-loop] setMode("${mode}") 是旧模式值，已按别名映射为 channel=${mapped.channel}/tier=${mapped.tier}（0.5.x 保留别名，0.6.0 移除）`);
    const tierResult = this.setTier(mapped.tier);
    const channelResult = this.setChannel(mapped.channel);
    return {
      ok: channelResult.ok && tierResult.ok,
      ...(channelResult.ok ? {} : { code: channelResult.code, detail: channelResult.detail }),
      aliased: true,
    };
  }

  /**
   * 任务边界切换应用（pushUserTask 调用；§3.3 约束 5）。
   * 档位：只改数值（不换前缀不换基）。通道：计划性换基（rebuild 前缀四段 + 基线重置 +
   * [tf-stream:context-rebased] + cache-reset 记账）。
   */
  #applyPendingSwitches()       {
    if (this.#pendingTier !== null) {
      const tier = this.#pendingTier;
      this.#pendingTier = null;
      if (tier !== this.#cfg.tier) {
        const tv = getTier(tier).values;
        this.#cfg.tier = tier;
        this.#cfg.tierValues = tv;
        this.#cfg.compactAggressiveness = tv.compactAggressiveness;
        this.#cfg.keepRecent = tv.keepRecent;
        this.#cfg.maxSummaryChars = tv.maxSummaryChars;
        this.#cfg.peekBudgetChars = tv.peekBudgetChars;
        // N/C 两旋钮：会话级 setBudget 显式值优先；否则档位值；装配显式值为不可逾越上限
        // （§4.6 优先级：任务指令 > 会话默认 > 装配上限）。
        this.#cfg.maxSteps = this.#sessionBudget.maxSteps ?? tv.maxSteps;
        this.#cfg.maxInputTokens = this.#sessionBudget.maxInputTokens ?? tv.maxInputTokens;
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'tier-switch', detail: `档位 → ${tier}（只改数值，不换基）：maxSteps=${this.effectiveLimits().maxSteps} maxInputTokens=${this.effectiveLimits().maxInputTokens}` });
        this.#ledgerWrite('plugin:tf-agent/surface', { event: 'tier-switch', tier, maxSteps: this.effectiveLimits().maxSteps, maxInputTokens: this.effectiveLimits().maxInputTokens });
      }
    }
    if (this.#pendingChannel !== null) {
      const next = this.#pendingChannel;
      this.#pendingChannel = null;
      if (next === this.#cfg.channel) return;
      if (next === 'code' && this.#availableCodeSource === null) {
        this.#warn('[stream-loop] 任务边界通道切换被拒：代码通道来源不可用（不静默降级）');
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'channel-refused', detail: '任务边界切换到 code 被拒：来源判定 none' });
        return;
      }
      const previous = this.#cfg.channel;
      this.#channel = next;
      this.#cfg.channel = next;
      this.#codeSource = next === 'code' ? this.#availableCodeSource  : undefined;
      const texts = composeChannelTexts(next, this.#codeSource, this.#cfg, this.#configRef);
      const contextTokens = estimatePromptTokens(this.#renderer.stableMessages());
      // 计划性换基（§8.3）：重置 preflight 基线 + 前缀组件更新 + policyLog（planned-rebase）
      this.#renderer.rebase({
        reason: `通道切换 ${previous} → ${next}（任务边界）`,
        system: texts.system,
        protocol: texts.protocol,
        toolSchemas: texts.toolSchemas,
        invariants: texts.invariants,
        contextTokens,
      });
      // 模型可见一行（§8.6 实现要求 1）：进追加区（durable，下一请求必然可见）
      this.#renderer.appendHistory({ role: 'user', content: contextRebasedLine(`通道切换 → ${next === 'code' ? '代码' : '标准'}通道`) });
      // wire 承诺基线作废（新时代第一条请求）
      this.#lastRequest = null;
      this.#resetSeq += 1;
      this.#resetCause = 'channel-switch';
      this.#rebasesSession += 1;
      this.#rebasesTask += 1;
      this.#noteCacheReset('channel-switch', contextTokens);
      this.#surface.setCallReserved(next === 'code');
      this.#record({
        seq: ++DRIVER_SEQ, kind: 'fault', fault: 'channel-switch',
        detail: `通道 ${previous} → ${next}（来源=${this.#codeSource ?? '-'}）：计划性换基 + cache-reset（contextTokens≈${contextTokens}）`,
      });
      this.#ledgerWrite('plugin:tf-agent/surface', { event: 'channel-switch', from: previous, to: next, source: this.#codeSource ?? null, rebase: 'planned', contextTokens });
    }
  }

  /** 0.5.0（§8.6 实现要求 2）：cache-reset 事件——cause / contextTokens / estimatedColdCost。 */
  #noteCacheReset(cause        , contextTokens        )       {
    const record               = {
      seq: ++DRIVER_SEQ,
      kind: 'cache-reset',
      cause,
      contextTokens,
      estimatedColdCost: contextTokens,
    };
    this.#record(record);
    this.#ledgerWrite('plugin:tf-agent/cache', { cause, contextTokens, estimatedColdCost: contextTokens, at: new Date().toISOString() });
  }

  // ------------------------------------------ 0.5.0 P3：maxInputTokens 触顶压缩（§4.5.2/§7.6）

  /**
   * 单请求上下文上限触顶时的压缩（C 上限旋钮的落点）。在每次装配前判定：
   *  - 估算 tokens ≥ triggerRatio × maxInputTokens → 压缩旧段（整块、保 keepRecent、
   *    不越过当前任务块起点），产物 = 确定性摘要（kernel/compaction.ts，纯函数）+
   *    原文句柄化（obs，可 tf-peek / request:N 取回）；
   *  - 计划性换基（§8.3）：rebase() 重置基线 + [tf-stream:context-rebased] 注入 +
   *    cache-reset 记账（cause='compaction'）；
   *  - 受 maxRebasesPerTurn / maxRebasesPerSession 限流（超限跳过本次压缩，不静默——
   *    记 fault）；surfaceCompaction=false（回退点）与 maxInputTokens=0 时不压缩。
   */
  #maybeCompactForInputBudget(turn        )       {
    if (!this.#cfg.surfaceCompaction) return;
    const maxInput = this.effectiveLimits().maxInputTokens;
    if (maxInput <= 0) return;
    // 估算 = 稳定段 + 待转正尾块（上一请求发出、下一请求仍携带的部分）——触发判定看
    // "下一请求的真实体积"，只看 stable 会漏掉刚注入的大块观测（真机形态）。
    const stable = this.#renderer.stableMessages();
    const pendingTail = this.#deliveredTail?.blocks ?? [];
    const estimated = estimatePromptTokens([...stable, ...pendingTail]);
    const decision = shouldCompact(estimated, {
      maxInputTokens: maxInput,
      maxSteps: this.effectiveLimits().maxSteps,
      aggressiveness: this.#cfg.compactAggressiveness,
    });
    if (!decision.compact) return;
    // 可压缩块 = 追加区头部、不越过当前任务块起点（#segmentKeepFrom）、
    // 保底留 keepRecent 块不压（确定性摘要的"保留最近"纪律）。
    const totalBlocks = this.#renderer.appendBlockCount;
    const keepFloor = Math.max(this.#segmentKeepFrom, this.#cfg.keepRecent);
    const droppable = totalBlocks - keepFloor;
    if (droppable <= 0) {
      this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'compaction-skipped', detail: `${decision.reason}，但可压缩块为 0（keepFloor=${keepFloor} ≥ 总块数 ${totalBlocks}）——不压缩，照常发送` });
      return;
    }
    if (this.#rebasesTurn >= this.#cfg.maxRebasesPerTurn || this.#rebasesSession >= this.#cfg.maxRebasesPerSession) {
      this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'compaction-skipped', detail: `换基限流（turn ${this.#rebasesTurn}/${this.#cfg.maxRebasesPerTurn}，session ${this.#rebasesSession}/${this.#cfg.maxRebasesPerSession}）——跳过压缩` });
      return;
    }
    // 注：§8.4 换基成本判据（rebaseBudgetRatio）只约束 append-drift 受限换基
    // （#assertWirePrefix）——计划性压缩不适用：压缩恰恰在**降低**后续每个请求的
    // 未缓存输入，套"剩余预算 > rebase_cost × 1.5"会让压缩永远无法触发（触发点
    // 0.7×maxInput > max/2.5）。计划性换基走 maxRebases 限流 + 记账（§8.3 判定表：
    // planned-rebase = 正常执行并记账）。
    // 折叠被丢弃块为确定性摘要（纯函数；原文块转 CompactItem——role 自块类型，内容原样；
    // 0.5.0 §5.6(1)：携带已折叠效果的块（观测/回灌/digest 行含该效果句柄）→ 先行折叠为
    // [applied pN] 一行（压缩是追加区唯一合法改写点，效果压缩在此生效）。
    const dropCount = droppable;
    const before = this.#renderer.stableMessages();
    const droppedBlocks = before.slice(1).slice(0, dropCount); // [0] = system 前缀
    const items = droppedBlocks.map((m) => {
      const effectLine = this.#elidableEffectLineForBlock(m.content);
      if (effectLine !== null) {
        return { role: 'user'         , content: effectLine };
      }
      return { role: m.role === 'assistant' ? 'assistant'          : m.role === 'tool' ? 'tool'          : 'user'         , content: m.content };
    });
    const compacted = compactItems(items, {
      keepRecent: 0, // 保留集合已由 keepFloor 表达
      maxSummaryChars: this.#cfg.maxSummaryChars,
      aggressiveness: this.#cfg.compactAggressiveness,
    });
    const { dropped } = this.#renderer.dropAppendHead(dropCount, {
      reason: `maxInputTokens 触顶压缩（estimated≈${estimated} tokens ≥ ${decision.triggerRatio} × ${maxInput}；turn ${turn} 装配前）`,
    });
    // 原文句柄化（§7.6：原文去向 = OutputStore + handle）+ request:N 别名登记
    for (const [i, text] of dropped.entries()) {
      const observation = this.#obs.observe({
        tool: 'tf-read',
        ok: true,
        key: `compact:turn${turn}:${i}`,
        content: text,
        callId: `cmp-t${turn}-${i}`,
      });
      if (observation.handle !== null) this.#obs.registerRequestHandle(turn, observation.handle);
      this.#record({
        seq: ++DRIVER_SEQ, kind: 'observation',
        handle: observation.handle, key: `compact:turn${turn}:${i}`,
        infoGain: 'low', reason: 'compaction-handleized',
      });
    }
    // 摘要落追加区（压缩产物；确定性，同输入同字节）
    if (compacted.summaryText !== '') {
      this.#renderer.appendHistory({ role: 'user', content: compacted.summaryText });
      this.#summaryBlocks += 1;
    }
    // 计划性换基（§8.3）：基线重置 + 模型可见一行 + 记账
    this.#renderer.rebase({ reason: '上下文压缩（maxInputTokens 触顶）', contextTokens: estimated });
    this.#renderer.appendHistory({ role: 'user', content: contextRebasedLine('压缩') });
    this.#lastRequest = null;
    this.#resetSeq += 1;
    this.#resetCause = 'compaction';
    this.#rebasesTurn += 1;
    this.#rebasesSession += 1;
    this.#rebasesTask += 1;
    // 段边界游标同步前移（被丢块已离开追加区）
    this.#segmentKeepFrom = Math.max(0, this.#segmentKeepFrom - dropCount);
    this.#noteCacheReset('compaction', estimated);
    this.#record({
      seq: ++DRIVER_SEQ, kind: 'fault', fault: 'compaction',
      detail: `${decision.reason} → 丢弃 ${dropped.length} 块（原文句柄化 obs:read:cmp-t${turn}-*，可 tf-peek/request:${turn} 取回）；摘要 ${compacted.summaryChars} 字符；换基记账 planned-rebase`,
    });
    this.#ledgerWrite('plugin:tf-agent/cache', { cause: 'compaction', turn, droppedBlocks: dropped.length, summaryChars: compacted.summaryChars, estimated, triggerRatio: decision.triggerRatio });
  }

  /** 生效的双旋钮值（任务指令 > 会话默认 > 档位值；§4.6）。 */
  effectiveLimits()                                               {
    return {
      maxSteps: this.#taskBudget?.maxSteps ?? this.#sessionBudget.maxSteps ?? this.#cfg.maxSteps,
      maxInputTokens: this.#taskBudget?.maxInputTokens ?? this.#sessionBudget.maxInputTokens ?? this.#cfg.maxInputTokens,
    };
  }

  /** S5 快照贡献端口（apply() 注入；代码通道的状态摘要注入通道，U10 探针面）。 */
  setRuntimeContextPort(port                        )       {
    this.#runtimeContextPort = port;
  }

  /** 当前语义状态摘要行（控制页 / S5 贡献共用同一投影；无计划时 null）。 */
  stateDigestLine()                {
    if (!this.#cfg.stateDigest) return null;
    if (this.#cfg.channel === 'standard' && !this.#cfg.enablePlan) return null;
    const open = this.#plan === null ? [] : [...this.#plan.items.entries()].filter(([, item]) => item.status === 'open');
    const failed = [...this.#commands.values()].filter((r) => r.status === 'failed').length;
    return renderStateDigest({
      goals: this.#plan?.items.size,
      verified: this.#plan === null ? undefined : this.#plan.items.size - open.length,
      open: open.map(([id, item]) => ({ id, text: item.text })),
      failed,
    });
  }

  /** 控制栏运行状态（§3.3 底部状态行数据源；ControlStatsFace）。 */
  runtimeStatus()   
                                                                                           
                                                                     
                                                                                       
                                                         
                                                            
    {
    const peek = this.#obs.peekMetrics();
    const executor = this.#cfg.channel === 'code'
      ? (this.#codeSource === 'preset' ? 'ptc-preset' : this.#codeSource === 'bridge' ? 'ptc-bridge' : 'none')
      : 'native';
    const surface = this.#cfg.channel === 'code'
      ? (this.#codeSource === 'preset' ? 'preset 原样（不注册不裁剪）' : '仅 tf-code')
      : this.#cfg.surfacePolicy === 'reserved-only' ? '透传（tf-* 保留）' : 'profile（回退演练）';
    return {
      channel: this.#cfg.channel,
      tier: this.#cfg.tier,
      codeSource: this.#cfg.channel === 'code' ? this.#codeSource : undefined,
      channelFallback: this.#channelFallback,
      requestedChannel: this.#requestedChannel,
      requests: this.#taskRequestCount,
      rebases: this.#rebasesTask,
      redundantPeeks: {
        hits: Math.max(0, peek.redundantHits - this.#peekMetricsBase.hits),
        total: Math.max(0, peek.peekRequests - this.#peekMetricsBase.total),
      },
      summaries: this.#summaryBlocks,
      executor,
      surface,
      effective: this.effectiveLimits(),
    };
  }

  /** F7：按句柄取回观测原文（段边界丢弃的旧段原文、命令产出等）；未知句柄返回 null。
   *  只读通道，不进上下文——供排障/回取与评测断言使用。 */
  peekHandle(handle        , fromLine = 1, toLine = Number.MAX_SAFE_INTEGER)                {
    return this.#obs.peek(handle, fromLine, toLine);
  }

  /** v0.4.0（P5）：当前冻结工具面的工具名（tf-code 全绑定生成用）。无面 = 空数组（0.3.x 行为）。 */
  surfaceNames()                    {
    return this.#currentSurface?.names ?? [];
  }

  /**
   * F5：命令成功回执 → 标记其 accepts 声明的验收项为已验证。
   * 证据 = `cmdId(handle=…,fp=…)`——模型自述"已完成"不产生任何条目（无回执不验证）。
   * 每次标记落台账；注入差分在 #buildInjections 里统一生成。
   */
  #markAccepts(cmd           , handle                    , fingerprint        )       {
    const accepts = cmd.attrs['accepts'];
    if (accepts === undefined || this.#plan === null || !this.#cfg.enablePlan) return;
    for (const rawId of accepts.split(',')) {
      const id = rawId.trim();
      if (id === '') continue;
      const item = this.#plan.items.get(id);
      if (item === undefined || item.status === 'verified') continue;
      item.status = 'verified';
      item.evidence = `${cmd.id}(handle=${handle ?? '-'} fp=${fingerprint})`;
      this.#record({ seq: ++DRIVER_SEQ, kind: 'plan-accept', acceptId: id, cmdId: cmd.id, evidence: item.evidence });
      this.#ledgerWrite('plugin:tf-agent/plan', { revision: this.#plan.revision, verified: id, cmdId: cmd.id, evidence: item.evidence });
    }
  }

  /**
   * 0.5.0（§5.6(1)）：效果落账。动作生效即记账（目标、版本、验证状态、句柄）；
   * 验证状态：声明了 accepts → 全部验收项有回执才 'pass'（否则 'unverified'，不折叠）；
   * 未声明 accepts 的成功写/执行 → 'pass'（回执即效果验证）。效果压缩在
   * #commitStepDigest 折叠历史行为一行（[applied pN] …），原文按句柄保留。
   */
  #recordEffect(cmd           , rec               , contentText        )       {
    if (this.#cfg.effectElision === false) return;
    const accepts = cmd.attrs['accepts'];
    let verify                                 = 'pass';
    let acceptId                    ;
    if (accepts !== undefined && this.#plan !== null && this.#cfg.enablePlan) {
      const ids = accepts.split(',').map((s) => s.trim()).filter((s) => s !== '');
      const allVerified = ids.length > 0 && ids.every((id) => this.#plan .items.get(id)?.status === 'verified');
      verify = allVerified ? 'pass' : 'unverified';
      acceptId = ids[0];
    }
    const versionMatch = /@v(\d+)$/.exec(rec.handle ?? '');
    this.#effectCounter += 1;
    this.#effects.push({
      effectId: `p${this.#effectCounter}`,
      cmdId: cmd.id,
      action: cmd.name.replace(/^tf-/, ''),
      target: cmd.attrs['path'] ?? cmd.attrs['cmd'] ?? cmd.attrs['pattern'] ?? cmd.attrs['description'] ?? cmd.id,
      ...(versionMatch !== null ? { version: Number(versionMatch[1]) } : {}),
      verify,
      ...(acceptId !== undefined ? { acceptId } : {}),
      ...(rec.handle !== undefined ? { handle: rec.handle } : {}),
      digestIndex: this.#cmdOrder,
    });
    this.#ledgerWrite('plugin:tf-agent/plan', { kind: 'effect', effectId: `p${this.#effectCounter}`, cmdId: cmd.id, action: cmd.name, verify, handle: rec.handle ?? null, chars: contentText.length });
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
      channel: () => ({
        channel: this.#cfg.channel,
        requestedChannel: this.#requestedChannel,
        tier: this.#cfg.tier,
        codeSource: this.#cfg.channel === 'code' ? this.#codeSource : undefined,
        channelFallback: this.#channelFallback,
      }),
      peekMetrics: () => obs.peekMetrics(),
      rebaseCounts: () => ({
        planned: this.#records.filter((r) => r.kind === 'cache-reset' && (r.cause === 'compaction' || r.cause === 'channel-switch')).length,
        appendDrift: this.#records.filter((r) => r.kind === 'fault' && r.fault === 'prefix-reset').length,
        session: this.#rebasesSession,
      }),
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

  // ------------------------------------------------------------------ O5 阶梯（0.5.0：任务级基数）

  /**
   * 任务级 token 预算阶梯（README O5：<70% normal；70-90% high-only；>90% final-only）。
   *
   * 0.5.0 D1 修复：基数改为**任务起点**快照（pushUserTask 记录 #usageBase /
   * #injectedCharsBase）——不再用会话累计，同会话后续任务不再开局即处 final-only。
   * 0.5.0 D7 修复：严格口径 = input + output（cacheRead 不按 1:1 计入控制——缓存命中
   * 越好越早降级的方向性错误就此消除；cacheRead 只进观测报表，tokens_total_with_cache 口径）。
   * budgetTokens 未显式设置时阶梯关闭（恒 normal；预算治理走 maxSteps/maxInputTokens
   * 双旋钮，§4.5.2），observeBudgetTokens 只做观测告警。
   */
  budgetLevel()              {
    const budget = this.#cfg.budgetTokens;
    if (budget === undefined || budget <= 0) return 'normal';
    const input = Math.max(0, this.#usage.inputTokens - this.#usageBase.inputTokens);
    const output = Math.max(0, this.#usage.outputTokens - this.#usageBase.outputTokens);
    const injected = Math.max(0, this.#injectedChars - this.#injectedCharsBase);
    const spent = input + output + Math.ceil(injected / 4);
    if (spent >= budget * 0.9) return 'final-only';
    if (spent >= budget * 0.7) return 'high-only';
    return 'normal';
  }

  /** 任务级花费（严格口径：input + output + 注入折算；观测告警与报表用，不含 cacheRead）。 */
  taskSpentTokens()         {
    const input = Math.max(0, this.#usage.inputTokens - this.#usageBase.inputTokens);
    const output = Math.max(0, this.#usage.outputTokens - this.#usageBase.outputTokens);
    const injected = Math.max(0, this.#injectedChars - this.#injectedCharsBase);
    return input + output + Math.ceil(injected / 4);
  }

  /** 0.5.0 观测预算判定（budgetTokens 降为观测项——D7；超阈值 warn + 台账，不改行为）。 */
  #observeBudgetOnce(turn        )       {
    const result = observeBudget(this.taskSpentTokens(), this.#cfg.observeBudgetTokens);
    if (result === null || !result.warn || this.#budgetWarned) return;
    this.#budgetWarned = true;
    const detail = `观测预算：本任务花费 ${this.taskSpentTokens()} tokens ≥ 90% × ${this.#cfg.observeBudgetTokens}`
      + `（观测告警，不改变执行行为；cacheRead 未按 1:1 计入——D7）`;
    this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'budget-observe', detail });
    this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'budget-observe', spent: this.taskSpentTokens(), threshold: this.#cfg.observeBudgetTokens, ratio: result.ratio, turn });
    this.#warn(`[stream-loop] ${detail}`);
  }

  // ------------------------------------------------------------------ 任务入口

  /**
   * 追加一条用户任务（Agent.followup 的驱动器侧入口：只进装配历史，不发请求）。
   *
   * 0.5.0：
   *  - D1 修复：记录任务起点计量快照（#usageBase / #injectedCharsBase）——budgetLevel
   *    从此用任务级差值；
   *  - §4.6 任务级预算指令：消息首行 `[tf-budget: 8steps/20k]` 解析后从正文剥离；
   *    结构化来源 message.source.tfBudget 同步支持（followup 透传 message，本方法读取）；
   *  - §3.3 约束 5：执行通道/档位切换在任务边界生效——pending 切换在此刻应用
   *    （通道切换 = 计划性换基；档位切换只改数值不换基）；
   *  - F7：记录当前任务块的起始下标——段边界只丢弃它之前的旧段。
   */
  pushUserTask(text        , message          )       {
    // —— 任务边界切换（先于任务块落位）——
    this.#applyPendingSwitches();
    // —— 任务级预算指令（§4.6：文本指令 + 结构化 source.tfBudget；文本指令优先剥除）——
    // 装配级显式上限不可逾越（§4.6：任务指令 > 会话默认 > 装配上限——"上限"是硬顶，
    // 任务指令只能收窄不能突破）。
    const parsed = parseTaskBudgetDirective(text);
    const structured = readStructuredTaskBudget(message);
    const taskBudget = {
      ...(parsed.budget ?? {}),
      ...(structured ?? {}),
    };
    const assemblySteps = this.#configRef.maxSteps ?? this.#configRef.maxRequests ?? 0;
    if (taskBudget.maxSteps !== undefined && assemblySteps > 0 && taskBudget.maxSteps > assemblySteps) {
      taskBudget.maxSteps = assemblySteps;
    }
    const assemblyInput = this.#configRef.maxInputTokens ?? 0;
    if (taskBudget.maxInputTokens !== undefined && assemblyInput > 0 && taskBudget.maxInputTokens > assemblyInput) {
      taskBudget.maxInputTokens = assemblyInput;
    }
    this.#taskBudget = taskBudget;
    // —— D1：任务起点计量快照 ——
    this.#usageBase = { ...this.#usage };
    this.#injectedCharsBase = this.#injectedChars;
    this.#taskRequestCount = 0;
    this.#rebasesTask = 0;
    this.#budgetWarned = false;
    this.#taskBudgetBlocked = null;
    this.#effects.length = 0;
    this.#effectCounter = 0;
    this.#peekBudgetUsed = 0;
    const peekMetricsBase = this.#obs.peekMetrics();
    this.#peekMetricsBase = { hits: peekMetricsBase.redundantHits, total: peekMetricsBase.peekRequests };
    this.#segmentKeepFrom = this.#renderer.appendBlockCount;
    this.#renderer.appendHistory({ role: 'user', content: parsed.text });
  }

  /** 运行中回合的 steer 入口（修复限制 2）：下一请求装配时进追加区（对齐内建
   *  "注入运行中回合的下一步"）；流内不打断的前提不变——当前流跑完才装配。 */
  pushSteer(text        , message          )       {
    this.#pendingSteers.push({ text, message });
  }

  /** 尚未消费（未进装配历史）的 steer 的原始消息（Agent.inbox.nextStep 的如实暴露面）。 */
  get pendingSteerMessages()                     {
    return this.#pendingSteers.map((s) => s.message);
  }

  /**
   * resume 重放（修复限制 4 的另一半）：把上一会话的 tf-* 台账事实回灌驱动器。
   * 只回放 'plugin:tf-agent/final'（finalCandidates → 最终答案跨 resume 可用）。
   * 刻意不回放命令记录：属性不回放则幂等指纹永不匹配，回放反而会占用 id 命名空间
   * 挡住合法重发；旧失败也不该在新回合里当作重入事由重新上报。finalCandidates
   * 不进 #commands，因此重放不会让 #finalSeen 立即为真——新回合仍须模型自己收尾。
   */
  rehydrateRecords(records                                                )                                       {
    let applied = 0;
    let skipped = 0;
    for (const rec of records) {
      const data = (rec.data !== null && typeof rec.data === 'object' ? rec.data : undefined)                                       ;
      if (rec.kind !== 'plugin:tf-agent/final' || data === undefined || typeof data['summary'] !== 'string') {
        skipped += 1;
        continue;
      }
      const cmdId = typeof data['cmdId'] === 'string' ? data['cmdId'] : `replayed-final-${applied + 1}`;
      const existing = this.#finalCandidates.find((c) => c.cmdId === cmdId);
      if (existing !== undefined) {
        existing.summary = data['summary']; // 同 id 携带新 summary = 覆盖（与运行中 last-wins 语义一致）
      } else {
        this.#finalCandidates.push({ cmdId, summary: data['summary'], turn: 0, step: 0 });
      }
      this.#record({ seq: ++DRIVER_SEQ, kind: 'final', summary: data['summary'] });
      applied += 1;
    }
    return { applied, skipped };
  }

  /** 外部取消（Agent.cancel 的入口）：中断当前流与在途请求，并 abort 回合 signal
   *  （K4：取消传导到工具派发与 tf-code runtime；abort 后由 drain 等待在途清理再收束）。 */
  cancel(reason         )       {
    this.#aborted = true;
    this.#abortReason = reason;
    for (const controller of this.#activeControllers) {
      controller.abort(reason instanceof Error ? reason : new Error(String(reason)));
    }
    this.#turnController?.abort(reason instanceof Error ? reason : new Error(String(reason)));
  }

  /** K4：回合 signal（runTurn 期间有效；缺省 = 一次性从未触发的 controller，兼容直派发路径）。 */
  #commandSignal()              {
    return this.#turnController?.signal ?? new AbortController().signal;
  }

  /** 跑一个回合（从当前装配历史到 FINISH/blocked）。异常一律上抛（fail-open，红线 5）。 */
  async runTurn()                         {
    // F6：resume 停机核对——"有意图无回执"时不发任何请求（零注入），直接 blocked，
    // 由用户核对意图日志（CLI `dsh-stream-agent intents`）后决定继续或放弃。
    if (this.#resumeHalt !== null) {
      const reason                = { kind: 'blocked', detail: `resume 停机核对（F6）：${this.#resumeHalt}——存在写前意图无回执，不自动重放；请人工核对后重试（CLI: dsh-stream-agent intents）。` };
      this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'resume-halt-pending-intents', detail: reason.kind === 'blocked' ? reason.detail : undefined });
      this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'resume-halt-pending-intents', turn: this.#turnCounter + 1 });
      this.#ports.events?.turnEnd(this.#turnCounter + 1, reason);
      return reason;
    }
    const turn = ++this.#turnCounter;
    const controller = new AbortController();
    this.#turnController = controller;
    this.#rebasesTurn = 0;
    this.#peekBudgetUsed = 0;
    // ---- 0.5.0（§4.5.3 / R11）：任务预算下限保护——低于 3×前缀估算时拒绝启动，
    // 返回"至少需要 N"的明确提示，避免必然失败的任务烧掉整个前缀（零请求）。----
    if (this.#taskBudgetBlocked === null) {
      const prefixEstimate = estimatePromptTokens(this.#renderer.stableMessages());
      const floor = checkTaskBudgetFloor(prefixEstimate, this.effectiveLimits().maxInputTokens);
      if (!floor.ok) {
        this.#taskBudgetBlocked = floor.reason;
        const reason                = { kind: 'blocked', detail: floor.reason };
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'task-budget-floor', detail: floor.reason });
        this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'task-budget-floor', minimum: floor.minimumInputTokens, prefixEstimate, turn });
        this.#ports.events?.turnStart(turn);
        try {
          this.#ports.events?.turnEnd(turn, reason);
        } catch (eventError) {
          this.#warn('turn/end 事件写入失败', eventError);
        }
        return reason;
      }
    } else {
      // 同任务的后续回合沿用首回合的下限结论（任务级一次性判定；恢复出口 = 新任务）。
      const reason                = { kind: 'blocked', detail: this.#taskBudgetBlocked };
      this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'task-budget-floor', detail: `${this.#taskBudgetBlocked}（沿用本任务首回合判定）` });
      this.#ports.events?.turnStart(turn);
      try {
        this.#ports.events?.turnEnd(turn, reason);
      } catch (eventError) {
        this.#warn('turn/end 事件写入失败', eventError);
      }
      return reason;
    }
    // F7 长会话段边界：追加区超过阈值时，在新回合开始处整块丢弃旧段（保留当前任务块起
    // 的全部块）。被丢弃原文句柄化登记（可 tf-peek 回取），显式记录缓存重置点。
    if (this.#cfg.segmentMaxChars > 0 && this.#segmentKeepFrom > 0 && this.#renderer.appendChars > this.#cfg.segmentMaxChars) {
      const before = this.#renderer.appendChars;
      const { dropped } = this.#renderer.dropAppendHead(this.#segmentKeepFrom, {
        reason: `append chars ${before} > segmentMaxChars ${this.#cfg.segmentMaxChars}（turn ${turn} 开始处，完整回合边界）`,
      });
      for (const [i, text] of dropped.entries()) {
        // 句柄化登记（obs：first observation → high，但不在命令通道上，永不自动注入；
        // tf-peek 按句柄取回原文——"原文可按 request:N 回取"的落地形态）
        this.#obs.observe({
          tool: 'tf-read',
          ok: true,
          key: `segment:turn${turn}:${i}`,
          content: text,
          callId: `seg-t${turn}-${i}`,
        });
      }
      this.#record({
        seq: ++DRIVER_SEQ, kind: 'observation',
        handle: dropped.length > 0 ? `obs:read:seg-t${turn}-0@v1` : null,
        key: `segment:turn${turn}`, infoGain: 'low', reason: 'segment-drop-handleized',
      });
      // v0.4.3（P0-7①）：段边界 = 显式缓存重置点，重置纪元 +1（request 记录携带 resetSeq/resetCause）；
      // wire 全文基线同步作废（dropAppendHead 是唯一合法的历史收缩通道，不走断言）。
      this.#resetSeq += 1;
      this.#resetCause = 'segment-drop';
      this.#lastRequest = null;
      this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'segment-drop', detail: `dropped ${dropped.length} blocks (${before} chars) at turn ${turn} boundary; originals handleized (obs:read:seg-t${turn}-*)` });
      this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'segment-drop', turn, droppedBlocks: dropped.length, chars: before });
      this.#segmentKeepFrom = 0;
    }
    debugTrace('turn.start', { turn });
    try {
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
    } finally {
      // K4：回合收束前等待在途命令清理完成（0 后置写），再释放回合 signal。
      await this.#drain();
      // v0.3.2：回合已结束但最后一步的易变尾还没轮到"下一请求"转正——在此收编，
      // 保证下个回合（或 resume 后的同会话）仍能看到最后一步的观测事实。
      if (this.#deliveredTail !== null && this.#deliveredTail.turn === turn) {
        this.#commitDeliveredTail();
      }
      if (this.#turnController === controller) this.#turnController = null;
    }
  }

  // ------------------------------------------------------------------ 回合主循环

  async #turnLoop(turn        )                         {
    let step = 0;
    // 防震荡护栏按回合重置（maxReentries / final nudge / final-only 档都是回合级护栏）——
    // 不重置的话，多任务长会话会在第 N 个回合被历史累计计数误杀（F7 长会话测试实抓）。
    this.#reentryCount = 0;
    this.#finalNudges = 0;
    this.#nudgeMark = null;
    this.#finalOnlyRequests = 0;
    // v0.3.1：final 收束闸的回合级状态（命令序按回合重置——上一回合的 final 不得收敛本回合）
    this.#cmdOrder = 0;
    this.#lastFinalOrder = 0;
    this.#lastNonFinalOrder = 0;
    this.#reportedFinalRejects.clear();
    this.#pendingReplays = [];
    this.#replays = 0;
    this.#replayCapped = false;
    this.#truncationRetries = 0;
    this.#truncation = null;
    // v0.4.3（P0-6）：回合级状态清零——append-drift 的每回合放行预算、兜底交付一次性标记、
    // 本回合命令集（兜底交付的"台账事实"来源）。
    this.#prefixResendsTurn = 0;
    this.#fallbackFinalDelivered = false;
    this.#turnCommandIds.clear();
    // v0.4.0（自 0.3.3 回流）：收束改造的回合级状态（停滞预算 / 收束期 / 产出水位）
    this.#stallReentries = 0;
    this.#progressOkMark = 0;
    this.#closeOutActive = false;
    this.#closeOutRequests = 0;
    let reason                = { kind: 'blocked', detail: 'turn loop exited without convergence' };

    while (true) {
      // v0.4.2：digest 的落史时机在流结束时（见 consumeStream 之后的 #commitStepDigest），
      // 易变尾的转正在 render 之后（转正块落位 = 上一请求尾部的同一位置）——两件事各就
      // 各位，下一请求的公共前缀即可覆盖上一请求的全部 prompt（无 transient 尾时缓存读零损失；
      // 有 transient（error/nudge）时该块在下一请求被丢弃，前缀在该 index 断裂——损失
      // bounded 一块，0.5.0 起按 transient-drop 计量）。
      // ---- 0.5.0（§4.5.2）：maxInputTokens 触顶压缩——在装配前判定，触顶即压缩旧段
      //（计划性换基：摘要落追加区 + 原文句柄化 + 基线重置 + 记账）。
      this.#maybeCompactForInputBudget(turn);
      // ---- steer 注入（修复限制 2）：运行中到达的 steer 在下一请求（内建的"下一步"）生效
      // ——进追加区（只追加，前缀单调不破）；流内不打断：当前流早已跑完才会走到这里。
      if (this.#pendingSteers.length > 0) {
        const steers = this.#pendingSteers.splice(0);
        for (const s of steers) {
          this.#renderer.appendHistory({
            role: 'user',
            content: `[tf-stream:steer]\n${s.text}\n（用户在回合进行中插入的指令；与本回合后续工作冲突时，以本指令为准）`,
          });
        }
      }
      const level = this.budgetLevel();
      step += 1;
      try {
        this.#ports.events?.stepStart(turn, step);
      } catch (error) {
        this.#warn('step/start 事件写入失败', error);
      }

      // ---- v0.4.0 工具面（P1）：每请求解析一次（首请求冻结；失败沿用旧面 degraded=stale）。
      // 无宿主面（toolSurface=off 或 L2）→ undefined，注入一行降级说明（级别转换时）。 ----
      const surface = await this.#surface.resolve({
        ...(this.#agentRef === undefined ? {} : { agent: this.#agentRef }),
        signal: this.#commandSignal(),
        modelSelection: { provider: this.#cfg.provider, model: this.#cfg.model, ...(this.#cfg.reasoningEffort === undefined ? {} : { reasoningEffort: this.#cfg.reasoningEffort }) },
      });
      this.#currentSurface = surface;
      // 降级判定：有宿主服务面且解析失败/缺席才是降级；headless 无服务面 = 稳态
      // protocol-only（0.3.x 行为），不注行不记账（避免对离线路径制造永久噪声）
      const degradedLevel                                            =
        surface?.degraded
        ?? (surface === undefined && this.#surface.hasService && this.#cfg.toolSurface !== 'off' ? 'protocol-only' : 'ok');
      if (degradedLevel !== 'ok' && degradedLevel !== this.#lastSurfaceDegraded) {
        // 降级注入走追加区（前缀单调不破；同级别不重复——只加一次级别转换行）
        this.#renderer.appendHistory({ role: 'user', content: degradedLine(degradedLevel) });
        this.#ledgerWrite('plugin:tf-agent/surface', { event: 'degrade', level: degradedLevel, frozenAt: surface?.frozenAt ?? 0 });
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: `surface-${degradedLevel}`, detail: `frozenAt=${surface?.frozenAt ?? 0}` });
      } else if (degradedLevel === 'ok' && this.#lastSurfaceDegraded !== 'ok') {
        this.#ledgerWrite('plugin:tf-agent/surface', { event: 'recover', frozenAt: surface?.frozenAt ?? 0 });
      }
      if (surface !== undefined && this.#lastSurfaceDegraded === 'ok' && surface.frozenAt === 1 && this.#cfg.toolSurface !== 'off') {
        // 首冻结审计（§8.4：surface:freeze 落 obs 台账，不落 session——E6 红线不变）
        this.#ledgerWrite('plugin:tf-agent/surface', { event: 'freeze', profile: surface.profile, tools: surface.names.length, nativeDeclared: surface.schemas.length, frozenAt: surface.frozenAt });
      }
      this.#lastSurfaceDegraded = degradedLevel;

      // ---- REQUEST：装配 + O6 preflight（render() 内置断言，违反即抛 → fail-closed）----
      let messages                 ;
      try {
        messages = this.#renderer.render();
      } catch (error) {
        // v0.4.3（P0-6③④⑤）：内置 preflight 抛出的 stable-drift 与 wire 断言同一条处置
        // 路径（0 重发 → 最小对账 → 兜底交付 → blocked）——异常上抛开发者日志，但不再是
        // 用户可见终态（旧实现直接炸出 runTurn，用户侧只剩半截输出）。
        if (!(error instanceof PrefixBrokenError)) throw error;
        const detail = this.#prefixFailClosed(error, turn, step, 'render() 内置 preflight');
        // v0.4.0：兜底交付必须先于 step/end（assistant/message 需落在打开的 turn+step 内）
        this.#deliverFallbackFinal(turn, step, detail);
        try {
          this.#ports.events?.stepEnd(turn, step);
        } catch (stepError) {
          this.#warn('step/end 事件写入失败', stepError);
        }
        reason = { kind: 'blocked', detail: `前缀校验失败（fail-closed，拒绝发送）：${detail}` };
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'turn-blocked', detail: reason.detail });
        break;
      }
      // v0.4.3（P0-6①②）：wire 边界承诺前缀断言——比较对象是**上一请求收尾后的稳定段**
      // （#lastRequest.promised：转正之后的 stableMessages() 逐字节快照）。render() 内置
      // preflight 只守装配时的 stable；本断言补上两个盲区：转正块与已发文本逐字节一致、
      // 追加区不被代码改写。v0.4.3.1：基线从"上一请求前 N 条（horizon）"改为 promised——
      // 与易变尾块序完全解耦（混合尾 error 前置不再误报 append-drift，核查 §2）。
      // 失败按三类处置（P0-6③④）：append-drift 预算内放行一次；其余 fail-closed。
      if (this.#cfg.faultPrefixDrift !== undefined) this.#faultDriftBaseline(turn);
      const wire = this.#assertWirePrefix(messages, turn, step);
      if (wire.verdict === 'fail') {
        // P0-6⑤：有产出时才有交付。顺序固定：receipt 最小对账（#prefixFailClosed 内）→ 兜底交付 → step/end → blocked。
        this.#deliverFallbackFinal(turn, step, wire.detail);
        try {
          this.#ports.events?.stepEnd(turn, step);
        } catch (error) {
          this.#warn('step/end 事件写入失败', error);
        }
        reason = { kind: 'blocked', detail: `前缀校验失败（fail-closed，拒绝发送）：${wire.detail}` };
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'turn-blocked', detail: reason.detail });
        break;
      }
      // 分类锚点必须在转正前取（转正会增长 stableMessages）；承诺前缀 = 转正后的稳定段
      // ——下一请求的前 promised.length 条必须与它逐字节一致（transient 尾块不在承诺里）。
      const stableLen = this.#renderer.stableMessages().length;
      // v0.4.2：**刚随本请求发出的**易变尾在此转正——落位 = 它在本请求 prompt 里的同一
      // 位置（尾部），下一请求的公共前缀因此覆盖本请求的全部 prompt（无 transient 尾时
      // 缓存读零损失；有 transient 时前缀在该 index 断裂，损失 bounded 一块）。
      // 本步的 digest 在流结束时就地落史（见 consumeStream 之后），时序：转正 → digest。
      this.#commitDeliveredTail();
      this.#lastRequest = { promised: this.#renderer.stableMessages(), stableLen };
      const stableHash = this.#renderer.stableHash();
      this.#stableHashes.push(stableHash);
      const fullHash = renderHash(messages);
      // v0.4.3（P0-7①）：request 记录携带尺子——prefixTokensEst（本地估算，交叉校验用）、
      // resetSeq/resetCause（重置纪元）、feedbackBytes（反馈字节分类快照，取后清零）。
      // providerInput/cacheRead/cacheWrite/output 在流末由 usage chunk 回填（记录先建、数字后补）。
      const requestRecord                = {
        seq: ++DRIVER_SEQ, kind: 'request', turn, step,
        provider: this.#cfg.provider, model: this.#cfg.model,
        level, stableHash, renderHash: fullHash,
        injectionBlocks: 0,
        prefixTokensEst: estimatePromptTokens(messages),
        resetSeq: this.#resetSeq,
        ...(this.#resetCause === undefined ? {} : { resetCause: this.#resetCause }),
        feedbackBytes: { ...this.#feedbackBytes },
      };
      this.#feedbackBytes = { full: 0, dedup: 0, handle: 0 };
      this.#record(requestRecord);

      // ---- STREAMING：逐 delta 消费；命令闭合即派发，不结束流 ----
      const streamOutcome = await this.#consumeStream(turn, step, messages, level);
      // v0.4.3（P0-7①）：本请求的实际计量回填（usage chunk 在流末才到；同一对象引用，外部
      // 复算口径 = Σ request 记录的 providerInputTokens，权威值非估算——E9）。
      if (streamOutcome.usage !== null) {
        const u = streamOutcome.usage;
        requestRecord.providerInputTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
        requestRecord.cacheRead = u.cacheReadTokens;
        requestRecord.cacheWrite = u.cacheWriteTokens;
        requestRecord.output = u.outputTokens;
      }
      // 0.5.0（D7）：观测预算——只告警不改行为（严格口径，cacheRead 不按 1:1 计入）。
      this.#observeBudgetOnce(turn);

      // 不可重试的流错误（凭据/配置层）：fail-fast 终止回合，不进重入循环
      if (streamOutcome.finish.kind === 'error' && NON_RETRYABLE_STREAM_CODES.has(finishCode(streamOutcome.finish))) {
        // v0.3.0：step/end 之前必须等在途工具落定——流中途已派发的 tool/call 若在
        // step/end 之后才写 tool/result，v4 校验会判"tool/call 不在打开的 step 内"→ corrupt。
        await this.#drain();
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
      // v0.3.0：step/end 推迟到"收束判定"之后——final 答案是 assistant/message，
      // v4 格式要求它落在打开的 turn+step 内；此前在 step/end 之后写会被判
      // "assistant/message does not match an open turn and step" → 整条会话 corrupt。

      // v0.4.2：本步的正文 + 命令摘要**就地落史**（流结束即落，不等下一轮循环顶部）。
      // 时序红线：易变尾的转正发生在 render 之后（转正块落位 = 上一请求尾部的同一位置），
      // digest 必须在转正之后追加——下一请求的公共前缀才能覆盖上一请求的全部 prompt
      //（无 transient 尾时缓存读零损失；digest 在转正前落史会把转正块整体挤到错位，
      // 每条注入被双倍支付）。
      this.#commitStepDigest();

      // ---- 收束判定（仅三种重入事由：失败/拒绝、high 观测、peek 需求）----
      const issues = this.#collectIssues();
      const injections = this.#buildInjections(issues, level);
      // v0.3.2 截断修复：输出在命令中途被截断（max-tokens / 流异常终止 / DSML 块未闭合）时，
      // 0.3.1 只记一条 truncated 台账、不产生任何重入事由——模型以为任务结束，用户看到
      // 半截输出。这里强制一次续写注入（带上已生成内容尾部，便于从断点续写）；
      // 回合级上限 MAX_TRUNCATION_RETRIES，超限如实 blocked，不无限烧请求。
      if (this.#truncation !== null && level !== 'final-only' && this.#truncationRetries < MAX_TRUNCATION_RETRIES) {
        this.#truncationRetries += 1;
        injections.blocks.push({ role: 'user', content: truncationNudge(this.#truncation) });
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'output-truncated', detail: `${this.#truncation.reason}（第 ${this.#truncationRetries} 次续写）` });
        this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'output-truncated', reason: this.#truncation.reason, retry: this.#truncationRetries, turn });
      }
      // v0.4.0（自 0.3.3 回流）：畸形/孤立闭合标签的定向纠错注入（一次性；final-only 档
      // 不注入——预算已枯竭）。挂块即成为重入事由（injections.blocks.length > 0）——真机
      // 场景里"纯 prose 残片 + 无命令无 final"的流也会因此重入一次，模型拿到纠错信号后继续干活。
      if (this.#strayCloseNudge !== null && level !== 'final-only') {
        injections.blocks.push({ role: 'user', content: this.#strayCloseNudge });
        this.#strayCloseNudge = null;
      }
      // 饥饿防线（07 号结果 §3.6 上报的断链，08 号评测前按其建议修复）：
      // 升格骨架接入注入通路（按 high 观测同款格式；final-only 档不注入——预算已枯竭）。
      // v0.4.0（自 0.3.3 回流）：**先只算块、不挂块**——升格是"补充上下文"，不是重入事由。
      // 此前它无条件挂进 injections.blocks，只要本步有一条升格就必然 needsReentry=true：
      // 模型已经给出合法 tf-final，却被一块"补充观测"顶掉 completed，回合继续烧请求直到撞墙。
      const promoted = this.#obs.noteStep(injections.highInjected);
      const promotedBlock                       = promoted !== null
        && level !== 'final-only'
        && !this.#reportedObservations.has(promoted.seq)
        ? {
          role: 'user',
          content: `[tf-stream:observation handle=${promoted.handle ?? ''} key=starvation-promoted]\n${(promoted.payload                         ).rendered ?? ''}\n（细节用 tf-peek handle="${promoted.handle}" from_line=.. to_line=.. 取回）`,
        }
        : null;
      const promotedSeq = promotedBlock === null ? null : promoted.seq;

      if (streamOutcome.finish.kind === 'error' || streamOutcome.finish.kind === 'aborted') {
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: `stream-${streamOutcome.finish.kind}`, detail: finishDetail(streamOutcome.finish) });
        this.#ledgerWrite('plugin:tf-agent/fault', { fault: `stream-${streamOutcome.finish.kind}`, detail: finishDetail(streamOutcome.finish), turn });
      }

      // ---- final 收束闸（真连 R3/R4 教训 + v0.3.1 截断修复）----
      // 四类拒绝，任一成立都说明"这条 final 不能作为交付答案"：
      //   ① depends_on 未满足 / ② 仍有命令未完成（原有过早判定）
      //   ③ summary 是占位（placeholder / 占位 / 空……）—— 0.3.1 真机证据：写成
      //      `summary="placeholder"` 的 final 被照单全收，用户侧看到的就是"截断 + 一句占位"
      //   ④ 这条 final 之后又发过命令 —— 模型写完 final 又继续干活，旧答案已过期，
      //      必须在本流末尾重新声明（0.3.1 同一会话：第 4 步的 final 被第 7 步复用为答案）
      // 拒绝只注入一次（同 cmdId+kind）：二次不放行、也不重复烧注入，交给 nudge 护栏收束。
      const candidate = this.#finalCandidates.length > 0 ? this.#finalCandidates[this.#finalCandidates.length - 1] : undefined;
      // 回合归属：上一回合的 final（或 resume 回放 turn=0）不得充当本回合答案
      const lastFinal = candidate !== undefined && candidate.turn === turn ? candidate : undefined;
      let prematureFinal                    ;
      let rejectedFinal                    ;
      if (lastFinal !== undefined && level !== 'final-only') {
        const finalRec = this.#commands.get(lastFinal.cmdId);
        const unmetDeps = (finalRec?.cmd.depends_on ?? []).filter((d) => this.#commands.get(d)?.status !== 'ok');
        const unfinished = [...this.#commands.values()].filter((r) => r.cmd.name !== 'tf-final' && (r.status === 'pending' || r.status === 'dispatched'));
        prematureFinal = unmetDeps.length > 0
          ? `tf-final 过早：depends_on 未满足（${unmetDeps.join(', ')}）`
          : unfinished.length > 0
            ? 'tf-final 过早：仍有命令未完成'
            : undefined;
        // F5：计划存在且还有未验证的验收项 → tf-final 过早（缺项或未验证不得标完成；
        // 验证只能来自命令成功回执，模型自述不算）。
        if (prematureFinal === undefined && this.#cfg.enablePlan && this.#plan !== null) {
          const open = [...this.#plan.items.entries()].filter(([, item]) => item.status === 'open');
          if (open.length > 0) {
            prematureFinal = `tf-final 过早：计划有 ${open.length} 项验收未验证（${open.map(([id]) => id).join(', ')}）——完成对应命令并用 accepts="..." 声明回执，或用 tf-plan 修订计划（显式移除不再需要的项）。`;
          }
        }
        // ③④ 内容面：占位 summary / 过期 final
        let hardIssue                                              ;
        if (prematureFinal === undefined) {
          const summaryIssue = checkFinalSummary(lastFinal.summary);
          if (summaryIssue !== null) {
            hardIssue = { kind: summaryIssue.kind, detail: `tf-final 无效：${summaryIssue.detail}` };
          } else if (this.#lastFinalOrder > 0 && this.#lastNonFinalOrder > this.#lastFinalOrder) {
            hardIssue = {
              kind: 'stale',
              detail: 'tf-final 无效：这条 final 之后又发出了命令（答案已过期）——请在本流末尾用新 id 重新输出 tf-final，summary 写最终答案原文',
            };
          }
        }
        if (hardIssue !== undefined) {
          // key 只按 kind：换新 id 再写一次占位/过期 final，是同一个毛病，不再重复烧注入
          if (this.#reportedFinalRejects.has(hardIssue.kind)) {
            // 已提示过仍未改：不重复注入，也不放行收敛（走 nudge / blocked，如实收场）
            rejectedFinal = hardIssue.detail;
          } else {
            this.#reportedFinalRejects.add(hardIssue.kind);
            prematureFinal = hardIssue.detail;
          }
        }
      }

      const finalSeen = lastFinal !== undefined && prematureFinal === undefined && rejectedFinal === undefined;
      // 0.5.0：标准通道才有 tf-final 收束概念；代码通道（§3.2：验收闸 否）流正常终止
      // 且无重入事由即收束，交付物 = 最后一条 assistant 消息。
      const expectsFinal = this.#cfg.channel === 'standard';
      // steer 在本流期间到达 → 不能带着未消费的 steer 收敛（对齐内建：插话必须被下一步看到）
      const pendingSteerCount = this.#pendingSteers.length;
      const needsReentry = issues.length > 0 || injections.blocks.length > 0 || prematureFinal !== undefined
        || pendingSteerCount > 0 || (promotedBlock !== null && !finalSeen);

      if (!expectsFinal && !needsReentry && streamOutcome.finish.kind !== 'error' && streamOutcome.finish.kind !== 'aborted') {
        // 代码通道收束：无 tf-final、无验收闸——流正常终止且无事由即完成（§3.2 能力矩阵）
        reason = { kind: 'completed' };
        const prose = normalizeProse(this.#streamProse);
        if (prose !== '') {
          try {
            this.#ports.events?.finalAnswer?.(turn, step, prose);
          } catch (error) {
            this.#warn('final 答案消息写入失败', error);
          }
        }
        try {
          this.#ports.events?.stepEnd(turn, step);
        } catch (error) {
          this.#warn('step/end 事件写入失败', error);
        }
        break;
      }

      if (prematureFinal !== undefined && lastFinal !== undefined) {
        // v0.3.2：计划门槛拒绝时附上计划快照——模型看不到计划内容就无法验收
        //（真机里计划只在创建那一步的易变尾出现过一次，随后彻底消失）。
        const planBlock = prematureFinal.includes('计划') ? this.#planSnapshot() : '';
        injections.blocks.push({
          role: 'user'         ,
          content: `[tf-stream:error id=${lastFinal.cmdId} cmd=tf-final] ${prematureFinal}\n`
            + (planBlock !== '' ? `当前计划：\n${planBlock}\n` : '')
            + '建议：先取回所需结果（tf-peek）或补齐未完成命令，然后在流末尾用新 id 重发 tf-final；summary 必须包含最终答案原文（数字/行内容/路径/结论），不得占位。',
        });
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'premature-final', detail: prematureFinal });
        this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'premature-final', detail: prematureFinal, turn });
      }

      if (finalSeen && !needsReentry) {
        // 成功路径：零注入，只写 ledger —— 分派 06 核心命题
        reason = { kind: 'completed' };
        // 最终答案落会话：headless 输出与评测 checks 消费最后一条 assistant 消息。
        // v0.3.0：必须在 step/end 之前写（v4 的 assistant/message 要求打开的 turn+step）。
        if (lastFinal !== undefined && lastFinal.summary.trim() !== '') {
          try {
            this.#ports.events?.finalAnswer?.(turn, step, lastFinal.summary);
          } catch (error) {
            this.#warn('final 答案消息写入失败', error);
          }
        }
        try {
          this.#ports.events?.stepEnd(turn, step);
        } catch (error) {
          this.#warn('step/end 事件写入失败', error);
        }
        break;
      }

      // 非成功路径（重入 / 阻断 / 取消）：本步到此结束。
      // v0.4.0（自 0.3.3 回流）：step/end 的时机下移到收束判定之后——兜底交付是一条
      // assistant/message，v4 校验要求它落在**打开的** turn+step 内，先写 step/end 会被判 corrupt。

      const finalOnlyGate = level === 'final-only' && this.#finalOnlyRequests >= 1;
      // v0.4.2：nudge 进度感知护栏。nudge 不再是一次性预算——被提示后模型**继续产出**
      // （新 ok 命令）就不算"提示失效"，绝不因此中断生产性工作；只有"零产出的连续
      // nudge"（真打转）才 blocked。整体仍由停滞预算 / 请求硬上限 / O5 预算阶梯兜底。
      // 真机取证（session-8f22c7a0）：旧语义下 nudge 在写文件步被消耗，随后的崩溃步
      // （或任何无注入的写步）直接 nudgeExhausted → 任务中断。
      const okCommandCount = [...this.#commands.values()].filter((r) => r.status === 'ok').length;
      const progressSinceNudge = this.#nudgeMark === null || okCommandCount > this.#nudgeMark;
      const nudgeExhausted = !needsReentry && !finalSeen && this.#finalNudges >= 1 && !progressSinceNudge;

      // v0.4.0 收束改造 —— 真机"任务被砍在半途、用户只看到最后一句 prose"的根因就在这里：
      // 旧实现 `#reentryCount >= maxReentries` 把**生产性重入**（每步都在读/写/跑命令、
      // 每步都拿到新事实）与**原地打转**一视同仁，第 12 步 hard blocked；且收束时没有任何
      // 兜底交付，界面于是停在最后一句 prose 上（session-6bb805db / 27876fd9 / 7fbfef8f）。
      // 新口径分三账，互不串味：
      //   ① 停滞预算 #stallReentries——只在"本步没有新增 ok 命令"的重入上累加（真打转）；
      //      有产出就清零并退出收束期，生产性工作不再被"重入次数"硬杀。
      //   ② 请求硬上限 #cfg.maxRequests——绝对闸（生产性步骤也计），防 token 黑洞。
      //   ③ 收束期 #closeOutActive——撞墙但**有事实可交付**时不立刻砍：注入一条"停止探索、
      //      立即 tf-final"的收束指令（回合内最多 closeOutRequests 次），用尽仍无 final 则
      //      写一条明确标注未完成的兜底交付（#buildFallbackFinal，台账事实，不伪造结论）。
      // 0.5.0（§4.5.2）：N 上限 = maxSteps（任务指令 > 会话默认 > 档位值；0 = 无上限）。
      // 触顶行为 = 停止探索、注入收束指令要求 tf-final（收束期）——不是直接硬杀。
      const stepLimit = shouldStopForSteps(step, {
        maxInputTokens: this.effectiveLimits().maxInputTokens,
        maxSteps: this.effectiveLimits().maxSteps,
        aggressiveness: this.#cfg.compactAggressiveness,
      });
      const hardCap = stepLimit.atLimit;
      const stallExhausted = this.#stallReentries >= this.#cfg.stallReentries;
      const atWall = finalOnlyGate || nudgeExhausted || hardCap || stallExhausted;
      let wallDetail = '';
      let closeOut = false;
      let ending = false;
      if (this.#aborted) {
        ending = true;
        reason = { kind: 'aborted', reason: this.#abortReason instanceof Error ? this.#abortReason.message : String(this.#abortReason ?? 'cancelled') };
      } else if (atWall) {
        wallDetail = finalOnlyGate
          ? '预算进入 final-only 档'
          : hardCap
            ? stepLimit.reason
            : stallExhausted
              ? `连续 ${this.#cfg.stallReentries} 次重入无新增产出`
              : '流终止且无 tf-final、无重入事由（提示一次后仍未收敛）';
        // 收束期只对"有事实可交付"的回合开放：零产出回合没有可交付内容，多烧一次请求
        // 只会再得到一段 prose（真机 nudge 空转的形态）。final-only 档不开放（该档自身
        // 已带 degraded 收束注入）。0.5.0（§4.5.2）：maxSteps 触顶同样先给收束期——
        // "触顶行为 = 停止探索，注入收束指令要求 tf-final"，closeOutRequests 限次数。
        const deliverable = this.#productiveOkCount() > 0;
        const closeOutLeft = this.#cfg.closeOutRequests - this.#closeOutRequests;
        if (deliverable && !finalSeen && closeOutLeft > 0 && level !== 'final-only') {
          this.#closeOutRequests += 1;
          this.#closeOutActive = true;
          closeOut = true;
          this.#record({
            seq: ++DRIVER_SEQ, kind: 'fault', fault: 'closeout-nudge',
            detail: `${wallDetail} → 收束第 ${this.#closeOutRequests}/${this.#cfg.closeOutRequests} 次`,
          });
          this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'closeout-nudge', detail: wallDetail, attempt: this.#closeOutRequests, turn });
        } else {
          ending = true;
          reason = {
            kind: 'blocked',
            detail: rejectedFinal !== undefined
              ? `final 被拒且未重发（${rejectedFinal}）：不把占位/过期答案当交付${deliverable ? `；${wallDetail}` : ''}`
              : `${wallDetail} → 回合收束`,
          };
        }
      }

      // v0.4.0：走到这里说明本步不会以"合法 final"收场——升格块这才真正挂上
      //（成功路径已在上面 break，不会再被补充块顶掉）。
      if (promotedBlock !== null && promotedSeq !== null) {
        this.#reportedObservations.add(promotedSeq);
        injections.blocks.push(promotedBlock);
        // v0.4.3（P0-7①）：升格骨架 = handle 类反馈
        this.#noteFeedback('handle', promotedBlock.content);
      }

      if (ending) {
        // 兜底交付：必须在 step/end 之前写（assistant/message 需落在打开的 turn+step 内）
        if (reason.kind === 'blocked') this.#deliverFallbackFinal(turn, step, reason.detail);
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'turn-blocked', detail: reason.kind === 'blocked' ? reason.detail : reason.kind });
        try {
          this.#ports.events?.stepEnd(turn, step);
        } catch (error) {
          this.#warn('step/end 事件写入失败', error);
        }
        break;
      }

      // 重入路径（含收束期）：本步结束
      try {
        this.#ports.events?.stepEnd(turn, step);
      } catch (error) {
        this.#warn('step/end 事件写入失败', error);
      }

      // ---- INJECTING：O3 句柄目录差分（追加区）+ 易变尾注入，发下一请求 ----
      const delta = this.#obs.directoryDelta(this.#deltaCursor);
      const maxSeq = [...delta.added, ...delta.changed, ...delta.stale].reduce((m, e) => Math.max(m, e.seq), this.#deltaCursor);
      this.#deltaCursor = maxSeq;
      this.#renderer.appendHandleDelta(delta);

      let tail = injections.blocks;
      // v0.3.1：重复命令的原结果回灌。只在此处（确实要发下一请求）才物化——
      // 上面所有收敛/阻断分支都已 break，不会白记账、也不会白读内容。
      const replays = this.#materializeReplays();
      if (replays.length > 0) tail = [...tail, ...replays];
      if (closeOut) {
        // 收束期：保留失败/拒绝事实块（模型要知道哪里错了），收束指令压在最末
        tail = [...tail, { role: 'user'         , content: this.#closeOutNudge(this.#closeOutRequests, wallDetail) }];
      } else if (tail.length === 0 && !finalSeen) {
        if (level === 'final-only') {
          // O5 >90% 档：停止一切注入，输出降级交付（已完成/未完成/已排除见台账），只收 tf-final
          tail = [{
            role: 'user'         ,
            content: `[tf-stream:degraded] 预算已进入 final-only 档：停止一切注入。请根据台账现状立即输出 tf-final 结束任务；未完成项将在交付说明中列为未完成。`,
          }];
          this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'degraded-delivery' });
          this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'degraded-delivery', turn });
        } else {
          // 无重入事由但也没 tf-final：进度感知提示（护栏防无限循环——真打转由
          // nudgeExhausted 的"零产出"判定收束，不靠提示次数）。
          this.#finalNudges += 1;
          this.#nudgeMark = [...this.#commands.values()].filter((r) => r.status === 'ok').length;
          tail = [{
            role: 'user'         ,
            content: rejectedFinal !== undefined
              ? `[tf-stream:nudge] 上一条 tf-final 被拒（${rejectedFinal}）。请继续任务并在流末尾用新 id 重发 tf-final，summary 写最终答案原文；任务确实没做完就如实写明未完成项。`
              : '[tf-stream:nudge] 输出已终止但未收到 tf-final。若任务已完成请输出 tf-final；否则继续输出剩余 tf-* 命令。',
          }];
          this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'missing-final-nudge' });
        }
      }
      this.#injectedChars += tail.reduce((n, b) => n + b.content.length, 0);
      if (level === 'final-only') this.#finalOnlyRequests += 1;
      // v0.4.0（自 0.3.3 回流）缓存友好排序：durable 块（observation/peek/replay/tool-result/
      // plan/receipt）前置，非 durable 块（error/nudge/closeout）后置。理由在 #commitDeliveredTail：
      // 只有 durable 块会转正进历史，一旦非 durable 块夹在 durable 块**前面**，转正后的历史
      // 就在那一处与上一请求的 prompt 分叉——其后所有 durable 块（一次读注入可达上万字符）
      // 全部退化成未缓存输入。两组内部保持原有相对顺序，durable 子序列单调不破（P0-6 的
      // promised 承诺只覆盖该子序列，排序不影响其逐字节一致性）。
      tail = [...tail.filter(isDurableBlock), ...tail.filter((b) => !isDurableBlock(b))];
      this.#renderer.setTail(tail);
      // v0.3.2：这批尾块会随下一请求发出；发出后由 #commitDeliveredTail 转正为历史。
      this.#deliveredTail = {
        turn,
        step,
        blocks: tail.map((b) => ({ role: (b.role ?? 'user')                         , content: b.content })),
      };
      // v0.4.0：停滞计数——判据是"本步是否新增了生产性 ok 命令"，不是重入次数。
      const productiveNow = this.#productiveOkCount();
      if (productiveNow > this.#progressOkMark) {
        this.#progressOkMark = productiveNow;
        this.#stallReentries = 0;
        this.#closeOutActive = false;
      } else if (!closeOut) {
        this.#stallReentries += 1;
      }
      this.#reentryCount += 1;
    }

    this.#record({ seq: ++DRIVER_SEQ, kind: 'turn-end', reason });
    try {
      this.#ports.events?.turnEnd(turn, reason);
    } catch (error) {
      this.#warn('turn/end 事件写入失败', error);
    }
    // v0.4.2：回合台账带缓存口径（hit 比 = cacheRead / 计费输入；适配器未上报时省略——
    // 不把缺数据写成 0%）。缓存命中是 O6 前缀单调性的直接收益，必须可观测可对账。
    const billedInput = this.#usage.inputTokens + this.#usage.cacheReadTokens + this.#usage.cacheWriteTokens;
    const cacheHitRatio = billedInput > 0 ? Math.round((this.#usage.cacheReadTokens / billedInput) * 100) / 100 : undefined;
    this.#ledgerWrite('plugin:tf-agent/step', {
      turn, steps: step, requests: this.#requestCount,
      usage: { ...this.#usage },
      ...(cacheHitRatio === undefined ? {} : { cacheHitRatio }),
      reason: reason.kind,
    });
    return reason;
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
  )           
                             
                                                                        
                                                                                                                   
     {
    // 新流：隐式写序的流内序号清零（跨流依赖仍由 depends_on 显式声明）
    this.#streamSeqCounter = 0;
    this.#streamWrites = [];
    // v0.3.2：本步摘要与截断事实（续写注入 + 追加区转录用）
    this.#stepCommandIds = [];
    this.#stepNatives = [];
    this.#truncation = null;
    const parser = new TfStreamParser();
    const controller = new AbortController();
    this.#activeControllers.add(controller);
    let textBuf = '';
    this.#streamProse = '';
    let reasoningChars = 0;
    // v0.3.1：思考过程捕获（按块 index 分段，落盘时按到达序拼接为单个 reasoning 块）
    const reasoningParts           = [];
    let reasoningLastIndex                = null;
    const natives = new Map                               ();
    let finish                          = null;
    let usageSeen                                                           ;
    // v0.4.3（P0-7①）：本请求的 usage 累计（多条 usage chunk 相加；适配器未上报 → 保持 null）
    let requestUsage                                                                                                          = null;

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

    // v0.3.1 实时帧：流开始即发 start 帧（契约见 #frameEmit）。思考过程
    // （reasoning-delta）逐帧透传——桌面端思考区 live 渲染的数据源。正文不逐帧透传：
    // 流文本是协议标记（tf-*），实时显示会把标记闪成乱码；落盘后以纯 prose 消息呈现。
    // 发射异常即熔断（本会话不再发），任务不受影响（fail-open）。
    const frameStart = ()       => this.#frameStartAttempt(turn, step);
    const frameEnd = (settlement                                                 )       =>
      this.#frameEndAttempt(settlement);

    try {
      if (this.#cfg.provider === '' || this.#cfg.model === '') {
        // 无模型路由（桌面端未选择模型且无默认）：失败注入引导，不静默烧流
        return {
          finish: {
            kind: 'error'         ,
            message: '未解析到可用模型路由（provider/model 为空）：请先在界面选择模型后重试',
            code: 'NO_MODEL_ROUTE',
          },
          usage: null,
        };
      }
      const stream = this.#ports.stream({
        provider: this.#cfg.provider,
        model: this.#cfg.model,
        reasoningEffort: this.#cfg.reasoningEffort,
        messages: toWireMessages(messages),
        // v0.4.0（P1）：nativeTools 开启时携带冻结面 schema（core 档白名单 / standard-full 全量）。
        // 默认关闭——schema 的每请求 token 成本由 tf-call 的逐调用成本替代（§15 默认文本）。
        ...(this.#cfg.nativeTools && this.#currentSurface !== undefined && this.#currentSurface.schemas.length > 0
          ? { tools: this.#currentSurface.schemas }
          : {}),
        signal: controller.signal,
        sessionId: this.#sessionId,
      });
      this.#requestCount += 1;
      this.#taskRequestCount += 1;
      debugTrace('stream.call', {
        turn,
        step,
        provider: this.#cfg.provider,
        model: this.#cfg.model,
        messages: messages.length,
        sessionProbe: this.#sessionProbe(),
      });
      frameStart();

      for await (const chunk of stream) {
        bump();
        switch (chunk.type) {
          case 'text-delta':
            textBuf += chunk.text;
            feed(chunk.text);
            break;
          case 'reasoning-delta': {
            reasoningChars += chunk.text.length; // 思维链不进协议解析，只计体积
            // v0.3.1：思考过程捕获 + 实时帧（桌面端思考过程 live 显示的数据源）
            if (reasoningLastIndex !== chunk.index) {
              reasoningParts.push(chunk.text);
              reasoningLastIndex = chunk.index;
            } else {
              reasoningParts[reasoningParts.length - 1] += chunk.text;
            }
            this.#frameReasoningDelta(chunk.index, chunk.text);
            break;
          }
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
            // v0.4.2：缓存口径（缺省 0——mock/旧适配器不上报时零漂移）。
            this.#usage.cacheReadTokens += chunk.usage.cacheReadTokens ?? 0;
            this.#usage.cacheWriteTokens += chunk.usage.cacheWriteTokens ?? 0;
            // v0.4.3（P0-7①）：本请求的 usage 累计（回填 request 记录的尺子字段）。
            requestUsage = requestUsage === null
              ? {
                  inputTokens: chunk.usage.inputTokens,
                  outputTokens: chunk.usage.outputTokens,
                  cacheReadTokens: chunk.usage.cacheReadTokens ?? 0,
                  cacheWriteTokens: chunk.usage.cacheWriteTokens ?? 0,
                }
              : {
                  inputTokens: requestUsage.inputTokens + chunk.usage.inputTokens,
                  outputTokens: requestUsage.outputTokens + chunk.usage.outputTokens,
                  cacheReadTokens: requestUsage.cacheReadTokens + (chunk.usage.cacheReadTokens ?? 0),
                  cacheWriteTokens: requestUsage.cacheWriteTokens + (chunk.usage.cacheWriteTokens ?? 0),
                };
            this.#record({
              seq: ++DRIVER_SEQ, kind: 'usage', turn,
              inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens,
              ...(chunk.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: chunk.usage.cacheReadTokens }),
              ...(chunk.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: chunk.usage.cacheWriteTokens }),
            });
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

    // v0.3.2：finish=max-tokens 本身就是"输出被截断"的硬信号（即使命令恰好闭合，
    // 正文也可能停在半句）。与 parser 的 truncated 事件合并成一次续写事由。
    if (finish.kind === 'max-tokens' && this.#truncation === null) {
      this.#truncation = { reason: 'max-tokens', raw: this.#streamProse };
    }
    // 本步摘要：下一步请求装配前落追加区（#commitStepDigest）
    this.#stepNatives = (finish.kind === 'stop' || finish.kind === 'tool-calls')
      ? [...natives.values()].map((c) => ({ id: c.id, name: c.name ?? 'unknown' }))
      : [];
    this.#lastStepDigest = {
      turn,
      step,
      prose: this.#streamProse,
      cmdIds: [...this.#stepCommandIds],
      natives: [...this.#stepNatives],
    };

    // 会话落盘：assistant 消息（成功 → assistant/message；error/aborted → attempt / 中断消息）
    // v0.3.0：原生 tool_call 通道要在**同一条** assistant 消息里广告 tool-call 块，
    // 否则随后宿主写出的 tool/call 在 v4 格式校验里没有生命周期 → 历史加载被判 corrupt。
    // 只有确定会执行的批次才广告（error/aborted 的残缺调用如实丢弃，不能留下未解广告）。
    // v0.3.1：正文落盘从整段原文改为纯 prose（#streamProse，parser text 事件拼接）——
    // 协议标记（tf-*/DSML）留在台账与会话事实层，桌面端过程区只显示可读文本。
    const nativeCallsWillRun = (finish.kind === 'stop' || finish.kind === 'tool-calls') && natives.size > 0;
    const nativeAds                          = nativeCallsWillRun
      ? [...natives.values()].map((c) => ({ id: c.id, name: c.name ?? 'unknown', arguments: c.arguments || '{}' }))
      : [];
    const reasoningText = reasoningParts.join('\n');
    let settlement                                                 ;
    try {
      // v0.3.2：落盘正文归一化（去纯空白消息 / 压缩连续空行）——0.3.1 常见 "\n\n\n\n"
      // 空气泡，桌面端过程区看起来就是"被截断的空白"。
      settlement = this.#ports.events?.assistantMessage(turn, step, normalizeProse(this.#streamProse), {
        finish,
        usage: usageSeen,
        toolCalls: nativeAds,
        ...(reasoningText !== '' ? { reasoning: reasoningText } : {}),
      });
    } catch (error) {
      this.#warn('assistant 事件写入失败', error);
    }
    frameEnd(settlement);
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

    return { finish, usage: requestUsage };
  }

  // ------------------------------------------------------------------ parser 事件处理

  #handleParserEvent(event             , turn        , step        )       {
    switch (event.type) {
      case 'text':
        // v0.3.1：prose 累积（落盘 assistant/message 的正文；0.3.0 落整段原文，协议
        // 标记会在桌面端渲染成乱码）。命令本体已作为 command 事件处理，不进 prose。
        this.#streamProse += event.text;
        break;
      case 'command':
        this.#onCommand(event.command, turn, step);
        break;
      case 'malformed':
        // fail-soft：记 ledger，流继续（分派 06 硬性要求 + 05 号故障剧本口径）
        this.#record({ seq: ++DRIVER_SEQ, kind: 'malformed', raw: event.raw, reason: event.reason });
        this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'malformed-command', reason: event.reason, raw: event.raw.slice(0, 200) });
        // v0.4.0（自 0.3.3 回流）：畸形/孤立闭合标签第一次出现时挂一条定向纠错注入
        // （malformedCloserNudge；本回合首个非 final-only 请求携带）。此前 fail-soft 只记
        // 台账、无纠错信号——真机 2026-11-20：`</tf-*>` 同一会话两度落进正文，模型全程
        // 不知道这是错形态（桌面端正文里出现裸的 `</tf-*>`，会话无产出收场）。
        if (event.reason.startsWith('stray-close-tag') && !this.#strayCloseGuided) {
          this.#strayCloseGuided = true;
          this.#strayCloseNudge = malformedCloserNudge(event.raw);
          this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'malformed-closer-guidance', detail: `第一次畸形闭合（${event.reason}）→ 挂定向纠错注入` });
          this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'malformed-closer-guidance', reason: event.reason });
        }
        break;
      case 'truncated':
        this.#record({ seq: ++DRIVER_SEQ, kind: 'truncated', raw: event.raw, reason: event.reason });
        this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'truncated-command', reason: event.reason });
        // v0.3.2：截断不再只是台账——本步结束前由 #turnLoop 强制一次续写注入。
        this.#truncation = { reason: event.reason, raw: event.raw };
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
    // 0.5.0（§5.2/§5.3 让位）：代码通道下本插件不执行 tf-* 命令——
    //  · preset 来源：完全不接管命令面（§5.3"输出解析 = 否"），任何 tf-* 标记记账丢弃；
    //  · bridge 来源：只放行 tf-code（受限窄桥，0.4.x 行为），其余 tf-* 记账丢弃。
    // 让位可验证：代码通道下本插件对命令的派发数为 0（preset）/ 仅 tf-code（bridge）。
    if (this.#cfg.channel === 'code') {
      const allowed = this.#codeSource === 'bridge' && cmd.name === 'tf-code';
      if (!allowed) {
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'rejected', detail: 'code-channel-yield: 代码通道下本插件不执行 tf-* 命令（让位 PTC，§5.3）' });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'code-channel-yield', source: this.#codeSource ?? 'preset' });
        return;
      }
    }
    // v0.3.1：回合级命令序（跨请求单调）。final 之后又发过非 final 命令 → 那条 final 过期
    //（模型写完 final 又继续干活；旧答案不能当成交付内容）。
    const order = ++this.#cmdOrder;
    // v0.4.3（P0-6⑤）：本回合命令集（兜底交付的"台账事实"清单来源；含失败命令，
    // "是否真有产出"另看 status——与 0.3.3 同语义）。
    this.#turnCommandIds.add(cmd.id);
    // v0.3.2：本步摘要（含重复 id 的命令——模型确实发过它们，历史要如实）
    this.#stepCommandIds.push(cmd.id);
    if (cmd.name !== 'tf-final') this.#lastNonFinalOrder = order;
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
        // v0.3.1：无论覆盖还是幂等，都算"本流末尾又声明了一次" → 刷新 final 序（不再判过期）。
        this.#lastFinalOrder = order;
        if (commandFingerprint(prev.cmd) === fp) {
          this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'ok', detail: 'duplicate-idempotent: 返回原回执' });
        } else {
          const summary = cmd.attrs['summary'] ?? '';
          const cand = this.#finalCandidates.find((c) => c.cmdId === cmd.id);
          if (cand !== undefined) {
            cand.summary = summary;
            cand.turn = turn;
            cand.step = step;
          }
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
          this.#queueReplay(cmd, prev);
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
      this.#lastFinalOrder = order;
      this.#finalCandidates.push({ cmdId: cmd.id, summary: record.detail, turn, step });
      this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'ok', detail: record.detail });
      this.#record({ seq: ++DRIVER_SEQ, kind: 'final', summary: record.detail });
      this.#ledgerWrite('plugin:tf-agent/final', { summary: record.detail, turn, step, cmdId: cmd.id });
    }
    this.#dispatchReady(turn, step);
  }

  /**
   * v0.3.1 截断修复：重复命令的原结果回灌（幂等语义不变，不重执行）。
   *
   * 为什么需要：观测内容只在"易变尾"注入一次，跨请求即消失（历史里只剩句柄目录行）。
   * 模型丢失上下文后最自然的动作就是把同一条 read/glob 再发一次——0.3.1 只回
   * "duplicate-idempotent（handle=…）"，模型仍然一无所获，于是原地打转（真机会话
   * `session-84274277` 第 3–7 步连续 glob 同一 pattern），最后用 `summary="placeholder"`
   * 收场。这里把原观测按既有上限回灌一次，给模型一条低成本的恢复路径。
   */
  #queueReplay(cmd           , prev               )       {
    if (prev.status !== 'ok') return;
    if (prev.handle === undefined || prev.handle === '') return;
    if (!REPLAYABLE_COMMANDS.has(cmd.name)) return;
    if (this.#pendingReplays.length >= MAX_REPLAY_INJECTIONS) {
      // 同一条重复命令反复重发：只记一次 fault，不重复刷台账
      if (!this.#replayCapped) {
        this.#replayCapped = true;
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'replay-capped', detail: `重复命令回灌已达上限 ${MAX_REPLAY_INJECTIONS}` });
        this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'replay-capped', cap: MAX_REPLAY_INJECTIONS });
      }
      return;
    }
    // 只登记意图：内容在真正装配进下一次请求时才 peek（收敛路径直接丢弃，
    // 不占 injected 计数——injected 口径是"确实进入模型上下文的观测负载"）。
    this.#pendingReplays.push({ cmdId: cmd.id, name: cmd.name, handle: prev.handle });
  }

  /** 把待回灌的重复命令物化成注入块（仅在轮到它们进入下一次请求时调用）。
   *  0.5.0：回灌侧上限 readFeedbackLimit 缺省 0 = 不截断（读取侧 maxReadChars 已控住，§7.5）；
   *  效果压缩（§5.6(1)）：被回灌命令的效果已落账、验证通过且不在最近 keepRecent 个效果内
   *  → 折叠为 [applied pN] 一行（丢弃原始输出正文，原文按句柄 tf-peek 可取回）。 */
  #materializeReplays()                  {
    if (this.#pendingReplays.length === 0) return [];
    const limit = this.#cfg.readFeedbackLimit;
    const out                  = [];
    for (const item of this.#pendingReplays) {
      // 效果折叠优先：旧效果不再重发原始输出（重复付费），一行效果 + 句柄取回路径
      const effectLine = this.#elidableEffectLineFor(item.cmdId);
      if (effectLine !== null) {
        const folded = `[tf-stream:replay id=${item.cmdId} name=${item.name} handle=${item.handle}]\n${effectLine}\n（原始输出已按效果压缩折叠；原文用 tf-peek handle="${item.handle}" from_line=.. to_line=.. 取回）`;
        this.#replays += 1;
        this.#noteFeedback('handle', folded);
        out.push({ role: 'user', content: folded });
        this.#record({
          seq: ++DRIVER_SEQ, kind: 'observation',
          handle: item.handle, key: `replay:${item.cmdId}`, infoGain: 'high', reason: 'duplicate-replay-folded',
        });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: item.cmdId, name: item.name, status: 'duplicate-replay-folded', handle: item.handle });
        continue;
      }
      const content = this.#obs.peek(item.handle, 1, Number.MAX_SAFE_INTEGER);
      if (content === null || content === '') continue;
      this.#replays += 1;
      const body = limit <= 0 || content.length <= limit
        ? content
        : `${content.slice(0, limit)}\n……（原结果超长，已截断 ${content.length - limit} 字符；用 tf-peek handle="${item.handle}" from_line=.. to_line=.. 精确取回）`;
      const replayContent = `[tf-stream:replay id=${item.cmdId} name=${item.name} handle=${item.handle}]\n`
        + '这条命令与之前完全相同（幂等）：没有重复执行，以下回灌它的原结果。\n'
        + `${body}\n（需要其它行段用 tf-peek handle="${item.handle}" from_line=.. to_line=..）`;
      // v0.4.3（P0-7①）：原结果完整回灌 = full；超限截断形态 = handle（头 + 句柄）。
      this.#noteFeedback(content.length <= limit ? 'full' : 'handle', replayContent);
      out.push({
        role: 'user',
        content: replayContent,
      });
      this.#record({
        seq: ++DRIVER_SEQ, kind: 'observation',
        handle: item.handle, key: `replay:${item.cmdId}`, infoGain: 'high', reason: 'duplicate-replay',
      });
      this.#ledgerWrite('plugin:tf-agent/command', { cmdId: item.cmdId, name: item.name, status: 'duplicate-replay', handle: item.handle, chars: content.length });
    }
    this.#pendingReplays = [];
    return out;
  }

  /**
   * v0.3.2：把上一步的正文 + 命令摘要落进追加区（assistant/message 语义）。
   *
   * 为什么必须有：渲染器只持有"稳定前缀 + 追加区 + 易变尾"。0.3.x 从不往追加区写
   * assistant/工具事实，易变尾又每请求重建——模型在第 2 个请求起就只看到 system + 任务 +
   * 句柄目录行。真机 session-e4b9a89c 里模型的原话是"The history is truncated. I don't see
   * the plan content"，随后反复重读、计划无法验收、9 步后 blocked。
   *
   * 对齐内建 dsh-agent-loop 的语义：`session.deriveMessages()` 每步都把完整的
   * assistant/message（含 tool-call 块）与 tool/result 回放给模型；这里用压缩摘要
   *（id/命令/目标/状态/句柄/字符数）落追加区，原结果由随后的易变尾转正承载。
   */
  #commitStepDigest()       {
    const digest = this.#lastStepDigest;
    this.#lastStepDigest = null;
    if (digest === null) return;
    const prose = normalizeProse(digest.prose);
    if (prose !== '') {
      // v0.4.2：assistant 历史块必须带 source（宿主 forAdapter 无防护读
      // source.replayState；缺失 = 请求崩溃。provider/model 取驱动器实时路由）。
      this.#renderer.appendHistory({ role: 'assistant', content: capText(prose, STEP_PROSE_COMMIT_LIMIT), source: this.modelSource() });
    }
    const lines           = [];
    for (const id of digest.cmdIds) {
      const rec = this.#commands.get(id);
      if (rec === undefined) continue;
      // 0.5.0（§5.6(1)）：效果落账后，digest 行携带 effect id（效果压缩的折叠发生在两个
      // 合法改写点：回灌（#materializeReplays）与压缩（#maybeCompactForInputBudget）——
      // 追加区本身只增不改，行内只标注效果地址）。
      const effect = this.#effects.find((e) => e.cmdId === id);
      const target = rec.cmd.attrs['path'] ?? rec.cmd.attrs['cmd'] ?? rec.cmd.attrs['pattern']
        ?? rec.cmd.attrs['handle'] ?? rec.cmd.attrs['summary'] ?? '';
      const detail = rec.detail !== undefined && rec.detail !== '' ? ` · ${capText(rec.detail, 120)}` : '';
      lines.push(
        `- ${id} ${rec.cmd.name}${target !== '' ? ` ${capText(target, 120)}` : ''} → ${rec.status}`
        + `${rec.handle !== undefined ? ` handle=${rec.handle}` : ''}${detail}`
        + `${effect !== undefined ? ` · effect=${effect.effectId}` : ''}`,
      );
    }
    for (const native of digest.natives) {
      lines.push(`- native ${native.name} (callId=${native.id}) → 已执行，结果见随后注入块`);
    }
    if (lines.length === 0) return;
    this.#renderer.appendHistory({
      role: 'user',
      content: `[tf-stream:step step=${digest.step} 上一步动作与结果]\n${lines.join('\n')}`,
    });
  }

  /** v0.3.2：把已随请求发出的易变尾转正为追加区历史（下一请求仍可见，不再一次性蒸发）。
   *  只转正"事实类"块（观测/peek/原生结果/回灌）；nudge / degraded / error 这类
   *  瞬态指令不回灌历史——否则下一回合模型会把过期的"预算告急""final 被拒"当现状。
   *  v0.4.3：返回转正块数（诊断用）；承诺前缀基线（#lastRequest.promised）在调用方于本方法
   *  之后取 stableMessages()——v0.4.3.1 起与块序解耦（核查 §2.5）。 */
  #commitDeliveredTail()         {
    const delivered = this.#deliveredTail;
    this.#deliveredTail = null;
    if (delivered === null) return 0;
    let promoted = 0;
    for (const block of delivered.blocks) {
      if (!isDurableBlock(block)) continue;
      this.#renderer.appendHistory({ role: block.role, content: block.content });
      promoted += 1;
    }
    return promoted;
  }

  /** F5 计划快照（final 被计划门槛拒绝时随注入一起给出，模型不必凭记忆猜验收项）。 */
  #planSnapshot()         {
    if (this.#plan === null) return '';
    return [...this.#plan.items.entries()]
      .map(([id, item]) => `- [${id}] ${item.text}（${item.status}）`)
      .join('\n');
  }

  // ------------------------------------------------------- v0.4.3 P0-6 wire 断言

  /**
   * 0.5.0（§8.3 判定表 + §8.5 配置）：前缀非单调按三类分别处置——不采用"报错/重发"二分。
   * 返回 'ok'（放行——含预算内的受限换基）或 'fail'（fail-closed 收场，detail 供 blocked
   * 文案与兜底交付）。比较与分类在内核 assertRequestPrefix：
   *   - stable-drift：**始终 fail**（不受 prefixPolicy 影响，§8.5）——稳定段被改写意味着
   *     装配被破坏，重发只会烧缓存不修根因；
   *   - shrink（越界）：fail——承诺前缀收缩 = 历史被销毁；段边界必须走 dropAppendHead
   *     / rebase 计划性通道；
   *   - append-drift（可归因）：受限换基——prefixPolicy='fail' 时绝不换基（§12.4 回退）；
     'auto'（默认）每回合 1 次/每会话 3 次内放行同一份 next（0 额外请求）；'rebase' 走
     换基成本判据（§8.4：剩余预算 > rebase_cost × rebaseBudgetRatio）。
   *   - planned-rebase 永不进入本断言——压缩/通道切换在发送前已重置基线（#lastRequest=null）。
   */
  #assertWirePrefix(next                          , turn        , step        )                                                          {
    const baseline = this.#lastRequest;
    if (baseline === null) return { verdict: 'ok' };
    try {
      assertRequestPrefix(baseline, next);
      return { verdict: 'ok' };
    } catch (error) {
      if (!(error instanceof PrefixBrokenError)) throw error;
      const cause = error.prefixCause;
      const diag = `index=${error.index} stablePrefixLen=${error.stablePrefixLen} cause=${cause} 期望="${capText(error.expected, 80)}" 实际="${capText(error.actual, 80)}"`;
      if (cause === 'append-drift' && this.#cfg.prefixPolicy !== 'fail') {
        const contextTokens = estimatePromptTokens(next);
        const budgetOk = this.#rebaseAffordable(contextTokens);
        const limitsOk = this.#prefixResendsTurn < 1 && this.#prefixResendsSession < 3;
        if (limitsOk && (this.#cfg.prefixPolicy === 'auto' || budgetOk)) {
          // P0-6④（v0.4.3.1 用词，核查 §4.2）：断言在发送前——"放行"= 记账后照常发送同一份
          // next，0 额外请求；显式缓存重置点（下一请求基线 = 本次发送内容）。
          this.#prefixResendsTurn += 1;
          this.#prefixResendsSession += 1;
          this.#resetSeq += 1;
          this.#resetCause = 'prefix-reset';
          const detail = `append-drift 受限换基（${this.#cfg.prefixPolicy}；会话第 ${this.#prefixResendsSession} 次/上限 3，回合第 ${this.#prefixResendsTurn} 次/上限 1${this.#cfg.prefixPolicy === 'rebase' ? (budgetOk ? '' : '；预算判据不满足被拒') : ''}）：${diag}`;
          this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'prefix-reset', detail });
          this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'prefix-reset', cause, index: error.index, stablePrefixLen: error.stablePrefixLen, turn });
          this.#warn(`P0-6 append-drift：承诺前缀与下一请求头部不一致——放行一次同一份 next，基线随本请求推进（${diag}）`, error);
          return { verdict: 'ok' };
        }
      }
      const verdict = cause === 'append-drift'
        ? (this.#cfg.prefixPolicy === 'fail'
          ? 'append-drift：prefixPolicy=fail 绝不换基（§12.4 回退面）'
          : `append-drift 超出放行预算（每回合 1 次/每会话 3 次，已用 ${this.#prefixResendsSession} 次）——降级 fail-closed`)
        : cause === 'shrink'
          ? '承诺前缀收缩（历史被销毁；段边界必须走 dropAppendHead / rebase 计划性通道）'
          : 'stable-drift（稳定段被改写，0 放行；stable-drift 始终 fail，不受 prefixPolicy 影响）';
      const full = this.#prefixFailClosed(error, turn, step, verdict);
      return { verdict: 'fail', detail: full };
    }
  }

  /**
   * 0.5.0（§8.4 换基成本判据）：rebase_cost ≈ C（当前上下文 token）；
   * 规则：剩余预算 > rebase_cost × rebaseBudgetRatio → 允许自动换基，否则 fail 保留现场。
   * 剩余预算（token 口径）= maxInputTokens − 当前估算（maxInputTokens=0 无上限 → 恒允许）。
   */
  #rebaseAffordable(contextTokens        )          {
    const maxInput = this.effectiveLimits().maxInputTokens;
    if (maxInput <= 0) return true;
    const remaining = maxInput - contextTokens;
    return remaining > contextTokens * this.#cfg.rebaseBudgetRatio;
  }

  /**
   * v0.4.3（P0-6⑤）：前缀破坏的 fail-closed 收场事实链——prefix-broken 台账 + 账本 +
   * 开发者日志 + receipt 最小对账。返回 detail 供 blocked 文案与兜底交付复用。
   * 异常上抛开发者日志（#warn），但不作为用户可见终态（runTurn 不再把它炸出去）。
   */
  #prefixFailClosed(error                   , turn        , step        , origin        )         {
    const cause = error.prefixCause;
    const diag = `index=${error.index} stablePrefixLen=${error.stablePrefixLen} cause=${cause} 期望="${capText(error.expected, 80)}" 实际="${capText(error.actual, 80)}"`;
    const detail = `${origin}：${diag}`;
    this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'prefix-broken', detail });
    this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'prefix-broken', cause, index: error.index, stablePrefixLen: error.stablePrefixLen, expected: capText(error.expected, 80), actual: capText(error.actual, 80), turn, step });
    this.#warn(`P0-6 前缀破坏（fail-closed，拒绝发送不做静默修复）：${detail}`, error);
    // receipt 最小对账——pending 意图一律标 unknown（不重放、不声称回滚）。
    this.#reconcilePendingIntents('prefix-broken');
    return detail;
  }

  /** v0.4.3（P0-6⑤）：最小对账——把 pending 意图整批标 unknown（ack 语义写死：
   *  只解除恢复锁，不重放工具、不声称回滚）。IO 失败 fail-open + 告警（意图保持 pending，
   *  恢复锁不解除——宁可多一次人工核对，不可虚报已对账）。 */
  #reconcilePendingIntents(cause        )       {
    try {
      const result = this.#ports.reconcilePendingIntents?.(cause);
      this.#record({
        seq: ++DRIVER_SEQ, kind: 'fault', fault: 'intent-reconciled',
        detail: `${cause}：pending 意图整批标记 unknown（acked=${result?.acked ?? 0}；只解除恢复锁，不重放工具，不声称回滚）`,
      });
    } catch (error) {
      this.#warn('P0-6⑤ 最小对账失败（fail-open：意图保持 pending，恢复锁不解除）', error);
    }
  }

  /** v0.4.3（离线探针，faultPrefixDrift 专用）：篡改上一请求承诺前缀基线的一个字节，模拟
   *  "历史被改写"——真实世界只因未来装配回归而发生；探针让 P0-6 三类处置可离线复演。
   *  kind='stable' 篡改稳定段（index 1，task 块）；kind='append' 篡改承诺前缀内的第一个
   *  转正块（index = stableLen；承诺前缀无转正块时该请求跳过）。oncePerTurn=true
   *  时每回合只注入一次。只改基线快照（发送原文与 renderHash 不受影响）。
   *  v0.4.3.1：基线 = promised（转正后 stable），篡改点语义不变。 */
  #faultDriftBaseline(turn        )       {
    const baseline = this.#lastRequest;
    if (baseline === null) return;
    const cfg = this.#cfg.faultPrefixDrift;
    if (cfg === undefined) return;
    const promised = [...baseline.promised];
    let index        ;
    if (cfg.kind === 'stable') {
      if (baseline.stableLen < 2) return; // 没有可篡改的稳定段（system 之下）
      index = 1;
    } else {
      if (promised.length <= baseline.stableLen) return; // 无转正块可篡改
      index = baseline.stableLen;
    }
    // oncePerTurn 标记放在"确认可篡改"之后——否则首个无法篡改的请求会把整个回合
    // 的探针名额消耗掉（0.5.0 修正：探针在多请求剧本里第一次到位时才生效）。
    if (cfg.oncePerTurn === true) {
      if (this.#faultDriftTurns.has(turn)) return;
      this.#faultDriftTurns.add(turn);
    }
    if (cfg.kind === 'stable') {
      if (baseline.stableLen < 2) return; // 没有可篡改的稳定段（system 之下）
      index = 1;
    } else {
      if (promised.length <= baseline.stableLen) return; // 无转正块可篡改
      index = baseline.stableLen;
    }
    promised[index] = { ...promised[index] , content: `${promised[index] .content}（探针篡改）` };
    this.#lastRequest = { promised, stableLen: baseline.stableLen };
  }

  /** v0.4.3（P0-7①）：反馈字节分类累计（注入位点调用；request 记录写入时快照清零）。
   *  'full' = 全量回灌；'handle' = 句柄/骨架/回执（超限或自写回验形态）。dedup 由 P0-4
   *  （0.5.0）引入，0.4.3 恒 0——字段先占位，口径不漂移。 */
  #noteFeedback(kind                   , content        )       {
    this.#feedbackBytes[kind] += content.length;
  }

  // ------------------------------------------ v0.4.3 P0-6⑤ 兜底交付（回植 0.3.3；有产出时才有交付——核查 §4.3）

  /**
   * v0.4.3（P0-6⑤，自 0.3.3 回植）：本回合的"生产性 ok 命令"数（兜底交付的产出基准）。
   * 排除 tf-final（声明不是工作）与 tf-plan（计划不是交付）。
   */
  #productiveOkCount()         {
    let n = 0;
    for (const id of this.#turnCommandIds) {
      const rec = this.#commands.get(id);
      if (rec === undefined || rec.status !== 'ok') continue;
      if (rec.cmd.name === 'tf-final' || rec.cmd.name === 'tf-plan') continue;
      n += 1;
    }
    return n;
  }

  /** v0.4.3（P0-6⑤，自 0.3.3 回植）：本回合 ok 的命令记录（兜底交付取证用；按解析序）。 */
  #turnOkRecords()                  {
    const out                  = [];
    for (const id of this.#turnCommandIds) {
      const rec = this.#commands.get(id);
      if (rec !== undefined && rec.status === 'ok') out.push(rec);
    }
    return out.sort((a, b) => a.cmd.seq - b.cmd.seq);
  }

  /**
   * v0.4.0（自 0.3.3 回流）：收束期指令（只在到达停滞/硬上限后注入；排在所有事实块之后，
   * 模型最后读到它）。它不是"再试一次"的许可，而是"停止探索、立即交付"的最后通牒。
   */
  #closeOutNudge(attempt        , detail        )         {
    const ok = this.#productiveOkCount();
    const last = attempt >= 2;
    return [
      `[tf-stream:closeout attempt=${attempt}] ${last ? '这是最后一次收束机会。' : '进入收束阶段。'}`,
      `本回合已成功执行 ${ok} 条命令；${detail}`,
      '停止继续探索/验证：不要再读文件、跑检查或补新功能，除非缺少的结果会改变最终结论。',
      '立即用 tf-final 交付：summary 写最终答案原文（数字/行内容/路径/结论）+ 未验证项清单；',
      '任务确实没做完就如实写“未完成：…”，不要用 placeholder/占位/TODO。',
    ].join('\n');
  }

  /**
   * v0.4.3（P0-6⑤，自 0.3.3 回植）：兜底交付的交付说明。用户侧的"失败即空转"本质是
   * 回合结束时没有 assistant 最终消息。这里把台账事实写成一条**明确标注未完成**的
   * 交付说明（不是伪造模型答案）：已完成什么、最近一次命令输出、哪些没验证。
   * 零产出回合返回 null（不伪造"已完成"）。
   */
  #buildFallbackFinal(detail        )                {
    const ok = this.#turnOkRecords();
    if (ok.length === 0) return null;
    const writes = ok.filter((r) => r.cmd.name === 'tf-write' || r.cmd.name === 'tf-edit' || r.cmd.name === 'tf-append');
    const bashes = ok.filter((r) => r.cmd.name === 'tf-bash' || r.cmd.name === 'tf-code');
    const reads = ok.filter((r) => r.cmd.name === 'tf-read' || r.cmd.name === 'tf-grep' || r.cmd.name === 'tf-glob'
      || r.cmd.name === 'tf-peek' || r.cmd.name === 'tf-call');
    const lines           = [`[未完成交付] 回合在收束预算内停止（${capText(detail, 160)}），没有收到有效的 tf-final。以下为台账事实，不是模型结论：`];
    let listed = 0;
    for (const rec of [...writes, ...bashes, ...reads]) {
      if (listed >= 8) break;
      const target = rec.cmd.attrs['path'] ?? rec.cmd.attrs['cmd'] ?? rec.cmd.attrs['pattern'] ?? rec.cmd.attrs['handle'] ?? '';
      const label = rec.cmd.name;
      const size = rec.observation?.payload.kind === 'skeleton'
        ? (rec.observation.payload                         ).rendered?.length
        : undefined;
      lines.push(`- ${label}${target === '' ? '' : ` ${capText(target, 120)}`} → ok${rec.handle === undefined ? '' : `（${rec.handle}）`}${size === undefined ? '' : `，${size} 字符`}`);
      listed += 1;
    }
    const lastBash = bashes[bashes.length - 1];
    if (lastBash !== undefined) {
      const output = this.#obs.peek(lastBash.handle ?? '', 1, Number.MAX_SAFE_INTEGER);
      if (output !== null && output.trim() !== '') {
        const tail = output.length <= 700 ? output : `…${output.slice(output.length - 700)}`;
        lines.push(`最近一次命令输出（尾部 ≤700 字符）：\n${tail}`);
      }
    }
    const unfinished = [...this.#turnCommandIds]
      .map((id) => this.#commands.get(id))
      .filter((r)                     => r !== undefined && (r.status === 'failed' || r.status === 'pending' || r.status === 'dispatched'));
    if (unfinished.length > 0) {
      lines.push('未完成/未验证：');
      for (const rec of unfinished.slice(0, 5)) {
        lines.push(`- ${rec.cmd.id} ${rec.cmd.name} → ${rec.status}${rec.detail === undefined ? '' : `（${capText(rec.detail, 120)}）`}`);
      }
    }
    lines.push('如需继续，请直接说明下一步（例如“继续修 X”）；本回合没有把未验证的工作标成完成。');
    return capText(lines.join('\n'), 4000);
  }

  /**
   * v0.4.3（P0-6⑤，自 0.3.3 回植）：兜底交付——前缀破坏收场的最后一道闸。
   * fail-closed 拒绝发送后，把**台账事实**写成一条明确标注未完成的 assistant 消息落进
   * 会话，而不是让界面停在最后一句 prose 上。零产出（无 ok 命令）→ 不写（不伪造"已完成"）；
   * 同一回合只写一次。异常上抛开发者日志，不作为用户可见终态。
   */
  #deliverFallbackFinal(turn        , step        , detail        )       {
    if (this.#fallbackFinalDelivered) return;
    const text = this.#buildFallbackFinal(detail);
    if (text === null) {
      this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'fallback-final-skipped', detail: '零产出回合（无 ok 命令）→ 不写兜底交付（不伪造"已完成"）' });
      return;
    }
    this.#fallbackFinalDelivered = true;
    try {
      this.#ports.events?.finalAnswer?.(turn, step, text);
    } catch (error) {
      this.#warn('兜底交付写入失败', error);
    }
    this.#record({
      seq: ++DRIVER_SEQ, kind: 'fault', fault: 'fallback-final',
      detail: `回合收束但无 tf-final → 已写未完成交付说明（${capText(detail, 120)}）`,
    });
    this.#ledgerWrite('plugin:tf-agent/fault', {
      fault: 'fallback-final', detail, turn, step, commands: this.#productiveOkCount(),
    });
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
        detail: cmd.name === 'tf-write' ? `path=${cmd.attrs['path'] ?? ''}` : cmd.attrs['cmd'] ?? cmd.attrs['description'] ?? cmd.attrs['path'] ?? '',
      });
      if (verdict.verdict === 'deny') {
        rec.status = 'rejected';
        rec.detail = `${verdict.reason}: ${verdict.detail}`;
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'rejected', detail: rec.detail });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'rejected', detail: rec.detail });
        return;
      }
    }

    // ---- tf-peek：内核 obs 直接取回（need_result 通道；0.5.0 走 span 账本 + 回合预算）----
    if (cmd.name === 'tf-peek') {
      const handle = cmd.attrs['handle'] ?? '';
      const symbol = cmd.attrs['symbol'];
      const from = Number(cmd.attrs['from_line'] ?? '1');
      const to = cmd.attrs['to_line'] === undefined ? Number.MAX_SAFE_INTEGER : Number(cmd.attrs['to_line']);
      // 0.5.0（§5.2）：handle 支持 request:N 别名（长上下文压缩段的取回地址）
      const handleCandidates = this.#obs.resolveHandleRef(handle);
      // 0.5.0（Appendix B）：symbol 属性 → 符号定位取回（±40 行窗口；§7.2 问题 1 修复）。
      // 符号命中按窗口区间走 span 账本（recordDelivered 由 peek 结果注入时统一登记）。
      if (symbol !== undefined && symbol !== '') {
        const symbolHit = handleCandidates
          .map((h) => this.#obs.peekBySymbol(h, symbol, this.#requestCount))
          .find((r) => r !== null) ?? null;
        if (symbolHit === null) {
          const workInFlight = [...this.#commands.values()].some(
            (r) => r.cmd.name !== 'tf-peek' && (r.status === 'pending' || r.status === 'dispatched'),
          );
          if (workInFlight) {
            rec.status = 'dispatched';
            rec.detail = 'deferred: handle/symbol 未就绪，流末重试';
            this.#deferredPeeks.push({ rec, turn, step });
            this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'dispatched', detail: rec.detail });
            return;
          }
          rec.status = 'failed';
          rec.detail = `unknown-symbol:${symbol}（handle=${handle}）——用 tf-grep 先定位符号所在文件，或核对 handle`;
          this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
          this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
          return;
        }
        if (this.#cfg.peekBudgetChars > 0 && symbolHit.text.length > this.#cfg.peekBudgetChars - this.#peekBudgetUsed) {
          const budgetLine = `[budget] 本回合取回已达上限（${this.#cfg.peekBudgetChars} 字符，已用 ${this.#peekBudgetUsed}）。请先用 tf-grep 缩小范围，或在下回合继续。`;
          rec.status = 'ok';
          rec.output = budgetLine;
          rec.detail = 'peek-budget-exhausted';
          this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'ok', detail: rec.detail });
          return;
        }
        rec.status = 'ok';
        rec.output = `L${symbolHit.from}-${symbolHit.to}（符号 ${symbol} 定义于 L${symbolHit.line}，±40 行窗口）\n${symbolHit.text}`;
        rec.detail = `${symbolHit.text.length} chars（symbol=${symbol} → L${symbolHit.line}）`;
        this.#peekBudgetUsed += symbolHit.text.length;
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'ok', handle: handleCandidates[0] ?? handle, detail: rec.detail });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'ok', handle, symbol: symbol, line: symbolHit.line, chars: symbolHit.text.length });
        return;
      }
      const spanResult = handleCandidates.length > 0 ? this.#obs.peekWithLedger(handleCandidates[0] , from, to, this.#requestCount) : null;
      const content = spanResult === null
        ? (handleCandidates.length > 1 ? handleCandidates.map((h) => this.#obs.peek(h, from, to)).find((c) => c !== null) ?? null : null)
        : (spanResult.kind === 'unchanged' ? spanResult.line : spanResult.text);
      if (spanResult === null && content === null) {
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
      // 0.5.0（§7.3(3)）：回合取回预算——超预算返回 [budget] 一行（不允许静默继续）。
      if (this.#cfg.peekBudgetChars > 0 && content !== null && content.length > 0) {
        const remaining = this.#cfg.peekBudgetChars - this.#peekBudgetUsed;
        if (content.length > remaining) {
          const budgetLine = `[budget] 本回合取回已达上限（${this.#cfg.peekBudgetChars} 字符，已用 ${this.#peekBudgetUsed}）。请先用 tf-grep 缩小范围，或在下回合继续。`;
          rec.status = 'ok';
          rec.output = budgetLine;
          rec.detail = `peek-budget-exhausted: ${budgetLine}`;
          this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'ok', detail: rec.detail });
          this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'peek-budget', handle, used: this.#peekBudgetUsed, cap: this.#cfg.peekBudgetChars });
          return;
        }
      }
      rec.status = 'ok';
      rec.output = content ?? '';
      rec.detail = `${(content ?? '').length} chars${spanResult?.kind === 'unchanged' ? '（span 命中：不重发正文）' : spanResult?.kind === 'partial' ? `（${spanResult.note}）` : ''}`;
      if (content !== null && spanResult !== undefined && spanResult !== null && spanResult.kind !== 'unchanged') {
        // 投递记账（span 账本）：本次正文进入上下文，登记已投递区间
        this.#obs.recordDelivered(spanResult.handle, spanResult.from, spanResult.to, this.#requestCount);
      }
      if (content !== null) this.#peekBudgetUsed += content.length;
      this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'ok', handle, detail: rec.detail });
      this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'ok', handle, chars: (content ?? '').length, spanKind: spanResult?.kind ?? 'content' });
      return;
    }

    // ---- tf-plan：计划与验收（F5；驱动器内部处理，不映射工具）----
    if (cmd.name === 'tf-plan') {
      if (!this.#cfg.enablePlan) {
        rec.status = 'failed';
        rec.detail = 'plan-disabled: 计划与验收未启用（enablePlan: false）';
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
        return;
      }
      const items = parsePlanItems(cmd.body ?? '');
      if (items.length === 0) {
        rec.status = 'failed';
        rec.detail = 'bad-plan: tf-plan body 需要至少一行验收项（格式：- [id] 描述）';
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
        return;
      }
      // 计划修订 = 整体替换（修订必须在显式 tf-plan 里声明，不接受隐式改计划）；
      // 已验证项在新计划中同名重声明时保留证据（显式重声明显式保留），缺席项 = 显式移除。
      const next = new Map                        ();
      for (const item of items) {
        const prev = this.#plan?.items.get(item.id);
        next.set(item.id, prev !== undefined && prev.status === 'verified'
          ? { text: item.text, status: 'verified', evidence: prev.evidence }
          : { text: item.text, status: 'open' });
      }
      const revision = (this.#plan?.revision ?? 0) + 1;
      this.#plan = { revision, items: next };
      rec.status = 'ok';
      rec.detail = `plan v${revision}: ${items.length} 验收项`;
      this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'ok', detail: rec.detail });
      this.#record({ seq: ++DRIVER_SEQ, kind: 'plan', revision, open: [...next.values()].filter((i) => i.status === 'open').length, total: next.size });
      this.#ledgerWrite('plugin:tf-agent/plan', { revision, cmdId: cmd.id, items: items.map((i) => ({ id: i.id, text: i.text, status: next.get(i.id) .status })) });
      return;
    }

    // ---- tf-code：程序化工具调用（PTC 桥接；缺端口或未显式开启 → 命令级失败并引导改道）----
    if (cmd.name === 'tf-code') {
      const executor = this.#ports.executeCode;
      if (executor === undefined || !this.#cfg.codeEnabled) {
        rec.status = 'failed';
        rec.detail = 'no-code-channel: tf-code 未开启（K1 默认关闭；需显式 enableCode: true 且宿主提供 ctx.ptcRuntime 服务缝（@deepseek-ai/dsh-ptc-runtime）后才可用），改道 tf-bash/tf-write';
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
        return;
      }
      const timeoutAttr = cmd.attrs['timeout'];
      const timeoutMs = timeoutAttr !== undefined && /^\d+$/.test(timeoutAttr) ? Number(timeoutAttr) : this.#cfg.codeTimeoutMs;
      let outcome;
      try {
        outcome = await executor({
          callId: cmd.id,
          code: cmd.body ?? '',
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          // K4：回合 signal 直通（cancel 传导到 runtime；不再用独立且永不触发的 controller）
          signal: this.#commandSignal(),
          // K2：会话工作区（与 tf-write/tf-read 同一解析语义；未解析到则由宿主取默认目录）
          ...(this.#sessionCwd === undefined ? {} : { cwd: this.#sessionCwd }),
          ...(this.#agentRef === undefined ? {} : { agent: this.#agentRef }),
        });
      } catch (error) {
        // 执行器自身异常（fail-open）：结构化失败 + 告警，不静默吞
        rec.status = 'failed';
        rec.detail = `code-executor-error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail.slice(0, 200) });
        this.#warn(`tf-code ${cmd.id} 执行异常`, error);
        return;
      }
      // 观测登记（code 族：成功 high 首次/变化注骨架；失败一律 high）
      const observation = this.#obs.observe({
        tool: 'tf-code',
        ok: outcome.ok,
        key: observationKey(cmd),
        content: outcome.ok ? (outcome.valueJson ?? '') : (outcome.error ?? 'unknown'),
        callId: cmd.id,
      });
      rec.observation = observation;
      rec.handle = observation.handle ?? undefined;
      this.#record({
        seq: ++DRIVER_SEQ, kind: 'observation',
        handle: observation.handle, key: observationKey(cmd),
        infoGain: observation.info_gain, reason: observation.reason,
      });
      // K2 沙箱事实记账（成功与失败都记；enforcement=partial 必须显式可见）
      const sandbox = outcome.sandbox;
      if (sandbox !== undefined) {
        this.#record({
          seq: ++DRIVER_SEQ, kind: 'sandbox',
          cmdId: cmd.id, mode: sandbox.mode, enforcement: sandbox.enforcement,
          deniedCount: sandbox.denied?.length ?? 0,
        });
        this.#ledgerWrite('plugin:tf-agent/command', {
          cmdId: cmd.id, name: cmd.name, sandbox: true,
          mode: sandbox.mode, enforcement: sandbox.enforcement, denied: sandbox.denied,
          cwd: outcome.cwd ?? this.#sessionCwd ?? null,
        });
      }
      if (!outcome.ok) {
        rec.status = 'failed';
        // K3 结构化失败注入：kind + 可重试结论 + 建议 + 日志尾（200 字符）。
        const kind = outcome.kind ?? 'exception';
        const retryable = outcome.retryable === true;
        const logsTail = outcome.logs === undefined ? '' : `\nlogs tail: ${outcome.logs.slice(-200)}`;
        rec.detail = `[kind=${kind} retry=${retryable ? 'yes' : 'no'}] ${outcome.error ?? 'unknown'}${logsTail}`.slice(0, 800);
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'failed', kind, retryable, detail: (outcome.error ?? '').slice(0, 200) });
        return;
      }
      rec.status = 'ok';
      rec.detail = `${(outcome.valueJson ?? '').length} chars${outcome.logs === undefined ? '' : ` + logs ${outcome.logs.length} chars`}`;
      // F3：首成功/变化结果完整注入——值在上限内时挂到 rec.output（need_result 通道），
      // 超限保持骨架 + 句柄形态（中间结果不回灌的红线不破）。
      const valueJson = outcome.valueJson ?? '';
      if (observation.payload.kind === 'skeleton' && valueJson.length <= this.#cfg.codeValueInjectLimit) {
        rec.output = valueJson;
      }
      // F5：tf-code 成功（有回执）→ 声明的验收项记为已验证（证据 = 命令 id + 值指纹）
      this.#markAccepts(cmd, rec.handle, contentFingerprint(valueJson));
      // 0.5.0（§5.6(1)）：效果落账（标准通道折叠单元 = 单次工具调用）
      this.#recordEffect(cmd, rec, valueJson);
      this.#record({
        seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'ok',
        handle: rec.handle, infoGain: observation.info_gain, detail: rec.detail,
      });
      this.#ledgerWrite('plugin:tf-agent/command', {
        cmdId: cmd.id, name: cmd.name, status: 'ok',
        handle: rec.handle, infoGain: observation.info_gain, chars: valueJson.length,
        valueInjected: rec.output !== undefined,
        enforcement: sandbox?.enforcement,
      });
      return;
    }

    // ---- tf-write / tf-read / tf-edit / tf-append / tf-grep / tf-glob / tf-bash / tf-call：映射原生工具，单命令批执行 ----
    let mapped                                                              = null;
    let result                     ;
    // v0.4.0（P2/G2）：tf-call 通用调用通道——name 在冻结工具面内校验（unknown-tool 结构化
    // 失败 + 前缀建议），body 必须是 JSON 对象（bad-json-arguments 结构化失败）。校验不占
    // 请求 token（错误只进下一请求注入）；工具面缺席（L2）时引导回 tf-* 命令。
    if (cmd.name === 'tf-call') {
      const toolName = cmd.attrs['name'] ?? '';
      const nameError = this.#surface.validateCallName(toolName);
      let args         ;
      let argsError                    ;
      if (nameError === null) {
        try {
          args = JSON.parse((cmd.body ?? '').trim());
          if (args === null || typeof args !== 'object' || Array.isArray(args)) {
            argsError = 'tf-call body 必须是 JSON 对象（键值参数表），不是数组或标量';
          }
        } catch {
          argsError = 'tf-call body 不是合法 JSON：核对引号转义（属性值内的 " 要写成 \\"）后重发';
        }
      }
      if (nameError !== null || argsError !== undefined) {
        rec.status = 'failed';
        rec.detail = (nameError ?? argsError) .slice(0, 500);
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'failed', kind: nameError !== undefined ? 'unknown-tool' : 'bad-json-arguments', detail: rec.detail.slice(0, 200) });
        return;
      }
      mapped = { name: toolName, arguments: args                            };
    } else {
      mapped = this.#cfg.toolMapping.toToolCall(cmd);
    }
    // F6 写前意图：变更类命令（tf-write/tf-edit/tf-append）在派发到宿主工具**之前**落盘（fsync）。
    // 崩溃后"有意图无回执"即可判定写入可能已发生 → resume 停机核对。零注入：只进账本。
    const intentOp                                     = cmd.name === 'tf-write'
      ? 'write'
      : cmd.name === 'tf-edit'
        ? 'edit'
        : cmd.name === 'tf-append'
          ? 'append'
          : null;
    if (intentOp !== null) {
      try {
        this.#ports.onIntent?.({
          cmdId: cmd.id,
          op: intentOp,
          path: cmd.attrs['path'] ?? '',
          fingerprint: contentFingerprint(cmd.body ?? ''),
        });
      } catch (intentError) {
        // fail-open（红线 6：可选功能 fail-open 且必须告警）——不因意图落盘失败阻断写入
        this.#warn('F6 写前意图落盘失败（fail-open，继续派发；崩溃窗口内该写入不可判定）', intentError);
      }
    }
    try {
      if (mapped === null) {
        // tf-edit body 标记解析失败等：映射层无法产出参数——结构化失败，不静默改全文。
        rec.status = 'failed';
        rec.detail = cmd.name === 'tf-edit'
          ? 'tf-edit body 解析失败：需要 "<<<<<<< OLD" / "=======" / ">>>>>>> NEW" 三行标记各出现一次且顺序正确（结构化失败，不做模糊匹配、不改全文）'
          : `no-tool-mapping:${cmd.name}`;
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail.slice(0, 200) });
        return;
      }
      // v0.3.0（会话格式修复）：先广告 tool-call 生命周期，再让宿主工具管线落 tool/call。
      // 宿主的 v4 校验要求 assistant/message(tool-call) → tool/call → tool/result 三段齐全；
      // 只写 tool/call 会让整条会话日志被判 corrupt（桌面端历史对话加载失败）。
      // v0.3.1：广告是流中落盘的 assistant/message——若实时 attempt 还开着，客户端 fold 会把它
      // 暂存进 pending 且 end 帧只消费一条结算 → 滞留到下一步触发 events.restart()。
      // 先收束（abandoned）再广告：广告与后续 tool/call、落盘消息全部直接 publish。
      this.#frameEndAbandonedIfOpen();
      const advertised                        = { id: cmd.id, name: mapped.name, arguments: JSON.stringify(mapped.arguments) };
      try {
        this.#ports.events?.advertiseToolCalls?.(turn, step, [advertised]);
      } catch (adError) {
        this.#warn('tool-call 广告写入失败（fail-open：工具照常派发，但该条会话日志可能不可读）', adError);
      }
      result = await this.#ports.executeTools({
        calls: [{ type: 'tool-call', id: cmd.id, name: advertised.name, arguments: advertised.arguments }],
        // K4：回合 signal（cancel 时传导；不再用独立且永不触发的 AbortController）
        signal: this.#commandSignal(),
        maxParallelToolCalls: 1,
        ...(this.#agentRef === undefined ? {} : { agent: this.#agentRef }),
        // v0.4.0（R5）：beta 缺省不透传 toolSet（when 门控不收紧）；strictAdmission 开启才带
        ...(this.#cfg.strictAdmission && this.#currentSurface?.toolSet !== undefined
          ? { toolSet: this.#currentSurface.toolSet }
          : {}),
        log: safeToolLog(this.#ports, turn, step),
      });
    } catch (error) {
      rec.status = 'failed';
      rec.detail = isAbortError(error) ? `aborted: 回合取消（K4），未产生后置结果` : describeToolError(error);
      // v0.3.0：广告已落但派发失败 → 闭合工具生命周期（否则 step/end 留下未解调用）
      try {
        this.#ports.events?.repairToolCall?.(turn, step, cmd.id);
      } catch (repairError) {
        this.#warn('tool-call 生命周期闭合事件写入失败（fail-open）', repairError);
      }
      // F6 写后回执（失败路径）：意图闭合为"已发生但失败"，不算"无回执"
      if (intentOp !== null) {
        try {
          this.#ports.onIntentReceipt?.({ cmdId: cmd.id, ok: false, detail: rec.detail.slice(0, 120) });
        } catch (receiptError) {
          this.#warn('F6 意图回执落盘失败（fail-open）', receiptError);
        }
      }
      this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
      this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail.slice(0, 200) });
      return;
    }

    const first = result.results[0];
    // v0.3.0：批次返回里没有本调用的结果（宿主静默丢弃/未派发）→ 补闭合，避免未解广告。
    if (first === undefined) {
      try {
        this.#ports.events?.repairToolCall?.(turn, step, cmd.id);
      } catch (repairError) {
        this.#warn('tool-call 生命周期闭合事件写入失败（fail-open）', repairError);
      }
    }
    const contentText = blockTextOf(first?.result?.content);
    const isError = first?.result?.isError === true;

    // ---- 观测登记（O1 三档返回；失败一律 high）。v0.4.0：tf-call 按宿主工具名分族
    // （familyHint 语义：web/skill/agent/ask → high 候选，office/goal → 低增益回执）----
    const observation = this.#obs.observe({
      tool: cmd.name === 'tf-call' ? (cmd.attrs['name'] ?? 'tf-call')
        : cmd.name === 'tf-ask' ? 'ask_user_question'
        : cmd.name === 'tf-skill' ? 'skill'
        : cmd.name,
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
      // F6 写后回执（工具级失败路径）：意图闭合为"已发生但失败"
      if (intentOp !== null) {
        try {
          this.#ports.onIntentReceipt?.({ cmdId: cmd.id, ok: false, detail: rec.detail.slice(0, 120) });
        } catch (receiptError) {
          this.#warn('F6 意图回执落盘失败（fail-open）', receiptError);
        }
      }
      this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
      this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail.slice(0, 200) });
      return;
    }

    rec.status = 'ok';
    // v0.4.2：detail 显示**写入正文的大小**（cmd.body = 解析器捕获的原文长度）——
    // 旧实现显示 contentText.length（回执包装 `<path>...Created file...</content>`
    // 的自身长度 ≈144 字符），模型误读为"文件只有 144 字符"→ 触发全量重写
    // （真机 session-3d4caf01：白烧 2-3 步 + 1 万思考 token）。
    rec.detail = `written ${(cmd.body ?? '').length} chars`;
    rec.handle = observation.handle ?? undefined;
    if (cmd.name === 'tf-write' && typeof cmd.attrs['path'] === 'string') {
      // 修复限制 1：登记本任务自写路径（tf-read 命中时只注入回执，掐断"写→读回验"循环）
      this.#writtenPaths.add(normalizeTaskPath(cmd.attrs['path']));
    }
    // F6 写后回执（成功路径）
    if (intentOp !== null) {
      try {
        this.#ports.onIntentReceipt?.({ cmdId: cmd.id, ok: true, detail: rec.detail.slice(0, 120) });
      } catch (receiptError) {
        this.#warn('F6 意图回执落盘失败（fail-open）', receiptError);
      }
    }
    // F5：命令成功（有回执）→ 声明的验收项记为已验证（证据 = 命令 id + 句柄/指纹）
    this.#markAccepts(cmd, rec.handle, contentFingerprint(contentText));
    // 0.5.0（§5.6(1)）：效果落账——效果压缩的数据源（目标、版本、diffstat、验证状态、句柄）
    this.#recordEffect(cmd, rec, contentText);
    this.#record({
      seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'ok',
      handle: rec.handle, infoGain: observation.info_gain, detail: rec.detail,
    });
    this.#ledgerWrite('plugin:tf-agent/command', {
      cmdId: cmd.id, name: cmd.name, status: 'ok',
      handle: rec.handle, infoGain: observation.info_gain,
      // v0.4.2：写入类命令的 chars = 写入正文的大小（与 digest 一致），不是回执包装长度。
      chars: (cmd.body ?? '').length,
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
        // v0.4.0（R5）：strictAdmission 开启才带 toolSet（与 tf-* 批同一准入视图）
        ...(this.#cfg.strictAdmission && this.#currentSurface?.toolSet !== undefined
          ? { toolSet: this.#currentSurface.toolSet }
          : {}),
        signal,
        log: safeToolLog(this.#ports, turn, step),
      });
    } catch (error) {
      this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'native-tool-batch-error', detail: error instanceof Error ? error.message : String(error) });
    }
    // v0.3.0：广告已随 assistant 消息落盘；批次异常/缺项时逐个闭合，避免未解工具生命周期。
    for (const call of calls) {
      if (result !== undefined && result.results.some((r) => r.callId === call.id)) continue;
      try {
        this.#ports.events?.repairToolCall?.(turn, step, call.id);
      } catch (repairError) {
        this.#warn('原生 tool-call 生命周期闭合事件写入失败（fail-open）', repairError);
      }
    }
    const results = (result?.results ?? []).map((r) => ({
      callId: r.callId,
      name: calls.find((c) => c.id === r.callId)?.name ?? 'unknown',
      content: blockTextOf(r.result?.content),
      isError: r.result?.isError === true,
    }));
    for (const _call of calls) this.#ports.onToolSettled?.();
    // 0.5.0（§5.6(1)）：代码通道的效果压缩单元 = run_code 整次调用（一次 = 一条效果）。
    // 记录来自程序的返回值声明（返回值文本长度），不来自子调用事件（§5.5：子调用不产生
    // 模型可见事件）。
    for (const r of results) {
      if (r.name !== 'run_code' || r.isError || !this.#cfg.effectElision) continue;
      this.#effectCounter += 1;
      this.#effects.push({
        effectId: `p${this.#effectCounter}`,
        cmdId: r.callId,
        action: 'run_code',
        target: 'run_code',
        verify: 'pass',
        digestIndex: this.#cmdOrder,
      });
    }
    if (results.length === 0 || level === 'final-only') return;

    // 原生通道结果即需求（阻塞语义）：注入易变尾，下一请求立即可见。
    // F4：仅在声明了 nativeToolSchemas（原生通道显式启用）时执行上限策略——
    // 首成功/短结果完整注入；超限块登记 obs 并转"骨架 + 句柄"，杜绝全量回灌。
    const capped = this.#cfg.nativeToolSchemasEnabled === true;
    const blocks = results.map((r) => {
      if (!capped || r.isError || r.content.length <= this.#cfg.nativeResultLimit) {
        const nativeFull = `[tf-stream:tool-result callId=${r.callId} tool=${r.name}${r.isError ? ' isError=true' : ''}]\n${r.content}`;
        // v0.4.3（P0-7①）：上限内/未启用上限策略 = full（错误块如实计 full——它是实发内容）
        this.#noteFeedback('full', nativeFull);
        return {
          role: 'user'         ,
          content: nativeFull,
        };
      }
      const observation = this.#obs.observe({
        tool: r.name,
        ok: true,
        key: `native:${r.name}:${r.callId}`,
        content: r.content,
        callId: r.callId,
      });
      const skeleton = observation.payload.kind === 'skeleton' ? observation.payload.rendered : '';
      this.#record({
        seq: ++DRIVER_SEQ, kind: 'observation',
        handle: observation.handle, key: `native:${r.name}:${r.callId}`,
        infoGain: observation.info_gain, reason: `${observation.reason}:native-capped`,
      });
      const nativeCapped = `[tf-stream:tool-result callId=${r.callId} tool=${r.name}] ${r.content.length} 字符超出原生通道注入上限（${this.#cfg.nativeResultLimit}），已句柄化：${skeleton}\n（原文用 tf-peek handle="${observation.handle ?? ''}" from_line=.. to_line=.. 取回）`;
      // v0.4.3（P0-7①）：超限句柄化 = handle
      this.#noteFeedback('handle', nativeCapped);
      return {
        role: 'user'         ,
        content: nativeCapped,
      };
    });
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
      // v0.4.0（自 0.3.3 回流）：单请求读注入预算（按本请求新注入的正文累减；已注入过的
      // 不占额度）。≤0 = 关闭预算（回退点：行为等价 0.4.0 之前的逐文件上限）。
      let readBudget = this.#cfg.readFeedbackBudgetPerRequest > 0
        ? this.#cfg.readFeedbackBudgetPerRequest
        : Number.POSITIVE_INFINITY;
      for (const rec of this.#commands.values()) {
        const obs = rec.observation;
        if (obs === undefined || obs.info_gain !== 'high') continue;
        // 失败命令的 obs 也是 high，但失败走结构化错误块，这里跳过（避免双重注入）
        if (rec.status !== 'ok') continue;
        if (obs.payload.kind !== 'skeleton') continue;
        // v0.4.3（P0-7①）：反馈分类（full=全量回灌 / handle=骨架或截断+句柄），整块字节计入
        let feedbackClass                   ;
        if (this.#reportedObservations.has(obs.seq)) continue;
        this.#reportedObservations.add(obs.seq);
        let body        ;
        if (rec.cmd.name === 'tf-read') {
          // 0.5.0：读取统一走 span 感知取回（一次取回一个计数——口径与 0.4.x 的"自动 peek
          // 1 次"对齐）。spanLedger=false（回退点）时 peekWithLedger 恒 content 分支，
          // 行为与 plain peek 逐字节一致。
          const readHandle = obs.handle ?? '';
          const spanView = this.#cfg.spanLedger && readHandle !== ''
            ? this.#obs.peekWithLedger(readHandle, 1, Number.MAX_SAFE_INTEGER, this.#requestCount, { countRequest: false })
            : null;
          const full = spanView !== null
            ? (spanView.kind === 'unchanged' ? null : spanView.text)
            : this.#obs.peek(readHandle, 1, Number.MAX_SAFE_INTEGER);
          // 修复限制 1：自写回验 receipt——tf-read 命中本任务 tf-write 已写过的路径时，
          // 全文就在模型上下文里，不再重复回灌（掐断"写→读回验"循环，写批任务的主要 token 开销）。
          const selfWritten = this.#cfg.selfReadFeedback !== 'full'
            && typeof rec.cmd.attrs['path'] === 'string'
            && this.#writtenPaths.has(normalizeTaskPath(rec.cmd.attrs['path']));
          if (selfWritten) {
            const lines = full === null ? 'unknown' : String(full.split('\n').length);
            const fp = full === null ? 'unavailable' : contentFingerprint(full);
            const receiptContent = `[tf-stream:receipt handle=${obs.handle ?? ''} path=${rec.cmd.attrs['path']} lines=${lines} sha256=${fp}]`
              + `\n该路径由你本任务的 tf-write 写入，写入成功（写失败会有 [tf-stream:error]；没有错误注入即写成功）。`
              + `写入正文不回灌（回验纪律）——若它是在更早的流步骤写的，你当前上下文里没有原文。`
              + `需要原文（全量或行段）用 tf-peek handle="${obs.handle}" 取回；需要修改用 tf-edit 的 OLD 精确字面量可先 tf-peek 取回后再改。`;
            blocks.push({
              role: 'user',
              // v0.4.2 文案修正：写入正文不回灌——跨流步骤后"全文已在你的上下文中"是假的
              // （真机 session-8f22c7a0：模型自述 "I don't have the exact text visible"，被迫全量重写）。
              content: receiptContent,
            });
            // v0.4.3（P0-7①）：回执 = handle 类反馈（指针，不是全文；dedup 语义 P0-4 再分）
            this.#noteFeedback('handle', receiptContent);
            highInjected = true;
            continue;
          }
          // 0.5.0（§7.3(2)）：span 去重的回灌面——命中已投递且未变化 → 一行 [unchanged]
          //（跨回合工作集，§5.6(3)）；部分重叠 → 只补新增区间（spanView.text 已是新增部分）。
          if (spanView !== null && spanView.kind === 'unchanged') {
            const unchanged = `[tf-stream:observation handle=${obs.handle ?? ''} key=${observationKey(rec.cmd)}]\n${spanView.line}`;
            blocks.push({ role: 'user', content: unchanged });
            this.#noteFeedback('handle', unchanged);
            highInjected = true;
            continue;
          }
          if (spanView !== null && spanView.kind === 'partial') {
            // 部分重叠：只补新增区间（span 账本剪掉已投递部分），原文按句柄仍可取回
            const partialBody = `${spanView.text}\n（${spanView.note}）`;
            const partialContent = `[tf-stream:observation handle=${obs.handle ?? ''} key=${observationKey(rec.cmd)}]\n${partialBody}\n（细节用 tf-peek handle="${obs.handle}" from_line=.. to_line=.. 取回）`;
            blocks.push({ role: 'user', content: partialContent });
            if (obs.handle !== null) {
              this.#obs.recordDelivered(obs.handle, spanView.from, spanView.to, this.#requestCount);
            }
            this.#noteFeedback('handle', partialContent);
            highInjected = true;
            continue;
          }
          // 0.5.0（§7.3(1) + §7.5 双旋钮）：读取侧超上限（maxReadChars）→ 行锚索引 +
          // 未投递区间（D4 修复：头部截断策略本身制造取回）；peekIndex=false（回退点）→
          // 回到 0.4.x 头部截断形态。
          if (this.#cfg.peekIndex && full !== null && full.length > this.#cfg.maxReadChars) {
            const spans = this.#obs.deliveredSpanList(obs.handle ?? '')
              .map((s) => ({ from: s.from, to: s.to }));
            const indexText = renderReadIndex(full, { delivered: spans });
            body = `${indexText}\n（正文超过读取上限 ${this.#cfg.maxReadChars} 字符：只投索引；用 tf-peek handle="${obs.handle}" from_line=.. to_line=.. 按窗口取回）`;
            feedbackClass = 'handle';
          } else {
            const readLimit = this.#cfg.readFeedbackLimit;
            body = full !== null && readLimit > 0
              ? readFeedbackBody(full, obs.payload.rendered, readLimit)
              : (full ?? obs.payload.rendered);
            // v0.4.0（自 0.3.3 回流）单请求读注入预算：一次读多文件时不再把每个文件的全文都
            // 塞进同一请求（真机 13 步会话 step 3：单请求 5916 个未缓存 token，占全会话未缓存
            // 输入的 47%）。预算内给全文，超出给"头 800 字符 + 句柄"，下一请求用 tf-peek 精确
            // 补全——把大块新内容摊平到多个请求，每个请求只新增它这一步真正要看的那份。
            let previewed = false;
            if (body.length > readBudget) {
              body = readPreviewBody(full, obs.payload.rendered, READ_PREVIEW_CHARS);
              previewed = true;
            }
            readBudget = Math.max(0, readBudget - body.length);
            // v0.4.3（P0-7①）：与 readFeedbackBody 同分支的分类——全文 ≤ 上限且未因预算降级
            // = full；取不到原文（骨架）、超限截断或预算降级 = handle（指针 + 句柄）。
            feedbackClass = !previewed && full !== null && (readLimit <= 0 || full.length <= readLimit) ? 'full' : 'handle';
            // 投递记账（span 账本）：只登记**实际进入上下文**的行区间——预算降级（preview）
            // 只投了头部，账本不得把整个文件记为已投递（否则未投递部分的 peek 会被误判
            // [unchanged]）。0.4.x 截断形态（readFeedbackLimit>0 且超限）同理只记实际发送的头尾？——
            // 头尾保留是"中段省略"，区间不连续，span 账本按区间记账不适用（不登记，回退点行为）。
            if (full !== null && obs.handle !== null && !previewed && (readLimit <= 0 || full.length <= readLimit)) {
              this.#obs.recordDelivered(obs.handle, 1, full.split('\n').length, this.#requestCount);
            } else if (full !== null && obs.handle !== null && previewed) {
              const deliveredLines = full.slice(0, READ_PREVIEW_CHARS).split('\n').length - 1;
              if (deliveredLines > 0) {
                this.#obs.recordDelivered(obs.handle, 1, deliveredLines, this.#requestCount);
              }
            }
          }
        } else if (rec.cmd.name === 'tf-code' && rec.output !== undefined) {
          // F3：code 结果可见性——上限内的首成功/变化值完整注入（省一次 tf-peek 往返）；
          // 句柄仍然有效，需要原文行段时照常 tf-peek。仅 tf-code 显式开启时此路径可达。
          body = rec.output;
          feedbackClass = 'full';
        } else {
          body = obs.payload.rendered;
          feedbackClass = 'handle';
        }
        const observationContent = `[tf-stream:observation handle=${obs.handle ?? ''} key=${observationKey(rec.cmd)}]\n${body}\n（细节用 tf-peek handle="${obs.handle}" from_line=.. to_line=.. 取回）`;
        blocks.push({
          role: 'user',
          content: observationContent,
        });
        // v0.4.3（P0-7①）：按整块实发字节计入其分类。
        this.#noteFeedback(feedbackClass, observationContent);
        highInjected = true;
      }
    }

    // 3. tf-peek 结果（need_result 通道；high-only/final-only 档暂停——预算紧张先保失败通道）
    if (level === 'normal') {
      for (const rec of this.#commands.values()) {
        if (rec.cmd.name !== 'tf-peek' || rec.status !== 'ok') continue;
        if (this.#reportedPeeks.has(rec.cmd.id)) continue;
        this.#reportedPeeks.add(rec.cmd.id);
        const peekContent = `[tf-stream:peek handle=${rec.cmd.attrs['handle'] ?? ''} lines=${rec.cmd.attrs['from_line'] ?? 1}-${rec.cmd.attrs['to_line'] ?? 'end'}]\n${rec.output ?? ''}`;
        blocks.push({
          role: 'user',
          content: peekContent,
        });
        // v0.4.3（P0-7①）：peek 是模型的显式取回请求 → 全量回灌
        this.#noteFeedback('full', peekContent);
      }
    }

    // 4. F5 计划差分（只注差分：新计划全量一次，此后只注变化——新增/验证/移除；净增 ≤0 的关键）
    if (this.#cfg.enablePlan && this.#plan !== null) {
      const announced = this.#planAnnounced;
      const planBlock = renderPlanDiff(this.#plan.revision, this.#plan.items, announced);
      if (planBlock !== null) blocks.push({ role: 'user', content: planBlock });
      // 更新已宣布快照（与本次注入一致；空差分不推进——下请求继续携带）
      if (announced === null) {
        this.#planAnnounced = new Map([...this.#plan.items].map(([id, item]) => [id, item.status]));
      } else if (planBlock !== null) {
        for (const [id, status] of this.#plan.items) announced.set(id, status);
        for (const id of [...announced.keys()]) {
          if (!this.#plan.items.has(id)) announced.delete(id);
        }
      }
    }

    // 4.5 0.5.0（§5.6(2)）：语义状态摘要——一行 ~30 token，替代模型重读测试输出自行判断。
    // 标准通道经回灌注入；代码通道经 S5 快照注入（runtimeStatus/stateDigestLine → systemPrompt.context）。
    // 摘要**不构成重入事由**：只挂在已确定要重入的请求上（搭车），且内容变化才重发——
    // 否则每请求都多一块，needsReentry 恒真，回合永远不收敛（f5 E1 回归抓到）。
    if (this.#cfg.stateDigest && this.#cfg.enablePlan && this.#plan !== null) {
      const digest = this.stateDigestLine();
      if (digest !== null && blocks.length > 0 && digest !== this.#lastDigestInjected) {
        blocks.push({ role: 'user', content: digest });
        this.#lastDigestInjected = digest;
      }
      // S5 端口在位（真实宿主 systemPrompt.context）→ 变化即推送快照（替换旧快照语义）；
      // 代码通道只走这条路（无回灌），标准通道两条都通。
      if (digest !== null) this.#pushRuntimeContext(digest);
    }

    // 5. 原生 tool_call 结果（阻塞通道回灌，任意档都注入——它们是模型的即时需求）
    blocks.push(...this.#pendingNativeBlocks);
    this.#pendingNativeBlocks = [];

    return { blocks, highInjected };
  }

  /**
   * 0.5.0（§5.6(1)）：给定命令 id，若其效果已落账、验证通过、且不在最近
   * effectElisionKeepRecent 个效果内 → 返回 [applied pN] 一行（效果压缩的折叠形态）；
   * 否则 null（原始输出照常回灌）。
   */
  #elidableEffectLineFor(cmdId        )                {
    if (this.#cfg.effectElision === false) return null;
    const index = this.#effects.findIndex((e) => e.cmdId === cmdId);
    if (index < 0) return null;
    return this.#effectLineIfElidable(this.#effects[index] , index);
  }

  /**
   * 0.5.0（§5.6(1)）：块内容级的效果折叠判定（压缩路径）——块内容含某已折叠效果的
   * 句柄（观测块 / 回灌块 / digest 行）→ 该块折叠为 [applied pN] 一行。
   */
  #elidableEffectLineForBlock(content        )                {
    if (this.#cfg.effectElision === false) return null;
    for (const [index, effect] of this.#effects.entries()) {
      if (effect.handle === undefined) continue;
      if (!content.includes(effect.handle)) continue;
      const line = this.#effectLineIfElidable(effect, index);
      if (line !== null) return line;
    }
    return null;
  }

  #effectLineIfElidable(effect             , index        )                {
    const recencyFromNewest = this.#effects.length - 1 - index;
    if (!shouldElideEffect(effect.verify, recencyFromNewest, this.#cfg.effectElisionKeepRecent)) return null;
    return renderEffectLine({
      effectId: effect.effectId,
      action: effect.action,
      target: effect.target,
      ...(effect.version !== undefined ? { version: effect.version } : {}),
      verify: effect.verify,
      ...(effect.acceptId !== undefined ? { acceptId: effect.acceptId } : {}),
      ...(effect.handle !== undefined ? { handle: effect.handle } : {}),
    });
  }

  // ------------------------------------------------------------------ 账本

  /**
   * 0.5.0 S5 快照贡献（§2.4 接缝 5 / §5.6(2)）：systemPrompt.context 由宿主 loop 渲染成
   * runtime-context 快照消息并 supersede 旧快照——语义自带版本替换，不造成前缀无限增长。
   * 端口缺席（离线/宿主未接）时静默跳过（标准通道的摘要已走回灌通道）；同文本不重发。
   */
  #pushRuntimeContext(text        )       {
    if (this.#runtimeContextPort === undefined) return;
    if (this.#lastDigestSent === text) return;
    this.#lastDigestSent = text;
    try {
      this.#runtimeContextPort(text);
      this.#ledgerWrite('plugin:tf-agent/cache', { kind: 's5-context', chars: text.length });
    } catch (error) {
      this.#warn('S5 runtime context 贡献失败（fail-open：标准通道回灌不受影响）', error);
    }
  }

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

/** 任务内路径规范化（自写回验判定用）：统一分隔符；大小写保留（不做平台猜测试）。 */
function normalizeTaskPath(path        )         {
  return path.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// 0.5.0（§4.6）：任务级预算指令（消息首行 [tf-budget: 8steps/20k] + 结构化 source.tfBudget）
// ---------------------------------------------------------------------------

                                      
                    
                          
 

/**
 * 解析并剥离消息首行的预算指令：`[tf-budget: 8steps/20k]`。
 *  - 8steps / 8step / 8步 → maxSteps；20k / 20000 → maxInputTokens（k = ×1000）；
 *  - 无指令（或无法解析出任何字段）返回原文与 null——正文一字节不动；
 *  - 有指令时返回剥离后的正文（指令行之后的内容）。
 */
export function parseTaskBudgetDirective(text        )                                                       {
  const firstLineEnd = text.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  const m = /^\s*\[tf-budget:\s*([^\]]+)\]\s*$/.exec(firstLine);
  if (m === null) return { text, budget: null };
  const budget                      = {};
  for (const part of m[1] .split('/')) {
    const spec = part.trim();
    if (spec === '') continue;
    const steps = /^(\d+)\s*(?:steps?|步)$/i.exec(spec);
    const tokens = /^(\d+)\s*k(?: tokens?)?$/i.exec(spec);
    if (steps !== null) budget.maxSteps = Number(steps[1]);
    else if (tokens !== null) budget.maxInputTokens = Number(tokens[1]) * 1000;
  }
  if (budget.maxSteps === undefined && budget.maxInputTokens === undefined) {
    return { text, budget: null };
  }
  const rest = firstLineEnd === -1 ? '' : text.slice(firstLineEnd + 1);
  return { text: rest, budget };
}

/** 结构化任务预算（§4.6：followup(message).source.tfBudget——followup 透传 message）。 */
function readStructuredTaskBudget(message         )                             {
  if (message === null || typeof message !== 'object') return null;
  const source = (message                        ).source;
  if (source === null || typeof source !== 'object') return null;
  const tfBudget = (source                          ).tfBudget;
  if (tfBudget === null || typeof tfBudget !== 'object') return null;
  const raw = tfBudget                                                    ;
  const budget                      = {};
  if (typeof raw.maxSteps === 'number' && Number.isFinite(raw.maxSteps) && raw.maxSteps >= 0) {
    budget.maxSteps = Math.floor(raw.maxSteps);
  }
  if (typeof raw.maxInputTokens === 'number' && Number.isFinite(raw.maxInputTokens) && raw.maxInputTokens >= 0) {
    budget.maxInputTokens = Math.floor(raw.maxInputTokens);
  }
  return budget.maxSteps === undefined && budget.maxInputTokens === undefined ? null : budget;
}

/** 内容指纹（receipt 行）：sha256 前 16 位十六进制——够对账，不泄露内容。 */
function contentFingerprint(content        )         {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
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

/** v0.4.0（自 0.3.3 回流）：单请求 tf-read 完整正文注入预算（字符）。一次读五个文件时，
 *  旧实现把五份全文都塞进同一请求（真机 13 步会话 step 3：5916 个未缓存 token，占全会话
 *  未缓存输入的 47%）。预算内的文件给全文，超出部分给"头 800 字符 + 句柄"预览，下一请求
 *  可用 tf-peek 精确补全——把大块新内容摊平，避免一次请求把缓存命中率拉低。
 *  12000 字符 ≈ 3k tokens；按 8000/文件的单文件上限，通常可容 1-2 份全文。 */
export const DEFAULT_READ_FEEDBACK_BUDGET_PER_REQUEST = 12_000;

/** v0.4.0：超预算 tf-read 的预览长度（字符）。小文件（≤ 此值）照给全文。 */
const READ_PREVIEW_CHARS = 800;

function readFeedbackBody(full               , skeleton        , limit        )         {
  if (full === null) return `${skeleton}\n（原文不可取回，仅骨架；tf-peek 可按行段重试）`;
  if (full.length <= limit) return full;
  const headCut = Math.max(0, Math.floor(limit * 0.7));
  const tailCut = Math.max(0, Math.floor(limit * 0.2));
  const omitted = full.length - headCut - tailCut;
  return `${full.slice(0, headCut)}\n……（中段省略 ${omitted} 字符；tf-peek handle=<句柄> from_line=.. to_line=.. 精确取回）……\n${full.slice(full.length - tailCut)}`;
}

/** v0.4.0（自 0.3.3 回流）：本请求读注入预算已满时的降级正文——头 N 字符 + 取回路径。
 *  小文件（≤ N 字符）照给全文：它几乎不占额度，没必要为省几百字符把模型推去额外 peek。 */
function readPreviewBody(full               , skeleton        , previewChars        )         {
  if (full === null) return `${skeleton}\n（原文不可取回，仅骨架；tf-peek 可按行段重试）`;
  if (full.length <= previewChars) return full;
  const lines = full.split('\n').length;
  return `${full.slice(0, previewChars)}\n……（本请求读注入预算已满：共 ${lines} 行 / ${full.length} 字符，此处只给前 ${previewChars} 字符；`
    + `余下用 tf-peek handle=<句柄> from_line=.. to_line=.. 精确取回）……`;
}

/** v0.3.1 截断修复：可回灌原结果的重复命令（信息类，无副作用）。
 *  模型把同一条读/搜/命令又发一次时，原实现只回"duplicate-idempotent（handle=…）"——
 *  上下文里已没有内容（观测只在易变尾注入一次），模型拿不到任何事实，只能再猜再读，
 *  直到用占位 final 收场。幂等语义不变（不重复执行），但把原结果回灌一次。 */
const REPLAYABLE_COMMANDS                      = new Set(['tf-read', 'tf-grep', 'tf-glob', 'tf-bash']);

/** 每回合最多回灌次数（防"模型原地打转 → 每步都回灌"的 token 黑洞；超限记 fault 不静默） */
const MAX_REPLAY_INJECTIONS = 4;

/** K4：识别取消类错误（AbortError / DOMException AbortError / 显式 abort 消息），与超时分账。 */
function isAbortError(error         )          {
  if (error instanceof Error) {
    return error.name === 'AbortError'
      || (error                ).code === 20
      || /(^|\b)(abort|aborted)(\b|$)/i.test(error.message);
  }
  return false;
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
  if (cmd.name === 'tf-code') {
    return '请按错误诊断修复程序体（语法/绑定参数/超时），换新 id 重发；简单场景可改道 tf-bash 或 tf-write。';
  }
  return '请根据失败原因修正后重发该命令（可换新 id）。';
}

function observationKey(cmd           )         {
  const base = cmd.attrs['path'] ?? cmd.attrs['cmd'] ?? cmd.attrs['handle'];
  if (base !== undefined) return base;
  // v0.4.0：tf-call 的稳定目标 = 工具名 + 参数指纹（同参数幂等归并，不同参数各自成 key）
  if (cmd.name === 'tf-call') {
    return `${cmd.attrs['name'] ?? 'unknown'}:${contentFingerprint(cmd.body ?? '')}`;
  }
  // tf-code 没有稳定目标：description 优先，缺省用程序体指纹（同 id 重复才归并，不同程序各自成 key）
  if (cmd.name === 'tf-code') {
    return cmd.attrs['description'] !== undefined
      ? `code:${cmd.attrs['description']}`
      : `code:${contentFingerprint(cmd.body ?? '')}`;
  }
  return cmd.name;
}

/**
 * F5 计划差分渲染：首个计划注全量清单；其后只注变化（新增 / 已验证 / 已移除）。
 * 无变化返回 null（不产生任何块——请求体积不变）。计划状态本身在驱动器侧，
 * 请求里永远只出现差分（净增 ≤0 的关键设计）。
 */
function renderPlanDiff(
  revision        ,
  items                                                                                       ,
  announced                                                 ,
)                {
  const lines           = [];
  if (announced === null) {
    // 首次：全量清单一次（带每项当前验证状态）
    lines.push(`[tf-stream:plan v${revision}]`, '任务计划与验收项（完成对应命令时用 accepts="<id>" 声明回执；全部验收项有回执后 tf-final 才会通过）：');
    for (const [id, item] of items) {
      lines.push(item.status === 'verified'
        ? `- [${id}] ${item.text} ✓ 已验证（回执：${item.evidence ?? '-'}）`
        : `- [${id}] ${item.text}（未验证）`);
    }
    return lines.join('\n');
  }
  const added           = [];
  const verified           = [];
  const removed           = [];
  for (const [id, item] of items) {
    const prev = announced.get(id);
    if (prev === undefined) added.push(`+ [${id}] ${item.text}`);
    else if (prev === 'open' && item.status === 'verified') verified.push(`✓ [${id}] 已验证（回执：${item.evidence ?? '-'}）`);
  }
  for (const id of announced.keys()) {
    if (!items.has(id)) removed.push(`- [${id}] 已从计划移除`);
  }
  if (added.length === 0 && verified.length === 0 && removed.length === 0) return null;
  lines.push(`[tf-stream:plan-diff v${revision}]`);
  lines.push(...added, ...verified, ...removed);
  return lines.join('\n');
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

/** RenderMessage → GenerateOptions.messages 线格式（loop-built 请求：首条 system 携带系统提示）。
 *  v0.4.2：assistant 消息必须携带 source（宿主 LlmRuntime.forAdapter 无防护读
 *  message.source.replayState，GitHub master 同源；缺失 = 流 error → 回合中断）。 */
function toWireMessages(messages                          )                                   {
  return messages.map((m) => ({
    role: m.role,
    content: [{ type: 'text'         , text: m.content }],
    ...(m.source === undefined ? {} : { source: { ...m.source } }),
  }));
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
 * 会话日志 assistant 消息的 model source（v0.4.1-beta.2 修复，与 0.3.2 同一套）。
 * 宿主校验器（dsh-session assertMessageEventShape → hasProviderModel）要求
 * `source = {kind:'model', provider:<非空字符串>, model:<非空字符串>}`；缺 provider/model
 * 的日志在读取时抛 `message must have model source`，整条会话被判 corrupt——桌面端
 * 表现为"历史加载失败"。0.4.1-beta.1 及更早版本只写了 `{kind:'model'}`，本类型把实时
 * provider/model 带进写入路径（applySelection 换模后随动）。
 */
/** v0.4.2：assistant 消息的宿主来源（会话日志 source 与请求装配的 RenderMessage.source
 *  共用）。kind 固定 'model'（宿主 forAdapter/validateReplay 都先读 source.kind）。 */
                                  
                
                   
                
 

/**
 * 从 duck-typed Session 构造 TurnEventWriter。
 * 事件形状对照：turn/start {turn}（:731）、step/start {turn,step}（:757）、
 * step/end {turn,step}（:781）、turn/end {turn,reason}（:819）、
 * assistant/message {turn,step,message,usage?,stream}（:949，surfaceOp:'append'）、
 * assistant/attempt {turn,step,stream}（:924）。assistant message 形状镜像
 * dsh-llm createAssistantMessage（lib/types/message.js:64-73）：{id, role:'assistant',
 * content:[{type:'text',text}], source:{kind:'model', provider, model}}（探针 C 实测可写）。
 *
 * v0.4.1-beta.2：modelInfo 在**写入时**调用（不缓存）——applySelection 运行时换模后随动；
 * 缺省（离线/无模型路由信息）时 provider/model 落 'unknown'，保证日志形状仍可通过
 * 宿主校验（空字符串同样会被 hasProviderModel 拒绝）。
 */
export function createSessionEventWriter(session         , modelInfo                        )                              {
  const s = session                                                                                     ;
  if (s === undefined || typeof s.append !== 'function') return undefined;
  const append = (type        , data         , opts          )       => {
    s.append (type, data, opts);
  };
  /** v0.3.1：带结算信息的 append（seq 供 assistant-stream end 帧配对）。 */
  const appendSettling = (type                                           , data         , opts          )                                                                         => {
    const appended = s.append (type, data, opts)                                       ;
    return { eventType: type, ...(appended !== null && typeof appended === 'object' && typeof appended.seq === 'number' ? { seq: appended.seq } : {}) };
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
      const toolCalls = info.toolCalls ?? [];
      const reasoning = info.reasoning;
      if (info.finish.kind === 'error' || info.finish.kind === 'aborted') {
        if (text.length > 0) {
          // 中断但有部分正文：assistant/message + interrupted（镜像内建 :891-905）
          return appendSettling('assistant/message', {
            turn, step,
            message: makeAssistantMessage(text, [], reasoning, modelInfo?.()),
            interrupted: true,
            ...usageField,
            stream: [],
          }, { surfaceOp: 'append' });
        }
        return appendSettling('assistant/attempt', { turn, step, stream: [] });
      }
      if (text.length === 0 && toolCalls.length === 0) {
        // 成功终止但无文本也无原生调用：assistant/attempt（镜像内建 :906-915 的空内容分支）
        return appendSettling('assistant/attempt', { turn, step, stream: [] });
      }
      return appendSettling('assistant/message', {
        turn, step,
        message: makeAssistantMessage(text, toolCalls, reasoning, modelInfo?.()),
        ...usageField,
        stream: [],
      }, { surfaceOp: 'append' });
    },
    advertiseToolCalls(turn, step, calls) {
      if (calls.length === 0) return;
      // v0.3.0：v4 会话格式的工具生命周期广告。形状 = 内建 loop 的 assistant/message
      // （content 里的 tool-call 块），arguments 必须与随后 tool/call 里的字符串逐字节相同
      // （宿主校验器用严格相等比对 name/arguments）。
      append('assistant/message', {
        turn, step,
        message: makeAssistantMessage('', calls, undefined, modelInfo?.()),
        stream: [],
      }, { surfaceOp: 'append' });
    },
    repairToolCall(turn, step, callId) {
      // v0.3.0：派发异常后的生命周期闭合。先读会话快照确认事实，已有 result 就什么都不写
      // （重复 result 会让日志再次 corrupt）。
      const snap = (s                                                              ).snapshotEvents;
      const events = typeof snap === 'function' ? snap.call(s) : [];
      let started = false;
      let settled = false;
      for (const event of events) {
        const e = event                                                                                       ;
        if (e.type === 'tool/call' && e.data?.callId === callId) started = true;
        if (e.type === 'tool/result' && e.data?.message?.toolCallId === callId) settled = true;
      }
      if (settled) return;
      if (started) {
        append('tool/result', {
          turn, step,
          message: {
            id: `tool-result-${callId}-${randomUUID()}`,
            role: 'tool',
            source: { kind: 'tool', callId },
            toolCallId: callId,
            isError: true,
            content: [{ type: 'text', text: 'Error: tool call ended without a recorded result（插件在派发异常后补写的闭合结果）' }],
          },
        }, { surfaceOp: 'append' });
        return;
      }
      // 未开始：宿主 v4 校验唯一接受的形状（notStartedRepair：id 前缀 / 固定正文 /
      // error.name=ToolNotStartedError + code=TOOL_NOT_STARTED / 无 sourceEventSeqs）。
      append('tool/result', {
        turn, step,
        message: {
          id: `interrupted-tool-result-${callId}-0`,
          role: 'tool',
          source: { kind: 'tool', callId },
          toolCallId: callId,
          isError: true,
          content: [{ type: 'text', text: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.' }],
        },
        error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
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
        message: makeAssistantMessage(text, [], undefined, modelInfo?.()),
        stream: [],
      }, { surfaceOp: 'append' });
    },
    toolLog(turn, step) {
      return { turn, step };
    },
  };
}

                                                                                                                                                                       

/**
 * 构造 assistant 消息（形状镜像 dsh-llm createAssistantMessage，lib/types/message.js:64-73）。
 * v0.4.1-beta.2：source 必须携带非空 provider/model（宿主 hasProviderModel 校验，缺了整条日志
 * 判 corrupt）；写入方未提供或为空串时落 'unknown'——日志保持可加载，不谎报模型。
 */
function makeAssistantMessage(text        , toolCalls                                   = [], reasoning         , modelInfo                  )                                                                                                                                  {
  const content                          = [];
  // v0.3.1：reasoning 块在首位（镜像内建 BlockAssembler 的流序：思考先于正文）。
  if (reasoning !== undefined && reasoning.trim() !== '') content.push({ type: 'reasoning', text: reasoning });
  if (text.length > 0) content.push({ type: 'text', text });
  for (const call of toolCalls) content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments });
  const provider = modelInfo?.provider !== undefined && modelInfo.provider !== '' ? modelInfo.provider : 'unknown';
  const model = modelInfo?.model !== undefined && modelInfo.model !== '' ? modelInfo.model : 'unknown';
  return {
    id: randomUUID(),
    role: 'assistant',
    content,
    source: { kind: 'model', provider, model },
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
  /** v0.4.1-beta.2：agent/status 发射出口（宿主事件总线；缺省 = 不发）。 */
  #emitStatus                                                                                  = undefined;

  constructor(deps                     ) {
    this.id = deps.id;
    this.session = deps.session;
    this.#driver = deps.driver;
    this.#storedHandle = deps.storedHandle;
    this.#warning = deps.onWarning ?? (() => {});
    this.#emitStatus = deps.emitStatus;
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
   *  修复限制 2（对齐内建语义）：回合运行中 → 注入运行中回合的下一步（下一请求装配时
   *  进追加区，[tf-stream:steer] 用户块）；单流"流内不打断"前提不变——不掐当前流。
   *  空闲 → 与内建一致按新回合任务处理（插队队首）。 */
  steer(message                                                                                                       )       {
    if (this.#disposed) throw new Error(`agent "${this.id}": steer after dispose`);
    const text = message.content
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block && typeof (block                      ).text === 'string' ? (block                      ).text : ''))
      .join('\n');
    if (text.trim() === '') throw new Error(`agent "${this.id}": steer 消息没有文本内容`);
    debugTrace('steer', { id: this.id, chars: text.length, running: this.#status === 'running' });
    this.#appendSessionEvent('user/message', message, { surfaceOp: 'append' });
    if (this.#status === 'running') {
      this.#driver.pushSteer(text, message);
      return;
    }
    this.#inbox.unshift({ text, message });
    if (this.#status === 'idle') this.#startNextTurn();
  }

  /** v0.4.1-beta.2：桌面端命令路径的通知注入（dsh-user-approval setPolicy:127 实测调用
   *  `agent.inject(...)`——0.4.1-beta.1 缺这个方法，改审批策略的命令以
   *  "agent.inject is not a function" 报错收场）。镜像内建 send(input,'next-step',false)：
   *  落盘 + 并入"下一步"装配，但**不唤醒空闲 agent**（通知型注入不该自己开回合）。
   *  pendingSteers 在 runTurn 的每次请求前消费（含下一回合首请求）——无论运行中还是
   *  空闲都走同一通道，下一请求必然可见；steer/inject 的区别只在唤醒，与内建一致。 */
  inject(message                                                                                                       )       {
    if (this.#disposed) throw new Error(`agent "${this.id}": inject after dispose`);
    const text = message.content
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block && typeof (block                      ).text === 'string' ? (block                    ).text : ''))
      .join('\n');
    debugTrace('inject', { id: this.id, chars: text.length, running: this.#status === 'running' });
    this.#appendSessionEvent('user/message', message, { surfaceOp: 'append' });
    if (text.trim() === '') return;
    this.#driver.pushSteer(text, message);
  }

  /** 桌面端空内容续跑路径读取的 inbox 面（prompt:37548）。修复限制 2 后：
   *  nextStep 如实暴露尚未消费的 steer（已注入装配历史的从队列移除）；
   *  nextTurn 恒为空（单流没有跨回合排队注入）。 */
  get inbox()                                               {
    return { nextTurn: [], nextStep: [...this.#driver.pendingSteerMessages] };
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

  /** v0.4.1-beta.2：运行态转换统一出口（只在真正变化时发 agent/status，镜像内建 setPhase 语义）。
   *  发射失败不阻断回合（fail-open，告警不静默）。 */
  #setStatus(next                    )       {
    if (this.#status === next) return;
    this.#status = next;
    try {
      this.#emitStatus?.({ agent: this, status: next });
    } catch (error) {
      this.#warning(`agent "${this.id}": agent/status 发射失败（不阻断回合）`, error);
    }
  }

  /** 开下一回合（inbox 逐条串行驱动）。 */
  #startNextTurn()       {
    const next = this.#inbox.shift();
    if (next === undefined) return;
    this.#setStatus('running');
    this.#running = (async () => {
      try {
        // 0.5.0（§4.6）：透传 message——pushUserTask 读取 message.source.tfBudget
        //（结构化任务级预算），不再像 0.4.x 那样丢弃 message。
        this.#driver.pushUserTask(next.text, next.message);
        await this.#driver.runTurn();
      } catch (error) {
        // fail-open：回合异常必须浮出（headless 靠 whenIdle 拒绝感知失败）；告警出口保证有日志
        this.#warning(`agent "${this.id}": 回合异常上抛`, error);
        throw error;
      } finally {
        this.#running = undefined;
        if (this.#cancelCause !== undefined) {
          this.#setStatus('idle');
          if (!this.#cancelCause.keepInbox) this.#inbox.length = 0;
          this.#cancelCause = undefined;
          return;
        }
        if (this.#inbox.length > 0 && !this.#disposed) {
          this.#startNextTurn();
          return;
        }
        this.#setStatus('idle');
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

                                     
                                                     
                                                                                 
 

                                   
                    
                 
                           
                     
 

                      
                                     
                      
 

/**
 * 会话持久化面（宿主 sessionPersistence 与本地 JSONL 降级实现的结构公共面）。
 * 形状逐字段对应 initialize 内的 duck-type 用法（create/open/append/read/header）。
 */
                                         
                                                                                                   
                           
                                                       
                                                                                       
                     
                                 
     
                                                                            
                           
                                                       
                                                                                       
                     
                                 
     
 

                                         
                                                         
        
                                   
                                
                                   
                                                          
    
                                                                           
                                                                                                                               
                                                      
                                                     
                                                                                    
                                                     
                                
                                                                     
                                                          
 

                                         
                    
                        
                 
                            
                               
                                  
                       
                                                                 
 

                                         
                          
                        
                                  
                       
                                                                 
 

                                  
                         
                           
 

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
    // v0.2.1：loader 是可选服务——Cordis 下裸读会抛 "cannot get property ... without inject"，
    // 必须走安全探测（cordis-compat.ts 顶部记录了完整事故链）。
    const loader = getService                                   (ctx, 'loader');
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

      // 修复限制 3：本地 JSONL 持久化路径需要事件镜像——包装会话 append（原型链透传，
      // snapshotEvents/header 等行为不变）；宿主持久化路径不加包装（checkpoint 机制在宿主侧）。
      let driverSession          = preparation.session;
      if (args.persistenceIsFallback === true && stored !== undefined) {
        const storedHandle = stored.handle;
        driverSession = withEventCapture(preparation.session, {
          appendEvents: (events) => {
            void storedHandle.append?.(events         )?.catch?.((error         ) => {
              warning('[stream-loop] 会话事件落盘失败（fail-open：内存事实不丢）', error);
            });
          },
        }, warning);
      }

      const { driver } = deps.createDriver({
        sessionId: args.sessionId,
        agentOptions: args.agentOptions,
        session: driverSession,
      });
      debugTrace('driver.created');
      driver.setIdentity(args.sessionId, args.sessionId);
      // 修复限制 4 的另一半：resume 路径回放 tf-* 台账事实（final 答案 + ok 命令幂等面）。
      // 来源二选一：宿主路径扫 seed 里的 plugin:tf-agent/* 事件；本地台账路径读 ledger JSONL。
      if (args.prepareOpts.seed !== undefined || args.fallbackLedger?.file !== undefined) {
        const records = collectTfAgentRecords(args.prepareOpts.seed, args.fallbackLedger?.file, warning);
        if (records.length > 0) {
          const replay = driver.rehydrateRecords(records);
          debugTrace('ledger.rehydrated', replay);
        }
      }
      // 探针 C 定案：ledger 走 plugin:tf-agent/* 私有记录（appendPluginRecord 自动 ignorable:true）。
      // 宿主模块不可达（bundle 形态 bare import 解析不到同一副本）→ 降级本地文件台账（可重放，
      // 修复限制 4）；连本地台账都不可用才降级内存，告警不静默。
      await attachSessionLedger(driver, driverSession, warning, deps.ctx, args.fallbackLedger);
      debugTrace('ledger.attached');

      const agent = new StreamLoopAgent({
        id: args.sessionId,
        session: driverSession,
        driver,
        ctx: ownerCtx,
        scopeModule: dshScope,
        storedHandle: stored?.handle,
        modelSelection: {
          provider: args.agentOptions.provider ?? '',
          model: args.agentOptions.model ?? '',
          reasoningEffort: args.agentOptions.reasoningEffort,
        },
        // v0.4.1-beta.2（UI 卡住修复，与 0.3.2 同一套）：宿主事件总线在位（cordis ctx.emit）
        // 才接 agent/status。桌面端 dsh-api-session-controller 监听它转发 api-session/status
        // （running 布尔），客户端据此收起"运行中"指示——不接线 = 回合结束后 UI 永远转圈。
        ...(typeof (deps.ctx                      ).emit === 'function'
          ? {
              emitStatus: (payload                                                ) => {
                (deps.ctx                                                      ).emit('agent/status', payload);
              },
            }
          : {}),
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
      // 修复限制 3：宿主 sessionPersistence 缺位 → 本地 JSONL 持久化（会话事件落盘，
      // resume 真正可用）；两者都缺 → create 不落盘（v0.1 行为）。
      let persistence = deps.ctx.get?.('sessionPersistence')                                      ;
      let persistenceIsFallback = false;
      if ((persistence === undefined || typeof (persistence                        ).create !== 'function') && deps.createFallbackPersistence !== undefined) {
        const fallback = deps.createFallbackPersistence(options.sessionId);
        if (fallback !== undefined && typeof fallback.create === 'function') {
          persistence = fallback;
          persistenceIsFallback = true;
          debugTrace('persistence.fallback.jsonl', { sessionId: options.sessionId });
        }
      }
      return initialize(ownerCtx, {
        sessionId: options.sessionId,
        prepareOpts: {
          ...(options.meta === undefined ? {} : { meta: options.meta }),
          ...(options.seed === undefined ? {} : { seed: options.seed }),
          ...(options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount }),
        },
        persistence,
        persistenceIsFallback,
        fallbackLedger: deps.fallbackLedger?.(options.sessionId),
        agentOptions: options.agentOptions ?? {},
        setup: options.setup,
        source: 'startup',
        parentAgent: options.parentAgent,
        signal: options.signal,
      });
    },

    async resume(ownerCtx, options) {
      assertSessionId(options.resumeSessionId);
      // 修复限制 3：宿主 sessionPersistence 缺位 → 本地 JSONL 持久化 resume（不再直接报错）。
      let persistence = deps.ctx.get?.('sessionPersistence')                                      ;
      let persistenceIsFallback = false;
      if ((persistence === undefined || typeof persistence.open !== 'function') && deps.createFallbackPersistence !== undefined) {
        const fallback = deps.createFallbackPersistence(options.resumeSessionId);
        if (fallback !== undefined && typeof fallback.open === 'function') {
          persistence = fallback;
          persistenceIsFallback = true;
          debugTrace('resume.persistence.fallback.jsonl', { sessionId: options.resumeSessionId });
        }
      }
      if (persistence === undefined || typeof persistence.open !== 'function') {
        throw new Error('[stream-loop] cannot resume: session persistence is not configured（需要 dsh-session-persistence 后端，或启用本地 JSONL 持久化降级）');
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
          persistenceIsFallback,
          fallbackLedger: deps.fallbackLedger?.(id),
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

/** 从 seed 事件与本地台账文件收集 plugin:tf-agent/* 记录（resume 重放入口）。 */
function collectTfAgentRecords(
  seed                                ,
  ledgerFile                    ,
  warn                                              ,
)                                         {
  const records                                         = [];
  if (seed !== undefined) {
    for (const event of seed) {
      if (event === null || typeof event !== 'object') continue;
      const e = event                                      ;
      if (typeof e.type === 'string' && e.type.startsWith('plugin:tf-agent/')) {
        records.push({ kind: e.type, data: e.data });
      }
    }
  }
  if (ledgerFile !== undefined) {
    const loaded = loadLedgerRecords(ledgerFile);
    if (loaded.skipped > 0) warn?.(`[stream-loop] 本地台账坏行跳过 ${loaded.skipped} 条（${ledgerFile}）`);
    for (const rec of loaded.records) records.push({ kind: rec.type, data: rec.data });
  }
  return records;
}

/**
 * 探针 C 通道（修复限制 4）：优先经宿主 loader 取同源 @deepseek-ai/dsh-session 副本调用
 * appendPluginRecord（bundle 形态 bare import 不走宿主解析，必须走 loader 的 internal 通道——
 * 与 dsh-scope 同款三级降级）；仍不可达且提供了本地台账 → 降级 JSONL 文件台账（可重放，
 * 非易失内存）；两者都不可用才降级内存台账。每级降级都告警，绝不静默。
 */
export async function attachSessionLedger(
  driver                    ,
  session         ,
  warn                                              ,
  ctx          ,
  fallback                     ,
)                {
  try {
    const mod = (await acquireHostModule(ctx, '@deepseek-ai/dsh-session'))     
                                                                                 
                 ;
    if (mod === undefined || typeof mod.appendPluginRecord !== 'function') throw new Error('appendPluginRecord 导出缺失');
    driver.attachLedger({
      record(type, data) {
        mod.appendPluginRecord (session, type, data);
      },
    });
  } catch (error) {
    if (fallback !== undefined) {
      driver.attachLedger({
        record(type, data) {
          fallback.appendRecord(type, data);
        },
      });
      warn?.('[stream-loop] plugin:tf-agent ledger 的 plugin record 通道不可达，降级本地文件台账（JSONL 落盘，resume 可重放）', error);
      return;
    }
    // 类身份/解析失败且无本地台账 → 内存台账降级（driver 内存 records 永远有全量事实），告警不静默
    warn?.('[stream-loop] plugin:tf-agent ledger 落 plugin record 失败，降级内存台账（resume 后 tf-* 状态不可重放）', error);
  }
}

// ---------------------------------------------------------------------------
// ⑤ apply —— Cordis 函数插件入口（生产 preset 挂载；F1 路线接管）
// ---------------------------------------------------------------------------

                                  
                    
                 
                           
                                
                        
                               
                            
                                                                    
                   
                                                                    
                
                                      
                    
                                                         
                          
                         
                                                
                       
                      
                        
                           
                                
                           
                                               
                          
                          
                                   
                            
                        
                                                             
                              
                                                     
                       
                                                  
                      
                                      
                        
                                                       
                             
                                                                 
                                            
                              
                             
                             
                                
                                                                  
                          
                         
                                                                      
                       
                                 
                            
                                                              
                                            
                                                                 
                                                   
                                                                               
                                                                
                                             
                 
                     
                  
                  
                           
                  
    
                                                                
                                                      
                                                                     
                                                    
                        
                                        
                               
                             
                        
                        
                                                              
                              
                                                                            
                                             
                         
                                           
                                             
                                                    
                          
                                                                                      
                                        
                                                            
                                   
                       
                                                                                           
                        
                                                                               
                                
                                                                 
                                   
                             
                                                               
                       
                                                           
                          
                                                                 
                                         
                                                                
                           
                                             
                         
                                                                                          
                        
                                       
                        
                                                         
                            
                                                                   
                         
                                                                         
                                                                     
                            
                                                                        
                    
                                                                           
                                 
                
                                      
                
                                                                        
                             
 

/**
 * v0.4.0 → 0.5.0：装配 config 的工具面档位归一（未知值回 standard）。
 * 0.5.0 D2 修复：'off' 档**已删除**——它曾把第三方工具砍到完全不可达（§4.3）；
 * 工具面策略走 surfacePolicy（reserved-only 默认 = 透传），'off' 值由调用方告警。
 */
export function asSurfaceProfile(value                    )                 {
  return value === 'core' || value === 'standard' || value === 'full' ? value : 'standard';
}

/** 0.5.0：surfacePolicy 归一（'profile' 仅回退演练保留；未知值归一 reserved-only）。 */
export function asSurfacePolicy(value                    )                {
  return value === 'profile' ? 'profile' : 'reserved-only';
}

/**
 * 0.5.0（§5.2）：代码通道三来源探测（U3 探针）。
 * 判定只依赖"当前作用域执行器是否为 PTC 实现"（R12 设计约束：不依赖 preset id）：
 *  ① 显式 config.codeChannelSource 绕过探测；
 *  ② preset 探针（U3）：duck-type 宿主 tools 服务的执行器内省面，或解析一次工具清单看
 *     `run_code` 是否在面内（PTC preset 注册的唯一程序入口）；
 *  ③ bridge 判定：ctx.ptcRuntime 存在且形状符合（looksLikePtcRuntime）。
 * 返回 'preset' | 'bridge' | null（null = 代码通道不可用——拒绝进入，§5.2 第三分支）。
 */
export function detectCodeChannelSource(
  tools                                                                                                                                                                      ,
  ptcRuntime         ,
)                             {
  // ② preset 探针：执行器内省面（duck-type；宿主若提供即直接判）
  if (tools !== undefined && typeof tools.getExecutor === 'function') {
    try {
      const executor = tools.getExecutor(undefined);
      if (looksLikePtcExecutor(executor)) return 'preset';
    } catch { /* 内省失败 → 下一探针 */ }
  }
  if (looksLikePtcExecutor(tools?.executor)) return 'preset';
  // ② preset 探针（U3 回退形态）：工具清单内出现 run_code = PTC preset 在位
  if (tools !== undefined && typeof tools.schemas === 'function') {
    try {
      const schemas = tools.schemas(undefined, undefined)                                    ;
      if (Array.isArray(schemas) && schemas.some((s) => (s                      )?.name === 'run_code')) {
        return 'preset';
      }
    } catch { /* 无 agent 作用域时解析可能失败 → 不判 preset */ }
  }
  // ③ bridge：ctx.ptcRuntime 服务在位且形状符合
  if (looksLikePtcRuntime(ptcRuntime)) return 'bridge';
  return null;
}

/** duck-type 判定"执行器实现是 PTC"（R12：不按 preset id，按实现特征）。 */
function looksLikePtcExecutor(executor         )          {
  if (executor === null || executor === undefined || typeof executor !== 'object') return false;
  const e = executor                                                                               ;
  if (typeof e.runProgram === 'function') return true;
  const name = typeof e.name === 'string' ? e.name.toLowerCase() : '';
  if (name.includes('ptc')) return true;
  const kind = typeof e.kind === 'string' ? e.kind.toLowerCase() : '';
  return kind.includes('ptc');
}

/**
 * v0.4.1：装配 config 的段级增删表 → 类型化协议段配置。
 * 宽松键（拼写错误/前端字段）在这里告警并丢弃——不阻断装载，但绝不静默（红线 5）；
 * 驱动器构造期对非法值 fail-fast（composeProtocolText 抛错），所以必须在入口先洗净。
 */
export function sanitizeProtocolSections(
  value                                     ,
  warn                            ,
)                                                          {
  if (value === undefined) return undefined;
  const cleaned                                              = {};
  for (const [key, flag] of Object.entries(value)) {
    if ((PROTOCOL_SECTION_IDS                     ).includes(key) && typeof flag === 'boolean') {
      cleaned[key                     ] = flag;
    } else {
      warn?.(`[stream-loop] protocolSections 未知段或非布尔值已忽略: ${key}=${String(flag)}（可用: ${PROTOCOL_SECTION_IDS.join(', ')}）`);
    }
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/** v0.4.1：协议档位（字符串形态）归一 + 未知值告警（归一 full 是 fail-open，告警是红线 5）。 */
export function resolveProtocolLevel(value                    , warn                            )                {
  if (value === undefined) return 'full';
  const level = asProtocolLevel(value);
  if (level !== value) warn?.(`[stream-loop] protocolLevel 未知档位 "${value}"，归一为 full（可用: full|lean|minimal）`);
  return level;
}

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
  const logger = getService                                  (ctx, 'logger');
  const warning = (message        , detail          )       => {
    // 红线 5：告警走宿主 logger（可用时），否则 console.error —— 都不静默
    const text = `[stream-loop] ${message}${detail === undefined ? '' : ` :: ${detailString(detail)}`}`;
    if (logger?.warn !== undefined) logger.warn(text);
    else console.error(text);
  };

  // v0.2.1：全部服务读取走 getService —— Cordis 对未 inject 的属性裸读会抛
  // "cannot get property ... without inject"，v0.2.0 因此整层接管未激活（见 cordis-compat.ts）。
  const llm = getService                                                                           (ctx, 'llm');
  // v0.4.0：tools 服务取全量面（resolve/schemas 给 ToolSurface；execute 给工具批）
  const tools = getService                                                                                                                                                                 (ctx, 'tools');
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new Error('[stream-loop] ctx.llm.stream 不可用：entry 挂载失败（需要 dsh-llm 服务在位）');
  }
  if (tools === undefined || typeof tools.execute !== 'function') {
    throw new Error('[stream-loop] ctx.tools.execute 不可用：entry 挂载失败（需要 dsh-tools 服务在位）');
  }

  // 默认模型三级回退：agentOptions（宿主 agentDefaultModel 惰性 getter）→ entry config →
  // 宿主 agentDefaultModel → 最后兜底。桌面端部署常只挂 deepseek-account 路由，
  // 硬编码 deepseek-official/deepseek-chat 会请求到无凭据的路由。
  const agentDefaultModel = getService                                                                                          (ctx, 'agentDefaultModel');
  const defaultSelection = agentDefaultModel?.currentSelection?.() ?? {};
  const stateRoot = resolveStateDir(config.stateDir);
  // 控制状态（0.5.0 两轴）：显式 config（channel/tier，旧 mode 走别名 + warn）
  // > STREAM_AGENT_CHANNEL/STREAM_AGENT_TIER（旧 STREAM_AGENT_MODE 走别名）> control.json > 默认。
  // §6.4 命名空间：streamAgent.{channel,tier,lang,mode} 为具名写法；根级别名保留一个 minor。
  const ns = config.streamAgent ?? {};
  const control = resolveControlState(
    {
      channel: config.channel ?? ns.channel,
      tier: config.tier ?? ns.tier,
      lang: config.lang ?? ns.lang,
      mode: config.mode ?? ns.mode,
    },
    config.stateDir,
    warning,
  );
  // 每次新建 agent 时重算：桌面控制页可以在不重启的情况下切通道/档位，
  // 已有的 driver 保持创建时的参数（会话内不突变），新会话拿到新参数。
  // 0.5.0（§4.2）：档位只提供数值默认（maxSteps/maxInputTokens/压缩/取回），不再携带
  // 任何工具面/并行度副作用（D2/D3 的成因正是旧预设顺手改了工具面）。
  const resolveEffective = (    
                       
                 
                                         
                                    
                             
                                 
                         
                                     
                                 
                                
  ) => {
    const tierValues = getTier(control.tier).values;
    const surfacePolicyRaw = config.surfacePolicy ?? 'reserved-only';
    const surfacePolicy                = surfacePolicyRaw === 'profile' ? 'profile' : 'reserved-only';
    if (surfacePolicyRaw !== 'reserved-only' && surfacePolicyRaw !== 'profile') {
      warning(`[stream-loop] surfacePolicy 未知值 "${surfacePolicyRaw}"，归一 reserved-only（可用: reserved-only|profile）`);
    }
    if (surfacePolicy === 'profile') {
      warning('[stream-loop] surfacePolicy=profile 是 0.4.x 过滤行为（已弃用，仅回退演练 §12.4；默认 reserved-only 对第三方工具零影响）');
    }
    return {
      channel: control.channel,
      tier: control.tier,
      selfReadFeedback: config.selfReadFeedback ?? 'receipt',
      // 'auto' = 交给 codeExecutor 是否存在决定（保持 v0.2.0 的"宿主有 PTC 就开"语义）
      enableCode: config.enableCode,
      persistFallback: config.persistFallback ?? true,
      maxParallelToolCalls: config.maxParallelToolCalls ?? 3,
      maxReentries: config.maxReentries ?? 12,
      budgetTokens: config.budgetTokens,
      surfacePolicy,
      toolSurface: asSurfaceProfile(config.toolSurface),
    };
  };
  const effective = resolveEffective();
  // 修复限制 3/4：本地持久化兜底（默认开启；模式或 config.persistFallback === false 关闭）
  const persistFallbackEnabled = effective.persistFallback !== false;
  // 0.2.0 PTC 桥接：ctx.ptcRuntime 在位（形状校验通过）→ tf-code 通道可用；
  // 形状不符或缺失 → 通道关闭（协议文本不声明 tf-code），告警不静默（红线 5）。
  // v0.2.1：ptcRuntime 是可选服务，只经 getService 探测（裸读即装载期抛错）。
  const ptcRuntime = getService         (ctx, 'ptcRuntime');
  // 0.5.0（§5.2）：代码通道三来源探测（U3 探针；R12——只按执行器实现判定，不按 preset id）。
  // preset 探测走 tools 内省 / run_code 工具清单；bridge 探测走 ptcRuntime 形状。
  const codeSourceProbe = detectCodeChannelSource(tools                                                 , ptcRuntime);
  if (codeSourceProbe === null) {
    warning('[stream-loop] 代码通道来源判定 = none（未检测到 PTC 预设或 ptcRuntime）：channel=code 将被拒绝并回退标准通道（§5.2，不静默降级）');
  } else {
    warning(`[stream-loop] 代码通道来源判定 = ${codeSourceProbe}${codeSourceProbe === 'preset' ? '（PTC preset 在位：代码通道完全让位，§5.3）' : '（内置窄桥：受限能力，如实显示）'}`);
  }
  // v0.4.0（P5）：当前会话驱动器引用（createDriver 闭包回填；tf-code 全绑定按面生成）。
  // v0.4.1-beta.2：同一持有者供会话日志 model source 写入时取实时 provider/model（不缓存）。
  // v0.4.2：控制页状态面经此读取运行时缓存口径（cacheStats）。
  // 0.5.0：控制页状态面扩到 runtimeStatus（通道/档位/换基/取回统计）。
  const currentDriverRef   
              
                                        
                                     
                                                                                                   
                                                                       
                                       
                                                                                      
                                                            
                                                                                                                         
                                                                                                
      
    = {};
  const codeExecutor = looksLikePtcRuntime(ptcRuntime)
    ? createCodeExecutor(ptcRuntime, { executeTools: (input) => tools.execute(input         ) })
    : undefined;
  if (ptcRuntime !== undefined && codeExecutor === undefined) {
    warning('ctx.ptcRuntime 形状不符（缺 resolve/run），tf-code 通道关闭（fail-open，其余行为不变）', ptcRuntime);
  }
  const factory = createStreamAgentFactory({
    ctx: ctx                                            ,
    createFallbackPersistence: persistFallbackEnabled
      ? (sessionId) => createJsonlPersistence(join(stateRoot, 'sessions'), sessionId, warning)
      : undefined,
    fallbackLedger: persistFallbackEnabled
      ? (sessionId) => {
          const file = ledgerFileOf(stateRoot, sessionId);
          return { file, appendRecord: (type        , data         ) => appendLedgerRecord(file, type, data) };
        }
      : undefined,
    createDriver({ agentOptions, session, sessionId }) {
      const live = resolveEffective();
      const cfg                     = {
        provider: agentOptions.provider || config.provider || defaultSelection.provider || '',
        model: agentOptions.model || config.model || defaultSelection.model || '',
        reasoningEffort: agentOptions.reasoningEffort ?? config.reasoningEffort ?? defaultSelection.reasoningEffort,
        // ---- 0.5.0 两轴 + 数值旋钮（§4.2/§4.5）----
        channel: live.channel,
        tier: live.tier,
        maxSteps: config.maxSteps,
        maxInputTokens: config.maxInputTokens,
        compactAggressiveness: config.compactAggressiveness,
        keepRecent: config.keepRecent,
        maxSummaryChars: config.maxSummaryChars,
        peekBudgetChars: config.peekBudgetChars,
        effectElision: config.effectElision,
        effectElisionKeepRecent: config.effectElisionKeepRecent,
        stateDigest: config.stateDigest,
        surfaceCompaction: config.surfaceCompaction,
        spanLedger: config.spanLedger,
        peekIndex: config.peekIndex,
        maxReadChars: config.maxReadChars,
        readFeedbackLimit: config.readFeedbackLimit,
        prefixPolicy: config.prefixPolicy,
        rebaseBudgetRatio: config.rebaseBudgetRatio,
        maxRebasesPerTurn: config.maxRebasesPerTurn,
        maxRebasesPerSession: config.maxRebasesPerSession,
        surfacePolicy: live.surfacePolicy,
        // 0.5.0（§5.2）：代码通道来源判定（apply() 全局探测一次；显式配置绕过探测）
        codeChannelSource: config.codeChannelSource,
        ...(codeSourceProbe !== null ? { codeSource: codeSourceProbe } : {}),
        // 观测预算（D7：只告警不改行为）
        observeBudgetTokens: config.observeBudgetTokens,
        // 0.5.0（附录 A）：taskBudget = 任务级便捷写法的会话级默认
        ...(config.taskBudget === undefined || config.taskBudget === null ? {} : { taskBudget: config.taskBudget }),
        maxParallelToolCalls: live.maxParallelToolCalls,
        maxReentries: live.maxReentries,
        streamIdleTimeoutMs: config.streamIdleTimeoutMs,
        budgetTokens: live.budgetTokens,
        selfReadFeedback: live.selfReadFeedback,
        enableCode: live.enableCode,
        codeTimeoutMs: config.codeTimeoutMs,
        codeQuota: config.codeQuota,
        codeValueInjectLimit: config.codeValueInjectLimit,
        nativeResultLimit: config.nativeResultLimit,
        enablePlan: config.enablePlan,
        segmentMaxChars: config.segmentMaxChars,
        nativeToolSchemas: config.nativeToolSchemas,
        systemPrompt: config.systemPrompt,
        protocolText: config.protocolText,
        invariants: config.invariants,
        // v0.4.1 协议组件化（档位/段增删/自定义追加）：入口宽松表先洗净（未知段告警丢弃），
        // 未知档位归一 full + 告警；protocolText 显式替换仍压过档位与段配置
        protocolLevel: resolveProtocolLevel(config.protocolLevel, warning),
        protocolSections: sanitizeProtocolSections(config.protocolSections, warning),
        protocolAppend: config.protocolAppend,
        // v0.5.0 工具面：reserved-only 默认（第三方工具透传）；profile 仅回退演练（已弃用）
        toolSurface: live.toolSurface,
        nativeTools: config.nativeTools === true,
        callCommand: config.callCommand !== false,
        strictAdmission: config.strictAdmission === true,
      };
      // F6 恢复意图：意图日志端口（fsync 落盘；enableIntents: false 关闭——回退点）。
      // 写前意图在派发前落盘、写后回执落定即记；崩溃后"有意图无回执"= 写入可能已发生。
      const intentsEnabled = config.enableIntents !== false;
      const intentBook = new Map                ();
      const intentFile = sessionId !== undefined && sessionId !== '' ? intentFileOf(stateRoot, sessionId) : undefined;
      const loadIntentState = ()                  => {
        if (intentFile === undefined) return { seq: 0 };
        try {
          return { seq: loadIntentRecords(intentFile).records.length };
        } catch {
          return { seq: 0 };
        }
      };
      const intentSeqState = intentsEnabled ? loadIntentState() : { seq: 0 };
      const driver = new SingleStreamDriver(
        {
          stream: (options) => llm.stream(options),
          executeTools: (input) => tools.execute(input),
          // v0.4.0（P1）：宿主 tools 全量面（resolve/schemas）——方法缺失或解析失败时
          // ToolSurfaceHolder 自行降级 L2（protocol-only，一行注入 + 台账）
          ...(tools === undefined ? {} : { toolsService: tools                                }),
          ...(codeExecutor === undefined ? {} : { executeCode: codeExecutor }),
          // v0.3.1 思考过程实时帧：宿主事件总线在位（cordis ctx.emit）才接线；
          // 发射契约由驱动器保证（revision/index 递增、异常熔断），宿主无监听器时是 no-op。
          ...(typeof (ctx                      ).emit === 'function'
            ? {
                emitHostEvent: (event        , payload         ) => {
                  (ctx                                                      ).emit(event, payload);
                },
              }
            : {}),
          ...(intentsEnabled && intentFile !== undefined
            ? {
                onIntent: (event                                                                                       ) => {
                  intentSeqState.seq += 1;
                  intentBook.set(event.cmdId, intentSeqState.seq);
                  appendIntentRecord(intentFile , { type: 'intent', seq: intentSeqState.seq, at: new Date().toISOString(), sessionId: sessionId ?? '', ...event });
                },
                onIntentReceipt: (event                                                 ) => {
                  const intentSeq = intentBook.get(event.cmdId) ?? -1;
                  intentSeqState.seq += 1;
                  appendIntentRecord(intentFile , { type: 'receipt', seq: intentSeqState.seq, at: new Date().toISOString(), intentSeq, ok: event.ok, ...(event.detail === undefined ? {} : { detail: event.detail }) });
                },
                // v0.4.3（P0-6⑤）：前缀破坏收场时的最小对账——pending 意图整批标 unknown
                //（只解除恢复锁，不重放工具、不声称回滚；完整三态在 P0-8/0.5.1）。
                reconcilePendingIntents: (cause        ) => ({ acked: reconcilePendingIntents(intentFile , cause, intentSeqState) }),
              }
            : {}),
          events: createSessionEventWriter(session, () => currentDriverRef.driver?.modelSource()),
          onWarning: warning,
        },
        cfg,
      );
      currentDriverRef.driver = driver;
      // K2：会话工作区解析（tf-code resolve 透传用）。会话 header.cwd（会话原始目录）
      // 优先，缺省回退宿主 workingDirectory 服务的部署默认目录；两者都不可得则不传，
      // 由宿主按自己的默认语义解析。插件不复制宿主的优先级规则。
      const headerCwd = (session                                              )?.header?.cwd;
      const workingDirectory = getService                               (ctx, 'workingDirectory');
      const resolvedCwd = typeof headerCwd === 'string' && headerCwd !== ''
        ? headerCwd
        : (workingDirectory?.defaultDirectory !== undefined ? workingDirectory.defaultDirectory : undefined);
      driver.setSessionCwd(resolvedCwd);
      // 0.5.0（S5 / §2.4 接缝 5）：systemPrompt.context 快照贡献——代码通道的唯一注入通道
      //（不接管 loop 时无法在流内插消息），宿主 loop 把贡献渲染成 runtime-context 快照并
      // supersede 旧快照（U10 探针面；服务缺席 = 静默跳过，标准通道走回灌不受影响）。
      const systemPromptService = getService                                              (ctx, 'systemPrompt');
      if (systemPromptService !== undefined && typeof systemPromptService.context === 'function') {
        driver.setRuntimeContextPort((text        ) => {
          systemPromptService.context ({ name: 'streamAgent.state', text });
        });
      }
      // F6 resume 停机核对：创建/恢复会话时检查"有意图无回执"；存在即置位停机
      // （不发请求、零注入、不自动重放）。resumeIntentPolicy: 'ignore' 可跳过（回退点）。
      if (intentsEnabled && intentFile !== undefined && config.resumeIntentPolicy !== 'ignore') {
        try {
          const { records, badLines } = loadIntentRecords(intentFile);
          const pending = pendingIntents(records).filter((p) => p.state === 'pending');
          if (pending.length > 0) {
            const listing = pending.slice(0, 8).map((p) => `${p.intent.op} ${p.intent.path} (cmd=${p.intent.cmdId} fp=${p.intent.fingerprint})`).join('; ');
            driver.setResumeHalt(`${pending.length} 条写前意图无回执（${listing}${pending.length > 8 ? ' …' : ''}）${badLines > 0 ? `；另有 ${badLines} 行坏记录` : ''}`);
            warning(`[stream-loop] F6 resume 停机核对：会话 ${sessionId} 有 ${pending.length} 条写前意图无回执（写入可能已发生）——不自动重放，请人工核对（CLI: dsh-stream-agent intents）`);
          }
        } catch (error) {
          warning('F6 意图日志读取失败（fail-open：不做停机核对，继续会话）', error);
        }
      }
      return { driver };
    },
    onWarning: warning,
  });

  const agents = getService                                                                    (ctx, 'agents');
  if (agents === undefined || typeof agents.setFactory !== 'function') {
    throw new Error('[stream-loop] ctx.agents.setFactory 不可用：无法接管 agent 创建（需要 dsh-agent 服务在位）');
  }
  // 0.5.0（§6.2）：loop 接管与让位——setFactory 全局单槽，占用即抛错。
  //   takeoverOnConflict='degrade'（默认）：不接管，转 sidecar（控制栏状态与诊断可用，
  //   上下文治理全部关闭）；'refuse'：抛出错误明确冲突。两种处置都不静默（兼容矩阵：
  //   "宿主 + 另一 loop 插件 → 降级为 sidecar 并报冲突，无静默覆盖"）。
  const profileName = resolveProfileName(ctx);
  let detachFactory                          ;
  let degradedSidecar = false;
  try {
    detachFactory = agents.setFactory(factory);
  } catch (error) {
    if (config.takeoverOnConflict === 'refuse') {
      throw doubleLoopError(error, profileName);
    }
    // degrade：让位为 sidecar。owner = 占位者（控制栏显示"未接管：已被 <X> 接管"）。
    degradedSidecar = true;
    const owner = resolveFactoryOwner(error, profileName);
    markDegrade(owner);
    warning(
      `[stream-loop] loop 接管失败（takeoverOnConflict=degrade）：转 sidecar 模式——`
      + `控制栏状态与诊断可用，上下文治理（压缩/摘要/度量）全部关闭。占位者=${owner}。`
      + `原始错误：${detailString(error)}`,
      error,
    );
  }
  if (!degradedSidecar) {
    // 接管事实登记：控制栏据此写"接管生效"或"未接管"；owner = 本插件（0.5.0 增字段）
    markTakeover(`${control.channel}/${control.tier}`, 'stream-agent');
  }

  // 桌面控制页的宿主面：读状态 / 切通道 / 切档位 / 切预算 / 切语言（旧 setMode 保留为别名）。
  // UI 是独立子包（ui/），经同源 HTTP 路由调用本服务；服务不存在时 UI 降级为只读诊断。
  const controlStatus = ()                          => {
    const live = resolveEffective();
    const persisted = readPersistedControl(config.stateDir);
    return {
      version: VERSION,
      takeover: !degradedSidecar,
      takeoverOwner: takeover().owner,
      degradedSidecar,
      channel: control.channel,
      channelSource: control.channelSource,
      channelLocked: control.channelSource === 'config' || control.channelSource === 'env',
      tier: control.tier,
      tierSource: control.tierSource,
      tierLocked: control.tierSource === 'config' || control.tierSource === 'env',
      aliased: control.aliased,
      legacyMode: control.legacyMode,
      lang: control.lang,
      langSource: control.langSource,
      langLocked: control.langSource === 'config' || control.langSource === 'env',
      codeSource: codeSourceProbe,
      takeoverPriority: config.takeoverPriority ?? 100,
      effective: {
        selfReadFeedback: live.selfReadFeedback,
        enableCode: live.enableCode === undefined ? false : live.enableCode,
        persistFallback: live.persistFallback,
        maxParallelToolCalls: live.maxParallelToolCalls,
        maxReentries: live.maxReentries,
        budgetTokens: live.budgetTokens ?? null,
        surfacePolicy: live.surfacePolicy,
        toolSurface: live.toolSurface,
        ...(currentDriverRef.driver?.runtimeStatus().effective
          ?? { maxSteps: getTier(control.tier).values.maxSteps, maxInputTokens: getTier(control.tier).values.maxInputTokens }),
      },
      // 0.5.0：运行时状态（本任务 N / 换基 / 重复取回 / 摘要段；控制栏底部状态行同源）
      runtime: currentDriverRef.driver?.runtimeStatus() ?? null,
      // v0.4.2：运行时缓存口径（控制页"缓存命中"行；当前会话无活动驱动器时为 null，
      // 客户端隐藏该行——离线/mock 适配器没有缓存数据，不渲染成 0%）。
      cache: currentDriverRef.driver?.cacheStats() ?? null,
      channels: publicChannelCatalog(),
      tiers: publicTierCatalog(),
      legacyModes: publicLegacyModeCatalog(),
      updatedAt: persisted.updatedAt ?? null,
      stateFile: control.file,
    };
  };
  const applyChannel = (next        )                                                                       => {
    if (!isChannelId(next)) return { ok: false, code: 'invalid-channel' };
    if (control.channelSource === 'config' || control.channelSource === 'env') return { ok: false, code: 'locked' };
    control.channel = next;
    control.channelSource = 'runtime';
    // 会话内切换走驱动器（任务边界生效 + 计划性换基记账）；落盘供新会话继承
    const driverResult = currentDriverRef.driver?.setChannel(next) ?? { ok: true };
    let persisted = true;
    try {
      writePersistedControl({ channel: control.channel, tier: control.tier, lang: control.lang }, config.stateDir);
      control.channelSource = 'file';
    } catch (error) {
      persisted = false;
      control.channelSource = 'runtime';
      warning(`控制栏通道已在本进程生效，但落盘失败（重启后会回到旧值）：${control.file}`, error);
    }
    if (!driverResult.ok) {
      return { ok: false, code: driverResult.code, detail: driverResult.detail, persisted };
    }
    if (!degradedSidecar) markTakeover(`${control.channel}/${control.tier}`, 'stream-agent');
    return { ok: true, persisted };
  };
  const applyTier = (next        )                                                      => {
    if (!isTierId(next)) return { ok: false, code: 'invalid-tier' };
    if (control.tierSource === 'config' || control.tierSource === 'env') return { ok: false, code: 'locked' };
    control.tier = next;
    control.tierSource = 'runtime';
    const driverResult = currentDriverRef.driver?.setTier(next) ?? { ok: true };
    let persisted = true;
    try {
      writePersistedControl({ channel: control.channel, tier: control.tier, lang: control.lang }, config.stateDir);
      control.tierSource = 'file';
    } catch (error) {
      persisted = false;
      control.tierSource = 'runtime';
      warning(`控制栏档位已在本进程生效，但落盘失败（重启后会回到旧值）：${control.file}`, error);
    }
    if (!driverResult.ok) return { ok: false, code: driverResult.code, persisted };
    if (!degradedSidecar) markTakeover(`${control.channel}/${control.tier}`, 'stream-agent');
    return { ok: true, persisted };
  };
  const applyBudget = (budget                                                )                                                  => {
    return currentDriverRef.driver?.setBudget(budget)
      ?? { ok: false, code: 'no-driver', detail: '当前没有活动会话驱动器' };
  };
  const applyMode = (next        )                                                                                          => {
    // 0.5.x 别名（0.6.0 移除）：旧模式值 → (channel, tier) 两路应用 + warn。
    if (!isLegacyModeId(next)) return { ok: false, code: 'invalid-mode' };
    if (control.channelSource === 'config' || control.channelSource === 'env'
      || control.tierSource === 'config' || control.tierSource === 'env') {
      return { ok: false, code: 'locked' };
    }
    const mapped = resolveLegacyMode(next);
    warning(`[stream-loop] setMode("${next}") 是旧模式值，已按别名映射为 channel=${mapped.channel}/tier=${mapped.tier}（0.5.x 保留别名，0.6.0 移除）`);
    const channelResult = applyChannel(mapped.channel);
    if (!channelResult.ok) return { ...channelResult, aliased: true };
    const tierResult = applyTier(mapped.tier);
    return { ok: tierResult.ok, ...(tierResult.ok ? {} : { code: tierResult.code }), persisted: channelResult.persisted && tierResult.persisted, aliased: true };
  };
  const applyLang = (next        )                                                      => {
    if (!isLang(next)) return { ok: false, code: 'invalid-lang' };
    if (control.langSource === 'config' || control.langSource === 'env') return { ok: false, code: 'locked' };
    control.lang = next;
    try {
      writePersistedControl({ channel: control.channel, tier: control.tier, lang: control.lang }, config.stateDir);
      control.langSource = 'file';
      return { ok: true, persisted: true };
    } catch (error) {
      control.langSource = 'runtime';
      warning(`控制栏语言已在本进程生效，但落盘失败（重启后会回到旧值）：${control.file}`, error);
      return { ok: true, persisted: false };
    }
  };
  // 老式测试桩可能没有 provide（只挂服务不建容器）；真实 Cordis 一定有。
  // 注册失败也不能影响 loop 本体：桌面控制页只是可选面，降级为只读即可。
  if (typeof ctx.provide === 'function') {
    try {
      ctx.provide('streamAgentRuntime', {
        status: controlStatus,
        // 0.5.0：三个新方法（§4.6 会话级落点）；setMode 保留为别名（0.6.0 移除）
        setChannel: applyChannel,
        setTier: applyTier,
        setBudget: applyBudget,
        setMode: applyMode,
        setLang: applyLang,
      });
    } catch (error) {
      warning('streamAgentRuntime 服务注册失败：桌面控制页降级为只读（loop 本体不受影响）', error);
    }
  }

  if (config.announceTakeover === true) {
    const codeState = degradedSidecar
      ? 'loop=sidecar(degraded)'
      : `channel=${control.channel} source=${codeSourceProbe ?? '-'} tier=${control.tier}`;
    console.error(`[stream-loop] ${degradedSidecar ? 'TAKEOVER-DEGRADED: sidecar mode（另一 loop 插件已接管）' : 'TAKEOVER-ACTIVE: agent factory registered via setFactory (built-in agent-loop must be disabled by profile patch)'} · ${codeState} · executor=${codeExecutor === undefined ? 'native' : 'bridge-available'} · priority=${config.takeoverPriority ?? 100} · profile=${profileName}`);
  }

  // 会话投影注册（桌面端硬依赖，内建 agent-loop 在 Service.init 注册——dsh-agent-loop rc.3:50110）：
  // 客户端模型选择器的 projected 数据面 = 服务端 modelSelection 投影；缺失时
  // dsh-client-ui-model-selection 的 syncInputs 永远停在 status:"loading"（"正在加载模型…"），
  // 会话列表/写作工具等也读该投影族。经宿主 loader 取同源 @deepseek-ai/dsh-agent 的导出注册。
  // fail-open（红线 5）：服务/模块/定义任一不可达 → 告警不静默，headless 行为不变。
  const sessionProjections = getService                                                      (ctx, 'sessionProjections');
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
      clearTakeover();
    } catch (error) {
      warning('[stream-loop] factory 卸载失败', error);
    }
  };
  ctx.effect?.(() => dispose, 'streamAgent.setFactory()');
  // Cordis 函数式插件契约：返回值必须可调用（cordis-compat.ts 缺陷 2）
  return asPluginEffect({ factory, dispose });
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

/** S3：解析当前 profile 名（宿主 profileContext.dir 的 basename；测试桩/缺失时回退 env 与 unknown）。 */
function resolveProfileName(ctx         )         {
  const dir = (ctx                                       ).get?.('profileContext')                                 ;
  const raw = typeof (dir                                 )?.dir === 'string' ? (dir                   ).dir : undefined;
  if (raw !== undefined && raw !== '') {
    const parts = raw.replace(/\\/g, '/').split('/').filter((p) => p !== '');
    const last = parts[parts.length - 1];
    if (last !== undefined && last !== '') return last;
  }
  const env = typeof process !== 'undefined' ? process.env['DSH_PROFILE'] : undefined;
  return env !== undefined && env !== '' ? env : 'unknown';
}

/** S3：把宿主的 setFactory 冲突裸错转换为 E_DOUBLE_LOOP 具名失败（fail-fast，不重试不静默）。 */
function doubleLoopError(original         , profile        )        {
  const detail = original instanceof Error ? original.message : String(original);
  const error = new Error(
    `[E_DOUBLE_LOOP] 双 loop 冲突，接管失败：profile=${profile} 已注册了另一个 agent factory`
    + `（来源通常为内建 @deepseek-ai/dsh-agent-loop 或另一个 stream 实例）；entry=stream-agent。`
    + ` 原始错误：${detail}`
    + ` 处置建议：不要把本插件装进已有内建 loop 的 profile（web/desktop 等）；`
    + `在专用 profile（如 profiles/stream 模板）中安装，或确认该 profile 的 bundle/patch 已停用`
    + ` @deepseek-ai/dsh-agent-loop（"- id: agent-loop" + "disabled: true"）。`,
  );
  error.name = 'E_DOUBLE_LOOP';
  return error;
}

/**
 * 0.5.0（§6.2）：从 setFactory 冲突里解析占位者（控制栏"未接管：已被 <X> 接管"）。
 * 宿主裸错通常不含占位者名字——按可读性降级：错误消息内提到的已知 loop 名 → 该名；
 * 否则 profile 名；再否则 unknown。
 */
function resolveFactoryOwner(error         , profile        )         {
  const text = detailString(error);
  for (const candidate of ['dsh-agent-loop', 'agent-loop', 'dsh-stream-agent', 'stream-agent']         ) {
    if (text.toLowerCase().includes(candidate)) return candidate;
  }
  return profile !== '' && profile !== 'unknown' ? `profile:${profile}` : 'unknown';
}

/** 诊断追踪（STREAM_LOOP_DEBUG=1 时向 stderr 打里程碑；生产默认关闭，不产生噪音）。 */
export function debugTrace(milestone        , detail          )       {
  if (process.env.STREAM_LOOP_DEBUG !== '1') return;
  console.error(`[stream-loop:debug] ${milestone}${detail === undefined ? '' : ` :: ${detailString(detail)}`}`);
}
