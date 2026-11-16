// test/adapters.test.ts —— 分派 07：四个薄适配 entry
//
// 覆盖分派 07 验收：
//   - state-handle：provide ctx.state / BlobSink 接 storage（含 per-record 键约束模拟）/
//     resume 重建句柄目录（file/obs/blob 三族）/ 失配 fail-closed / storage 降级 fail-open
//   - obs-broker：工具结果出口登记（失败→high）/ 三档 none 去重 / 结果原样放行 /
//     llm/stream 泄漏扫描（骨架不误报、全文必报）/ 指标口径 / broker_error fail-open
//   - action-gate：未声明受治理动作 deny 可读（内核原文透传）/ spec 后工作区哈希不变 /
//     凭据一次性三路径（already_used / expired / hash_mismatch）+ unknown /
//     strict 模式透传 / fatal 无通道拒绝 / gate_error fail-open
//   - context-render：O6 preflight 逐会话稳定前缀断言（violation → fail-closed 抛
//     PrefixBrokenError）/ prefix 台账 / preflight_error fail-open / O4 freezeDynamics
//   - 组装 E2E：driver + state-handle + obs-broker + context-render + mock 模型——
//     单文件读任务上下文无全文（泄漏扫描 0 + 逐消息断言）+ tf-peek 第 42 行取回成功

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import applyStateHandle from '../src/entry/state-handle.ts';
import type { StateService, StateSnapshot } from '../src/entry/state-handle.ts';
import applyObsBroker from '../src/entry/obs-broker.ts';
import type { ObsBrokerHandle } from '../src/entry/obs-broker.ts';
import applyActionGate from '../src/entry/action-gate.ts';
import type { ActionGateHandle } from '../src/entry/action-gate.ts';
import applyContextRender from '../src/entry/context-render.ts';
import type { ContextRenderHandle } from '../src/entry/context-render.ts';
import { SingleStreamDriver, normalizeStreamShim } from '../src/entry/loop.ts';
import type { StreamRequestOptions, ToolBatchInputLike, ToolBatchResultLike } from '../src/entry/loop.ts';
import { createMockModel } from '../src/entry/mock-provider.ts';
import type { Scenario, StreamChunk } from '../src/entry/mock-provider.ts';
import { PrefixBrokenError } from '../src/kernel/render.ts';
import { MemoryBlobSink } from '../src/kernel/state.ts';
import type { BlobSink } from '../src/kernel/state.ts';

// ---------------------------------------------------------------------------
// 测试设施：fake Cordis ctx + fake storage + fake tools
// ---------------------------------------------------------------------------

function makeFakeCtx() {
  const services = new Map<string, unknown>();
  const listeners = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const warnings: string[] = [];
  const ctx = {
    get: (name: string): unknown => services.get(name),
    provide: (name: string, value: unknown): unknown => {
      services.set(name, value);
      return () => services.delete(name);
    },
    on: (event: string, listener: (...args: unknown[]) => unknown): unknown => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {
        const i = list.indexOf(listener);
        if (i >= 0) list.splice(i, 1);
      };
    },
    effect: (fn: () => () => void): unknown => {
      fn();
      return undefined;
    },
  };
  services.set('logger', { warn: (m: string) => warnings.push(m) });
  return { ctx, services, listeners, warnings };
}

/** 宿主 per-record 键约束模拟：键不匹配 [a-zA-Z0-9_-]+ 直接拒绝（backend.d.ts:96-98）。 */
class MemKvUnit {
  tables: Record<string, Record<string, unknown>>;
  constructor(tables: string[]) {
    this.tables = Object.fromEntries(tables.map((t) => [t, {}]));
  }
  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    return { tables: structuredClone(this.tables), global: null };
  }
  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    assert.match(key, /^[a-zA-Z0-9_-]+$/, `unsafe kv key: ${key}`);
    this.tables[table]![key] = structuredClone(value);
  }
  async close(): Promise<void> {}
}

function makeStorage(unit: MemKvUnit): { backend: { get(name: string): { kv: { open(): Promise<MemKvUnit> } } } } {
  return { backend: { get: (name: string) => (name === 'json' ? { kv: { open: async () => unit } } : assert.fail(`unknown backend ${name}`)) } };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

interface GuardBox { guard?: (exec: { name: string; arguments?: unknown }) => string | undefined }

function makeTools(body: (name: string, args: Record<string, unknown>) => { content: unknown; isError: boolean }) {
  const listeners: Array<(...args: unknown[]) => unknown> = [];
  const box: GuardBox = {};
  const service = {
    guard: (g: NonNullable<GuardBox['guard']>): (() => void) => {
      box.guard = g;
      return () => {
        box.guard = undefined;
      };
    },
    onPostExecute: (fn: (...args: unknown[]) => unknown): void => {
      listeners.push(fn);
    },
    execute: async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => {
      const results: ToolBatchResultLike['results'] = [];
      for (const call of input.calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments) as Record<string, unknown>;
        } catch {
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: 'bad JSON arguments' }], isError: true } });
          continue;
        }
        let outcome = body(call.name, args);
        // 管线顺序模拟：pre-execute policy（略）→ guards → body → post-execute waterfall
        if (box.guard !== undefined) {
          const denial = box.guard({ name: call.name, arguments: args });
          if (denial !== undefined) outcome = { content: [{ type: 'text', text: denial }], isError: true };
        }
        let decision: { content: unknown; isError: boolean } = outcome;
        for (const fn of listeners) {
          decision = (await fn({ callId: call.id, name: call.name, arguments: args }, decision, () => Promise.resolve(decision))) as typeof decision;
        }
        results.push({ callId: call.id, result: { content: decision.content, isError: decision.isError } });
      }
      return { results, additionalContexts: [], concluded: false };
    },
  };
  return { service, listeners, box };
}

/** state 快照（测试辅助）：file/obs/blob 三族句柄一次布齐。 */
function seedHandles(service: StateService): StateSnapshot {
  service.store.put('file-content-alpha', { kind: 'file', path: 'src/a.ts' });
  service.store.put('obs-content-beta', { kind: 'obs', tool: 'read', callId: 'c9' });
  service.store.put('blob-content-gamma');
  return service.snapshot();
}

// ---------------------------------------------------------------------------
// A. state-handle
// ---------------------------------------------------------------------------

describe('07 state-handle', () => {
  it('A1: provide ctx.state；storage 接驳后 blob 落持久层（键约束内）', async () => {
    const unit = new MemKvUnit(['blobs', 'handles']);
    const { ctx, services } = makeFakeCtx();
    services.set('storage', makeStorage(unit));
    const { service } = applyStateHandle(ctx as never, {});
    await tick();
    assert.equal(service.durable, true);
    const h = service.store.put('persist-me', { kind: 'file', path: 'p.txt' });
    assert.equal(service.store.get(h), 'persist-me');
    await tick();
    const persisted = Object.values(unit.tables['blobs']!);
    assert.equal(persisted.length >= 1, true, 'blob 应写入 storage');
  });

  it('A2: resume 从持久层重建句柄目录（file/obs/blob 三族逐一对上）', async () => {
    const unit = new MemKvUnit(['blobs', 'handles']);
    const first = makeFakeCtx();
    first.services.set('storage', makeStorage(unit));
    const one = applyStateHandle(first.ctx as never, {});
    await tick();
    const snap = seedHandles(one.service);
    await one.service.persist();
    await one.dispose();

    const second = makeFakeCtx();
    second.services.set('storage', makeStorage(unit)); // "重启"：同一持久层，全新内存
    const two = applyStateHandle(second.ctx as never, {});
    await tick();
    assert.equal(two.service.durable, true);
    const report = await two.service.resume();
    assert.equal(report.ok, true, `mismatches: ${report.mismatches.join('; ')}`);
    assert.deepEqual(
      two.service.store.handles().map((h) => `${h.kind}:${h.path}@v${h.version}`),
      snap.handles.map((e) => e.handle),
    );
    // 内容逐字节一致：以重建 store 取回原文
    const restored = two.service.store.handles().map((h) => two.service.store.get(h));
    assert.deepEqual(restored, ['file-content-alpha', 'obs-content-beta', 'blob-content-gamma']);
    await two.dispose();
  });

  it('A3: resume 失配 fail-closed——不切换 store，报告 mismatches', async () => {
    const unit = new MemKvUnit(['blobs', 'handles']);
    const first = makeFakeCtx();
    first.services.set('storage', makeStorage(unit));
    const one = applyStateHandle(first.ctx as never, {});
    await tick();
    seedHandles(one.service);
    await one.service.persist();

    // 篡改快照内容 → 内容寻址重建必然失配
    const tampered = Object.values(unit.tables['handles']!)[0] as { handle: string; contentB64: string };
    tampered.contentB64 = Buffer.from('corrupted').toString('base64');

    const second = makeFakeCtx();
    second.services.set('storage', makeStorage(unit));
    const two = applyStateHandle(second.ctx as never, {});
    await tick();
    const storeBefore = two.service.store;
    const report = await two.service.resume();
    assert.equal(report.ok, false);
    assert.equal(report.mismatches.length >= 1, true);
    assert.equal(two.service.store, storeBefore, '失配时不许切换 store');
  });

  it('A4: storage 不可用 → 本地文件 KvUnit 兜底（durable=true，跨会话 resume 可用；修复限制 3）；localFallback 关闭 → 内存降级', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-state-'));
    try {
      // ① 默认：宿主 storage 缺位 → 本地 JSON 文件 KvUnit（durable），且降级路径告警不静默
      const { ctx, warnings } = makeFakeCtx(); // 无 storage 服务
      const first = applyStateHandle(ctx as never, { stateDir: dir });
      await tick();
      assert.equal(first.service.durable, true, '本地文件兜底后必须 durable');
      const h = first.service.store.put('local-fallback-durable');
      assert.equal(first.service.store.get(h), 'local-fallback-durable');
      assert.equal(warnings.some((w) => w.includes('state-handle')), true, '宿主 storage 缺位必须告警');
      await first.service.persist();
      await first.dispose();
      const handleStr = `${h.kind}:${h.path}@v${h.version}`;

      // ② "重启"：全新内存 + 同一 stateDir → 快照读回、resume 重建（跨会话，无宿主 storage）
      const second = makeFakeCtx();
      const two = applyStateHandle(second.ctx as never, { stateDir: dir });
      await tick();
      assert.equal(two.service.durable, true);
      const report = await two.service.resume();
      assert.equal(report.ok, true, `mismatches: ${report.mismatches.join('; ')}`);
      const restored = two.service.store.handles().map((x) => `${x.kind}:${x.path}@v${x.version}`);
      assert.ok(restored.includes(handleStr), `resume 应重建句柄 ${handleStr}`);
      assert.equal(two.service.store.get(two.service.store.handles().find((x) => `${x.kind}:${x.path}@v${x.version}` === handleStr)!), 'local-fallback-durable');
      await two.dispose();

      // ③ localFallback:false → 维持 v0.1 内存降级行为（durable=false）
      const third = makeFakeCtx();
      const mem = applyStateHandle(third.ctx as never, { stateDir: dir, localFallback: false });
      await tick();
      assert.equal(mem.service.durable, false);
      assert.equal(third.warnings.some((w) => w.includes('state-handle')), true, '内存降级必须告警');
      await mem.service.persist();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A5: announce 路径——装载横幅可输出且 apply 不抛（宿主冒烟曾在此抓到 ReferenceError）', async () => {
    const { ctx, services } = makeFakeCtx();
    services.set('storage', makeStorage(new MemKvUnit(['blobs', 'handles'])));
    const banners: string[] = [];
    const originalError = console.error;
    console.error = (msg: unknown): void => {
      banners.push(String(msg));
    };
    try {
      const { service } = applyStateHandle(ctx as never, { announce: true });
      await tick();
      assert.equal(service.durable, true);
      const obsEnv = makeFakeCtx();
      obsEnv.services.set('state', { sink: service.sink, durable: true });
      applyObsBroker(obsEnv.ctx as never, { announce: true });
      applyContextRender(obsEnv.ctx as never, { announce: true });
      const gateEnv = makeFakeCtx();
      gateEnv.services.set('tools', { guard: () => () => {} });
      gateEnv.services.set('storage', makeStorage(new MemKvUnit(['staged'])));
      applyActionGate(gateEnv.ctx as never, { announce: true });
    } finally {
      console.error = originalError;
    }
    assert.equal(banners.some((b) => b.includes('[state-handle] mounted')), true);
    assert.equal(banners.some((b) => b.includes('[obs-broker] mounted')), true);
    assert.equal(banners.some((b) => b.includes('[action-gate] mounted')), true);
    assert.equal(banners.some((b) => b.includes('[context-render] mounted')), true);
  });
});

// ---------------------------------------------------------------------------
// B. obs-broker
// ---------------------------------------------------------------------------

describe('07 obs-broker', () => {
  function setup(withState = true) {
    const env = makeFakeCtx();
    const sink: BlobSink = withState ? new MemoryBlobSink() : { write: () => {}, read: () => undefined };
    env.services.set('state', { sink, durable: withState });
    const handle = applyObsBroker(env.ctx as never, {}) as ObsBrokerHandle;
    const postExecute = env.listeners.get('tools/post-execute')![0] as (
      exec: { callId: string; name: string; arguments?: unknown },
      result: { isError: boolean; content: unknown },
      next: () => Promise<{ isError: boolean; content: unknown }>,
    ) => Promise<{ isError: boolean; content: unknown }>;
    const onStream = env.listeners.get('llm/stream')![0] as (
      options: { messages?: { content: readonly { type: string; text?: string }[] }[]; sessionId?: string },
      next: () => AsyncIterable<StreamChunk>,
    ) => AsyncIterable<StreamChunk>;
    return { env, handle, postExecute, onStream, sink };
  }

  it('B1: 工具结果出口登记——首次 read 成功 → high；结果原样放行；blob 落盘', async () => {
    const { handle, postExecute } = setup();
    const result = { isError: false, content: [{ type: 'text', text: 'line1\nline2' }] };
    const out = await postExecute({ callId: 'r1', name: 'tf-read', arguments: { file_path: 'a.ts' } }, result, () => Promise.resolve(result));
    assert.equal(out, result, '结果对象必须原样放行（不得改写）');
    const counters = handle.counters();
    assert.equal(counters.produced, 1);
    assert.equal(counters.injected, 1, '首次 high 骨架计入 injected（08 号口径）');
    const audit = handle.faults.records.find((r) => r.kind === 'audit');
    assert.equal((audit?.data['info_gain'] as string), 'high');
    assert.equal((audit?.data['handle'] as string), 'obs:read:r1@v1');
  });

  it('B2: 失败结果 info_gain=high（模型必须看到失败）且原样放行', async () => {
    const { handle, postExecute } = setup();
    const result = { isError: true, content: [{ type: 'text', text: 'EFAIL: boom' }] };
    await postExecute({ callId: 'b1', name: 'tf-bash', arguments: { cmd: 'boom' } }, result, () => Promise.resolve(result));
    const audit = handle.faults.records.find((r) => r.kind === 'audit');
    assert.equal((audit?.data['info_gain'] as string), 'high');
    assert.equal((audit?.data['isError'] as boolean), true);
  });

  it('B3: 同 key 同内容重复观测 → 内核归 none（连目录都不更新）', async () => {
    const { handle, postExecute } = setup();
    const result = { isError: false, content: [{ type: 'text', text: 'same' }] };
    await postExecute({ callId: 'c1', name: 'tf-read', arguments: { file_path: 'same.txt' } }, result, () => Promise.resolve(result));
    await postExecute({ callId: 'c2', name: 'tf-read', arguments: { file_path: 'same.txt' } }, result, () => Promise.resolve(result));
    const audits = handle.faults.records.filter((r) => r.kind === 'audit');
    assert.equal((audits[1]?.data['info_gain'] as string), 'none');
    assert.equal((audits[1]?.data['reason'] as string), 'duplicate-observation');
  });

  it('B4: 泄漏扫描——骨架单行不误报；blob 全文原样出现必报 leak', async () => {
    const { handle, onStream, postExecute } = setup();
    const fullText = ['import os from "node:os"', 'export function alpha() {', '  return 1;', '}', 'export class Beta {}'].join('\n');
    await postExecute({ callId: 'r1', name: 'tf-read', arguments: { file_path: 'a.ts' } }, { isError: false, content: [{ type: 'text', text: fullText }] }, () => Promise.resolve({ isError: false, content: [] }));

    // 请求 1：只含骨架摘要（单行摘录）→ 无泄漏
    const skeletonOnly = { messages: [{ content: [{ type: 'text', text: '[tf-stream:observation handle=obs:read:r1@v1]\n[骨架] 共 5 行\n  L1 [import] import os from "node:os"' }] }], sessionId: 's1' };
    for await (const _ of onStream(skeletonOnly, asyncEmptyStream())) void _;
    assert.equal(handle.faults.count('leak'), 0, '骨架摘录不算泄漏');
    assert.equal(handle.faults.count('metrics'), 1, '逐请求指标落账');

    // 请求 2：全文原样出现 → leak 记录（证据流，不阻断）
    const leaking = { messages: [{ content: [{ type: 'text', text: `[tf-stream:tool-result]\n${fullText}` }] }], sessionId: 's1' };
    for await (const _ of onStream(leaking, asyncEmptyStream())) void _;
    const leak = handle.faults.records.find((r) => r.kind === 'leak');
    assert.notEqual(leak, undefined, '全文出现必须记录 leak');
    assert.equal((leak?.data['handle'] as string), 'obs:read:r1@v1');
  });

  it('B5: fail-open（audit 路径注错）→ 结果照常放行 + broker_error 留痕', async () => {
    const env = makeFakeCtx();
    env.services.set('state', { sink: new MemoryBlobSink(), durable: true });
    const handle = applyObsBroker(env.ctx as never, { faultInjection: 'audit' }) as ObsBrokerHandle;
    const postExecute = env.listeners.get('tools/post-execute')![0] as (exec: unknown, result: { isError: boolean; content: unknown }, next: () => Promise<{ isError: boolean; content: unknown }>) => Promise<{ isError: boolean; content: unknown }>;
    const result = { isError: false, content: [{ type: 'text', text: 'x' }] };
    const out = await postExecute({ callId: 'f1', name: 'tf-read', arguments: {} }, result, () => Promise.resolve(result));
    assert.equal(out, result, 'fail-open：放行不毁结果');
    assert.equal(handle.faults.count('broker_error'), 1);
  });

  it('B6: fail-open（scan 路径注错）→ 请求照常放行 + broker_error 留痕', async () => {
    const env = makeFakeCtx();
    env.services.set('state', { sink: new MemoryBlobSink(), durable: true });
    const handle = applyObsBroker(env.ctx as never, { faultInjection: 'scan' }) as ObsBrokerHandle;
    const onStream = env.listeners.get('llm/stream')![0] as (options: unknown, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>;
    let consumed = false;
    const wrapped = onStream({ messages: [{ content: [{ type: 'text', text: 'hi' }] }] }, () => asyncEmptyStream()());
    for await (const chunk of wrapped) {
      if (chunk.type === 'finish') consumed = true; // next() 的流原样到达消费方
    }
    assert.equal(consumed, true, 'fail-open：流放行');
    assert.equal(handle.faults.count('broker_error'), 1);
  });
});

function asyncEmptyStream(): () => AsyncIterable<StreamChunk> {
  return async function* () {
    yield { type: 'finish', reason: { kind: 'stop' } };
  } as AsyncIterable<StreamChunk>;
}

// ---------------------------------------------------------------------------
// C. action-gate
// ---------------------------------------------------------------------------

describe('07 action-gate', () => {
  it('C1: read 级直接放行；stage-commit 模式下 write 走暂存闭环后放行', async () => {
    const { ctx, services } = makeFakeCtx();
    const { box } = makeTools(() => ({ content: [], isError: false }));
    services.set('tools', { guard: (g: never) => (box.guard = g as never) && (() => {}) });
    const handle = applyActionGate(ctx as never, {}) as ActionGateHandle;
    assert.equal(box.guard?.({ name: 'read', arguments: { file_path: 'x' } }), undefined, 'read 放行');
    assert.equal(box.guard?.({ name: 'write', arguments: { file_path: 'a.txt', content: 'v1' } }), undefined, 'spec 闭环后放行');
    assert.equal(handle.registry.frozen, true);
  });

  it('C2: 未声明 reversibility 的受治理动作 → deny + 内核原文可读理由', async () => {
    const { ctx, services } = makeFakeCtx();
    const { box } = makeTools(() => ({ content: [], isError: false }));
    services.set('tools', { guard: (g: never) => (box.guard = g as never) && (() => {}) });
    applyActionGate(ctx as never, { actions: { write: 'spec', read: 'read', 'tf-write': 'spec', 'tf-read': 'read' } }) as ActionGateHandle;
    const denial = box.guard?.({ name: 'tf-bash', arguments: {} }); // tf-* 前缀受治理但未声明
    assert.match(denial ?? '', /undeclared-reversibility/);
    assert.match(denial ?? '', /未注册的 action：tf-bash/, '内核 UnknownActionError 原文透传');
    assert.equal(box.guard?.({ name: 'grep', arguments: {} }), undefined, '宿主自有工具不表意见');
  });

  it('C3: spec 后工作区哈希不变（暂存落 storage，不触碰工作区）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-gate-'));
    try {
      writeFileSync(join(dir, 'a.txt'), 'original', 'utf8');
      const unit = new MemKvUnit(['staged']);
      const { ctx, services } = makeFakeCtx();
      const { box } = makeTools(() => ({ content: [], isError: false }));
      services.set('tools', { guard: (g: never) => (box.guard = g as never) && (() => {}) });
      services.set('storage', makeStorage(unit));
      const handle = applyActionGate(ctx as never, { workspaceRoot: dir }) as ActionGateHandle;
      await tick();
      assert.equal(box.guard?.({ name: 'write', arguments: { file_path: 'a.txt', content: 'changed' } }), undefined);
      assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'original', '工作区不得被 spec 触碰');
      const staged = Object.values(unit.tables['staged'] ?? {}) as Array<{ path: string; content: string }>;
      assert.deepEqual(staged, [{ path: 'a.txt', content: 'changed' }], '暂存写入落在 storage');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C4: 凭据一次性三路径 + unknown，全部结构化原因', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-gate2-'));
    try {
      const { ctx, services } = makeFakeCtx();
      const { box } = makeTools(() => ({ content: [], isError: false }));
      services.set('tools', { guard: (g: never) => (box.guard = g as never) && (() => {}) });
      const handle = applyActionGate(ctx as never, { workspaceRoot: dir, credentialTtlMs: 60_000 }) as ActionGateHandle;
      // 路径 1 already_used
      const spec = handle.gate.speculate({ action: 'tf-write', taskId: 't1', writes: [{ path: 'x.txt', content: 'v1' }] });
      assert.equal(spec.verdict, 'allow');
      const commit1 = handle.gate.commit({ action: 'tf-write', taskId: 't1', credential: spec.credential });
      assert.equal(commit1.verdict, 'allow');
      const commit2 = handle.gate.commit({ action: 'tf-write', taskId: 't1', credential: spec.credential });
      assert.equal(commit2.verdict, 'deny');
      assert.equal(commit2.verdict === 'deny' && commit2.rejection.reason, 'already_used');
      // 路径 2 expired
      const expiredEnv = makeFakeCtx();
      const { box: box2 } = makeTools(() => ({ content: [], isError: false }));
      expiredEnv.services.set('tools', { guard: (g: never) => (box2.guard = g as never) && (() => {}) });
      const expiredGate = applyActionGate(expiredEnv.ctx as never, { workspaceRoot: dir, credentialTtlMs: 1 }) as ActionGateHandle;
      const spec2 = expiredGate.gate.speculate({ action: 'tf-write', taskId: 't2', writes: [{ path: 'y.txt', content: 'v2' }] });
      await tick();
      const commit3 = expiredGate.gate.commit({ action: 'tf-write', taskId: 't2', credential: spec2.credential });
      assert.equal(commit3.verdict === 'deny' && commit3.rejection.reason, 'expired');
      // 路径 3 hash_mismatch（spec 之后目标内容变化）
      writeFileSync(join(dir, 'z.txt'), 'before', 'utf8');
      const spec3 = handle.gate.speculate({ action: 'tf-write', taskId: 't3', writes: [{ path: 'z.txt', content: 'after' }] });
      writeFileSync(join(dir, 'z.txt'), 'changed-externally', 'utf8');
      const commit4 = handle.gate.commit({ action: 'tf-write', taskId: 't3', credential: spec3.credential });
      assert.equal(commit4.verdict === 'deny' && commit4.rejection.reason, 'hash_mismatch');
      // 路径 4 unknown
      const commit5 = handle.gate.commit({ action: 'tf-write', taskId: 't4', credential: { id: 'no-such-id', specHash: '', taskId: 't4', expiresAt: 0, used: false } });
      assert.equal(commit5.verdict === 'deny' && commit5.rejection.reason, 'unknown');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C5: strict 模式 spec 拒绝透传；C6 fatal 无批准通道拒绝；C7 commit 凭据校验走守卫', async () => {
    const { ctx, services } = makeFakeCtx();
    const { box } = makeTools(() => ({ content: [], isError: false }));
    services.set('tools', { guard: (g: never) => (box.guard = g as never) && (() => {}) });
    const handle = applyActionGate(ctx as never, { mode: 'strict', actions: { write: 'spec', read: 'read', 'tf-write': 'spec', 'tf-apply': 'commit', 'tf-nuke': 'fatal' } }) as ActionGateHandle;
    const strictDenial = box.guard?.({ name: 'write', arguments: { file_path: 'a.txt', content: 'v' } });
    assert.match(strictDenial ?? '', /spec-via-speculate/, '内核 admit 语义透传');
    assert.equal(box.guard?.({ name: 'read', arguments: {} }), undefined);

    const fatalDenial = box.guard?.({ name: 'tf-nuke', arguments: {} });
    assert.match(fatalDenial ?? '', /fatal-no-approval-channel/);

    const commitNoCredential = box.guard?.({ name: 'tf-apply', arguments: {} });
    assert.match(commitNoCredential ?? '', /commit-requires-credential/);
    const spec = handle.gate.speculate({ action: 'tf-write', taskId: 't', writes: [{ path: 'w.txt', content: '1' }] });
    const commitDenial = box.guard?.({ name: 'tf-apply', arguments: { __credential: { id: 'wrong' } } });
    assert.match(commitDenial ?? '', /unknown/, '凭据不存在 → 结构化拒绝');
    void spec;
  });

  it('C8: 守卫自身异常 → fail-open 放行 + gate_error 留痕', () => {
    const { ctx, services } = makeFakeCtx();
    const { box } = makeTools(() => ({ content: [], isError: false }));
    services.set('tools', { guard: (g: never) => (box.guard = g as never) && (() => {}) });
    const handle = applyActionGate(ctx as never, { faultInjection: true }) as ActionGateHandle;
    assert.equal(box.guard?.({ name: 'write', arguments: { file_path: 'a.txt', content: 'v' } }), undefined, 'fail-open 放行');
    assert.equal(handle.faults.count('gate_error'), 1);
  });
});

// ---------------------------------------------------------------------------
// D. context-render
// ---------------------------------------------------------------------------

describe('07 context-render', () => {
  function setup(config: Record<string, unknown> = {}) {
    const env = makeFakeCtx();
    const handle = applyContextRender(env.ctx as never, config) as ContextRenderHandle;
    const onStream = env.listeners.get('llm/stream')![0] as (options: unknown, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>;
    return { env, handle, onStream };
  }
  const request = (system: string, user: string) => ({
    messages: [
      { role: 'system', content: [{ type: 'text', text: system }] },
      { role: 'user', content: [{ type: 'text', text: user }] },
    ],
    sessionId: 'sess-1',
  });

  it('D1: 逐会话稳定前缀断言——同前缀多请求通过，prefix 台账逐请求落账', async () => {
    const { handle, onStream } = setup();
    for (let i = 1; i <= 3; i++) {
      for await (const _ of onStream(request('SYSTEM-V1', `turn ${i}`), asyncEmptyStream())) void _;
    }
    const prefixes = handle.faults.records.filter((r) => r.kind === 'prefix');
    assert.equal(prefixes.length, 3);
    assert.equal(new Set(prefixes.map((r) => r.data['stableHash'])).size, 1, '稳定前缀 hash 逐请求恒定（O4/O6）');
  });

  it('D2: 稳定前缀被改动 → fail-closed 抛 PrefixBrokenError + prefix-broken 记录', async () => {
    const { handle, onStream } = setup();
    for await (const _ of onStream(request('SYSTEM-V1', 'q1'), asyncEmptyStream())) void _;
    assert.throws(
      () => onStream(request('SYSTEM-V2-DRIFT', 'q2'), asyncEmptyStream()).next(),
      PrefixBrokenError,
      '前缀破坏必须拒绝发送（fail-closed）',
    );
    assert.equal(handle.faults.count('prefix-broken'), 1);
  });

  it('D3: 断言器自身异常 → fail-open 放行 + preflight_error 留痕', async () => {
    const { handle, onStream } = setup({ faultInjection: true });
    let finished = false;
    for await (const chunk of onStream(request('S', 'q'), asyncEmptyStream())) {
      if (chunk.type === 'finish') finished = true;
    }
    assert.equal(finished, true, 'fail-open：流放行');
    assert.equal(handle.faults.count('preflight_error'), 1);
  });

  it('D4: freezeDynamics（O4）——动态值撞稳定前缀即抛，正常归位不抛', () => {
    const { handle } = setup();
    assert.throws(() => handle.freezeDynamics({ t: '动态冻结载体' }, 'volatile-tail'), /DynamicInPrefixError|动态字段/);
    handle.freezeDynamics({ now: '2026-11-14T00:00:00Z' }, 'volatile-tail'); // 易变尾：不抛
    handle.freezeDynamics({ dir: '/w' }, 'turn-freeze'); // 回合冻结：不抛
  });
});

// ---------------------------------------------------------------------------
// E. 组装 E2E：driver + 三 entry（验收：上下文无全文 + tf-peek 第 42 行）
// ---------------------------------------------------------------------------

describe('07 composed E2E', () => {
  it('E1: 单文件读任务——上下文无全文（泄漏扫描 0 + 逐消息断言），tf-peek 取回第 42 行', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => (i === 41 ? 'L42-zebra: the answer lives here' : `filler line ${i + 1} padding padding`));
    lines[0] = 'import os from "node:os"';
    const bigTxt = lines.join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'tf-e2e-'));
    try {
      writeFileSync(join(dir, 'big.txt'), bigTxt, 'utf8');
      const fullText = readFileSync(join(dir, 'big.txt'), 'utf8');
      assert.equal(fullText, bigTxt);

      // ---- fake 宿主 ----
      const env = makeFakeCtx();
      const unit = new MemKvUnit(['blobs', 'handles', 'staged']);
      env.services.set('storage', makeStorage(unit));
      const tools = makeTools((name, args) => {
        if (name === 'read') return { content: [{ type: 'text', text: readFileSync(join(dir, String(args['file_path'])), 'utf8') }], isError: false };
        return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
      });
      env.services.set('tools', tools.service);
      const state = applyStateHandle(env.ctx as never, {});
      await tick();
      const broker = applyObsBroker(env.ctx as never, {}) as ObsBrokerHandle;
      applyActionGate(env.ctx as never, { workspaceRoot: dir });
      const render = applyContextRender(env.ctx as never, {}) as ContextRenderHandle;
      tools.listeners.push(...(env.listeners.get('tools/post-execute') ?? []));

      // ---- mock 模型（三请求剧本：读 → peek 42 行 → final；顺序敏感：更具体的 marker 放前）----
      const scenarios: Scenario[] = [
        {
          name: 'e2e-final',
          match: { promptIncludes: 'tf-stream:peek' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '第 42 行拿到了。\n' },
            { type: 'commands', commands: ['<tf-final id="f1" summary="answer: L42-zebra"/>'] },
            { type: 'finish', reason: 'stop' },
          ],
        },
        {
          name: 'e2e-peek',
          match: { promptIncludes: 'tf-stream:observation' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '看骨架，取回第 42 行。\n' },
            { type: 'commands', commands: ['<tf-peek handle="obs:read:r1@v1" from_line="42" to_line="42" id="p1"/>'] },
            { type: 'waitTools', count: 1, timeoutMs: 5000 },
            { type: 'finish', reason: 'stop' },
          ],
        },
        {
          name: 'e2e-read',
          match: { promptIncludes: '句柄演练 07' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '先读 big.txt。\n' },
            { type: 'commands', commands: ['<tf-read path="big.txt" id="r1"/>'] },
            { type: 'waitTools', count: 1, timeoutMs: 5000 },
            { type: 'finish', reason: 'stop' },
          ],
        },
      ];
      const model = createMockModel({ scenarios, provider: 'mock' });

      // ---- llm.stream = broker 外层 → context-render 内层 → mock 的 waterfall 链 ----
      const wireRequests: Array<StreamRequestOptions> = [];
      const mockStream = (options: StreamRequestOptions): AsyncIterable<StreamChunk> =>
        model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal });
      const renderListener = env.listeners.get('llm/stream')!.find((fn) => fn !== (broker as unknown as { onStream?: unknown }).onStream)!;
      void renderListener;
      const [brokerOnStream, renderOnStream] = env.listeners.get('llm/stream')! as Array[
        (options: { messages?: { content: unknown }[]; sessionId?: string }, next: () => AsyncIterable<StreamChunk>) => AsyncIterable<StreamChunk>
      ];
      const llm = {
        stream: (options: StreamRequestOptions): AsyncIterable<StreamChunk> => {
          wireRequests.push(options);
          return brokerOnStream(options, () => renderOnStream(options, () => normalizeStreamShim(mockStream(options))));
        },
      };

      const driver = new SingleStreamDriver(
        {
          stream: (options) => llm.stream(options),
          executeTools: (input) => tools.service.execute(input),
          onToolSettled: () => model.notifyToolResult(),
        },
        { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000 },
      );
      driver.pushUserTask('句柄演练 07：读 big.txt 并取回第 42 行。');
      const reason = await driver.runTurn();
      assert.equal(reason.kind, 'completed');

      // ---- 验收 1：read 反馈（v0.2 完整反馈语义：3.9k 文件 < 8000 上限 → 全文反馈，泄漏照记）----
      assert.ok(broker.faults.count('leak') >= 1, 'read 全文反馈按设计如实记 leak（07 §3.3 口径区分，非缺陷）');
      const allTexts = wireRequests.flatMap((r) => r.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')));
      assert.equal(allTexts.length >= 3, true);
      assert.equal(allTexts.some((t) => t.includes(bigTxt)), true, '第二次请求包含 read 完整原文反馈（≤ 上限）');
      // ---- 验收 2：tf-peek 第 42 行取回成功（peek 结果注入下一请求，final 携带答案）----
      assert.equal(allTexts.some((t) => t.includes('L42-zebra: the answer lives here')), true, '第 42 行原文进入上下文（反馈或 peek）');
      const finalRecord = driver.snapshot().records.find((r) => r.kind === 'final') as { summary?: string } | undefined;
      assert.match(finalRecord?.summary ?? '', /L42-zebra/, '模型（剧本）基于取回内容作答');
      // ---- 指标与 prefix 台账 ----
      const counters = driver.snapshot().counters();
      assert.equal(counters.produced >= 1, true);
      assert.equal(counters.peeked, 2, 'v0.2：完整反馈自动 peek 1 次 + 模型 peek 1 次');
      const prefixes = render.faults.records.filter((r) => r.kind === 'prefix');
      assert.equal(prefixes.length, wireRequests.length, '逐请求 prefix 台账');
      assert.equal(new Set(prefixes.map((r) => r.data['stableHash'])).size, 1, '稳定前缀 hash 全程恒定');
      await state.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
