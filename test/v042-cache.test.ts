// test/v042-cache.test.ts —— v0.4.2 缓存命中 + 计划持久性回归（真机 session-6b61cb4d / e4b9a89c）
//
// 两案同源：注入内容（观测/peek/计划）只在"易变尾"出现一次，下一请求即消失。
// 后果一（失忆循环 → 任务中断）：模型丢上下文后重发同命令、连发 peek 找回、
//   反复 premature-final 被拒（6b61cb4d 第 5-9 步连续 6 次），重入上限硬停。
// 后果二（缓存命中低）：易变尾每请求重建，该区域全是 cache miss——命中率被压到
//   稳定段占比（真机 27.4K tok / 64%）。
// 修复：易变尾"事实类"块转正进追加区（只追加，前缀单调），计划/回执也在转正清单。
//
// 断言全部对着**线格式请求**（wireRequests）与台账 records，不看内部字段。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, normalizeStreamShim } from '../src/entry/loop.ts';
import type {
  DriverPorts,
  StreamChunkLike,
  StreamDriverConfig,
  ToolBatchInputLike,
  ToolBatchResultLike,
} from '../src/entry/loop.ts';

type ChunkGen = AsyncGenerator<StreamChunkLike, void, undefined>;

async function* scriptedStream(chunks: readonly StreamChunkLike[]): ChunkGen {
  for (const chunk of chunks) yield chunk;
}

function textDelta(text: string, index = 1): StreamChunkLike {
  return { type: 'text-delta', index, text } as StreamChunkLike;
}

function finishStop(): StreamChunkLike {
  return { type: 'finish', reason: { kind: 'stop' } } as StreamChunkLike;
}

function usageChunk(fields: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): StreamChunkLike {
  return { type: 'usage', usage: fields } as StreamChunkLike;
}

interface Harness {
  driver: SingleStreamDriver;
  /** 每请求的完整 prompt 文本（拼一段便于 includes 断言） */
  prompts: string[];
  cleanup: () => void;
}

function makeHarness(responses: ReadonlyArray<readonly StreamChunkLike[]>, task: string, config?: Partial<StreamDriverConfig>): Harness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v042-'));
  const prompts: string[] = [];
  let call = 0;
  const ports: DriverPorts = {
    stream: (options) => {
      prompts.push(options.messages.map((m) => (typeof m.content === 'string' ? m.content : (m.content as Array<{ text?: string }>).map((b) => b.text ?? '').join(''))).join('\n'));
      const chunks = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return normalizeStreamShim(scriptedStream(chunks) as never) as AsyncIterable<StreamChunkLike>;
    },
    executeTools: async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => {
      const results = [];
      for (const callItem of input.calls) {
        results.push({ callId: callItem.id, result: { content: [{ type: 'text', text: `ok:${callItem.name}` }], isError: false } });
      }
      return { results };
    },
  };
  const driver = new SingleStreamDriver(ports, {
    provider: 'mock',
    model: 'mock-v042',
    ...config,
  });
  driver.pushUserTask(task);
  return { driver, prompts, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

function promptOf(harness: Harness, index: number): string {
  return harness.prompts[index] ?? '';
}

// ---------------------------------------------------------------- T1 计划持久性

test('V1. 计划块跨请求可见：声明后每个后续请求都带计划（含差分），不再一次蒸发', async () => {
  // 步 1：声明计划 + 占位 final（被拒 → 重入）；步 2：读命令 + 正确 final（收敛）
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [
      textDelta('声明计划。\n'),
      textDelta('<tf-plan id="plan1">\n- [a1] 检查 README 约定\n- [a2] 实现 receipt_tools\n</tf-plan>\n'),
      textDelta('<tf-final id="f1" summary="placeholder"/>\n'),
      finishStop(),
    ],
    [
      textDelta('实现并收尾。\n'),
      textDelta('<tf-read path="README.md" id="r1" accepts="a1"/>\n'),
      textDelta('<tf-write path="receipt_tools/__init__.py" id="w1" accepts="a2">x = 1\n</tf-write>\n'),
      textDelta('<tf-final id="f2" summary="receipt_tools 已实现：__init__.py 导出 x=1，README 约定已核对。"/>\n'),
      finishStop(),
    ],
  ];
  const harness = makeHarness(responses, '完成 receipt 工具包（声明计划再实现）。', { enablePlan: true });
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', `回合应收敛：${JSON.stringify(reason)}`);
    assert.ok(harness.prompts.length >= 2, `至少两个请求，实际 ${harness.prompts.length}`);
    // 请求 2（计划声明后的下一请求）：计划全量块必须可见（旧实现里它已蒸发）
    const second = promptOf(harness, 1);
    assert.ok(second.includes('[tf-stream:plan v1]'), '第 2 请求必须带计划全量块（转正进追加区）');
    assert.ok(second.includes('[a2] 实现 receipt_tools'), '计划原文（验收项文本）必须可见——模型据此知道要验收什么');
    // 请求 2 同时必须带 premature-final 拒绝注入（被拒事由；计划门槛拒绝附带计划快照）
    assert.ok(second.includes('[tf-stream:error'), '第 2 请求必须带 final 拒绝事由');
    // 若有第 3 请求：计划差分（a2 已验证）也必须可见
    if (harness.prompts.length >= 3) {
      const third = promptOf(harness, 2);
      assert.ok(
        third.includes('[tf-stream:plan v1]') || third.includes('[tf-stream:plan-diff'),
        '第 3 请求必须仍能看到计划（全量或差分）',
      );
    }
    // 前缀单调性：每请求的文本必须以"上一请求去掉易变尾后的内容"为前缀。
    // 这里用委托断言：请求 N+1 必须包含请求 N 的稳定段骨架（system + 任务块）。
    for (let i = 1; i < harness.prompts.length; i += 1) {
      const prev = promptOf(harness, i - 1);
      const cur = promptOf(harness, i);
      assert.ok(cur.includes(prev.split('\n')[0] ?? ''), '稳定段头部（system）跨请求不变');
    }
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------- V2 缓存口径

test('V2. usage 缓存字段随流进台账：cacheRead/Write 累计 + 回合台账带命中率', async () => {
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [
      textDelta('读文件。\n'),
      textDelta('<tf-read path="README.md" id="r1"/>\n'),
      usageChunk({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 50 }),
      finishStop(),
    ],
    [
      textDelta('读到了，收尾：README 约定已核对，输出答案原文。\n'),
      textDelta('<tf-final id="f1" summary="答案原文：README 要求实现 receipt_tools 包并跑 grade.py 自检。"/>\n'),
      usageChunk({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 1500, cacheWriteTokens: 60 }),
      finishStop(),
    ],
  ];
  const harness = makeHarness(responses, '读 README 后收尾。');
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', JSON.stringify(reason));
    const records = harness.driver.snapshot().records;
    const usages = records.filter((r) => r.kind === 'usage') as Array<{ kind: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }>;
    assert.equal(usages.length, 2, '两个请求各一条 usage 记录');
    assert.equal(usages[0]!.cacheReadTokens, 900, 'usage 记录必须携带 cacheReadTokens');
    assert.equal(usages[0]!.cacheWriteTokens, 50, 'usage 记录必须携带 cacheWriteTokens');
    // 无缓存字段的适配器（mock 默认）不产生 0 值噪声：字段缺省而非 0
    const bare = makeHarness([
      [textDelta('收尾。\n'), textDelta('<tf-final id="f1" summary="直接交付原文答案。"/>'), usageChunk({ inputTokens: 10, outputTokens: 5 }), finishStop()],
    ], '直接收尾。');
    try {
      await bare.driver.runTurn();
      const bareUsages = bare.driver.snapshot().records.filter((r) => r.kind === 'usage') as Array<Record<string, number>>;
      assert.equal(bareUsages.length, 1);
      assert.equal(bareUsages[0]!['cacheReadTokens'], undefined, '适配器未上报缓存字段时不得写 0 值噪声');
    } finally {
      bare.cleanup();
    }
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------- V3 预算口径

test('V3. 预算口径（0.5.0 D1/D7）：阶梯用任务级差值 + 严格口径——cacheRead 不再加速降级', async () => {
  // D7（旧缺陷的反向修复）：budget=1000；两个请求各带 cacheRead 750——0.4.x 把缓存读按
  // 1:1 计入控制，缓存命中越好越早降级（方向与成本相反）。0.5.0 阶梯只看严格口径
  // （input+output）：100+20 + 100+30 = 250 < 700 → 全程 normal，绝不因缓存读升档。
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [
      textDelta('读文件。\n'),
      textDelta('<tf-read path="a.txt" id="r1"/>\n'),
      usageChunk({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 750 }),
      finishStop(),
    ],
    [
      textDelta('收尾：文件读到了，答案原文如下——A 文件为示例文件，约定已核对。\n'),
      textDelta('<tf-final id="f1" summary="A 文件已核对。"/>\n'),
      usageChunk({ inputTokens: 100, outputTokens: 30, cacheReadTokens: 750 }),
      finishStop(),
    ],
  ];
  const harness = makeHarness(responses, '读一个文件后收尾。', { budgetTokens: 1000 });
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', JSON.stringify(reason));
    const records = harness.driver.snapshot().records;
    const requests = records.filter((r) => r.kind === 'request') as Array<{ kind: string; level: string }>;
    assert.ok(requests.length >= 2, `至少 2 个请求，实际 ${requests.length}`);
    for (const r of requests) {
      assert.equal(r.level, 'normal', 'cacheRead 不计入控制（严格口径）：阶梯保持 normal');
    }
    // 显式未命中输入超阈值时阶梯仍然生效（预算没有失效，只是不再被缓存读污染）：
    // 0.4.x 的 high-only 语义对"真实计费输入"保留。
    const ladder = makeHarness([
      [
        textDelta('读文件。\n'),
        textDelta('<tf-read path="a.txt" id="r1"/>\n'),
        usageChunk({ inputTokens: 800, outputTokens: 20, cacheReadTokens: 5 }),
        finishStop(),
      ],
      [
        textDelta('收尾：A 文件为示例文件，约定已核对。\n'),
        textDelta('<tf-final id="f1" summary="A 文件已核对。"/>\n'),
        usageChunk({ inputTokens: 200, outputTokens: 10 }),
        finishStop(),
      ],
    ], '读一个文件后收尾（阶梯）。', { budgetTokens: 1000 });
    try {
      await ladder.driver.runTurn();
      const ladderRequests = ladder.driver.snapshot().records
        .filter((r) => r.kind === 'request') as Array<{ kind: string; level: string }>;
      // 阶梯按"发送该请求时的任务级花费"取档：请求 2 发送前 = 820（请求 1 的 800+20）
      // ≥ 70% 预算 → high-only；缓存读不参与（D7）。
      assert.equal(ladderRequests[ladderRequests.length - 1]!.level, 'high-only', '严格口径花费 820 ≥ 70% 预算 → high-only');
    } finally {
      ladder.cleanup();
    }
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------- V4 控制页口径

test('V4. cacheStats：控制页口径快照（无缓存数据 hitRatio=null；有数据按计费输入取比）', async () => {
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [
      textDelta('读文件。\n'),
      textDelta('<tf-read path="README.md" id="r1"/>\n'),
      usageChunk({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 }),
      finishStop(),
    ],
    [
      textDelta('收尾：README 约定已核对，答案原文如下。\n'),
      textDelta('<tf-final id="f1" summary="README 要求实现 receipt_tools 包，已核对。"/>\n'),
      usageChunk({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 1100, cacheWriteTokens: 40 }),
      finishStop(),
    ],
  ];
  const harness = makeHarness(responses, '读 README 后收尾。');
  try {
    await harness.driver.runTurn();
    const stats = (harness.driver as unknown as { cacheStats(): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; billedInput: number; cacheHitRatio: number | null } }).cacheStats();
    assert.equal(stats.cacheReadTokens, 2000, '跨请求累计缓存读');
    assert.equal(stats.cacheWriteTokens, 40);
    assert.equal(stats.billedInput, 100 + 50 + 2000 + 40, '计费输入 = 未命中 + 缓存读 + 缓存写');
    assert.equal(stats.cacheHitRatio, Math.round((2000 / 2190) * 100) / 100, '命中率 = 缓存读 / 计费输入');
    // 无缓存数据的驱动器（mock 不上报）：null，不渲染成 0%
    const bare = makeHarness([
      [textDelta('收尾。\n'), textDelta('<tf-final id="f1" summary="直接交付原文答案。"/>'), usageChunk({ inputTokens: 10, outputTokens: 5 }), finishStop()],
    ], '直接收尾。');
    try {
      await bare.driver.runTurn();
      const bareStats = (bare.driver as unknown as { cacheStats(): { cacheHitRatio: number | null } }).cacheStats();
      assert.equal(bareStats.cacheHitRatio, null, '适配器未上报缓存字段时命中率必须是 null（缺数据 ≠ 0%）');
    } finally {
      bare.cleanup();
    }
  } finally {
    harness.cleanup();
  }
});
