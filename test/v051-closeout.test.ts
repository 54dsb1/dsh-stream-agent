// test/v051-closeout.test.ts —— 0.5.1 升级清单 M1/M2 的可验证验收
//
// 覆盖（编号对齐 0.5.1-beta 清单）：
//   1.1 回合收尾：无验收项 + 有产出时流末正文即交付（同轮、0 额外请求）；
//       awaiting：tf-ask 返回 pending → awaiting，0 nudge / 0 额外请求；
//       requireFinal: true = 0.4.x 回退开关（缺 final 必 nudge）。
//   1.3 验收证据：证据绑定"命令回执 + 验收项文本哈希"——改文本即失效；
//       accepts 指向不存在的验收项记台账；失败回执不产生验证。
//   2.2 回灌方向：selfReadFeedback 默认 full（写后读回灌全文）；feedbackBytes 三桶可复算。
//
// 断言对着 wire 请求 / 台账记录 / 交付文本（与 v032/v040 同纪律：不看私有字段）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver } from '../src/entry/loop.ts';
import type { DriverPorts, StreamChunkLike, StreamDriverConfig, ToolBatchInputLike, ToolBatchResultLike, TurnEventWriter } from '../src/entry/loop.ts';

type ChunkGen = AsyncGenerator<StreamChunkLike, void, undefined>;

async function* scriptedStream(chunks: readonly StreamChunkLike[]): ChunkGen {
  for (const chunk of chunks) yield chunk;
}

function textDelta(text: string, index = 1): StreamChunkLike {
  return { type: 'text-delta', index, text } as StreamChunkLike;
}

function reasoningDelta(text: string, index = 0): StreamChunkLike {
  return { type: 'reasoning-delta', index, text } as StreamChunkLike;
}

function finish(kind: 'stop' | 'max-tokens' = 'stop'): StreamChunkLike {
  return { type: 'finish', reason: { kind } } as StreamChunkLike;
}

interface Harness {
  driver: SingleStreamDriver;
  requests: string[][];
  finalAnswers: string[];
  sandboxDir: string;
  cleanup: () => void;
}

/** 沙箱执行器：write/read 落临时目录；ask_user_question 返回宿主 pending 形态。 */
function createExecutor(sandboxDir: string) {
  return async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => {
    const results: ToolBatchResultLike['results'] = [];
    for (const call of input.calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments) as Record<string, unknown>;
      } catch {
        results.push({ callId: call.id, result: { content: [{ type: 'text', text: 'bad json' }], isError: true } });
        continue;
      }
      if (call.name === 'write') {
        const filePath = String(args['file_path'] ?? '');
        const abs = join(sandboxDir, filePath);
        mkdirSync(join(abs, '..'), { recursive: true });
        writeFileSync(abs, String(args['content'] ?? ''), 'utf8');
        results.push({ callId: call.id, result: { content: [{ type: 'text', text: `written ${filePath}` }], isError: false } });
      } else if (call.name === 'read') {
        try {
          const abs = join(sandboxDir, String(args['file_path'] ?? ''));
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: readFileSync(abs, 'utf8') }], isError: false } });
        } catch (error) {
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: `ENOENT: ${String(error)}` }], isError: true } });
        }
      } else if (call.name === 'ask_user_question') {
        // 宿主 dsh-tool-ask-user 的 timed ask：等待超时 → {pending:true,...}
        results.push({
          callId: call.id,
          result: { content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: call.id, message: 'no answer batch yet' }) }], isError: false },
        });
      } else {
        results.push({ callId: call.id, result: { content: [{ type: 'text', text: `echo:${String(args['command'] ?? '')}` }], isError: false } });
      }
    }
    return { results, additionalContexts: [], concluded: false };
  };
}

function makeHarness(
  responses: ReadonlyArray<readonly StreamChunkLike[]>,
  task: string,
  config?: Partial<StreamDriverConfig>,
): Harness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v051-'));
  const requests: string[][] = [];
  const finalAnswers: string[] = [];
  let call = 0;
  const events: TurnEventWriter = {
    turnStart: () => {},
    assistantMessage: () => undefined,
    stepStart: () => {},
    stepEnd: () => {},
    turnEnd: () => {},
    toolLog: () => undefined,
    finalAnswer: (_turn: number, _step: number, text: string) => { finalAnswers.push(text); },
  };
  const ports: DriverPorts = {
    stream: (options) => {
      requests.push(options.messages.map((m) => m.content.map((b) => b.text).join('')));
      const chunks = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return { [Symbol.asyncIterator]: () => scriptedStream(chunks) } as AsyncIterable<StreamChunkLike>;
    },
    executeTools: createExecutor(sandboxDir),
    events,
  };
  const driver = new SingleStreamDriver(ports, { provider: 'mock', model: 'mock-v051', ...config });
  driver.pushUserTask(task);
  return { driver, requests, finalAnswers, sandboxDir, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

function faultsOf(harness: Harness): string[] {
  return harness.driver.snapshot().records
    .filter((r) => r.kind === 'fault')
    .map((r) => String((r as { fault?: string }).fault ?? ''));
}

// ---------------------------------------------------------------------------
// 1.1 收尾：同轮交付 / awaiting / 回退开关
// ---------------------------------------------------------------------------

test('V1.1-1 纯写三文件 + 流末正文（无 tf-final）→ 同轮交付，1 个请求，0 nudge', async () => {
  const harness = makeHarness([
    [textDelta(
      '<tf-write path="a.md" id="w1">A</tf-write>'
      + '<tf-write path="b.md" id="w2">B</tf-write>'
      + '<tf-write path="c.md" id="w3">C</tf-write>'
      + '\n三个文件都写完了：a.md / b.md / c.md。\n',
    ), finish()],
  ], '写三个文件。');
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', `无验收项时流末正文即交付：${JSON.stringify(reason)}`);
    assert.equal(harness.requests.length, 1, `同轮交付不得多烧请求，实际 ${harness.requests.length}`);
    assert.ok(!faultsOf(harness).includes('missing-final-nudge'), '不得再出现"必 nudge"');
    assert.equal(harness.finalAnswers.length, 1, '必须有一条交付');
    assert.ok(harness.finalAnswers[0]!.includes('三个文件都写完了'), `交付 = 流末正文，实际：${harness.finalAnswers[0]}`);
    for (const f of ['a.md', 'b.md', 'c.md']) assert.ok(readFileSync(join(harness.sandboxDir, f), 'utf8').length > 0, `${f} 已落盘`);
  } finally {
    harness.cleanup();
  }
});

test('V1.1-2 回退开关 requireFinal: true → 0.4.x 语义（缺 final 必 nudge）', async () => {
  const harness = makeHarness([
    [textDelta('<tf-write path="a.md" id="w1">A</tf-write>\n写完了。\n'), finish()],
    [textDelta('仍然不输出 tf-final。\n'), finish()],
  ], '写一个文件。', { requireFinal: true });
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'blocked', `回退点应回到 0.4.x（提示后仍不收尾 → blocked）：${JSON.stringify(reason)}`);
    assert.ok(harness.requests.length >= 2, `缺 final 必须 nudge（至少 2 请求），实际 ${harness.requests.length}`);
    assert.ok(faultsOf(harness).includes('missing-final-nudge'), '回退点必须保留 missing-final-nudge');
    assert.ok(harness.requests[1]!.join('\n').includes('[tf-stream:nudge]'), '第二请求应带 nudge 注入');
  } finally {
    harness.cleanup();
  }
});

test('V1.1-3 tf-ask 返回 pending → awaiting 收束，0 nudge / 0 额外请求', async () => {
  const harness = makeHarness([
    [textDelta('<tf-ask q="选 A 还是 B？" header="选择" options="A,B" id="q1"/>\n'), finish()],
  ], '需要用户决策的任务。');
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'awaiting:user', `提问即收束（不是 blocked/completed）：${JSON.stringify(reason)}`);
    assert.ok(reason.kind === 'awaiting:user' && (reason.detail ?? '').includes('q1'), 'awaiting:user 文案要指向提问 id');
    assert.equal(harness.requests.length, 1, `awaiting 回合 0 额外请求，实际 ${harness.requests.length}`);
    assert.ok(!faultsOf(harness).includes('missing-final-nudge'), 'awaiting 回合 0 nudge');
    assert.equal(harness.finalAnswers.length, 0, '等待用户回答时不得伪造最终交付');
  } finally {
    harness.cleanup();
  }
});

test('V1.1-4 有未验证验收项时不走"正文即交付"：仍按验收闸提示', async () => {
  const harness = makeHarness([
    [textDelta('<tf-plan id="p1">- [a1] a.md 已写入</tf-plan><tf-write path="a.md" id="w1">A</tf-write>\n写好了。\n'), finish()],
    [textDelta('<tf-write path="a.md" id="w2" accepts="a1">A2</tf-write><tf-final id="f1" summary="a.md 已写入（a1 由 w2 回执验证）"/>\n'), finish()],
  ], '带验收项的任务。');
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', JSON.stringify(reason));
    assert.ok(harness.requests.length >= 2, `验收项存在 → 不接受"流末正文即交付"，实际 ${harness.requests.length}`);
    // 关键不变量：交付的是模型的 tf-final summary，不是第一段"写好了。"（正文未被当成交付）
    assert.ok(harness.finalAnswers.length >= 1);
    assert.ok(harness.finalAnswers[0]!.includes('a1 由 w2 回执验证'), `交付必须是 final summary：${harness.finalAnswers[0]}`);
    assert.ok(!harness.finalAnswers[0]!.includes('写好了'), '未验证验收项时不得把流末正文当交付');
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 1.3 验收证据绑定
// ---------------------------------------------------------------------------

test('V1.3-1 计划修订改了验收项文本 → 旧证据作废（回到未验证，final 被判过早）', async () => {
  const harness = makeHarness([
    // 回合 1 / 请求 1：声明计划 + 用真实回执验证 a1 + final
    [textDelta('<tf-plan id="p1">- [a1] a.md 已写入</tf-plan><tf-write path="a.md" id="w1" accepts="a1">A</tf-write><tf-final id="f1" summary="a.md 已写入"/>\n'), finish()],
    // 回合 1 / 请求 2（计划块注入带来的重入）：final 仍然有效 → 收敛
    [textDelta('<tf-final id="f2" summary="a.md 已写入（a1 已由 w1 回执验证）"/>\n'), finish()],
    // 回合 2 / 请求 3：同名 a1 但描述改了（改需求）→ 0.5.1 起旧回执不再证明新要求
    [textDelta('<tf-plan id="p2">- [a1] a.md 已写入且包含三行内容</tf-plan><tf-final id="f3" summary="已按新口径完成"/>\n'), finish()],
    // 回合 2 / 请求 4：再发 final 仍被拒（不重复注入 → blocked）
    [textDelta('<tf-final id="f4" summary="已按新口径完成"/>\n'), finish()],
  ], '先按旧口径完成，再改口径。');
  try {
    const first = await harness.driver.runTurn();
    assert.equal(first.kind, 'completed', `首回合应完成：${JSON.stringify(first)}`);
    const second = await harness.driver.runTurn();
    const faults = faultsOf(harness);
    assert.ok(faults.includes('plan-evidence-invalidated'), `改文本必须使旧证据失效：${JSON.stringify(faults)}`);
    assert.ok(faults.includes('premature-final'), '失效后 final 必须被判过早（不得继承旧回执）');
    assert.equal(second.kind, 'blocked', `屡教不改的 premature final → blocked：${JSON.stringify(second)}`);
  } finally {
    harness.cleanup();
  }
});

test('V1.3-2 accepts 指向不存在的验收项 → 记台账、不产生验证', async () => {
  const harness = makeHarness([
    [textDelta('<tf-plan id="p1">- [a1] a.md 已写入</tf-plan><tf-write path="a.md" id="w1" accepts="aZ">A</tf-write><tf-final id="f1" summary="a.md 已写入"/>\n'), finish()],
    [textDelta('<tf-final id="f2" summary="a.md 已写入"/>\n'), finish()],
  ], '错误验收 id 的防伪造探针。');
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'blocked', `伪造的 accepts 不得通过验收：${JSON.stringify(reason)}`);
    const faults = faultsOf(harness);
    assert.ok(faults.includes('plan-accept-unknown'), `未知验收 id 必须记台账：${JSON.stringify(faults)}`);
    assert.ok(faults.includes('premature-final'), 'a1 未验证 → final 必须被拒（伪造不通过）');
    const accepts = harness.driver.snapshot().records.filter((r) => r.kind === 'plan-accept');
    assert.equal(accepts.length, 0, `不得产生任何 plan-accept 记录：${JSON.stringify(accepts)}`);
  } finally {
    harness.cleanup();
  }
});

test('V1.3-3 失败回执不产生验证：失败命令的 accepts 不改变验收项', async () => {
  const harness = makeHarness([
    [textDelta('<tf-plan id="p1">- [a1] x.md 已写入</tf-plan><tf-write path="x.md" id="w1" accepts="a1">X</tf-write><tf-final id="f1" summary="x.md 已写入"/>\n'), finish()],
    [textDelta('<tf-final id="f2" summary="x.md 已写入"/>\n'), finish()],
  ], '失败回执探针。');
  try {
    // 让写失败：沙箱目录里放一个同名目录，writeFileSync 抛 EISDIR
    mkdirSync(join(harness.sandboxDir, 'x.md'), { recursive: true });
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'blocked', `失败写不得验证 a1：${JSON.stringify(reason)}`);
    const faults = faultsOf(harness);
    assert.ok(faults.includes('premature-final'), '失败写 → a1 仍 open → final 被判过早');
    const accepts = harness.driver.snapshot().records.filter((r) => r.kind === 'plan-accept');
    assert.equal(accepts.length, 0, '失败回执不得产生 plan-accept 记录');
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2.2 回灌方向（默认 full）与 feedbackBytes 三桶
// ---------------------------------------------------------------------------

test('V2.2-1 默认 selfReadFeedback=full：写后读回灌全文（不是 receipt），三桶字节可复算', async () => {
  const harness = makeHarness([
    [textDelta('<tf-write path="a.md" id="w1">UNIQUE-BODY-42</tf-write><tf-read path="a.md" id="r1"/><tf-final id="f1" summary="a.md 内容为 UNIQUE-BODY-42"/>\n'), finish()],
  ], '写后读回验。');
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', JSON.stringify(reason));
    assert.equal(harness.requests.length, 2, `read 的 full 观测应带来一次重入，实际 ${harness.requests.length}`);
    const req2 = harness.requests[1]!.join('\n');
    assert.ok(req2.includes('UNIQUE-BODY-42'), '默认（full）必须回灌自写文件全文');
    assert.ok(!req2.includes('[tf-stream:receipt handle='), '默认不再是 receipt 形态');
    const requests = harness.driver.snapshot().records.filter((r) => r.kind === 'request') as Array<{ feedbackBytes?: { full: number; dedup: number; handle: number } }>;
    assert.ok(requests.length >= 2);
    assert.ok((requests[1]!.feedbackBytes?.full ?? 0) > 0, '第二请求应记 full 字节');
    assert.equal(requests[1]!.feedbackBytes?.dedup, 0, '首次读不是去重形态');
    assert.equal(requests[1]!.feedbackBytes?.handle, 0, '首次读不是句柄形态');
  } finally {
    harness.cleanup();
  }
});

test('V2.2-2 重复取回同一区间 → dedup 形态（[unchanged]），full 不重复计费', async () => {
  const harness = makeHarness([
    [textDelta('<tf-write path="a.md" id="w1">SAME-1</tf-write><tf-read path="a.md" id="r1"/>\n'), finish()],
    // 显式取回一段——该区间已随 read 观测投递过 → span 账本命中 → [unchanged] 一行
    [textDelta('<tf-peek handle="obs:read:r1@v2" from_line="1" to_line="1" id="k1"/>\n'), finish()],
    [textDelta('<tf-final id="f1" summary="a.md 内容为 SAME-1"/>\n'), finish()],
  ], '重复取回。');
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', JSON.stringify(reason));
    const requests = harness.driver.snapshot().records.filter((r) => r.kind === 'request') as Array<{ feedbackBytes?: { full: number; dedup: number; handle: number } }>;
    const withDedup = requests.filter((r) => (r.feedbackBytes?.dedup ?? 0) > 0);
    assert.ok(withDedup.length > 0, `重复取回应记 dedup 字节：${JSON.stringify(requests.map((r) => r.feedbackBytes))}`);
    const anyPrompt = harness.requests.map((r) => r.join('\n')).join('\n=====\n');
    assert.ok(anyPrompt.includes('[unchanged]'), '重复取回注入一行 [unchanged]');
  } finally {
    harness.cleanup();
  }
});
