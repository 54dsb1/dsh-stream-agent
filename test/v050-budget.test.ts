// test/v050-budget.test.ts —— 0.5.0 P1：预算模型重构（计划书 §4.5）
//
// 覆盖（Appendix B："新增：任务级基数、双旋钮、下限保护"）：
//   B 组（D1 修复）：budgetLevel 基数 = 任务起点快照——同会话第二个任务不再开局即降级；
//   K 组（§4.5.2 双旋钮）：maxSteps 触顶 → 收束期注入"立即 tf-final"（收束而非硬杀）；
//     maxInputTokens 触发压缩（P3 联动，见 v050-compact）；
//   F 组（§4.5.3/R11 下限保护）：任务预算 < 3×前缀估算 → 拒绝启动 + "至少需要 N"提示，零请求；
//   D 组（§4.6 任务级预算指令）：[tf-budget: 8steps/20k] 首行解析并从正文剥离；
//     结构化 source.tfBudget 透传（followup 不再丢 message）；
//   G 组（D7）：budgetTokens 观测——超阈值告警不改行为；cacheRead 不按 1:1 计入。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SingleStreamDriver,
  parseTaskBudgetDirective,
  normalizeStreamShim,
} from '../src/entry/loop.ts';
import type { DriverPorts, StreamDriverConfig, StreamRequestOptions, ToolBatchInputLike, ToolBatchResultLike } from '../src/entry/loop.ts';
import { createMockModel } from '../src/entry/mock-provider.ts';
import type { Scenario } from '../src/entry/mock-provider.ts';
import { checkTaskBudgetFloor, shouldCompact, shouldStopForSteps, observeBudget } from '../src/kernel/governor.ts';

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

function makeHarness(opts: { task: string; scenarios: Scenario[]; config?: Partial<StreamDriverConfig> }): Harness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v050b-'));
  const model = createMockModel({ scenarios: opts.scenarios, provider: 'mock' });
  const wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }> = [];
  const ports: DriverPorts = {
    stream: (options) => {
      wireRequests.push({ ...options, contentTexts: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')) });
      return normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal }));
    },
    executeTools: noopExecutor(),
    onToolSettled: () => model.notifyToolResult(),
  };
  // 0.5.1（1.1）：这些用例覆盖 0.4.x 收束机制（缺 final → nudge → 重入）→ 回退开关
  const config: StreamDriverConfig = { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000, requireFinal: true, ...opts.config };
  const driver = new SingleStreamDriver(ports, config);
  driver.pushUserTask(opts.task);
  return { driver, wireRequests, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

const fast = { charsPerChunk: 0, delayMs: 0 };

// ---------------------------------------------------------------------------
// 纯函数组（kernel/governor.ts）
// ---------------------------------------------------------------------------

describe('0.5.0 预算：governor 纯函数', () => {
  it('G1. shouldCompact：触发率随 aggressiveness 递减；maxInputTokens=0 永不压缩（回退点）', () => {
    const limits = { maxInputTokens: 10_000, maxSteps: 24, aggressiveness: 'balanced' as const };
    assert.equal(shouldCompact(6_000, limits).compact, false);
    assert.equal(shouldCompact(7_500, limits).compact, true, 'balanced 触发率 0.7');
    const aggressive = { ...limits, aggressiveness: 'aggressive' as const };
    assert.equal(shouldCompact(5_500, aggressive).compact, true, 'aggressive 触发率 0.5');
    const conservative = { ...limits, aggressiveness: 'conservative' as const };
    assert.equal(shouldCompact(8_500, conservative).compact, false);
    assert.equal(shouldCompact(9_500, conservative).compact, true, 'conservative 触发率 0.9');
    const off = { ...limits, maxInputTokens: 0 };
    assert.equal(shouldCompact(Number.MAX_SAFE_INTEGER, off).compact, false, 'maxInputTokens=0 = 无上限仅观测（§12.4）');
  });

  it('G2. shouldStopForSteps：触顶返回收束判定（不硬杀）；maxSteps=0 无上限', () => {
    const limits = { maxInputTokens: 0, maxSteps: 24, aggressiveness: 'balanced' as const };
    assert.equal(shouldStopForSteps(23, limits).atLimit, false);
    const atLimit = shouldStopForSteps(24, limits);
    assert.equal(atLimit.atLimit, true);
    assert.ok(atLimit.reason.includes('24'), atLimit.reason);
    const unlimited = { ...limits, maxSteps: 0 };
    assert.equal(shouldStopForSteps(10_000, unlimited).atLimit, false, 'maxSteps=0 = 无上限（§12.4）');
  });

  it('G3. 下限保护（R11）：预算 < 3×前缀估算 → 拒绝 + 最小值提示', () => {
    const bad = checkTaskBudgetFloor(5_000, 12_000);
    assert.equal(bad.ok, false);
    assert.equal(bad.minimumInputTokens, 15_000, '3 × 5000');
    assert.ok(bad.reason.includes('15,000') || bad.reason.includes('15000'), bad.reason);
    const ok = checkTaskBudgetFloor(5_000, 20_000);
    assert.equal(ok.ok, true);
    assert.equal(checkTaskBudgetFloor(5_000, 0).ok, true, 'maxInputTokens=0 无上限不拦截');
  });

  it('G4. observeBudget（D7）：观测项超阈值告警；budget=0/undefined 恒不告警', () => {
    assert.deepEqual(observeBudget(950, 1_000), { warn: true, ratio: 0.95 });
    assert.equal(observeBudget(500, 1_000)!.warn, false);
    assert.equal(observeBudget(10_000_000, undefined), null);
    assert.equal(observeBudget(10_000_000, 0), null);
  });
});

// ---------------------------------------------------------------------------
// 任务级预算指令（§4.6）
// ---------------------------------------------------------------------------

describe('0.5.0 预算：任务级指令', () => {
  it('D1. [tf-budget: 8steps/20k] 首行解析并从正文剥离', () => {
    const parsed = parseTaskBudgetDirective('[tf-budget: 8steps/20k]\n请修复 bug。');
    assert.deepEqual(parsed.budget, { maxSteps: 8, maxInputTokens: 20_000 });
    assert.equal(parsed.text, '请修复 bug。');
    // 无指令：正文一字节不动
    const none = parseTaskBudgetDirective('请修复 bug。');
    assert.equal(none.budget, null);
    assert.equal(none.text, '请修复 bug。');
    // 非指令首行不剥
    const plain = parseTaskBudgetDirective('[说明] 这不是预算指令。\n正文');
    assert.equal(plain.budget, null);
    // 变体写法
    const stepOnly = parseTaskBudgetDirective('[tf-budget: 5steps]\n正文');
    assert.deepEqual(stepOnly.budget, { maxSteps: 5 });
    const tokenOnly = parseTaskBudgetDirective('[tf-budget: 48k]\n正文');
    assert.deepEqual(tokenOnly.budget, { maxInputTokens: 48_000 });
    // 解析不出任何字段 → 原样保留（fail-open，不吞正文）
    const garbage = parseTaskBudgetDirective('[tf-budget: ???]\n正文');
    assert.equal(garbage.budget, null);
    assert.equal(garbage.text, '[tf-budget: ???]\n正文');
  });

  it('D2. 指令生效：任务级 maxSteps 覆盖档位值（任务指令 > 会话默认 > 装配上限）', async () => {
    // maxSteps=3：第 3 步触顶 → 收束期 → 第 4 步 blocked（有产出 → 兜底交付）
    const h = makeHarness({
      task: '[tf-budget: 3steps]\n预算指令演练：连续发读命令。',
      config: { maxSteps: 24 },
      scenarios: [{
        name: 'loop-reads',
        match: { promptIncludes: '预算指令演练' },
        chunking: fast,
        steps: [
          { type: 'text', text: '继续读。\n' },
          { type: 'commands', commands: ['<tf-read path="a.txt" id="r1"/>'] },
          { type: 'waitTools', count: 1, timeoutMs: 5000 },
          { type: 'finish', reason: 'stop' },
        ],
      }],
    });
    try {
      const reason = await h.driver.runTurn();
      // 3 步触顶 → 收束期最多 closeOut 2 次 → blocked（mock 无 final）
      assert.equal(reason.kind, 'blocked', JSON.stringify(reason));
      const faults = h.driver.snapshot().records.filter((r) => r.kind === 'fault');
      assert.ok(faults.some((r) => r.fault === 'closeout-nudge'), '触顶走收束期（注入"立即 tf-final"），不是直接硬杀');
      assert.ok(h.wireRequests.length <= 5, `3 步上限 + 2 次收束 = 最多 5 个请求，实际 ${h.wireRequests.length}`);
    } finally {
      h.cleanup();
    }
  });

  it('D3. 结构化 source.tfBudget 透传（followup 不再丢 message，§4.6）', async () => {
    const h = makeHarness({
      task: '结构化预算演练。',
      config: { maxSteps: 24 },
      scenarios: [{
        name: 'loop-reads2',
        match: { promptIncludes: '结构化预算演练' },
        chunking: fast,
        steps: [
          { type: 'text', text: '继续读。\n' },
          { type: 'commands', commands: ['<tf-read path="a.txt" id="r1"/>'] },
          { type: 'waitTools', count: 1, timeoutMs: 5000 },
          { type: 'finish', reason: 'stop' },
        ],
      }],
    });
    try {
      // 模拟 Agent.followup 透传 message：source.tfBudget = { maxSteps: 2 }
      h.driver.pushUserTask('', { source: { tfBudget: { maxSteps: 2 } } });
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'blocked');
      assert.ok(h.wireRequests.length <= 4, `maxSteps=2 + closeout ≤ 4 请求，实际 ${h.wireRequests.length}`);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// D1：任务级基数
// ---------------------------------------------------------------------------

describe('0.5.0 预算：D1 任务级基数', () => {
  it('B1. 同会话第二个任务不再继承第一个任务的累计花费（旧版 D1 缺陷的回归断言）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-v050b1-'));
    try {
      // 预置"任务一已烧 900 tokens"的真实状态（#usage 是私有字段——通过首个 mock 请求的
      // usage chunk 注入：500+400），然后验证同一驱动器上任务二的差值从 0 起算。
      // 阶梯档位在装配时记录进 request 记录，事后断言。
      const usageByRequest = [800, 50, 50];
      let requestIndex = 0;
      const streams: Array<Array<unknown>> = [
        // 任务一，请求 1：读文件（触发重入）
        [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: '读文件。\n<tf-read path="a.txt" id="r1"/>\n' },
          { type: 'usage', usage: { inputTokens: usageByRequest[0]!, outputTokens: 0 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ],
        // 任务一，请求 2：final 收束
        [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="任务一完成：a.txt 已核对，内容为示例。"/>\n' },
          { type: 'usage', usage: { inputTokens: usageByRequest[1]!, outputTokens: 0 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ],
        // 任务二，请求 3：final 收束
        [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: '<tf-final id="f2" summary="任务二完成：答案原文为预算已重置。"/>\n' },
          { type: 'usage', usage: { inputTokens: usageByRequest[2]!, outputTokens: 0 } },
          { type: 'finish', reason: { kind: 'stop' } },
        ],
      ];
      const driver = new SingleStreamDriver(
        {
          stream: () => {
            const chunks = streams[Math.min(requestIndex++, streams.length - 1)]!;
            return (async function* () { for (const c of chunks) yield c as never; })();
          },
          executeTools: noopExecutor(),
        },
        { provider: 'mock', model: 'm', budgetTokens: 1_000 },
      );
      // 任务一
      driver.pushUserTask('预算演练任务一');
      const reason1 = await driver.runTurn();
      assert.equal(reason1.kind, 'completed', JSON.stringify(reason1));
      let requests = driver.snapshot().records.filter((r) => r.kind === 'request') as Array<{ level: string }>;
      assert.equal(requests.length, 2, '任务一两个请求');
      assert.equal(requests[0]!.level, 'normal');
      // 请求 2 发送前：任务一花费 800 ≥ 70% 预算 → high-only（阶梯按任务差值取档）
      assert.equal(requests[1]!.level, 'high-only', '阶梯仍生效：任务内差值 800 ≥ 700 → high-only');
      // 任务二（D1 核心断言）：同驱动器同会话，新任务差值从 0 起算 → normal
      //（旧实现用会话累计 850 ≥ 900 → 任务二开局即 final-only——正是 D1 缺陷）。
      driver.pushUserTask('任务二：重新开始，预算已重置。');
      const reason2 = await driver.runTurn();
      assert.equal(reason2.kind, 'completed', JSON.stringify(reason2));
      requests = driver.snapshot().records.filter((r) => r.kind === 'request') as Array<{ level: string }>;
      assert.equal(requests[2]!.level, 'normal', '任务二首请求 normal（D1：不再继承任务一累计）');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('B2. cacheRead 不按 1:1 计入阶梯（D7）：缓存命中再大也不升档', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-v050b2-'));
    try {
      const driver = new SingleStreamDriver(
        {
          stream: () => (async function* () {
            yield { type: 'block-start', index: 0, blockType: 'text' } as never;
            yield { type: 'text-delta', index: 0, text: '读文件。\n<tf-read path="a.txt" id="r1"/>\n' } as never;
            yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 9_000 } } as never;
            yield { type: 'finish', reason: { kind: 'stop' } } as never;
          })(),
        },
        { provider: 'mock', model: 'm', budgetTokens: 1_000 },
      );
      driver.pushUserTask('缓存演练');
      await driver.runTurn();
      const requests = driver.snapshot().records.filter((r) => r.kind === 'request') as Array<{ level: string }>;
      assert.equal(requests[requests.length - 1]!.level, 'normal', '严格口径 60 << 700；cacheRead 9000 不计入控制（D7）');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 下限保护 E2E（R11）
// ---------------------------------------------------------------------------

describe('0.5.0 预算：下限保护 E2E', () => {
  it('R1. 预算必然不足的任务：拒绝启动（零请求 + 明确提示），不烧前缀', async () => {
    const h = makeHarness({
      task: '下限保护演练。',
      config: { maxInputTokens: 1_000 },
      scenarios: [{
        name: 'never-reached',
        match: { promptIncludes: '下限保护演练' },
        chunking: fast,
        steps: [{ type: 'finish', reason: 'stop' }],
      }],
    });
    try {
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'blocked', JSON.stringify(reason));
      assert.ok(reason.kind === 'blocked' && reason.detail.includes('下限保护'), reason.kind === 'blocked' ? reason.detail : '');
      assert.ok(reason.kind === 'blocked' && /\d/.test(reason.detail), '提示必须包含"至少需要 N"的具体数字');
      assert.equal(h.wireRequests.length, 0, '零请求——不烧前缀');
      const faults = h.driver.snapshot().records.filter((r) => r.kind === 'fault');
      assert.ok(faults.some((r) => r.fault === 'task-budget-floor'), '台账记录 task-budget-floor');
    } finally {
      h.cleanup();
    }
  });

  it('R2. 放宽的唯一正确路径 = 装配/档位上限抬高（任务指令不能突破装配上限，§4.6）', async () => {
    // 装配 maxInputTokens 抬到 48k → 下限保护通过 → 任务正常启动。
    const h = makeHarness({
      task: '[tf-budget: 12k]\n下限放宽演练。',
      config: { maxInputTokens: 48_000 },
      scenarios: [{
        name: 'finish-fast',
        match: { promptIncludes: '下限放宽演练' },
        chunking: fast,
        steps: [
          { type: 'text', text: '完成。\n' },
          { type: 'commands', commands: ['<tf-final id="f1" summary="完成：答案原文为下限放宽演练通过。"/>'] },
          { type: 'finish', reason: 'stop' },
        ],
      }],
    });
    try {
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed', JSON.stringify(reason));
    } finally {
      h.cleanup();
    }
  });
});
