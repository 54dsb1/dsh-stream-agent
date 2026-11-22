// test/v040-closeout.test.ts —— v0.4.0 回合收束改造 + 读注入预算（真机取证 2026-11-21）
//
// 来源：0.3.3（stable 线）的同源修复。0.4.0 自 0.3.1 分叉，0.3.2/0.3.3 的收束与缓存修复
// 未回流，真机表现与 0.3.x 同症状——本文件把 0.3.3 的十个探针原样搬进 0.4 能力面，
// 作为"回流完成"的验收证据（探针不改写：断言对着线格式请求/parser 事件/交付文本）。
//
// 真机现象（ZCode 桌面端，DeepSeek-V4.1-Flash）：13 步的真实任务（读文件 → 改文件 → 跑检查）
// 在第 12 步被 `#reentryCount >= maxReentries` hard blocked，**收束时没有任何兜底交付**——
// 界面于是停在最后一句 prose 上，用户看到的就是"输出截断"（session-6bb805db / 27876fd9 /
// 7fbfef8f / d6cd0759 四例同形态）。同时一次读五个文件把所有全文塞进同一请求（step 3 单请求
// 5916 个未缓存 token），把前缀缓存整块打掉。
//
// 本文件覆盖四组：
//   P1–P3（parser）：命令正文闭合允许空白/属性；DSML 畸形开标签不得吞掉正文
//                    （`lastIndexOf('>')` 的回归线）。
//   C1–C4（loop）  ：生产性重入不计停滞预算；撞墙先收束（closeout 注入）；收束用尽写
//                    **明确标注未完成的兜底交付**；零产出回合不伪造交付。
//   R1–R3（loop）  ：单请求 tf-read 正文预算（超出转预览 + 句柄）；预算 0 回退；
//                    durable 块前置（缓存前缀可延续）。
//
// 断言对着线格式请求 / parser 事件 / assistant 交付文本，不看内部字段（与 v032 同纪律）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver } from '../src/entry/loop.ts';
import type { DriverPorts, StreamChunkLike, StreamDriverConfig, ToolBatchInputLike, ToolBatchResultLike, TurnEventWriter } from '../src/entry/loop.ts';
import { TfStreamParser } from '../src/kernel/parser.ts';
import type { ParserEvent, TfCommand } from '../src/kernel/parser.ts';

// ---------------------------------------------------------------- 解析器设施

function commandsOf(events: ParserEvent[]): TfCommand[] {
  return events.filter((e) => e.type === 'command').map((e) => (e as { command: TfCommand }).command);
}

function feedAll(parser: TfStreamParser, deltas: readonly string[]): ParserEvent[] {
  const out: ParserEvent[] = [];
  for (const delta of deltas) out.push(...parser.feed(delta));
  out.push(...parser.end());
  return out;
}

// ---------------------------------------------------------------- P 系列：正文闭合

test('P1. 闭合标签带尾随空白（</tf-write >）：正文照常取全，不再判 truncated 整段丢弃', () => {
  const events = feedAll(new TfStreamParser(), ['<tf-write path="a.py" id="w1">\nprint(1)\n</tf-write >\n']);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1, `正文闭合带空白也必须成命令，实际事件：${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(cmds[0]!.name, 'tf-write');
  assert.equal(cmds[0]!.body?.trim(), 'print(1)', '正文不得因闭合标签的空白而丢');
  assert.equal(events.filter((e) => e.type === 'truncated').length, 0, '不得判 truncated');
});

test('P2. 闭合标签带属性（</tf-write path="x">）：按名字匹配取端界，正文完整', () => {
  const events = feedAll(new TfStreamParser(), ['<tf-write path="a.py" id="w1">HELLO</tf-write path="x">']);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0]!.body, 'HELLO');
  assert.equal(events.filter((e) => e.type === 'truncated').length, 0);
});

test('P3. 真机回归：DSML 畸形开标签（name 里塞属性、正文含 > ）不得吞掉命令正文', () => {
  // 真机 session-27876fd9 step 7 的形态：模型把 attrs 全塞进 name，且正文里出现 `>`。
  // 旧 scanHeaderClose 退化通道取 buf.lastIndexOf('>')，落在正文的 `>` 上——整个脚本
  // 被当标签吃掉，tf-write 正文变空（模型白烧步数）。
  const events = feedAll(new TfStreamParser(), [
    '<｜｜DSML｜｜ invoke name="tf-write path="a.py" id="w1">\n',
    'if a > b: pass\n',
    '</tf-write>\n',
  ]);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1, `畸形 DSML 开标签也必须抢救出命令，实际：${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(cmds[0]!.name, 'tf-write');
  assert.equal(cmds[0]!.attrs['path'], 'a.py');
  assert.equal(cmds[0]!.body, 'if a > b: pass', '正文必须完整（旧实现被 lastIndexOf 吞掉）');
});

// ---------------------------------------------------------------- 驱动器设施

type ChunkGen = AsyncGenerator<StreamChunkLike, void, undefined>;

async function* scriptedStream(chunks: readonly StreamChunkLike[]): ChunkGen {
  for (const chunk of chunks) yield chunk;
}

function textDelta(text: string, index = 1): StreamChunkLike {
  return { type: 'text-delta', index, text } as StreamChunkLike;
}

function finish(kind: 'stop' | 'max-tokens'): StreamChunkLike {
  return { type: 'finish', reason: { kind } } as StreamChunkLike;
}

interface DriverHarness {
  driver: SingleStreamDriver;
  requests: string[][];
  /** 落进会话的 assistant 最终消息（events.finalAnswer 通道）。 */
  finalAnswers: string[];
  sandboxDir: string;
  cleanup: () => void;
}

/** 沙箱执行器：写 bad/ 前缀一律失败（制造"失败重入但不推进"的形态），其余照常。 */
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
      const filePath = String(args['file_path'] ?? '');
      if (call.name === 'write') {
        if (filePath.startsWith('bad/')) {
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: `EACCES: ${filePath}` }], isError: true } });
          continue;
        }
        const abs = join(sandboxDir, filePath);
        mkdirSync(join(abs, '..'), { recursive: true });
        writeFileSync(abs, String(args['content'] ?? ''), 'utf8');
        results.push({ callId: call.id, result: { content: [{ type: 'text', text: `written ${filePath}` }], isError: false } });
      } else if (call.name === 'read') {
        try {
          const text = String(args['file_path'] ?? '');
          const abs = join(sandboxDir, text);
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: readFileSync(abs, 'utf8') }], isError: false } });
        } catch (error) {
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: `ENOENT: ${String(error)}` }], isError: true } });
        }
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
): DriverHarness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v033-closeout-'));
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
  const driver = new SingleStreamDriver(ports, { provider: 'mock', model: 'mock-v033-closeout', ...config });
  driver.pushUserTask(task);
  return { driver, requests, finalAnswers, sandboxDir, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

function promptOf(harness: DriverHarness, index: number): string {
  return (harness.requests[index] ?? []).join('\n');
}

function faultsOf(harness: DriverHarness): string[] {
  return harness.driver.snapshot().records
    .filter((r) => r.kind === 'fault')
    .map((r) => String((r as { fault?: string }).fault ?? ''));
}

// ---------------------------------------------------------------- C 系列：收束

test('C1. 生产性重入不再被 maxReentries 硬杀：每步都有新产出 → 干到 final 为止', async () => {
  const harness = makeHarness([
    [textDelta('<tf-write path="a.md" id="w1">A</tf-write>'), finish('stop')],
    [textDelta('<tf-write path="b.md" id="w2">B</tf-write>'), finish('stop')],
    [textDelta('<tf-write path="c.md" id="w3">C</tf-write>'), finish('stop')],
    [textDelta('<tf-final id="f1" summary="三个文件都写完了：a.md / b.md / c.md"/>'), finish('stop')],
  ], '生产性重入演练', { maxReentries: 2, maxRequests: 8 });
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', `生产性重入不得被砍：${JSON.stringify(reason)}`);
    // 旧实现（#reentryCount >= maxReentries=2）在第 3 个请求就 blocked
    assert.equal(harness.requests.length, 4, `应干到第 4 个请求（final），实际 ${harness.requests.length}`);
    assert.ok(!faultsOf(harness).includes('turn-blocked'), '不得出现 turn-blocked');
    assert.ok(!faultsOf(harness).includes('fallback-final'), '真 final 收敛时不该走兜底交付');
  } finally {
    harness.cleanup();
  }
});

test('C2. 停滞到顶 → 先注入收束指令（closeout），模型照做即正常收敛', async () => {
  const harness = makeHarness([
    // 有产出：写成功一个 + 写失败一个（失败即重入事由）
    [textDelta('<tf-write path="a.md" id="w1">A</tf-write>'), textDelta('<tf-write path="bad/x" id="w2">X</tf-write>'), finish('stop')],
    [textDelta('<tf-write path="bad/y" id="w3">Y</tf-write>'), finish('stop')],
    [textDelta('<tf-write path="bad/z" id="w4">Z</tf-write>'), finish('stop')],
    [textDelta('<tf-write path="bad/w" id="w5">W</tf-write>'), finish('stop')],
    [textDelta('<tf-final id="f9" summary="已写入 a.md；三条 bad/ 路径被沙箱拒绝，未验证"/>'), finish('stop')],
  ], '收束指令演练', { maxReentries: 2, closeOutRequests: 1, maxRequests: 8 });
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed');
    // 1 首请求 + 2 次停滞重入 + 1 收束请求 + 1 final = 5
    assert.equal(harness.requests.length, 5, `停滞 → 收束一次 → final，共 5 个请求，实际 ${harness.requests.length}`);
    const closeOutPrompt = promptOf(harness, 4);
    assert.ok(closeOutPrompt.includes('[tf-stream:closeout attempt=1'), '收束请求必须带 closeout 指令');
    assert.ok(closeOutPrompt.includes('立即用 tf-final 交付'), '收束指令要求立刻交付');
    assert.ok(faultsOf(harness).includes('closeout-nudge'), '收束注入要落台账');
    assert.equal(harness.finalAnswers.length, 1);
    assert.ok(harness.finalAnswers[0]!.includes('已写入 a.md'), '交付的是模型自己的 final');
  } finally {
    harness.cleanup();
  }
});

test('C3. 收束预算用尽仍无 final → blocked + 兜底交付（明确标注未完成，不是伪造结论）', async () => {
  const harness = makeHarness([
    [textDelta('<tf-write path="a.md" id="w1">A</tf-write>'), textDelta('<tf-write path="bad/x" id="w2">X</tf-write>'), finish('stop')],
    [textDelta('<tf-write path="bad/y" id="w3">Y</tf-write>'), finish('stop')],
    [textDelta('<tf-write path="bad/z" id="w4">Z</tf-write>'), finish('stop')],
    [textDelta('<tf-write path="bad/w" id="w5">W</tf-write>'), finish('stop')],
  ], '兜底交付演练', { maxReentries: 2, closeOutRequests: 1, maxRequests: 8 });
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'blocked');
    assert.ok(reason.kind === 'blocked' && reason.detail.includes('连续 2 次重入无新增产出'), `detail 应说明停滞：${JSON.stringify(reason)}`);
    // 用户侧"截断"的最后一道闸：必须有一条 assistant 交付说明落进会话
    assert.equal(harness.finalAnswers.length, 1, '收束必须有且只有一条兜底交付');
    const fallback = harness.finalAnswers[0]!;
    assert.ok(fallback.includes('[未完成交付]'), '兜底交付必须自报未完成（不得伪装成结论）');
    assert.ok(fallback.includes('a.md'), '兜底交付要列出已完成的台账事实');
    assert.ok(fallback.includes('bad/z') || fallback.includes('未完成'), '兜底交付要列未完成项');
    assert.ok(faultsOf(harness).includes('fallback-final'), '兜底交付要落台账');
  } finally {
    harness.cleanup();
  }
});

test('C4. 零产出回合（纯 prose、无任何 ok 命令）→ blocked 且不伪造交付', async () => {
  const harness = makeHarness([
    [textDelta('我就是不输出 tf-final。\n'), finish('stop')],
    [textDelta('仍然不输出。\n'), finish('stop')],
    [textDelta('第三次也不输出。\n'), finish('stop')],
  ], '零产出演练');
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'blocked');
    assert.equal(harness.requests.length, 2, 'nudge 一次后仍无 final → blocked（不因收束期再多烧请求）');
    assert.equal(harness.finalAnswers.length, 0, '没有任何事实可交付时不得写兜底交付');
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------- R 系列：读注入预算

const BIG1 = `B1-START\n${'x'.repeat(2900)}\nB1-END`;
const BIG2 = `B2-START\n${'y'.repeat(2900)}\nB2-END`;

function seedBigFiles(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'big1.txt'), BIG1, 'utf8');
  writeFileSync(join(dir, 'big2.txt'), BIG2, 'utf8');
}

test('R1. 单请求读注入预算：首份给全文、超预算的第二份转"预览 + 句柄"', async () => {
  const harness = makeHarness([
    [textDelta('<tf-read path="big1.txt" id="r1"/>'), textDelta('<tf-read path="big2.txt" id="r2"/>'), finish('stop')],
    [textDelta('<tf-final id="f1" summary="两个文件都看了一眼"/>'), finish('stop')],
  ], '读预算演练', { readFeedbackBudgetPerRequest: 4000 });
  try {
    seedBigFiles(harness.sandboxDir);
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed');
    const p2 = promptOf(harness, 1);
    assert.ok(p2.includes('B1-END'), '预算内的第一份必须是全文');
    assert.ok(p2.includes('B2-START'), '超预算的第二份仍要有头部预览');
    assert.ok(!p2.includes('B2-END'), '超预算的第二份不给全文（下一请求再按需 peek）');
    assert.ok(p2.includes('本请求读注入预算已满'), '降级必须如实说明原因');
    assert.ok(p2.includes('tf-peek handle='), '必须给取回路径');
  } finally {
    harness.cleanup();
  }
});

test('R2. readFeedbackBudgetPerRequest=0 关闭预算（回退点）：两份都全文，行为等价 v0.3.2', async () => {
  const harness = makeHarness([
    [textDelta('<tf-read path="big1.txt" id="r1"/>'), textDelta('<tf-read path="big2.txt" id="r2"/>'), finish('stop')],
    [textDelta('<tf-final id="f1" summary="两个文件都读完了"/>'), finish('stop')],
  ], '读预算关闭演练', { readFeedbackBudgetPerRequest: 0 });
  try {
    seedBigFiles(harness.sandboxDir);
    await harness.driver.runTurn();
    const p2 = promptOf(harness, 1);
    assert.ok(p2.includes('B1-END'), '关闭预算后第一份全文');
    assert.ok(p2.includes('B2-END'), '关闭预算后第二份也是全文');
    assert.ok(!p2.includes('本请求读注入预算已满'));
  } finally {
    harness.cleanup();
  }
});

test('R3. 尾块排序：durable 事实块前置、瞬态指令后置（下一请求的前缀可覆盖事实块）', async () => {
  const harness = makeHarness([
    [
      textDelta('<tf-read path="note.txt" id="r1"/>'),
      textDelta('<tf-write path="bad/x" id="w1">X</tf-write>'),
      finish('stop'),
    ],
    [textDelta('<tf-final id="f1" summary="读过 note.txt；bad/x 写失败"/>'), finish('stop')],
  ], '尾块排序演练');
  try {
    mkdirSync(harness.sandboxDir, { recursive: true });
    writeFileSync(join(harness.sandboxDir, 'note.txt'), 'NOTE-CONTENT', 'utf8');
    await harness.driver.runTurn();
    const p2 = promptOf(harness, 1);
    const obsAt = p2.indexOf('[tf-stream:observation handle=');
    const errAt = p2.indexOf('[tf-stream:error id=');
    assert.ok(obsAt !== -1 && errAt !== -1, '同一请求里两类块都在');
    assert.ok(obsAt < errAt, 'durable 观测块必须排在瞬态 error 块之前（否则转正后前缀在 error 处分叉）');
  } finally {
    harness.cleanup();
  }
});
