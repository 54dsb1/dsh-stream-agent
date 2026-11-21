// test/v032-truncation.test.ts —— v0.3.2 会话中途截断修复（真机 session-e4b9a89c）
//
// 覆盖四条根因（取证见 CHANGELOG 0.3.2）：
//   T1 DSML 参数式调用被当噪声：`invoke` + `parameter` 子标签形态下，命令丢失、
//      参数值（README.md / r10 / 命令行）作为 prose 漏进正文 —— 用户侧就是"截断的正文"。
//   T2 请求之间无会话记忆：上一步的 assistant 正文 / 命令 / 结果不进追加区，
//      观测只注入一次；第 3 个请求起模型只看到 system + 任务 + 句柄目录行
//      （真机原话 "The history is truncated"）。
//   T3 非正文命令的配对开标签（少写 '/'）吞掉后续整段输出。
//   T4 max-tokens / 块未闭合的截断没有任何续写事由：回合"安静地"结束在半截输出上。
//
// 断言全部对着**线格式请求**（wireRequests）与**落盘事件**，不看内部字段。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, createSessionEventWriter } from '../src/entry/loop.ts';
import type {
  DriverPorts,
  StreamChunkLike,
  StreamDriverConfig,
  ToolBatchInputLike,
  ToolBatchResultLike,
} from '../src/entry/loop.ts';
import { TfStreamParser } from '../src/kernel/parser.ts';
import type { ParserEvent, TfCommand } from '../src/kernel/parser.ts';

// ---------------------------------------------------------------- 解析器设施

function commandsOf(events: ParserEvent[]): TfCommand[] {
  return events.filter((e) => e.type === 'command').map((e) => (e as { command: TfCommand }).command);
}

function proseOf(events: ParserEvent[]): string {
  return events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
}

function feedAll(parser: TfStreamParser, deltas: string[]): ParserEvent[] {
  const out: ParserEvent[] = [];
  for (const delta of deltas) out.push(...parser.feed(delta));
  out.push(...parser.end());
  return out;
}

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
  /** 逐请求的线格式消息文本（每条 message 一项） */
  requests: string[][];
  sandboxDir: string;
  cleanup: () => void;
}

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
        const abs = join(sandboxDir, String(args['file_path'] ?? ''));
        results.push({ callId: call.id, result: { content: [{ type: 'text', text: readFileSync(abs, 'utf8') }], isError: false } });
      } else {
        results.push({ callId: call.id, result: { content: [{ type: 'text', text: `echo:${String(args['command'] ?? '')}` }], isError: false } });
      }
    }
    return { results, additionalContexts: [], concluded: false };
  };
}

function makeHarness(responses: ReadonlyArray<readonly StreamChunkLike[]>, task: string, config?: Partial<StreamDriverConfig>): DriverHarness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v032-'));
  const requests: string[][] = [];
  let call = 0;
  const ports: DriverPorts = {
    stream: (options) => {
      requests.push(options.messages.map((m) => m.content.map((b) => b.text).join('')));
      const chunks = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return {
        [Symbol.asyncIterator]: () => scriptedStream(chunks),
      } as AsyncIterable<StreamChunkLike>;
    },
    executeTools: createExecutor(sandboxDir),
  };
  const driver = new SingleStreamDriver(ports, {
    provider: 'mock',
    model: 'mock-v032',
    ...config,
  });
  driver.pushUserTask(task);
  return { driver, requests, sandboxDir, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

/** 某个请求的全部消息文本（拼成一段便于 includes 断言）。 */
function promptOf(harness: DriverHarness, index: number): string {
  return (harness.requests[index] ?? []).join('\n');
}

// ---------------------------------------------------------------- T1 解析器

test('T1. DSML 参数式子标签：命令照常发出，参数值不再作为 prose 泄漏', () => {
  const parser = new TfStreamParser();
  const events = feedAll(parser, [
    '我先读取 README。\n',
    '<｜｜DSML｜｜ calls>\n',
    '<｜｜DSML｜｜ invoke name="tf-read">\n',
    '<｜｜DSML｜｜ parameter name="path" string="true">README.md</｜｜DSML｜｜ parameter>\n',
    '<｜｜DSML｜｜ parameter name="id" string="true">r10</｜｜DSML｜｜ parameter>\n',
    '</｜｜DSML｜｜ invoke>\n',
    '</｜｜DSML｜｜ calls>\n',
  ]);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0]!.name, 'tf-read');
  assert.equal(cmds[0]!.attrs['path'], 'README.md');
  assert.equal(cmds[0]!.id, 'r10');
  const prose = proseOf(events);
  assert.ok(prose.includes('我先读取 README。'));
  assert.ok(!prose.includes('README.md'), '参数值不得进正文（真机残片 "README.md r10"）');
  assert.ok(!prose.includes('r10'), 'id 不得进正文');
  assert.ok(!prose.includes('DSML'), 'DSML 标签不得进正文');
});

test('T1b. DSML 参数式跨 chunk（逐字符）+ 正文参数（tf-write content）', () => {
  const text = '<｜｜DSML｜｜ invoke name="tf-write">\n'
    + '<｜｜DSML｜｜ parameter name="path">a.txt</｜｜DSML｜｜ parameter>\n'
    + '<｜｜DSML｜｜ parameter name="content">line1\nline2</｜｜DSML｜｜ parameter>\n'
    + '</｜｜DSML｜｜ invoke>';
  const parser = new TfStreamParser();
  const events = feedAll(parser, [...text]);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0]!.name, 'tf-write');
  assert.equal(cmds[0]!.attrs['path'], 'a.txt');
  assert.equal(cmds[0]!.body, 'line1\nline2');
});

test('T1c. DSML 块未闭合：非正文命令能救则救；正文命令不写半截', () => {
  const nonBody = new TfStreamParser();
  const rescued = feedAll(nonBody, [
    '<｜｜DSML｜｜ invoke name="tf-bash">\n',
    '<｜｜DSML｜｜ parameter name="cmd">Get-ChildItem</｜｜DSML｜｜ parameter>',
  ]);
  const bash = commandsOf(rescued);
  assert.equal(bash.length, 1);
  assert.equal(bash[0]!.attrs['cmd'], 'Get-ChildItem');
  assert.ok(rescued.some((e) => e.type === 'truncated'));

  const body = new TfStreamParser();
  const dropped = feedAll(body, [
    '<｜｜DSML｜｜ invoke name="tf-write">\n',
    '<｜｜DSML｜｜ parameter name="path">a.txt</｜｜DSML｜｜ parameter>\n',
    '<｜｜DSML｜｜ parameter name="content">半截内容',
  ]);
  assert.equal(commandsOf(dropped).length, 0, '未闭合的正文命令不得执行（避免写半截文件）');
  assert.ok(dropped.some((e) => e.type === 'truncated'));
});

// ---------------------------------------------------------------- T3 解析器

test('T3. 非正文命令少了 "/" 不吞后续输出：命令照发、后续命令照解析', () => {
  const parser = new TfStreamParser();
  const events = feedAll(parser, [
    '<tf-read path="README.md" id="r10">\n接下来是说明文本。\n<tf-final id="f1" summary="完成"/>',
  ]);
  const cmds = commandsOf(events);
  assert.deepEqual(cmds.map((c) => c.id), ['r10', 'f1']);
  assert.ok(proseOf(events).includes('接下来是说明文本。'), '被误当正文的文本归还 prose');
});

test('T3b. 流末尾仍未闭合的非正文命令：命令照发，剩余文本不丢', () => {
  const parser = new TfStreamParser();
  const events = feedAll(parser, ['前文<tf-read path="a.md" id="r1">\n后面没有闭合']);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0]!.id, 'r1');
  const prose = proseOf(events);
  assert.ok(prose.includes('前文'));
  assert.ok(prose.includes('后面没有闭合'));
});

// ---------------------------------------------------------------- T2 驱动器

test('T2. 第 3 个请求仍能看到第 1 步的观测内容与命令摘要（历史不再蒸发）', async () => {
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
    assert.equal(harness.requests.length, 3);

    assert.ok(harness.requests[1]!.join('\n').includes('AAAA-READ-CONTENT'), '第 2 请求带首读观测');
    assert.ok(harness.requests[1]!.join('\n').includes('[tf-stream:step step=1'), '第 2 请求带第 1 步摘要');

    // 回归点：0.3.1 在第 3 个请求里已经看不到 AAAA-READ-CONTENT（观测只注入一次）。
    assert.ok(promptOf(harness, 2).includes('AAAA-READ-CONTENT'), '第 3 请求仍能看到第 1 步的读取内容');
    assert.ok(promptOf(harness, 2).includes('[tf-stream:step step=1'), '第 1 步摘要持久');
    assert.ok(promptOf(harness, 2).includes('[tf-stream:step step=2'), '第 2 步摘要已追加');

    // 前缀单调：后一请求的前 N 条消息必须与前一请求逐条一致（只追加，不重写历史）
    const prev = harness.requests[1]!;
    const next = harness.requests[2]!;
    assert.ok(next.length > prev.length, '第 3 请求应比第 2 请求更长');
    for (let i = 0; i < prev.length; i++) {
      assert.equal(next[i], prev[i], `第 ${i} 条消息必须逐字节不变（前缀单调）`);
    }
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------- T4 驱动器

test('T4. max-tokens 截断未闭合的 tf-write：强制续写，模型重发后落盘完整内容', async () => {
  const harness = makeHarness([
    [textDelta('开始写文件。\n'), textDelta('<tf-write path="out.txt" id="w1">\n第一段\n第二'), finish('max-tokens')],
    [
      textDelta('<tf-write path="out.txt" id="w2">完整内容\n</tf-write>'),
      textDelta('<tf-final id="f2" summary="已写入 out.txt"/>'),
      finish('stop'),
    ],
  ], '截断续写任务');
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed');
    assert.equal(harness.requests.length, 2, '截断后必须重入一次续写请求');
    assert.ok(promptOf(harness, 1).includes('[tf-stream:truncated'), '续写请求带截断说明');
    assert.ok(promptOf(harness, 1).includes('unclosed-command-body:tf-write'), '说明里带截断原因');
    assert.equal(readFileSync(join(harness.sandboxDir, 'out.txt'), 'utf8'), '完整内容\n');
    const faults = harness.driver.snapshot().records.filter((r) => r.kind === 'fault' && r.fault === 'output-truncated');
    assert.equal(faults.length, 1, '截断续写记账一次');
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------- 计划快照

test('T5. 计划门槛拒绝 tf-final 时，注入里带计划项原文（模型不必凭记忆猜）', async () => {
  const harness = makeHarness([
    [
      textDelta('<tf-plan id="p1">\n- [a1] 写出 receipt_tools/model.py\n</tf-plan>'),
      textDelta('<tf-final id="f1" summary="做完了"/>'),
      finish('stop'),
    ],
    [textDelta('<tf-final id="f2" summary="真的做完了"/>'), finish('stop')],
  ], '计划快照任务', { maxReentries: 2 });
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'blocked', '验收项未验证不放行');
    assert.ok(promptOf(harness, 1).includes('写出 receipt_tools/model.py'), '拒绝注入必须带计划项原文');
    assert.ok(promptOf(harness, 1).includes('当前计划'), '明确标注计划快照');
  } finally {
    harness.cleanup();
  }
});
