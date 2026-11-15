/**
 * gate.ts 单测：装配期失败 / 两段式凭据全失效路径 / fatal 批准通道 / spec 零副作用。
 * 全部离线：StagingSink 用内存 mock，时钟注入，不碰网络不碰 fs。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  ActionRegistry,
  ActionGate,
  MissingReversibilityError,
  UnknownActionError,
  RegistryFrozenError,
  RegistryNotFrozenError,
  NotSpecActionError,
  StagingLeakError,
  SystemClock,
  type StagingSink,
  type StagedWriteReceipt,
  type ApprovalChannel,
  type GateClock,
  type SpecRequest,
  type CommitCredential,
  type SpecResult,
} from '../src/kernel/gate.ts';

/** 收窄 SpecResult 的辅助（避免测试里散布 as 链）。 */
function expectAllow(result: SpecResult): {
  diff: string;
  specHash: string;
  credential: CommitCredential;
} {
  assert.equal(result.verdict, 'allow');
  return result as {
    diff: string;
    specHash: string;
    credential: CommitCredential;
  };
}

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 内存 StagingSink mock：工作区只被测试显式改写，sink 自身无任何触达工作区的路径。 */
class MockStagingSink implements StagingSink {
  readonly stagedWrites: Array<{ path: string; content: string }> = [];
  /** 模拟真实工作区（path → content）。测试用 setWorkspace 显式变更以触发 hash_mismatch。 */
  readonly workspace = new Map<string, string>();

  setWorkspace(path: string, content: string): void {
    this.workspace.set(path, content);
  }

  writeStaged(path: string, content: string): StagedWriteReceipt {
    this.stagedWrites.push({ path, content });
    return { path, hash: sha(content) };
  }

  diffStaged(): string {
    if (this.stagedWrites.length === 0) return '';
    return this.stagedWrites
      .map((w) => `--- a/${w.path}\n+++ b/${w.path}\n@@\n+${w.content}`)
      .join('\n');
  }

  workspaceHash(path: string): string {
    return sha(this.workspace.get(path) ?? '');
  }
}

class FakeClock implements GateClock {
  t: number;
  constructor(t: number = 1_000) {
    this.t = t;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

function frozenRegistry(): ActionRegistry {
  const reg = new ActionRegistry();
  reg.declare({ name: 'tf-read', reversibility: 'read' });
  reg.declare({ name: 'tf-write', reversibility: 'spec' });
  reg.declare({ name: 'tf-write-commit', reversibility: 'commit' });
  reg.declare({ name: 'tf-rm-rf', reversibility: 'fatal' });
  reg.freeze();
  return reg;
}

function makeGate(opts?: {
  clock?: GateClock;
  approval?: ApprovalChannel;
  ttl?: number;
  sink?: MockStagingSink;
  registry?: ActionRegistry;
}): { gate: ActionGate; sink: MockStagingSink; clock: FakeClock } {
  const sink = opts?.sink ?? new MockStagingSink();
  const clock = (opts?.clock as FakeClock) ?? new FakeClock();
  const gate = new ActionGate({
    registry: opts?.registry ?? frozenRegistry(),
    staging: sink,
    clock,
    ...(opts?.ttl !== undefined ? { credentialTtlMs: opts.ttl } : {}),
    ...(opts?.approval ? { approval: opts.approval } : {}),
  });
  return { gate, sink, clock };
}

const specReq = (writes: Array<{ path: string; content: string }>): SpecRequest => ({
  action: 'tf-write',
  taskId: 'task-1',
  writes,
});

// ---------------------------------------------------------------------------
// 装配期：缺 reversibility 声明 → freeze() 抛错
// ---------------------------------------------------------------------------

test('registry：缺 reversibility 声明在 freeze() 抛 MissingReversibilityError（启动期失败）', () => {
  const reg = new ActionRegistry();
  reg.declare({ name: 'tf-read', reversibility: 'read' });
  reg.declare({ name: 'tf-write' }); // 缺声明
  reg.declare({ name: 'tf-bash' }); // 缺声明
  reg.declare({ name: 'tf-final', reversibility: 'commit' });
  assert.throws(
    () => reg.freeze(),
    (err: unknown) => {
      assert.ok(err instanceof MissingReversibilityError);
      // 报错列出全部缺失项，而不是只报第一个
      assert.deepEqual(err.actions.sort(), ['tf-bash', 'tf-write']);
      assert.match(err.message, /tf-write/);
      return true;
    },
  );
  // 冻结失败后 registry 保持不可用（装配期失败要趁早暴露）
  assert.equal(reg.frozen, false);
  assert.throws(() => reg.reversibilityOf('tf-read'), RegistryNotFrozenError);
});

test('registry：补齐声明后 freeze() 成功；重名/冻结后 declare 抛错；未注册 action 抛 UnknownActionError', () => {
  const reg = new ActionRegistry();
  reg.declare({ name: 'tf-write', reversibility: 'spec' });
  assert.throws(() => reg.declare({ name: 'tf-write', reversibility: 'read' }), /重复注册/);
  reg.declare({ name: 'tf-read', reversibility: 'read' });
  reg.freeze();
  assert.equal(reg.frozen, true);
  assert.equal(reg.reversibilityOf('tf-read'), 'read');
  assert.throws(() => reg.declare({ name: 'another', reversibility: 'read' }), RegistryFrozenError);
  assert.throws(() => reg.reversibilityOf('nope'), UnknownActionError);
});

// ---------------------------------------------------------------------------
// admit：read / fatal / commit-spec 分流
// ---------------------------------------------------------------------------

test('admit：read 级直接放行', async () => {
  const { gate } = makeGate();
  const result = await gate.admit({ action: 'tf-read', taskId: 't' });
  assert.deepEqual(result, { verdict: 'allow', reversibility: 'read' });
});

test('admit：fatal 级无批准通道 → 结构化拒绝，理由可读', async () => {
  const { gate } = makeGate();
  const result = await gate.admit({ action: 'tf-rm-rf', taskId: 't' });
  assert.equal(result.verdict, 'deny');
  assert.ok(result.verdict === 'deny');
  assert.equal((result as { reason: string }).reason, 'fatal-no-approval-channel');
  assert.match((result as { detail: string }).detail, /不可逆/);
  assert.match((result as { detail: string }).detail, /批准通道/);
});

test('admit：fatal 级有批准通道 → 交给通道裁决（同意放行 / 拒绝拒绝）', async () => {
  const approving: ApprovalChannel = { requestApproval: () => true };
  const denying: ApprovalChannel = { requestApproval: () => false };
  const { gate: g1 } = makeGate({ approval: approving });
  const { gate: g2 } = makeGate({ approval: denying });
  const ok = await g1.admit({ action: 'tf-rm-rf', taskId: 't' });
  assert.deepEqual(ok, { verdict: 'allow', reversibility: 'fatal' });
  const no = await g2.admit({ action: 'tf-rm-rf', taskId: 't' });
  assert.ok(no.verdict === 'deny');
  assert.equal((no as { reason: string }).reason, 'fatal-approval-denied');
});

test('admit：commit 级不允许直接准入（必须走两段式）；spec 级指向 speculate', async () => {
  const { gate } = makeGate();
  const c = await gate.admit({ action: 'tf-write-commit', taskId: 't' });
  assert.ok(c.verdict === 'deny');
  assert.match((c as { reason: string }).reason, /commit-requires-credential/);
  const s = await gate.admit({ action: 'tf-write', taskId: 't' });
  assert.ok(s.verdict === 'deny');
  assert.match((s as { reason: string }).reason, /spec-via-speculate/);
});

test('gate：未冻结 registry 上调用 → RegistryNotFrozenError（装配期失败）', () => {
  const reg = new ActionRegistry();
  reg.declare({ name: 'tf-read', reversibility: 'read' });
  const sink = new MockStagingSink();
  const gate = new ActionGate({ registry: reg, staging: sink });
  assert.rejects(() => gate.admit({ action: 'tf-read' }), RegistryNotFrozenError);
});

// ---------------------------------------------------------------------------
// speculate：spec 零副作用 + 凭据签发
// ---------------------------------------------------------------------------

test('speculate：写暂存区 + 产 diff + 发凭据；真实工作区零副作用（mock 断言）', () => {
  const { gate, sink, clock } = makeGate({ ttl: 5_000 });
  sink.setWorkspace('src/app.ts', 'const a = 1;\n');
  const before = new Map(sink.workspace);
  const stagedBefore = sink.stagedWrites.length;

  const result = expectAllow(
    gate.speculate(specReq([{ path: 'src/app.ts', content: 'const a = 2;\n' }])),
  );

  // 工作区未被触碰：map 深比较不变
  assert.deepEqual([...sink.workspace], [...before]);
  // 写的是暂存区，不是工作区
  assert.equal(sink.stagedWrites.length, stagedBefore + 1);
  assert.equal(sink.stagedWrites[0].path, 'src/app.ts');
  assert.equal(sink.stagedWrites[0].content, 'const a = 2;\n');
  // diff 已产出
  assert.match(result.diff, /const a = 2/);
  // 凭据：specHash = 暂存 receipts 的确定性 sha256；expiresAt = now + ttl
  const expectedSpecHash = sha(
    JSON.stringify([{ path: 'src/app.ts', hash: sha('const a = 2;\n') }]),
  );
  assert.equal(result.specHash, expectedSpecHash);
  assert.equal(result.credential.specHash, expectedSpecHash);
  assert.equal(result.credential.taskId, 'task-1');
  assert.equal(result.credential.expiresAt, clock.now() + 5_000);
  assert.equal(result.credential.used, false);
});

test('speculate：暂存泄漏进工作区 → StagingLeakError（fail-closed，不发凭据）', () => {
  // 恶意/错误 sink：writeStaged 同时改工作区
  const leaky = new MockStagingSink();
  const originalWrite = leaky.writeStaged.bind(leaky);
  leaky.writeStaged = (path: string, content: string) => {
    leaky.setWorkspace(path, content); // 违反契约
    return originalWrite(path, content);
  };
  const { gate } = makeGate({ sink: leaky });
  leaky.setWorkspace('src/app.ts', 'old');
  assert.throws(
    () => gate.speculate(specReq([{ path: 'src/app.ts', content: 'new' }])),
    StagingLeakError,
  );
});

test('speculate：非 spec 级 action 抛 NotSpecActionError；空写入结构化拒绝', () => {
  const { gate } = makeGate();
  assert.throws(() => gate.speculate({ ...specReq([]), action: 'tf-read', writes: [{ path: 'a', content: 'x' }] }), NotSpecActionError);
  const empty = gate.speculate(specReq([]));
  assert.ok(empty.verdict === 'deny');
  assert.match((empty as { reason: string }).reason, /empty-spec/);
});

// ---------------------------------------------------------------------------
// commit：凭据三种失效路径全部结构化返回
// ---------------------------------------------------------------------------

test('commit：有效凭据放行一次；同一凭据二次使用 → already_used（结构化）', () => {
  const { gate, sink } = makeGate();
  sink.setWorkspace('src/app.ts', 'v1');
  const cred = expectAllow(
    gate.speculate(specReq([{ path: 'src/app.ts', content: 'v2' }])),
  ).credential;

  const first = gate.commit({ action: 'tf-write-commit', taskId: 'task-1', credential: cred });
  assert.ok(first.verdict === 'allow');
  assert.equal((first as { credentialId: string }).credentialId, cred.id);
  assert.equal(cred.used, true);

  const second = gate.commit({ action: 'tf-write-commit', taskId: 'task-1', credential: cred });
  assert.ok(second.verdict === 'deny');
  const rej = (second as { rejection: { reason: string; detail: string } }).rejection;
  assert.equal(rej.reason, 'already_used');
  assert.match(rej.detail, /一次性/);
});

test('commit：spec 后目标内容变化 → hash_mismatch（结构化，含路径）', () => {
  const { gate, sink } = makeGate();
  sink.setWorkspace('src/app.ts', 'v1');
  sink.setWorkspace('src/lib.ts', 'L1');
  const cred = expectAllow(
    gate.speculate(
      specReq([
        { path: 'src/app.ts', content: 'v2' },
        { path: 'src/lib.ts', content: 'L2' },
      ]),
    ),
  ).credential;

  // 另一个工程师在 spec 之后改了工作区
  sink.setWorkspace('src/lib.ts', 'L1-changed-by-others');
  const result = gate.commit({ action: 'tf-write-commit', taskId: 'task-1', credential: cred });
  assert.ok(result.verdict === 'deny');
  const rej = (result as { rejection: { reason: string; detail: string } }).rejection;
  assert.equal(rej.reason, 'hash_mismatch');
  assert.match(rej.detail, /src\/lib\.ts/);
  assert.match(rej.detail, /spec 之后/);
  // hash_mismatch 不消费凭据（未被 used），凭据仍可解释状态
  assert.equal(cred.used, false);
});

test('commit：超时 → expired（结构化，含时间）；used+expired 时 already_used 优先', () => {
  const clock = new FakeClock(1_000);
  const { gate, sink } = makeGate({ clock, ttl: 100 });
  sink.setWorkspace('a.txt', '');
  const cred = expectAllow(
    gate.speculate(specReq([{ path: 'a.txt', content: 'x' }])),
  ).credential;
  assert.equal(cred.expiresAt, 1_100);

  clock.advance(101);
  const result = gate.commit({ action: 'tf-write-commit', taskId: 'task-1', credential: cred });
  assert.ok(result.verdict === 'deny');
  const rej = (result as { rejection: { reason: string; detail: string } }).rejection;
  assert.equal(rej.reason, 'expired');
  assert.match(rej.detail, /过期/);

  // used + expired：already_used 优先于 expired（确定性校验顺序）
  sink.setWorkspace('a.txt', '');
  const cred2 = expectAllow(
    gate.speculate(specReq([{ path: 'a.txt', content: 'y' }])),
  ).credential;
  cred2.used = true; // 直接标记已用（模拟消费后时钟过期）
  const r2 = gate.commit({ action: 'tf-write-commit', taskId: 'task-1', credential: cred2 });
  assert.ok(r2.verdict === 'deny');
  assert.equal((r2 as { rejection: { reason: string } }).rejection.reason, 'already_used');
});

test('commit：未知凭据 → unknown（结构化）', () => {
  const { gate } = makeGate();
  const fake = {
    id: 'task-x#spec#999',
    specHash: sha('nothing'),
    taskId: 'task-x',
    expiresAt: 9_999,
    used: false,
  };
  const result = gate.commit({ action: 'tf-write-commit', taskId: 'task-x', credential: fake });
  assert.ok(result.verdict === 'deny');
  const rej = (result as { rejection: { reason: string; detail: string } }).rejection;
  assert.equal(rej.reason, 'unknown');
  assert.match(rej.detail, /不存在/);
});

test('commit：specHash 内容正确性 —— 相同内容重复 spec 得到相同 specHash', () => {
  const { gate, sink } = makeGate();
  sink.setWorkspace('a.txt', '');
  const s1 = expectAllow(gate.speculate(specReq([{ path: 'a.txt', content: 'same' }])));
  const s2 = expectAllow(gate.speculate(specReq([{ path: 'a.txt', content: 'same' }])));
  assert.equal(s1.specHash, s2.specHash);
  // 两个凭据互相独立，均可各自消费一次
  assert.notEqual(s1.credential.id, s2.credential.id);
  const r1 = gate.commit({ action: 'tf-write-commit', taskId: 'task-1', credential: s1.credential });
  const r2 = gate.commit({ action: 'tf-write-commit', taskId: 'task-1', credential: s2.credential });
  assert.ok(r1.verdict === 'allow');
  assert.ok(r2.verdict === 'allow');
});

// ---------------------------------------------------------------------------
// SystemClock 冒烟（真实时钟路径）
// ---------------------------------------------------------------------------

test('SystemClock：默认时钟可用（冒烟）', () => {
  const clock = new SystemClock();
  const t1 = clock.now();
  assert.ok(Number.isFinite(t1));
  assert.ok(clock.now() >= t1);
});
