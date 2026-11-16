// entry/action-gate.ts —— 动作门（M4 适配，分派 07）
//
// 挂点：ToolsService 管线 guard（F6，dsh-tools/lib/types/index.d.ts:136； ToolGuard 契约
// contracts.d.ts:374：同步、只拒绝不放行、不可改写——探针 B 实测，参数改写需 executor 层）。
// 职责：翻译内核 gate 的判定为管线语义：
//   1. 未声明 reversibility 的受治理动作 → deny + 可读理由（内核 UnknownActionError 原文透传）；
//      非本插件治理空间的宿主工具（grep/web/…）不表意见（返回 undefined，放行权归宿主策略层）。
//   2. spec 级：写暂存区（StagingSink 接 DSH storage，绝不触碰真实工作区）+ 产 diff +
//      领一次性凭据；默认 stage-commit 模式在本守卫内完成 speculate→commit 自洽闭环后放行
//      （否则 tf-write 永远无法落地）；strict 模式走内核 admit()，拒绝透传（留给驱动器侧两段式）。
//   3. commit 凭据校验：kernel gate.commit 的结构化拒绝（already_used / expired /
//      hash_mismatch / unknown）原样透传为可读拒绝串。
//   4. fatal 级：无批准通道 → deny（内核 admit 同款理由）。
// fail-open（红线 5）：守卫自身异常 → 不表意见（放行）+ ledger 记 gate_error，绝不静默。
// 红线：本 entry 不写业务逻辑——判定/凭据/暂存泄漏探测全在 kernel/gate.ts。

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ActionRegistry, ActionGate, SystemClock } from '../kernel/gate.ts';
import type { StagingSink, StagedWriteReceipt, Reversibility, CommitCredential } from '../kernel/gate.ts';
import { makeWarn, EntryLedger, kernelDiffer, openKvUnit } from './adapter-kit.ts';
import type { HostCtxLike, StorageLike, KvUnitLike } from './adapter-kit.ts';

export interface ActionGateConfig {
  /** 工作区根（workspaceHash 探针与 diff 基线；默认 process.cwd()） */
  workspaceRoot?: string;
  /** staging KvUnit 名（默认 'tfAgentStaging'；后端固定 'json'，与 state-handle 同款接驳） */
  unit?: string;
  /** 凭据有效期 ms（默认 300_000，透传内核） */
  credentialTtlMs?: number;
  /** spec 级放行模式：'stage-commit'（默认，守卫内闭环）/ 'strict'（拒绝透传，两段式上移驱动器） */
  mode?: 'stage-commit' | 'strict';
  /** 动作声明（提供即整体替换默认声明；缺省用默认）；受治理集合 = 声明集合 ∪ tf-* 前缀 */
  actions?: Record<string, Reversibility>;
  /** 测试注错位：守卫体抛错（fail-open 验证用；生产不得设置） */
  faultInjection?: boolean;
  /** 装载自证横幅（排障用；preset/patch 激活对 CLI 静默，探针 A 惯例） */
  announce?: boolean;
}

export interface ActionGateHandle {
  registry: ActionRegistry;
  gate: ActionGate;
  faults: EntryLedger;
  dispose: () => void;
}

/** StagingSink 适配：暂存区在 DSH storage（per-record 表），工作区探针走 fs（只读）。 */
function makeStagingSink(workspaceRoot: string, getUnit: () => KvUnitLike | undefined, faults: EntryLedger): StagingSink {
  const staged = new Map<string, string>(); // path -> content（暂存区内存面；storage 异步落盘）
  const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
  const safeKey = (p: string): string => p.replace(/[^a-zA-Z0-9_-]/g, '_') || 'root';
  return {
    writeStaged(path, content) {
      staged.set(path, content);
      const receipt: StagedWriteReceipt = { path, hash: sha(content) };
      void getUnit()
        ?.putRecord('staged', safeKey(path), { path, content })
        .catch((error) => faults.push('staging-persist-error', { path, error: String(error) })); // diff/凭据以内存为准；落盘失败不静默
      return receipt;
    },
    diffStaged() {
      if (staged.size === 0) return '';
      const differ = kernelDiffer(); // 复用内核逐行 diff（零业务逻辑重写）
      const out: string[] = [];
      for (const [path, content] of staged) {
        const before = readWorkspace(path, workspaceRoot);
        if (before === content) continue;
        const hFrom = differ.put(before);
        const hTo = differ.put(content);
        out.push(differ.diff(hFrom, hTo));
      }
      return out.join('\n');
    },
    workspaceHash(path) {
      return sha(readWorkspace(path, workspaceRoot));
    },
  };
}

function readWorkspace(path: string, root: string): string {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return ''; // 不存在视为空串 hash（内核 StagingSink 契约 :74-75）
  }
}

/** 默认声明（配置可覆盖）；受治理集合 = 声明集合 ∪ tf-* 前缀。
 *  tf-code 本体按 read 级准入（程序内的 tools.write 绑定走宿主管线，各自受原生守卫治理）。 */
function defaultActions(): Record<string, Reversibility> {
  return {
    'tf-write': 'spec', write: 'spec',
    'tf-read': 'read', read: 'read',
    'tf-peek': 'read', 'tf-final': 'read',
    'tf-bash': 'read', bash: 'read',
    'tf-code': 'read',
  };
}

export const name = 'stream-agent-action-gate';
export const inject = ['tools', 'storage'];

export default function apply(ctx: HostCtxLike, config: ActionGateConfig = {}): ActionGateHandle {
  const warn = makeWarn(ctx, 'action-gate');
  const faults = new EntryLedger();
  const workspaceRoot = config.workspaceRoot ?? process.cwd();

  // staging unit 异步接驳（失败降级为纯内存暂存区，内核泄漏探测仍生效）
  let unit: KvUnitLike | undefined;
  const storage = (ctx.get?.('storage') ?? (ctx as { storage?: StorageLike }).storage) as StorageLike | undefined;
  openKvUnit(storage, config.unit ?? 'tfAgentStaging', ['staged'])
    .then((opened) => {
      unit = opened;
      faults.push('staging-attached', { attached: unit !== undefined });
    })
    .catch((error) => faults.push('staging-degraded', { error: String(error) }));

  const registry = new ActionRegistry();
  const actions = config.actions ?? defaultActions();
  for (const [action, rev] of Object.entries(actions)) registry.declare({ name: action, reversibility: rev });
  registry.freeze(); // 装配期失败趁早暴露（缺声明在此抛 MissingReversibilityError）
  const gate = new ActionGate({ registry, staging: makeStagingSink(workspaceRoot, () => unit, faults), clock: new SystemClock(), ...(config.credentialTtlMs === undefined ? {} : { credentialTtlMs: config.credentialTtlMs }) });
  const mode = config.mode ?? 'stage-commit';
  const governed = (name: string): boolean => name.startsWith('tf-') || name in actions;

  /** 拒绝串：内核 reason/detail 原样内嵌（"结构化可读理由，内核输出透传"）。 */
  const denial = (reason: string, detail: string): string => `[action-gate] ${reason}: ${detail}`;

  /** spec/commit 级执行体的守卫翻译（stage-commit 闭环或 strict 透传）。 */
  function gateSpecLevel(rev: 'spec' | 'commit', name: string, args: Record<string, unknown>): string | undefined {
    const taskId = typeof args['__taskId'] === 'string' ? (args['__taskId'] as string) : 'ungoverned-task';
    if (mode === 'strict') {
      // strict 模式：两段式上移驱动器侧，守卫只透传内核 admit() 的拒绝语义。
      // 内核 admit 是 async（fatal 批准通道），而 ToolGuard 是同步面——此处按内核
      // gate.ts admit() :455-462 的 reason/detail 原文镜像，异步批准走 pre-execute waterfall（v2）。
      const detail = rev === 'commit'
        ? `action "${name}" 是 commit 级：先由 spec 级动作产出一次性凭据，再走 gate.commit() 放行，不允许直接准入`
        : `action "${name}" 是 spec 级：走 gate.speculate() 写暂存区并领取一次性凭据，不允许直接准入`;
      return denial(rev === 'commit' ? 'commit-requires-credential' : 'spec-via-speculate', detail);
    }
    const writes = specWritesOf(args);
    if (writes === null) return denial('unparseable-spec', `动作 "${name}" 的参数缺 file_path/path + content，无法落暂存区`);
    const spec = gate.speculate({ action: name, taskId, writes });
    if (spec.verdict === 'deny') return denial(spec.reason, spec.detail);
    const commit = gate.commit({ action: name, taskId, credential: spec.credential }); // 一次性凭据即领即验
    return commit.verdict === 'deny' ? denial(commit.rejection.reason, commit.rejection.detail) : undefined;
  }

  // ---- ToolsService guard（F6；同步、只拒绝）--------------------------------
  const guard = (execution: { name: string; arguments?: unknown }): string | undefined => {
    try {
      if (config.faultInjection === true) throw new Error('injected gate fault');
      const name = execution.name;
      let rev: Reversibility;
      try {
        rev = registry.reversibilityOf(name);
      } catch (error) {
        // 未声明：受治理动作 deny（内核错误原文透传）；宿主自有工具不表意见
        return governed(name) ? denial('undeclared-reversibility', error instanceof Error ? error.message : String(error)) : undefined;
      }
      const args = (execution.arguments ?? {}) as Record<string, unknown>;
      if (rev === 'read') return undefined; // 直接放行（内核 admit 的 read 语义）
      if (rev === 'fatal') {
        // 守卫是同步面，人工批准通道需异步 waterfall；headless v1 无通道 → 内核同款拒绝
        return denial('fatal-no-approval-channel', `action "${name}" 是 fatal 级（不可逆），当前装配没有人工批准通道，直接拒绝`);
      }
      if (rev === 'commit') {
        const credential = args['__credential'] as { id?: string } | undefined;
        if (credential === undefined || typeof credential.id !== 'string') {
          return denial('commit-requires-credential', `action "${name}" 是 commit 级：须携带 speculate 签发的一次性凭据（arguments.__credential.id）`);
        }
        const commit = gate.commit({ action: name, taskId: typeof args['__taskId'] === 'string' ? (args['__taskId'] as string) : 'ungoverned-task', credential: credential as unknown as CommitCredential });
        return commit.verdict === 'deny' ? denial(commit.rejection.reason, commit.rejection.detail) : undefined;
      }
      return gateSpecLevel('spec', name, args); // 走到这里 rev 必为 spec（read/fatal/commit 已处理）
    } catch (error) {
      faults.push('gate_error', { action: execution?.name ?? '', error: error instanceof Error ? error.message : String(error) });
      warn('守卫异常：放行（fail-open）', error);
      return undefined;
    }
  };

  if (typeof (ctx.get?.('tools') as { guard?: unknown } | undefined)?.guard !== 'function') {
    throw new Error('[action-gate] ctx.tools.guard 不可用：无法接入工具管线（需要 dsh-tools 服务在位）');
  }
  (ctx.get('tools') as { guard(g: typeof guard): () => void }).guard(guard);
  if (config.announce === true) console.error(`[action-gate] mounted: guard registered (actions: ${Object.keys(actions).join(',')}; mode=${mode})`);

  return {
    registry,
    gate,
    faults,
    dispose: () => {},
  };
}

/** write 类参数 → SpecWrite[]（dsh-tool-fs write schema：file_path/content；兼容 path）。 */
function specWritesOf(args: Record<string, unknown>): Array<{ path: string; content: string }> | null {
  const path = args['file_path'] ?? args['path'];
  const content = args['content'];
  if (typeof path !== 'string' || path === '' || typeof content !== 'string') return null;
  return [{ path, content }];
}
