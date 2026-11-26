// test/v050-prefix.test.ts —— 0.5.0 P4：前缀策略（计划书 §8）
//
// 覆盖（Appendix B："新增"）：
//   J 组（判定表 §8.3）：planned-rebase（正常路径：记账 + 模型可见）/ append-drift
//     （受限换基，预算内放行）/ stable-drift（始终 fail，不受 prefixPolicy 影响）/
//     shrink（越界 fail）；
//   P 组（配置 §8.5）：prefixPolicy='fail' → 绝不换基（§12.4 回退面）；
//   B 组（成本判据 §8.4）：rebaseBudgetRatio——剩余预算不足 → 不自动换基；
//   L 组（限流 §8.5）：maxRebasesPerTurn / maxRebasesPerSession；
//   M 组（模型可见 + 记账 §8.6）：[tf-stream:context-rebased] 注入 + cache-reset 事件。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SingleStreamDriver,
  normalizeStreamShim,
  estimatePromptTokens,
} from '../src/entry/loop.ts';
import type { DriverPorts, StreamDriverConfig, StreamRequestOptions, ToolBatchInputLike, ToolBatchResultLike } from '../src/entry/loop.ts';
import { ContextRenderer, assertRequestPrefix, PrefixBrokenError, contextRebasedLine, renderHash } from '../src/kernel/render.ts';

// ---------------------------------------------------------------------------
// 设施
// ---------------------------------------------------------------------------

function noopExecutor(): (input: ToolBatchInputLike) => Promise<ToolBatchResultLike> {
  return async (input) => ({
    results: input.calls.map((c) => ({ callId: c.id, result: { content: [{ type: 'text', text: `${c.name}:ok` }], isError: false } })),
  });
}

/** 带内容回灌的执行器：read 返回预置内容（逼高上下文体积）。 */
function contentExecutor(files: Record<string, string>): (input: ToolBatchInputLike) => Promise<ToolBatchResultLike> {
  return async (input) => ({
    results: input.calls.map((c) => {
      const args = JSON.parse(c.arguments || '{}') as Record<string, unknown>;
      if (c.name === 'read') {
        return { callId: c.id, result: { content: [{ type: 'text', text: files[String(args['file_path'] ?? '')] ?? '(missing)' }], isError: false } };
      }
      return { callId: c.id, result: { content: [{ type: 'text', text: `${c.name}:ok` }], isError: false } };
    }),
  });
}

interface Harness {
  driver: SingleStreamDriver;
  wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }>;
  cleanup: () => void;
}

function makeHarness(opts: { task: string; streams: Array<Array<unknown>>; files?: Record<string, string>; config?: Partial<StreamDriverConfig> }): Harness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v050p-'));
  const wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }> = [];
  const ports: DriverPorts = {
    stream: (options) => {
      const idx = Math.min(wireRequests.length, opts.streams.length - 1);
      wireRequests.push({ ...options, contentTexts: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')) });
      return (async function* () { for (const c of opts.streams[idx]!) yield c as never; })();
    },
    executeTools: opts.files === undefined ? noopExecutor() : contentExecutor(opts.files),
    onToolSettled: () => {},
  };
  const config: StreamDriverConfig = { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000, maxSteps: 16, ...opts.config };
  const driver = new SingleStreamDriver(ports, config);
  driver.pushUserTask(opts.task);
  return { driver, wireRequests, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

const stop = { type: 'finish', reason: { kind: 'stop' } };
const blockStart = { type: 'block-start', index: 0, blockType: 'text' };

// ---------------------------------------------------------------------------
// 内核面：PrefixBrokenCause 分类 + planned-rebase 通道
// ---------------------------------------------------------------------------

describe('0.5.0 前缀：内核分类与 planned-rebase 通道', () => {
  it('J1. 三类成因判定保持：stable-drift / append-drift / shrink（判定式不变，§8.1）', () => {
    const renderer = new ContextRenderer({ system: 'S', protocol: 'P', toolSchemas: 'T', invariants: 'I' });
    renderer.appendHistory({ role: 'user', content: 'task' });
    renderer.appendHistory({ role: 'assistant', content: 'reply', source: { kind: 'model', provider: 'mock', model: 'm' } });
    const baseline = { promised: renderer.stableMessages(), stableLen: 2 };
    // stable-drift：稳定段（index < stableLen）被改写
    const drifted = [...baseline.promised];
    drifted[1] = { role: 'user', content: 'task（被改写）' };
    assert.throws(() => assertRequestPrefix(baseline, drifted), (error: unknown) => {
      const e = error as PrefixBrokenError;
      return e instanceof PrefixBrokenError && e.prefixCause === 'stable-drift';
    });
    // append-drift：承诺前缀内的转正块（index ≥ stableLen）被改写
    const appendDrifted = [...baseline.promised];
    appendDrifted[2] = { role: 'assistant', content: 'reply（被改写）', source: { kind: 'model', provider: 'mock', model: 'm' } };
    assert.throws(() => assertRequestPrefix(baseline, appendDrifted), (error: unknown) => {
      const e = error as PrefixBrokenError;
      return e instanceof PrefixBrokenError && e.prefixCause === 'append-drift';
    });
    // shrink：承诺前缀收缩
    assert.throws(() => assertRequestPrefix(baseline, baseline.promised.slice(0, 2)), (error: unknown) => {
      const e = error as PrefixBrokenError;
      return e instanceof PrefixBrokenError && e.prefixCause === 'shrink';
    });
  });

  it('J2. planned-rebase：rebase() 是合法换基通道——基线重置 + policyLog（accepted:true）+ 前缀组件可更新', () => {
    const renderer = new ContextRenderer({ system: 'S', protocol: 'OLD-PROTOCOL', toolSchemas: 'T', invariants: 'I' });
    renderer.appendHistory({ role: 'user', content: 'task' });
    const before = renderHash(renderer.stableMessages());
    const record = renderer.rebase({ reason: '通道切换 standard → code', protocol: 'NEW-PROTOCOL', toolSchemas: 'T2', contextTokens: 1234 });
    // policyLog：planned-rebase 记账（绝不静默）
    const policy = renderer.policyLog;
    assert.ok(policy.some((r) => r.kind === 'planned-rebase' && r.accepted === true && r.request.includes('通道切换')));
    assert.ok(record.detail.includes('1234'), 'contextTokens 记账');
    // 前缀组件更新 + 基线重置：render() 不再对旧前缀断言
    const after = renderer.stableMessages();
    assert.ok(after[0]!.content.includes('NEW-PROTOCOL'), '协议段已换');
    assert.ok(after[0]!.content.includes('T2'), '工具面段已换');
    assert.notEqual(renderHash(after), before, '前缀已重建（新时代第一条请求）');
    // 换基后追加历史仍合法（旧基线已作废，不会 stable-drift 误报）
    renderer.appendHistory({ role: 'user', content: 'next-task' });
    assert.doesNotThrow(() => renderer.render());
  });

  it('J3. 模型可见行：[tf-stream:context-rebased] 一行（§8.6 实现要求 1）', () => {
    const line = contextRebasedLine('通道切换 → 代码通道');
    assert.ok(line.startsWith('[tf-stream:context-rebased]'), line);
    assert.ok(line.includes('缓存已重置') && line.includes('行为不变'), line);
  });
});

// ---------------------------------------------------------------------------
// Driver E2E：计划性换基（通道切换）+ prefixPolicy 配置
// ---------------------------------------------------------------------------

describe('0.5.0 前缀：driver E2E', () => {
  it('P1. 通道切换换基后 wire 断言零误报：新时代第一条请求正常发送（0 prefix-broken）', async () => {
    const h = makeHarness({
      task: '换基演练：任务一标准通道收尾。',
      streams: [[blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="任务一完成：答案原文为换基演练通过。"/>' }, stop]],
      config: { codeSource: 'bridge', maxInputTokens: 0, surfaceCompaction: false },
    });
    try {
      const reason1 = await h.driver.runTurn();
      assert.equal(reason1.kind, 'completed');
      assert.equal(h.driver.setChannel('code').ok, true, '排队切到代码通道');
      h.driver.pushUserTask('任务二：代码通道继续。');
      const reason2 = await h.driver.runTurn();
      assert.notEqual(reason2.kind, 'blocked', JSON.stringify(reason2));
      // wire 断言：新时代第一条请求零误报（planned-rebase 不进断言失败路径）
      const faults = h.driver.snapshot().records.filter((r) => r.kind === 'fault');
      assert.ok(!faults.some((r) => r.fault === 'prefix-broken'), '换基后零 prefix-broken（计划性换基是正常路径）');
      assert.ok(
        h.driver.snapshot().records.some((r) => r.kind === 'cache-reset' && r.cause === 'channel-switch'),
        'cache-reset 记账（cause=channel-switch）',
      );
    } finally {
      h.cleanup();
    }
  });

  it('P2. 真实漂移（append-drift）预算内放行一次；prefixPolicy=fail 时绝不放行（§12.4）', async () => {
    // 探针在第 3 请求注入 append-drift：#lastRequest.promised 必须含转正块（第 2 请求的
    // durable 尾块转正后才出现 index ≥ stableLen 的可篡改点）。
    for (const policy of ['auto', 'fail'] as const) {
      const h = makeHarness({
        task: `漂移探针演练（${policy}）。`,
        streams: [
          [blockStart, { type: 'text-delta', index: 0, text: '读 A。\n<tf-read path="a.txt" id="ra"/>\n' }, stop],
          [blockStart, { type: 'text-delta', index: 0, text: '读 B。\n<tf-read path="b.txt" id="rb"/>\n' }, stop],
          [blockStart, { type: 'text-delta', index: 0, text: `<tf-final id="f1" summary="完成：漂移探针演练（${policy}）通过。"/>\n` }, stop],
        ],
        config: {
          faultPrefixDrift: { kind: 'append', oncePerTurn: true },
          prefixPolicy: policy,
          maxInputTokens: 0,
          surfaceCompaction: false,
        },
      });
      try {
        const reason = await h.driver.runTurn();
        const faults = h.driver.snapshot().records.filter((r) => r.kind === 'fault');
        const reset = faults.some((r) => r.fault === 'prefix-reset');
        const broken = faults.some((r) => r.fault === 'prefix-broken');
        if (policy === 'auto') {
          assert.equal(reset, true, 'auto：append-drift 预算内放行一次（prefix-reset）');
          assert.equal(broken, false, 'auto：不 fail-closed');
          assert.equal(reason.kind, 'completed', JSON.stringify(reason));
        } else {
          assert.equal(broken, true, 'fail：append-drift 也 fail-closed（绝不换基，§12.4 回退面）');
          assert.equal(reset, false, 'fail：无放行');
        }
      } finally {
        h.cleanup();
      }
    }
  });

  it('P3. 0.6.1：stable-drift 默认接受继续（auto/rebase）；仅显式 fail 保留 fail-closed', async () => {
    for (const policy of ['auto', 'rebase', 'fail'] as const) {
      const h = makeHarness({
        task: `稳定段漂移演练（${policy}）。`,
        streams: [
          [blockStart, { type: 'text-delta', index: 0, text: '先读。\n<tf-read path="a.txt" id="r1"/>\n' }, stop],
          [blockStart, { type: 'text-delta', index: 0, text: `<tf-final id="f1" summary="完成：稳定段漂移演练（${policy}）通过。"/>\n` }, stop],
        ],
        config: {
          faultPrefixDrift: { kind: 'stable', oncePerTurn: true },
          prefixPolicy: policy,
          maxInputTokens: 0,
          surfaceCompaction: false,
        },
      });
      try {
        const reason = await h.driver.runTurn();
        const faults = h.driver.snapshot().records.filter((r) => r.kind === 'fault');
        if (policy === 'fail') {
          assert.equal(faults.some((r) => r.fault === 'prefix-broken'), true, 'fail：stable-drift 仍 fail-closed（显式回退面）');
          assert.equal(faults.some((r) => r.fault === 'prefix-reset'), false, 'fail：0 放行');
        } else {
          // 0.6.1：接受为缓存重置点——同一份 next 照常发送，对话不中断
          assert.equal(faults.some((r) => r.fault === 'prefix-reset'), true, `${policy}：stable-drift 接受（prefix-reset）`);
          assert.equal(faults.some((r) => r.fault === 'prefix-broken'), false, `${policy}：不 fail-closed`);
          assert.equal(reason.kind, 'completed', `${policy}：任务完成（JSON：${JSON.stringify(reason)}）`);
        }
      } finally {
        h.cleanup();
      }
    }
  });

  it('B1. 0.6.1：rebaseBudgetRatio / §8.4 成本判据随"受限换基"退役——预算不再约束接受', async () => {
    // 旧契约（≤0.6.0）：prefixPolicy='rebase' 时放行还要求 §8.4 成本判据
    //   （剩余预算 > 当前估算 × rebaseBudgetRatio），预算不足 → fail-closed。
    // 0.6.1：接受 = 发送前放行同一份 next（0 额外请求 / 0 重发成本）——不存在"换基成本"，
    // 预算判据失去意义。两个 ratio 值都必须接受继续（回归钉：判据退役后不复活）。
    for (const ratio of [100, 1.5] as const) {
      const h = makeHarness({
        task: `换基判据演练（ratio=${ratio}）。`,
        streams: [
          [blockStart, { type: 'text-delta', index: 0, text: '读 A。\n<tf-read path="a.txt" id="ra"/>\n' }, stop],
          [blockStart, { type: 'text-delta', index: 0, text: '读 B。\n<tf-read path="b.txt" id="rb"/>\n' }, stop],
          [blockStart, { type: 'text-delta', index: 0, text: `<tf-final id="f1" summary="完成：换基判据演练（ratio=${ratio}）通过。"/>\n` }, stop],
        ],
        config: {
          faultPrefixDrift: { kind: 'append', oncePerTurn: true },
          prefixPolicy: 'rebase',
          rebaseBudgetRatio: ratio,
          // 0.5.2：token 估算按 CJK 加权（汉字 ≈0.9 token/字符），前缀估算变大——
          // 6_000 会低于"3×前缀"下限保护，按新口径抬到 30_000。
          maxInputTokens: 30_000,
          surfaceCompaction: false,
          observeBudgetTokens: 0,
        },
      });
      try {
        const reason = await h.driver.runTurn();
        const faults = h.driver.snapshot().records.filter((r) => r.kind === 'fault');
        assert.equal(faults.some((r) => r.fault === 'prefix-reset'), true, `ratio=${ratio}：接受继续（prefix-reset）`);
        assert.equal(faults.some((r) => r.fault === 'prefix-broken'), false, `ratio=${ratio}：预算判据退役，不 fail-closed`);
        assert.equal(reason.kind, 'completed', `ratio=${ratio}：任务完成`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('L1. 换基限流：maxRebasesPerTurn=0 → 压缩被跳过且记 compaction-skipped（不静默）', async () => {
    const bigFile = Array.from({ length: 120 }, (_, i) => `filler ${i + 1} padding padding padding padding`).join('\n');
    const readStream = (id: string) => [blockStart, { type: 'text-delta', index: 0, text: `读。\n<tf-read path="f-${id}.txt" id="r-${id}"/>\n` }, stop];
    const h = makeHarness({
      task: '限流演练：读三个大文件后收尾。',
      streams: [readStream('a'), readStream('b'), readStream('c'),
        [blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="完成：答案原文为限流演练通过。"/>\n' }, stop]],
      files: { 'f-a.txt': bigFile, 'f-b.txt': bigFile, 'f-c.txt': bigFile },
      // 0.5.2：token 估算按 CJK 加权（汉字 ≈0.9 token/字符），前缀估算从 ~560 涨到 ~2015——
      // 6_000 会低于"3×前缀"下限保护，按新口径抬到 8_000（仍能触顶触发压缩判定）。
      config: { maxInputTokens: 8_000, maxRebasesPerTurn: 0, keepRecent: 1, surfaceCompaction: true, observeBudgetTokens: 0 },
    });
    try {
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed', JSON.stringify(reason));
      const faults = h.driver.snapshot().records.filter((r) => r.kind === 'fault');
      assert.ok(faults.some((r) => r.fault === 'compaction-skipped'), '限流跳过必须记账（不静默）');
      assert.equal(
        h.driver.snapshot().records.filter((r) => r.kind === 'cache-reset' && r.cause === 'compaction').length,
        0, '限流生效：本回合 0 次压缩换基',
      );
    } finally {
      h.cleanup();
    }
  });

  it('M1. estimatePromptTokens 口径不变（换基判据的输入）：Σcontent/4 上取整', () => {
    const messages = [
      { role: 'system' as const, content: 'abcd' },       // 4 chars
      { role: 'user' as const, content: 'abcde' },         // 5 chars → 合计 9 → ceil(9/4)=3
    ];
    assert.equal(estimatePromptTokens(messages), 3);
  });
});
