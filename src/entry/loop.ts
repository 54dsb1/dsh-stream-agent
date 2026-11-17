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
import { TfStreamParser, splitEditBody } from '../kernel/parser.ts';
import type { TfCommand, ParserEvent } from '../kernel/parser.ts';
import { ContextRenderer, renderHash } from '../kernel/render.ts';
import type { RenderMessage } from '../kernel/render.ts';
import { ObservationLedger } from '../kernel/obs.ts';
import type { ObservationResult } from '../kernel/obs.ts';
import {
  appendLedgerRecord,
  createJsonlPersistence,
  ledgerFileOf,
  loadLedgerRecords,
  resolveStateDir,
  withEventCapture,
} from './json-persistence.ts';
import type { FileLedgerFallback } from './json-persistence.ts';
import { createCodeExecutor, DEFAULT_CODE_QUOTA, looksLikePtcRuntime } from './ptc-bridge.ts';
import type { CodeExecutor, CodeQuota, SandboxFacts } from './ptc-bridge.ts';
import { asPluginEffect, getService } from './cordis-compat.ts';
import { readPersistedControl, resolveControlState, writePersistedControl } from './control-state.ts';
import type { ControlStateWithSource } from './control-state.ts';
import { appendIntentRecord, intentFileOf, loadIntentRecords, pendingIntents } from './intent-log.ts';
import { clearTakeover, markTakeover } from './takeover-registry.ts';
import { ToolSurfaceHolder, degradedLine } from './tool-surface.ts';
import type { SurfaceProfile, ToolSurface, ToolsServiceLike } from './tool-surface.ts';
import { isModeId, modeConfig, publicModeCatalog } from '../kernel/modes.ts';
import { isLang } from '../kernel/control-bar.ts';
import { VERSION } from '../version.ts';

// ---------------------------------------------------------------------------
// ① 流契约镜像（dsh-llm/lib/types/types.d.ts 与 dsh-tools/lib/types/executor.d.ts，rc.1 npm）
// ---------------------------------------------------------------------------

/**
 * 镜像 types.d.ts:138-156 FinishReasonMap。
 * 真实宿主的 error finish 把失败事实放在 `failure`（rc.3 实测：
 * {kind:'error', failure:{message, code}}）；mock 05 号用的是平铺 {message, code}。
 * 两种形状都接受，读取统一走 finishCode/finishMessage。
 */
export type FinishReasonLike =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; message?: string; code?: string }
  | {
      kind: 'error';
      message?: string;
      code?: string;
      failure?: { message: string; code: string; status?: number };
    };

/** error finish 的机器码（宿主形状 failure.code 优先，mock 平铺形状 code 兜底）。 */
export function finishCode(finish: FinishReasonLike): string {
  if (finish.kind !== 'error') return finish.kind;
  return finish.failure?.code ?? finish.code ?? 'UNKNOWN';
}

/** error/aborted finish 的可读消息。 */
export function finishMessage(finish: FinishReasonLike): string {
  if (finish.kind === 'error') return finish.failure?.message ?? finish.message ?? 'error';
  if (finish.kind === 'aborted') return finish.message ?? 'aborted';
  return finish.kind;
}

/** 镜像 types.d.ts:458-488 StreamChunk（本驱动消费的全部变体） */
export type StreamChunkLike =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: { type: string; text?: string; id?: string; name?: string; arguments?: string } }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'finish'; reason: FinishReasonLike };

/** 镜像 types.d.ts:538-580 GenerateOptions（驱动器发出的请求形状） */
export interface StreamRequestOptions {
  provider: string;
  model: string;
  reasoningEffort?: string;
  messages: readonly { role: string; content: readonly { type: 'text'; text: string }[] }[];
  /** v0.4.0 原生通道（P1）：nativeTools 开启时携带冻结工具面的 schema（GenerateOptions.tools 直通）。
   *  默认关闭（§15：默认文本）——可达性走 tf-call，不为 schema 付每请求 token。 */
  tools?: readonly { name: string; description: string; parameters: Record<string, unknown> }[];
  signal?: AbortSignal;
  sessionId?: string;
}

/** 镜像 executor.d.ts:16-45 ToolBatchInput（probe B 实测形状；单命令批 = calls 长度 1） */
export interface ToolBatchInputLike {
  calls: readonly { type: 'tool-call'; id: string; name: string; arguments: string }[];
  signal: AbortSignal;
  maxParallelToolCalls?: number;
  /** 当前 agent（fs 工具的路径解析读 exec.agent.session；独立批不带 agent 会
   * "Cannot read properties of undefined (reading 'session')"——2026-11-15 真连 W1 教训） */
  agent?: unknown;
  toolSet?: unknown;
  log?: { turn: number; step: number };
}

/** 镜像 executor.d.ts:47-56 ToolBatchResult（probe B 实测返回结构） */
export interface ToolBatchResultLike {
  results: readonly { callId: string; result: { content: unknown; isError: boolean } }[];
  additionalContexts?: readonly unknown[];
  concluded?: boolean;
}

// ---------------------------------------------------------------------------
// 驱动器配置与端口
// ---------------------------------------------------------------------------

/** tf-* 命令 → 原生工具的映射（信息型 read/bash 走原生阻塞通道，写类走单流通道） */
export interface ToolMapping {
  /** 返回原生工具名与参数；返回 null = 该命令由驱动器内部处理（tf-peek / tf-final） */
  toToolCall(cmd: TfCommand): { name: string; arguments: Record<string, unknown> } | null;
}

export const DEFAULT_TOOL_MAPPING: ToolMapping = {
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
        const args: Record<string, unknown> = { file_path: cmd.attrs['path'] ?? '' };
        if (offset !== undefined && /^\d+$/.test(offset)) args['offset'] = Number(offset);
        if (limit !== undefined && /^\d+$/.test(limit)) args['limit'] = Number(limit);
        return { name: 'read', arguments: args };
      }
      case 'tf-edit': {
        // F1：精确替换映射宿主 edit（old → new；replace_all=false 时宿主要求恰好出现一次）。
        // body 用 OLD/NEW 标记行分隔两段字面量；解析失败回结构化失败，绝不静默改成全文重写。
        const split = splitEditBody(cmd.body ?? '');
        if (split === null) return null;
        const args: Record<string, unknown> = {
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
        const args: Record<string, unknown> = { pattern: cmd.attrs['pattern'] ?? '' };
        if (cmd.attrs['path'] !== undefined && cmd.attrs['path'] !== '') args['path'] = cmd.attrs['path'];
        if (cmd.attrs['include'] !== undefined && cmd.attrs['include'] !== '') args['include'] = cmd.attrs['include'];
        return { name: 'grep', arguments: args };
      }
      case 'tf-glob': {
        const args: Record<string, unknown> = { pattern: cmd.attrs['pattern'] ?? '' };
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
        const question: Record<string, unknown> = {
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

export interface StreamDriverConfig {
  provider: string;
  model: string;
  reasoningEffort?: string;
  /** 独立命令并行度上限（可配，默认 3 —— 分派 06 硬性要求 1） */
  maxParallelToolCalls?: number;
  /** 最大重入次数（防震荡护栏；超出 → turn 以 blocked 终止并如实记录） */
  maxReentries?: number;
  /** 流空闲看门狗：流在此时长内无任何 chunk → abort（fault-timeout 路径） */
  streamIdleTimeoutMs?: number;
  /** 任务级 token 预算（O5 阶梯分母；缺省 = 阶梯关闭，恒为 normal 档） */
  budgetTokens?: number;
  /** 饥饿防线阈值（透传 obs.ts） */
  starvationThreshold?: number;
  /** 原生工具 schema 文本（双通道：声明给模型的可用原生工具；缺省 = 协议独占） */
  nativeToolSchemas?: string;
  /** 系统提示 / 协议文本 / 不变量覆盖（测试注入用；生产用默认） */
  systemPrompt?: string;
  protocolText?: string;
  invariants?: string;
  toolMapping?: ToolMapping;
  /** 自写回验策略（修复限制 1：写批任务 token 偏重）。'receipt'（默认）=
   *  tf-read 命中本任务 tf-write 已写过的路径时只注入回执（行数 + 内容指纹），
   *  不重复回灌全文——全文本就在模型上下文里，掐断"写→读回验"循环；
   *  'full' = v0.1 行为（完整反馈，读外部文件仍走此路径）。 */
  selfReadFeedback?: 'receipt' | 'full';
  /** tf-code 程序化通道（PTC 桥接）。K1（0.3.0）：**默认关闭**——只有显式
   *  `enableCode: true` 且 executeCode 端口在位才启用（协议文本才声明 tf-code 段）；
   *  缺省/false 都关闭。不做会话级动态开关（协议段构造期冻结，动态切换会破坏前缀单调）。 */
  enableCode?: boolean;
  /** tf-code 默认超时（毫秒）；缺省 = 宿主 provider 默认（Node 后端 120s，上限 600s）。 */
  codeTimeoutMs?: number;
  /** tf-code 协议段覆盖（缺省 DEFAULT_CODE_PROTOCOL_SECTION；仅通道启用时追加） */
  codeProtocolText?: string;
  /** v0.4.0 工具面档位（P1）：'core' | 'standard'（默认）| 'full' | 'off'（0.3.x 回退点）。
   *  只影响原生 tools 声明面与降级语义；tf-call 可达性始终是冻结面的全量。 */
  toolSurface?: SurfaceProfile;
  /** v0.4.0 原生通道（P1）：请求携带 tools schema。默认 false（§15 默认文本）——
   *  schema 的每请求 token 成本 > tf-call 的逐调用成本；开启场景 = 模型对原生
   *  tool_call 的结构化收益优先（provider 原生并行/错误形状）。 */
  nativeTools?: boolean;
  /** v0.4.0 tf-call 通用调用通道（G2：命令表净增 1）。默认 true；toolSurface=off 强制关。 */
  callCommand?: boolean;
  /** v0.4.0 tf-call 协议段覆盖（缺省 DEFAULT_CALL_PROTOCOL_SECTION；仅通道启用时追加） */
  callProtocolText?: string;
  /** v0.4.0 toolSet 准入（R5：beta 缺省 false——toolSet 只用于 schemas 视图，不传 execute）。
   *  true = execute 带 toolSet（when 门控收紧，P6 复跑后再默认开）。 */
  strictAdmission?: boolean;
  /** K5：tf-code 配额三项硬限制（子调用次数 / 输出字节 / 墙钟毫秒）；缺省 DEFAULT_CODE_QUOTA。 */
  codeQuota?: CodeQuota;
  /** F3：tf-code 首成功/变化结果的完整注入上限（字符）；≤ 上限整值注入，超限转骨架 + 句柄。
   *  仅通道显式开启时生效；缺省 DEFAULT_CODE_VALUE_INJECT_LIMIT。 */
  codeValueInjectLimit?: number;
  /** F4：原生 tool_call 结果的单块注入上限（字符）；仅声明了 nativeToolSchemas 时生效。
   *  超限块转骨架 + 句柄（obs 登记，可 tf-peek 取回）；缺省 DEFAULT_NATIVE_RESULT_LIMIT。 */
  nativeResultLimit?: number;
  /** F5：计划与验收（tf-plan + accepts 回执判定 + tf-final 过早拦截）。默认 true；
   *  false = 关闭（回退点）：tf-plan 命令级失败，accepts 属性忽略，tf-final 不做验收校验。 */
  enablePlan?: boolean;
  /** F7 长会话段边界：追加区超过该字符数时，在新回合开始处整块丢弃旧段（保留当前任务块起
   *  的所有块），被丢弃原文句柄化可回取。0/负数 = 关闭（回退点）。缺省 DEFAULT_SEGMENT_MAX_CHARS。 */
  segmentMaxChars?: number;
}

export interface DriverPorts {
  /** 发起一次流式请求（真实宿主 = ctx.llm.stream；离线 = normalizeStreamShim 包裹的 mock adapter） */
  stream(options: StreamRequestOptions): AsyncIterable<StreamChunkLike>;
  /** 工具执行（真实宿主 = ctx.tools.execute 单命令批；离线 = 沙箱执行器） */
  executeTools(input: ToolBatchInputLike): Promise<ToolBatchResultLike>;
  /** 每个工具调用落定（成功或失败）后回调一次 —— mock waitTools 的回灌信号源（05 号交接 §7.1） */
  onToolSettled?: () => void;
  /** 会话事件写入（真实宿主才提供；离线测试缺省） */
  events?: TurnEventWriter;
  /** 动作门（kernel/gate.ts 的 ActionGate；缺省 = 不做准入） */
  gate?: GatePort;
  /** tf-code 程序化执行通道（PTC 桥接；缺省 = tf-code 命令级失败并引导改道） */
  executeCode?: CodeExecutor;
  /** F6 恢复意图：写前意图落盘（实现在 fsync 意图日志；缺省 = 不落盘，F6 关闭——回退点）。
   *  在变更类命令（tf-write/tf-edit/tf-append）派发到宿主工具**之前**调用。 */
  onIntent?: (intent: { cmdId: string; op: 'write' | 'edit' | 'append'; path: string; fingerprint: string }) => void;
  /** F6 写后回执：变更类命令落定（成功或失败）即调用；与 onIntent 按 cmdId 关联。 */
  onIntentReceipt?: (receipt: { cmdId: string; ok: boolean; detail?: string }) => void;
  /** v0.3.1 思考过程实时帧：向宿主事件总线发 agent/assistant-stream 帧（桌面端
   *  思考过程 live 显示的数据源；真实宿主 = ctx.emit）。缺省 = 不发（headless/离线），
   *  桌面端只看落盘消息（0.3.0 行为）。发射异常由驱动器捕获并熔断（fail-open）。 */
  emitHostEvent?: (event: string, payload: unknown) => void;
  /** v0.4.0 工具面（P1）：宿主 tools 服务的完整面（resolve/schemas/execute）。
   *  缺省 = 无宿主面 → ToolSurfaceHolder 返回 undefined（L2 protocol-only，0.3.x 行为）。 */
  toolsService?: ToolsServiceLike;
  /** 驱动器自身异常/账本落盘失败的告警出口（红线 5：不许静默） */
  onWarning?: (message: string, detail?: unknown) => void;
}

/**
 * 会话事件写入面（真实宿主路径专用；事件形状逐字段镜像 dsh-agent-loop/lib/index.js
 * 的 append 调用 :731/:757/:781/:819/:891-955，turn/end reason 形状镜像 :747-821）。
 */
export interface ToolCallAdvertisement {
  id: string;
  name: string;
  arguments: string;
}

export interface TurnEventWriter {
  turnStart(turn: number): void;
  stepStart(turn: number, step: number): void;
  /** v0.3.1：返回落盘结算信息（事件类型 + seq），供 assistant-stream end 帧配对。
   *  无落盘（写入失败/无会话）返回 undefined —— 驱动器按 abandoned 收束实时帧。 */
  assistantMessage(turn: number, step: number, text: string, info: {
    finish: FinishReasonLike;
    usage?: { inputTokens: number; outputTokens: number };
    /** v0.3.1：模型思考过程（reasoning delta 拼接）。非空时随本条消息落成
     *  `{type:'reasoning', text}` 内容块（块序 = assistant 消息首位，镜像内建
     *  BlockAssembler 输出序），桌面端据此渲染思考过程行。 */
    reasoning?: string;
    /** 原生 tool_call 通道（v0.3.0）：随本条 assistant 消息一并广告的 tool-call 块。
     *  v4 会话格式要求每个 tool/call 都能在同一 turn/step 的 assistant/message 里
     *  找到同名同参的 tool-call 块，缺失会让整条日志在读取时被判 corrupt。 */
    toolCalls?: readonly ToolCallAdvertisement[];
  }): { eventType: 'assistant/message' | 'assistant/attempt'; seq?: number } | undefined;
  stepEnd(turn: number, step: number): void;
  turnEnd(turn: number, reason: TurnEndReason): void;
  /** 任务最终答案（最后一个 ok tf-final 的 summary）落成会话最终 assistant 消息
   * （headless 输出与评测 checks 都消费最后一条 assistant 消息；缺省 = 流原文即答案） */
  finalAnswer?(turn: number, step: number, text: string): void;
  /** 原生工具批次执行时传给 executeTools 的 log（tools 管线用它落 tool/call + tool/result） */
  toolLog(turn: number, step: number): { turn: number; step: number } | undefined;
  /** v0.3.0（会话格式修复）：把即将派发的工具调用**先**广告成同步骤 assistant/message 的
   *  tool-call 块，再让宿主工具管线落 tool/call。宿主的 v4 格式校验要求
   *  `assistant/message(content: tool-call) → tool/call → tool/result` 三段齐全；
   *  只有 tool/call 的日志在读取时抛 `tool/call <id> has no advertised tool lifecycle`
   *  → 整个会话被判 corrupt → 桌面端"历史加载失败"。 */
  advertiseToolCalls?(turn: number, step: number, calls: readonly ToolCallAdvertisement[]): void;
  /** v0.3.0：广告已落、派发却没产出 tool/call + tool/result 时补一条闭合事件，
   *  否则 step/end 会留下未解调用（同样 corrupt）。未开始的调用写宿主唯一接受的
   *  TOOL_NOT_STARTED 修复形状；已开始但无结果的写普通错误结果。已有 result 不重复写。 */
  repairToolCall?(turn: number, step: number, callId: string): void;
}

/** kernel/gate.ts ActionGate.admit 的 duck-type 面（04 号对接面备忘） */
export interface GatePort {
  admit(req: { action: string; taskId?: string; detail?: string }): Promise<
    { verdict: 'allow'; reversibility: string } | { verdict: 'deny'; reason: string; detail: string }
  >;
}

export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'blocked'; detail?: string }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; reason?: string }
  | { kind: 'error'; error: { message: string; code: string } };

// ---------------------------------------------------------------------------
// ledger 记录（探针 C 定案：tf-* 协议状态落 plugin:tf-agent/<record> 私有记录）
// ---------------------------------------------------------------------------

export type DriverRecord =
  | { seq: number; kind: 'request'; turn: number; step: number; provider: string; model: string; level: BudgetLevel; stableHash: string; renderHash: string; injectionBlocks: number }
  | { seq: number; kind: 'usage'; turn: number; inputTokens: number; outputTokens: number }
  | { seq: number; kind: 'command'; id: string; name: string; status: 'pending' | 'dispatched' | 'ok' | 'failed' | 'rejected'; detail?: string; handle?: string; infoGain?: string }
  | { seq: number; kind: 'malformed'; raw: string; reason: string }
  | { seq: number; kind: 'truncated'; raw: string; reason: string }
  | { seq: number; kind: 'cycle'; cycle: readonly string[] }
  | { seq: number; kind: 'final'; summary?: string }
  | { seq: number; kind: 'fault'; fault: string; detail?: string }
  | { seq: number; kind: 'observation'; handle: string | null; key: string; infoGain: string; reason: string }
  /** K2 沙箱事实记账（tf-code 每次运行一条；宿主未报告的字段缺省） */
  | { seq: number; kind: 'sandbox'; cmdId: string; mode?: string; enforcement?: string; deniedCount: number }
  /** F5 计划与验收（tf-plan 每次声明/修订一条） */
  | { seq: number; kind: 'plan'; revision: number; open: number; total: number }
  /** F5 验收项验证回执（accepts 命中且命令成功时一条） */
  | { seq: number; kind: 'plan-accept'; acceptId: string; cmdId: string; evidence: string }
  | { seq: number; kind: 'turn-end'; reason: TurnEndReason };

/** plugin record 通道（真实宿主）。类型语法 plugin:tf-agent/<record>（dsh-session types.d.ts:527）。 */
export type TfAgentRecordType = 'plugin:tf-agent/command' | 'plugin:tf-agent/final' | 'plugin:tf-agent/fault' | 'plugin:tf-agent/step' | 'plugin:tf-agent/plan' | 'plugin:tf-agent/intent';

export interface LedgerSink {
  record(type: TfAgentRecordType, data: unknown): void;
}

export type BudgetLevel = 'normal' | 'high-only' | 'final-only';

/**
 * 不可重试的流错误码（LLM 配置/凭据层故障）：重入必然重演，fail-fast 终止回合，
 * 不烧重入预算（探针 A 实测 MISSING_CREDENTIAL 即此层错误）。
 */
const NON_RETRYABLE_STREAM_CODES: ReadonlySet<string> = new Set([
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
<tf-edit path="src/app.ts" id="e1" depends_on="r1">
<<<<<<< OLD
被替换的原文（精确字面量，全文唯一；不做模糊匹配）
=======
替换后的新文
>>>>>>> NEW
</tf-edit>
<tf-append path="notes.md" id="a1" anchor="锚点原文（可选；缺省=追加到文件末尾）">
追加正文（原样输出，直到闭合标签；不改既有内容）
</tf-append>
<tf-grep pattern="正则" path="src" include="*.ts" id="g1"/>
<tf-glob pattern="**/*.md" id="gl1"/>
<tf-bash cmd="命令行" id="b1"/>
<tf-peek handle="obs:read:c3@v1" from_line="10" to_line="20" id="p1"/>
<tf-final id="f1" summary="一句话完成说明"/>

（改既有文件用 tf-edit（精确替换）或 tf-append（只追加），不要整文件重写；
找内容用 tf-grep（回匹配行）/tf-glob（回路径），不要用 tf-bash 调 shell 搜索，
也不要把搜索当"读文件"用——grep 结果超长会截断并提示 tf-peek。）

（tf-read 可选 offset/limit：1 基行号起点与行数，大文件按行段取，省 token。）

（收尾纪律：命令全部闭合后，本流必须以 tf-final 结束；写完文件、执行完命令不等于任务结束。）

## 计划与验收（复合任务推荐）
<tf-plan id="p1">
- [a1] 验收项描述
- [a2] 验收项描述
</tf-plan>
- 计划只声明一次；修订时重发 tf-plan（新计划整体替换旧计划，请求里只注差分）。
- 完成某验收项对应的命令时，在该命令上加 accepts 属性，如 <tf-write path="out.md" id="w1" accepts="a1">...</tf-write>。
- 全部验收项都有命令成功回执后 tf-final 才会通过；缺项/未验证会被判为过早并注入提示——
  模型自述"已完成"不构成验收证据。

## 结果获取（关键）
tf-read 首次/内容变化的结果会完整注入下一请求（超长文件截断为中段省略，用 tf-peek 精确取回）；
tf-bash / tf-write / tf-edit / tf-append 成功只记台账（回执），不回灌输出。
失败一律以 [tf-stream:error] 注入，没有错误注入就是成功了。
因此：要看命令输出或计算结果时，用 tf-peek 按句柄取回——handle 从 [tf-stream:observation]
与句柄目录增量中取。答案依赖命令输出时，先 peek 再收尾。

## 回验纪律（省 token 的关键）
- 你 tf-write 的正文全文就在你的上下文里：不要为了"确认写成功"而 tf-read 自己刚写过的
  路径——那只会得到回执（行数 + 内容指纹，[tf-stream:receipt]），不会重复回灌全文。
  写失败一定会有 [tf-stream:error] 注入；没有错误注入就是写成功了。
- tf-read 留给"读不是你写的文件"（任务要求读的既有文件、命令产出的文件）。
- 确需局部比对自写文件时，用 tf-peek 按行段取回，不要全文重读。

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
4. tf-read 首次/变化结果完整注入下一请求；其余成功产出只句柄化（见"结果获取"）。
   需要某句柄的细节时发 tf-peek（handle 用句柄目录里的值，行段 1-based 闭区间）。
   tf-edit 匹配失败（原文不唯一/不存在）会以结构化错误注入：核对后修正 OLD 段重发，
   不要扩大替换范围改全文。tf-grep/tf-glob 只回匹配行/路径，超长会截断并提示 tf-peek。
5. 上一请求若报告 [tf-stream:error]，先修复或改道该命令（换路径/换命令），再继续其余任务。
6. 全部命令成功且无需更多信息时输出 tf-final；收到 tf-final 后本任务收敛，不再有下一请求。
7. 调用工具只允许上表的 tf-* 标记：不要输出 <｜｜DSML｜｜…>、<think> 包裹、JSON tool_call
   等任何原生调用格式——它们不会被解析成命令，只会浪费输出 token 并在界面显示为乱码。`;

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

/** F3：tf-code 首成功/变化结果完整注入的默认上限（字符）。4000 ≈ 2k tokens：
 *  上限内值直接可见（省一次 tf-peek 往返），超限转骨架 + 句柄（中间结果不回灌的红线不破）。 */
export const DEFAULT_CODE_VALUE_INJECT_LIMIT = 4000;

/** F4：原生 tool_call 结果单块注入的默认上限（字符），仅声明 nativeToolSchemas 时生效。
 *  6000 ≈ 3k tokens：首成功/短结果完整注入，超限转骨架 + 句柄，杜绝原生通道全量回灌。 */
export const DEFAULT_NATIVE_RESULT_LIMIT = 6000;

/** F7：长会话段边界阈值（追加区字符数）。160k 字符 ≈ 40k tokens：超过即在新回合开始处
 *  整块丢弃旧段（ADR-001：整块丢弃路线，显式缓存重置点，原文句柄化可回取）。 */
export const DEFAULT_SEGMENT_MAX_CHARS = 160_000;

// ---------------------------------------------------------------------------
// ② SingleStreamDriver
// ---------------------------------------------------------------------------

interface CommandRecord {
  cmd: TfCommand;
  status: 'pending' | 'dispatched' | 'ok' | 'failed' | 'rejected';
  /** 当前流内解析序号（隐式写序用；每流重置） */
  streamSeq?: number;
  detail?: string;
  handle?: string;
  /** 命令产出原文（peek 的取回内容；供 need_result 注入） */
  output?: string;
  /** 执行产出的观测（供 high 骨架注入判定） */
  observation?: ObservationResult;
}

/** F5：验收项（计划状态放驱动器=宿主侧；请求只注差分）。 */
interface PlanAcceptItem {
  text: string;
  status: 'open' | 'verified';
  /** 验证证据：命令 id + 回执（句柄/指纹）；模型自述"已完成"不算证据 */
  evidence?: string;
}

/** F5：解析 tf-plan body 的验收项行（`- [id] 描述`；无有效行时调用方判结构化失败）。 */
export function parsePlanItems(body: string): Array<{ id: string; text: string }> {
  const items: Array<{ id: string; text: string }> = [];
  const seen = new Set<string>();
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*[-*]?\s*\[([A-Za-z0-9_-]{1,64})\]\s+(.+?)\s*$/);
    if (m === null) continue;
    const id = m[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, text: m[2]! });
  }
  return items;
}

interface StructuredIssue {
  cmdId: string;
  name: string;
  target: string;
  reason: string;
  suggestion: string;
}

interface NativeCallAccumulator {
  id: string;
  name?: string;
  arguments: string;
}

export interface DriverSnapshot {
  records: readonly DriverRecord[];
  counters: () => { injected: number; produced: number; peeked: number; injectedRatio: number };
  usage: { inputTokens: number; outputTokens: number };
  requestCount: number;
  stableHashes: readonly string[];
}

let DRIVER_SEQ = 0;

export class SingleStreamDriver {
  #ports: DriverPorts;
  readonly #cfg: {
    provider: string;
    model: string;
    reasoningEffort?: string;
    maxParallelToolCalls: number;
    maxReentries: number;
    streamIdleTimeoutMs: number;
    budgetTokens?: number;
    /** tf-read 成功反馈完整原文的字符上限（缺省 DEFAULT_READ_FEEDBACK_LIMIT；超长截断保头尾） */
    readFeedbackLimit?: number;
    /** 自写回验策略（修复限制 1）：'receipt'（默认）| 'full' */
    selfReadFeedback: 'receipt' | 'full';
    /** tf-code 通道是否启用（K1：仅显式 enableCode:true 且端口在位；决定协议文本是否声明 tf-code） */
    codeEnabled: boolean;
    /** tf-code 默认超时（毫秒）；undefined = 宿主 provider 默认 */
    codeTimeoutMs?: number;
    /** K5：tf-code 配额三项硬限制 */
    codeQuota: Required<CodeQuota>;
    /** F3：tf-code 结果完整注入上限（字符） */
    codeValueInjectLimit: number;
    /** F4：原生结果单块注入上限（字符） */
    nativeResultLimit: number;
  /** F4：原生通道是否启用（声明了 nativeToolSchemas 才算；决定结果上限策略是否生效） */
  nativeToolSchemasEnabled: boolean;
  /** F5：计划与验收是否启用（默认 true；false 时 tf-plan 命令级失败、accepts 忽略——回退点） */
  enablePlan: boolean;
  /** F7：段边界阈值（追加区字符数；≤0 = 关闭） */
  segmentMaxChars: number;
  toolMapping: ToolMapping;
  /** v0.4.0 工具面档位（§16 决议 2：缺省 standard）。'off' = 0.3.x 行为（无宿主面，
   *  tf-call 关闭——回退点）。 */
  toolSurface: SurfaceProfile;
  /** v0.4.0 原生通道开关（§15：默认文本 false）。开启时请求携带冻结面 schema
   *  （core 档白名单 / standard-full 全量），可达性同时保留 tf-call。 */
  nativeTools: boolean;
  /** v0.4.0 tf-call 通用通道开关（G2）。toolSurface=off 时强制关。 */
  callCommand: boolean;
  /** v0.4.0 toolSet 准入（R5 决议 3：beta 缺省 false——toolSet 只用于 schemas 视图，
   *  不传 execute；P6 复跑后再收紧）。 */
  strictAdmission: boolean;
  };
  readonly #renderer: ContextRenderer;
  readonly #obs: ObservationLedger;
  /** v0.4.0 工具面（P1）：会话首请求冻结；tf-call 校验面 + nativeTools 声明面。 */
  readonly #surface: ToolSurfaceHolder;
  /** 本请求冻结的工具面快照（undefined = L2 protocol-only / toolSurface=off）。 */
  #currentSurface: ToolSurface | undefined = undefined;
  /** 上一次注入的降级级别（同级别不重复注入；级别变化或恢复时重新注入）。 */
  #lastSurfaceDegraded: 'stale' | 'core' | 'protocol-only' | 'ok' = 'ok';
  readonly #records: DriverRecord[] = [];
  readonly #commands = new Map<string, CommandRecord>();
  readonly #inFlight = new Set<Promise<void>>();
  readonly #activeControllers = new Set<AbortController>();
  /** 当前流内命令序号（隐式写序：后续命令等待先闭合的同流 tf-write —— 上游 ThinkFlow 语义） */
  #streamSeqCounter = 0;
  #streamWrites: Array<{ id: string; seq: number }> = [];
  /** unknown-handle 的 peek（同流乐观 peek）：流末 drain 后重试一次，仍无此句柄才失败 */
  #deferredPeeks: Array<{ rec: CommandRecord; turn: number; step: number }> = [];
  /** 本任务内 tf-write 已成功写过的路径（规范化分隔符；修复限制 1 的自写回验判定） */
  readonly #writtenPaths = new Set<string>();
  /** F5 计划与验收：计划状态放驱动器（宿主侧）；请求只注差分。
   *  items 为当前 revision 的验收项全集；announced 保存上次注入时各验收项的状态，
   *  差分 = 两次状态之差（新增 / 变已验证 / 移除）。 */
  #plan: { revision: number; items: Map<string, PlanAcceptItem> } | null = null;
  #planAnnounced: Map<string, PlanAcceptItem['status']> | null = null;
  /** 运行中回合收到的 steer（修复限制 2：下一请求装配时进追加区，对齐内建"注入运行中回合的下一步"） */
  #pendingSteers: Array<{ text: string; message: unknown }> = [];

  #turnCounter = 0;
  /** K4 取消链路：回合级 signal（runTurn 创建，cancel 时 abort）。所有工具派发
   *  （executeTools / executeCode）共用它——不再用独立且永不触发的 AbortController。 */
  #turnController: AbortController | null = null;
  #requestCount = 0;
  #reentryCount = 0;
  #finalNudges = 0;
  #finalOnlyRequests = 0;
  #deltaCursor = 0; // O3 directoryDelta 游标（obs seq 空间）
  #usage = { inputTokens: 0, outputTokens: 0 };
  #injectedChars = 0;
  #stableHashes: string[] = [];
  #aborted = false;
  #abortReason: unknown;
  #ledger: LedgerSink | undefined;
  #warn: (message: string, detail?: unknown) => void;
  #gate: GatePort | undefined;
  #taskId = 'task';
  #sessionId: string | undefined;
  /** 已上报的结构化问题（同一失败只注入一次） */
  #reportedIssues = new Set<string>();
  /** 已注入骨架的观测 key（driver seq 空间，避免重复注入） */
  #reportedObservations = new Set<number>();
  /** 已回灌结果的 peek 命令 id */
  #reportedPeeks = new Set<string>();
  /** 当前 agent 引用（executeTools 带上 agent；fs 工具 session 解析依赖，见 ToolBatchInputLike） */
  #agentRef: unknown = undefined;
  /** K2：会话工作区（factory 从 session header / workingDirectory 服务解析后回填；
   *  tf-code resolve 透传，与 tf-write/tf-read 的路径解析语义一致）。 */
  #sessionCwd: string | undefined = undefined;
  /** F6：resume 停机核对标记（"有意图无回执"时由 factory 置位；置位后 runTurn 直接 blocked，
   *  不发任何请求、零注入——由用户核对后重启/清除意图，不自动重放）。 */
  #resumeHalt: string | null = null;
  /** F7：当前任务块在追加区的起始下标（pushUserTask 时刻的块数）——段丢弃只丢它之前的旧段。 */
  #segmentKeepFrom = 0;
  /** ok 的 tf-final 候选（解析序）；任务最终答案取最后一个（过早 final 可被后继覆盖） */
  #finalCandidates: Array<{ cmdId: string; summary: string; turn: number; step: number }> = [];
  /** v0.3.1：当前流内的 prose 累积（parser 的 text 事件拼接；落盘 assistant/message 的正文）。
   *  0.3.0 落盘的是整段原文（含 tf-* 标记与 DSML 噪声）——桌面端过程区把协议标记渲染成乱码，
  *  本版起落盘纯 prose：命令事实在台账（plugin:tf-agent/*），会话日志只留用户可读内容。 */
  #streamProse = '';
  /** v0.3.1 实时帧状态：agent 生命周期内的 attempt 序号与帧序号（revision 逐帧 +1，
   *  契约见 dsh-api-session-controller SessionAssistantStreamAccumulator.accept）。 */
  #attemptCounter = 0;
  #frameRevision = 0;
  #frameChunkIndex = 0;
  #frameAttemptId: string | undefined = undefined;
  /** 实时帧熔断：发射抛错（无监听器异常/宿主总线异常）后本会话不再发（fail-open）。 */
  #frameBroken = false;

  // ---------------------------------------------------------- v0.3.1 实时帧（agent/assistant-stream）

  /**
   * 思考过程实时帧（桌面端 live 显示的数据源）。契约对齐宿主两端的 fold：
   * dsh-api-session-controller SessionAssistantStreamAccumulator.accept（服务端，要求
   * revision 逐帧 +1、chunk index 逐块 +1）与客户端 ClientAssistantStream.acceptFrame
   * （start 只在无活跃 attempt 时接受）。发射异常即熔断（本会话不再发，fail-open）。
   */
  #frameEmit(frame: Record<string, unknown>): void {
    if (this.#frameBroken || this.#ports.emitHostEvent === undefined || this.#agentRef === undefined) return;
    try {
      this.#ports.emitHostEvent('agent/assistant-stream', { agent: this.#agentRef, frame });
    } catch (error) {
      this.#frameBroken = true;
      this.#warn('assistant-stream 实时帧发射失败（已熔断，本会话不再发）', error);
    }
  }

  /** 流开始帧：分配 attemptId（session 内唯一），index 清零。 */
  #frameStartAttempt(turn: number, step: number): void {
    if (this.#ports.emitHostEvent === undefined || this.#agentRef === undefined || this.#sessionId === undefined) return;
    this.#frameAttemptId = `${this.#sessionId}:${++this.#attemptCounter}`;
    this.#frameChunkIndex = 0;
    this.#frameEmit({ type: 'start', attemptId: this.#frameAttemptId, revision: ++this.#frameRevision, turn, step });
  }

  /** 思考 delta 帧（正文不逐帧透传：流文本是协议标记，实时显示会闪现乱码）。 */
  #frameReasoningDelta(index: number, text: string): void {
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
  #frameEndAttempt(settlement: { eventType: string; seq?: number } | undefined): void {
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
  #frameEndAbandonedIfOpen(): void {
    this.#frameEndAttempt(undefined);
  }

  constructor(ports: DriverPorts, config: StreamDriverConfig, renderer?: ContextRenderer, obs?: ObservationLedger) {
    this.#ports = ports;
    this.#cfg = {
      provider: config.provider,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      maxParallelToolCalls: config.maxParallelToolCalls ?? 3,
      maxReentries: config.maxReentries ?? 8,
      streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 30_000,
      budgetTokens: config.budgetTokens,
      selfReadFeedback: config.selfReadFeedback ?? 'receipt',
      // K1（0.3.0）：默认关闭——只有显式 enableCode:true 且端口在位才启用。
      // 0.2.0 的"端口在位即启用"（auto）语义已按 M2/K1 结论收口：协议段默认 0 字符。
      codeEnabled: config.enableCode === true && ports.executeCode !== undefined,
      codeTimeoutMs: config.codeTimeoutMs,
      codeQuota: { ...DEFAULT_CODE_QUOTA, ...(config.codeQuota ?? {}) },
      codeValueInjectLimit: config.codeValueInjectLimit ?? DEFAULT_CODE_VALUE_INJECT_LIMIT,
      nativeResultLimit: config.nativeResultLimit ?? DEFAULT_NATIVE_RESULT_LIMIT,
      nativeToolSchemasEnabled: config.nativeToolSchemas !== undefined,
      enablePlan: config.enablePlan ?? true,
      segmentMaxChars: config.segmentMaxChars ?? DEFAULT_SEGMENT_MAX_CHARS,
      toolMapping: config.toolMapping ?? DEFAULT_TOOL_MAPPING,
      // v0.4.0 工具面（P1）：'off' 档 = 0.3.x 行为回退点；无宿主服务面（headless/离线）
      // 时 tf-call 段不声明（协议文本与 0.3.x 一致，mock 剧本匹配不受影响）
      toolSurface: config.toolSurface ?? 'standard',
      nativeTools: config.nativeTools === true,
      callCommand: (config.toolSurface ?? 'standard') !== 'off'
        && config.callCommand !== false
        && ports.toolsService !== undefined,
      strictAdmission: config.strictAdmission === true,
    };
    // tf-code 协议段只在实际可执行时声明（稳定前缀构造期冻结：通道不存在就不会被模型幻觉调用）
    // v0.4.0：tf-call 协议段同理（callCommand 决定声明与否；'off' 档不声明，0.3.x 回退点）
    const protocolText = (config.protocolText ?? DEFAULT_PROTOCOL_TEXT)
      + (this.#cfg.codeEnabled ? `\n\n${config.codeProtocolText ?? DEFAULT_CODE_PROTOCOL_SECTION}` : '')
      + (this.#cfg.callCommand ? `\n\n${config.callProtocolText ?? DEFAULT_CALL_PROTOCOL_SECTION}` : '');
    this.#renderer = renderer ?? new ContextRenderer({
      system: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      protocol: protocolText,
      toolSchemas: config.nativeToolSchemas ?? (this.#cfg.nativeTools
        ? '（本请求的原生工具 schema 见 tools 字段；未列出的宿主工具一律走 tf-call）'
        : '（本回合未启用原生工具；一切文件与命令操作走 tf-* 协议）'),
      invariants: config.invariants ?? DEFAULT_INVARIANTS,
    });
    this.#surface = new ToolSurfaceHolder(ports.toolsService, {
      profile: this.#cfg.toolSurface,
      nativeTools: this.#cfg.nativeTools,
      callCommand: this.#cfg.callCommand,
    });
    this.#obs = obs ?? new ObservationLedger({ starvationThreshold: config.starvationThreshold });
    this.#warn = ports.onWarning ?? (() => {});
    this.#gate = ports.gate;
  }

  /** 注入 ledger 通道（探针 C 定案的 plugin:tf-agent/* 落盘口；缺省只进内存 records）。 */
  attachLedger(sink: LedgerSink): void {
    this.#ledger = sink;
  }

  /** 运行时模型路由切换（Agent.model.select 的落点）。 */
  applySelection(selection: { provider?: string; model?: string; reasoningEffort?: string }): void {
    if (selection.provider !== undefined) this.#cfg.provider = selection.provider;
    if (selection.model !== undefined) this.#cfg.model = selection.model;
    if (selection.reasoningEffort !== undefined) this.#cfg.reasoningEffort = selection.reasoningEffort;
  }

  /** Agent 层接线：会话 id（请求路由 stamp）与任务 id（gate 凭据绑定）。 */
  setIdentity(sessionId: string | undefined, taskId: string): void {
    this.#sessionId = sessionId;
    this.#taskId = taskId;
  }

  /** Agent 构造完成后回填引用：工具批的 agent 字段（fs 工具 session 解析依赖）。 */
  setAgent(agent: unknown): void {
    this.#agentRef = agent;
  }

  /** K2：回填会话工作区（tf-code resolve 透传用；factory 在 createDriver 闭包里解析）。 */
  setSessionCwd(cwd: string | undefined): void {
    this.#sessionCwd = cwd;
  }

  /** F6：置位 resume 停机核对（"有意图无回执"；零注入——只阻断，不进上下文）。 */
  setResumeHalt(detail: string): void {
    this.#resumeHalt = detail;
  }

  /** F6：清除停机核对（人工核对完成后的出口）。 */
  clearResumeHalt(): void {
    this.#resumeHalt = null;
  }

  /** F7：按句柄取回观测原文（段边界丢弃的旧段原文、命令产出等）；未知句柄返回 null。
   *  只读通道，不进上下文——供排障/回取与评测断言使用。 */
  peekHandle(handle: string, fromLine = 1, toLine = Number.MAX_SAFE_INTEGER): string | null {
    return this.#obs.peek(handle, fromLine, toLine);
  }

  /** v0.4.0（P5）：当前冻结工具面的工具名（tf-code 全绑定生成用）。无面 = 空数组（0.3.x 行为）。 */
  surfaceNames(): readonly string[] {
    return this.#currentSurface?.names ?? [];
  }

  /**
   * F5：命令成功回执 → 标记其 accepts 声明的验收项为已验证。
   * 证据 = `cmdId(handle=…,fp=…)`——模型自述"已完成"不产生任何条目（无回执不验证）。
   * 每次标记落台账；注入差分在 #buildInjections 里统一生成。
   */
  #markAccepts(cmd: TfCommand, handle: string | undefined, fingerprint: string): void {
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

  /** Agent 作用域的工具执行器重绑（桌面端 preset 层）：
   *  web/desktop 组合把 tool-fs/tool-pwsh 从宿主平面挪进 agent preset 层（standard.patch.yml），
   *  entry 根 ctx 的 tools 服务解析不到 write/edit/bash → "unknown tool"。
   *  setup（preset 绑定）完成后用 agentCtx 的 tools 服务重绑；headless 回退根服务不变。 */
  setToolsExecutor(execute: (input: ToolBatchInputLike) => Promise<ToolBatchResultLike>): void {
    this.#ports = { ...this.#ports, executeTools: execute };
  }

  snapshot(): DriverSnapshot {
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
  #dumpEval(turn: number, reason: TurnEndReason): void {
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
  budgetLevel(): BudgetLevel {
    const budget = this.#cfg.budgetTokens;
    if (budget === undefined || budget <= 0) return 'normal';
    const spent = this.#usage.inputTokens + this.#usage.outputTokens + Math.ceil(this.#injectedChars / 4);
    if (spent >= budget * 0.9) return 'final-only';
    if (spent >= budget * 0.7) return 'high-only';
    return 'normal';
  }

  // ------------------------------------------------------------------ 任务入口

  /** 追加一条用户任务（Agent.followup 的驱动器侧入口：只进装配历史，不发请求）。
   *  F7：记录当前任务块的起始下标——段边界只丢弃它之前的旧段（整块、完整回合边界）。 */
  pushUserTask(text: string): void {
    this.#segmentKeepFrom = this.#renderer.appendBlockCount;
    this.#renderer.appendHistory({ role: 'user', content: text });
  }

  /** 运行中回合的 steer 入口（修复限制 2）：下一请求装配时进追加区（对齐内建
   *  "注入运行中回合的下一步"）；流内不打断的前提不变——当前流跑完才装配。 */
  pushSteer(text: string, message?: unknown): void {
    this.#pendingSteers.push({ text, message });
  }

  /** 尚未消费（未进装配历史）的 steer 的原始消息（Agent.inbox.nextStep 的如实暴露面）。 */
  get pendingSteerMessages(): readonly unknown[] {
    return this.#pendingSteers.map((s) => s.message);
  }

  /**
   * resume 重放（修复限制 4 的另一半）：把上一会话的 tf-* 台账事实回灌驱动器。
   * 只回放 'plugin:tf-agent/final'（finalCandidates → 最终答案跨 resume 可用）。
   * 刻意不回放命令记录：属性不回放则幂等指纹永不匹配，回放反而会占用 id 命名空间
   * 挡住合法重发；旧失败也不该在新回合里当作重入事由重新上报。finalCandidates
   * 不进 #commands，因此重放不会让 #finalSeen 立即为真——新回合仍须模型自己收尾。
   */
  rehydrateRecords(records: ReadonlyArray<{ kind: string; data: unknown }>): { applied: number; skipped: number } {
    let applied = 0;
    let skipped = 0;
    for (const rec of records) {
      const data = (rec.data !== null && typeof rec.data === 'object' ? rec.data : undefined) as Record<string, unknown> | undefined;
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
  cancel(reason: unknown): void {
    this.#aborted = true;
    this.#abortReason = reason;
    for (const controller of this.#activeControllers) {
      controller.abort(reason instanceof Error ? reason : new Error(String(reason)));
    }
    this.#turnController?.abort(reason instanceof Error ? reason : new Error(String(reason)));
  }

  /** K4：回合 signal（runTurn 期间有效；缺省 = 一次性从未触发的 controller，兼容直派发路径）。 */
  #commandSignal(): AbortSignal {
    return this.#turnController?.signal ?? new AbortController().signal;
  }

  /** 跑一个回合（从当前装配历史到 FINISH/blocked）。异常一律上抛（fail-open，红线 5）。 */
  async runTurn(): Promise<TurnEndReason> {
    // F6：resume 停机核对——"有意图无回执"时不发任何请求（零注入），直接 blocked，
    // 由用户核对意图日志（CLI `dsh-stream-agent intents`）后决定继续或放弃。
    if (this.#resumeHalt !== null) {
      const reason: TurnEndReason = { kind: 'blocked', detail: `resume 停机核对（F6）：${this.#resumeHalt}——存在写前意图无回执，不自动重放；请人工核对后重试（CLI: dsh-stream-agent intents）。` };
      this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'resume-halt-pending-intents', detail: reason.kind === 'blocked' ? reason.detail : undefined });
      this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'resume-halt-pending-intents', turn: this.#turnCounter + 1 });
      this.#ports.events?.turnEnd(this.#turnCounter + 1, reason);
      return reason;
    }
    const turn = ++this.#turnCounter;
    const controller = new AbortController();
    this.#turnController = controller;
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
        const failure: TurnEndReason = {
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
      if (this.#turnController === controller) this.#turnController = null;
    }
  }

  // ------------------------------------------------------------------ 回合主循环

  async #turnLoop(turn: number): Promise<TurnEndReason> {
    let step = 0;
    // 防震荡护栏按回合重置（maxReentries / final nudge / final-only 档都是回合级护栏）——
    // 不重置的话，多任务长会话会在第 N 个回合被历史累计计数误杀（F7 长会话测试实抓）。
    this.#reentryCount = 0;
    this.#finalNudges = 0;
    this.#finalOnlyRequests = 0;
    let reason: TurnEndReason = { kind: 'blocked', detail: 'turn loop exited without convergence' };

    while (true) {
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
      const degradedLevel: 'stale' | 'core' | 'protocol-only' | 'ok' =
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
          content: `[tf-stream:observation handle=${promoted.handle ?? ''} key=starvation-promoted]\n${(promoted.payload as { rendered?: string }).rendered ?? ''}\n（细节用 tf-peek handle="${promoted.handle}" from_line=.. to_line=.. 取回）`,
        });
      }

      if (streamOutcome.finish.kind === 'error' || streamOutcome.finish.kind === 'aborted') {
        this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: `stream-${streamOutcome.finish.kind}`, detail: finishDetail(streamOutcome.finish) });
        this.#ledgerWrite('plugin:tf-agent/fault', { fault: `stream-${streamOutcome.finish.kind}`, detail: finishDetail(streamOutcome.finish), turn });
      }

      // ---- 过早 final 检测（真连 R3/R4 教训）：占位 final 不算收敛，注入引导重发 ----
      const lastFinal = this.#finalCandidates.length > 0 ? this.#finalCandidates[this.#finalCandidates.length - 1] : undefined;
      let prematureFinal: string | undefined;
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
      }

      const finalSeen = this.#finalSeen && prematureFinal === undefined;
      // steer 在本流期间到达 → 不能带着未消费的 steer 收敛（对齐内建：插话必须被下一步看到）
      const pendingSteerCount = this.#pendingSteers.length;
      const needsReentry = issues.length > 0 || injections.blocks.length > 0 || prematureFinal !== undefined || pendingSteerCount > 0;

      if (prematureFinal !== undefined && lastFinal !== undefined) {
        injections.blocks.push({
          role: 'user' as const,
          content: `[tf-stream:error id=${lastFinal.cmdId} cmd=tf-final] ${prematureFinal}\n建议：先取回所需结果（tf-peek）或补齐未完成命令，然后在流末尾用新 id 重发 tf-final；summary 必须包含最终答案原文（数字/行内容/路径/结论），不得占位。`,
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

      // 非成功路径（重入 / 阻断 / 取消）：本步到此结束
      try {
        this.#ports.events?.stepEnd(turn, step);
      } catch (error) {
        this.#warn('step/end 事件写入失败', error);
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
            role: 'user' as const,
            content: `[tf-stream:degraded] 预算已进入 final-only 档：停止一切注入。请根据台账现状立即输出 tf-final 结束任务；未完成项将在交付说明中列为未完成。`,
          }];
          this.#record({ seq: ++DRIVER_SEQ, kind: 'fault', fault: 'degraded-delivery' });
          this.#ledgerWrite('plugin:tf-agent/fault', { fault: 'degraded-delivery', turn });
        } else {
          // 无重入事由但也没 tf-final：一次性提示（护栏防无限循环）
          this.#finalNudges += 1;
          tail = [{ role: 'user' as const, content: '[tf-stream:nudge] 输出已终止但未收到 tf-final。若任务已完成请输出 tf-final；否则继续输出剩余 tf-* 命令。' }];
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

  get #finalSeen(): boolean {
    return this.#commands.size > 0 && [...this.#commands.values()].some((rec) => rec.cmd.name === 'tf-final' && rec.status === 'ok');
  }

  // ------------------------------------------------------------------ 流消费

  /** 诊断探针：会话对象的事件账面（内存事件数/末尾 seq）。 */
  #sessionProbe(): unknown {
    const session = (this.#agentRef as { session?: { snapshotEvents?(offset: number): Array<{ seq?: number; type?: string }> } } | undefined)?.session;
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
    turn: number,
    step: number,
    messages: readonly RenderMessage[],
    level: BudgetLevel,
  ): Promise<{ finish: FinishReasonLike }> {
    // 新流：隐式写序的流内序号清零（跨流依赖仍由 depends_on 显式声明）
    this.#streamSeqCounter = 0;
    this.#streamWrites = [];
    const parser = new TfStreamParser();
    const controller = new AbortController();
    this.#activeControllers.add(controller);
    let textBuf = '';
    this.#streamProse = '';
    let reasoningChars = 0;
    // v0.3.1：思考过程捕获（按块 index 分段，落盘时按到达序拼接为单个 reasoning 块）
    const reasoningParts: string[] = [];
    let reasoningLastIndex: number | null = null;
    const natives = new Map<string, NativeCallAccumulator>();
    let finish: FinishReasonLike | null = null;
    let usageSeen: { inputTokens: number; outputTokens: number } | undefined;

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

    const feed = (delta: string) => {
      const events: ParserEvent[] = parser.feed(delta);
      for (const event of events) this.#handleParserEvent(event, turn, step);
    };

    // v0.3.1 实时帧：流开始即发 start 帧（契约见 #frameEmit）。思考过程
    // （reasoning-delta）逐帧透传——桌面端思考区 live 渲染的数据源。正文不逐帧透传：
    // 流文本是协议标记（tf-*），实时显示会把标记闪成乱码；落盘后以纯 prose 消息呈现。
    // 发射异常即熔断（本会话不再发），任务不受影响（fail-open）。
    const frameStart = (): void => this.#frameStartAttempt(turn, step);
    const frameEnd = (settlement: { eventType: string; seq?: number } | undefined): void =>
      this.#frameEndAttempt(settlement);

    try {
      if (this.#cfg.provider === '' || this.#cfg.model === '') {
        // 无模型路由（桌面端未选择模型且无默认）：失败注入引导，不静默烧流
        return {
          finish: {
            kind: 'error' as const,
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
        // v0.4.0（P1）：nativeTools 开启时携带冻结面 schema（core 档白名单 / standard-full 全量）。
        // 默认关闭——schema 的每请求 token 成本由 tf-call 的逐调用成本替代（§15 默认文本）。
        ...(this.#cfg.nativeTools && this.#currentSurface !== undefined && this.#currentSurface.schemas.length > 0
          ? { tools: this.#currentSurface.schemas }
          : {}),
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
    // v0.3.0：原生 tool_call 通道要在**同一条** assistant 消息里广告 tool-call 块，
    // 否则随后宿主写出的 tool/call 在 v4 格式校验里没有生命周期 → 历史加载被判 corrupt。
    // 只有确定会执行的批次才广告（error/aborted 的残缺调用如实丢弃，不能留下未解广告）。
    // v0.3.1：正文落盘从整段原文改为纯 prose（#streamProse，parser text 事件拼接）——
    // 协议标记（tf-*/DSML）留在台账与会话事实层，桌面端过程区只显示可读文本。
    const nativeCallsWillRun = (finish.kind === 'stop' || finish.kind === 'tool-calls') && natives.size > 0;
    const nativeAds: ToolCallAdvertisement[] = nativeCallsWillRun
      ? [...natives.values()].map((c) => ({ id: c.id, name: c.name ?? 'unknown', arguments: c.arguments || '{}' }))
      : [];
    const reasoningText = reasoningParts.join('\n');
    let settlement: { eventType: string; seq?: number } | undefined;
    try {
      settlement = this.#ports.events?.assistantMessage(turn, step, this.#streamProse, {
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

    return { finish };
  }

  // ------------------------------------------------------------------ parser 事件处理

  #handleParserEvent(event: ParserEvent, turn: number, step: number): void {
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

  #onCommand(cmd: TfCommand, turn: number, step: number): void {
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
    const record: CommandRecord = { cmd, status: 'pending' };
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
  #dispatchReady(turn: number, step: number): void {
    if (this.#aborted) return;
    for (const rec of this.#commands.values()) {
      if (rec.status !== 'pending') continue;
      if (this.#inFlight.size >= this.#cfg.maxParallelToolCalls) return;
      const depsMet = rec.cmd.depends_on.every((d) => this.#commands.get(d)?.status === 'ok');
      if (!depsMet) continue;
      const pendingWrites = rec.streamSeq !== undefined
        ? this.#streamWrites.filter((w) => w.seq < rec.streamSeq! && this.#commands.get(w.id)?.status !== 'ok')
        : [];
      if (pendingWrites.length > 0) continue;
      rec.status = 'dispatched';
      this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: rec.cmd.id, name: rec.cmd.name, status: 'dispatched' });
      const task: Promise<void> = this.#executeCommand(rec, turn, step)
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

  async #executeCommand(rec: CommandRecord, turn: number, step: number): Promise<void> {
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
      const next = new Map<string, PlanAcceptItem>();
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
      this.#ledgerWrite('plugin:tf-agent/plan', { revision, cmdId: cmd.id, items: items.map((i) => ({ id: i.id, text: i.text, status: next.get(i.id)!.status })) });
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
    let mapped: { name: string; arguments: Record<string, unknown> } | null = null;
    let result: ToolBatchResultLike;
    // v0.4.0（P2/G2）：tf-call 通用调用通道——name 在冻结工具面内校验（unknown-tool 结构化
    // 失败 + 前缀建议），body 必须是 JSON 对象（bad-json-arguments 结构化失败）。校验不占
    // 请求 token（错误只进下一请求注入）；工具面缺席（L2）时引导回 tf-* 命令。
    if (cmd.name === 'tf-call') {
      const toolName = cmd.attrs['name'] ?? '';
      const nameError = this.#surface.validateCallName(toolName);
      let args: unknown;
      let argsError: string | undefined;
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
        rec.detail = (nameError ?? argsError)!.slice(0, 500);
        this.#record({ seq: ++DRIVER_SEQ, kind: 'command', id: cmd.id, name: cmd.name, status: 'failed', detail: rec.detail });
        this.#ledgerWrite('plugin:tf-agent/command', { cmdId: cmd.id, name: cmd.name, status: 'failed', kind: nameError !== undefined ? 'unknown-tool' : 'bad-json-arguments', detail: rec.detail.slice(0, 200) });
        return;
      }
      mapped = { name: toolName, arguments: args as Record<string, unknown> };
    } else {
      mapped = this.#cfg.toolMapping.toToolCall(cmd);
    }
    // F6 写前意图：变更类命令（tf-write/tf-edit/tf-append）在派发到宿主工具**之前**落盘（fsync）。
    // 崩溃后"有意图无回执"即可判定写入可能已发生 → resume 停机核对。零注入：只进账本。
    const intentOp: 'write' | 'edit' | 'append' | null = cmd.name === 'tf-write'
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
      const advertised: ToolCallAdvertisement = { id: cmd.id, name: mapped.name, arguments: JSON.stringify(mapped.arguments) };
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
    rec.detail = `${contentText.length} chars`;
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
    turn: number,
    step: number,
    calls: NativeCallAccumulator[],
    signal: AbortSignal,
    level: BudgetLevel,
  ): Promise<void> {
    let result: ToolBatchResultLike | undefined;
    try {
      result = await this.#ports.executeTools({
        calls: calls.map((c) => ({ type: 'tool-call' as const, id: c.id, name: c.name ?? 'unknown', arguments: c.arguments || '{}' })),
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
    if (results.length === 0 || level === 'final-only') return;

    // 原生通道结果即需求（阻塞语义）：注入易变尾，下一请求立即可见。
    // F4：仅在声明了 nativeToolSchemas（原生通道显式启用）时执行上限策略——
    // 首成功/短结果完整注入；超限块登记 obs 并转"骨架 + 句柄"，杜绝全量回灌。
    const capped = this.#cfg.nativeToolSchemasEnabled === true;
    const blocks = results.map((r) => {
      if (!capped || r.isError || r.content.length <= this.#cfg.nativeResultLimit) {
        return {
          role: 'user' as const,
          content: `[tf-stream:tool-result callId=${r.callId} tool=${r.name}${r.isError ? ' isError=true' : ''}]\n${r.content}`,
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
      return {
        role: 'user' as const,
        content: `[tf-stream:tool-result callId=${r.callId} tool=${r.name}] ${r.content.length} 字符超出原生通道注入上限（${this.#cfg.nativeResultLimit}），已句柄化：${skeleton}\n（原文用 tf-peek handle="${observation.handle ?? ''}" from_line=.. to_line=.. 取回）`,
      };
    });
    this.#injectedChars += blocks.reduce((n, b) => n + b.content.length, 0);
    this.#pendingNativeBlocks.push(...blocks);
  }

  #pendingNativeBlocks: Array<{ role: 'user'; content: string }> = [];

  // ------------------------------------------------------------------ drain / 收束

  async #drain(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
      // 全部落定后再开一轮派发（依赖在 drain 期间满足的命令）
      this.#dispatchReady(this.#turnCounter, 0);
    }
  }

  /** 流末重试延迟的 peek（同流乐观 peek；句柄已由 drain 期间完成的命令注册）。
   *  仍无此句柄才按失败注入——上游"信息工具先等之前的写入"的驱动器侧闭环。 */
  async #resolveDeferredPeeks(turn: number, step: number): Promise<void> {
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
  #collectIssues(): StructuredIssue[] {
    const issues: StructuredIssue[] = [];
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
  #buildInjections(issues: readonly StructuredIssue[], level: BudgetLevel): { blocks: Array<{ role: 'user'; content: string }>; highInjected: boolean } {
    const blocks: Array<{ role: 'user'; content: string }> = [];
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
        let body: string;
        if (rec.cmd.name === 'tf-read') {
          const full = this.#obs.peek(obs.handle ?? '', 1, Number.MAX_SAFE_INTEGER);
          // 修复限制 1：自写回验 receipt——tf-read 命中本任务 tf-write 已写过的路径时，
          // 全文就在模型上下文里，不再重复回灌（掐断"写→读回验"循环，写批任务的主要 token 开销）。
          const selfWritten = this.#cfg.selfReadFeedback !== 'full'
            && typeof rec.cmd.attrs['path'] === 'string'
            && this.#writtenPaths.has(normalizeTaskPath(rec.cmd.attrs['path']));
          if (selfWritten) {
            const lines = full === null ? 'unknown' : String(full.split('\n').length);
            const fp = full === null ? 'unavailable' : contentFingerprint(full);
            blocks.push({
              role: 'user',
              content: `[tf-stream:receipt handle=${obs.handle ?? ''} path=${rec.cmd.attrs['path']} lines=${lines} sha256=${fp}]`
                + `\n该路径由你本任务的 tf-write 写入，全文已在你的上下文中，不重复回灌（回验纪律）。`
                + `写失败会有 [tf-stream:error]；没有错误注入即写成功。确需局部比对用 tf-peek handle="${obs.handle}" from_line=.. to_line=..。`,
            });
            highInjected = true;
            continue;
          }
          body = readFeedbackBody(full, obs.payload.rendered, this.#cfg.readFeedbackLimit ?? DEFAULT_READ_FEEDBACK_LIMIT);
        } else if (rec.cmd.name === 'tf-code' && rec.output !== undefined) {
          // F3：code 结果可见性——上限内的首成功/变化值完整注入（省一次 tf-peek 往返）；
          // 句柄仍然有效，需要原文行段时照常 tf-peek。仅 tf-code 显式开启时此路径可达。
          body = rec.output;
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

    // 5. 原生 tool_call 结果（阻塞通道回灌，任意档都注入——它们是模型的即时需求）
    blocks.push(...this.#pendingNativeBlocks);
    this.#pendingNativeBlocks = [];

    return { blocks, highInjected };
  }

  // ------------------------------------------------------------------ 账本

  #record(record: DriverRecord): void {
    this.#records.push(record);
  }

  #ledgerWrite(type: TfAgentRecordType, data: unknown): void {
    if (this.#ledger === undefined) return;
    try {
      this.#ledger.record(type, data);
    } catch (error) {
      // 账本落盘失败不毁任务：内存 records 已有全量事实，告警出口保证不静默（红线 5）
      this.#warn(`ledger 落盘失败（${type}），事实已保留在内存 records`, error);
    }
  }
}

function safeToolLog(ports: DriverPorts, turn: number, step: number): { turn: number; step: number } | undefined {
  try {
    return ports.events?.toolLog(turn, step);
  } catch {
    return undefined;
  }
}

/** 任务内路径规范化（自写回验判定用）：统一分隔符；大小写保留（不做平台猜测试）。 */
function normalizeTaskPath(path: string): string {
  return path.replace(/\\/g, '/');
}

/** 内容指纹（receipt 行）：sha256 前 16 位十六进制——够对账，不泄露内容。 */
function contentFingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/** 命令指纹（重复 id 幂等判定）：名称 + 属性 + 正文（tf-write）。确定性序列化。 */
function commandFingerprint(cmd: TfCommand): string {
  const attrs = Object.keys(cmd.attrs).sort().map((k) => `${k}=${cmd.attrs[k]}`).join('&');
  return `${cmd.name}|${attrs}|${cmd.body ?? ''}`;
}

/** tf-read 成功反馈的完整原文默认上限（字符）——超过则头尾保留、中段省略。
 *  8000 字符 ≈ 4k tokens：上游 ThinkFlow 实证"省 token 主因是消灭回合数"，完整反馈
 *  远省于基线的多回合重读；截断边界 lottery（恰好切掉答案行）在 2026-11-15 sanity 实测，
 *  故阈值取宽。 */
export const DEFAULT_READ_FEEDBACK_LIMIT = 8000;

function readFeedbackBody(full: string | null, skeleton: string, limit: number): string {
  if (full === null) return `${skeleton}\n（原文不可取回，仅骨架；tf-peek 可按行段重试）`;
  if (full.length <= limit) return full;
  const headCut = Math.max(0, Math.floor(limit * 0.7));
  const tailCut = Math.max(0, Math.floor(limit * 0.2));
  const omitted = full.length - headCut - tailCut;
  return `${full.slice(0, headCut)}\n……（中段省略 ${omitted} 字符；tf-peek handle=<句柄> from_line=.. to_line=.. 精确取回）……\n${full.slice(full.length - tailCut)}`;
}

/** K4：识别取消类错误（AbortError / DOMException AbortError / 显式 abort 消息），与超时分账。 */
function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError'
      || (error as DOMException).code === 20
      || /(^|\b)(abort|aborted)(\b|$)/i.test(error.message);
  }
  return false;
}

/** 工具批失败取因：ToolBatchExecutionError 把真实错误包在 cause/partial 里（dsh-tools
 *  shared-DTdn5dXO.js），只记 message 会把根因吞掉（2026-11-15 真连 W1 教训）。 */
function describeToolError(error: unknown): string {
  const top = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown })?.cause;
  const parts: string[] = [top];
  let cur = cause;
  for (let depth = 0; cur !== undefined && depth < 4; depth += 1) {
    if (cur instanceof Error) {
      parts.push(`cause: ${cur.message}`);
      cur = (cur as { cause?: unknown }).cause;
    } else if (cur !== null && typeof cur === 'object') {
      const partial = (cur as { partial?: unknown }).partial ?? cur;
      parts.push(`cause: ${JSON.stringify(partial).slice(0, 400)}`);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(`cause: ${String(cur)}`);
      cur = undefined;
    }
  }
  return parts.join(' | ').slice(0, 500);
}

function suggestFor(cmd: TfCommand): string {
  if (cmd.name === 'tf-write') return '请换一个可写的路径重发（可换新 id 避免冲突），或修正文件内容后重试。';
  if (cmd.name === 'tf-bash') return '请检查命令本身（语法/依赖/工作目录），修正后重发，或改道用 tf-write 落地产物。';
  if (cmd.name === 'tf-read') return '请确认路径存在（可先用 tf-bash ls 查看），或改用其他来源。';
  if (cmd.name === 'tf-peek') return 'handle 必须来自句柄目录增量（obs:<family>:<callId>@v<version>），请核对后重发。';
  if (cmd.name === 'tf-code') {
    return '请按错误诊断修复程序体（语法/绑定参数/超时），换新 id 重发；简单场景可改道 tf-bash 或 tf-write。';
  }
  return '请根据失败原因修正后重发该命令（可换新 id）。';
}

function observationKey(cmd: TfCommand): string {
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
  revision: number,
  items: ReadonlyMap<string, { text: string; status: 'open' | 'verified'; evidence?: string }>,
  announced: ReadonlyMap<string, 'open' | 'verified'> | null,
): string | null {
  const lines: string[] = [];
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
  const added: string[] = [];
  const verified: string[] = [];
  const removed: string[] = [];
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

function blockTextOf(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'string') return block;
      if (block !== null && typeof block === 'object' && 'text' in block && typeof (block as { text?: unknown }).text === 'string') {
        return (block as { text: string }).text;
      }
      return JSON.stringify(block);
    }).join('\n');
  }
  return String(content);
}

function finishDetail(finish: FinishReasonLike): string {
  if (finish.kind === 'error') return `${finishCode(finish)}: ${finishMessage(finish)}`;
  return finishMessage(finish);
}

/** RenderMessage → GenerateOptions.messages 线格式（loop-built 请求：首条 system 携带系统提示）。 */
function toWireMessages(messages: readonly RenderMessage[]): StreamRequestOptions['messages'] {
  return messages.map((m) => ({ role: m.role, content: [{ type: 'text' as const, text: m.content }] }));
}

/**
 * 流归一化 shim（镜像 LlmRuntime.stream 的异常归一化契约，types.d.ts:456）。
 * 真实宿主路径不需要（ctx.llm.stream 已归一化）；离线直连适配器（mock）时使用。
 */
export function normalizeStreamShim(inner: AsyncIterable<StreamChunkLike>): AsyncGenerator<StreamChunkLike> {
  let finished = false;
  async function* run(): AsyncGenerator<StreamChunkLike> {
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
export function createSessionEventWriter(session: unknown): TurnEventWriter | undefined {
  const s = session as { append?: (type: string, data: unknown, opts?: unknown) => unknown } | undefined;
  if (s === undefined || typeof s.append !== 'function') return undefined;
  const append = (type: string, data: unknown, opts?: unknown): void => {
    s.append!(type, data, opts);
  };
  /** v0.3.1：带结算信息的 append（seq 供 assistant-stream end 帧配对）。 */
  const appendSettling = (type: 'assistant/message' | 'assistant/attempt', data: unknown, opts?: unknown): { eventType: 'assistant/message' | 'assistant/attempt'; seq?: number } => {
    const appended = s.append!(type, data, opts) as { seq?: number } | null | undefined;
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
            message: makeAssistantMessage(text, [], reasoning),
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
        message: makeAssistantMessage(text, toolCalls, reasoning),
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
        message: makeAssistantMessage('', calls),
        stream: [],
      }, { surfaceOp: 'append' });
    },
    repairToolCall(turn, step, callId) {
      // v0.3.0：派发异常后的生命周期闭合。先读会话快照确认事实，已有 result 就什么都不写
      // （重复 result 会让日志再次 corrupt）。
      const snap = (s as { snapshotEvents?: (from?: number) => readonly unknown[] }).snapshotEvents;
      const events = typeof snap === 'function' ? snap.call(s) : [];
      let started = false;
      let settled = false;
      for (const event of events) {
        const e = event as { type?: unknown; data?: { callId?: unknown; message?: { toolCallId?: unknown } } };
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
        message: makeAssistantMessage(text),
        stream: [],
      }, { surfaceOp: 'append' });
    },
    toolLog(turn, step) {
      return { turn, step };
    },
  };
}

type AssistantContentBlock = { type: 'text'; text: string } | { type: 'reasoning'; text: string } | { type: 'tool-call'; id: string; name: string; arguments: string };

function makeAssistantMessage(text: string, toolCalls: readonly ToolCallAdvertisement[] = [], reasoning?: string): { id: string; role: 'assistant'; content: AssistantContentBlock[]; source: { kind: 'model' } } {
  const content: AssistantContentBlock[] = [];
  // v0.3.1：reasoning 块在首位（镜像内建 BlockAssembler 的流序：思考先于正文）。
  if (reasoning !== undefined && reasoning.trim() !== '') content.push({ type: 'reasoning', text: reasoning });
  if (text.length > 0) content.push({ type: 'text', text });
  for (const call of toolCalls) content.push({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments });
  return {
    id: randomUUID(),
    role: 'assistant',
    content,
    source: { kind: 'model' },
  };
}

// ---------------------------------------------------------------------------
// ③ StreamLoopAgent —— duck-typed Agent（dsh-agent/lib/types/runtime-types.d.ts 的运行面）
// ---------------------------------------------------------------------------

export interface StreamLoopAgentDeps {
  id: string;
  session: unknown; // 真实宿主 = dsh-session Session（duck-type：.id / .append / .seq）
  driver: SingleStreamDriver;
  /** 持久化句柄（真实宿主 createStoredSession/resume 的产物；dispose 时关闭） */
  storedHandle?: { close(): Promise<void> } | undefined;
  /** AgentOptions 的模型路由（headless 传入 agentOptions = {...selection}） */
  modelSelection?: { provider: string; model: string; reasoningEffort?: string };
  /** 宿主 ctx（ownerCtx，cordis 上下文）：宿主工具管线读 agent.ctx.fiber.assertActive()
   * 与 agent.ctx 服务面（dsh-working-directory/lib/index.js:97 实证）。缺省 = 工具批
   * 不带 agent（独立执行），fs 工具的 session 解析会失败——2026-11-15 真连 W1 教训。 */
  ctx?: unknown;
  /** 宿主同源 dsh-scope 模块（桌面端）：构造时以 agent 实例本身为 key 铸造作用域——
   *  镜像内建 createScope(loopCtx, this)；宿主工具执行器 selectExecutor(input.agent) 与
   *  守卫 chainLayers(exec.agent) 按 scopeChainOf(agent) 选层，key 不是 agent 实例时
   *  preset 层工具（write/edit/pwsh）永远解析不到。缺省（headless/fake host）不铸造。 */
  scopeModule?: DshScopeLike;
  onWarning?: (message: string, detail?: unknown) => void;
}

/**
 * StreamLoopAgent：headless 消费的最小运行面（dsh-headless/lib/index.js:336-376 实测）：
 *   .id / .session / .status / .model / .whenIdle() / .followup(message) /
 *   .cancel(cause, options?) / .ctx（工具管线用）。
 * 不是 Cordis Service（本地插件无 cordis 副本可用，见文件头）；生命周期由工厂的 dispose 承担。
 */
export class StreamLoopAgent {
  readonly id: string;
  readonly session: unknown;
  readonly ctx: unknown;
  readonly #driver: SingleStreamDriver;
  readonly #storedHandle?: { close(): Promise<void> };
  readonly #warning: (message: string, detail?: unknown) => void;
  readonly #inbox: Array<{ text: string; message: unknown }> = [];
  #status: 'idle' | 'running' = 'idle';
  #running: Promise<void> | undefined;
  #cancelCause: { cause: unknown; keepInbox: boolean } | undefined;
  #selection: { provider: string; model: string; reasoningEffort?: string };
  #disposeScope: (() => Promise<void>) | undefined;
  #disposed = false;

  constructor(deps: StreamLoopAgentDeps) {
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

  get status(): 'idle' | 'running' {
    return this.#status;
  }

  /** dsh-agent runtime-types.d.ts:46-64 Model 面。 */
  get model(): {
    current(): Readonly<{ provider: string; model: string; reasoningEffort?: string }> | undefined;
    select(selection: { provider: string; model: string; reasoningEffort?: string }): void;
  } {
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
  followup(message: { content: readonly { type: string; text?: string }[]; source?: unknown; id?: string; role?: string }): void {
    if (this.#disposed) throw new Error(`agent "${this.id}": followup after dispose`);
    const text = message.content
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
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
  steer(message: { content: readonly { type: string; text?: string }[]; source?: unknown; id?: string; role?: string }): void {
    if (this.#disposed) throw new Error(`agent "${this.id}": steer after dispose`);
    const text = message.content
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block && typeof (block as { text?: unknown }).text === 'string' ? (block as { text?: unknown }).text : ''))
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

  /** 桌面端空内容续跑路径读取的 inbox 面（prompt:37548）。修复限制 2 后：
   *  nextStep 如实暴露尚未消费的 steer（已注入装配历史的从队列移除）；
   *  nextTurn 恒为空（单流没有跨回合排队注入）。 */
  get inbox(): { nextTurn: unknown[]; nextStep: unknown[] } {
    return { nextTurn: [], nextStep: [...this.#driver.pendingSteerMessages] };
  }

  /** 桌面端维护包裹（prompt/agent 生命周期路径）。无独立维护面 → 直通透传。 */
  runMaintenance<T>(operation: () => T | Promise<T>): T | Promise<T> {
    return operation();
  }

  /** dsh-agent runtime-types.d.ts:191 whenIdle：回合与队列全部落定后 resolve。 */
  whenIdle(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    return Promise.resolve();
  }

  /** dsh-agent runtime-types.d.ts:184 cancel。keepInbox 缺省 true（保留待处理输入）。 */
  cancel(cause: unknown, options?: { keepInbox?: boolean }): void {
    const keepInbox = options?.keepInbox ?? true;
    this.#cancelCause = { cause, keepInbox };
    this.#driver.cancel(cause);
    if (!keepInbox) this.#inbox.length = 0;
  }

  /** 取消并释放（工厂 dispose 的内部路径）。 */
  async dispose(): Promise<void> {
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
  #startNextTurn(): void {
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

  #appendSessionEvent(type: string, data: unknown, opts?: { surfaceOp?: 'append' }): void {
    const session = this.session as { append?: (t: string, d: unknown, o?: unknown) => unknown } | undefined;
    if (session === undefined || typeof session.append !== 'function') return;
    try {
      const appended = session.append(type, data, opts);
      debugTrace('session.append', { type, seq: (appended as { seq?: number } | undefined)?.seq });
    } catch (error) {
      this.#warning(`agent "${this.id}": 会话事件 ${type} 写入失败（fail-open 继续，事实见内存台账）`, error);
    }
  }
}

// ---------------------------------------------------------------------------
// ④ createStreamAgentFactory —— AgentFactory（dsh-agent/lib/types/index.d.ts:155-190）
// ---------------------------------------------------------------------------

export interface SessionsServiceLike {
  prepare(id: string, opts?: { meta?: unknown; seed?: readonly unknown[]; inheritedEventCount?: number; eventState?: unknown }): unknown;
  enter?(session: unknown): () => void;
  announce?(session: unknown): void;
}

/**
 * sessions.prepare() 返回原始 Session（rc.3 实测：内建 loop 用 SessionPreparation.create
 * 包一层才得到 {session, [dispose]}，dsh-session/lib/index.js:949-973）。这里归一化两种形态。
 */
function normalizePreparation(raw: unknown): { session: unknown; [Symbol.dispose]?: () => void } {
  if (raw !== null && typeof raw === 'object' && 'session' in (raw as Record<string, unknown>)) {
    return raw as { session: unknown; [Symbol.dispose]?: () => void };
  }
  return { session: raw };
}

export interface AgentsRegistryLike {
  enter?(agent: unknown, owner: unknown): () => void;
  announce?(agent: unknown, source: string, signal?: AbortSignal): Promise<void>;
}

export interface AgentOptionsLike {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

interface StoredLike {
  handle: { close(): Promise<void> };
  storedCount: number;
}

/**
 * 会话持久化面（宿主 sessionPersistence 与本地 JSONL 降级实现的结构公共面）。
 * 形状逐字段对应 initialize 内的 duck-type 用法（create/open/append/read/header）。
 */
export interface SessionPersistenceLike {
  create(header: unknown, opts?: { inheritedEventCount?: number; signal?: AbortSignal }): Promise<{
    close(): Promise<void>;
    append?(events: readonly unknown[]): Promise<void>;
    read?(from: number): Promise<{ events: readonly unknown[]; eventState?: unknown }>;
    header?: unknown;
    inheritedEventCount?: number;
  }>;
  open(id: string, mode: string, opts?: { signal?: AbortSignal }): Promise<{
    close(): Promise<void>;
    append?(events: readonly unknown[]): Promise<void>;
    read?(from: number): Promise<{ events: readonly unknown[]; eventState?: unknown }>;
    header?: unknown;
    inheritedEventCount?: number;
  }>;
}

export interface StreamAgentFactoryDeps {
  /** 宿主 ctx（duck-type：sessions / agents / get() 服务读取） */
  ctx: {
    sessions?: SessionsServiceLike;
    agents?: AgentsRegistryLike;
    get?(service: string): unknown;
    effect?(fn: () => () => void, name?: string): unknown;
  };
  /** 每次 agent 创建时构造驱动器（session 已就绪；依赖注入点：离线注 mock 流，宿主注 ctx.llm.stream） */
  createDriver(agent: { sessionId: string; agentOptions: AgentOptionsLike; session: unknown }): { driver: SingleStreamDriver };
  /** 修复限制 3：宿主 sessionPersistence 缺位时的本地 JSONL 持久化工厂。
   *  缺省 = 不降级（create 不落盘、resume 报结构化错误——v0.1 行为）。 */
  createFallbackPersistence?(sessionId: string): SessionPersistenceLike | undefined;
  /** 修复限制 4：bundle 形态 plugin record 通道不可达时的本地文件台账工厂。
   *  缺省 = 降级易失内存台账（v0.1 行为）。 */
  fallbackLedger?(sessionId: string): FileLedgerFallback | undefined;
  onWarning?: (message: string, detail?: unknown) => void;
}

export interface CreateAgentOptionsLike {
  sessionId: string;
  parentAgent?: unknown;
  meta?: unknown;
  seed?: readonly unknown[];
  inheritedEventCount?: number;
  agentOptions?: AgentOptionsLike;
  signal?: AbortSignal;
  setup?: (agentCtx: unknown, agent: StreamLoopAgent) => unknown;
}

export interface ResumeAgentOptionsLike {
  resumeSessionId: string;
  parentAgent?: unknown;
  agentOptions?: AgentOptionsLike;
  signal?: AbortSignal;
  setup?: (agentCtx: unknown, agent: StreamLoopAgent) => unknown;
}

export interface AgentHandleLike {
  agent: StreamLoopAgent;
  dispose(): Promise<void>;
}

function assertSessionId(id: string): void {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error(`[stream-loop] sessionId must be a non-empty string, got ${String(id)}`);
  }
}

// ---------------------------------------------------------------------------
// dsh-scope 作用域获取（桌面端 Agent preset 绑定的硬要求）
// ---------------------------------------------------------------------------

export interface DshScopeLike {
  createScope(ctx: unknown, key: unknown, options?: { parent?: unknown }): {
    ctx: unknown;
    rawDispose(): void | Promise<void>;
    dispose(): Promise<void>;
  };
}

async function unwrapScopeModule(mod: unknown): Promise<DshScopeLike | undefined> {
  const m = mod as { createScope?: unknown; default?: { createScope?: unknown } };
  if (typeof m?.createScope === 'function') return m as DshScopeLike;
  if (typeof m?.default?.createScope === 'function') return m.default as DshScopeLike;
  return undefined;
}

let dshScopeCache: Promise<DshScopeLike | undefined> | undefined;
const hostModuleCache = new Map<string, Promise<unknown | undefined>>();

/** 获取宿主同源的模块（bundle 形态下 bare import 不可达，必须走宿主 loader 的 internal 通道）：
 *  ① entry ctx 的 loader.import（bare 名走 loader 的 internal 通道 → 宿主副本）；
 *  ② loader.internal.import 直达；
 *  ③ 普通 dynamic import（本地 node_modules 形态可用；bundle 形态解析失败）。
 *  全部失败返回 undefined（调用方按需降级/fail-open）。 */
async function acquireHostModule(ctx: unknown, specifier: string): Promise<unknown | undefined> {
  const cached = hostModuleCache.get(specifier);
  if (cached !== undefined) return cached;
  const operation = (async (): Promise<unknown | undefined> => {
    const anyCtx = ctx as {
      loader?: {
        import?(id: string): Promise<unknown>;
        internal?: { import?(id: string, base?: unknown, opts?: unknown): Promise<unknown> };
      };
    };
    // v0.2.1：loader 是可选服务——Cordis 下裸读会抛 "cannot get property ... without inject"，
    // 必须走安全探测（cordis-compat.ts 顶部记录了完整事故链）。
    const loader = getService<NonNullable<typeof anyCtx.loader>>(ctx, 'loader');
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
async function acquireDshScope(ctx: unknown): Promise<DshScopeLike | undefined> {
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
export function createStreamAgentFactory(deps: StreamAgentFactoryDeps): {
  createAgent(ownerCtx: unknown, options: CreateAgentOptionsLike): Promise<AgentHandleLike>;
  resume(ownerCtx: unknown, options: ResumeAgentOptionsLike): Promise<AgentHandleLike>;
} {
  const warning = deps.onWarning ?? (() => {});

  async function initialize(ownerCtx: unknown, args: {
    sessionId: string;
    prepareOpts: { meta?: unknown; seed?: readonly unknown[]; inheritedEventCount?: number; eventState?: unknown };
    /** createAgent 路径：传入 persistence，句柄在 initialize 内用同一 preparation 建（镜像内建顺序） */
    persistence?: { create(header: unknown, opts?: { inheritedEventCount?: number; signal?: AbortSignal }): Promise<{ close(): Promise<void> }> } | undefined;
    /** persistence 是否为本地 JSONL 降级实现（是 → 会话事件镜像落 JSONL，修复限制 3） */
    persistenceIsFallback?: boolean;
    /** 修复限制 4：plugin record 通道不可达时的本地文件台账（按 session 落 JSONL，可重放） */
    fallbackLedger?: FileLedgerFallback | undefined;
    /** resume 路径：句柄已打开（read 已完成），直接携带 */
    stored?: StoredLike | undefined;
    agentOptions: AgentOptionsLike;
    setup?: (agentCtx: unknown, agent: StreamLoopAgent) => unknown;
    source: 'startup' | 'resume';
    parentAgent?: unknown;
    signal?: AbortSignal;
  }): Promise<AgentHandleLike> {
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
            handle: await args.persistence.create((preparation.session as { header?: unknown }).header, {
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
          const open = (args.persistence as {
            open?(id: string, mode: string, opts?: { signal?: AbortSignal }): Promise<{
              close(): Promise<void>;
              read(from: number): Promise<{ events: readonly unknown[]; eventState?: unknown }>;
              header: unknown;
              inheritedEventCount?: number;
            }>;
          }).open;
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
      let driverSession: unknown = preparation.session;
      if (args.persistenceIsFallback === true && stored !== undefined) {
        const storedHandle = stored.handle;
        driverSession = withEventCapture(preparation.session, {
          appendEvents: (events) => {
            void storedHandle.append?.(events as never)?.catch?.((error: unknown) => {
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
        onWarning: warning,
      });
      debugTrace('agent.constructed');
      driver.setAgent(agent);

      // 镜像内建 appendUnstoredSuffix（initializeAgent 进入公告前调用）：prepare 的 seed
      // 会在会话内补 session/end-seed 占位事件（seq = seed 长度）。这批内存 suffix 必须
      // 立刻落盘对齐 handle cursor，否则宿主 checkpoint flush（ctx.sessions.flush）从
      // 占位事件之后起批 → "append seq mismatch"（桌面端 resume 后首个模型请求即死）。
      if (stored !== undefined) {
        const snap = preparation.session as { snapshotEvents?(offset: number): Array<unknown> } | undefined;
        const suffix = typeof snap?.snapshotEvents === 'function' ? snap.snapshotEvents(stored.storedCount) : [];
        if (suffix.length > 0) {
          await stored.handle.append(suffix as never);
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
      if (setupCommit !== undefined && setupCommit !== null && typeof (setupCommit as { commit?: () => void }).commit === 'function') {
        (setupCommit as { commit: () => void }).commit();
      }

      // agent 公告（镜像内建 :1578-1579；AgentRegistry.enter/announce 无 brand 校验，duck-type 可通行）
      const agents = deps.ctx.agents;
      const detachAgent = agents?.enter?.(agent, args.parentAgent);
      if (agents?.announce !== undefined) {
        await agents.announce(agent, args.source, args.signal);
      }
      debugTrace('agent.announced');

      const dispose = async (): Promise<void> => {
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
      let persistence = deps.ctx.get?.('sessionPersistence') as SessionPersistenceLike | undefined;
      let persistenceIsFallback = false;
      if ((persistence === undefined || typeof (persistence as { create?: unknown }).create !== 'function') && deps.createFallbackPersistence !== undefined) {
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
      let persistence = deps.ctx.get?.('sessionPersistence') as SessionPersistenceLike | undefined;
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
  seed: readonly unknown[] | undefined,
  ledgerFile: string | undefined,
  warn?: (message: string, detail?: unknown) => void,
): Array<{ kind: string; data: unknown }> {
  const records: Array<{ kind: string; data: unknown }> = [];
  if (seed !== undefined) {
    for (const event of seed) {
      if (event === null || typeof event !== 'object') continue;
      const e = event as { type?: unknown; data?: unknown };
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
  driver: SingleStreamDriver,
  session: unknown,
  warn?: (message: string, detail?: unknown) => void,
  ctx?: unknown,
  fallback?: FileLedgerFallback,
): Promise<void> {
  try {
    const mod = (await acquireHostModule(ctx, '@deepseek-ai/dsh-session')) as {
      appendPluginRecord?(session: unknown, type: string, data: unknown): number;
    } | undefined;
    if (mod === undefined || typeof mod.appendPluginRecord !== 'function') throw new Error('appendPluginRecord 导出缺失');
    driver.attachLedger({
      record(type, data) {
        mod.appendPluginRecord!(session, type, data);
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

export interface LoopEntryConfig {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  maxParallelToolCalls?: number;
  maxReentries?: number;
  streamIdleTimeoutMs?: number;
  budgetTokens?: number;
  nativeToolSchemas?: string;
  systemPrompt?: string;
  protocolText?: string;
  invariants?: string;
  /** 自写回验策略（修复限制 1）：'receipt'（默认）| 'full' —— 见 StreamDriverConfig.selfReadFeedback */
  selfReadFeedback?: 'receipt' | 'full';
  /** tf-code 程序化通道（PTC 桥接）。K1（0.3.0）：**默认关闭**；显式 true 且宿主挂载
   *  @deepseek-ai/dsh-ptc-runtime 才启用（协议文本才声明 tf-code 段）。粒度是装配/模式级，
   *  不做会话级动态开关（协议段构造期冻结）。 */
  enableCode?: boolean;
  /** K5：tf-code 配额三项硬限制（maxSubcalls / maxOutputBytes / maxWallMs；缺省 DEFAULT_CODE_QUOTA） */
  codeQuota?: CodeQuota;
  /** F3：tf-code 结果完整注入上限（字符；缺省 DEFAULT_CODE_VALUE_INJECT_LIMIT，仅 opt-in 生效） */
  codeValueInjectLimit?: number;
  /** F4：原生 tool_call 结果单块注入上限（字符；缺省 DEFAULT_NATIVE_RESULT_LIMIT，
   *  仅声明 nativeToolSchemas 时生效） */
  nativeResultLimit?: number;
  /** F5：计划与验收开关（默认 true；false 关闭 tf-plan/accepts/验收拦截——回退点） */
  enablePlan?: boolean;
  /** F6：写前意图日志开关（默认 true；false = 不落盘、不做 resume 核对——回退点） */
  enableIntents?: boolean;
  /** F6：resume 时"有意图无回执"的策略：'halt'（默认，停机核对）/ 'ignore'（只告警不阻断） */
  resumeIntentPolicy?: 'halt' | 'ignore';
  /** F7：长会话段边界阈值（追加区字符数；0/负数关闭；缺省 DEFAULT_SEGMENT_MAX_CHARS） */
  segmentMaxChars?: number;
  /** tf-code 默认超时（毫秒）；缺省 = 宿主 provider 默认 */
  codeTimeoutMs?: number;
  /** v0.4.0 工具面档位（P1）：'core' | 'standard'（默认）| 'full' | 'off'（0.3.x 回退点） */
  toolSurface?: string;
  /** v0.4.0 原生通道开关（默认 false——§15 默认文本；schema token 成本见 StreamDriverConfig.nativeTools） */
  nativeTools?: boolean;
  /** v0.4.0 tf-call 通用调用通道（默认 true；toolSurface=off 强制关） */
  callCommand?: boolean;
  /** v0.4.0 toolSet 准入收紧（R5：beta 默认 false；P6 复跑后再默认开） */
  strictAdmission?: boolean;
  /** v0.4.0 模式切换（P4）：控制页/CLI 暴露 PresetRouter（空白会话三向切换；已开回合具名失败） */
  presetRouter?: boolean;
  /** 修复限制 3/4：宿主缺 storage/sessionPersistence/plugin record 模块时的本地文件持久化兜底
   *  （JSONL 会话日志 + 文件台账 + 本地 KvUnit）。默认开启；false = 维持 v0.1 内存降级行为。 */
  persistFallback?: boolean;
  /** 本地持久化状态根目录（缺省 env STREAM_AGENT_STATE_DIR → ~/.dsh-stream-agent） */
  stateDir?: string;
  /** 控制栏模式（v0.2.1）：balanced / lean / compat / power；缺省读 control.json → balanced */
  mode?: string;
  /** 控制栏语言：zh / en（只影响控制栏文案，不影响协议） */
  lang?: string;
  /** 接管自证：注册成功后向 stderr 打一行横幅（探针 A 实测 preset 激活对 CLI 静默，排障只能靠插件自证日志） */
  announceTakeover?: boolean;
}

/** v0.4.0：装配 config 的工具面档位归一（未知值回 standard + 告警由调用方负责；'off' = 0.3.x 回退点）。 */
export function asSurfaceProfile(value: string | undefined): SurfaceProfile {
  return value === 'core' || value === 'standard' || value === 'full' || value === 'off' ? value : 'standard';
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
export default function apply(ctx: {
  agents?: AgentsRegistryLike & { setFactory?(factory: unknown): () => void };
  llm?: { stream(options: StreamRequestOptions): AsyncIterable<StreamChunkLike> };
  tools?: { execute(input: ToolBatchInputLike): Promise<ToolBatchResultLike> };
  get?(service: string): unknown;
  effect?(fn: () => () => void, name?: string): unknown;
}, config: LoopEntryConfig = {}): { factory: ReturnType<typeof createStreamAgentFactory>; dispose: () => void } {
  const logger = getService<{ warn?(message: string): void }>(ctx, 'logger');
  const warning = (message: string, detail?: unknown): void => {
    // 红线 5：告警走宿主 logger（可用时），否则 console.error —— 都不静默
    const text = `[stream-loop] ${message}${detail === undefined ? '' : ` :: ${detailString(detail)}`}`;
    if (logger?.warn !== undefined) logger.warn(text);
    else console.error(text);
  };

  // v0.2.1：全部服务读取走 getService —— Cordis 对未 inject 的属性裸读会抛
  // "cannot get property ... without inject"，v0.2.0 因此整层接管未激活（见 cordis-compat.ts）。
  const llm = getService<{ stream(options: StreamRequestOptions): AsyncIterable<StreamChunkLike> }>(ctx, 'llm');
  // v0.4.0：tools 服务取全量面（resolve/schemas 给 ToolSurface；execute 给工具批）
  const tools = getService<{ execute(input: ToolBatchInputLike): Promise<ToolBatchResultLike>; resolve?(context: unknown): unknown; schemas?(scope: unknown, toolSet?: unknown): unknown }>(ctx, 'tools');
  if (llm === undefined || typeof llm.stream !== 'function') {
    throw new Error('[stream-loop] ctx.llm.stream 不可用：entry 挂载失败（需要 dsh-llm 服务在位）');
  }
  if (tools === undefined || typeof tools.execute !== 'function') {
    throw new Error('[stream-loop] ctx.tools.execute 不可用：entry 挂载失败（需要 dsh-tools 服务在位）');
  }

  // 默认模型三级回退：agentOptions（宿主 agentDefaultModel 惰性 getter）→ entry config →
  // 宿主 agentDefaultModel → 最后兜底。桌面端部署常只挂 deepseek-account 路由，
  // 硬编码 deepseek-official/deepseek-chat 会请求到无凭据的路由。
  const agentDefaultModel = getService<{ currentSelection?(): { provider?: string; model?: string; reasoningEffort?: string } }>(ctx, 'agentDefaultModel');
  const defaultSelection = agentDefaultModel?.currentSelection?.() ?? {};
  const stateRoot = resolveStateDir(config.stateDir);
  // 控制栏模式（v0.2.1）：显式 config.mode > STREAM_AGENT_MODE > control.json > balanced。
  // 模式只提供默认值，下面每个字段都用 `config.X ?? preset.X` —— 显式装配永远压过模式。
  const control = resolveControlState({ mode: config.mode, lang: config.lang }, config.stateDir, warning);
  // 每次新建 agent 时重算：桌面控制页可以在不重启的情况下切模式，
  // 已有的 driver 保持创建时的参数（会话内不突变），新会话拿到新参数。
  const resolveEffective = (): {
    selfReadFeedback: 'receipt' | 'full';
    enableCode: boolean | undefined;
    persistFallback: boolean;
    maxParallelToolCalls: number;
    maxReentries: number;
    budgetTokens: number | undefined;
    toolSurface: ReturnType<typeof asSurfaceProfile>;
  } => {
    const preset = modeConfig(control.mode);
    return {
      selfReadFeedback: config.selfReadFeedback ?? preset.selfReadFeedback,
      // 'auto' = 交给 codeExecutor 是否存在决定（保持 v0.2.0 的"宿主有 PTC 就开"语义）
      enableCode: config.enableCode ?? (preset.enableCode === 'auto' ? undefined : preset.enableCode),
      persistFallback: config.persistFallback ?? preset.persistFallback,
      maxParallelToolCalls: config.maxParallelToolCalls ?? preset.maxParallelToolCalls,
      maxReentries: config.maxReentries ?? preset.maxReentries,
      budgetTokens: config.budgetTokens ?? preset.budgetTokens,
    toolSurface: asSurfaceProfile(config.toolSurface ?? preset.toolSurface),
    };
  };
  const effective = resolveEffective();
  // 修复限制 3/4：本地持久化兜底（默认开启；模式或 config.persistFallback === false 关闭）
  const persistFallbackEnabled = effective.persistFallback !== false;
  // 0.2.0 PTC 桥接：ctx.ptcRuntime 在位（形状校验通过）→ tf-code 通道可用；
  // 形状不符或缺失 → 通道关闭（协议文本不声明 tf-code），告警不静默（红线 5）。
  // v0.2.1：ptcRuntime 是可选服务，只经 getService 探测（裸读即装载期抛错）。
  const ptcRuntime = getService<unknown>(ctx, 'ptcRuntime');
  // v0.4.0（P5）：当前会话驱动器引用（createDriver 闭包回填；tf-code 全绑定按面生成）。
  const currentDriverRef: { driver?: { surfaceNames(): readonly string[] } } = {};
  const codeExecutor = looksLikePtcRuntime(ptcRuntime)
    ? createCodeExecutor(ptcRuntime, { executeTools: (input) => tools.execute(input as never) })
    : undefined;
  if (ptcRuntime !== undefined && codeExecutor === undefined) {
    warning('ctx.ptcRuntime 形状不符（缺 resolve/run），tf-code 通道关闭（fail-open，其余行为不变）', ptcRuntime);
  }
  const factory = createStreamAgentFactory({
    ctx: ctx as unknown as StreamAgentFactoryDeps['ctx'],
    createFallbackPersistence: persistFallbackEnabled
      ? (sessionId) => createJsonlPersistence(join(stateRoot, 'sessions'), sessionId, warning)
      : undefined,
    fallbackLedger: persistFallbackEnabled
      ? (sessionId) => {
          const file = ledgerFileOf(stateRoot, sessionId);
          return { file, appendRecord: (type: string, data: unknown) => appendLedgerRecord(file, type, data) };
        }
      : undefined,
    createDriver({ agentOptions, session, sessionId }) {
      const live = resolveEffective();
      const cfg: StreamDriverConfig = {
        provider: agentOptions.provider || config.provider || defaultSelection.provider || '',
        model: agentOptions.model || config.model || defaultSelection.model || '',
        reasoningEffort: agentOptions.reasoningEffort ?? config.reasoningEffort ?? defaultSelection.reasoningEffort,
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
        // v0.4.0 工具面（P1/P2）：档位缺省 standard（对等优先，§16 决议 2）；nativeTools
        // 缺省关（§15 默认文本）；strictAdmission 缺省关（R5，P6 再收紧）
        toolSurface: live.toolSurface,
        nativeTools: config.nativeTools === true,
        callCommand: config.callCommand !== false,
        strictAdmission: config.strictAdmission === true,
      };
      // F6 恢复意图：意图日志端口（fsync 落盘；enableIntents: false 关闭——回退点）。
      // 写前意图在派发前落盘、写后回执落定即记；崩溃后"有意图无回执"= 写入可能已发生。
      const intentsEnabled = config.enableIntents !== false;
      const intentBook = new Map<string, number>();
      const intentFile = sessionId !== undefined && sessionId !== '' ? intentFileOf(stateRoot, sessionId) : undefined;
      const loadIntentState = (): { seq: number } => {
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
          ...(tools === undefined ? {} : { toolsService: tools as unknown as ToolsServiceLike }),
          ...(codeExecutor === undefined ? {} : { executeCode: codeExecutor }),
          // v0.3.1 思考过程实时帧：宿主事件总线在位（cordis ctx.emit）才接线；
          // 发射契约由驱动器保证（revision/index 递增、异常熔断），宿主无监听器时是 no-op。
          ...(typeof (ctx as { emit?: unknown }).emit === 'function'
            ? {
                emitHostEvent: (event: string, payload: unknown) => {
                  (ctx as { emit: (name: string, payload: unknown) => void }).emit(event, payload);
                },
              }
            : {}),
          ...(intentsEnabled && intentFile !== undefined
            ? {
                onIntent: (event: { cmdId: string; op: 'write' | 'edit' | 'append'; path: string; fingerprint: string }) => {
                  intentSeqState.seq += 1;
                  intentBook.set(event.cmdId, intentSeqState.seq);
                  appendIntentRecord(intentFile!, { type: 'intent', seq: intentSeqState.seq, at: new Date().toISOString(), sessionId: sessionId ?? '', ...event });
                },
                onIntentReceipt: (event: { cmdId: string; ok: boolean; detail?: string }) => {
                  const intentSeq = intentBook.get(event.cmdId) ?? -1;
                  intentSeqState.seq += 1;
                  appendIntentRecord(intentFile!, { type: 'receipt', seq: intentSeqState.seq, at: new Date().toISOString(), intentSeq, ok: event.ok, ...(event.detail === undefined ? {} : { detail: event.detail }) });
                },
              }
            : {}),
          events: createSessionEventWriter(session),
          onWarning: warning,
        },
        cfg,
      );
      currentDriverRef.driver = driver;
      // K2：会话工作区解析（tf-code resolve 透传用）。会话 header.cwd（会话原始目录）
      // 优先，缺省回退宿主 workingDirectory 服务的部署默认目录；两者都不可得则不传，
      // 由宿主按自己的默认语义解析。插件不复制宿主的优先级规则。
      const headerCwd = (session as { header?: { cwd?: unknown } } | undefined)?.header?.cwd;
      const workingDirectory = getService<{ defaultDirectory?: string }>(ctx, 'workingDirectory');
      const resolvedCwd = typeof headerCwd === 'string' && headerCwd !== ''
        ? headerCwd
        : (workingDirectory?.defaultDirectory !== undefined ? workingDirectory.defaultDirectory : undefined);
      driver.setSessionCwd(resolvedCwd);
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

  const agents = getService<AgentsRegistryLike & { setFactory?(factory: unknown): () => void }>(ctx, 'agents');
  if (agents === undefined || typeof agents.setFactory !== 'function') {
    throw new Error('[stream-loop] ctx.agents.setFactory 不可用：无法接管 agent 创建（需要 dsh-agent 服务在位）');
  }
  // S3 双 loop 具名诊断（0.3.0-beta.1）：setFactory 是全局唯一槽位，内建 agent-loop 未被
  // 停用时宿主抛裸错 "an agent factory is already registered"。转换为 E_DOUBLE_LOOP：
  // 带 profile 标识、冲突来源与处置建议——冲突必须具名失败，不 catch 后继续、不重试、
  // 不靠装载顺序"碰巧"获胜（C2 单 loop 权威）。
  const profileName = resolveProfileName(ctx);
  let detachFactory: (() => void) | undefined;
  try {
    detachFactory = agents.setFactory(factory);
  } catch (error) {
    throw doubleLoopError(error, profileName);
  }
  // 接管事实登记：控制栏据此写"接管生效"或"未接管"
  markTakeover(control.mode);

  // v0.2.1 桌面控制页的宿主面：只暴露"读状态 / 切模式 / 切语言"三件事。
  // UI 是独立子包（ui/），经同源 HTTP 路由调用本服务；服务不存在时 UI 降级为只读诊断。
  const controlStatus = (): Record<string, unknown> => {
    const live = resolveEffective();
    const persisted = readPersistedControl(config.stateDir);
    return {
      version: VERSION,
      takeover: true,
      mode: control.mode,
      modeSource: control.modeSource,
      modeLocked: control.modeSource === 'config' || control.modeSource === 'env',
      lang: control.lang,
      langSource: control.langSource,
      langLocked: control.langSource === 'config' || control.langSource === 'env',
      effective: {
        selfReadFeedback: live.selfReadFeedback,
        enableCode: live.enableCode === undefined ? false : live.enableCode,
        persistFallback: live.persistFallback,
        maxParallelToolCalls: live.maxParallelToolCalls,
        maxReentries: live.maxReentries,
        budgetTokens: live.budgetTokens ?? null,
        toolSurface: live.toolSurface,
      },
      modes: publicModeCatalog(),
      updatedAt: persisted.updatedAt ?? null,
      stateFile: control.file,
    };
  };
  const applyMode = (next: string): { ok: boolean; code?: string; persisted?: boolean } => {
    if (!isModeId(next)) return { ok: false, code: 'invalid-mode' };
    if (control.modeSource === 'config' || control.modeSource === 'env') return { ok: false, code: 'locked' };
    control.mode = next;
    markTakeover(next);
    try {
      writePersistedControl({ mode: control.mode, lang: control.lang }, config.stateDir);
      control.modeSource = 'file';
      return { ok: true, persisted: true };
    } catch (error) {
      control.modeSource = 'runtime';
      warning(`控制栏模式已在本进程生效，但落盘失败（重启后会回到旧值）：${control.file}`, error);
      return { ok: true, persisted: false };
    }
  };
  const applyLang = (next: string): { ok: boolean; code?: string; persisted?: boolean } => {
    if (!isLang(next)) return { ok: false, code: 'invalid-lang' };
    if (control.langSource === 'config' || control.langSource === 'env') return { ok: false, code: 'locked' };
    control.lang = next;
    try {
      writePersistedControl({ mode: control.mode, lang: control.lang }, config.stateDir);
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
        setMode: applyMode,
        setLang: applyLang,
      });
    } catch (error) {
      warning('streamAgentRuntime 服务注册失败：桌面控制页降级为只读（loop 本体不受影响）', error);
    }
  }

  if (config.announceTakeover === true) {
    const codeState = codeExecutor === undefined
      ? 'code=off'
      : (resolveEffective().enableCode === true ? 'code=on(opt-in)' : 'code=off(default,K1)');
    console.error(`[stream-loop] TAKEOVER-ACTIVE: agent factory registered via setFactory (built-in agent-loop must be disabled by profile patch) · mode=${control.mode} (${control.modeSource}) · ${codeState} · profile=${profileName}`);
  }

  // 会话投影注册（桌面端硬依赖，内建 agent-loop 在 Service.init 注册——dsh-agent-loop rc.3:50110）：
  // 客户端模型选择器的 projected 数据面 = 服务端 modelSelection 投影；缺失时
  // dsh-client-ui-model-selection 的 syncInputs 永远停在 status:"loading"（"正在加载模型…"），
  // 会话列表/写作工具等也读该投影族。经宿主 loader 取同源 @deepseek-ai/dsh-agent 的导出注册。
  // fail-open（红线 5）：服务/模块/定义任一不可达 → 告警不静默，headless 行为不变。
  const sessionProjections = getService<{ register?(definition: unknown): Promise<unknown> }>(ctx, 'sessionProjections');
  if (sessionProjections === undefined || typeof sessionProjections.register !== 'function') {
    warning('ctx.sessionProjections.register 不可达：跳过 modelSelection 投影注册（headless 不受影响；桌面端客户端模型选择器会停在加载态）');
  } else {
    acquireHostModule(ctx, '@deepseek-ai/dsh-agent')
      .then((mod) => {
        const definition = (mod as { modelSelectionProjectionDefinition?: unknown } | undefined)?.modelSelectionProjectionDefinition;
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

  const dispose = (): void => {
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

function detailString(detail: unknown): string {
  if (detail instanceof Error) return detail.message;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/** S3：解析当前 profile 名（宿主 profileContext.dir 的 basename；测试桩/缺失时回退 env 与 unknown）。 */
function resolveProfileName(ctx: unknown): string {
  const dir = (ctx as { get?: (name: string) => unknown }).get?.('profileContext') as { dir?: unknown } | undefined;
  const raw = typeof (dir as { dir?: unknown } | undefined)?.dir === 'string' ? (dir as { dir: string }).dir : undefined;
  if (raw !== undefined && raw !== '') {
    const parts = raw.replace(/\\/g, '/').split('/').filter((p) => p !== '');
    const last = parts[parts.length - 1];
    if (last !== undefined && last !== '') return last;
  }
  const env = typeof process !== 'undefined' ? process.env['DSH_PROFILE'] : undefined;
  return env !== undefined && env !== '' ? env : 'unknown';
}

/** S3：把宿主的 setFactory 冲突裸错转换为 E_DOUBLE_LOOP 具名失败（fail-fast，不重试不静默）。 */
function doubleLoopError(original: unknown, profile: string): Error {
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

/** 诊断追踪（STREAM_LOOP_DEBUG=1 时向 stderr 打里程碑；生产默认关闭，不产生噪音）。 */
export function debugTrace(milestone: string, detail?: unknown): void {
  if (process.env.STREAM_LOOP_DEBUG !== '1') return;
  console.error(`[stream-loop:debug] ${milestone}${detail === undefined ? '' : ` :: ${detailString(detail)}`}`);
}
