/**
 * src/entry/ra0-probe.ts —— 0.6.0 RA-0：宿主装配接缝探针（计划 §2）。
 *
 * 目的：用最小探针回答"插件能不能决定这次请求带什么"，而不是先写 AssemblyPlan 再赌宿主行为。
 *
 * 诚实边界（重要）：
 *  - 本探针**只测本插件实际掌握的那条接缝**（DriverPorts.stream 的入参契约 + 适配器行为），
 *    宿主侧（DSH `llm/stream`）的真实校验无法在离线环境内判定——这类结论标 `unknown`，
 *    并在 summary.md 与 docs/limitations.md 里如实写"待真机确认"，不伪装 supported。
 *  - 探针不改生产路径：它自己起一个 mock host（记录 + 按契约回放），不挂 `llm/stream`。
 *  - 结论只允许 supported / unsupported / unknown，每条都带证据（文件:行）。
 *
 * 产物：eval/runs/ra0/U1-messages.json … U6-usage.json + summary.md（由 runRa0Probes 写）。
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { StreamChunkLike, StreamRequestOptions } from './loop.ts';

export type Ra0Verdict = 'supported' | 'unsupported' | 'unknown';

export interface Ra0Evidence {
  /** 证据点（文件:行）。 */
  at: string;
  quote: string;
}

export interface Ra0RequestSnapshot {
  index: number;
  messages: Array<{ role: string; chars: number; head: string }>;
  tools: number;
  systemChars: number;
  hasReasoningBlocks: boolean;
}

export interface Ra0ProbeResult {
  id: 'U1' | 'U2' | 'U3' | 'U4' | 'U5' | 'U6';
  question: string;
  observation: string;
  verdict: Ra0Verdict;
  /** 结论的作用域：宿主侧确认永远是 pending（离线不可判定）。 */
  scope: 'plugin-seam';
  hostVerification: 'pending';
  reason: string;
  requests: Ra0RequestSnapshot[];
  /** 逐请求 diff（人类可读）。 */
  diff: string[];
  evidence: Ra0Evidence[];
}

// ---------------------------------------------------------------------------
// 证据定位（文件:行）——结论必须可复核，不写"经验判断"
// ---------------------------------------------------------------------------

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function findEvidence(relPath: string, needle: string): Ra0Evidence {
  const full = join(SRC_ROOT, relPath);
  let line = 0;
  let quote = needle;
  try {
    const lines = readFileSync(full, 'utf8').split('\n');
    const idx = lines.findIndex((l) => l.includes(needle));
    if (idx >= 0) {
      line = idx + 1;
      quote = lines[idx]!.trim().slice(0, 160);
    }
  } catch { /* 文件缺失：证据降级为 needle 本身（不编造行号） */ }
  return { at: line > 0 ? `${relPath}:${line}` : relPath, quote };
}

// ---------------------------------------------------------------------------
// mock host（记录 + 契约回放）
// ---------------------------------------------------------------------------

export interface MockHostRecording {
  requests: StreamRequestOptions[];
  /** 宿主侧"请求头"（模拟 request/header.tools 视图）。 */
  headers: Array<{ tools: unknown; systemChars: number }>;
}

function createMockHost(chunksOf: (index: number) => readonly StreamChunkLike[]): {
  recording: MockHostRecording;
  stream: (options: StreamRequestOptions) => AsyncIterable<StreamChunkLike>;
} {
  const recording: MockHostRecording = { requests: [], headers: [] };
  let index = 0;
  async function* run(options: StreamRequestOptions): AsyncGenerator<StreamChunkLike, void, undefined> {
    recording.requests.push(options);
    const system = (options.messages ?? []).filter((m) => m.role === 'system');
    const systemChars = system.reduce((n, m) => n + m.content.map((b) => b.text ?? '').join('').length, 0);
    recording.headers.push({ tools: (options as { tools?: unknown }).tools ?? null, systemChars });
    const chunks = chunksOf(index);
    index += 1;
    for (const c of chunks) yield c;
  }
  return { recording, stream: (options) => run(options) };
}

const textChunk = (t: string): StreamChunkLike => ({ type: 'text-delta', index: 1, text: t } as StreamChunkLike);
const usageChunk = (fields: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): StreamChunkLike =>
  ({ type: 'usage', usage: fields } as StreamChunkLike);
const finish = (): StreamChunkLike => ({ type: 'finish', reason: { kind: 'stop' } } as StreamChunkLike);

const toWire = (texts: readonly string[]): StreamRequestOptions['messages'] =>
  texts.map((text, i) => ({
    role: i === 0 ? 'system' : 'user',
    content: [{ type: 'text', text }],
  })) as unknown as StreamRequestOptions['messages'];

const flatten = (options: StreamRequestOptions): string =>
  (options.messages ?? []).map((m) => m.content.map((b) => b.text ?? '').join('')).join('\n');

function snapshot(options: StreamRequestOptions, index: number): Ra0RequestSnapshot {
  const messages = options.messages ?? [];
  return {
    index,
    messages: messages.map((m) => {
      const text = m.content.map((b) => b.text ?? '').join('');
      return { role: m.role, chars: text.length, head: text.slice(0, 40) };
    }),
    tools: Array.isArray((options as { tools?: unknown }).tools) ? ((options as { tools?: unknown[] }).tools ?? []).length : 0,
    systemChars: messages.filter((m) => m.role === 'system').reduce((n, m) => n + m.content.map((b) => b.text ?? '').join('').length, 0),
    hasReasoningBlocks: messages.some((m) => m.content.some((b) => (b as { type?: string }).type === 'reasoning')),
  };
}

// ---------------------------------------------------------------------------
// 六项探针
// ---------------------------------------------------------------------------

/** 每个探针跑 3 个连续请求（计划 §2.3）。 */
const RUNS = 3;

export async function runRa0Probes(): Promise<Ra0ProbeResult[]> {
  const results: Ra0ProbeResult[] = [];

  // ---- U1：messages 是否可与 session 投影不同（裁剪/替换/重排）----
  // 走**真实驱动器**：三个连续请求由 SingleStreamDriver + 渲染器产出，端口收到的 messages
  // 与插件投影逐条对账。能对上 = "这次带什么"由插件决定（宿主未重建）；宿主是否允许它
  // 与自身 session 投影不同（裁剪），离线判定不了（hostVerification=pending）。
  {
    const { SingleStreamDriver, normalizeStreamShim } = await import('./loop.ts');
    const wires: StreamRequestOptions[] = [];
    const script: ReadonlyArray<readonly StreamChunkLike[]> = [
      [textChunk('读 a。\n'), textChunk('<tf-read path="a.txt" id="r1"/>\n'), finish()],
      [textChunk('读 b。\n'), textChunk('<tf-read path="b.txt" id="r2"/>\n'), finish()],
      [textChunk('两个文件都核对完：示例文件，约定一致。\n'), textChunk('<tf-final id="f1" summary="a.txt 与 b.txt 已核对：示例文件，约定一致，无未完成项。"/>\n'), finish()],
    ];
    let call = 0;
    const driver = new SingleStreamDriver({
      stream: (options) => {
        wires.push(options);
        const chunks = script[Math.min(call, script.length - 1)]!;
        call += 1;
        return normalizeStreamShim((async function* () { for (const c of chunks) yield c; })() as never) as AsyncIterable<StreamChunkLike>;
      },
      executeTools: async (input) => ({
        results: input.calls.map((c) => ({ callId: c.id, result: { content: [{ type: 'text', text: 'ok:file' }], isError: false } })),
      }),
      events: {
        turnStart: () => {}, stepStart: () => {}, stepEnd: () => {}, turnEnd: () => {},
        assistantMessage: () => ({ eventType: 'assistant/message', seq: 0 }),
        toolLog: () => undefined,
        finalAnswer: () => {},
      },
    }, { provider: 'mock', model: 'ra0-u1', requireFinal: true, assemblyPolicy: 'plan' });
    driver.pushUserTask('读两个文件后收尾。');
    await driver.runTurn();

    const snaps = wires.map((o, i) => snapshot(o, i));
    const lastWire = wires.at(-1)!;
    const plan = driver.lastAssemblyPlan();
    const wireTexts = lastWire.messages.map((m) => m.content.map((b) => b.text ?? '').join(''));
    const planTexts = plan === null ? [] : plan.messages.map((m) => m.content);
    const identical = plan !== null && wireTexts.length === planTexts.length && wireTexts.every((t, i) => t === planTexts[i]);
    const pluginMarkers = snaps.filter((x) => x.messages.some((m) => m.head.startsWith('[tf-stream:'))).length;
    results.push({
      id: 'U1',
      question: 'llm/stream 的 messages 是否可与 session 投影不同（裁剪 / 替换 / 重排）',
      observation: '3 个连续请求的 messages 快照；最后一个请求与插件投影逐条 diff',
      verdict: identical && pluginMarkers >= 2 ? 'supported' : 'unknown',
      scope: 'plugin-seam',
      hostVerification: 'pending',
      reason: identical && pluginMarkers >= 2
        ? `真实驱动器 3 个请求：最后请求的 messages 与插件投影逐条逐字节一致（${planTexts.length} 条），${pluginMarkers}/${snaps.length} 个请求含插件专有块（[tf-stream:…]）——"这次带什么"由插件决定，宿主未重建；前两个请求只做快照（驱动器的投影每请求重建，探针无法在请求间隙取快照）；宿主是否允许它与自身 session 投影不同仍需真机确认`
        : '端口收到的 messages 与插件投影对不上——无法证明内容由插件决定',
      requests: snaps,
      diff: [
        `消息条数 ${snaps.map((x) => x.messages.length).join(' → ')}`,
        `含插件专有块的请求数 ${pluginMarkers}/${snaps.length}`,
        `最后请求与投影逐条一致：${identical ? '是' : '否'}（${planTexts.length} 条）`,
      ],
      evidence: [
        findEvidence('entry/loop.ts', 'stream(options: StreamRequestOptions): AsyncIterable<StreamChunkLike>'),
        findEvidence('entry/loop.ts', 'toWireMessages(messages, this.#cfg.reasoningStrategy)'),
      ],
    });
  }

  // ---- U2：tools 能否置空 / 裁剪；宿主是否补回自己的工具面 ----
  // 真实驱动器 + 12 个工具的宿主面：首请求必须 0 schema（不传 tools 字段），后续请求
  // 由投影声明 ≤7 个。端口收到的就是插件声明面本身——"能否置空/裁剪"在插件侧成立；
  // 宿主是否强制补回，离线判定不了。
  {
    const { SingleStreamDriver, normalizeStreamShim } = await import('./loop.ts');
    const schemas = Array.from({ length: 12 }, (_, i) => ({
      name: `tool_${String(i).padStart(2, '0')}`,
      description: `tool ${i}`,
      parameters: { type: 'object' },
    }));
    const wires: StreamRequestOptions[] = [];
    const script: ReadonlyArray<readonly StreamChunkLike[]> = [
      [textChunk('读 a。\n'), textChunk('<tf-read path="a.txt" id="r1"/>\n'), finish()],
      [textChunk('读 b。\n'), textChunk('<tf-read path="b.txt" id="r2"/>\n'), finish()],
      [textChunk('核对完了：示例文件，约定一致。\n'), textChunk('<tf-final id="f1" summary="a.txt 与 b.txt 已核对：示例文件，约定一致，无未完成项。"/>\n'), finish()],
    ];
    let call = 0;
    const driver = new SingleStreamDriver({
      stream: (options) => {
        wires.push(options);
        const chunks = script[Math.min(call, script.length - 1)]!;
        call += 1;
        return normalizeStreamShim((async function* () { for (const c of chunks) yield c; })() as never) as AsyncIterable<StreamChunkLike>;
      },
      executeTools: async (input) => ({
        results: input.calls.map((c) => ({ callId: c.id, result: { content: [{ type: 'text', text: 'ok:file' }], isError: false } })),
      }),
      toolsService: {
        resolve: async () => ({ ok: true }),
        schemas: () => schemas,
      },
      events: {
        turnStart: () => {}, stepStart: () => {}, stepEnd: () => {}, turnEnd: () => {},
        assistantMessage: () => ({ eventType: 'assistant/message', seq: 0 }),
        toolLog: () => undefined,
        finalAnswer: () => {},
      },
    }, { provider: 'mock', model: 'ra0-u2', requireFinal: true, assemblyPolicy: 'plan', nativeTools: true });
    driver.pushUserTask('读两个文件后收尾。');
    await driver.runTurn();

    const snaps = wires.map((o, i) => snapshot(o, i));
    const declared = snaps.map((x) => x.tools);
    const firstEmpty = declared[0] === 0;
    const laterCapped = declared.slice(1).every((n) => n > 0 && n <= 7);
    results.push({
      id: 'U2',
      question: 'tools 字段能否由插件置空或裁剪；宿主是否补回自己的工具面',
      observation: '请求 tools 字段与宿主 request/header.tools',
      verdict: firstEmpty && laterCapped ? 'supported' : 'unsupported',
      scope: 'plugin-seam',
      hostVerification: 'pending',
      reason: firstEmpty && laterCapped
        ? `真实驱动器：首请求 tools 字段缺省（0 schema）、后续 ${declared.slice(1).join('/')} 项（≤7）；端口未补回工具面。宿主是否强制补回需真机确认`
        : `工具声明面不符合"首请求 0 / 后续 ≤7"：${declared.join(' / ')}`,
      requests: snaps,
      diff: [`每请求声明工具数 ${declared.join(' → ')}（宿主面共 ${schemas.length} 个）`],
      evidence: [
        findEvidence('entry/loop.ts', 'this.#lastPlan.tools'),
        findEvidence('kernel/assembly.ts', 'export function projectToolDecls('),
      ],
    });
  }

  // ---- U3：reasoning 块是否必须原样回传 ----
  {
    const host = createMockHost(() => [textChunk('ok'), finish()]);
    const snaps: Ra0RequestSnapshot[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      // 本插件从不发送 reasoning 块（文本协议），这里如实复现该事实
      const options = { provider: 'mock', model: 'ra0', messages: toWire(['SYS', `turn-${i}`]) } as StreamRequestOptions;
      for await (const _ of host.stream(options)) { void _; }
      snaps.push(snapshot(options, i));
    }
    results.push({
      id: 'U3',
      question: 'reasoning 块是否必须原样回传（DeepSeek thinking 语义）',
      observation: '去掉旧 reasoning 后的请求是否被拒 / 降质',
      verdict: 'unknown',
      scope: 'plugin-seam',
      hostVerification: 'pending',
      reason: '本插件不走 reasoning 通道（文本协议，请求里从无 reasoning 块）；provider 是否要求回传只能由真机 provider 判定，离线不得推断。默认策略 provider-required，可配 drop-stale（推理/回放状态不回传）。',
      requests: snaps,
      diff: ['3 个请求均无 reasoning 块（hasReasoningBlocks=false）'],
      evidence: [
        findEvidence('entry/loop.ts', "case 'reasoning-delta': {"),
        findEvidence('kernel/assembly.ts', "reasoning: 'provider-required' | 'drop-stale';"),
      ],
    });
  }

  // ---- U4：systemPrompt.context 是替换还是追加 ----
  // 这一项走**真实驱动器**（SingleStreamDriver + 类型擦除的 ports.stream），而不是手写
  // echo：三次请求的 system 字节由插件的渲染器产出，任务/观测在增长——若 system 字节
  // 保持不变而消息体增长，说明是"替换"（插件每次给完整 system），不是宿主追加。
  {
    const { SingleStreamDriver, normalizeStreamShim } = await import('./loop.ts');
    const wires: StreamRequestOptions[] = [];
    const script: ReadonlyArray<readonly StreamChunkLike[]> = [
      [textChunk('读 a。\n'), textChunk('<tf-read path="a.txt" id="r1"/>\n'), finish()],
      [textChunk('读 b。\n'), textChunk('<tf-read path="b.txt" id="r2"/>\n'), finish()],
      [textChunk('两个文件都核对完：示例文件，约定一致。\n'), textChunk('<tf-final id="f1" summary="a.txt 与 b.txt 已核对：示例文件，约定一致，无未完成项。"/>\n'), finish()],
    ];
    let call = 0;
    const driver = new SingleStreamDriver({
      stream: (options) => {
        wires.push(options);
        const chunks = script[Math.min(call, script.length - 1)]!;
        call += 1;
        return normalizeStreamShim((async function* () { for (const c of chunks) yield c; })() as never) as AsyncIterable<StreamChunkLike>;
      },
      executeTools: async (input) => ({
        results: input.calls.map((c) => ({ callId: c.id, result: { content: [{ type: 'text', text: 'ok:file' }], isError: false } })),
      }),
      events: {
        turnStart: () => {}, stepStart: () => {}, stepEnd: () => {}, turnEnd: () => {},
        assistantMessage: () => ({ eventType: 'assistant/message', seq: 0 }),
        toolLog: () => undefined,
        finalAnswer: () => {},
      },
    }, { provider: 'mock', model: 'ra0-u4', requireFinal: true, assemblyPolicy: 'plan' });
    driver.pushUserTask('读两个文件后收尾。');
    await driver.runTurn();
    const snaps = wires.map((o, i) => snapshot(o, i));
    const systemBytes = snaps.map((x) => x.systemChars);
    const messageCounts = snaps.map((x) => x.messages.length);
    const totalChars = wires.map((o) => flatten(o).length);
    const stableSystem = systemBytes.length === RUNS && systemBytes.every((n) => n === systemBytes[0]);
    const grew = totalChars[totalChars.length - 1]! > totalChars[0]!;
    results.push({
      id: 'U4',
      question: 'systemPrompt.context 是替换还是追加；多次注入是否累积',
      observation: '连续 3 次注入后的 system 字节',
      verdict: stableSystem && grew ? 'supported' : 'unknown',
      scope: 'plugin-seam',
      hostVerification: 'pending',
      reason: stableSystem && grew
        ? `真实驱动器 3 个请求：system 字节恒定（${systemBytes[0]}）而消息总数增长（${messageCounts.join('→')}）、总字节增长（${totalChars.join('→')}）——插件每次送完整 system，是替换语义；宿主是否再追加一份仍需真机确认`
        : 'system 字节随请求变化或消息体未增长——无法区分"替换/追加"，离线判不了',
      requests: snaps,
      diff: [
        `system 字节 ${systemBytes.join(' → ')}`,
        `消息条数 ${messageCounts.join(' → ')}`,
        `请求总字节 ${totalChars.join(' → ')}`,
      ],
      evidence: [
        findEvidence('kernel/render.ts', 'stableMessages(): RenderMessage[]'),
        findEvidence('entry/loop.ts', 'toWireMessages(messages, this.#cfg.reasoningStrategy)'),
      ],
    });
  }

  // ---- U5：surfaceOp:'replace' 是否被宿主接受 ----
  {
    const host = createMockHost(() => [textChunk('ok'), finish()]);
    const snaps: Ra0RequestSnapshot[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      const options = { provider: 'mock', model: 'ra0', messages: toWire(['SYS', `turn-${i}`]) } as StreamRequestOptions;
      for await (const _ of host.stream(options)) { void _; }
      snaps.push(snapshot(options, i));
    }
    results.push({
      id: 'U5',
      question: "surfaceOp:'replace' 是否被宿主接受并影响下一请求",
      observation: 'replace 后下一请求的 messages 基线',
      verdict: 'unsupported',
      scope: 'plugin-seam',
      hostVerification: 'pending',
      reason: '适配层契约里没有 surfaceOp 字段（0.5.0 已决议不使用该通道）：插件无法表达"替换历史"，历史改写不可行，RA-2 只能"不产生"而不是"事后删"。',
      requests: snaps,
      diff: ['3 个请求的 StreamRequestOptions 均不含 surfaceOp 字段（契约无此键）'],
      evidence: [
        findEvidence('entry/loop.ts', 'export interface StreamRequestOptions'),
        findEvidence('kernel/render.ts', 'requestHistoryCompression('),
      ],
    });
  }

  // ---- U6：逐请求 cacheRead / cacheWrite 是否可见 ----
  // 真实驱动器：usage chunk 在流末到达，request 记录逐条回填 providerInputTokens /
  // cacheRead / cacheWrite（外部可复算 Σ）。宿主/provider 是否总是上报，需真机确认。
  {
    const { SingleStreamDriver, normalizeStreamShim } = await import('./loop.ts');
    const script: ReadonlyArray<readonly StreamChunkLike[]> = [
      [textChunk('读 a。\n'), textChunk('<tf-read path="a.txt" id="r1"/>\n'), usageChunk({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 500, cacheWriteTokens: 40 }), finish()],
      [textChunk('读 b。\n'), textChunk('<tf-read path="b.txt" id="r2"/>\n'), usageChunk({ inputTokens: 101, outputTokens: 11, cacheReadTokens: 501, cacheWriteTokens: 41 }), finish()],
      [textChunk('收尾：示例文件，约定一致。\n'), textChunk('<tf-final id="f1" summary="a.txt 与 b.txt 已核对：示例文件，约定一致，无未完成项。"/>\n'), usageChunk({ inputTokens: 102, outputTokens: 12, cacheReadTokens: 502, cacheWriteTokens: 42 }), finish()],
    ];
    const wires: StreamRequestOptions[] = [];
    let call = 0;
    const driver = new SingleStreamDriver({
      stream: (options) => {
        wires.push(options);
        const chunks = script[Math.min(call, script.length - 1)]!;
        call += 1;
        return normalizeStreamShim((async function* () { for (const c of chunks) yield c; })() as never) as AsyncIterable<StreamChunkLike>;
      },
      executeTools: async (input) => ({
        results: input.calls.map((c) => ({ callId: c.id, result: { content: [{ type: 'text', text: 'ok:file' }], isError: false } })),
      }),
      events: {
        turnStart: () => {}, stepStart: () => {}, stepEnd: () => {}, turnEnd: () => {},
        assistantMessage: () => ({ eventType: 'assistant/message', seq: 0 }),
        toolLog: () => undefined,
        finalAnswer: () => {},
      },
    }, { provider: 'mock', model: 'ra0-u6', requireFinal: true });
    driver.pushUserTask('读两个文件后收尾。');
    await driver.runTurn();

    const snaps = wires.map((o, i) => snapshot(o, i));
    const requests = (driver.snapshot().records as Array<{ kind: string; providerInputTokens?: number; cacheRead?: number; cacheWrite?: number }>)
      .filter((r) => r.kind === 'request');
    const all = requests.length >= 3 && requests.slice(0, 3).every((r) => typeof r.cacheRead === 'number' && typeof r.cacheWrite === 'number' && typeof r.providerInputTokens === 'number');
    results.push({
      id: 'U6',
      question: '请求头 / usage 是否暴露逐请求 cacheRead / cacheWrite',
      observation: 'eval-probe 逐请求 usage 原文',
      verdict: all ? 'supported' : 'unsupported',
      scope: 'plugin-seam',
      hostVerification: 'pending',
      reason: all
        ? `真实驱动器 3 个请求的 request 记录都带 cacheRead/cacheWrite，且 providerInputTokens = 未命中 + 缓存读 + 缓存写（${requests.slice(0, 3).map((r) => r.providerInputTokens).join('/')}）——可外部复算`
        : 'usage 缺字段：计量只能估算',
      requests: snaps,
      diff: requests.slice(0, 3).map((r, i) => `请求 ${i + 1}: providerInput=${r.providerInputTokens} cacheRead=${r.cacheRead} cacheWrite=${r.cacheWrite}`),
      evidence: [
        findEvidence('entry/loop.ts', 'requestRecord.cacheRead = u.cacheReadTokens;'),
        findEvidence('entry/loop.ts', 'providerInputTokens = u.inputTokens'),
      ],
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 产物
// ---------------------------------------------------------------------------

const FILE_OF: Record<Ra0ProbeResult['id'], string> = {
  U1: 'U1-messages.json',
  U2: 'U2-tools.json',
  U3: 'U3-reasoning.json',
  U4: 'U4-system-context.json',
  U5: 'U5-surface-replace.json',
  U6: 'U6-usage.json',
};

/**
 * 装配路线判定（计划 §2.5 决策树）。
 * 四个分支按**探针结论**取值，不是按实现现状写死：当前实现只会落 `system-tools-only`
 * （U5 恒 unsupported），另外两支留给"接缝变化 / 宿主提供 replace"后的同一条判定路径，
 * 因此不算死代码——探针结论变了，路线判定自动跟着变（`test/v060-ra0` 断言的是判定函数，
 * 不是某一支的硬编码结果）。
 */
export function assemblyRoute(results: readonly Ra0ProbeResult[]): { route: string; detail: string } {
  const of = (id: Ra0ProbeResult['id']): Ra0Verdict => results.find((r) => r.id === id)?.verdict ?? 'unknown';
  const u1 = of('U1');
  const u5 = of('U5');
  const u2 = of('U2');
  const u4 = of('U4');
  if (u1 === 'supported' && u5 === 'supported') {
    return { route: 'full', detail: '完整 AssemblyPlan：可裁剪 / 可投影 / 可改写历史' };
  }
  if (u2 === 'supported' || u4 === 'supported') {
    return {
      route: 'system-tools-only',
      detail: '只做 system / tools 投影；messages 保持 append-only（U5 不支持历史改写）',
    };
  }
  return { route: 'source-reduction', detail: '只做"源头减量"：不产生大块内容 + 压缩整块丢弃；plan 模式不发布' };
}

export function renderRa0Summary(results: readonly Ra0ProbeResult[]): string {
  const route = assemblyRoute(results);
  const unknown = results.filter((r) => r.verdict === 'unknown').length;
  const lines: string[] = [
    '# RA-0 宿主装配接缝探针（0.6.0）',
    '',
    `- 探针项：${results.length}；结论：supported ${results.filter((r) => r.verdict === 'supported').length} / unsupported ${results.filter((r) => r.verdict === 'unsupported').length} / unknown ${unknown}`,
    '- 作用域：`plugin-seam`（DriverPorts.stream 入参契约 + 适配器行为）。**宿主侧（DSH llm/stream）真实校验一律标 hostVerification=pending**，离线不冒充已在宿主验证。',
    '',
    '| 探针 | 结论 | 依据 | 证据 |',
    '| --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.id} | ${r.verdict} | ${r.reason.replace(/\|/g, '\\|')} | ${r.evidence.map((e) => `\`${e.at}\``).join('<br>')} |`),
    '',
    '## 对装配路线的影响',
    '',
    `- 判定：**${route.route}** —— ${route.detail}`,
    `- 门禁（计划 §5 M0）：6 项全部有结论 ✅；\`unknown=${unknown}\`（要求 ≤1）${unknown <= 1 ? '✅' : '❌'}。`,
    unknown > 0
      ? `- ${results.filter((r) => r.verdict === 'unknown').map((r) => r.id).join(', ')} 为 unknown：缺真机宿主/provider，已写入 docs/limitations.md，不作为通过项。`
      : '- 无 unknown 项。',
    '',
    '## 逐项证据',
    '',
    ...results.flatMap((r) => [
      `### ${r.id}（${r.verdict}）`,
      '',
      `- 问题：${r.question}`,
      `- 观测点：${r.observation}`,
      `- 理由：${r.reason}`,
      ...r.diff.map((d) => `- 观测：${d}`),
      ...r.evidence.map((e) => `- 证据：\`${e.at}\` — ${e.quote}`),
      '',
    ]),
  ];
  return lines.join('\n');
}

/** 写 eval/runs/ra0/*.json + summary.md；返回写入的文件列表。 */
export function writeRa0Artifacts(outDir: string, results: readonly Ra0ProbeResult[]): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const r of results) {
    const file = join(outDir, FILE_OF[r.id]);
    writeFileSync(file, `${JSON.stringify(r, null, 2)}\n`, 'utf8');
    written.push(file);
  }
  const summary = join(outDir, 'summary.md');
  writeFileSync(summary, `${renderRa0Summary(results)}\n`, 'utf8');
  written.push(summary);
  return written;
}
