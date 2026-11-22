// test/v050-peek.test.ts —— 0.5.0 P5：取回策略（计划书 §7.3/§7.4/§7.5）
//
// 覆盖（Appendix B："新增"）：
//   S 组（kernel/obs.ts span 账本）：recordDelivered / peekWithLedger 三形态
//     （unchanged / partial / content）+ 回退点（spanLedger=false）+ 度量（§7.4）；
//   P 组（peekBudgetChars）：回合取回预算触顶 → [budget] 一行（不允许静默继续）；
//   R 组（readFeedbackLimit 双旋钮 §7.5）：0 = 不截断（0.5.0 默认）；8000 = 0.4.x 形态；
//   M 组（§7.4 指标）：redundant_peek_ratio / k_mean / deref_bytes 口径。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, normalizeStreamShim } from '../src/entry/loop.ts';
import type { DriverPorts, StreamDriverConfig, StreamRequestOptions, ToolBatchInputLike, ToolBatchResultLike } from '../src/entry/loop.ts';
import { ObservationLedger, renderReadIndex } from '../src/kernel/obs.ts';

// ---------------------------------------------------------------------------
// 设施
// ---------------------------------------------------------------------------

function fileExecutor(files: Record<string, string>): (input: ToolBatchInputLike) => Promise<ToolBatchResultLike> {
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
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v050pk-'));
  const wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }> = [];
  const ports: DriverPorts = {
    stream: (options) => {
      const idx = Math.min(wireRequests.length, opts.streams.length - 1);
      wireRequests.push({ ...options, contentTexts: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')) });
      return normalizeStreamShim((async function* () { for (const c of opts.streams[idx]!) yield c as never; })());
    },
    executeTools: fileExecutor(opts.files ?? {}),
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
// S 组：span 账本纯内核面
// ---------------------------------------------------------------------------

describe('0.5.0 取回：span 账本（kernel/obs.ts，D5 修复）', () => {
  it('S1. 命中已投递且未变化 → [unchanged] 一行（不重复投递正文）', () => {
    const obs = new ObservationLedger();
    const result = obs.observe({ tool: 'tf-read', ok: true, key: 'a.txt', content: 'alpha\nbeta\ngamma\ndelta', callId: 'c1' });
    assert.ok(result.handle !== null);
    obs.recordDelivered(result.handle, 1, 4, 10);
    const peek = obs.peekWithLedger(result.handle, 1, 4, 12);
    assert.equal(peek!.kind, 'unchanged');
    assert.ok(peek!.kind === 'unchanged' && peek!.line.includes('req#10'), peek!.kind === 'unchanged' ? peek!.line : '');
    assert.ok(peek!.kind === 'unchanged' && !peek!.line.includes('alpha'), '正文不重发');
  });

  it('S2. 部分重叠 → 只返回新增区间 + 说明；无重叠 → 正文照常', () => {
    const obs = new ObservationLedger();
    const result = obs.observe({ tool: 'tf-read', ok: true, key: 'a.txt', content: 'L1\nL2\nL3\nL4', callId: 'c1' });
    const handle = result.handle!;
    obs.recordDelivered(handle, 1, 2, 10);
    // 部分重叠：L2-4 与已投递 L1-2 相交
    const partial = obs.peekWithLedger(handle, 2, 4, 12);
    assert.equal(partial!.kind, 'partial');
    assert.ok(partial!.kind === 'partial' && partial!.text === 'L3\nL4', partial!.kind === 'partial' ? partial!.text : '');
    assert.ok(partial!.kind === 'partial' && partial!.note.includes('新增'), '说明行');
    // 无重叠
    const fresh = obs.observe({ tool: 'tf-read', ok: true, key: 'b.txt', content: 'X1\nX2', callId: 'c2' });
    const full = obs.peekWithLedger(fresh.handle!, 1, 2, 12);
    assert.equal(full!.kind, 'content');
    assert.ok(full!.kind === 'content' && full!.text === 'X1\nX2');
  });

  it('S3. 内容变化后旧投递失效：hash 变 → 正文照常返回', () => {
    const obs = new ObservationLedger();
    const first = obs.observe({ tool: 'tf-read', ok: true, key: 'a.txt', content: 'v1-L1\nv1-L2', callId: 'c1' });
    obs.recordDelivered(first.handle!, 1, 2, 10);
    // 内容变化 → 新版本新句柄（obs 目录语义）；对新句柄的取回不受旧账影响
    const second = obs.observe({ tool: 'tf-read', ok: true, key: 'a.txt', content: 'v2-L1\nv2-L2', callId: 'c2' });
    assert.notEqual(second.handle, first.handle, '内容变化 = 新版本句柄');
    const peek = obs.peekWithLedger(second.handle!, 1, 2, 12);
    assert.equal(peek!.kind, 'content', '新句柄无投递记录 → 正文');
  });

  it('S4. 回退点：spanLedger=false → 恒 content（行为等价 0.4.0，可重复投递）', () => {
    const obs = new ObservationLedger({ spanLedger: false });
    const result = obs.observe({ tool: 'tf-read', ok: true, key: 'a.txt', content: 'L1\nL2', callId: 'c1' });
    obs.recordDelivered(result.handle!, 1, 2, 10);
    assert.equal(obs.deliveredSpanList(result.handle!).length, 0, '账本关闭：不记账');
    const peek = obs.peekWithLedger(result.handle!, 1, 2, 12);
    assert.equal(peek!.kind, 'content', '回退点：无去重，正文照常');
    assert.ok(peek!.kind === 'content' && peek!.text === 'L1\nL2');
  });

  it('S5. 度量（§7.4）：redundant_peek_ratio / k_mean / deref_bytes 口径', () => {
    const obs = new ObservationLedger();
    const r = obs.observe({ tool: 'tf-read', ok: true, key: 'a.txt', content: 'L1\nL2\nL3', callId: 'c1' });
    obs.recordDelivered(r.handle!, 1, 3, 1);
    obs.peekWithLedger(r.handle!, 1, 3, 2); // unchanged
    obs.peekWithLedger(r.handle!, 1, 3, 3); // unchanged again
    obs.peekWithLedger(r.handle!, 1, 3, 4); // unchanged again
    const m = obs.peekMetrics();
    assert.equal(m.peekRequests, 3);
    assert.equal(m.redundantHits, 3);
    assert.equal(m.redundantPeekRatio, 1, '全部命中（目标 ≥ 0.8）');
    assert.equal(m.kMean, 3, '单 handle 三次取回 → k_mean = 3（真实会话目标 ≤1.2 是分布要求）');
    assert.ok(m.derefBytes === 0, 'unchanged 取回 0 正文字节（去重收益）');
    void renderReadIndex;
  });

  it('S6. request:N 句柄别名（§7.6）：压缩段按请求序号取回', () => {
    const obs = new ObservationLedger();
    const r = obs.observe({ tool: 'tf-read', ok: true, key: 'seg', content: 'seg-1\nseg-2\nseg-3', callId: 'cmp-t1-0' });
    obs.registerRequestHandle(1, r.handle!);
    assert.deepEqual(obs.resolveHandleRef('request:1'), [r.handle]);
    assert.deepEqual(obs.resolveHandleRef('request:99'), [], '未知请求号 → 空列表（不臆造）');
    const content = obs.peek(obs.resolveHandleRef('request:1')[0]!, 1, 2);
    assert.equal(content, 'seg-1\nseg-2');
  });
});

// ---------------------------------------------------------------------------
// P 组：回合取回预算
// ---------------------------------------------------------------------------

describe('0.5.0 取回：peekBudgetChars（§7.3(3)）', () => {
  it('P1. 触顶 → [budget] 一行注入（不允许静默继续）', async () => {
    const big = Array.from({ length: 200 }, (_, i) => `line ${i + 1} content content`).join('\n');
    // 先读小文件（完整投递、预算占用极小），再对**未投递过**的大文件整体取回 → 触预算闸。
    const h = makeHarness({
      task: '取回预算演练：读小文件后整体取回大文件。',
      streams: [
        [blockStart, { type: 'text-delta', index: 0, text: '读小文件。\n<tf-read path="small.txt" id="r0"/>\n' }, stop],
        [blockStart, { type: 'text-delta', index: 0, text: '再读大文件。\n<tf-read path="big.txt" id="r1"/>\n' }, stop],
        [blockStart, { type: 'text-delta', index: 0, text: '<tf-peek handle="obs:read:r1@v1" from_line="1" to_line="200" id="p1"/>\n' }, stop],
        [blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="完成：取回预算演练通过，答案原文为预算提示可见。"/>\n' }, stop],
      ],
      files: { 'small.txt': 'small A\nsmall B\n', 'big.txt': big },
      config: { peekBudgetChars: 500, readFeedbackBudgetPerRequest: 800, maxInputTokens: 0, surfaceCompaction: false, observeBudgetTokens: 0 },
    });
    try {
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed', JSON.stringify(reason));
      // 大文件的读取反馈受 readFeedbackBudgetPerRequest 摊平；此处直接对大文件句柄整体
      // 取回（内容 ~4.8k 字符 > 500 预算）→ [budget] 行。
      const peekRecords = h.driver.snapshot().records.filter((r) => r.kind === 'command' && r.id === 'p1') as Array<{ status: string; detail?: string }>;
      const peekResult = peekRecords[peekRecords.length - 1];
      assert.ok(peekResult !== undefined && peekResult.status === 'ok' && (peekResult.detail ?? '').includes('peek-budget'), JSON.stringify(peekRecords));
      assert.ok(
        h.wireRequests.some((r) => r.contentTexts.some((t) => t.includes('[budget]'))),
        '注入 [budget] 一行（§7.3(3) 文案）',
      );
      assert.ok(
        !h.wireRequests.some((r) => r.contentTexts.some((t) => t.includes('[tf-stream:peek') && t.includes('line 200 content'))),
        '超预算正文不注入（不允许静默继续）',
      );
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// R 组：readFeedbackLimit 双旋钮（§7.5）
// ---------------------------------------------------------------------------

describe('0.5.0 取回：读取/回灌双旋钮（§7.5，D6 修复）', () => {
  it('R1. readFeedbackLimit=0（0.5.0 默认）：中等文件完整回灌，不截断', async () => {
    const medium = Array.from({ length: 100 }, (_, i) => `row ${i + 1}`).join('\n'); // ≈ 800 字符
    const h = makeHarness({
      task: '双旋钮演练（默认）：读中等文件后收尾。',
      streams: [
        [blockStart, { type: 'text-delta', index: 0, text: '读。\n<tf-read path="m.txt" id="r1"/>\n' }, stop],
        [blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="完成：双旋钮演练通过，答案原文为全文可见。"/>\n' }, stop],
      ],
      files: { 'm.txt': medium },
      config: { maxInputTokens: 0, surfaceCompaction: false, observeBudgetTokens: 0 },
    });
    try {
      await h.driver.runTurn();
      assert.ok(
        h.wireRequests[1]!.contentTexts.some((t) => t.includes('row 100')),
        '回灌侧 0 = 不截断：全文可见（读取侧已控住）',
      );
    } finally {
      h.cleanup();
    }
  });

  it('R2. readFeedbackLimit=8000（0.4.x 形态）：超限截断保头尾 + tf-peek 提示（回退点）', async () => {
    const big = Array.from({ length: 900 }, (_, i) => `row ${i + 1} padding padding`).join('\n'); // ≈ 18k 字符
    const h = makeHarness({
      task: '双旋钮演练（0.4.x 形态）：读大文件后收尾。',
      streams: [
        [blockStart, { type: 'text-delta', index: 0, text: '读。\n<tf-read path="b.txt" id="r1"/>\n' }, stop],
        [blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="完成：双旋钮 0.4.x 形态演练通过。"/>\n' }, stop],
      ],
      files: { 'b.txt': big },
      config: { readFeedbackLimit: 8000, maxInputTokens: 0, surfaceCompaction: false, observeBudgetTokens: 0 },
    });
    try {
      await h.driver.runTurn();
      const req2 = h.wireRequests[1]!.contentTexts.join('\n');
      assert.ok(req2.includes('中段省略'), '0.4.x 截断形态：中段省略');
      assert.ok(req2.includes('tf-peek'), '截断提示 tf-peek 精确取回');
    } finally {
      h.cleanup();
    }
  });

  it('R3. maxReadChars（读取侧）：大文件只投行锚索引（D4 修复）；peekIndex=false 回到头部截断', async () => {
    const big = Array.from({ length: 600 }, (_, i) => (i === 200 ? 'export function anchorSymbol() {}' : `filler ${i + 1} padding`)).join('\n');
    // peekIndex=true（默认）+ maxReadChars 32k 默认 → 18k 文件走完整回灌；把 maxReadChars 压到 2k 触发索引化
    const indexed = makeHarness({
      task: '索引化演练：读大文件后收尾。',
      streams: [
        [blockStart, { type: 'text-delta', index: 0, text: '读。\n<tf-read path="b.txt" id="r1"/>\n' }, stop],
        [blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="完成：索引化演练通过。"/>\n' }, stop],
      ],
      files: { 'b.txt': big },
      config: { maxReadChars: 2_000, maxInputTokens: 0, surfaceCompaction: false, observeBudgetTokens: 0 },
    });
    try {
      await indexed.driver.runTurn();
      const req2 = indexed.wireRequests[1]!.contentTexts.join('\n');
      assert.ok(req2.includes('[tf-stream:read]'), '索引头信息（§7.3(1)）');
      assert.ok(req2.includes('anchorSymbol'), '行锚含顶层符号');
      assert.ok(req2.includes('未投递区间'), '未投递区间显式列出');
      assert.ok(!req2.includes('filler 600'), '正文不随索引注入（D4：索引替代头部截断）');
    } finally {
      indexed.cleanup();
    }
    // 回退点：peekIndex=false → 回到 0.4.x 头部截断形态
    const legacy = makeHarness({
      task: '索引关闭演练：读大文件后收尾。',
      streams: [
        [blockStart, { type: 'text-delta', index: 0, text: '读。\n<tf-read path="b.txt" id="r1"/>\n' }, stop],
        [blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="完成：索引关闭演练通过。"/>\n' }, stop],
      ],
      files: { 'b.txt': big },
      config: { peekIndex: false, maxReadChars: 2_000, readFeedbackLimit: 8000, maxInputTokens: 0, surfaceCompaction: false, observeBudgetTokens: 0 },
    });
    try {
      await legacy.driver.runTurn();
      const req2 = legacy.wireRequests[1]!.contentTexts.join('\n');
      assert.ok(!req2.includes('[tf-stream:read]'), '回退点：无索引头');
      assert.ok(req2.includes('filler 1 padding'), '头部截断形态：正文头部可见');
    } finally {
      legacy.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// M 组：度量口径（§7.4）
// ---------------------------------------------------------------------------

describe('0.5.0 取回：指标口径（§7.4）', () => {
  it('M1. E2E：重复取回被账本吸收 → redundant_peek_ratio 达标 + k_mean ≤ 1.2 判定面', async () => {
    const content = 'L1 alpha\nL2 beta\nL3 gamma\nL4 delta\n';
    const h = makeHarness({
      task: '重复取回演练：读文件后重复取回同一区间。',
      streams: [
        [blockStart, { type: 'text-delta', index: 0, text: '读。\n<tf-read path="a.txt" id="r1"/>\n' }, stop],
        // 重复取回已投递区间（D5：命中账本 → [unchanged]，不重发正文）
        [blockStart, { type: 'text-delta', index: 0, text: '<tf-peek handle="obs:read:r1@v1" from_line="1" to_line="4" id="p1"/>\n' }, stop],
        [blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="完成：重复取回演练通过，答案原文为 L2 beta。"/>\n' }, stop],
      ],
      files: { 'a.txt': content },
      config: { maxInputTokens: 0, surfaceCompaction: false, observeBudgetTokens: 0 },
    });
    try {
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed', JSON.stringify(reason));
      const m = h.driver.snapshot().peekMetrics();
      assert.equal(m.peekRequests, 1, '只有模型 tf-peek 计入取回度量（自动完整反馈不计，§7.4 口径）');
      assert.equal(m.redundantHits, 1, '模型 peek 命中账本');
      assert.equal(m.redundantPeekRatio, 1, '模型取回全部命中账本（目标 ≥ 0.8）');
      assert.equal(m.kMean, 1, 'k_mean = 每句柄取回次数均值（模型取回 1 次）');
      assert.ok(
        h.wireRequests[2]!.contentTexts.some((t) => t.includes('[unchanged]')),
        '重复取回注入 [unchanged]（D5）',
      );
    } finally {
      h.cleanup();
    }
  });
});
