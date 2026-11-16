// entry/state-handle.ts —— 状态服务（M1 适配，分派 07）
//
// 职责（07 号任务书）：kernel/state 的 StateStore 经 ctx.provide 提供为 Cordis 服务
// `ctx.state`；BlobSink 接 DSH storage（adapter-kit.DurableBlobSink：内存覆盖读 + 写回后
// 异步持久，内核同步语义不变）；resume 时从持久层快照重建句柄目录——重放编排在本层，
// 确定性由内核内容寻址保证（同内容 → 同 hash → 同版本，重放结果逐字节可验证）。
// 本 entry 只做"翻译"（快照格式 + 重放校验），无业务逻辑。
//
// fail-open（红线 5）：storage 不可用 → 内存实现降级 + 告警（durable=false），服务照常提供。

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { StateStore, parseHandle, formatHandle } from '../kernel/state.ts';
import type { PutRef } from '../kernel/state.ts';
import { makeWarn, EntryLedger, DurableBlobSink, bytesToB64, b64ToBytes, hydrateFromUnit, openKvUnit } from './adapter-kit.ts';
import type { HostCtxLike, StorageLike, KvUnitLike } from './adapter-kit.ts';
import { JsonFileKvUnit, resolveStateDir, safeFileName } from './json-persistence.ts';

export interface HandleSnapshotEntry {
  /** 形如 file:src/app.ts@v3（formatHandle 产物）。 */
  handle: string;
  /** 内容 sha256（StateHandle.hash 原样；resume 重放后逐字节校验完整性）。 */
  hash: string;
  /** 原写入是否为字符串（内核 get 的 string/bytes 双形态必须保真还原）。 */
  text: boolean;
  /** 内容 base64；取不到内容的句柄记 null（resume 时跳过并如实报告）。 */
  contentB64: string | null;
}
export interface StateSnapshot {
  handles: HandleSnapshotEntry[];
}
export interface ResumeReport {
  ok: boolean;
  rebuilt: number;
  skipped: number;
  mismatches: string[];
}
export interface StateService {
  readonly store: StateStore;
  readonly sink: DurableBlobSink;
  readonly durable: boolean;
  snapshot(): StateSnapshot;
  /** 快照落持久层（handles 表；dispose 时也会尽力执行一次）。 */
  persist(): Promise<StateSnapshot>;
  /** 从持久层读回快照；storage 不可用返回 null（调用方决定，不静默）。 */
  load(): Promise<StateSnapshot | null>;
  /** 重建句柄目录：缺省从持久层快照重放（内容寻址保证同 hash → 同版本）。 */
  resume(snap?: StateSnapshot): Promise<ResumeReport>;
  flush(): Promise<void>;
}

export interface StateHandleConfig {
  /** KvUnit 名（默认 'tfAgentState'；后端固定 'json'，与 action-gate staging 同款接驳） */
  unit?: string;
  /** 装载自证横幅（排障用；preset/patch 激活对 CLI 静默，探针 A 惯例） */
  announce?: boolean;
  /** 修复限制 3：宿主缺 storage backend 'json' 时的本地文件 KvUnit 兜底（durable，resume 可用）。
   *  默认开启；false = 维持 v0.1 内存降级行为。 */
  localFallback?: boolean;
  /** 本地状态根目录（缺省 env STREAM_AGENT_STATE_DIR → ~/.dsh-stream-agent/storage） */
  stateDir?: string;
}

/** 句柄字符串 → 内核 put 的 ref（重放用；解析失败抛 UnknownHandleError → 上层计入 mismatches）。 */
function refOf(handle: string): PutRef | null {
  const parsed = parseHandle(handle);
  if (parsed.kind === 'file') return { kind: 'file', path: parsed.path };
  if (parsed.kind === 'obs') {
    const colon = parsed.path.indexOf(':');
    if (colon <= 0) return null;
    return { kind: 'obs', tool: parsed.path.slice(0, colon), callId: parsed.path.slice(colon + 1) };
  }
  return {}; // blob：path 由 put 从 hash 自动生成
}

/** store → 快照（内容取不到的句柄记 null，resume 时跳过并如实报告）。 */
function snapshotOf(store: StateStore): StateSnapshot {
  const handles = store.handles().map((h) => {
    try {
      const content = store.get(h);
      const text = typeof content === 'string';
      const bytes = text ? new TextEncoder().encode(content) : content;
      return { handle: formatHandle(h), hash: h.hash, text, contentB64: bytesToB64(bytes) };
    } catch {
      return { handle: formatHandle(h), hash: h.hash, text: false, contentB64: null };
    }
  });
  return { handles };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const name = 'stream-agent-state';
export const inject = ['storage'];

export default function apply(ctx: HostCtxLike, config: StateHandleConfig = {}): { service: StateService; dispose: () => void } {
  const warn = makeWarn(ctx, 'state-handle');
  const ledger = new EntryLedger();
  const sink = new DurableBlobSink(warn, (kind, data) => ledger.push(kind, data));
  let store = new StateStore(sink);
  let unit: KvUnitLike | undefined;

  const service: StateService = {
    get store() {
      return store;
    },
    get sink() {
      return sink;
    },
    get durable() {
      return sink.attached;
    },
    snapshot: () => snapshotOf(store),
    async persist(): Promise<StateSnapshot> {
      const snap = snapshotOf(store);
      if (unit === undefined) return snap; // 内存降级：无处可写，快照照常返回
      let seq = 0;
      for (const entry of snap.handles) await unit.putRecord('handles', String(++seq), entry);
      ledger.push('persist-catalog', { handles: snap.handles.length });
      return snap;
    },
    async load(): Promise<StateSnapshot | null> {
      if (unit === undefined) return null;
      const all = await unit.loadAll();
      return {
        handles: Object.entries(all.tables['handles'] ?? [])
          .sort((a, b) => Number(a[0]) - Number(b[0])) // 表键为序号；磁盘序是字典序，须数值排序
          .map(([, value]) => value as HandleSnapshotEntry),
      };
    },
    async resume(snap?: StateSnapshot): Promise<ResumeReport> {
      const source = snap ?? (await service.load());
      if (source === null || source === undefined) {
        ledger.push('resume-unavailable', {});
        warn('resume 快照不可得（storage 未接驳或为空）：保留原 store');
        return { ok: false, rebuilt: 0, skipped: 0, mismatches: ['持久层快照不可得'] };
      }
      const mismatches: string[] = [];
      const next = new StateStore(sink);
      let rebuilt = 0;
      let skipped = 0;
      for (const entry of source.handles) {
        if (entry.contentB64 === null) {
          skipped += 1;
          continue;
        }
        try {
          const ref = refOf(entry.handle);
          if (ref === null) throw new Error('ref 解析失败');
          const bytes = b64ToBytes(entry.contentB64);
          // 内容完整性：快照 hash 与重放内容、内核寻址结果三方对上才收
          if (sha256Hex(bytes) !== entry.hash) throw new Error('内容 hash 与快照不符');
          const rebuiltHandle = next.put(entry.text ? new TextDecoder().decode(bytes) : bytes, ref);
          if (rebuiltHandle.hash !== entry.hash) throw new Error(`内核寻址 hash 不符（${rebuiltHandle.hash.slice(0, 8)}…）`);
          if (formatHandle(rebuiltHandle) !== entry.handle) throw new Error(`重建为 ${formatHandle(rebuiltHandle)}`);
          rebuilt += 1;
        } catch (error) {
          mismatches.push(`${entry.handle}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const report: ResumeReport = { ok: mismatches.length === 0, rebuilt, skipped, mismatches };
      if (report.ok) {
        store = next; // 全部对上才切换（fail-closed：不许半重建状态静默生效）
        ledger.push('resume', { rebuilt, skipped });
      } else {
        ledger.push('resume-mismatch', { ...report });
        warn('resume 重建校验失败：保留原 store，报告 mismatches', report);
      }
      return report;
    },
    flush: () => sink.flush(),
  };

  // storage 异步接驳（open → 水合 → attach）；宿主 backend 缺位 → 本地文件 KvUnit 兜底
  // （修复限制 3，durable 不再是易失内存）；连本地兜底也失败才降级内存（fail-open，不静默）
  const storage = (ctx.get?.('storage') ?? (ctx as { storage?: StorageLike }).storage) as StorageLike | undefined;
  const unitName = config.unit ?? 'tfAgentState';
  openKvUnit(storage, unitName, ['blobs', 'handles'])
    .catch(() => undefined) // 宿主 storage 异常 → 走本地兜底，最终降级由下级 catch 统一记账
    .then(async (opened) => {
      if (opened === undefined && config.localFallback !== false) {
        // 修复限制 3：本地 JSON 文件 KvUnit（JsonFileKvUnit 构造即做可写性探针，失败抛错）
        const local = new JsonFileKvUnit(join(resolveStateDir(config.stateDir), 'storage'), unitName, warn);
        await local.putRecord('blobs', '__open_probe__', { at: Date.now() });
        sink.attach(local, await hydrateFromUnit(local));
        unit = local;
        ledger.push('storage-local-fallback', { unit: unitName, file: local.file });
        warn(`宿主 storage backend "json" 不可用，降级本地文件 KvUnit（${local.file}；durable，跨会话 resume 可用）`);
        return;
      }
      if (opened === undefined) throw new Error('storage backend "json" 不可用或无 kv facet（本地兜底已关闭或失败）');
      sink.attach(opened, await hydrateFromUnit(opened));
      unit = opened;
      ledger.push('storage-attached', { unit: unitName });
    })
    .catch((error) => {
      ledger.push('storage-degraded', { error: String(error) });
      warn('storage 接驳失败（宿主与本地兜底均不可用），降级内存 BlobSink（服务照常提供）', error);
    });

  if (typeof ctx.provide !== 'function') throw new Error('[state-handle] ctx.provide 不可用：无法提供服务 ctx.state');
  ctx.provide('state', service);
  if (config.announce === true) console.error('[state-handle] mounted: provide(state)（storage 异步接驳中，降级与否见后续告警）');

  const dispose = (): void => {
    void (async () => {
      await service.persist().catch((error) => warn('句柄目录落盘失败（内存事实不丢）', error));
      await sink.flush().catch(() => {});
      await unit?.close().catch((error) => warn('storage unit 关闭失败', error));
    })();
  };
  ctx.effect?.(() => dispose, 'stateHandle.provide(state)');
  return { service, dispose };
}
