// kernel/state.ts —— 内容寻址状态树与句柄（M1，分派 02）
//
// 内核层纪律：零框架依赖（不 import 任何 @deepseek-ai/*）；
// 除 node:crypto 哈希计算外无任何副作用（无 fs、无网络、无 console）——
// BlobSink 是唯一 IO 出口，依赖注入全走构造参数。
//
// 不变量 I2（强制溯源，违反即抛错，绝不静默修正）：
//   confidence="derived" 必须带非空 derivedFrom；
//   confidence="stated"  必须不带 derivedFrom。

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type HandleKind = 'file' | 'blob' | 'obs';

/** 句柄：内容寻址 + 版本。形如 file:src/app.ts@v3 / obs:tool:callId@v3 / blob:1a2b3c4d@v1 */
export interface StateHandle {
  readonly kind: HandleKind;
  readonly path: string;
  readonly version: number;
  readonly hash: string; // sha256 hex
}

/** 状态节点：强制溯源（不变量 I2） */
export interface StateNode {
  readonly id: string;
  readonly value: unknown;
  readonly derivedFrom?: readonly string[]; // 来源节点 id 列表
  readonly confidence: 'stated' | 'derived'; // stated 必须无 derivedFrom；derived 必须有
  readonly createdAt: number;
}

/**
 * BlobSink：内核唯一的 IO 出口。默认内存实现；
 * localStorage / 文件实现在适配层（07 号分派）接到 DSH storage 服务。
 */
export interface BlobSink {
  write(key: string, data: Uint8Array): void;
  read(key: string): Uint8Array | undefined;
}

export interface PutRef {
  kind?: HandleKind; // 缺省 'blob'（path 自动取 hash 前 8 位）
  path?: string; // kind='file' 必填
  tool?: string; // kind='obs' 必填
  callId?: string; // kind='obs' 必填
}

export interface SetOpts {
  derivedFrom?: readonly string[];
  confidence?: 'stated' | 'derived';
}

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

export class InvalidStateWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateWriteError';
  }
}

export class UnknownHandleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownHandleError';
  }
}

export class CycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CycleError';
  }
}

// ---------------------------------------------------------------------------
// 默认内存 BlobSink
// ---------------------------------------------------------------------------

export class MemoryBlobSink implements BlobSink {
  private readonly blobs = new Map<string, Uint8Array>();

  write(key: string, data: Uint8Array): void {
    this.blobs.set(key, data);
  }

  read(key: string): Uint8Array | undefined {
    return this.blobs.get(key);
  }
}

// ---------------------------------------------------------------------------
// 句柄格式化 / 解析
// ---------------------------------------------------------------------------

export function formatHandle(handle: StateHandle): string {
  return `${handle.kind}:${handle.path}@v${handle.version}`;
}

/** 解析句柄字符串；格式非法抛 UnknownHandleError。 */
export function parseHandle(text: string): StateHandle {
  const at = text.lastIndexOf('@v');
  if (at <= 0) throw new UnknownHandleError(`malformed handle: "${text}"`);
  const prefix = text.slice(0, at);
  const version = Number(text.slice(at + 2));
  if (!Number.isInteger(version) || version < 1) {
    throw new UnknownHandleError(`malformed handle version: "${text}"`);
  }
  const colon = prefix.indexOf(':');
  if (colon < 0) throw new UnknownHandleError(`malformed handle: "${text}"`);
  const kind = prefix.slice(0, colon) as HandleKind;
  const path = prefix.slice(colon + 1);
  if (!path) throw new UnknownHandleError(`malformed handle: "${text}"`);
  if (kind !== 'file' && kind !== 'blob' && kind !== 'obs') {
    throw new UnknownHandleError(`unknown handle kind: "${text}"`);
  }
  // blob 句柄 path 必须是 8 位 hash 前缀（写入时由 put 保证）
  if (kind === 'blob' && !/^[0-9a-f]{8}$/.test(path)) {
    throw new UnknownHandleError(`malformed blob handle: "${text}"`);
  }
  return { kind, path, version, hash: '' };
}

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

export class StateStore {
  private readonly sink: BlobSink;
  private readonly textEncoder = new TextEncoder();
  private readonly textDecoder = new TextDecoder();

  /** 每个 `${kind}:${path}` 键下：hash → 版本号（同一内容复用同一版本） */
  private readonly versionByHash = new Map<string, Map<string, number>>();
  /** 每个 `${kind}:${path}` 键下的下一个版本号 */
  private readonly nextVersion = new Map<string, number>();
  /** 哪些 hash 是以字符串写入的（get 时还原为 string） */
  private readonly textHashes = new Set<string>();
  private readonly nodes = new Map<string, StateNode>();
  /** 句柄目录：按创建顺序去重 */
  private readonly catalog = new Map<string, StateHandle>();

  constructor(sink?: BlobSink) {
    this.sink = sink ?? new MemoryBlobSink();
  }

  /**
   * 内容寻址写。同一内容重复写入得到同一版本（sha256 相同 → 版本号复用）。
   * ref 缺省写 blob（path = hash 前 8 位）；file / obs 见 PutRef。
   */
  put(content: Uint8Array | string, ref?: PutRef): StateHandle {
    const bytes = typeof content === 'string' ? this.textEncoder.encode(content) : content;
    const hash = sha256Hex(bytes);
    const kind = ref?.kind ?? 'blob';

    let path: string;
    if (kind === 'file') {
      if (!ref?.path) {
        throw new InvalidStateWriteError('put() with kind="file" requires ref.path');
      }
      path = ref.path;
    } else if (kind === 'obs') {
      if (!ref?.tool || !ref?.callId) {
        throw new InvalidStateWriteError('put() with kind="obs" requires ref.tool and ref.callId');
      }
      path = `${ref.tool}:${ref.callId}`;
    } else {
      path = hash.slice(0, 8);
    }

    const key = `${kind}:${path}`;
    let byHash = this.versionByHash.get(key);
    if (!byHash) {
      byHash = new Map();
      this.versionByHash.set(key, byHash);
    }

    let version = byHash.get(hash);
    if (version === undefined) {
      version = this.nextVersion.get(key) ?? 1;
      this.nextVersion.set(key, version + 1);
      byHash.set(hash, version);
    }

    // 内容寻址存储：同一 hash 只存一份，天然去重
    this.sink.write(hash, bytes);
    if (typeof content === 'string') this.textHashes.add(hash);

    const handle: StateHandle = { kind, path, version, hash };
    this.catalog.set(formatHandle(handle), handle);
    return handle;
  }

  /** 取回句柄对应的全文。句柄不存在 / 版本不符 / blob 丢失 → UnknownHandleError。 */
  get(handle: StateHandle): Uint8Array | string {
    this.assertKnownHandle(handle);
    const data = this.sink.read(handle.hash);
    if (!data) {
      throw new UnknownHandleError(`blob missing for handle: ${formatHandle(handle)}`);
    }
    return this.textHashes.has(handle.hash) ? this.textDecoder.decode(data) : data;
  }

  /**
   * 写状态节点（不变量 I2）。节点不可变：同一 id 重复写入抛错。
   * derivedFrom 允许前向引用（引用尚未写入的节点）——环不在写入期阻止，
   * 而是在 trace() 展开时检测（否则环根本无法构造出来测试）。
   */
  set(id: string, value: unknown, opts: SetOpts = {}): StateNode {
    if (this.nodes.has(id)) {
      throw new InvalidStateWriteError(`state node already exists: "${id}"`);
    }
    const confidence = opts.confidence ?? 'stated';
    const { derivedFrom } = opts;

    if (confidence === 'derived') {
      if (!derivedFrom || derivedFrom.length === 0) {
        throw new InvalidStateWriteError(
          `I2 violation: node "${id}" is derived but has no derivedFrom`,
        );
      }
    } else if (derivedFrom !== undefined) {
      throw new InvalidStateWriteError(
        `I2 violation: node "${id}" is stated but carries derivedFrom`,
      );
    }
    if (derivedFrom) {
      for (const src of derivedFrom) {
        if (typeof src !== 'string' || src.length === 0) {
          throw new InvalidStateWriteError(`I2 violation: node "${id}" has empty derivedFrom entry`);
        }
      }
    }

    const node: StateNode = Object.freeze({
      id,
      value,
      ...(derivedFrom ? { derivedFrom: [...derivedFrom] } : {}),
      confidence,
      createdAt: Date.now(),
    });
    this.nodes.set(id, node);
    return node;
  }

  /**
   * 完整来源链：从节点出发递归展开 derivedFrom（含节点自身，先序 DFS），
   * 去重；展开路径上出现环抛 CycleError，来源缺失抛 UnknownHandleError。
   */
  trace(id: string): StateNode[] {
    const start = this.nodes.get(id);
    if (!start) throw new UnknownHandleError(`unknown state node: "${id}"`);

    const chain: StateNode[] = [];
    const seen = new Set<string>();
    const inStack = new Set<string>();

    const visit = (node: StateNode): void => {
      if (inStack.has(node.id)) {
        throw new CycleError(`provenance cycle detected at node "${node.id}"`);
      }
      if (seen.has(node.id)) return; // 菱形依赖去重
      seen.add(node.id);
      inStack.add(node.id);
      chain.push(node);
      for (const src of node.derivedFrom ?? []) {
        const parent = this.nodes.get(src);
        if (!parent) {
          throw new UnknownHandleError(
            `provenance node "${src}" (referenced by "${node.id}") does not exist`,
          );
        }
        visit(parent);
      }
      inStack.delete(node.id);
    };

    visit(start);
    return chain;
  }

  /** 两个句柄内容的逐行差异（unified 风格，无上下文行）。内容一致返回空串。 */
  diff(fromHandle: StateHandle, toHandle: StateHandle): string {
    const from = this.get(fromHandle);
    const to = this.get(toHandle);
    const a = splitLines(asText(from));
    const b = splitLines(asText(to));
    if (arraysEqual(a, b)) return '';

    const ops = diffOps(a, b);
    const out: string[] = [`--- ${formatHandle(fromHandle)}`, `+++ ${formatHandle(toHandle)}`];

    let i = 0;
    while (i < ops.length) {
      if (ops[i].type === 'equal') {
        i += 1; // 无上下文行格式：equal 直接跳过
        continue;
      }
      // 收集一个连续变更块（-/+ 混合，直到遇到 equal）
      const aStart = ops[i].aLine;
      const bStart = ops[i].bLine;
      let aLen = 0;
      let bLen = 0;
      const body: string[] = [];
      while (i < ops.length && ops[i].type !== 'equal') {
        const op = ops[i];
        if (op.type === 'delete') {
          body.push(`-${op.text}`);
          aLen += 1;
        } else {
          body.push(`+${op.text}`);
          bLen += 1;
        }
        i += 1;
      }
      // count=0 时起始行取变更点前一行（GNU unified diff 约定）
      const aHead = aLen > 0 ? `${aStart},${aLen}` : `${aStart - 1},0`;
      const bHead = bLen > 0 ? `${bStart},${bLen}` : `${bStart - 1},0`;
      out.push(`@@ -${aHead} +${bHead} @@`);
      out.push(...body);
    }
    return out.join('\n');
  }

  /** 当前句柄目录（按首次创建顺序，已去重）。 */
  handles(): StateHandle[] {
    return [...this.catalog.values()];
  }

  private assertKnownHandle(handle: StateHandle): void {
    if (!handle || typeof handle !== 'object') {
      throw new UnknownHandleError('not a handle');
    }
    if (handle.kind !== 'file' && handle.kind !== 'blob' && handle.kind !== 'obs') {
      throw new UnknownHandleError(`unknown handle kind: ${String(handle.kind)}`);
    }
    const byHash = this.versionByHash.get(`${handle.kind}:${handle.path}`);
    const version = byHash?.get(handle.hash);
    if (version !== handle.version) {
      throw new UnknownHandleError(
        `unknown handle: ${formatHandle(handle)}` +
          (version !== undefined ? ` (actual version v${version})` : ''),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 内部工具（纯函数）
// ---------------------------------------------------------------------------

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function asText(content: Uint8Array | string): string {
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

type DiffOp =
  | { type: 'equal'; aLine: number; bLine: number; text: string }
  | { type: 'delete'; aLine: number; bLine: number; text: string }
  | { type: 'insert'; aLine: number; bLine: number; text: string };

/** 经典 LCS 逐行 diff（O(n·m)，内核数据量下足够），输出带行号的 op 序列。 */
function diffOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'equal', aLine: i + 1, bLine: j + 1, text: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'delete', aLine: i + 1, bLine: j + 1, text: a[i] });
      i += 1;
    } else {
      ops.push({ type: 'insert', aLine: i + 1, bLine: j + 1, text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'delete', aLine: i + 1, bLine: m + 1, text: a[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'insert', aLine: n + 1, bLine: j + 1, text: b[j] });
    j += 1;
  }
  return ops;
}
