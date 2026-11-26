// test/v043-prefix.test.ts —— v0.4.3 P0-6 前缀退路 + P0-7① 尺子回归（升级清单 §4/§7）
//
// 门禁判据（0.6.1 修订：前缀不单调默认"接受继续"）：
//   ① append 漂移探针：接受为缓存重置点、1 条 prefix-reset、任务完成、0 额外请求；
//   ② stable 漂移探针：同样接受继续（P2）；fail-closed 收场面只在显式 prefixPolicy='fail'
//     下保留（P2b / P4）——blocked 且存在 fallback final、最小对账；
//   ③ 「每回合必漂移」探针：5 个回合全部完成（无放行预算——接受 0 额外开销，限流退役）；
//   ④ 前缀破坏收场（显式 fail 面）：pending intent 全落 unknown（最小对账），悬空 0；
//   尺子：ΣproviderInput / N / resetCount 可外部复算；prefixTokensEst / feedbackBytes /
//   resetSeq / resetCause 落 request 记录；cacheHitRate 标 diagnostic-only。
//
// 驱动器探针用 faultPrefixDrift（离线探针专用配置）篡改上一请求基线——与真实装配回归
// 同一条处置路径（#assertWirePrefix → 三类分类 → 预算/收场）。断言全部对着**线格式请求**
// （prompts / captured messages）与台账 records，不看驱动器内部字段。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, estimatePromptTokens, normalizeStreamShim } from '../src/entry/loop.ts';
import type {
  DriverPorts,
  RenderMessage,
  RequestRecord,
  StreamChunkLike,
  StreamDriverConfig,
  ToolBatchInputLike,
  ToolBatchResultLike,
} from '../src/entry/loop.ts';
import { assertRequestPrefix, PrefixBrokenError } from '../src/kernel/render.ts';
import type { RequestBaseline } from '../src/kernel/render.ts';
import { appendIntentRecord, intentFileOf, loadIntentRecords, pendingIntents, reconcilePendingIntents } from '../src/entry/intent-log.ts';

// ================================================================ 内核：assertRequestPrefix

const msg = (role: RenderMessage['role'], content: string): RenderMessage => ({ role, content });

/** v0.4.3.1：基线 = promised（上一请求收尾后的稳定段快照）+ stableLen（装配时长度，分类锚点）。 */
function baselineOf(promised: readonly RenderMessage[], stableLen: number): RequestBaseline {
  return { promised, stableLen };
}

test('K1. 承诺前缀逐字节继承 + 承诺之外自由变化（digest/新尾）→ 放行', () => {
  const promised = [msg('system', 'sys'), msg('user', 'task'), msg('user', 'obs-promoted')];
  const next = [msg('system', 'sys'), msg('user', 'task'), msg('user', 'obs-promoted'), msg('user', 'digest-new'), msg('user', 'tail-new')];
  const result = assertRequestPrefix(baselineOf(promised, 2), next);
  assert.equal(result.prefixLength, 3);
});

test('K2. append-drift：转正块（承诺前缀内、稳定段之外）被改写 → cause=append-drift', () => {
  const promised = [msg('system', 'sys'), msg('user', 'task'), msg('user', 'obs-promoted'), msg('user', 'obs2-promoted')];
  const drifted = [msg('system', 'sys'), msg('user', 'task'), msg('user', 'obs-promoted（被改写）'), msg('user', 'obs2-promoted')];
  try {
    assertRequestPrefix(baselineOf(promised, 2), drifted);
    assert.fail('必须抛 PrefixBrokenError');
  } catch (error) {
    assert.ok(error instanceof PrefixBrokenError);
    assert.equal(error.prefixCause, 'append-drift');
    assert.equal(error.index, 2);
    assert.equal(error.stablePrefixLen, 2);
    assert.ok(error.index >= error.stablePrefixLen);
  }
});

test('K3. stable-drift：稳定段被改写 → cause=stable-drift，index < stablePrefixLen', () => {
  const promised = [msg('system', 'sys'), msg('user', 'task'), msg('user', 'obs-promoted')];
  const drifted = [msg('system', 'sys'), msg('user', 'task（被改写）'), msg('user', 'obs-promoted')];
  try {
    assertRequestPrefix(baselineOf(promised, 2), drifted);
    assert.fail('必须抛 PrefixBrokenError');
  } catch (error) {
    assert.ok(error instanceof PrefixBrokenError);
    assert.equal(error.prefixCause, 'stable-drift');
    assert.equal(error.index, 1);
    assert.equal(error.stablePrefixLen, 2);
  }
});

test('K4. shrink：next 比 承诺前缀 短且未声明 allowTailDrop → cause=shrink；合法尾部丢弃可放行', () => {
  const promised = [msg('system', 'sys'), msg('user', 'task'), msg('user', 'obs-promoted')];
  const shorter = [msg('system', 'sys'), msg('user', 'task')];
  try {
    assertRequestPrefix(baselineOf(promised, 2), shorter);
    assert.fail('必须抛 PrefixBrokenError');
  } catch (error) {
    assert.ok(error instanceof PrefixBrokenError);
    assert.equal(error.prefixCause, 'shrink');
    assert.ok(error.message.includes('dropAppendHead'), 'shrink 文案必须指出段边界应走 dropAppendHead');
  }
  // allowTailDrop：next 是 promised 的严格字节前缀 → 合法（整块尾部丢弃）
  const ok = assertRequestPrefix(baselineOf(promised, 2), shorter, { allowTailDrop: true });
  assert.equal(ok.prefixLength, 2);
});

test('K5. role 变化在承诺前缀内 → append-drift（转正块 role 必须逐字节一致）', () => {
  const promised = [msg('system', 'sys'), msg('user', 'task'), msg('user', 'obs-promoted')];
  const roleSwapped: RenderMessage[] = [msg('system', 'sys'), msg('user', 'task'), msg('assistant', 'obs-promoted')];
  try {
    assertRequestPrefix(baselineOf(promised, 2), roleSwapped);
    assert.fail('必须抛 PrefixBrokenError');
  } catch (error) {
    assert.ok(error instanceof PrefixBrokenError);
    assert.equal(error.prefixCause, 'append-drift');
    assert.equal(error.index, 2);
  }
});

test('K6. 混合易变尾（transient 在 durable 前）不参与承诺：error 块不进基线，观测块转正即匹配（核查 §2 反例）', () => {
  // 上一请求尾 = [error(transient), observation(durable)]——error 本来就不转正，
  // observation 本来就要转正。基线 promised = 转正后的 stable = [sys, task, observation]；
  // 下一请求该位置就是 observation → 必须放行（v0.4.3 的 horizon 公式在此误报 append-drift）。
  const promised = [msg('system', 'sys'), msg('user', 'task'), msg('user', '[tf-stream:observation handle=obs:read:good@v1 key=ok.txt]…')];
  const next = [
    msg('system', 'sys'),
    msg('user', 'task'),
    msg('user', '[tf-stream:observation handle=obs:read:good@v1 key=ok.txt]…'),
    msg('user', 'digest-new'),
    msg('user', '[tf-stream:nudge] …'),
  ];
  const result = assertRequestPrefix(baselineOf(promised, 2), next);
  assert.equal(result.prefixLength, 3);
});

// ================================================================ 驱动器探针基建

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

interface ProbeHarness {
  driver: SingleStreamDriver;
  /** 每请求的线格式消息快照（尺子复算用） */
  wireMessages: Array<Array<{ role: string; content: readonly { type: 'text'; text: string }[] }>>;
  prompts: string[];
  finalAnswers: string[];
  /** 本回合收场原因序列（多次 runTurn 时按序追加） */
  cleanup: () => void;
}

function makeProbe(
  responses: ReadonlyArray<readonly StreamChunkLike[]>,
  tasks: readonly string[],
  config?: Partial<StreamDriverConfig>,
  hooks?: { reconcile?: (cause: string) => { acked: number } },
): ProbeHarness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v043-'));
  const wireMessages: ProbeHarness['wireMessages'] = [];
  const prompts: string[] = [];
  const finalAnswers: string[] = [];
  let call = 0;
  const ports: DriverPorts = {
    stream: (options) => {
      wireMessages.push([...options.messages]);
      prompts.push(options.messages.map((m) => m.content.map((b) => b.text ?? '').join('')).join('\n'));
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
    ...(hooks?.reconcile === undefined ? {} : { reconcilePendingIntents: hooks.reconcile }),
    events: {
      turnStart: () => {},
      stepStart: () => {},
      stepEnd: () => {},
      turnEnd: () => {},
      assistantMessage: () => ({ eventType: 'assistant/message', seq: 0 }),
      toolLog: () => undefined,
      finalAnswer: (_turn: number, _step: number, text: string) => {
        finalAnswers.push(text);
      },
    },
  };
  const driver = new SingleStreamDriver(ports, {
    provider: 'mock',
    model: 'mock-v043',
    // 0.5.1（1.1）：前缀/收束探针覆盖 0.4.x 收束机制 → 回退开关
    requireFinal: true,
    ...config,
  });
  for (const task of tasks) driver.pushUserTask(task);
  return { driver, wireMessages, prompts, finalAnswers, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

const faultsOf = (h: ProbeHarness, fault: string): Array<{ fault: string; detail?: string }> =>
  h.driver.snapshot().records.filter((r) => r.kind === 'fault' && r.fault === fault) as Array<{ fault: string; detail?: string }>;

const requestRecordsOf = (h: ProbeHarness): RequestRecord[] =>
  h.driver.snapshot().records.filter((r) => r.kind === 'request') as RequestRecord[];

// ---------------------------------------------------------------- 探针① append 漂移

test('P1（探针①）. append 漂移 → 恰好 1 次放行、1 条 prefix-reset、任务完成、0 prefix-broken', async () => {
  // R1: 读 a（观测入 R2 尾）；R2: 读 b（观测入 R3 尾，R2 尾 = durable obs1）；R3: 探针篡改
  // R2 尾的 durable 块 → append-drift → 放行一次 → R3 final 收敛。
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [textDelta('读 a。\n'), textDelta('<tf-read path="a.txt" id="r1"/>\n'), finishStop()],
    [textDelta('读 b。\n'), textDelta('<tf-read path="b.txt" id="r2"/>\n'), finishStop()],
    [textDelta('两个文件都读到了：a.txt 与 b.txt 的约定已核对，答案原文如下。A/B 均为示例文件。\n'), textDelta('<tf-final id="f1" summary="a.txt 与 b.txt 已核对，两者均为示例文件，约定一致。"/>\n'), finishStop()],
  ];
  const harness = makeProbe(responses, ['读两个文件后收尾。'], { faultPrefixDrift: { kind: 'append' } });
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', `任务必须完成（一次重发放行）：${JSON.stringify(reason)}`);
    assert.equal(faultsOf(harness, 'prefix-reset').length, 1, '恰好 1 条 prefix-reset');
    assert.equal(faultsOf(harness, 'prefix-broken').length, 0, '预算内不得 fail-closed');
    assert.equal(harness.prompts.length, 3, '放行 = 同一份 next 照常发送（0 额外请求）');
    const detail = faultsOf(harness, 'prefix-reset')[0]!.detail ?? '';
    assert.ok(detail.includes('cause=append-drift'), 'prefix-reset 必须带成因');
    assert.ok(detail.includes('stablePrefixLen'), 'prefix-reset 必须带 stablePrefixLen（判定依据）');
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------- 探针② stable 漂移

test('P2（探针②）. stable 漂移 → 接受为缓存重置点：同一份 next 照常发送、任务完成、0 额外请求（0.6.1）', async () => {
  // 0.6.1：前缀不单调（含 stable-drift）默认全部**接受**——发送前放行同一份 next（0 额外
  // 请求 / 0 注入文本），基线随本请求推进，对话不中断。fail-closed 面由 P2b
  // （prefixPolicy='fail' 显式回退面）单独钉住。
  //
  // R1: 写文件 ok（无 final → nudge）；R2 装配时探针篡改 R1 稳定段（index 1）→ stable-drift
  // → 接受 → R2 照常发送（本响应自带 final 收尾）。
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [textDelta('写文件。\n'), textDelta('<tf-write path="p.txt" id="w1">P</tf-write>\n'), finishStop()],
    [textDelta('写入已确认：p.txt 内容 P 已落盘核对一致。\n'), textDelta('<tf-final id="f1" summary="p.txt 已写入并核对：内容 P，无未完成项。"/>\n'), finishStop()],
  ];
  const harness = makeProbe(responses, ['写一个文件。'], { faultPrefixDrift: { kind: 'stable' } });
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', `stable-drift 必须接受继续：${JSON.stringify(reason)}`);
    assert.equal(harness.prompts.length, 2, '接受 = 同一份 next 照常发送（0 额外请求）');
    assert.equal(faultsOf(harness, 'prefix-reset').length, 1, '恰 1 条 prefix-reset（可诊断）');
    assert.equal(faultsOf(harness, 'prefix-broken').length, 0, '默认策略不再 fail-closed');
    assert.equal(faultsOf(harness, 'prefix-auto-continue').length, 0, '接受路径不需要续跑');
    const detail = faultsOf(harness, 'prefix-reset')[0]!.detail ?? '';
    assert.ok(detail.includes('cause=stable-drift'), 'prefix-reset 必须带成因');
    assert.ok(detail.includes('stablePrefixLen'), 'prefix-reset 必须带 stablePrefixLen（判定依据）');
    assert.ok(detail.includes('接受为缓存重置点'), '处置语义进台账');
    // request 记录：R2 处于新纪元（resetSeq=1，cause=prefix-reset）
    const records = requestRecordsOf(harness);
    assert.equal(records[1]!.resetSeq, 1, 'R2 进入重置新纪元');
    assert.equal(records[1]!.resetCause, 'prefix-reset');
  } finally {
    harness.cleanup();
  }
});

test('P2b. prefixPolicy=\'fail\'（显式回退面）：stable 漂移仍 fail-closed（§12.4 保留面）', async () => {
  // 显式配置"绝不换基，违约必报错"是用户的选择——0.6.1 把它作为唯一保留的 fail-closed 面。
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [textDelta('写文件。\n'), textDelta('<tf-write path="p.txt" id="w1">P</tf-write>\n'), finishStop()],
    // R2 不会发出（fail-closed 在发送前拦截）
  ];
  const harness = makeProbe(responses, ['写一个文件。'], {
    faultPrefixDrift: { kind: 'stable' },
    prefixPolicy: 'fail',
    autoContinueOnPrefixFail: false,
  });
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'blocked', '显式 fail 策略必须 fail-closed 收场');
    assert.ok(reason.kind === 'blocked' && (reason.detail ?? '').includes('stable-drift'), 'blocked 文案含成因 stable-drift');
    assert.equal(harness.prompts.length, 1, '0 放行：第二个请求不得发出');
    assert.equal(faultsOf(harness, 'prefix-broken').length, 1, '恰 1 条 prefix-broken（可诊断错误）');
    assert.equal(faultsOf(harness, 'prefix-reset').length, 0, 'fail 策略不放行');
    assert.equal(faultsOf(harness, 'fallback-final').length, 1, '有 ok 命令 → 存在 fallback final（P0-6⑤）');
    assert.equal(harness.finalAnswers.length, 1, '兜底交付落成 assistant 消息');
    assert.ok(harness.finalAnswers[0]!.includes('[未完成交付]'), '兜底交付明确标注未完成（不伪造模型结论）');
    assert.ok(harness.finalAnswers[0]!.includes('tf-write'), '兜底交付列出台账事实（写过的文件）');
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------- 探针③ 每回合必漂移

test('P3（探针③）. 每回合必漂移 → 每次都接受为缓存重置点，对话永不中断（0.6.1：无放行预算）', async () => {
  // 旧契约（≤0.6.0）：append-drift 受限换基有会话预算 3 次，第 4 次降级 fail-closed →
  // 对话中断。0.6.1：接受不产生任何额外请求/计费/注入，限流失去意义——5 个回合全部完成。
  // 每回合 2 请求：A=读文件（观测 durable 尾块留基线）、B=final 收敛。漂移在下一回合首请求
  // 装配时触发（oncePerTurn）。
  const readFinal = (file: string, n: number): ReadonlyArray<readonly StreamChunkLike[]> => [
    [textDelta(`读 ${file}。\n`), textDelta(`<tf-read path="${file}" id="r${n}"/>\n`), finishStop()],
    [textDelta(`${file} 已核对，约定如下：示例文件，内容为占位文本，无阻塞项。\n`), textDelta(`<tf-final id="f${n}" summary="${file} 已核对：示例文件，约定一致，无未完成项。"/>\n`), finishStop()],
  ];
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    ...readFinal('a.txt', 1),
    ...readFinal('b.txt', 2),
    ...readFinal('c.txt', 3),
    ...readFinal('d.txt', 4),
    ...readFinal('e.txt', 5),
  ];
  const harness = makeProbe(responses, ['读 a 收尾。', '读 b 收尾。', '读 c 收尾。', '读 d 收尾。', '读 e 收尾。'], {
    faultPrefixDrift: { kind: 'append', oncePerTurn: true },
  });
  try {
    for (let i = 0; i < 5; i += 1) {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed', `回合 ${i + 1} 必须完成（接受继续，永不中断）：${JSON.stringify(reason)}`);
    }
    assert.equal(faultsOf(harness, 'prefix-broken').length, 0, '0 fail-closed（不再有预算耗尽降级）');
    assert.equal(harness.prompts.length, 10, '每回合 2 请求 × 5 = 10（接受 = 0 额外请求）');
    const resets = faultsOf(harness, 'prefix-reset');
    assert.ok(resets.length >= 4, `每回合漂移都接受（实际 ${resets.length} 次）`);
    for (const rec of resets) {
      assert.ok((rec.detail ?? '').includes('cause=append-drift'), 'prefix-reset 必须带成因');
      assert.ok((rec.detail ?? '').includes('接受为缓存重置点'), '处置语义进台账');
    }
    assert.ok(harness.finalAnswers.length >= 5, '5 个回合各自交付 final');
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------- 探针④ 最小对账

test('P4（探针④）. prefixPolicy=\'fail\' 下前缀破坏收场 → pending intent 全落 unknown（悬空 0），ack 注明不重放不回滚', async () => {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v043-intent-'));
  try {
    const intentFile = intentFileOf(sandboxDir, 'probe-session');
    const seqState = { seq: 0 };
    // 两笔写前意图，均无回执（= pending：写入可能已发生）
    appendIntentRecord(intentFile, { type: 'intent', seq: ++seqState.seq, at: new Date().toISOString(), sessionId: 'probe-session', cmdId: 'w1', op: 'write', path: 'p1.txt', fingerprint: 'fp1' });
    appendIntentRecord(intentFile, { type: 'intent', seq: ++seqState.seq, at: new Date().toISOString(), sessionId: 'probe-session', cmdId: 'w2', op: 'edit', path: 'p2.txt', fingerprint: 'fp2' });
    let ackedViaPort = -1;
    const harness = makeProbe(
      [[textDelta('写文件。\n'), textDelta('<tf-write path="p.txt" id="w1">P</tf-write>\n'), finishStop()]],
      ['写一个文件。'],
      // 0.6.1：最小对账挂在 fail-closed 收场链上——显式回退面（prefixPolicy='fail'）触发
      { faultPrefixDrift: { kind: 'stable' }, prefixPolicy: 'fail', autoContinueOnPrefixFail: false },
      {
        reconcile: (cause) => {
          const acked = reconcilePendingIntents(intentFile, cause, seqState);
          ackedViaPort = acked;
          return { acked };
        },
      },
    );
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'blocked');
    assert.equal(ackedViaPort, 2, '两笔 pending 意图都被最小对账');
    assert.equal(faultsOf(harness, 'intent-reconciled').length, 1, '对账事实落台账');
    assert.ok((faultsOf(harness, 'intent-reconciled')[0]!.detail ?? '').includes('不重放'), '对账文案写死"不重放"');
    // 悬空 0：对账后 pendingIntents 必须为空（恢复锁解除）
    const { records } = loadIntentRecords(intentFile);
    const stillPending = pendingIntents(records).filter((p) => p.state === 'pending');
    assert.equal(stillPending.length, 0, 'pending 意图悬空数必须为 0');
    const ack = records.find((r) => r.type === 'ack') as { note?: string } | undefined;
    assert.ok(ack !== undefined, '对账以 ack 记录落盘');
    assert.ok((ack!.note ?? '').includes('unknown') && (ack!.note ?? '').includes('不声称回滚'), 'ack note 写明 unknown 语义（不重放、不声称回滚）');
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 探针⑤ 真实装配漂移

test('P5（探针⑤）. 真实混合尾（error+observation 同步）不篡改基线：0 prefix-reset、0 prefix-broken、任务完成（核查 §2.2 复现）', async () => {
  // 同一条流发两条命令：bad 依赖未满足 → error 块（transient，不转正）；good 成功 →
  // observation 块（durable，转正）。R2 尾 = [error, observation] 混合序——v0.4.3 的
  // horizon 公式在 R3 装配时误报 append-drift（消耗预算）；v0.4.3.1 promised 基线必须 0 误报。
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [
      textDelta('两个都试一下。\n'),
      textDelta('<tf-read path="ok.txt" id="bad" depends_on="nope"/>\n'),
      textDelta('<tf-read path="ok.txt" id="good"/>\n'),
      finishStop(),
    ],
    [textDelta('失败的那条改道说明已收到；成功那条的内容已核对：ok.txt 为示例文件。\n'), finishStop()],
    [textDelta('收尾：bad 已按建议改道（换依赖重发由后续回合处理），good 的 ok.txt 已核对。\n'), textDelta('<tf-final id="f1" summary="ok.txt 已核对（示例文件）；bad 命令依赖未满足已收到改道建议，未阻塞交付。"/>\n'), finishStop()],
  ];
  const harness = makeProbe(responses, ['带失败改道的读取任务。']);
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', `真实混合尾不得误判漂移：${JSON.stringify(reason)}`);
    assert.equal(faultsOf(harness, 'prefix-reset').length, 0, '混合尾不得消耗放行预算（核查 §2 阻断项的回归钉）');
    assert.equal(faultsOf(harness, 'prefix-broken').length, 0, '更不得 fail-closed 误杀任务');
    assert.equal(harness.prompts.length, 3, '三个请求全部正常发出（R2 尾 = [error, observation] 混合序）');
    assert.ok(harness.prompts[1]!.includes('[tf-stream:error'), 'R2 确实携带 error 块（transient）');
    assert.ok(harness.prompts[1]!.includes('[tf-stream:observation'), 'R2 确实携带 observation 块（durable）');
    // R3 的头部必须继承 R2 转正后的 stable（observation 在 error 的位置上——这正是旧公式误判点）
    assert.ok(harness.prompts[2]!.includes('[tf-stream:observation'), 'R3 头部继承转正后的 observation');
    assert.ok(!harness.prompts[2]!.includes('[tf-stream:error id=bad'), 'R3 不再携带 transient error（本来就不转正）');
  } finally {
    harness.cleanup();
  }
});

test('M0. 同一 mock 轨迹跑两次：renderHash 序列与 fault 序列逐字节一致（核查 §6 条目 2 验收）', async () => {
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [textDelta('读 a。\n'), textDelta('<tf-read path="a.txt" id="r1"/>\n'), finishStop()],
    [textDelta('读 b。\n'), textDelta('<tf-read path="b.txt" id="r2"/>\n'), finishStop()],
    [textDelta('收尾：a/b 均已核对：示例文件，约定一致。\n'), textDelta('<tf-final id="f1" summary="a.txt 与 b.txt 已核对：示例文件，约定一致。"/>\n'), finishStop()],
  ];
  const run = async (): Promise<{ hashes: string[]; faults: string[] }> => {
    const harness = makeProbe(responses, ['读两个文件后收尾。']);
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const records = harness.driver.snapshot().records;
      return {
        hashes: records.filter((r) => r.kind === 'request').map((r) => (r as unknown as { renderHash: string }).renderHash),
        faults: records.filter((r) => r.kind === 'fault').map((r) => `${(r as unknown as { fault: string }).fault}:${(r as unknown as { detail?: string }).detail ?? ''}`),
      };
    } finally {
      harness.cleanup();
    }
  };
  const a = await run();
  const b = await run();
  assert.equal(a.hashes.length, b.hashes.length, '两跑请求数一致');
  for (let i = 0; i < a.hashes.length; i += 1) {
    assert.equal(a.hashes[i], b.hashes[i], `第 ${i + 1} 请求 renderHash 逐字节一致`);
  }
  assert.deepEqual(a.faults, b.faults, 'fault 序列一致（0 fault 时同为空）');
});

// ================================================================ P0-7① 尺子

test('M1. request 记录带 prefixTokensEst：ASCII=Σcontent/4、CJK=0.7 token/字符（对实际发送消息独立复算）', async () => {
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [textDelta('收尾。\n'), textDelta('<tf-final id="f1" summary="直接交付：任务无文件操作，答案原文如下。"/>\n'), finishStop()],
  ];
  const harness = makeProbe(responses, ['直接收尾。']);
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed');
    const records = requestRecordsOf(harness);
    assert.equal(records.length, 1);
    const sent = harness.wireMessages[0]!;
    // 0.5.2：估算口径按 CJK 加权（汉字 ≈0.7 token/字符，ASCII 仍 4 字符/token）——
    // 纯 /4 会把中文前缀低估 ~2.8 倍，让压缩触发得太晚。
    let ascii = 0;
    let wide = 0;
    for (const m of sent) {
      for (const ch of m.content.map((b) => b.text ?? '').join('')) {
        if (ch.codePointAt(0)! >= 0x2e80) wide += 1;
        else ascii += 1;
      }
    }
    assert.equal(records[0]!.prefixTokensEst, Math.ceil(ascii / 4 + wide * 0.7), '估算 = ASCII/4 + CJK×0.7 上取整');
    assert.ok(records[0]!.prefixTokensEst! > 0);
  } finally {
    harness.cleanup();
  }
});

test('M2. request 记录计量回填：providerInputTokens = input+cacheRead+cacheWrite（权威值），未上报请求字段缺省', async () => {
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [
      textDelta('读文件。\n'),
      textDelta('<tf-read path="a.txt" id="r1"/>\n'),
      usageChunk({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 50 }),
      finishStop(),
    ],
    [textDelta('收尾：a.txt 已核对，示例文件约定一致。\n'), textDelta('<tf-final id="f1" summary="a.txt 已核对：示例文件，约定一致。"/>\n'), finishStop()],
  ];
  const harness = makeProbe(responses, ['读文件后收尾。']);
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed');
    const records = requestRecordsOf(harness);
    assert.equal(records.length, 2);
    assert.equal(records[0]!.providerInputTokens, 100 + 900 + 50, '计费输入 = 未命中 + 缓存读 + 缓存写');
    assert.equal(records[0]!.cacheRead, 900);
    assert.equal(records[0]!.cacheWrite, 50);
    assert.equal(records[0]!.output, 20);
    assert.equal(records[1]!.providerInputTokens, undefined, '适配器未上报的请求不写 0 噪声（字段缺省）');
  } finally {
    harness.cleanup();
  }
});

test('M3. 聚合三元组可外部复算：cacheStats().providerInputSum === Σ记录.providerInputTokens；requests=N；resetCount=末条 resetSeq', async () => {
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [textDelta('读 a。\n'), textDelta('<tf-read path="a.txt" id="r1"/>\n'), usageChunk({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 700 }), finishStop()],
    [textDelta('读 b。\n'), textDelta('<tf-read path="b.txt" id="r2"/>\n'), usageChunk({ inputTokens: 120, outputTokens: 12, cacheReadTokens: 800 }), finishStop()],
    [textDelta('收尾：a/b 均已核对，示例文件约定一致。\n'), textDelta('<tf-final id="f1" summary="a.txt 与 b.txt 已核对：示例文件，约定一致。"/>\n'), usageChunk({ inputTokens: 30, outputTokens: 8 }), finishStop()],
  ];
  const harness = makeProbe(responses, ['读两个文件后收尾。']);
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed');
    const records = requestRecordsOf(harness);
    const sum = records.reduce((n, r) => n + (r.providerInputTokens ?? 0), 0);
    const stats = (harness.driver as unknown as {
      cacheStats(): { providerInputSum: number; requests: number; resetCount: number; cacheHitRatio: number | null };
    }).cacheStats();
    assert.equal(stats.providerInputSum, sum, 'ΣproviderInput 可从 request 记录逐条复算');
    assert.equal(sum, 100 + 700 + 120 + 800 + 30, '只计上报了 usage 的请求（未上报不计 0）');
    assert.equal(stats.requests, records.length, 'N = request 记录数');
    assert.equal(stats.resetCount, 0, '无重置 → resetCount 0');
    // cacheHitRatio 保留但 diagnostic-only（类型面 + JSDoc；数值行为不变）
    assert.equal(typeof stats.cacheHitRatio, 'number');
  } finally {
    harness.cleanup();
  }
});

test('M4. resetSeq/resetCause：段边界 → 纪元 +1 且 cause=segment-drop；新纪元请求携带，旧纪元 resetSeq=0', async () => {
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    // 回合 1：读 + final（历史增长超过 segmentMaxChars=100）
    [textDelta('读 a。\n'), textDelta('<tf-read path="a.txt" id="r1"/>\n'), finishStop()],
    [textDelta('a.txt 已核对：示例文件，约定一致，无未完成项。\n'), textDelta('<tf-final id="f1" summary="a.txt 已核对：示例文件，约定一致。"/>\n'), finishStop()],
    // 回合 2：段边界触发后读 b + final
    [textDelta('读 b。\n'), textDelta('<tf-read path="b.txt" id="r2"/>\n'), finishStop()],
    [textDelta('b.txt 已核对：示例文件，约定一致。\n'), textDelta('<tf-final id="f2" summary="b.txt 已核对：示例文件，约定一致。"/>\n'), finishStop()],
  ];
  const harness = makeProbe(responses, ['读 a 收尾。', '读 b 收尾。'], { segmentMaxChars: 100 });
  try {
    const r1 = await harness.driver.runTurn();
    assert.equal(r1.kind, 'completed');
    harness.driver.pushUserTask('读 b 收尾。');
    const r2 = await harness.driver.runTurn();
    assert.equal(r2.kind, 'completed');
    const records = requestRecordsOf(harness);
    const turn1 = records.filter((r) => r.turn === 1);
    const turn2 = records.filter((r) => r.turn === 2);
    assert.ok(turn1.every((r) => (r.resetSeq ?? 0) === 0), '回合 1 全部处于纪元 0');
    assert.ok(turn2.length >= 2, '回合 2 至少 2 个请求');
    assert.ok(turn2.every((r) => r.resetSeq === 1), '回合 2 请求全部进入纪元 1');
    assert.ok(turn2.every((r) => r.resetCause === 'segment-drop'), '纪元成因 = segment-drop');
    assert.equal(faultsOf(harness, 'segment-drop').length, 1, '段边界事实落台账');
  } finally {
    harness.cleanup();
  }
});

test('M5. feedbackBytes 分类：全量观测=full、自写回验回执=handle、纯指令块（nudge）不计入', async () => {
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    // R1: 读 a（obs1 全量 → R2 尾）
    [textDelta('读 a。\n'), textDelta('<tf-read path="a.txt" id="r1"/>\n'), finishStop()],
    // R2: 写 w（无注入 → nudge 指令块，不计反馈）
    [textDelta('写 w。\n'), textDelta('<tf-write path="w.txt" id="w1">hello world</tf-write>\n'), finishStop()],
    // R3: 读 w（自写回验 → 回执 → R4 尾）
    [textDelta('回验 w。\n'), textDelta('<tf-read path="w.txt" id="r2"/>\n'), finishStop()],
    [textDelta('回验通过：写入成功且无错误注入，内容一致。\n'), textDelta('<tf-final id="f1" summary="w.txt 已写入并回验：写入成功，无错误注入。"/>\n'), finishStop()],
  ];
  // 0.5.1（2.2）：M5 覆盖自写回验 receipt 的字节分类 → 显式走回退点（默认已改 full）
  const harness = makeProbe(responses, ['写后回验收尾。'], { selfReadFeedback: 'receipt' });
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', JSON.stringify(reason));
    const records = requestRecordsOf(harness);
    assert.ok(records.length >= 4, `至少 4 个请求，实际 ${records.length}`);
    assert.equal(records[0]!.feedbackBytes!.full, 0, '首请求无反馈注入');
    assert.ok(records[1]!.feedbackBytes!.full > 0, 'obs1 全量回灌 → R2 记 full 字节');
    assert.equal(records[1]!.feedbackBytes!.handle, 0);
    assert.equal(records[2]!.feedbackBytes!.full, 0, 'nudge 是指令块 → R3 不计反馈');
    assert.equal(records[2]!.feedbackBytes!.handle, 0);
    assert.ok(records[3]!.feedbackBytes!.handle > 0, '自写回验回执 → R4 记 handle 字节');
    assert.equal(records[3]!.feedbackBytes!.full, 0, '回执不回灌全文 → full 恒 0');
    assert.equal(records[3]!.feedbackBytes!.dedup, 0, 'dedup 由 P0-4（0.5.0）引入，0.4.3 恒 0');
    // 交叉校验：full 字节 = 该请求尾块实发字节（R2 尾 = obs1 观测块）
    const secondPromptTailObs = harness.prompts[1]!;
    assert.ok(secondPromptTailObs.includes('[tf-stream:observation'), 'R2 确实携带 obs1 全量块');
  } finally {
    harness.cleanup();
  }
});

test('M6. wire 断言正常路径零噪声：无漂移会话 0 prefix-reset / 0 prefix-broken（对照探针）', async () => {
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [textDelta('读 a。\n'), textDelta('<tf-read path="a.txt" id="r1"/>\n'), finishStop()],
    [textDelta('收尾：a.txt 已核对：示例文件，约定一致。\n'), textDelta('<tf-final id="f1" summary="a.txt 已核对：示例文件，约定一致。"/>\n'), finishStop()],
  ];
  const harness = makeProbe(responses, ['读文件收尾。']);
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed');
    assert.equal(faultsOf(harness, 'prefix-reset').length, 0);
    assert.equal(faultsOf(harness, 'prefix-broken').length, 0);
  } finally {
    harness.cleanup();
  }
});
