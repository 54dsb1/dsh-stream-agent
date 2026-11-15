/**
 * kernel/gate.ts —— 两段式动作准入（spec / commit / fatal / read）+ 一次性凭据。
 *
 * 内核层纪律（README §8 红线 2）：
 * - 零框架依赖：不 import 任何 @deepseek-ai/*，只允许 node:crypto（sha256，与 state.ts 寻址口径一致）；
 * - 无真实 IO：工作区写操作由调用方注入的 StagingSink 承接（只写暂存区），内核不做 fs/网络；
 * - 装配期失败 vs 运行时拒绝：缺 reversibility 声明在 registry.freeze() 抛错（启动期失败），
 *   策略性拒绝一律返回结构化结果，绝不静默。
 *
 * 两段式模型（04 号任务书目标 A）：
 *   spec   级：写暂存区 + 产 diff，不触碰真实工作区；产出一次性凭据（绑定目标内容 hash）；
 *   commit 级：必须携带有效凭据才放行（already_used / expired / hash_mismatch / unknown 结构化拒绝）；
 *   fatal  级：无人工批准通道时直接拒绝；
 *   read   级：直接放行。
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// 基础类型
// ---------------------------------------------------------------------------

export type Reversibility = 'read' | 'spec' | 'commit' | 'fatal';

export interface ActionDecl {
  name: string;
  /** 可逆性级别。缺声明不报错，但 registry.freeze() 会抛 MissingReversibilityError。 */
  reversibility?: Reversibility;
  description?: string;
}

/** 一次性凭据：绑定 spec 内容 hash，超时或二次使用即作废。 */
export interface CommitCredential {
  readonly id: string;
  /** 绑定 spec 内容（暂存写入 receipts）的 sha256。 */
  readonly specHash: string;
  readonly taskId: string;
  readonly expiresAt: number;
  /** 一次性：commit 放行一次后置 true。 */
  used: boolean;
}

export type CredentialRejectionReason =
  | 'hash_mismatch'
  | 'expired'
  | 'already_used'
  | 'unknown';

/** 凭据校验失败必须返回结构化原因，不允许只给 "denied"。 */
export interface CredentialRejection {
  reason: CredentialRejectionReason;
  detail: string;
}

// ---------------------------------------------------------------------------
// 注入接口（内核不做真实 IO 的唯一出口）
// ---------------------------------------------------------------------------

export interface StagedWriteReceipt {
  path: string;
  /** 暂存写入内容的 sha256。 */
  hash: string;
}

/**
 * 暂存槽。契约：writeStaged 只写暂存区，绝不触碰真实工作区。
 * 内核在 speculate 前后各探测一次 workspaceHash，探测到变化直接抛 StagingLeakError（fail-closed）。
 */
export interface StagingSink {
  /** 写暂存区，返回写入内容的 hash。 */
  writeStaged(path: string, content: string): StagedWriteReceipt;
  /** 暂存内容相对基线的 diff（纯文本）。 */
  diffStaged(): string;
  /** 只读探针：真实工作区中该路径当前内容的 hash（不存在视为空串 hash）。 */
  workspaceHash(path: string): string;
}

/** fatal 级动作的人工批准通道（可缺省：缺省时 fatal 一律拒绝）。 */
export interface ApprovalChannel {
  requestApproval(req: {
    action: string;
    taskId?: string;
    detail: string;
  }): boolean | Promise<boolean>;
}

/** 可注入时钟：过期判定不做真实 Date.now 依赖，测试可冻结/拨快。 */
export interface GateClock {
  now(): number;
}

export class SystemClock implements GateClock {
  now(): number {
    return Date.now();
  }
}

// ---------------------------------------------------------------------------
// 错误类型（装配期 / 编程错误 → 抛错；策略拒绝 → 结构化返回）
// ---------------------------------------------------------------------------

/** 缺 reversibility 声明：freeze() 时抛（启动期失败，非运行时拒绝）。 */
export class MissingReversibilityError extends Error {
  readonly actions: string[];
  constructor(actions: string[]) {
    super(
      `registry.freeze() 失败：以下 action 缺 reversibility 声明：${actions.join(', ')}`,
    );
    this.name = 'MissingReversibilityError';
    this.actions = actions;
  }
}

export class UnknownActionError extends Error {
  constructor(name: string) {
    super(`未注册的 action：${name}`);
    this.name = 'UnknownActionError';
  }
}

export class RegistryFrozenError extends Error {
  constructor() {
    super('registry 已冻结，禁止再 declare()');
    this.name = 'RegistryFrozenError';
  }
}

export class RegistryNotFrozenError extends Error {
  constructor() {
    super('registry 尚未 freeze()，禁止使用（装配期失败要趁早暴露）');
    this.name = 'RegistryNotFrozenError';
  }
}

/** speculate() 用在非 spec 级 action 上：编程错误，抛错。 */
export class NotSpecActionError extends Error {
  constructor(name: string, reversibility: Reversibility) {
    super(
      `action "${name}" 的 reversibility 是 ${reversibility}，只有 spec 级动作能走 speculate()`,
    );
    this.name = 'NotSpecActionError';
  }
}

/** speculate 后探测到真实工作区变化：StagingSink 违反"只写暂存区"契约，fail-closed。 */
export class StagingLeakError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(
      `StagingSink 契约破坏：speculate 写暂存区后探测到工作区 "${path}" 内容变化（暂存泄漏进真实工作区）`,
    );
    this.name = 'StagingLeakError';
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// 决策类型
// ---------------------------------------------------------------------------

export interface SpecWrite {
  path: string;
  content: string;
}

export interface SpecRequest {
  action: string;
  taskId: string;
  writes: SpecWrite[];
  detail?: string;
}

export type SpecResult =
  | {
      verdict: 'allow';
      diff: string;
      specHash: string;
      credential: CommitCredential;
    }
  | { verdict: 'deny'; reason: string; detail: string };

export interface CommitRequest {
  action: string;
  taskId: string;
  credential: CommitCredential;
}

export type CommitResult =
  | { verdict: 'allow'; credentialId: string; action: string }
  | { verdict: 'deny'; rejection: CredentialRejection };

export interface AdmitRequest {
  action: string;
  taskId?: string;
  detail?: string;
}

export type AdmitResult =
  | { verdict: 'allow'; reversibility: Reversibility }
  | { verdict: 'deny'; reason: string; detail: string };

// ---------------------------------------------------------------------------
// ActionRegistry
// ---------------------------------------------------------------------------

interface DeclRecord {
  name: string;
  reversibility?: Reversibility;
  description?: string;
}

export class ActionRegistry {
  #decls = new Map<string, DeclRecord>();
  #frozen = false;

  /** 注册动作声明。冻结后调用抛 RegistryFrozenError；重名抛错。 */
  declare(decl: ActionDecl): this {
    if (this.#frozen) throw new RegistryFrozenError();
    if (this.#decls.has(decl.name)) {
      throw new Error(`action 重复注册：${decl.name}`);
    }
    this.#decls.set(decl.name, {
      name: decl.name,
      reversibility: decl.reversibility,
      description: decl.description,
    });
    return this;
  }

  /** 装配期冻结点：任何一个 action 缺 reversibility 声明都在此抛错（启动期失败）。 */
  freeze(): void {
    const missing: string[] = [];
    for (const d of this.#decls.values()) {
      if (!d.reversibility) missing.push(d.name);
    }
    if (missing.length > 0) throw new MissingReversibilityError(missing);
    this.#frozen = true;
  }

  get frozen(): boolean {
    return this.#frozen;
  }

  reversibilityOf(name: string): Reversibility {
    if (!this.#frozen) throw new RegistryNotFrozenError();
    const d = this.#decls.get(name);
    if (!d) throw new UnknownActionError(name);
    return d.reversibility as Reversibility;
  }
}

// ---------------------------------------------------------------------------
// ActionGate
// ---------------------------------------------------------------------------

interface CredentialRecord {
  credential: CommitCredential;
  action: string;
  /** spec 时采样的目标工作区内容 hash（path → hash）；commit 时逐项复核。 */
  expectedWorkspace: Array<{ path: string; hash: string }>;
}

export interface ActionGateOptions {
  registry: ActionRegistry;
  staging: StagingSink;
  clock?: GateClock;
  /** 凭据有效期，默认 5 分钟。 */
  credentialTtlMs?: number;
  /** fatal 级人工批准通道。缺省时 fatal 级一律拒绝。 */
  approval?: ApprovalChannel;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** spec 内容 hash：对暂存写入 receipts 做确定性序列化后 sha256（口径与 state.ts 一致）。 */
function computeSpecHash(receipts: readonly StagedWriteReceipt[]): string {
  const canonical = JSON.stringify(
    receipts
      .map((r) => ({ path: r.path, hash: r.hash }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
  return sha256(canonical);
}

export class ActionGate {
  readonly #registry: ActionRegistry;
  readonly #staging: StagingSink;
  readonly #clock: GateClock;
  readonly #ttl: number;
  readonly #approval?: ApprovalChannel;
  readonly #credentials = new Map<string, CredentialRecord>();
  #seq = 0;

  constructor(opts: ActionGateOptions) {
    this.#registry = opts.registry;
    this.#staging = opts.staging;
    this.#clock = opts.clock ?? new SystemClock();
    this.#ttl = opts.credentialTtlMs ?? 300_000;
    this.#approval = opts.approval;
  }

  #assertUsable(action: string): Reversibility {
    return this.#registry.reversibilityOf(action); // 未冻结 / 未注册 → 抛错（装配期失败）
  }

  /**
   * spec 级动作：写暂存区 + 产 diff + 发一次性凭据；对真实工作区零副作用。
   * - 非冻结/未注册 → 抛错；非 spec 级 → 抛 NotSpecActionError（编程错误）；
   * - 写暂存区前后各探测一次工作区，探测到变化抛 StagingLeakError（不发凭据）。
   */
  speculate(req: SpecRequest): SpecResult {
    const rev = this.#assertUsable(req.action);
    if (rev !== 'spec') throw new NotSpecActionError(req.action, rev);
    if (!req.writes || req.writes.length === 0) {
      return {
        verdict: 'deny',
        reason: 'empty-spec',
        detail: `spec 请求 "${req.action}"（taskId=${req.taskId}）没有任何写入目标`,
      };
    }

    // 1. 先采样目标工作区 hash（在写暂存区之前，若暂存泄漏也逃不过前后对比）
    const expectedWorkspace = req.writes.map((w) => ({
      path: w.path,
      hash: this.#staging.workspaceHash(w.path),
    }));

    // 2. 写暂存区（内核不做真实 IO，全部经注入的 StagingSink）
    const receipts = req.writes.map((w) =>
      this.#staging.writeStaged(w.path, w.content),
    );

    // 3. 复核：暂存写入不得触碰真实工作区（fail-closed）
    for (const e of expectedWorkspace) {
      if (this.#staging.workspaceHash(e.path) !== e.hash) {
        throw new StagingLeakError(e.path);
      }
    }

    const specHash = computeSpecHash(receipts);
    const credential: CommitCredential = {
      id: `${req.taskId}#spec#${++this.#seq}`,
      specHash,
      taskId: req.taskId,
      expiresAt: this.#clock.now() + this.#ttl,
      used: false,
    };
    this.#credentials.set(credential.id, {
      credential,
      action: req.action,
      expectedWorkspace,
    });

    return {
      verdict: 'allow',
      diff: this.#staging.diffStaged(),
      specHash,
      credential,
    };
  }

  /**
   * commit 级动作：必须携带有效一次性凭据。
   * 校验顺序（确定性）：unknown → already_used → expired → hash_mismatch。
   * 任一失败返回结构化原因；凭据不被消费（hash_mismatch 不烧凭据，但凭据已被用过则 already_used 优先）。
   */
  commit(req: CommitRequest): CommitResult {
    this.#assertUsable(req.action);
    const rec = this.#credentials.get(req.credential.id);
    if (!rec) {
      return {
        verdict: 'deny',
        rejection: {
          reason: 'unknown',
          detail: `凭据 ${req.credential.id} 不存在（从未签发或 id 传错）`,
        },
      };
    }
    if (rec.credential.used) {
      return {
        verdict: 'deny',
        rejection: {
          reason: 'already_used',
          detail: `凭据 ${rec.credential.id} 是一次性的，已在之前的 commit 中消费`,
        },
      };
    }
    const now = this.#clock.now();
    if (now > rec.credential.expiresAt) {
      return {
        verdict: 'deny',
        rejection: {
          reason: 'expired',
          detail: `凭据 ${rec.credential.id} 已于 ${rec.credential.expiresAt} 过期（当前 ${now}）`,
        },
      };
    }
    // spec 之后目标内容变化 → 凭据作废（hash_mismatch）
    for (const e of rec.expectedWorkspace) {
      const current = this.#staging.workspaceHash(e.path);
      if (current !== e.hash) {
        return {
          verdict: 'deny',
          rejection: {
            reason: 'hash_mismatch',
            detail: `凭据 ${rec.credential.id} 绑定的目标 "${e.path}" 内容在 spec 之后发生了变化（期望 ${e.hash.slice(0, 8)}…，实际 ${current.slice(0, 8)}…）`,
          },
        };
      }
    }
    rec.credential.used = true; // 一次性消费
    return {
      verdict: 'allow',
      credentialId: rec.credential.id,
      action: req.action,
    };
  }

  /**
   * 一次性准入判定（read / fatal / 未携带凭据的 commit、spec）。
   * - read：直接放行；
   * - fatal：无批准通道 → 拒绝（理由可读）；有通道 → 交给通道裁决；
   * - commit：准入不走这里——必须先 speculate() 拿凭据再走 commit()；
   * - spec：准入同样走 speculate()。
   */
  async admit(req: AdmitRequest): Promise<AdmitResult> {
    const rev = this.#assertUsable(req.action);
    if (rev === 'read') {
      return { verdict: 'allow', reversibility: 'read' };
    }
    if (rev === 'fatal') {
      if (!this.#approval) {
        return {
          verdict: 'deny',
          reason: 'fatal-no-approval-channel',
          detail: `action "${req.action}" 是 fatal 级（不可逆），当前装配没有人工批准通道，直接拒绝`,
        };
      }
      const ok = await this.#approval.requestApproval({
        action: req.action,
        taskId: req.taskId,
        detail: req.detail ?? '',
      });
      if (!ok) {
        return {
          verdict: 'deny',
          reason: 'fatal-approval-denied',
          detail: `action "${req.action}" 的人工批准被拒绝`,
        };
      }
      return { verdict: 'allow', reversibility: 'fatal' };
    }
    return {
      verdict: 'deny',
      reason: rev === 'commit' ? 'commit-requires-credential' : 'spec-via-speculate',
      detail:
        rev === 'commit'
          ? `action "${req.action}" 是 commit 级：先由 spec 级动作产出一次性凭据，再走 gate.commit() 放行，不允许直接准入`
          : `action "${req.action}" 是 spec 级：走 gate.speculate() 写暂存区并领取一次性凭据，不允许直接准入`,
    };
  }
}
