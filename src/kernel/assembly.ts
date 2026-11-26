/**
 * kernel/assembly.ts —— 0.6.0 请求装配契约（计划 §4：AssemblyPlan 是请求内容的唯一事实源）。
 *
 * 设计约束（计划 §4.3）：
 *  - **纯函数**：同一状态连续投影 20 次逐字节一致（无时钟、无 IO、无随机）；
 *  - 块顺序固定：`channel → protocol → tools → invariants → state`（前缀缓存的结构前提）；
 *  - `system.hash` 只由块文本决定（可外部复算，用于对账/实测）；
 *  - `tools` 允许为 null（首请求 0 schema）；声明名 ≤ 7；
 *  - `reasoning` 是显式策略而非隐式行为（`provider-required` / `drop-stale`）；
 *  - `budget.estimatedInputTokens` 与 `overBy` 一起给出，发送前可 fail-closed。
 *
 * 内容寻址去重（RA-2）只作用于**历史投影**：超过 payloadMinChars 的载荷，第二次及以后
 * 只发 `[tf-payload ref=sha256:… chars=…]` 一行引用——原文仍在句柄目录里可取回，
 * 因此这不是"摘要改写"，是"同 sha 只保留一份"。
 *
 * 内核层纪律：零框架依赖、零 IO（哈希用 node:crypto，与 render.ts 一致）。
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

export type AssemblyRole = 'system' | 'user' | 'assistant';

export interface AssemblyBlock {
  /** 稳定块标识（channel / protocol / tools / invariants / state）。 */
  id: string;
  text: string;
  /** 稳定块（构造期冻结）= true；状态块（随回合变化）= false。 */
  stable: boolean;
}

export interface AssemblyMessage {
  role: AssemblyRole;
  content: string;
  /** 0.6.0（RA-2）：载荷引用（内容寻址）。指向同请求内已出现的原文块。 */
  ref?: string;
  /** 宿主侧不透明元数据（assistant 消息的 source 必须原样透传；内核不解释）。 */
  source?: unknown;
}

export interface AssemblyToolDecl {
  name: string;
  description: string;
  parameters: unknown;
}

export interface AssemblyBudget {
  estimatedInputTokens: number;
  limit: number;
  overBy: number;
}

export interface AssemblyPlan {
  system: { blocks: AssemblyBlock[]; hash: string };
  messages: AssemblyMessage[];
  tools: null | AssemblyToolDecl[];
  reasoning: 'provider-required' | 'drop-stale';
  budget: AssemblyBudget;
}

/** 稳定块顺序（写死，任何变化都必须显式改契约与金样）。 */
export const ASSEMBLY_BLOCK_ORDER = ['channel', 'protocol', 'tools', 'invariants', 'state'] as const;
export type AssemblyBlockId = (typeof ASSEMBLY_BLOCK_ORDER)[number];

/** 0.6.0（RA-3）：工具声明名上限（thinkflow A2 不变量：首请求 0 schema）。 */
export const MAX_DECLARED_TOOLS = 7;

/** 0.6.0（RA-2）：进入"内容寻址去重"的载荷门槛（字符）。 */
export const DEFAULT_PAYLOAD_MIN_CHARS = 2000;

// ---------------------------------------------------------------------------
// 纯函数：投影
// ---------------------------------------------------------------------------

export interface AssemblyHistoryBlock {
  role: AssemblyRole;
  content: string;
  /** 稳定的块标识（可选；给定时用于 ref 指向）。 */
  id?: string;
  /** 宿主侧不透明元数据（原样带到 AssemblyMessage.source）。 */
  source?: unknown;
}

export interface AssemblyInput {
  /** 通道文本（channel 块）。 */
  channel: string;
  /** 协议文本（protocol 块）。 */
  protocol: string;
  /**
   * 工具**说明文本**（system 里的 tools 块）。给出时它恒定不变（前缀稳定的前提）；
   * 缺省用声明面渲染（仅适用于"声明面不随请求变化"的场景）。
   */
  toolsBlock?: string;
  /** 工具声明面（请求的 tools 字段）；null = 本请求不声明（首请求/文本通道）。 */
  tools: readonly AssemblyToolDecl[] | null;
  /** 任务不变量（invariants 块）。 */
  invariants: string;
  /** 状态块（随回合变化：计划/验收/句柄目录摘要；缺省空）。 */
  state?: string;
  /** 历史（追加区，按序）。 */
  history: readonly AssemblyHistoryBlock[];
  /** 易变尾（每请求重建）。 */
  tail?: readonly AssemblyHistoryBlock[];
  /** reasoning 策略（缺省 provider-required）。 */
  reasoning?: 'provider-required' | 'drop-stale';
  /** 发送前预算上限（0 = 不限制）。 */
  budgetLimit?: number;
  /** 去重门槛（字符）。 */
  payloadMinChars?: number;
  /** token 估算器（缺省用 estimateTokensRaw：浮点，累加后统一 ceil）。 */
  estimate?: (text: string) => number;
}

/** 与 loop.estimatePromptTokens 同口径的粗估（ASCII/4 + CJK×0.7）。供内核独立使用。 */
export function estimateCharsToTokens(text: string): number {
  return Math.ceil(estimateTokensRaw(text));
}

/** 同一口径的浮点形态（逐条累加后再 ceil，避免每条各自上取整把总量抬高）。 */
export function estimateTokensRaw(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! >= 0x2e80) wide += 1;
    else ascii += 1;
  }
  return ascii / 4 + wide * 0.7;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 内容寻址引用行（RA-2）：模型看到的是"同一载荷已在上面出现过"，不是摘要。 */
export function payloadRefLine(hash: string, chars: number, blockId?: string): string {
  return `[tf-payload ref=sha256:${hash.slice(0, 16)} chars=${chars}${blockId === undefined ? '' : ` id=${blockId}`}]`
    + ' 同一载荷已在本请求前文出现，正文不重复发送；需要原文时用 tf-peek 按句柄取回。';
}

/** 工具声明面排序 + 截断（确定性：按名字典序；截断后仍可复算）。 */
export function projectToolDecls(
  tools: readonly AssemblyToolDecl[] | null,
  max = MAX_DECLARED_TOOLS,
): AssemblyToolDecl[] | null {
  if (tools === null) return null;
  if (tools.length === 0) return null;
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sorted.slice(0, Math.max(0, max));
}

/**
 * 唯一投影入口：把"状态"变成"请求内容"。
 * 纯函数：同一输入连续 20 次逐字节一致（测试钉死）。
 */
export function projectAssembly(input: AssemblyInput): AssemblyPlan {
  const estimate = input.estimate ?? estimateTokensRaw;
  const blockTexts: Record<AssemblyBlockId, string> = {
    channel: input.channel,
    protocol: input.protocol,
    tools: input.toolsBlock
      ?? (input.tools === null || input.tools.length === 0 ? '' : renderToolBlock(input.tools)),
    invariants: input.invariants,
    state: input.state ?? '',
  };
  const blocks: AssemblyBlock[] = ASSEMBLY_BLOCK_ORDER
    .filter((id) => blockTexts[id] !== '')
    .map((id) => ({ id, text: blockTexts[id], stable: id !== 'state' }));

  const systemText = blocks.map((b) => b.text).join('\n\n');
  const systemHash = sha256(blocks.map((b) => `${b.id}\u0000${b.text}`).join('\u0001'));

  // ---- 历史投影 + 内容寻址去重（RA-2）----
  const minChars = input.payloadMinChars ?? DEFAULT_PAYLOAD_MIN_CHARS;
  const seen = new Map<string, number>(); // sha → chars
  const messages: AssemblyMessage[] = [{ role: 'system', content: systemText }];
  for (const block of [...input.history, ...(input.tail ?? [])]) {
    const chars = block.content.length;
    if (chars >= minChars) {
      const hash = sha256(block.content);
      const first = seen.get(hash);
      if (first !== undefined) {
        messages.push({
          role: block.role,
          content: payloadRefLine(hash, first, block.id),
          ref: `sha256:${hash}`,
          ...(block.source === undefined ? {} : { source: block.source }),
        });
        continue;
      }
      seen.set(hash, chars);
    }
    messages.push({
      role: block.role,
      content: block.content,
      ...(block.id === undefined ? {} : { ref: `block:${block.id}` }),
      ...(block.source === undefined ? {} : { source: block.source }),
    });
  }

  // ---- 工具声明（RA-3）----
  const tools = projectToolDecls(input.tools);
  const toolsChars = tools === null ? 0 : JSON.stringify(tools).length;

  // ---- 发送前预算（RA-4）----
  const limit = input.budgetLimit ?? 0;
  // tools schema 是紧凑 JSON（ASCII）：按 4 字符/token 计，避免为估算构造大字符串。
  const estimated = Math.ceil(messages.reduce((n, m) => n + estimate(m.content), 0) + toolsChars / 4);
  const overBy = limit > 0 ? Math.max(0, estimated - limit) : 0;

  return {
    system: { blocks, hash: systemHash },
    messages,
    tools,
    reasoning: input.reasoning ?? 'provider-required',
    budget: { estimatedInputTokens: estimated, limit, overBy },
  };
}

function renderToolBlock(tools: readonly AssemblyToolDecl[]): string {
  const lines = tools.map((t) => `- ${t.name}: ${t.description}`);
  return ['[tools] 本请求声明的工具（其余工具按名调用，不需要预声明）：', ...lines].join('\n');
}

/** 序列化（逐字节可比）：用于"20 次投影一致"与 dry-run 对账。 */
export function serializeAssemblyPlan(plan: AssemblyPlan): string {
  return JSON.stringify({
    system: { blocks: plan.system.blocks.map((b) => ({ id: b.id, text: b.text, stable: b.stable })), hash: plan.system.hash },
    messages: plan.messages.map((m) => ({ role: m.role, content: m.content, ...(m.ref === undefined ? {} : { ref: m.ref }) })),
    tools: plan.tools,
    reasoning: plan.reasoning,
    budget: plan.budget,
  });
}

// ---------------------------------------------------------------------------
// 预算贡献项（RA-4：每次拒绝必须能说清"谁把预算吃掉了"）
// ---------------------------------------------------------------------------

export interface BudgetContribution {
  label: string;
  chars: number;
  tokens: number;
  /** 占比（0–1）；用于排序展示 */
  share: number;
}

/** 按块/消息给出贡献项（字符与 token 双口径，按 token 降序；最多 8 项）。 */
export function budgetContributions(plan: AssemblyPlan, opts: { maxItems?: number } = {}): BudgetContribution[] {
  // 口径必须与 projectAssembly 的 estimatedInputTokens 一致：正文按 CJK 加权（浮点累加），
  // tools schema 是紧凑 JSON（ASCII，按 4 字符/token）。此前一律 chars/4，中文长段会低报 2–3 倍。
  const rows: Array<{ label: string; chars: number; raw: number }> = plan.system.blocks.map((b) => ({
    label: `system:${b.id}`,
    chars: b.text.length,
    raw: estimateTokensRaw(b.text),
  }));
  for (const [i, m] of plan.messages.entries()) {
    if (m.role === 'system') continue; // system 已按块统计
    rows.push({ label: `msg#${i}:${m.role}`, chars: m.content.length, raw: estimateTokensRaw(m.content) });
  }
  if (plan.tools !== null) {
    const chars = JSON.stringify(plan.tools).length;
    rows.push({ label: 'tools:schema', chars, raw: chars / 4 });
  }
  const tokens = rows.map((r) => r.raw);
  const total = tokens.reduce((n, t) => n + t, 0) || 1;
  return rows
    .map((r, i) => ({ label: r.label, chars: r.chars, tokens: Math.ceil(tokens[i]!), share: tokens[i]! / total }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, opts.maxItems ?? 8);
}

/** RA-4：拒绝文案（模型与用户都能据此定位）。 */
export function budgetRefusal(plan: AssemblyPlan): string {
  const top = budgetContributions(plan, { maxItems: 5 })
    .map((c) => `${c.label} ${c.tokens}t(${Math.round(c.share * 100)}%)`)
    .join(' · ');
  return `[budget] 请求在发送前被拒绝：估算 ${plan.budget.estimatedInputTokens} tokens > 上限 ${plan.budget.limit}，超出 ${plan.budget.overBy}。`
    + `主要贡献：${top}。请压缩历史/减小载荷后重试（不会发送半截请求）。`;
}
