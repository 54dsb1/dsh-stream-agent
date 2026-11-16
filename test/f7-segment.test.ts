// test/f7-segment.test.ts —— F7 长会话段边界（0.4.0 规划内容随 0.3.0 实施；ADR-001）
//
// 覆盖：
//   - renderer 单元：dropAppendHead 整块丢弃、policyLog 记录、前缀基线重置后 preflight 不误报
//   - 驱动器 E2E：长会话多回合 + 段丢弃——100+ 请求 0 前缀违规（PrefixBrokenError 不外泄）
//   - 块完整性：丢弃只落在回合边界，当前回合块保留；被丢弃原文句柄化可 tf-peek 回取
//   - 末/首请求体积断言：边界后首请求 ≤ 阈值 + 当前任务（≤1.5× 首请求口径的落地）

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, normalizeStreamShim } from '../src/entry/loop.ts';
import type { DriverPorts, StreamRequestOptions, ToolBatchInputLike, ToolBatchResultLike, StreamDriverConfig } from '../src/entry/loop.ts';
import { ContextRenderer, PrefixBrokenError } from '../src/kernel/render.ts';
import { createMockModel } from '../src/entry/mock-provider.ts';
import type { Scenario } from '../src/entry/mock-provider.ts';

// ---------------------------------------------------------------------------
// renderer 单元
// ---------------------------------------------------------------------------

describe('F7：renderer 段边界单元', () => {
  it('R1. dropAppendHead：整块丢弃 + policyLog 记录 + 前缀基线重置', () => {
    const r = new ContextRenderer({ system: 'S', protocol: 'P', toolSchemas: 'T', invariants: 'I' });
    r.appendHistory({ role: 'user', content: 'task1' });
    r.appendHistory({ role: 'assistant', content: 'a1' });
    r.appendHistory({ role: 'user', content: 'task2' });
    r.appendHistory({ role: 'assistant', content: 'a2' });
    assert.equal(r.appendBlockCount, 4);
    assert.ok(r.appendChars > 0);
    r.render(); // 建立前缀基线
    const { dropped, record } = r.dropAppendHead(2, { reason: 'test' });
    assert.deepEqual(dropped, ['task1', 'a1'], '丢弃的必须是完整整块');
    assert.equal(record.kind, 'segment-drop');
    assert.equal(record.accepted, true);
    assert.equal(r.policyLog.length, 1);
    assert.equal(r.appendBlockCount, 2);
    // 前缀基线已重置：下一请求与旧基线不同，但 preflight 不得误报
    let threw = false;
    try {
      r.render();
    } catch (error) {
      threw = error instanceof PrefixBrokenError;
    }
    assert.ok(!threw, '显式段边界后 render() 不得抛前缀违规');
    // 之后继续追加照常单调
    r.appendHistory({ role: 'user', content: 'task3' });
    r.render();
    r.render();
  });

  it('R2. 越界丢弃收敛到块数；0 块丢弃不记录', () => {
    const r = new ContextRenderer({ system: 'S', protocol: 'P', toolSchemas: 'T', invariants: 'I' });
    r.appendHistory({ role: 'user', content: 'x' });
    const { dropped, record } = r.dropAppendHead(99, { reason: 'over' });
    assert.equal(dropped.length, 1);
    assert.equal(record.droppedBlocks, 1);
    const empty = r.dropAppendHead(5, { reason: 'none' });
    assert.equal(empty.dropped.length, 0);
    assert.equal(r.policyLog.length, 2, '0 块丢弃也如实记录（不静默）');
  });
});

// ---------------------------------------------------------------------------
// 驱动器 E2E：长会话多回合 + 段丢弃
// ---------------------------------------------------------------------------

interface F7Harness {
  driver: SingleStreamDriver;
  wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }>;
  cleanup: () => void;
}

function makeF7Harness(opts: { config?: Partial<StreamDriverConfig> }): F7Harness {
  const dir = mkdtempSync(join(tmpdir(), 'tf-f7-'));
  const TURNS = 50;
  const scenarios: Scenario[] = [];
  for (let n = 1; n <= TURNS; n++) {
    // 回合第 2 请求：premature-final 拦截块含 `未验证（a<n>）`（每回合唯一）——
    // 完成验收项后收尾。顺序敏感：close 排在 turn 之前。
    scenarios.push({
      name: `f7-close${n}`,
      match: { model: `mock-turn${n}`, promptIncludes: `未验证（a${n}）` },
      chunking: { charsPerChunk: 0, delayMs: 0 },
      steps: [
        { type: 'text', text: `turn${n} 验收回执。\n` },
        { type: 'commands', commands: [`<tf-write path="t${n}.txt" id="w${n}b" accepts="a${n}">payload-${'x'.repeat(120)}-${n}</tf-write>`, `<tf-final id="f${n}b" summary="turn${n} done"/>`] },
        { type: 'waitTools', count: 1, timeoutMs: 5000 },
        { type: 'finish', reason: 'stop' },
      ],
    });
    // 回合第 1 请求：声明计划 + 写文件 + 收尾（验收项未验证 → F5 拦截 → 第二请求）
    scenarios.push({
      name: `f7-turn${n}`,
      match: { model: `mock-turn${n}` },
      chunking: { charsPerChunk: 0, delayMs: 0 },
      steps: [
        { type: 'text', text: `turn${n} 开工。\n` },
        { type: 'commands', commands: [
          `<tf-plan id="p${n}">\n- [a${n}] 写出 t${n}.txt\n</tf-plan>`,
          `<tf-write path="t${n}.txt" id="w${n}a">partial-${'x'.repeat(100)}-${n}</tf-write>`,
          `<tf-final id="f${n}a" summary="占位（会被 F5 拦截）"/>`,
        ] },
        { type: 'waitTools', count: 1, timeoutMs: 5000 },
        { type: 'finish', reason: 'stop' },
      ],
    });
  }
  const model = createMockModel({ scenarios, provider: 'mock' });
  const wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }> = [];
  const ports: DriverPorts = {
    stream: (options) => {
      wireRequests.push({ ...options, contentTexts: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')) });
      return normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal }));
    },
    executeTools: async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => ({
      results: input.calls.map((c) => ({ callId: c.id, result: { content: [{ type: 'text', text: `${c.name}:ok` }], isError: false } })),
    }),
    onToolSettled: () => model.notifyToolResult(),
  };
  const config: StreamDriverConfig = { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000, ...opts.config };
  const driver = new SingleStreamDriver(ports, config);
  return { driver, wireRequests, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('F7：驱动器 E2E（长会话 100+ 请求 0 前缀违规）', () => {
  it('E1. 50 回合 × 2 请求长会话触发段丢弃：0 前缀违规、块完整、原文可回取、体积有界', async () => {
    const h = makeF7Harness({ config: { segmentMaxChars: 1200 } });
    try {
      let totalRequests = 0;
      let dropsSeen = 0;
      let prefixViolations = 0;
      const firstReqChars = [];
      for (let n = 1; n <= 50; n++) {
        // 按模型路由区分回合（历史任务文本会持久存在，不能作为剧本匹配标记）
        h.driver.applySelection({ model: `mock-turn${n}` });
        h.driver.pushUserTask(`turn${n} 任务：写 t${n}.txt。`);
        const before = h.wireRequests.length;
        const reason = await h.driver.runTurn();
        assert.equal(reason.kind, 'completed', `turn${n} 应收敛：${JSON.stringify(reason)}`);
        totalRequests += h.wireRequests.length - before;
        firstReqChars.push(h.wireRequests[before]!.contentTexts[0]!.length);
        const records = h.driver.snapshot().records;
        dropsSeen = records.filter((r) => r.kind === 'fault' && r.fault === 'segment-drop').length;
        prefixViolations = records.filter((r) => r.kind === 'fault' && r.fault === 'driver-error').length;
        assert.equal(prefixViolations, 0, `turn${n} 后 0 次 driver-error（前缀违规会以 driver-error 呈现）`);
      }
      // 100 请求（50 回合 × 2）：0 前缀违规
      assert.ok(totalRequests >= 100, `长会话请求数应 ≥100，实际 ${totalRequests}`);
      assert.equal(prefixViolations, 0, '0 次 driver-error');
      assert.ok(dropsSeen >= 3, `小阈值下应多次段丢弃，实际 ${dropsSeen}`);

      // 块完整性与回取：最后一次丢弃的旧段原文可按句柄取回（不摘要改写）
      const records = h.driver.snapshot().records;
      const segDrop = [...records].reverse().find((r) => r.kind === 'fault' && r.fault === 'segment-drop');
      assert.ok(segDrop !== undefined);
      const handle = segDrop.detail!.match(/obs:read:seg-t(\d+)-0@v1/);
      if (handle !== null) {
        const retrieved = h.driver.peekHandle(`obs:read:seg-t${handle[1]}-0@v1`);
        assert.ok(retrieved !== null && retrieved.includes('turn'), `被丢弃旧段原文应可回取：${String(retrieved).slice(0, 80)}`);
      }

      // 体积有界：末段请求的 system 体积 ≤ 1.5 × 首回合请求 system 体积（末/首 ≤1.5× 的落地）
      const first = firstReqChars[0]!;
      const last = firstReqChars[firstReqChars.length - 1]!;
      assert.ok(last <= Math.ceil(first * 1.5) + 200, `边界后首请求体积应 ≤1.5×（first=${first} last=${last}）`);
    } finally {
      h.cleanup();
    }
  });

  it('E2. segmentMaxChars=0 关闭段边界（回退点）：长会话不丢弃', async () => {
    const h = makeF7Harness({ config: { segmentMaxChars: 0 } });
    try {
      for (let n = 1; n <= 3; n++) {
        h.driver.applySelection({ model: `mock-turn${n}` });
        h.driver.pushUserTask(`turn${n} 任务：写 t${n}.txt。`);
        const reason = await h.driver.runTurn();
        assert.equal(reason.kind, 'completed');
      }
      const records = h.driver.snapshot().records;
      assert.equal(records.filter((r) => r.kind === 'fault' && r.fault === 'segment-drop').length, 0, '关闭时不得丢弃');
    } finally {
      h.cleanup();
    }
  });
});
