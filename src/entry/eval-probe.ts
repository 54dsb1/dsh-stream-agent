// entry/eval-probe.ts —— 中立评测探针（分派 08，METRICS.md E4 插桩事实）
//
// 职责（只读测量，不改流）：挂 llm/stream waterfall（F4），逐请求把 GenerateOptions 原文
// （messages/config/…）与逐 chunk（含 usage 原文 JSON、finish）落盘 JSONL，供 08 号评测：
//   - M1 单位任务 token：usage 原文逐条留存（E3：inputTokens 为未缓存输入，cache 分量单列）；
//   - M4 prefix_hash：逐请求 messages 原文（E2：session log 的 request/header 不含 messages）；
//   - M2 对账口径：请求序列（与 session log request/header 对账）。
// 两臂同装（baseline / stream 两个 eval patch），插桩对称 = 测量仪器不进对照变量。
//
// fail-open（红线 5）：探针记录异常 → 立即停用记录（进程内一次告警），流原样透传绝不改写。
// 探针是 eval 专用 entry：生产 preset.yml 不引用；dumpDir 走 config 或 DSH_EVAL_PROBE_DIR env。

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { makeWarn } from './adapter-kit.ts';
import type { HostCtxLike } from './adapter-kit.ts';

/** 镜像 dsh-llm/lib/types/index.d.ts:45 llm/stream waterfall 监听器面（duck-type） */
type StreamListener = (options: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>;

export interface EvalProbeConfig {
  /** 落盘目录（缺省读 DSH_EVAL_PROBE_DIR env；两者都无 → 只透传不记录 + 一次告警） */
  dumpDir?: string;
  /** 落盘文件名（缺省 probe.jsonl；一个进程一个文件，pid 记进每条记录） */
  file?: string;
  /** 装载自证横幅（排障用） */
  announce?: boolean;
}

/** 循环安全的 JSON 序列化（messages 可能含宿主对象；失败降级为标记位 + 占位文本） */
function safeJson(value: unknown): { ok: boolean; text: string } {
  try {
    return { ok: true, text: JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? String(v) : v)) };
  } catch {
    return { ok: false, text: JSON.stringify({ unserializable: String(value).slice(0, 2000) }) };
  }
}

export const name = 'stream-agent-eval-probe';
export const inject: string[] = [];

export interface EvalProbeHandle {
  file: string | undefined;
  requestCount: () => number;
  dispose: () => void;
}

export default function apply(ctx: HostCtxLike, config: EvalProbeConfig = {}): EvalProbeHandle {
  const warn = makeWarn(ctx, 'eval-probe');
  const dumpDir = config.dumpDir ?? process.env.DSH_EVAL_PROBE_DIR ?? '';
  const file = dumpDir === '' ? undefined : join(dumpDir, config.file ?? 'probe.jsonl');
  let disabled = file === undefined;
  if (disabled) {
    warn('未配置 dumpDir/DSH_EVAL_PROBE_DIR：探针挂载但只透传不记录（评测装配遗漏？）');
  } else {
    try {
      mkdirSync(dirname(file as string), { recursive: true });
    } catch (error) {
      disabled = true;
      warn('dumpDir 不可创建：探针停用记录，只透传（fail-open）', error);
    }
  }
  let seq = 0;

  const appendLine = (line: string): void => {
    appendFileSync(file as string, line + '\n', 'utf8');
  };

  const onStream: StreamListener = (options, next) => {
    if (disabled) return next();
    const seqNow = ++seq;
    try {
      const s = safeJson(options);
      appendLine(JSON.stringify({
        kind: 'request', seq: seqNow, at: Date.now(), pid: process.pid,
        session: options['sessionId'] ?? '', optionsDirty: !s.ok, options: s.text,
      }));
    } catch (error) {
      disabled = true;
      warn('探针记录失败：本进程停用记录，流原样透传（fail-open）', error);
      return next();
    }
    const inner = next();
    return (async function* () {
      try {
        for await (const chunk of inner) {
          try {
            const s = safeJson(chunk);
            appendLine(JSON.stringify({ kind: 'chunk', seq: seqNow, at: Date.now(), chunk: s.text }));
          } catch { /* 记录失败不影响流转发（fail-open 分界：测量不动流本身） */ }
          yield chunk; // 原样透传：一个字节不改
        }
      } finally {
        try {
          appendLine(JSON.stringify({ kind: 'stream-end', seq: seqNow, at: Date.now() }));
        } catch { /* 同上 */ }
      }
    })();
  };

  if (typeof ctx.on !== 'function') throw new Error('[eval-probe] ctx.on 不可用：无法挂载 llm/stream');
  ctx.on('llm/stream', onStream as unknown as (...args: never[]) => unknown);
  if (config.announce === true) {
    console.error(`[eval-probe] mounted: llm/stream passthrough + capture${file === undefined ? '' : ` -> ${file}`}`);
  }

  return {
    file,
    requestCount: () => seq,
    dispose: () => {},
  };
}
