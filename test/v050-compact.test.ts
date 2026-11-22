// test/v050-compact.test.ts —— 0.5.0 P3：长上下文治理（计划书 §4.5.2/§5.6/§7.6）
//
// 覆盖（Appendix B："新增"）：
//   K 组（kernel/compaction.ts 纯函数）：确定性摘要（一行一条 / 头尾保留 / 工具行 / 失败行 /
//     write 行数变化 / keepRecent / maxSummaryChars 收敛）；
//   E 组（效果压缩 §5.6(1)）：验证通过且不在最近 N 个内的效果折叠为 [applied pN] 一行；
//   D 组（语义状态摘要 §5.6(2)）：[tf-stream:state] 一行 ~30 token；
//   C 组（driver E2E）：maxInputTokens 触顶 → dropAppendHead + 确定性摘要 + 句柄化 +
//     request:N 取回别名 + [tf-stream:context-rebased] + cache-reset 记账；
//   R 组（回退点）：surfaceCompaction=false / maxInputTokens=0 → 不压缩。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, normalizeStreamShim } from '../src/entry/loop.ts';
import type { DriverPorts, StreamDriverConfig, StreamRequestOptions, ToolBatchInputLike, ToolBatchResultLike } from '../src/entry/loop.ts';
import {
  compactItems,
  renderStateDigest,
  renderEffectLine,
  shouldElideEffect,
  renderUnchangedLine,
  renderSeenStamp,
} from '../src/kernel/compaction.ts';
import { estimatePromptTokens } from '../src/entry/loop.ts';

// ---------------------------------------------------------------------------
// 设施
// ---------------------------------------------------------------------------

function noopExecutor(): (input: ToolBatchInputLike) => Promise<ToolBatchResultLike> {
  return async (input) => ({
    results: input.calls.map((c) => ({ callId: c.id, result: { content: [{ type: 'text', text: `${c.name}:ok` }], isError: false } })),
  });
}

interface Harness {
  driver: SingleStreamDriver;
  wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }>;
  cleanup: () => void;
}

function makeHarness(opts: { task: string; streams: Array<Array<unknown>>; config?: Partial<StreamDriverConfig> }): Harness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v050k-'));
  const wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }> = [];
  const ports: DriverPorts = {
    stream: (options) => {
      const idx = Math.min(wireRequests.length, opts.streams.length - 1);
      wireRequests.push({ ...options, contentTexts: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')) });
      return (async function* () { for (const c of opts.streams[idx]!) yield c as never; })();
    },
    executeTools: noopExecutor(),
    onToolSettled: () => {},
  };
  const config: StreamDriverConfig = { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000, ...opts.config };
  const driver = new SingleStreamDriver(ports, config);
  driver.pushUserTask(opts.task);
  return { driver, wireRequests, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

const stop = { type: 'finish', reason: { kind: 'stop' } };
const blockStart = { type: 'block-start', index: 0, blockType: 'text' };

// ---------------------------------------------------------------------------
// K 组：确定性摘要纯函数
// ---------------------------------------------------------------------------

describe('0.5.0 压缩：kernel/compaction.ts 纯函数', () => {
  it('K1. 确定性：同输入同字节；每条压成一行', () => {
    const items = [
      { role: 'user' as const, content: '第一条消息内容。' },
      { role: 'assistant' as const, content: '第二条回复内容。' },
      { role: 'user' as const, content: '第三条。' },
    ];
    const opts = { keepRecent: 0, maxSummaryChars: 8_000, aggressiveness: 'balanced' as const };
    const a = compactItems(items, opts);
    const b = compactItems(items, opts);
    assert.equal(a.summaryText, b.summaryText, '确定性：同输入同字节');
    assert.ok(a.summaryText.startsWith('[tf-stream:summary]'), '摘要带标记行');
    assert.equal(a.compactedCount, 3);
    assert.ok(!a.summaryText.includes('\n\n'), '每条一行（无空行）');
  });

  it('K2. 超长条目保留头尾（max_item_chars=900）；aggressive 尾保留最少', () => {
    const long = 'x'.repeat(2_000);
    const items = [{ role: 'user' as const, content: long }];
    const balanced = compactItems(items, { keepRecent: 0, maxSummaryChars: 8_000, aggressiveness: 'balanced' });
    assert.ok(balanced.summaryText.includes('省略'), '中段省略说明');
    assert.ok(balanced.summaryText.length < 1_100, `单行 ≤ ~900+标记（实测 ${balanced.summaryText.length}）`);
    const aggressive = compactItems(items, { keepRecent: 0, maxSummaryChars: 8_000, aggressiveness: 'aggressive' });
    const conservative = compactItems(items, { keepRecent: 0, maxSummaryChars: 8_000, aggressiveness: 'conservative' });
    assert.ok(aggressive.summaryText.length <= balanced.summaryText.length, 'aggressive 保留更少');
    assert.ok(conservative.summaryText.length >= balanced.summaryText.length, 'conservative 保留更多');
  });

  it('K3. 工具行保留 tool+参数摘要+状态+字节数；失败保留 stderr 头部', () => {
    const items = [
      { role: 'tool' as const, content: '略', meta: { tool: 'tf-read', target: 'src/app.ts', status: 'ok', bytes: 1234, handle: 'obs:read:c1@v1' } },
      { role: 'tool' as const, content: '略', meta: { tool: 'pwsh', target: 'npm test', status: 'failed', stderrHead: 'Error: 3 tests failed' } },
    ];
    const r = compactItems(items, { keepRecent: 0, maxSummaryChars: 8_000, aggressiveness: 'balanced' });
    assert.ok(r.summaryText.includes('tf-read src/app.ts ok 1234B'), r.summaryText);
    assert.ok(r.summaryText.includes('handle=obs:read:c1@v1'), '句柄进摘要行（压缩后仍可取回，G2）');
    assert.ok(r.summaryText.includes('stderr='), '失败保留 stderr 头部');
    assert.ok(r.summaryText.includes('3 tests failed'), 'stderr 内容可见');
  });

  it('K4. write/edit 只保留 path+行数变化，不保留 diff 全文', () => {
    const items = [
      { role: 'tool' as const, content: '<<<<<< OLD\n...300 行 diff...\n>>>>>> NEW', meta: { tool: 'tf-write', pathDelta: 'src/app.ts +42/−8' } },
    ];
    const r = compactItems(items, { keepRecent: 0, maxSummaryChars: 8_000, aggressiveness: 'balanced' });
    assert.ok(r.summaryText.includes('tf-write src/app.ts +42/−8'), r.summaryText);
    assert.ok(!r.summaryText.includes('OLD'), 'diff 全文不进摘要');
  });

  it('K5. keepRecent：最近 N 条不压；空输入不压缩', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ role: 'user' as const, content: `msg ${i}` }));
    const r = compactItems(items, { keepRecent: 2, maxSummaryChars: 8_000, aggressiveness: 'balanced' });
    assert.equal(r.compactedCount, 3);
    assert.equal(r.kept.length, 2);
    assert.deepEqual(r.kept.map((x) => x.content), ['msg 3', 'msg 4'], '保留的是最近的');
    const tiny = compactItems(items.slice(0, 2), { keepRecent: 2, maxSummaryChars: 8_000, aggressiveness: 'balanced' });
    assert.equal(tiny.compactedCount, 0, '不足 keepRecent+1 不压缩');
    assert.equal(tiny.summaryText, '');
  });

  it('K6. maxSummaryChars 收敛：超限最旧先丢，永不超上限', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ role: 'user' as const, content: `第 ${i} 条消息，长度足够的正文内容填充填充填充。` }));
    const r = compactItems(items, { keepRecent: 0, maxSummaryChars: 1_000, aggressiveness: 'balanced' });
    assert.ok(r.summaryChars <= 1_000, `摘要 ${r.summaryChars} ≤ 1000`);
    assert.ok(r.summaryText.includes('超出摘要上限') || r.compactedCount === 50, '收敛语义：丢行或标注');
  });

  it('K7. 语义状态摘要 + 效果行 + 跨回合工作集（§5.6(2)(3)）', () => {
    const digest = renderStateDigest({ goals: 3, verified: 2, open: [{ id: 'a3', text: '类型检查' }], failed: 0 });
    assert.ok(digest !== null && digest.startsWith('[tf-stream:state]'), digest ?? '');
    assert.ok(digest!.includes('目标 3 项') && digest!.includes('已验证 2') && digest!.includes('a3'), digest!);
    assert.ok(digest!.length < 120, `一行 ~30 token（实测 ${digest!.length} 字符）`);
    assert.equal(renderStateDigest({}), null, '无计划无验证不产生摘要行');

    const effect = renderEffectLine({ effectId: 'p7', action: 'edit', target: 'src/app.ts', version: 3, diffstat: '+42/−8', verify: 'pass', acceptId: 'a1', handle: 'obs:edit:p7@v3' });
    assert.equal(effect, '[applied p7] edit src/app.ts → v3 (+42/−8) · verify a1 pass · handle=obs:edit:p7@v3');

    const codeEffect = renderEffectLine({ effectId: 'p7', action: 'run_code', target: 'run_code', verify: 'pass', calls: [{ tool: 'fs.edit', target: 'src/app.ts', version: 3, status: 'ok' }, { tool: 'pwsh', target: 'test', status: 'pass' }] });
    assert.ok(codeEffect.includes('run_code → 2 calls'), '代码通道折叠单元 = run_code 整次调用');

    assert.equal(shouldElideEffect('pass', 5, 3), true, '不在最近 3 个内 → 折叠');
    assert.equal(shouldElideEffect('pass', 1, 3), false, '最近 3 个内不折叠');
    assert.equal(shouldElideEffect('unverified', 9, 3), false, '未验证不折叠');
    assert.equal(shouldElideEffect('fail', 9, 3), false, '失败不折叠');

    assert.ok(renderUnchangedLine('src/app.ts', { from: 1, to: 120 }, 3, 12).includes('req#12'));
    assert.equal(renderSeenStamp('src/app.ts', 3), '[seen] src/app.ts @v3', '代码通道退化形态');
  });
});

// ---------------------------------------------------------------------------
// C 组：driver E2E（maxInputTokens 触顶压缩）
// ---------------------------------------------------------------------------

/** 带内容回灌的执行器：read 返回预置大内容（逼高上下文体积）。 */
function contentExecutor(files: Record<string, string>): (input: ToolBatchInputLike) => Promise<ToolBatchResultLike> {
  return async (input) => ({
    results: input.calls.map((c) => {
      const args = JSON.parse(c.arguments || '{}') as Record<string, unknown>;
      if (c.name === 'read') {
        const content = files[String(args['file_path'] ?? '')] ?? '(missing)';
        return { callId: c.id, result: { content: [{ type: 'text', text: content }], isError: false } };
      }
      return { callId: c.id, result: { content: [{ type: 'text', text: `${c.name}:ok` }], isError: false } };
    }),
  });
}

interface BigHarness {
  driver: SingleStreamDriver;
  wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }>;
  cleanup: () => void;
}

function makeBigHarness(opts: {
  task: string;
  streams: Array<Array<unknown>>;
  files?: Record<string, string>;
  config?: Partial<StreamDriverConfig>;
}): BigHarness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v050k-'));
  const wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }> = [];
  const ports: DriverPorts = {
    stream: (options) => {
      const idx = Math.min(wireRequests.length, opts.streams.length - 1);
      wireRequests.push({ ...options, contentTexts: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')) });
      return (async function* () { for (const c of opts.streams[idx]!) yield c as never; })();
    },
    executeTools: contentExecutor(opts.files ?? {}),
    onToolSettled: () => {},
  };
  const config: StreamDriverConfig = { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000, maxSteps: 16, ...opts.config };
  const driver = new SingleStreamDriver(ports, config);
  driver.pushUserTask(opts.task);
  return { driver, wireRequests, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

/** 大文件（约 6k 字符/个，读反馈完整回灌 → 追加区快速增长）。 */
function bigFile(name: string): string {
  return Array.from({ length: 120 }, (_, i) => `filler line ${i + 1} of ${name} — padding padding padding padding padding`).join('\n');
}

describe('0.5.0 压缩：driver E2E（maxInputTokens 触顶）', () => {
  it('C1. 触顶 → 旧段折叠为摘要 + 原文句柄化 + context-rebased + cache-reset 记账', async () => {
    const readStream = (id: string) => [
      blockStart,
      { type: 'text-delta', index: 0, text: `继续读取。\n<tf-read path="f-${id}.txt" id="r-${id}"/>\n` },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const finalStream = [
      blockStart,
      { type: 'text-delta', index: 0, text: '<tf-final id="f9" summary="完成：所有分段已核对，答案原文为压缩演练通过。"/>\n' },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const h = makeBigHarness({
      task: '压缩演练：连续读取四个大文件后收尾。',
      streams: [readStream('a'), readStream('b'), readStream('c'), readStream('d'), finalStream],
      files: {
        'f-a.txt': bigFile('a'),
        'f-b.txt': bigFile('b'),
        'f-c.txt': bigFile('c'),
        'f-d.txt': bigFile('d'),
      },
      // maxInputTokens 6k：0.7 触发 = 4200 tokens ≈ 16.8k 字符——两个 6k 文件回灌后即触顶。
      config: { maxInputTokens: 6_000, compactAggressiveness: 'balanced', keepRecent: 2, maxSummaryChars: 4_000, surfaceCompaction: true, spanLedger: true, effectElision: false, stateDigest: false, observeBudgetTokens: 0 },
    });
    try {
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed', JSON.stringify(reason));
      const snap = h.driver.snapshot();
      const cacheResets = snap.records.filter((r) => r.kind === 'cache-reset') as Array<{ cause: string; contextTokens: number; estimatedColdCost: number }>;
      assert.ok(cacheResets.some((r) => r.cause === 'compaction'), 'cache-reset 记账（§8.6）');
      const compaction = cacheResets.find((r) => r.cause === 'compaction')!;
      assert.ok(compaction.contextTokens > 0 && compaction.estimatedColdCost === compaction.contextTokens, 'contextTokens / estimatedColdCost');
      assert.ok(
        snap.records.some((r) => r.kind === 'observation' && r.key.startsWith('compact:')),
        '被丢弃块句柄化（obs 登记，原文可 tf-peek 回取）',
      );
      assert.ok(
        h.wireRequests.some((r) => r.contentTexts.some((t) => t.includes('[tf-stream:summary]'))),
        '确定性摘要注入',
      );
      assert.ok(
        h.wireRequests.some((r) => r.contentTexts.some((t) => t.includes('[tf-stream:context-rebased]'))),
        '换基后模型可见一行（§8.6 实现要求 1）',
      );
    } finally {
      h.cleanup();
    }
  });

  it('C2. 压缩后 handle 可取回（G2）：压缩段按 request:N 别名 tf-peek 回取', async () => {
    const streams: Array<Array<unknown>> = [
      [blockStart, { type: 'text-delta', index: 0, text: '读 A。\n<tf-read path="a.txt" id="ra"/>\n' }, { type: 'finish', reason: { kind: 'stop' } }],
      [blockStart, { type: 'text-delta', index: 0, text: '读 B。\n<tf-read path="b.txt" id="rb"/>\n' }, { type: 'finish', reason: { kind: 'stop' } }],
      [blockStart, { type: 'text-delta', index: 0, text: '读 C。\n<tf-read path="c.txt" id="rc"/>\n' }, { type: 'finish', reason: { kind: 'stop' } }],
      [blockStart, { type: 'text-delta', index: 0, text: '<tf-peek handle="request:1" from_line="1" to_line="3" id="pk"/>\n' }, { type: 'finish', reason: { kind: 'stop' } }],
      [blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="完成：取回成功，答案原文为压缩取回演练通过。"/>\n' }, { type: 'finish', reason: { kind: 'stop' } }],
    ];
    const h = makeBigHarness({
      task: '压缩取回演练：读三个大文件、按 request:1 取回、收尾。',
      streams,
      files: { 'a.txt': bigFile('a'), 'b.txt': bigFile('b'), 'c.txt': bigFile('c') },
      config: { maxInputTokens: 6_000, compactAggressiveness: 'balanced', keepRecent: 2, maxSummaryChars: 4_000, surfaceCompaction: true, observeBudgetTokens: 0 },
    });
    try {
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed', JSON.stringify(reason));
      const snap = h.driver.snapshot();
      assert.ok(
        snap.records.filter((r) => r.kind === 'cache-reset').some((r) => r.kind === 'cache-reset' && r.cause === 'compaction'),
        '压缩发生（前置条件）',
      );
      assert.ok(
        snap.records.some((r) => r.kind === 'command' && r.id === 'pk' && r.status === 'ok'),
        'request:N 句柄别名解析成功（压缩段可取回，G2）',
      );
    } finally {
      h.cleanup();
    }
  });

  it('C3. 回退点：surfaceCompaction=false / maxInputTokens=0 → 永不压缩', async () => {
    const variants = [
      { maxInputTokens: 0, surfaceCompaction: true, maxReadChars: 1, peekIndex: false, readFeedbackLimit: 8000 },
      { maxInputTokens: 6_000, surfaceCompaction: false, peekIndex: false, readFeedbackLimit: 8000 },
    ];
    for (const variant of variants) {
      const h = makeBigHarness({
        task: '回退演练：读两个大文件后收尾。',
        streams: [
          [blockStart, { type: 'text-delta', index: 0, text: '读 A。\n<tf-read path="a.txt" id="ra"/>\n' }, { type: 'finish', reason: { kind: 'stop' } }],
          [blockStart, { type: 'text-delta', index: 0, text: '读 B。\n<tf-read path="b.txt" id="rb"/>\n' }, { type: 'finish', reason: { kind: 'stop' } }],
          [blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="完成：答案原文为回退演练通过。"/>\n' }, { type: 'finish', reason: { kind: 'stop' } }],
        ],
        files: { 'a.txt': bigFile('a'), 'b.txt': bigFile('b') },
        config: { ...variant, keepRecent: 1, observeBudgetTokens: 0 },
      });
      try {
        const reason = await h.driver.runTurn();
        assert.equal(reason.kind, 'completed', JSON.stringify(reason));
        const cacheResets = h.driver.snapshot().records.filter((r) => r.kind === 'cache-reset');
        assert.equal(cacheResets.length, 0, `回退点 ${JSON.stringify(variant)}：不压缩不换基`);
      } finally {
        h.cleanup();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 效果压缩 E2E（§5.6(1)）
// ---------------------------------------------------------------------------

describe('0.5.0 压缩：效果压缩（§5.6(1)）', () => {
  it('E1. 旧效果的重复取回折叠为 [applied pN] 一行；新效果照常回灌原结果', async () => {
    // 剧本：bash 命令 b1（效果 p1）→ bash b2/b3/b4（把 p1 推出 keepRecent=2 窗口）→
    // 幂等重发 b1（duplicate-idempotent → 回灌）→ final。
    // 期望：p1 已在窗口外 → 回灌块折叠为 [applied p1]，不再重发原始输出正文；
    // digest 行携带 effect=pN 标注（追加区只增不改，折叠发生在回灌/压缩两个改写点）。
    const bashStep = (id: string, cmd: string, note: string) => [
      blockStart,
      { type: 'text-delta', index: 0, text: `${note}\n<tf-bash cmd="${cmd}" id="${id}"/>\n` },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const streams: Array<Array<unknown>> = [
      bashStep('b1', 'echo A-original-output', '第一条命令。'),
      bashStep('b2', 'echo B', '第二条。'),
      bashStep('b3', 'echo C', '第三条。'),
      bashStep('b4', 'echo D', '第四条。'),
      // 幂等重发 b1（同 id 同内容）→ duplicate-idempotent → 回灌（p1 已在窗口外 → 折叠）
      [blockStart, { type: 'text-delta', index: 0, text: '再取一次第一条命令的结果。\n<tf-bash cmd="echo A-original-output" id="b1"/>\n' }, { type: 'finish', reason: { kind: 'stop' } }],
      [blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="完成：A 命令结果已确认，答案原文为效果压缩演练通过。"/>\n' }, { type: 'finish', reason: { kind: 'stop' } }],
    ];
    const wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }> = [];
    const driver = new SingleStreamDriver(
      {
        stream: (options) => {
          const idx = Math.min(wireRequests.length, streams.length - 1);
          wireRequests.push({ ...options, contentTexts: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')) });
          return (async function* () { for (const c of streams[idx]!) yield c as never; })();
        },
        executeTools: noopExecutor(),
        onToolSettled: () => {},
      },
      { provider: 'mock', model: 'm', streamIdleTimeoutMs: 30_000, maxSteps: 12, effectElision: true, effectElisionKeepRecent: 2, maxInputTokens: 0, surfaceCompaction: false, observeBudgetTokens: 0 },
    );
    driver.pushUserTask('效果压缩演练：连续四条命令后幂等重发第一条。');
    try {
      const reason = await driver.runTurn();
      assert.equal(reason.kind, 'completed', JSON.stringify(reason));
      assert.ok(
        driver.snapshot().records.filter((r) => r.kind === 'command' && r.status === 'ok' && r.name === 'tf-bash').length >= 5,
        '五条 bash 全部 ok（前置条件：四条 + 幂等重发）',
      );
      assert.ok(
        driver.snapshot().records.some((r) => r.kind === 'observation' && r.reason === 'duplicate-replay-folded'),
        '旧效果回灌走折叠通道（duplicate-replay-folded）',
      );
      const replayBlock = wireRequests.find((r) => r.contentTexts.some((t) => t.includes('[tf-stream:replay') && t.includes('[applied p1]')));
      assert.ok(replayBlock !== undefined, '回灌块 = [applied p1] 效果行（原始输出不重发）');
      assert.ok(
        !replayBlock!.contentTexts.some((t) => t.includes('A-original-output') && t.includes('duplicate-replay') && t.includes('原结果')),
        '原始输出正文不随折叠回灌重发',
      );
    } finally {
      void normalizeStreamShim;
      void estimatePromptTokens;
    }
  });
});
