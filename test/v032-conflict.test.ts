// test/v032-conflict.test.ts —— v0.3.2 宿主契约冲突回归（真机 session-8f22c7a0，2026-11-20 23:31）
//
// "修复"后截断仍发生——对照 GitHub deepseek-harness 源码（packages/llm/llm/src/index.ts
// 的 forAdapter 与 packages/llm/llm-deepseek/src/serialize.ts）找到的**四个独立因素**：
//   W1 崩溃主因：宿主 LlmRuntime.forAdapter 对请求里的每条 assistant 消息读
//      `message.source.replayState`（master 无防护）——并行修复新增的"正文落追加区"
//      用 role:'assistant' 但不带 source，正文首次落史后的下一请求必崩
//      （TypeError: Cannot read properties of undefined (reading 'replayState')），
//      流以 error finish 收场 → 回合 blocked。本回归：assistant 线格式消息必须带 source。
//   W2 nudge 一次性预算误杀生产性回合：nudge 在"写文件步"被消耗后，任何后续
//      无注入步骤直接 nudgeExhausted → blocked。本回归：nudge 后继续产出不中断，
//      零产出才收束（C3 语义不变）。
//   W3 XML 实体未解码：模型把 `command="... &quot;EXIT=1&quot;"` 的实体原样传给
//      PowerShell → 命令报错，白烧一步。本回归：属性值实体解码。
//   W4 DSML 内联属性 invoke 走 body 模式吞包装残片：闭合标签到流末才露出。
//      本回归：内联属性 + parameter 混合形态整体缓冲，命令属性齐全、残片不进正文。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, normalizeStreamShim } from '../src/entry/loop.ts';
import type {
  DriverPorts,
  StreamChunkLike,
  StreamRequestOptions,
  ToolBatchInputLike,
  ToolBatchResultLike,
} from '../src/entry/loop.ts';
import { TfStreamParser } from '../src/kernel/parser.ts';
import type { ParserEvent, TfCommand } from '../src/kernel/parser.ts';
import { createMockModel } from '../src/entry/mock-provider.ts';

// ---------------------------------------------------------------- 设施

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

interface Harness {
  driver: SingleStreamDriver;
  /** 逐请求的线格式消息（原样引用，供 source 断言） */
  wireRequests: StreamRequestOptions['messages'][];
  sandboxDir: string;
  cleanup: () => void;
}

function makeHarness(responses: ReadonlyArray<readonly StreamChunkLike[]>, task: string): Harness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v032c-'));
  const wireRequests: StreamRequestOptions['messages'][] = [];
  let call = 0;
  const ports: DriverPorts = {
    stream: (options) => {
      wireRequests.push(options.messages);
      const chunks = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return normalizeStreamShim(scriptedStream(chunks));
    },
    executeTools: async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => {
      const results = [];
      for (const callItem of input.calls) {
        results.push({ callId: callItem.id, result: { content: [{ type: 'text', text: `ok:${callItem.name}` }], isError: false } });
      }
      return { results };
    },
  };
  const driver = new SingleStreamDriver(ports, { provider: 'mock-provider', model: 'mock-model', streamIdleTimeoutMs: 30_000 });
  driver.pushUserTask(task);
  return { driver, wireRequests, sandboxDir, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------- W1 崩溃主因

test('W1. assistant 线格式消息必须携带 source（宿主 forAdapter 契约；缺失即流崩溃）', async () => {
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [
      textDelta('我先写文件。\n'),
      textDelta('<tf-write path="a.txt" id="w1">x</tf-write>\n'),
      finishStop(),
    ],
    [
      textDelta('写完了，收尾：a.txt 内容为 x，任务完成。\n'),
      textDelta('<tf-final id="f1" summary="a.txt 已写入（内容 x），任务完成。"/>\n'),
      finishStop(),
    ],
  ];
  const harness = makeHarness(responses, '写 a.txt 后收尾。');
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', `应收敛：${JSON.stringify(reason)}`);
    assert.ok(harness.wireRequests.length >= 2);
    // 请求 1：无任何 assistant 消息（正文尚未落史）
    for (const message of harness.wireRequests[0]!) {
      assert.notEqual(message.role, 'assistant', '请求 1 不应有 assistant 历史');
    }
    // 请求 2：正文已落史 → assistant 消息必须带完整 source（缺了宿主 forAdapter 即崩）
    const assistants = harness.wireRequests[1]!.filter((m) => m.role === 'assistant');
    assert.ok(assistants.length >= 1, '请求 2 应有落史的 assistant 消息');
    for (const message of assistants) {
      assert.notEqual(message.source, undefined, 'assistant 线消息缺 source → 宿主 forAdapter 崩溃（真机 seq 121）');
      assert.equal(message.source!.kind, 'model');
      assert.equal(message.source!.provider, 'mock-provider');
      assert.equal(message.source!.model, 'mock-model');
    }
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------- W2 nudge 进度

test('W2. nudge 后继续产出不中断：写文件步不被 nudgeExhausted 误杀（零产出才收束）', async () => {
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [
      textDelta('写第一个文件。\n'),
      textDelta('<tf-write path="a.txt" id="w1">x</tf-write>\n'),
      finishStop(),
    ],
    [
      textDelta('写第二个文件。\n'),
      textDelta('<tf-write path="b.txt" id="w2">y</tf-write>\n'),
      finishStop(),
    ],
    [
      textDelta('两个文件都写完了：a.txt=x，b.txt=y，任务完成。\n'),
      textDelta('<tf-final id="f1" summary="a.txt=x、b.txt=y 已写入，任务完成。"/>\n'),
      finishStop(),
    ],
  ];
  const harness = makeHarness(responses, '写两个文件后收尾。');
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', `nudge 后继续产出不得中断（旧语义在请求 2 后即 blocked）：${JSON.stringify(reason)}`);
    assert.equal(harness.wireRequests.length, 3, `三步三请求，实际 ${harness.wireRequests.length}`);
  } finally {
    harness.cleanup();
  }
});

// ---------------------------------------------------------------- W3 实体解码

function commandsOf(events: ParserEvent[]): TfCommand[] {
  return events.filter((e) => e.type === 'command').map((e) => (e as { command: TfCommand }).command);
}

test('W3. 属性值 XML 实体解码：&quot; 进 PowerShell 前还原为引号（真机 step 5 selfcheck 报错）', () => {
  const parser = new TfStreamParser();
  const events = parser.feed('<tf-bash id="b4" cmd="python selfcheck.py; Write-Output &quot;EXIT=$LASTEXITCODE&quot;"/>');
  events.push(...parser.end());
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1, `命令应解析：${JSON.stringify(events)}`);
  assert.equal(cmds[0]!.attrs['cmd'], 'python selfcheck.py; Write-Output "EXIT=$LASTEXITCODE"');
  // &amp; 单遍解码不二次展开：&amp;quot; → &quot;（不变成 "）
  const parser2 = new TfStreamParser();
  const events2 = parser2.feed('<tf-bash id="b" cmd="echo &amp;quot;x&amp;quot;"/>');
  events2.push(...parser2.end());
  const cmds2 = commandsOf(events2);
  assert.equal(cmds2[0]!.attrs['cmd'], 'echo &quot;x&quot;');
});

// ---------------------------------------------------------------- W4 DSML 内联属性

test('W4. DSML 内联属性 + parameter 混合形态：整体缓冲，命令属性齐全，包装残片不进正文', () => {
  const parser = new TfStreamParser();
  const events: ParserEvent[] = [];
  events.push(...parser.feed('<｜｜DSML｜｜ invoke name="tf-read" id="r1">\n'));
  events.push(...parser.feed('<｜｜DSML｜｜ parameter name="path">README.md</｜｜DSML｜｜ parameter>\n'));
  events.push(...parser.feed('</｜｜DSML｜｜ invoke>\n'));
  events.push(...parser.feed('</｜｜DSML｜｜ calls>\n'));
  events.push(...parser.end());
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1, `命令应解析（旧实现走 body 模式吞残片）：${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(cmds[0]!.name, 'tf-read');
  assert.equal(cmds[0]!.id, 'r1', '内联属性保留（id 提升为命令身份）');
  assert.equal(cmds[0]!.attrs['path'], 'README.md', 'parameter 归集');
  const prose = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.ok(!prose.includes('DSML'), '包装残片不得进正文');
  assert.ok(!prose.includes('README.md'), '参数值不得进正文');
});

// ---------------------------------------------------------------- W6-W8（v0.3.3 第二批：真机 session-d6cd0759/3d4caf01）

test('W6. mangled DSML name 值抢救：属性塞进 name 值（奇数引号）→ 命令完整恢复', () => {
  // 真机 session-d6cd0759 seq 110 原形态：整条 tf-peek 丢失（dsml-wrapper malformed）
  const p = new TfStreamParser();
  const events = p.feed('<｜｜DSML｜｜ invoke name="tf-peek handle="obs:bash:b3@v1" from_line="1" to_line="30" id="p3"/>\n');
  events.push(...p.end());
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1, `mangled 形态应抢救出完整命令：${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(cmds[0]!.name, 'tf-peek');
  assert.equal(cmds[0]!.id, 'p3');
  assert.equal(cmds[0]!.attrs['handle'], 'obs:bash:b3@v1');
  assert.equal(cmds[0]!.attrs['from_line'], '1');
  assert.equal(cmds[0]!.attrs['to_line'], '30');
  const prose = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.ok(!prose.includes('obs:bash'), '属性值不得泄漏进正文');
  assert.equal(events.filter((e) => e.type === 'malformed').length, 0, '抢救成功零 malformed');
});

test('W7. 写入类 digest 尺寸如实：detail = 写入正文大小（不是回执包装长度）', async () => {
  const responses: ReadonlyArray<readonly StreamChunkLike[]> = [
    [
      textDelta('写文件。\n'),
      textDelta('<tf-write path="m.py" id="w1">\nimport re\nTOTAL=2315\n</tf-write>\n'),
      finishStop(),
    ],
    [
      textDelta('写入完成（2315 字节文件已落盘），任务完成。\n'),
      textDelta('<tf-final id="f1" summary="m.py 已写入（import re + TOTAL=2315），任务完成。"/>\n'),
      finishStop(),
    ],
  ];
  const harness = makeHarness(responses, '写 m.py 后收尾。');
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed', JSON.stringify(reason));
    // 第 2 请求的 digest 摘要行：detail 必须是写入正文的大小（26），不是回执包装长度（~144）
    const second = harness.wireRequests[1]!.map((m) => (m.content as Array<{ text: string }>).map((b) => b.text).join('')).join('\n');
    assert.ok(second.includes('written 22 chars'), `digest 应显示写入正文大小（written 26 chars）：${second.slice(0, 300)}`);
    assert.ok(!second.includes('144 chars'), '不得再出现回执包装长度（模型误读为文件大小的根因）');
  } finally {
    harness.cleanup();
  }
});
