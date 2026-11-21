// test/v033-wildcard-closer.test.ts —— v0.3.3 畸形/通配闭合标签修复（真机取证 2026-11-20）
//
// 真机现象（ZCode 桌面端，DeepSeek-V4.1-Flash 会话）：模型把协议通配当成闭合标签输出
// `</tf-*>`——0.3.2 的 probeTag 对 `</tf…` 只认「合法闭合形态」与「未终止前缀」两种，
// 畸形变体（通配 / 带属性）落到 'prose' 兜底原样透传：桌面端正文里出现裸的 `</tf-*>`，
// 且 loop 对 malformed 一律 fail-soft 只记台账、无纠错注入——模型同一会话内重复犯错，
// 会话无产出收场。
//
// 本文件覆盖两层修复：
//   W1–W6（parser）：协议命名空间内的畸形闭合一律记 malformed(stray-close-tag) 丢弃，
//                    不进 prose；HTML 闭合与"正文里提到 </tf"仍按正文透传（不过度拦截）。
//   W7–W8（loop）：第一次畸形闭合挂定向纠错注入（malformedCloserNudge），重入一次；
//                  只注入一次（同会话重复犯错不重复烧注入）。
//
// 断言对着线格式请求与 parser 事件，不看内部字段（与 v032-truncation.test.ts 同纪律）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, malformedCloserNudge } from '../src/entry/loop.ts';
import type { DriverPorts, StreamChunkLike, StreamDriverConfig, ToolBatchInputLike, ToolBatchResultLike } from '../src/entry/loop.ts';
import { TfStreamParser } from '../src/kernel/parser.ts';
import type { ParserEvent, TfCommand } from '../src/kernel/parser.ts';

// ---------------------------------------------------------------- 解析器设施

function commandsOf(events: ParserEvent[]): TfCommand[] {
  return events.filter((e) => e.type === 'command').map((e) => (e as { command: TfCommand }).command);
}

function proseOf(events: ParserEvent[]): string {
  return events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
}

function malformedOf(events: ParserEvent[]): Array<{ raw: string; reason: string }> {
  return events.filter((e) => e.type === 'malformed').map((e) => (e as { raw: string; reason: string }));
}

function feedAll(parser: TfStreamParser, deltas: readonly string[]): ParserEvent[] {
  const out: ParserEvent[] = [];
  for (const delta of deltas) out.push(...parser.feed(delta));
  out.push(...parser.end());
  return out;
}

// ---------------------------------------------------------------- W 系列：parser

test('W1. 真机主形态：prose 中的 </tf-*> 记 malformed(stray-close-tag:tf-*) 丢弃，前后文完整保留', () => {
  const parser = new TfStreamParser();
  const events = feedAll(parser, [
    "I'll start by inspecting the workspace.\n\n",
    '</tf-*>',
    '\nI need to correct that—no tf-final yet.',
  ]);
  const prose = proseOf(events);
  assert.ok(prose.includes("I'll start by inspecting the workspace."), '残片前的 prose 不丢');
  assert.ok(prose.includes('I need to correct that—no tf-final yet.'), '残片后的 prose 不丢');
  assert.ok(!prose.includes('</tf'), '通配闭合残片不得进正文（桌面端泄漏根因）');
  const mal = malformedOf(events);
  assert.equal(mal.length, 1);
  assert.equal(mal[0]!.reason, 'stray-close-tag:tf-*');
  assert.equal(mal[0]!.raw, '</tf-*>');
  assert.equal(commandsOf(events).length, 0);
});

test('W2. 带属性的畸形闭合整段丢弃：引号感知端界（属性值含 > 不截半）', () => {
  const parser = new TfStreamParser();
  const events = feedAll(parser, ['prose here\n', '</tf-write path="a" cmd="echo a>b">', 'tail prose']);
  const prose = proseOf(events);
  assert.equal(prose, 'prose here\ntail prose');
  const mal = malformedOf(events);
  assert.equal(mal.length, 1);
  assert.equal(mal[0]!.reason, 'stray-close-tag:tf-write');
  assert.equal(mal[0]!.raw, '</tf-write path="a" cmd="echo a>b">', 'token 端界必须是引号感知的最后一个 >');
});

test('W3. 跨 chunk 的通配闭合同样拦截（</tf- 与 *> 分两个 chunk）', () => {
  const parser = new TfStreamParser();
  const events = feedAll(parser, ['abc</tf-', '*>def']);
  const prose = proseOf(events);
  assert.equal(prose, 'abcdef');
  const mal = malformedOf(events);
  assert.equal(mal.length, 1);
  assert.equal(mal[0]!.raw, '</tf-*>');
});

test('W4. 流末的畸形闭合（无 >）：end() 记 malformed，不留半截在 prose', () => {
  const parser = new TfStreamParser();
  const events = feedAll(parser, ['文字</tf-write path="x']);
  const prose = proseOf(events);
  assert.equal(prose, '文字');
  const mal = malformedOf(events);
  assert.ok(mal.length >= 1);
  assert.ok(mal[0]!.reason.startsWith('stray-close-tag'));
  assert.ok(mal[0]!.raw.startsWith('</tf-write path="x'));
});

test('W5. 残片不吞后续输出：`</tf-*>` 之后照常发命令', () => {
  const parser = new TfStreamParser();
  const events = feedAll(parser, [
    '先检查环境。\n',
    '</tf-*>',
    '\n<tf-read path="README.md" id="r1"/>\n<tf-final id="f1" summary="完成"/>',
  ]);
  const cmds = commandsOf(events);
  assert.deepEqual(cmds.map((c) => c.id), ['r1', 'f1'], '残片之后的命令照常解析');
  const prose = proseOf(events);
  assert.ok(prose.includes('先检查环境。'));
  assert.ok(!prose.includes('</tf'));
  assert.equal(malformedOf(events).length, 1);
});

test('W6. 回归基线：HTML 闭合、`</tf 不在标签位`、合法名孤立闭合行为不变', () => {
  // 0.3.1 既有语义（parser.test.ts「普通 HTML 闭合标签仍按正文透传」）逐字复刻
  const html = new TfStreamParser();
  const htmlEvents = feedAll(html, ['正文 </div> 结束，</tf 不在标签位']);
  assert.ok(proseOf(htmlEvents).includes('</div>'), 'HTML 闭合标签属于正常正文');
  assert.equal(malformedOf(htmlEvents).length, 0, 'tf 后是空白且无 > → 仍是 prose（判别式带 \\S 的原因）');

  // 合法名孤立闭合（0.3.1 语义）：stray-close-tag:<name>
  const stray = new TfStreamParser();
  const strayEvents = feedAll(stray, ['先看一眼\n<tf-glob pattern="**/*" id="gl4"/>\n继续\n</tf-bash>\n']);
  assert.equal(proseOf(strayEvents), '先看一眼\n\n继续\n\n');
  assert.equal(malformedOf(strayEvents)[0]!.reason, 'stray-close-tag:tf-bash');
  assert.equal(commandsOf(strayEvents).length, 1);
});

// ---------------------------------------------------------------- 驱动器设施（与 v032-truncation 同款）

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
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v033-'));
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
    model: 'mock-v033',
    ...config,
  });
  driver.pushUserTask(task);
  return { driver, requests, sandboxDir, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

function promptOf(harness: DriverHarness, index: number): string {
  return (harness.requests[index] ?? []).join('\n');
}

// ---------------------------------------------------------------- W 系列：loop

test('W7. 真机场景端到端：畸形闭合触发定向纠错注入 + 重入，模型改正后收敛；注入只发生一次', async () => {
  const harness = makeHarness([
    // 流 1（真机形态）：prose + </tf-*>，无命令无 final —— 0.3.2 会话"安静地"无产出收场
    [textDelta("I'll start by inspecting the workspace.\n\n"), textDelta('</tf-*>'), finish('stop')],
    // 流 2：模型拿到纠错注入后改正——正常命令 + final
    [textDelta('<tf-write path="out.md" id="w1">内容</tf-write>'), textDelta('<tf-final id="f1" summary="已写入 out.md：内容"/>'), finish('stop')],
  ], '通配闭合纠错任务');
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed');
    assert.equal(harness.requests.length, 2, '畸形闭合必须触发一次重入（0.3.2 会话在此无产出收场）');

    // 第 2 请求携带定向纠错块（点名残片原文 + 两种合法形态 + 收束方式）
    const prompt2 = promptOf(harness, 1);
    assert.ok(prompt2.includes('[tf-stream:error cmd=protocol]'), '纠错块走 [tf-stream:error] 通道');
    assert.ok(prompt2.includes(malformedCloserNudge('</tf-*>')), '注入即 malformedCloserNudge 原文');
    assert.ok(prompt2.includes('</tf-*>'), '点名残片原文');
    assert.ok(prompt2.includes('不存在 `</tf-*>` 这样的流级闭合'), '明确否定流级通配闭合');

    // 工作真实完成（残片被丢弃，改正后的命令照常执行）
    assert.equal(readFileSync(join(harness.sandboxDir, 'out.md'), 'utf8'), '内容');

    // 桌面端正文不再泄漏残片：assistant 消息正文取自 parser prose
    const snapshot = harness.driver.snapshot();
    const leaked = snapshot.records.some((r) => r.kind === 'malformed' && typeof (r as { raw?: string }).raw === 'string' && (r as { raw?: string }).raw!.includes('</tf-*>'));
    assert.ok(leaked, '残片按 malformed 记账（台账留痕）');
    const guided = snapshot.records.filter((r) => r.kind === 'fault' && (r as { fault?: string }).fault === 'malformed-closer-guidance');
    assert.equal(guided.length, 1, '纠错记账一次（同会话重复犯错不重复注入）');
  } finally {
    harness.cleanup();
  }
});

test('W8. 同会话重复畸形闭合：纠错注入只挂一次（token 纪律），台账如实逐次记录', async () => {
  const parserEvents = feedAll(new TfStreamParser(), ['a</tf-*>', 'b</tf-*>', 'c</tf-bash>']);
  // parser 层：三次残片三次记账（事实如实）
  const mal = malformedOf(parserEvents);
  assert.equal(mal.length, 3);
  assert.deepEqual(mal.map((m) => m.reason), ['stray-close-tag:tf-*', 'stray-close-tag:tf-*', 'stray-close-tag:tf-bash']);

  // loop 层：guided 标志一次 —— 用两个连续畸形闭合的流验证
  const harness = makeHarness([
    [textDelta('x</tf-*>y</tf-*>'), finish('stop')],
    [textDelta('<tf-final id="f1" summary="完成"/>'), finish('stop')],
  ], '重复畸形闭合任务', { maxReentries: 2 });
  try {
    const reason = await harness.driver.runTurn();
    assert.equal(reason.kind, 'completed');
    const guided = harness.driver.snapshot().records.filter((r) => r.kind === 'fault' && (r as { fault?: string }).fault === 'malformed-closer-guidance');
    assert.equal(guided.length, 1, '同会话只注入一次');
    // 第 2 请求带注入；若还有第 3 请求则不得再带（一次性）
    assert.ok(promptOf(harness, 1).includes(malformedCloserNudge('</tf-*>')));
    if (harness.requests.length > 2) {
      assert.ok(!promptOf(harness, 2).includes('[tf-stream:error cmd=protocol]'), '第二次重入不再携带纠错块');
    }
  } finally {
    harness.cleanup();
  }
});

test('W9. malformedCloserNudge：点名原文（长残片截断到 40 字符）', () => {
  const short = malformedCloserNudge('</tf-*>');
  assert.ok(short.includes('`</tf-*>`'));
  const long = malformedCloserNudge('</tf-write path="a-very-long-path-that-exceeds-forty-chars-in-total-length" extra="x">');
  assert.ok(long.includes('…'), '超长残片截断');
  assert.ok(!long.includes('extra="x"'), '截断后不携带超长尾部');
});
