// test/v041-closeout.test.ts —— v0.4.1 回合收束改造 + 缓存前缀契约（真机取证 2026-11-21）
//
// 与 0.3.3 的 `test/v033-closeout.test.ts` 同源：0.4.x 线（ToolSurface/tf-call 能力面）
// 独立演进，0.3.2/0.3.3 的截断修复没有回流，于是同样两处结构性根因仍在：
//   ① `#reentryCount >= maxReentries` 把**生产性重入**当打转，13 步真实任务在第 12 步被
//      hard blocked，且收束时没有任何兜底交付 → 桌面端只剩最后一句 prose（用户侧"截断"）。
//   ② 追加区只有 system + 任务 + 句柄目录行：模型第 2 个请求起看不到自己上一步干了什么，
//      只能重读重猜；同时一次读多文件把几万字全塞进同一请求，前缀缓存被整块打掉。
//
// 本文件覆盖四组：
//   P1–P4（parser）：正文闭合容许空白/属性；DSML 畸形开标签（含 name 值塞属性）不吞正文。
//   D1–D2（驱动器）：本步正文 + 命令事实落追加区（历史不蒸发）、易变尾转正（前缀单调）。
//   C1–C4（收束） ：生产性重入不计停滞预算；撞墙先收束；收束用尽写"未完成交付"；零产出不伪造。
//   R1–R3（缓存） ：单请求读注入预算（超出转预览 + 句柄）、预算 0 回退、durable 块前置。
//
// 断言对着线格式请求 / parser 事件 / assistant 交付文本，不看内部字段。

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

test('P1. 闭合标签带尾随空白（</tf-write >）：正文照常取全，不判 truncated 整段丢弃', () => {
  const events = feedAll(new TfStreamParser(), ['<tf-write path="a.py" id="w1">\nprint(1)\n</tf-write >\n']);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1, `正文闭合带空白也必须成命令，实际事件：${JSON.stringify(events.map((e) => e.type))}`);
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

test('P3. 真机回归：DSML 畸形开标签（name 里塞属性）不得吞掉命令正文', () => {
  // session-27876fd9 step 7 的形态：attrs 全塞进 name，正文含 `>`。
  const events = feedAll(new TfStreamParser(), [
    '<｜｜DSML｜｜ invoke name="tf-write path="a.py" id="w1">\n',
    'if a > b: pass\n',
    '</tf-write>\n',
  ]);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1, `畸形 DSML 开标签也必须抢救出命令，实际：${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(cmds[0]!.name, 'tf-write');
  assert.equal(cmds[0]!.attrs['path'], 'a.py');
  assert.equal(cmds[0]!.body, '\nif a > b: pass\n', '正文必须完整（旧实现整条丢弃、正文漏进 prose）');
});

test('P4. 真机回归：mangled name 值的自闭合 invoke 完整恢复（属性归位）', () => {
  // session-d6cd0759 seq 110 的形态：`name="tf-peek handle="obs:..." from_line="1" .../>`
  const events = feedAll(new TfStreamParser(), [
    '<｜｜DSML｜｜ invoke name="tf-peek handle="obs:bash:b2@v1" from_line="1" to_line="30" id="p3"/>',
  ]);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1, `mangled 自闭合 invoke 必须恢复，实际：${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(cmds[0]!.name, 'tf-peek');
  assert.equal(cmds[0]!.id, 'p3');
  assert.equal(cmds[0]!.attrs['handle'], 'obs:bash:b2@v1');
  assert.equal(cmds[0]!.attrs['from_line'], '1');
  assert.equal(cmds[0]!.attrs['to_line'], '30');
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
  /** 每个请求的线格式正文（一条消息一项）。 */
  messages: string[][];
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
          const abs = join(sandboxDir, filePath);
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
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v041-'));
  const messages: string[][] = [];
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
      messages.push(options.messages.map((m) => m.content.map((b) => b.text).join('')));
      const chunks = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return { [Symbol.asyncIterator]: () => scriptedStream(chunks) } as AsyncIterable<StreamChunkLike>;
    },
    executeTools: createExecutor(sandboxDir),
    events,
  };
  const driver = new SingleStreamDriver(ports, {
    provider: 'mock',
    model: 'mock-v041',
    // 工具面 'off'：本文件不测 tf-call（无宿主服务面时行为等价，避免噪声）
    toolSurface: 'off',
    ...config,
  });
  driver.pushUserTask(task);
  return { driver, messages, finalAnswers, sandboxDir, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

function promptOf(harness: DriverHarness, index: number): string {
  return (harness.messages[index] ?? []).join('\n');
}

function faultsOf(harness: DriverHarness): string[] {
  return harness.driver.snapshot().records
    .filter((r) => r.kind === 'fault')
    .map((r) => String((r as { fault?: string }).fault ?? ''));
}

// ---------------------------------------------------------------- D 系列：历史与缓存前缀

test('D1. 本步摘要落追加区：第 3 个请求仍能看到第 1 步的动作与读取内容（历史不蒸发）', async () => {
  const harness = makeHarness([
    [textDelta('先读 a.txt。\n'), textDelta('<tf-read path="a.txt" id="r1"/>'), finish('stop')],
    [textDelta('再执行一条命令。\n'), textDelta('<tf-bash cmd="echo hi" id="b1"/>'), finish('stop')],
    [textDelta('<tf-final id="f1" summary="两步都完成"/>'), finish('stop')],
  ], '历史保留任务');
  try {
    mkdirSync(harness.sandboxDir, { recursive: true });
    writeFileSync(join(harness.sandboxDir, 'a.txt'), 'AAAA-READ-CONTENT', 'utf8');
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed');
    assert.equal(harness.messages.length, 3, `read → bash → final 应 3 次请求，实际 ${harness.messages.length}`);

    const p2 = promptOf(harness, 1);
    assert.ok(p2.includes('AAAA-READ-CONTENT'), '第 2 请求带首读观测');
    assert.ok(p2.includes('[tf-stream:step step=1'), '第 2 请求带第 1 步摘要');

    const p3 = promptOf(harness, 2);
    assert.ok(p3.includes('AAAA-READ-CONTENT'), '第 3 请求仍能看到第 1 步的读取内容（0.4.0 在此已蒸发）');
    assert.ok(p3.includes('[tf-stream:step step=1'), '第 1 步摘要持久');
    assert.ok(p3.includes('[tf-stream:step step=2'), '第 2 步摘要已追加');
  } finally {
    harness.cleanup();
  }
});

test('D2. 前缀单调（缓存命中的结构前提）：后一请求逐条包含前一请求的全部消息', async () => {
  const harness = makeHarness([
    [textDelta('先读 a.txt。\n'), textDelta('<tf-read path="a.txt" id="r1"/>'), finish('stop')],
    [textDelta('再执行一条命令。\n'), textDelta('<tf-bash cmd="echo hi" id="b1"/>'), finish('stop')],
    [textDelta('<tf-final id="f1" summary="两步都完成"/>'), finish('stop')],
  ], '前缀单调任务');
  try {
    mkdirSync(harness.sandboxDir, { recursive: true });
    writeFileSync(join(harness.sandboxDir, 'a.txt'), 'AAAA-READ-CONTENT', 'utf8');
    await harness.driver.runTurn();
    const prev = harness.messages[1]!;
    const next = harness.messages[2]!;
    assert.ok(next.length > prev.length, '第 3 请求应比第 2 请求更长（只追加）');
    for (let i = 0; i < prev.length; i++) {
      assert.equal(next[i], prev[i], `第 ${i} 条消息必须逐字节不变（前缀单调 = 缓存可复用）`);
    }
  } finally {
    harness.cleanup();
  }
});

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
    assert.equal(harness.messages.length, 4, `应干到第 4 个请求（final），实际 ${harness.messages.length}`);
    assert.ok(!faultsOf(harness).includes('turn-blocked'), '不得出现 turn-blocked');
    assert.ok(!faultsOf(harness).includes('fallback-final'), '真 final 收敛时不该走兜底交付');
  } finally {
    harness.cleanup();
  }
});

test('C2. 停滞到顶 → 先注入收束指令（closeout），模型照做即正常收敛', async () => {
  const harness = makeHarness([
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
    assert.equal(harness.messages.length, 5, `停滞 → 收束一次 → final，共 5 个请求，实际 ${harness.messages.length}`);
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
    assert.equal(harness.finalAnswers.length, 1, '收束必须有且只有一条兜底交付');
    const fallback = harness.finalAnswers[0]!;
    assert.ok(fallback.includes('[未完成交付]'), '兜底交付必须自报未完成（不得伪装成结论）');
    assert.ok(fallback.includes('a.md'), '兜底交付要列出已完成的台账事实');
    assert.ok(fallback.includes('未完成'), '兜底交付要列未完成项');
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
    assert.equal(harness.messages.length, 2, 'nudge 一次后仍无 final → blocked（不因收束期再多烧请求）');
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

test('R2. readFeedbackBudgetPerRequest=0 关闭预算（回退点）：两份都全文，行为等价 0.4.0', async () => {
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
