// test/v051-fence.test.ts —— 0.5.1（2.1）协议解析：围栏状态机 + 思考通道违规

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TfStreamParser } from '../src/kernel/parser.ts';
import type { ParserEvent, TfCommand } from '../src/kernel/parser.ts';
import { SingleStreamDriver } from '../src/entry/loop.ts';
import type { DriverPorts, StreamChunkLike, ToolBatchResultLike } from '../src/entry/loop.ts';

function run(deltas: readonly string[]): ParserEvent[] {
  const parser = new TfStreamParser();
  const events: ParserEvent[] = [];
  for (const delta of deltas) events.push(...parser.feed(delta));
  events.push(...parser.end());
  return events;
}

const textOf = (events: readonly ParserEvent[]): string =>
  events.filter((e) => e.type === 'text').map((e) => e.text).join('');
const commandsOf = (events: readonly ParserEvent[]): TfCommand[] =>
  events.filter((e) => e.type === 'command').map((e) => e.command);

// ---------------------------------------------------------------------------
// 围栏状态机
// ---------------------------------------------------------------------------

test('F1. 围栏内的 tf-write 只作 prose：0 执行、正文逐字节保留', () => {
  const src = '```md\n<tf-write path="x.md" id="w1">X</tf-write>\n```\n';
  const events = run([src]);
  assert.equal(commandsOf(events).length, 0, '围栏内命令不得执行');
  assert.equal(textOf(events), src, '正文必须逐字节保留');
});

test('F2. 缩进 2 空格仍算围栏；4 空格是缩进代码块（不拦命令）', () => {
  const indentedFence = '  ```\n<tf-read path="a.txt" id="r1"/>\n  ```\n';
  const e1 = run([indentedFence]);
  assert.equal(commandsOf(e1).length, 0, '≤3 空格缩进的围栏同样生效');
  assert.equal(textOf(e1), indentedFence);

  const indentedCode = '    ```\n<tf-read path="a.txt" id="r2"/>\n';
  const e2 = run([indentedCode]);
  assert.equal(commandsOf(e2).length, 1, '4 空格缩进不是围栏（命令照常解析）');
  assert.equal(commandsOf(e2)[0]!.attrs['path'], 'a.txt');
});

test('F3. 未闭合围栏延续到流末：0 命令、0 truncated、字节完整', () => {
  const src = '```\n<tf-write path="y.md" id="w1">Y</tf-write>';
  const events = run([src]);
  assert.equal(commandsOf(events).length, 0);
  assert.equal(events.filter((e) => e.type === 'truncated').length, 0, '围栏不是命令截断');
  assert.equal(textOf(events), src);
});

test('F4. 闭合行跨 chunk 拆分：仍正确闭合，后续命令恢复执行', () => {
  const events = run(['```\ncode\n``', '`\n<tf-read path="b.txt" id="r1"/>\n']);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1, '闭合后命令应恢复解析');
  assert.equal(cmds[0]!.attrs['path'], 'b.txt');
  assert.ok(textOf(events).startsWith('```\ncode\n```\n'), '围栏内字节保留（尾部换行属于后续 prose）');
});

test('F5. 标记字符必须一致：``` 围栏不会被 ~~~ 关闭', () => {
  const src = '```\n~~~\n<tf-read path="c.txt" id="r1"/>\n```\n';
  const events = run([src]);
  assert.equal(commandsOf(events).length, 0, '~~~ 不是 ``` 的闭合行');
  assert.equal(textOf(events), src);
});

test('F6. 围栏可带 info string；行内代码里的命令不执行（0.5.2 C-9 语义，0.6.0 统一）', () => {
  const withInfo = '```ts\n<tf-read path="d.txt" id="r1"/>\n```\n';
  assert.equal(commandsOf(run([withInfo])).length, 0);

  // 0.5.2（审计 C-9）：行内代码里的 `<tf-*>` 是示例文本，不是命令——与 F1 同一语义。
  // 0.6.0 复查修复（P3）：此前该断言为"1（执行）"——旧行为依赖 chunk 粒度（单 chunk
  // 反引号未经 pushText emit、状态陈旧 → 执行；拆 chunk → 不执行），正是"同输入不同
  // 分块产生不同结果"的不确定性缺陷的化石证据。修复后两种粒度一致：0 执行。
  const inline = '看这行 `<tf-read path="e.txt"/>` 示例。\n';
  const events = run([inline]);
  assert.equal(commandsOf(events).length, 0, '行内代码里的命令不执行（单 chunk 与 F1 拆 chunk 行为一致）');
  assert.ok(textOf(events).includes('<tf-read path="e.txt"/>'), '正文原样保留（不是丢弃）');
});

test('F7. 命令正文里的围栏标记不改变解析状态（body 由闭合标签界定）', () => {
  const src = '<tf-write path="doc.md" id="w1">\n```js\nconsole.log(1)\n```\n</tf-write>\n';
  const events = run([src]);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1);
  assert.ok(cmds[0]!.body!.includes('```js'), '正文原样保留');
  assert.ok(cmds[0]!.body!.includes('console.log(1)'));
});

// ---------------------------------------------------------------------------
// 思考通道违规（reasoning-delta 命中 <tf-）
// ---------------------------------------------------------------------------

function textDelta(text: string): StreamChunkLike {
  return { type: 'text-delta', index: 1, text } as StreamChunkLike;
}

test('F8. 思考通道里的命令 0 执行，且注入一次纠正（protocol-error:reasoning-channel）', async () => {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v051-fence-'));
  const requests: string[][] = [];
  const responses: Array<readonly StreamChunkLike[]> = [
    // 思考区写命令（拆成两个 delta 验证跨块探测）；正文只有说明
    [
      { type: 'reasoning-delta', index: 0, text: '我先写文件：<tf' } as StreamChunkLike,
      { type: 'reasoning-delta', index: 0, text: '-write path="secret.md" id="w1">X</tf-write>' } as StreamChunkLike,
      textDelta('已按计划处理。\n'),
      { type: 'finish', reason: { kind: 'stop' } } as StreamChunkLike,
    ],
    // 纠正后模型在正文通道正确输出并收尾
    [textDelta('<tf-final id="f1" summary="说明已给出；未在思考区执行任何命令。"/>\n'), { type: 'finish', reason: { kind: 'stop' } } as StreamChunkLike],
  ];
  let call = 0;
  const ports: DriverPorts = {
    stream: (options) => {
      requests.push(options.messages.map((m) => m.content.map((b) => b.text).join('')));
      const chunks = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return { [Symbol.asyncIterator]: () => (async function* () { for (const c of chunks) yield c; })() } as AsyncIterable<StreamChunkLike>;
    },
    executeTools: async (input) => ({
      results: input.calls.map((c) => ({ callId: c.id, result: { content: [{ type: 'text', text: 'should-not-run' }], isError: false } })) as ToolBatchResultLike['results'],
    }),
  };
  const driver = new SingleStreamDriver(ports, { provider: 'mock', model: 'mock-v051-reasoning' });
  driver.pushUserTask('思考区误写命令的探针。');
  try {
    const reason = await driver.runTurn();
    assert.equal(reason.kind, 'completed', JSON.stringify(reason));
    const faults = driver.snapshot().records.filter((r) => r.kind === 'fault').map((r) => String((r as { fault?: string }).fault));
    const hits = faults.filter((f) => f === 'protocol-error:reasoning-channel');
    assert.equal(hits.length, 1, `思考通道违规必须记一次台账：${JSON.stringify(faults)}`);
    assert.equal(existsSync(join(sandboxDir, 'secret.md')), false, '思考区命令 0 执行（不得落盘）');
    assert.ok(requests[1]!.join('\n').includes('reasoning-channel'), '下一请求必须带一次纠正');
    assert.equal(requests.length, 2, '纠正恰好带来一次请求');
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});
