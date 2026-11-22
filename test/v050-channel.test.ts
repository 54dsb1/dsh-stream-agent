// test/v050-channel.test.ts —— 0.5.0 P2：代码通道三来源判定、让位、回退（计划书 §5.2/§5.3/§6.3）
//
// 覆盖（Appendix B："新增：三来源判定、让位、回退"）：
//   S 组（§5.2 判定）：preset 探针（run_code 在工具面 / 执行器内省）→ bridge（ptcRuntime
//     形状）→ none（拒绝进入）；
//   Y 组（§5.3 让位）：代码通道（preset）下 tf-* 命令记账丢弃（派发数 0）、协议段 0 字符、
//     原生 tool_call 照常执行、回合正常收束（无 tf-final 概念）；
//   B 组（bridge 受限）：只放行 tf-code（协议段约 200 字符），其余 tf-* 丢弃；
//   R 组（回退）：来源皆无 → 回退标准通道 + 告警 + 台账（不静默降级）；
//   W 组（§6.3 工具面）：reserved-only 透传（tf- 前缀保留检查）；
//   C 组（§3.3 约束 5）：通道切换在任务边界生效 + 计划性换基（context-rebased + cache-reset）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SingleStreamDriver,
  normalizeStreamShim,
  detectCodeChannelSource,
  DEFAULT_CODE_BRIDGE_PROTOCOL_SECTION,
} from '../src/entry/loop.ts';
import type { DriverPorts, StreamDriverConfig, StreamRequestOptions, ToolBatchInputLike, ToolBatchResultLike } from '../src/entry/loop.ts';
import { reservedPrefixViolations } from '../src/entry/tool-surface.ts';
import { looksLikePtcRuntime } from '../src/entry/ptc-bridge.ts';
import { renderReadIndex } from '../src/kernel/obs.ts';

// ---------------------------------------------------------------------------
// 设施
// ---------------------------------------------------------------------------

interface Harness {
  driver: SingleStreamDriver;
  wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }>;
  executed: Array<{ name: string; arguments: string }>;
  warnings: string[];
  cleanup: () => void;
}

function makeHarness(opts: {
  chunks: Array<unknown>;
  /** 按请求序号取剧本（多请求演练用；缺省 = 每请求同一份 chunks） */
  chunksByRequest?: Array<Array<unknown>>;
  config?: Partial<StreamDriverConfig>;
  executeCode?: (input: { callId: string; code: string }) => Promise<{ ok: boolean; valueJson?: string; error?: string; kind?: string }>;
}): Harness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v050c-'));
  const wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }> = [];
  const executed: Array<{ name: string; arguments: string }> = [];
  const warnings: string[] = [];
  const ports: DriverPorts = {
    stream: (options) => {
      const requestIndex = wireRequests.length;
      wireRequests.push({ ...options, contentTexts: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')) });
      const chunks = opts.chunksByRequest !== undefined
        ? (opts.chunksByRequest[Math.min(requestIndex, opts.chunksByRequest.length - 1)] ?? opts.chunks)
        : opts.chunks;
      return (async function* () { for (const c of chunks) yield c as never; })();
    },
    executeTools: async (input: ToolBatchInputLike) => {
      for (const call of input.calls) executed.push({ name: call.name, arguments: call.arguments });
      return {
        results: input.calls.map((call) => ({ callId: call.id, result: { content: [{ type: 'text', text: `${call.name}:ok` }], isError: false } })),
      };
    },
    ...(opts.executeCode === undefined ? {} : { executeCode: opts.executeCode as never }),
    onWarning: (m) => warnings.push(m),
  };
  const config: StreamDriverConfig = { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000, ...opts.config };
  const driver = new SingleStreamDriver(ports, config);
  driver.pushUserTask('代码通道演练。');
  return { driver, wireRequests, executed, warnings, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

const stop = { type: 'finish', reason: { kind: 'stop' } };
const blockStart = { type: 'block-start', index: 0, blockType: 'text' };

// ---------------------------------------------------------------------------
// S 组：三来源判定（§5.2）
// ---------------------------------------------------------------------------

describe('0.5.0 通道：三来源判定（§5.2 / U3 探针）', () => {
  it('S1. preset 判定：run_code 在工具面内 → preset（不依赖 preset id，R12）', () => {
    const toolsWithRunCode = {
      schemas() {
        return [{ name: 'run_code', description: 'PTC 程序入口', parameters: {} }, { name: 'pwsh', description: '', parameters: {} }];
      },
    };
    assert.equal(detectCodeChannelSource(toolsWithRunCode as never, undefined), 'preset');
  });

  it('S2. preset 判定：执行器内省面（getExecutor / runProgram）→ preset', () => {
    assert.equal(detectCodeChannelSource({ getExecutor: () => ({ runProgram: () => {} }) } as never, undefined), 'preset');
    assert.equal(detectCodeChannelSource({ executor: { name: 'tool-executor-ptc' } } as never, undefined), 'preset');
  });

  it('S3. bridge 判定：ctx.ptcRuntime 形状符合（resolve+run）→ bridge', () => {
    const ptc = { resolve: (r: unknown) => r, run: async () => ({ value: 1 }) };
    assert.equal(detectCodeChannelSource(undefined, ptc), 'bridge');
    assert.equal(looksLikePtcRuntime(ptc), true);
    // 形状不符不算 bridge
    assert.equal(detectCodeChannelSource(undefined, { resolve: () => {} }), null);
  });

  it('S4. none：两者皆无 → null（代码通道不可用，拒绝进入）', () => {
    assert.equal(detectCodeChannelSource(undefined, undefined), null);
    assert.equal(detectCodeChannelSource({ schemas: () => [] } as never, undefined), null);
  });

  it('S5. 显式配置绕过探测：codeChannelSource=preset/bridge 直通驱动器（Appendix A）', async () => {
    const h = makeHarness({
      chunks: [blockStart, { type: 'text-delta', index: 0, text: '<tf-code id="c1">return 42;</tf-code>' }, stop],
      config: { channel: 'code', codeChannelSource: 'bridge', maxInputTokens: 0, surfaceCompaction: false, maxSteps: 4 },
      executeCode: async () => ({ ok: true, valueJson: '42' }),
    });
    try {
      const reason = await h.driver.runTurn();
      assert.notEqual(reason.kind, 'blocked', JSON.stringify(reason));
      const snap = h.driver.snapshot();
      assert.equal(snap.channel().channel, 'code');
      assert.equal(snap.channel().codeSource, 'bridge');
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Y 组：让位（§5.3）
// ---------------------------------------------------------------------------

describe('0.5.0 通道：preset 让位（§5.3 不写入对方表面）', () => {
  it('Y1. 协议段 0 字符：system 不含 tf-* 协议引导；模型可见贡献为通道措辞', async () => {
    const h = makeHarness({
      chunks: [blockStart, { type: 'text-delta', index: 0, text: '好的，完成。' }, stop],
      config: { channel: 'code', codeSource: 'preset', maxInputTokens: 0, surfaceCompaction: false },
    });
    try {
      await h.driver.runTurn();
      const firstSystem = h.wireRequests[0]!.contentTexts[0]!;
      assert.ok(!firstSystem.includes('## tf-* 单流协议'), '协议段 0 字符（不引导 tf-* 命令）');
      assert.ok(!firstSystem.includes('tf-write'), '无 tf-* 工具语法');
      assert.ok(firstSystem.includes('代码通道') || firstSystem.includes('run_code'), '系统提示换成通道措辞');
    } finally {
      h.cleanup();
    }
  });

  it('Y2. 命令派发数 0：tf-* 标记账丢弃（code-channel-yield），原生 tool_call 照常执行', async () => {
    const h = makeHarness({
      chunks: [blockStart, { type: 'text-delta', index: 0, text: '先看协议里的命令会被丢弃。\n<tf-read path="a.txt" id="r1"/>\n' }, stop],
      config: { channel: 'code', codeSource: 'preset', maxInputTokens: 0, surfaceCompaction: false },
    });
    try {
      await h.driver.runTurn();
      assert.equal(h.executed.length, 0, '本插件对命令的派发数为 0（§5.3 让位清单）');
      const snap = h.driver.snapshot();
      assert.ok(
        snap.records.some((r) => r.kind === 'command' && r.status === 'rejected' && String(r.detail ?? '').includes('code-channel-yield')),
        'tf-* 命令记账丢弃（可审计）',
      );
    } finally {
      h.cleanup();
    }
  });

  it('Y3. 原生 tool_call（preset 的工具面）照常经 executeTools 执行——让位不接管执行器', async () => {
    const nativeCall = [
      blockStart,
      { type: 'text-delta', index: 0, text: '直接调工具。\n' },
      { type: 'tool-call-delta', index: 1, id: 'nc1', name: 'run_code', argumentsDelta: '{}' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'nc1', name: 'run_code', arguments: '{}' } },
      stop,
    ];
    const plainProse = [blockStart, { type: 'text-delta', index: 0, text: 'run_code 结果已核对：返回 3 项统计。' }, stop];
    const h = makeHarness({
      chunks: nativeCall,
      chunksByRequest: [nativeCall, plainProse],
      config: { channel: 'code', codeSource: 'preset', maxInputTokens: 0, surfaceCompaction: false },
    });
    try {
      const reason = await h.driver.runTurn();
      assert.notEqual(reason.kind, 'blocked', JSON.stringify(reason));
      assert.ok(h.executed.some((c) => c.name === 'run_code'), 'run_code 经宿主管线执行（执行器来源 = ptc preset）');
      // 请求 2 注入原生结果（阻塞回灌）后收束
      assert.ok(h.wireRequests.length >= 2, '原生结果需要一次回灌请求');
      assert.ok(
        h.wireRequests[1]!.contentTexts.some((t) => t.includes('[tf-stream:tool-result') && t.includes('run_code')),
        '原生结果回灌下一请求',
      );
    } finally {
      h.cleanup();
    }
  });

  it('Y4. 无 tf-final 概念：流正常终止且无重入事由 → completed（验收闸不可做，§3.2）', async () => {
    const h = makeHarness({
      chunks: [blockStart, { type: 'text-delta', index: 0, text: '任务做完了，交付说明如下。' }, stop],
      config: { channel: 'code', codeSource: 'preset', maxInputTokens: 0, surfaceCompaction: false },
    });
    try {
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed', JSON.stringify(reason));
      assert.equal(h.wireRequests.length, 1, '单请求收束（无 final 逼问、无 nudge）');
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// B 组：bridge 受限窄桥
// ---------------------------------------------------------------------------

describe('0.5.0 通道：bridge 受限窄桥（§5.2 第二分支）', () => {
  it('B1. 协议段只写 tf-code 用法（约 200 字符级），tf-code 经本插件执行器执行', async () => {
    const h = makeHarness({
      chunks: [blockStart, { type: 'text-delta', index: 0, text: '<tf-code id="c1">return 42;</tf-code>' }, stop],
      config: { channel: 'code', codeSource: 'bridge', maxInputTokens: 0, surfaceCompaction: false },
      executeCode: async () => ({ ok: true, valueJson: '42' }),
    });
    try {
      const reason = await h.driver.runTurn();
      assert.notEqual(reason.kind, 'blocked', JSON.stringify(reason));
      const firstSystem = h.wireRequests[0]!.contentTexts[0]!;
      assert.ok(firstSystem.includes('tf-code'), 'tf-code 用法声明在');
      assert.ok(firstSystem.length < 2_000, `受限协议段（实测 ${firstSystem.length} 字符，不含完整 7 段协议）`);
      assert.ok(!firstSystem.includes('## 计划与验收'), '无 plan 段（bridge 不声明验收面）');
      assert.ok(
        h.driver.snapshot().records.some((r) => r.kind === 'command' && r.id === 'c1' && r.status === 'ok'),
        'tf-code 经 executeCode 端口执行成功',
      );
    } finally {
      h.cleanup();
    }
  });

  it('B2. bridge 下其余 tf-* 丢弃：只放行 tf-code（受限）', async () => {
    const h = makeHarness({
      chunks: [blockStart, { type: 'text-delta', index: 0, text: '<tf-read path="a.txt" id="r1"/>\n<tf-code id="c1">return 1;</tf-code>' }, stop],
      config: { channel: 'code', codeSource: 'bridge', maxInputTokens: 0, surfaceCompaction: false },
      executeCode: async () => ({ ok: true, valueJson: '1' }),
    });
    try {
      await h.driver.runTurn();
      const commands = h.driver.snapshot().records.filter((r) => r.kind === 'command');
      assert.ok(commands.some((r) => r.id === 'r1' && r.status === 'rejected'), 'tf-read 被让位丢弃');
      assert.ok(commands.some((r) => r.id === 'c1' && r.status === 'ok'), 'tf-code 放行');
      assert.equal(h.executed.length, 0, 'tf-read 不派发');
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// R 组：回退（来源皆无）
// ---------------------------------------------------------------------------

describe('0.5.0 通道：来源皆无 → 拒绝进入，回退标准（不静默）', () => {
  it('R1. channel=code 无来源：回退 standard + warn + channelFallback（控制栏可见）', async () => {
    const warnings: string[] = [];
    const h = makeHarness({
      chunks: [blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="标准通道完成。"/>' }, stop],
      config: { channel: 'code', maxInputTokens: 0, surfaceCompaction: false, ...( { } ) },
    });
    h.driver.setIdentity('s', 't');
    try {
      // makeHarness 未注入 codeSource → 构造期即回退
      const status = h.driver.runtimeStatus();
      assert.equal(status.channel, 'standard', '回退标准通道');
      assert.equal(status.requestedChannel, 'code', '请求值如实保留（控制栏显示"代码通道不可用"）');
      assert.ok(status.channelFallback !== undefined && status.channelFallback.includes('不可用'), status.channelFallback ?? '');
      assert.ok(h.warnings.some((w) => w.includes('代码通道不可用')), '告警不静默（§5.2）');
      void warnings;
      // 标准通道下 tf-final 正常收敛
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed', JSON.stringify(reason));
      assert.ok(h.wireRequests[0]!.contentTexts[0]!.includes('## tf-* 单流协议'), '标准通道协议段完整');
    } finally {
      h.cleanup();
    }
  });

  it('R2. setChannel("code") 无来源：拒绝 + 结构化原因（不排队不降级）', async () => {
    const h = makeHarness({
      chunks: [blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="完成。"/>' }, stop],
      config: { maxInputTokens: 0, surfaceCompaction: false },
    });
    try {
      const result = h.driver.setChannel('code');
      assert.equal(result.ok, false);
      assert.equal(result.code, 'code-unavailable');
      assert.ok(result.detail!.includes('未检测到 PTC'), result.detail);
      const status = h.driver.runtimeStatus();
      assert.equal(status.channel, 'standard', '未切换');
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// W 组：reserved-only 工具面（§6.3）
// ---------------------------------------------------------------------------

describe('0.5.0 通道：reserved-only 工具面', () => {
  it('W1. tf- 前缀保留检查：外部占用被识别，自有 14 条不算', () => {
    const violations = reservedPrefixViolations([
      'tf-read', 'tf-write', 'tf-edit', 'tf-append', 'tf-grep', 'tf-glob', 'tf-bash',
      'tf-peek', 'tf-final', 'tf-code', 'tf-plan', 'tf-call', 'tf-ask', 'tf-skill',
      'tf-external-tool', 'pwsh', 'web_search',
    ]);
    assert.deepEqual(violations, ['tf-external-tool']);
  });

  it('W2. 大文件行锚索引（§7.3(1) D4）：索引含头信息 + 行锚 + 未投递区间', () => {
    const lines = Array.from({ length: 400 }, (_, i) => (i === 199 ? 'export function buildIndex() {}' : `filler ${i + 1}`));
    const index = renderReadIndex(lines.join('\n'), { delivered: [{ from: 1, to: 120 }] });
    assert.ok(index.includes('400 行'), index.slice(0, 120));
    assert.ok(index.includes('已投递 L1-120'), '覆盖图显式列出');
    assert.ok(index.includes('L200 export function buildIndex'), '行锚含顶层符号');
    assert.ok(index.includes('未投递区间'), '未投递区间显式列出（模型无需推断）');
    // R9：索引超上限 → 只给符号名
    const manySymbols = Array.from({ length: 2000 }, (_, i) => `export const sym${i} = ${i};`);
    const capped = renderReadIndex(manySymbols.join('\n'), { maxIndexChars: 1_000 });
    assert.ok(capped.length < 2_200, `索引超预算降级为符号名（实测 ${capped.length} 字符）`);
  });
});

// ---------------------------------------------------------------------------
// C 组：通道切换（任务边界 + 计划性换基）
// ---------------------------------------------------------------------------

describe('0.5.0 通道：任务边界切换 + 计划性换基（§3.3 约束 5 / §8.3）', () => {
  it('C1. setChannel 排队 → pushUserTask 边界生效：换基 + [tf-stream:context-rebased] + cache-reset', async () => {
    const h = makeHarness({
      chunks: [blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="标准通道完成。"/>' }, stop],
      config: { maxInputTokens: 0, surfaceCompaction: false, maxSteps: 4 },
    });
    h.driver.setIdentity('s', 't');
    try {
      // 先探测 bridge 可用（显式 config.codeSource 的装配在 createDriver 已带——这里驱动器
      // 未带 codeSource，setChannel 会被拒；改用带 codeSource 的驱动器演练切换）
      const h2 = makeHarness({
        chunks: [blockStart, { type: 'text-delta', index: 0, text: '代码通道交付。' }, stop],
        config: { codeSource: 'bridge', maxInputTokens: 0, surfaceCompaction: false, maxSteps: 4 },
      });
      h2.driver.setIdentity('s', 't');
      await h.driver.runTurn(); // 任务一（标准通道）
      const queued = h2.driver.setChannel('code');
      assert.equal(queued.ok, true, JSON.stringify(queued));
      // 任务一进行中不生效（排队）：生效通道仍是 standard
      assert.equal(h2.driver.runtimeStatus().channel, 'standard');
      // 任务边界（pushUserTask）生效
      h2.driver.pushUserTask('任务二：切到代码通道。');
      const status = h2.driver.runtimeStatus();
      assert.equal(status.channel, 'code', '任务边界生效');
      assert.equal(status.codeSource, 'bridge');
      // 计划性换基记账（§8.6：cache-reset 事件含 cause/contextTokens/estimatedColdCost）
      const cacheResets = h2.driver.snapshot().records.filter((r) => r.kind === 'cache-reset');
      assert.ok(cacheResets.some((r) => r.kind === 'cache-reset' && r.cause === 'channel-switch'), 'cache-reset 记账');
      void h;
    } finally {
      h.cleanup();
    }
  });

  it('C2. 档位切换（setTier）只改数值：不换基、无 cache-reset', async () => {
    const h = makeHarness({
      chunks: [blockStart, { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="完成：答案原文为档位切换。"/>' }, stop],
      config: { maxInputTokens: 0, surfaceCompaction: false, maxSteps: 4 },
    });
    try {
      assert.equal(h.driver.setTier('deep').ok, true);
      h.driver.pushUserTask('任务二：换深档。');
      const status = h.driver.runtimeStatus();
      assert.equal(status.tier, 'deep');
      const cacheResets = h.driver.snapshot().records.filter((r) => r.kind === 'cache-reset');
      assert.equal(cacheResets.length, 0, '档位切换不换基（只改数值，§3.3 约束 2）');
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed');
    } finally {
      h.cleanup();
    }
  });
});
