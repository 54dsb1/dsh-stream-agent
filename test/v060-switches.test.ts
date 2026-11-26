// test/v060-switches.test.ts —— 0.6.0 §0 离线验收：A1 contextFold / A2 finalCheck /
// A3 持久化 schema 4 / A4 同轮续跑 / A5 续跑账本与状态面。
//
// 断言全部对着可观测面：**请求原文**（prompts）、**台账记录**（records/ledger）、**收场原因**。
// 不读驱动器私有字段；探针（faultPrefixDrift）与真实漂移走同一条处置路径。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, MAX_PREFIX_AUTO_CONTINUES, normalizeStreamShim } from '../src/entry/loop.ts';
import type { DriverPorts, StreamChunkLike, StreamDriverConfig, ToolBatchInputLike, ToolBatchResultLike, TurnEndReason } from '../src/entry/loop.ts';
import { controlFileOf, readPersistedControl, resolveControlState, writePersistedControl } from '../src/entry/control-state.ts';
import { switchSummaryLine } from '../src/kernel/control-bar.ts';
import applyControlBar from '../src/entry/control-bar.ts';

// ================================================================ 设施

type Chunk = StreamChunkLike;

async function* scripted(chunks: readonly Chunk[]): AsyncGenerator<Chunk, void, undefined> {
  for (const c of chunks) yield c;
}

const text = (t: string): Chunk => ({ type: 'text-delta', index: 1, text: t }) as Chunk;
const stop = (): Chunk => ({ type: 'finish', reason: { kind: 'stop' } }) as Chunk;

/** 一次性正常交付（无文件操作）。 */
const finishLike = (): ReadonlyArray<Chunk> => [
  text('直接交付：任务无文件操作，答案原文如下。\n'),
  text('<tf-final id="f1" summary="直接交付：任务无文件操作，答案原文如下。"/>\n'),
  stop(),
];

interface Harness {
  driver: SingleStreamDriver;
  prompts: string[];
  /** 收场事实消息（兜底交付）——零产出场景以前完全没被断言过 */
  finals: string[];
  ledger: Array<{ type: string; data: Record<string, unknown> }>;
  faults: (fault: string) => Array<{ fault: string; detail?: string }>;
  cleanup: () => void;
}

function makeHarness(
  responses: ReadonlyArray<readonly Chunk[]>,
  config: Partial<StreamDriverConfig> = {},
): Harness {
  const sandbox = mkdtempSync(join(tmpdir(), 'tf-v060-'));
  const prompts: string[] = [];
  const finals: string[] = [];
  const ledger: Harness['ledger'] = [];
  let call = 0;
  const ports: DriverPorts = {
    stream: (options) => {
      prompts.push(options.messages.map((m) => m.content.map((b) => b.text ?? '').join('')).join('\n'));
      const chunks = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return normalizeStreamShim(scripted(chunks) as never) as AsyncIterable<Chunk>;
    },
    executeTools: async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => ({
      results: input.calls.map((c) => ({
        callId: c.id,
        result: { content: [{ type: 'text', text: `ok:${c.name}` }], isError: false },
      })),
    }),
    events: {
      turnStart: () => {}, stepStart: () => {}, stepEnd: () => {}, turnEnd: () => {},
      assistantMessage: () => ({ eventType: 'assistant/message', seq: 0 }),
      toolLog: () => undefined,
      finalAnswer: (_turn: number, _step: number, answer: string) => { finals.push(answer); },
    },
  };
  const driver = new SingleStreamDriver(ports, {
    provider: 'mock',
    model: 'mock-v060',
    requireFinal: true,
    ...config,
  });
  driver.attachLedger({ record: (type, data) => ledger.push({ type, data: data as Record<string, unknown> }) });
  const allRecords = () => driver.snapshot().records as Array<{ kind: string; fault?: string; detail?: string }>;
  return {
    driver,
    prompts,
    finals,
    ledger,
    faults: (fault) => allRecords().filter((r) => r.kind === 'fault' && r.fault === fault) as Array<{ fault: string; detail?: string }>,
    cleanup: () => rmSync(sandbox, { recursive: true, force: true }),
  };
}

/** 一回合：读一个文件 + 收尾（2 个请求）。 */
const readFinal = (file: string, n: number): ReadonlyArray<readonly Chunk[]> => [
  [text(`读 ${file}。\n`), text(`<tf-read path="${file}" id="r${n}"/>\n`), stop()],
  [text(`${file} 已核对：示例文件，约定一致，无未完成项。\n`), text(`<tf-final id="f${n}" summary="${file} 已核对：示例文件，约定一致，无未完成项。"/>\n`), stop()],
];

// ================================================================ A1：contextFold

test('A1-1. contextFold=false：阈值都设了也不压缩、不折叠、不丢段（10 回合 0 事件）', async () => {
  const responses = Array.from({ length: 10 }, (_, i) => readFinal(`a${i}.txt`, i + 1)).flat();
  const h = makeHarness(responses, {
    contextFold: false,
    segmentMaxChars: 50,
    effectElisionKeepRecent: 1,
    keepRecent: 0,
    maxInputTokens: 12_000,
  });
  try {
    for (let i = 0; i < 10; i += 1) {
      h.driver.pushUserTask(`读 a${i}.txt 后收尾。`);
      const reason: TurnEndReason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed', `回合 ${i + 1} 应正常完成：${JSON.stringify(reason)}`);
    }
    assert.equal(h.faults('segment-drop').length, 0, 'contextFold=false：段丢弃必须为 0');
    assert.equal(h.faults('compaction').length, 0, 'contextFold=false：压缩必须为 0');
    assert.equal(h.faults('compaction-skipped').length, 0, 'contextFold=false：连"跳过"都不该出现（根本没判定）');
    const joined = h.prompts.join('\n');
    assert.ok(!joined.includes('[applied '), 'contextFold=false：效果折叠不得出现');
    // 追加区持续增长、无 drop：最后一个请求必须比第一个长
    assert.ok(h.prompts.at(-1)!.length > h.prompts[0]!.length, '追加区必须增长（旧内容不移出请求）');
  } finally {
    h.cleanup();
  }
});

test('A1-2. contextFold=true + 段阈值：段丢弃事件 >0 且 [context-rebased] 模型可见（10 回合）', async () => {
  const responses = Array.from({ length: 10 }, (_, i) => readFinal(`b${i}.txt`, i + 1)).flat();
  const h = makeHarness(responses, { contextFold: true, segmentMaxChars: 100, keepRecent: 0 });
  try {
    for (let i = 0; i < 10; i += 1) {
      h.driver.pushUserTask(`读 b${i}.txt 后收尾。`);
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed', `回合 ${i + 1} 应完成`);
    }
    assert.ok(h.faults('segment-drop').length > 0, 'contextFold=true + 阈值：段丢弃必须发生');
    assert.ok(h.prompts.join('\n').includes('[tf-stream:context-rebased]'), '[context-rebased] 必须模型可见');
  } finally {
    h.cleanup();
  }
});

test('A1-3. 面板摘要：开启但未设阈值 → 明确写"已开启，未设阈值，不触发"；关闭时写关', () => {
  const on = switchSummaryLine({ channel: 'standard', tier: 'standard', lang: 'zh', contextFold: true, finalCheck: true }, 'zh');
  assert.ok(on.includes('已开启，未设阈值，不触发'), `必须显式标注未触发：${on}`);
  const off = switchSummaryLine({ channel: 'standard', tier: 'standard', lang: 'zh', contextFold: false, finalCheck: true }, 'zh');
  assert.ok(off.includes('上下文折叠=关'), `关闭必须写关：${off}`);
  assert.ok(!off.includes('已开启'), '关闭时不得再出现"已开启"');
  const withThreshold = switchSummaryLine({ channel: 'standard', tier: 'standard', lang: 'zh', contextFold: true, finalCheck: true, limits: { segmentMaxChars: 100 } }, 'zh');
  assert.ok(!withThreshold.includes('未设阈值'), '设了阈值就不得再写未触发');
});

// ================================================================ A2：finalCheck

const planWriteProse = (id: string): ReadonlyArray<readonly Chunk[]> => [
  [
    text('先声明计划。\n'),
    text('<tf-plan id="p1">\n- [a1] 写出结果文件\n</tf-plan>\n'),
    text(`<tf-write path="out-${id}.txt" id="w${id}">X</tf-write>\n`),
    stop(),
  ],
  // 第二请求：纯 prose，不发 tf-final、不补 accepts
  [text('工作已经做完了，我不再输出结构化交付。\n'), stop()],
];

test('A2. enablePlan × finalCheck 2×2：false 时无 final 也正常交付、请求数不增、tf-plan 仍解析；true 时未完成 blocked', async () => {
  const cases: Array<{ plan: boolean; check: boolean; expect: 'completed' | 'blocked' }> = [
    { plan: true, check: true, expect: 'blocked' },
    { plan: true, check: false, expect: 'completed' },
    { plan: false, check: true, expect: 'blocked' },
    { plan: false, check: false, expect: 'completed' },
  ];
  for (const c of cases) {
    for (let round = 1; round <= 5; round += 1) {
    const h = makeHarness(planWriteProse(`${c.plan ? 'p' : 'n'}${c.check ? 'c' : 'x'}`), {
      enablePlan: c.plan,
      finalCheck: c.check,
    });
    try {
      h.driver.pushUserTask(`写文件并交付（第 ${round} 回合）。`);
      const reason = await h.driver.runTurn();
      assert.equal(
        reason.kind,
        c.expect,
        `enablePlan=${c.plan} finalCheck=${c.check} 第 ${round} 回合 期望 ${c.expect}，实际 ${JSON.stringify(reason)}`,
      );
      // finalCheck=false：不得因为"没有 tf-final"而多烧请求（收束 nudge 全部关闭）
      if (!c.check) {
        assert.ok(h.prompts.length <= 2, `finalCheck=false 请求数不得增加（实际 ${h.prompts.length}）`);
        assert.equal(h.faults('closeout-nudge').length, 0, 'finalCheck=false 不得注入收束 nudge（闸门关了不该催收）');
        assert.equal(h.faults('missing-final-nudge').length, 0, 'finalCheck=false 不得注入"请输出 tf-final"进度提示');
      }
      // tf-plan 的解析只受 enablePlan 控制：看命令终态（ok = 解析成功；failed = plan-disabled）
      const planCmd = (h.driver.snapshot().records as Array<{ kind: string; name?: string; status?: string; detail?: string }>)
        .filter((r) => r.kind === 'command' && r.name === 'tf-plan' && r.status !== 'pending' && r.status !== 'dispatched')
        .at(-1);
      assert.ok(planCmd !== undefined, 'tf-plan 命令必须被处理过');
      if (c.plan) assert.equal(planCmd.status, 'ok', `enablePlan=true：tf-plan 必须仍被解析（实际 ${planCmd.detail}）`);
      else assert.equal(planCmd.status, 'failed', 'enablePlan=false：tf-plan 结构化失败');
      // 无论开关组合，都不得出现"孤立 final"类硬错误
      assert.equal(h.faults('turn-blocked').length, c.expect === 'blocked' ? 1 : 0, '不允许无记录的硬失败');
    } finally {
      h.cleanup();
    }
    }
  }
});

test('A2-3. finalCheck=false 的静态提示不要求 tf-final；true 时要求（开关不能只关运行期闸门）', async () => {
  const on = makeHarness([finishLike()], { finalCheck: true });
  const off = makeHarness([finishLike()], { finalCheck: false });
  try {
    on.driver.pushUserTask('直接交付。');
    await on.driver.runTurn();
    off.driver.pushUserTask('直接交付。');
    await off.driver.runTurn();
    assert.ok(on.prompts[0]!.includes('tf-final'), 'finalCheck=true：系统提示必须要求 tf-final');
    assert.ok(off.prompts[0]!.includes('不需要 tf-final'), `finalCheck=false：提示必须明确不要求 tf-final（实际前 400 字：${off.prompts[0]!.slice(0, 400)}）`);
    assert.ok(!off.prompts[0]!.includes('回合必须以 <tf-final'), 'finalCheck=false：不变量里不得再出现"必须以 tf-final 收尾"');
  } finally {
    on.cleanup();
    off.cleanup();
  }
});

test('A3-5. 终端重置（r 键）与上限清空都保留两个开关；运行期改并行度生效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-v060-session-'));
  try {
    writePersistedControl({ channel: 'code', tier: 'deep', lang: 'zh', contextFold: false, finalCheck: false }, dir);
    const { ControlSession } = await import('../src/entry/control-session.ts');
    const saved: Array<Record<string, unknown>> = [];
    const session = new ControlSession(
      { channel: 'code', tier: 'deep', lang: 'zh', contextFold: false, finalCheck: false },
      {
        save: (state: Record<string, unknown>) => {
          saved.push(state as Record<string, unknown>);
          return join(dir, 'control.json');
        },
        columns: () => 80,
      } as never,
    );
    session.reset();
    assert.equal(saved.at(-1)!['contextFold'], false, 'r 键重置不得把 contextFold 恢复成开');
    assert.equal(saved.at(-1)!['finalCheck'], false, 'r 键重置不得把 finalCheck 恢复成开');
    session.applyLimits('reset');
    assert.equal(saved.at(-1)!['contextFold'], false, '上限清空不得把 contextFold 恢复成开');
    assert.equal(saved.at(-1)!['finalCheck'], false, '上限清空不得把 finalCheck 恢复成开');

    // 运行期并行度：setLimits 之后 effectiveParams 必须跟着变（此前只进构造期）
    // 不设装配值（装配 > limits 的优先级是既有语义），运行期用 setLimits 改
    const h = makeHarness([finishLike()]);
    try {
      h.driver.setLimits({ maxParallelToolCalls: 7 });
      assert.equal(h.driver.effectiveParams().maxParallelToolCalls, 7, 'setLimits 后并行度必须生效');
    } finally {
      h.cleanup();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A2-2. PTC兼容模式下 finalCheck 置灰：摘要行明确"PTC兼容模式无验收闸，不生效"', () => {
  const line = switchSummaryLine({ channel: 'code', tier: 'standard', lang: 'zh', contextFold: true, finalCheck: true }, 'zh');
  assert.ok(line.includes('PTC兼容模式无验收闸，不生效'), `PTC兼容模式必须灰显：${line}`);
  const std = switchSummaryLine({ channel: 'standard', tier: 'standard', lang: 'zh', contextFold: true, finalCheck: true }, 'zh');
  assert.ok(!std.includes('无验收闸'), '标准通道不得出现置灰说明');
});

// ================================================================ A3：持久化

test('A3-1. v3 文件读入 → 两开关默认 true（来源 default）；写回 schema=5 且保留未知字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-v060-cs-'));
  try {
    writeFileSync(controlFileOf(dir), JSON.stringify({
      schema: 3, channel: 'standard', tier: 'standard', lang: 'zh', limits: { maxSteps: 10 }, futureField: { keep: 1 },
    }), 'utf8');
    const resolved = resolveControlState({}, dir);
    assert.equal(resolved.contextFold, true, 'v3 缺字段 → 默认 true');
    assert.equal(resolved.finalCheck, true);
    assert.equal(resolved.contextFoldSource, 'default');
    assert.equal(resolved.finalCheckSource, 'default');

    writePersistedControl({ channel: 'standard', tier: 'standard', lang: 'zh', limits: { maxSteps: 10 }, contextFold: false, finalCheck: true }, dir);
    const raw = JSON.parse(readFileSync(controlFileOf(dir), 'utf8')) as Record<string, unknown>;
    assert.equal(raw['schema'], 5, 'schema 必须升到 5（0.6.0 正式版：contextRaw / preset）');
    assert.equal(raw['contextFold'], false);
    assert.equal(raw['finalCheck'], true);
    assert.deepEqual(raw['futureField'], { keep: 1 }, '未知字段必须原样保留（回滚兼容）');
    assert.deepEqual(raw['limits'], { maxSteps: 10 }, 'limits 不得被开关写回抹掉');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A3-2. 非法值丢弃并告警；来源优先级 config > env > file > default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-v060-cs2-'));
  const savedFold = process.env['STREAM_AGENT_CONTEXT_FOLD'];
  try {
    writeFileSync(controlFileOf(dir), JSON.stringify({ schema: 4, channel: 'standard', tier: 'standard', lang: 'zh', contextFold: 'yes-please', finalCheck: 0 }), 'utf8');
    const warnings: string[] = [];
    const fromBadFile = resolveControlState({}, dir, (m) => warnings.push(m));
    assert.equal(fromBadFile.contextFold, true, '非法 contextFold → 默认 true');
    assert.equal(fromBadFile.finalCheck, true, '数字 0 不是合法开关值 → 默认 true（只接受 boolean 与 on/off/1/0 字符串）');
    assert.ok(warnings.some((w) => w.includes('contextFold')), `非法值必须告警（实际：${warnings.join(' | ')}）`);

    process.env['STREAM_AGENT_CONTEXT_FOLD'] = 'off';
    const fromEnv = resolveControlState({}, dir);
    assert.equal(fromEnv.contextFold, false);
    assert.equal(fromEnv.contextFoldSource, 'env');

    const fromConfig = resolveControlState({ contextFold: true, finalCheck: false }, dir);
    assert.equal(fromConfig.contextFold, true, '装配 config 压过 env/file');
    assert.equal(fromConfig.contextFoldSource, 'config');
    assert.equal(fromConfig.finalCheck, false);
    assert.equal(fromConfig.finalCheckSource, 'config');
  } finally {
    if (savedFold === undefined) delete process.env['STREAM_AGENT_CONTEXT_FOLD'];
    else process.env['STREAM_AGENT_CONTEXT_FOLD'] = savedFold;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A3-3. 落盘往返：写 false 后重读仍 false（开关不被默认值覆盖）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-v060-cs3-'));
  try {
    writePersistedControl({ channel: 'standard', tier: 'standard', lang: 'zh', contextFold: false, finalCheck: false }, dir);
    const round = resolveControlState({}, dir);
    assert.equal(round.contextFold, false);
    assert.equal(round.contextFoldSource, 'file');
    assert.equal(round.finalCheck, false);
    assert.equal(round.finalCheckSource, 'file');
    assert.equal(readPersistedControl(dir).state.contextFold, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ================================================================ A4 / A5：同轮续跑与账本

const driftRecoverScript = (): ReadonlyArray<readonly Chunk[]> => [
  // R1：读文件（建立承诺基线；无 final → nudge）
  [text('读文件。\n'), text('<tf-read path="a.txt" id="r1"/>\n'), stop()],
  // R2：装配时探针篡改基线 → 前缀失败（未发送）→ 同轮续跑；本响应在续跑后的请求里被消费，
  // 且它自带 tf-final——恢复后一次请求即收尾。
  [text('两个文件都核对完了：示例文件，约定一致。\n'), text('<tf-final id="f1" summary="a.txt 已核对：示例文件，约定一致，无未完成项。"/>\n'), stop()],
];

test('A4-1. 三类前缀失败（stable / append / shrink）各 5 次：15/15 在同一 runTurn 内续跑并结束，请求不增加', async () => {
  const read = (f: string): readonly Chunk[] => [text(`读 ${f}。\n`), text(`<tf-read path="${f}" id="r-${f}"/>\n`), stop()];
  const finalTurn: readonly Chunk[] = [
    text('两个文件都核对完了：示例文件，约定一致。\n'),
    text('<tf-final id="f1" summary="a.txt 与 b.txt 已核对：示例文件，约定一致，无未完成项。"/>\n'),
    stop(),
  ];
  // 各成因的"何时可注入"不同：
  //  · stable/shrink：只要有承诺基线就能注入 → 两个响应即可（第二次即收尾）；
  //  · append：篡改点在"承诺前缀内的转正块"，必须先有一个已转正的块（第 3 个请求）。
  // 0.6.1：默认策略下三类违约都"接受继续"（0.4.3 探针 P2/P3 钉新契约）——本组钉的是
  // fail-closed 后自动续跑机制，故全部显式 prefixPolicy:'fail'（唯一的 fail-closed 面）。
  const cases: Array<{ kind: 'stable' | 'append' | 'shrink'; extra: Partial<StreamDriverConfig>; script: ReadonlyArray<readonly Chunk[]> }> = [
    { kind: 'stable', extra: { prefixPolicy: 'fail' }, script: [read('a.txt'), finalTurn] },
    { kind: 'append', extra: { prefixPolicy: 'fail' }, script: [read('a.txt'), read('b.txt'), finalTurn] },
    { kind: 'shrink', extra: { prefixPolicy: 'fail' }, script: [read('a.txt'), finalTurn] },
  ];
  for (const { kind, extra, script } of cases) {
    for (let n = 0; n < 5; n += 1) {
      const h = makeHarness(script, { faultPrefixDrift: { kind }, ...extra });
      try {
        h.driver.pushUserTask('读文件后收尾。');
        const reason = await h.driver.runTurn();
        assert.equal(reason.kind, 'completed', `${kind} #${n}: 必须同轮恢复并完成（实际 ${JSON.stringify(reason)}）`);
        assert.notEqual(reason.kind, 'awaiting:user', `${kind} #${n}: 不得要求用户再发消息（实际 kind=${reason.kind}）`);
        // 续跑 = 重建基线后重发同一批工作，不额外增加请求数（失败那次没有发出去）。
        assert.equal(h.prompts.length, script.length, `${kind} #${n}: 请求数必须等于剧本长度（实际 ${h.prompts.length}/${script.length}）`);
        assert.equal(h.faults('prefix-auto-continue').length, 1, `${kind} #${n}: 恰一次续跑（实际 ${h.faults('prefix-auto-continue').length}）`);
        assert.ok(h.prompts.join('\n').includes('[tf-stream:prefix-recovered]'), `${kind} #${n}: 模型必须看到恢复事实`);
        // A4：pending 意图必须整批标 unknown（只解除恢复锁，不重放工具）
        assert.equal(h.faults('intent-reconciled').length, 1, `${kind} #${n}: 续跑前必须完成最小对账`);
        assert.equal(h.faults('turn-blocked').length, 0, `${kind} #${n}: 不得收场 blocked`);
      } finally {
        h.cleanup();
      }
    }
  }
});

test('A4-2. 续跑耗尽：同一回合内 2 次后续跑仍失败 → 明确终态记录（零产出事实消息由 A4-3 单独覆盖）', async () => {
  const h = makeHarness(driftRecoverScript(), {
    faultPrefixDrift: { kind: 'stable', rearm: true },
    autoContinueOnPrefixFail: true,
    prefixPolicy: 'fail',
  });
  try {
    h.driver.pushUserTask('读文件后收尾。');
    const reason = await h.driver.runTurn();
    assert.equal(reason.kind, 'blocked', `耗尽后必须 blocked（实际 ${JSON.stringify(reason)}）`);
    assert.ok((reason.kind === 'blocked' ? reason.detail : '').includes('前缀校验失败'), 'blocked 文案必须可诊断');
    assert.equal(h.faults('prefix-auto-continue').length, MAX_PREFIX_AUTO_CONTINUES, `续跑次数必须等于上限 ${MAX_PREFIX_AUTO_CONTINUES}`);
    assert.equal(h.faults('prefix-auto-exhausted').length, 1, '耗尽必须有且仅有一条终态记录');
    assert.equal(h.faults('turn-blocked').length, 1, '收场事实必须落台账');
  } finally {
    h.cleanup();
  }
});

test('A5-1. 账本：每次续跑一条 prefix-auto-continue（turn/step/attempt/cause），耗尽一条 prefix-auto-exhausted', async () => {
  const h = makeHarness(driftRecoverScript(), { faultPrefixDrift: { kind: 'stable', rearm: true }, prefixPolicy: 'fail' });
  try {
    h.driver.pushUserTask('读文件后收尾。');
    await h.driver.runTurn();
    const continues = h.ledger.filter((r) => r.type === 'plugin:tf-agent/fault' && r.data['fault'] === 'prefix-auto-continue');
    assert.equal(continues.length, MAX_PREFIX_AUTO_CONTINUES, '续跑记录数与配置一致');
    for (const [i, rec] of continues.entries()) {
      assert.equal(rec.data['attempt'], i + 1, `attempt 必须从 1 单调递增（第 ${i + 1} 条）`);
      assert.equal(rec.data['maxAttempts'], MAX_PREFIX_AUTO_CONTINUES);
      assert.equal(rec.data['cause'], 'prefix-broken', 'cause 可复算');
      assert.equal(typeof rec.data['turn'], 'number');
      assert.equal(typeof rec.data['step'], 'number');
    }
    const exhausted = h.ledger.filter((r) => r.type === 'plugin:tf-agent/fault' && r.data['fault'] === 'prefix-auto-exhausted');
    assert.equal(exhausted.length, 1, '耗尽终态唯一');
    assert.equal(exhausted[0]!.data['attempts'], MAX_PREFIX_AUTO_CONTINUES, '耗尽记录带已用次数（可从账本复算）');
  } finally {
    h.cleanup();
  }
});

test('A5-2. 状态面：runtimeStatus 暴露本回合剩余次数（attempts/max/remaining/enabled）', async () => {
  const h = makeHarness(driftRecoverScript(), { faultPrefixDrift: { kind: 'stable' }, prefixPolicy: 'fail' });
  try {
    const before = h.driver.runtimeStatus();
    assert.equal(before.prefixAuto.max, MAX_PREFIX_AUTO_CONTINUES);
    assert.equal(before.prefixAuto.attempts, 0, '回合开始前为 0');
    assert.equal(before.prefixAuto.remaining, MAX_PREFIX_AUTO_CONTINUES);
    assert.equal(before.prefixAuto.enabled, true, '默认开启');
    h.driver.pushUserTask('读两个文件后收尾。');
    await h.driver.runTurn();
    const after = h.driver.runtimeStatus();
    assert.equal(after.prefixAuto.attempts, 1, '本回合用掉 1 次');
    assert.equal(after.prefixAuto.remaining, MAX_PREFIX_AUTO_CONTINUES - 1, '剩余量必须可见');
  } finally {
    h.cleanup();
  }
});

// ================================================================ A3-4：落盘不得丢开关（审查 P0 回归）

test('A3-4. 控制栏改通道/改上限后，control.json 里的两开关必须保持用户值（不被写回默认 true）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-v060-persist-'));
  try {
    // 用户显式关掉两个开关
    writePersistedControl({ channel: 'standard', tier: 'standard', lang: 'zh', contextFold: false, finalCheck: false }, dir);
    // 控制栏 entry：只有 get/provide/on/effect 的最小上下文（不触达任何可选服务）
    const ctx = { get: () => undefined, provide: () => {}, on: () => {}, effect: () => {} };
    const service = applyControlBar(ctx as never, { announce: false, stateDir: dir });
    service.setChannel('code'); // 触发一次落盘
    const raw = JSON.parse(readFileSync(controlFileOf(dir), 'utf8')) as Record<string, unknown>;
    assert.equal(raw['contextFold'], false, '改通道不得把 contextFold 写回 true');
    assert.equal(raw['finalCheck'], false, '改通道不得把 finalCheck 写回 true');
    assert.equal(raw['channel'], 'code', '通道本身要写对');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A4-3. 零产出回合遇前缀失败：同轮续跑耗尽后仍写一条"没有产生交付"的事实消息（用户侧不空白）', async () => {
  // 剧本：第一个请求就失败（无任何 ok 命令）→ 续跑 2 次仍失败 → 收场 blocked
  // 0.6.1：默认策略已改为"接受继续"，本用例钉 fail-closed 面 → 显式 prefixPolicy='fail'。
  const h = makeHarness(
    [[text('开始。\n'), stop()]],
    { faultPrefixDrift: { kind: 'stable', rearm: true }, prefixPolicy: 'fail' },
  );
  try {
    h.driver.pushUserTask('什么都不做的任务。');
    const reason = await h.driver.runTurn();
    assert.equal(reason.kind, 'blocked', JSON.stringify(reason));
    assert.equal(h.finals.length, 1, '零产出失败也必须写一条事实消息');
    assert.ok(h.finals[0]!.includes('没有产生交付'), `事实消息必须如实说明零产出（实际：${h.finals[0]!.slice(0, 120)}）`);
    assert.ok(h.finals[0]!.includes('前缀'), '事实消息必须指出失败发生在请求发送前');
  } finally {
    h.cleanup();
  }
});
