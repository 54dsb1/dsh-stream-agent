// entry/intent-log.ts —— F6 恢复意图：写前意图落盘（fsync）+ 写后回执 + resume 停机核对
//
// 红线（v0.4.0 规划 F6，随 0.3.0 实施）：
//   · 意图必须在写入发生**之前**落盘并 fsync——崩溃后"有意图无回执"即可判定"写入可能已发生"；
//   · 写后回执记录结果与时间；三态判定：未发生（意图前崩溃）/ 已发生（有意图有回执且 ok）/
//     不确定（有意图无回执——强制杀在写入中）；
//   · resume 时"有意图无回执"一律**停机核对**，不自动重放、不自动继续；
//   · 零注入：意图与回执不进模型上下文，只在账本与 resume 判定中使用。
//
// 文件布局：<stateRoot>/intents/<sessionId>.jsonl，每行一个 JSON 记录：
//   { type:'intent',  seq, at, sessionId, cmdId, op, path, fingerprint }
//   { type:'receipt', seq, at, intentSeq, ok, detail? }
//   { type:'ack',     seq, at, intentSeqs, note? }   —— 人工核对后的确认（CLI intents --ack）

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

/** 写前意图记录（写入发生前 fsync 落盘）。 */
export interface IntentRecord {
  type: 'intent';
  seq: number;
  at: string;
  sessionId: string;
  cmdId: string;
  /** 操作类型：write / edit / append（与 tf-write / tf-edit / tf-append 一一对应） */
  op: 'write' | 'edit' | 'append';
  path: string;
  /** 内容指纹（sha256 前 16 位）——对账"写的是什么"，不落内容本身 */
  fingerprint: string;
}

/** 写后回执记录（命令落定即追加；失败也记——把意图闭合为"已发生但失败"）。 */
export interface IntentReceiptRecord {
  type: 'receipt';
  seq: number;
  at: string;
  /** 对应 intent.seq；-1 = 找不到对应意图（防御式，不静默丢） */
  intentSeq: number;
  ok: boolean;
  detail?: string;
}

/** 人工核对确认（CLI intents --ack；停机核对的出口）。 */
export interface IntentAckRecord {
  type: 'ack';
  seq: number;
  at: string;
  intentSeqs: number[];
  note?: string;
}

export type IntentLogRecord = IntentRecord | IntentReceiptRecord | IntentAckRecord;

/** 内容指纹（sha256 前 16 位；够对账，不泄露内容）。 */
export function intentFingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/** 会话的意图日志路径：<stateRoot>/intents/<sessionId>.jsonl。 */
export function intentFileOf(stateRoot: string, sessionId: string): string {
  return join(stateRoot, 'intents', `${sessionId}.jsonl`);
}

/** 追加一条记录并 fsync（崩溃安全的关键：写入发生前意图必须已到盘）。 */
export function appendIntentRecord(file: string, record: IntentLogRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'a');
  try {
    writeFileSync(fd, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 读取全部记录（坏行如实跳过并计数，不中断——崩溃可能截断最后一行）。 */
export function loadIntentRecords(file: string): { records: IntentLogRecord[]; badLines: number } {
  if (!existsSync(file)) return { records: [], badLines: 0 };
  const records: IntentLogRecord[] = [];
  let badLines = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as IntentLogRecord;
      if (parsed.type === 'intent' || parsed.type === 'receipt' || parsed.type === 'ack') records.push(parsed);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { records, badLines };
}

export interface PendingIntent {
  intent: IntentRecord;
  /** 三态判定：pending = 有意图无回执（不确定：写入可能已发生）；failed = 已发生但失败 */
  state: 'pending' | 'failed';
}

/**
 * 计算"有意图无回执"集合（resume 停机核对的输入）：
 * - intent 没有任何 receipt 引用、也不在任何 ack 里 → pending（不确定）；
 * - intent 的 receipt ok=false 且无后续 ack → failed（已发生但失败——列出供参考，不阻断）。
 */
export function pendingIntents(records: readonly IntentLogRecord[]): PendingIntent[] {
  const receiptByIntent = new Map<number, IntentReceiptRecord>();
  const acked = new Set<number>();
  for (const r of records) {
    if (r.type === 'receipt') receiptByIntent.set(r.intentSeq, r);
    if (r.type === 'ack') for (const seq of r.intentSeqs) acked.add(seq);
  }
  const out: PendingIntent[] = [];
  for (const r of records) {
    if (r.type !== 'intent' || acked.has(r.seq)) continue;
    const receipt = receiptByIntent.get(r.seq);
    if (receipt === undefined) out.push({ intent: r, state: 'pending' });
    else if (!receipt.ok) out.push({ intent: r, state: 'failed' });
  }
  return out;
}

/**
 * v0.4.3（P0-6⑤）：最小对账——把 pending 意图整批 ack 标记 unknown。
 * 语义写死（与 0.5.1 P0-8 的完整三态一致）：**只解除恢复锁，不重放工具，不声称回滚**——
 * "写入可能已发生"这个事实由 note 如实携带，0.4.3 不做状态判定。
 * seqState 由调用方持有（与会话其余意图记录共用单调 seq）；返回 ack 的意图数。
 */
export function reconcilePendingIntents(file: string, cause: string, seqState: { seq: number }): number {
  const { records } = loadIntentRecords(file);
  const pending = pendingIntents(records).filter((p) => p.state === 'pending');
  if (pending.length === 0) return 0;
  seqState.seq += 1;
  appendIntentRecord(file, {
    type: 'ack',
    seq: seqState.seq,
    at: new Date().toISOString(),
    intentSeqs: pending.map((p) => p.intent.seq),
    note: `${cause}：最小对账把 pending 意图标记 unknown——只解除恢复锁，不重放工具，不声称回滚（P0-8/0.5.1 补完整三态）`,
  });
  return pending.length;
}
