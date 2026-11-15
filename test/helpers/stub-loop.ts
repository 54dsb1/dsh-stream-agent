// test/helpers/stub-loop.ts —— 桩 loop：mock E2E 的最小单流驱动器
//
// 这是测试设施，不是 06 号正式 loop。只实现 mock-provider E2E 所需的最小路径：
//   ctx.llm.stream 的替身 = normalizeStream(model.adapter.stream(options))
//   逐 delta 累积文本 → 行闭合即解析 tf-* 命令 → 直接执行（读写沙箱目录）
//   → 每个工具完成调用 model.notifyToolResult()（waitTools 的回灌信号源）
//   → finish chunk 终止。
//
// normalizeStream 镜像 LlmRuntime.stream 的异常归一化契约
// （dsh-llm/lib/types/types.d.ts:456："adapter may throw … normalizes that failure
// to a terminal `error` or `aborted` finish"）：适配器抛错 → 终止 error finish。
// 若适配器已先吐过 finish 再抛错（mock 的 fail-fast 语义），吞掉重复抛错。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GenerateOptionsLike, MockModel, StreamChunk } from '../../src/entry/mock-provider.ts';

// ---------------------------------------------------------------------------
// 流归一化 shim（镜像 LlmRuntime 契约）
// ---------------------------------------------------------------------------

export interface NormalizedFinish {
  kind: string;
  message?: string;
  code?: string;
}

export function normalizeStream(
  inner: AsyncIterable<StreamChunk>,
): { stream: AsyncGenerator<StreamChunk>; finished: NormalizedFinish | null } {
  const state = { finished: null as NormalizedFinish | null };
  async function* run(): AsyncGenerator<StreamChunk> {
    try {
      for await (const chunk of inner) {
        if (chunk.type === 'finish') {
          state.finished = { kind: chunk.reason.kind, message: (chunk.reason as { message?: string }).message, code: (chunk.reason as { code?: string }).code };
        }
        yield chunk;
      }
    } catch (error) {
      // 契约归一化：适配器异常 → 终止 error finish；已终止则吞掉重复抛错
      if (state.finished === null) {
        const message = error instanceof Error ? error.message : String(error);
        state.finished = { kind: 'error', message, code: 'MOCK_ADAPTER_THROWN' };
        yield { type: 'finish', reason: { kind: 'error', message, code: 'MOCK_ADAPTER_THROWN' } };
      }
    }
  }
  return { stream: run(), finished: state.finished === null ? state.finished : state.finished };
}

// ---------------------------------------------------------------------------
// tf-* 行解析（桩级：真正的 parser 在 kernel/parser.ts，03 号交付）
// ---------------------------------------------------------------------------

export interface TfCommand {
  kind: 'tf-write' | 'tf-read' | 'tf-peek' | 'tf-bash' | 'tf-final';
  raw: string;
  path?: string;
  content?: string;
}

export function parseTfLine(line: string): TfCommand | { kind: 'malformed'; raw: string } | null {
  const t = line.trim();
  if (t.length === 0 || !t.startsWith('tf-')) return null;
  const write = /^tf-write\s+(\S+)\s+"((?:[^"\\]|\\.)*)"$/.exec(t);
  if (write) return { kind: 'tf-write', raw: t, path: write[1], content: write[2]!.replace(/\\(["\\])/g, '$1') };
  const read = /^tf-read\s+(\S+)$/.exec(t);
  if (read) return { kind: 'tf-read', raw: t, path: read[1] };
  if (/^tf-final\s*$/.test(t)) return { kind: 'tf-final', raw: t };
  return { kind: 'malformed', raw: t };
}

// ---------------------------------------------------------------------------
// 桩 loop
// ---------------------------------------------------------------------------

export type LedgerEntry =
  | { seq: number; kind: 'tool'; cmd: string; path?: string; ok: boolean; detail?: string }
  | { seq: number; kind: 'malformed-command'; line: string }
  | { seq: number; kind: 'final' }
  | { seq: number; kind: 'fault'; fault: string; detail?: string }
  | { seq: number; kind: 'finish'; finish: NormalizedFinish };

export interface TimelineEvent {
  seq: number;
  what: 'tool-executed' | 'malformed-seen' | 'final-seen' | 'finish-seen' | 'budget-abort' | 'timeout-abort';
  detail?: string;
}

export interface StubLoopResult {
  assistantText: string;
  finish: NormalizedFinish | null;
  /** 事件时间线：断言"工具执行发生在流终止之前 / 挂起-重入顺序"用 */
  timeline: TimelineEvent[];
  ledger: LedgerEntry[];
  /** 沙箱内实际写入的文件（相对路径 → 内容） */
  writtenFiles: Map<string, string>;
  /** 沙箱内实际读过的文件（相对路径 → 内容） */
  readFiles: Map<string, string>;
  modelCalls: number;
  elapsedMs: number;
}

export interface StubLoopOptions {
  /** 沙箱目录（tf-write / tf-read 的根） */
  sandboxDir: string;
  /** 整轮超时（ms）：到点 abort 模拟消费方超时处理路径 */
  timeoutMs?: number;
  /** 输出预算（chars）：超出 abort 模拟预算降级路径 */
  budgetChars?: number;
  /** 发给"模型"的任务文本 */
  task: string;
  model: MockModel;
  modelId?: string;
}

export async function runStubLoop(opts: StubLoopOptions): Promise<StubLoopResult> {
  const started = Date.now();
  mkdirSync(opts.sandboxDir, { recursive: true });
  const controller = new AbortController();
  let timedOut = false;
  const timeoutTimer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, opts.timeoutMs)
      : undefined;

  let seq = 0;
  const ledger: LedgerEntry[] = [];
  const timeline: TimelineEvent[] = [];
  const writtenFiles = new Map<string, string>();
  const readFiles = new Map<string, string>();
  let text = '';
  let emittedChars = 0;
  let budgetAborted = false;
  let finish: NormalizedFinish | null = null;

  const messages: GenerateOptionsLike['messages'] = [
    { role: 'user', content: [{ type: 'text', text: opts.task }] },
  ];

  const { stream, finished } = normalizeStream(
    opts.model.adapter.stream({
      provider: opts.model.provider,
      model: opts.modelId ?? 'mock-scenario',
      messages,
      signal: controller.signal,
    }),
  );
  void finished;

  const executeTool = (cmd: TfCommand & { kind: 'tf-write' | 'tf-read' }) => {
    try {
      if (cmd.kind === 'tf-write') {
        const abs = join(opts.sandboxDir, cmd.path!);
        writeFileSync(abs, cmd.content!, 'utf8');
        writtenFiles.set(cmd.path!, cmd.content!);
        ledger.push({ seq: seq++, kind: 'tool', cmd: cmd.kind, path: cmd.path, ok: true, detail: `${cmd.content!.length} chars` });
      } else {
        const abs = join(opts.sandboxDir, cmd.path!);
        const content = readFileSync(abs, 'utf8');
        readFiles.set(cmd.path!, content);
        ledger.push({ seq: seq++, kind: 'tool', cmd: cmd.kind, path: cmd.path, ok: true, detail: `${content.length} chars` });
      }
      timeline.push({ seq: seq++, what: 'tool-executed', detail: cmd.raw });
    } catch (error) {
      ledger.push({ seq: seq++, kind: 'tool', cmd: cmd.kind, path: cmd.path, ok: false, detail: String((error as Error).message) });
      timeline.push({ seq: seq++, what: 'tool-executed', detail: `${cmd.raw} (failed)` });
    }
    // 工具完成信号回灌（waitTools 的挂起-重入通道）
    opts.model.notifyToolResult();
  };

  const handleLine = (line: string) => {
    const cmd = parseTfLine(line);
    if (cmd === null) return;
    if (cmd.kind === 'malformed') {
      ledger.push({ seq: seq++, kind: 'malformed-command', line: cmd.raw });
      timeline.push({ seq: seq++, what: 'malformed-seen', detail: cmd.raw });
      return;
    }
    if (cmd.kind === 'tf-final') {
      ledger.push({ seq: seq++, kind: 'final' });
      timeline.push({ seq: seq++, what: 'final-seen' });
      return;
    }
    executeTool(cmd);
  };

  // 行缓冲：delta 累积，按 '\n' 切分，闭合行立即派发（不等流结束）
  let lineBuffer = '';
  const feedText = (delta: string) => {
    text += delta;
    emittedChars += delta.length;
    if (opts.budgetChars !== undefined && emittedChars > opts.budgetChars && !budgetAborted) {
      budgetAborted = true;
      ledger.push({ seq: seq++, kind: 'fault', fault: 'budget-exceeded', detail: `emitted ${emittedChars} > ${opts.budgetChars}` });
      timeline.push({ seq: seq++, what: 'budget-abort', detail: `${emittedChars} chars` });
      controller.abort();
    }
    lineBuffer += delta;
    let idx: number;
    while ((idx = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, idx);
      lineBuffer = lineBuffer.slice(idx + 1);
      handleLine(line);
    }
  };

  try {
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') feedText(chunk.text);
      if (chunk.type === 'finish') {
        finish = { kind: chunk.reason.kind, message: (chunk.reason as { message?: string }).message, code: (chunk.reason as { code?: string }).code };
        ledger.push({ seq: seq++, kind: 'finish', finish });
        timeline.push({ seq: seq++, what: 'finish-seen', detail: finish.kind });
      }
    }
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (timedOut) {
      ledger.push({ seq: seq++, kind: 'fault', fault: 'timeout', detail: `aborted after ${Date.now() - started}ms` });
      timeline.push({ seq: seq++, what: 'timeout-abort' });
    }
  }

  return {
    assistantText: text,
    finish,
    timeline,
    ledger,
    writtenFiles,
    readFiles,
    modelCalls: opts.model.calls.length,
    elapsedMs: Date.now() - started,
  };
}
