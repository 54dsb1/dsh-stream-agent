// test/stream-v02.test.ts —— v0.2.0 优化项（对照上游 xuxiang-thinkflow 0.10.0 的语义对齐）：
//   T1 隐式写序：同流"先写后读"必须等写完成（上游 DESIGN：信息工具先等之前的写入）
//   T2 重复 id 幂等：同 id 同内容返回原回执不重执行；同 id 不同内容拒绝
//   T3 乐观 peek 延迟：同流 peek 未就绪句柄 → 流末 drain 后重试，成功交付
//   T4 tf-read offset/limit：parser 接受行范围属性，映射透传数值
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, DEFAULT_TOOL_MAPPING } from '../src/entry/loop.ts';
import type { DriverPorts, StreamRequestOptions, ToolBatchInputLike, ToolBatchResultLike, StreamDriverConfig } from '../src/entry/loop.ts';
import { normalizeStreamShim } from '../src/entry/loop.ts';
import { createMockModel } from '../src/entry/mock-provider.ts';
import type { Scenario } from '../src/entry/mock-provider.ts';
import { TfStreamParser } from '../src/kernel/parser.ts';

interface Harness {
  driver: SingleStreamDriver;
  sandboxDir: string;
  execCounts: { write: number; read: number; bash: number };
  wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }>;
  cleanup: () => void;
}

function makeHarness(task: string, scenarios: Scenario[], seed?: Record<string, string>): Harness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v02-'));
  for (const [name, content] of Object.entries(seed ?? {})) writeFileSync(join(sandboxDir, name), content, 'utf8');
  const execCounts = { write: 0, read: 0, bash: 0 };
  const model = createMockModel({ scenarios, provider: 'mock' });
  const wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }> = [];
  const execute = async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => {
    const results: ToolBatchResultLike['results'] = [];
    for (const call of input.calls) {
      const args = JSON.parse(call.arguments) as Record<string, unknown>;
      try {
        if (call.name === 'write') {
          execCounts.write += 1;
          writeFileSync(join(sandboxDir, String(args['file_path'])), String(args['content'] ?? ''), 'utf8');
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: `written ${String(args['file_path'])}` }], isError: false } });
        } else if (call.name === 'read') {
          execCounts.read += 1;
          const content = readFileSync(join(sandboxDir, String(args['file_path'])), 'utf8');
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: content }], isError: false } });
        } else if (call.name === 'bash') {
          execCounts.bash += 1;
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: `bash-echo:${String(args['command'] ?? '')}` }], isError: false } });
        } else {
          results.push({ callId: call.id, result: { content: [{ type: 'text', text: `unknown tool: ${call.name}` }], isError: true } });
        }
      } catch (error) {
        results.push({ callId: call.id, result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true } });
      }
    }
    return { results, additionalContexts: [], concluded: false };
  };
  const ports: DriverPorts = {
    stream: (options) => {
      wireRequests.push({ ...options, contentTexts: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')) });
      return normalizeStreamShim(model.adapter.stream({
        provider: options.provider, model: options.model, messages: options.messages, signal: options.signal,
      }));
    },
    executeTools: execute,
    onToolSettled: () => model.notifyToolResult(),
  };
  const config: StreamDriverConfig = { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000, maxReentries: 8 };
  const driver = new SingleStreamDriver(ports, config);
  driver.pushUserTask(task);
  return {
    driver, sandboxDir, execCounts, wireRequests,
    cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }),
  };
}

describe('v0.2.0 优化项（上游 xuxiang-thinkflow 语义对齐）', () => {
  let harness: Harness | undefined;
  beforeEach(() => {
    harness?.cleanup();
    harness = undefined;
  });

  it('T1. 隐式写序：同流先写后读（无显式 depends_on）时，read 必须在 write ok 之后派发', async () => {
    harness = makeHarness('先写后读', [
      {
        name: 'implicit-order',
        match: { promptIncludes: '先写后读' },
        chunking: { charsPerChunk: 0, delayMs: 0 },
        steps: [
          { type: 'text', text: '写入后读取。\n' },
          {
            type: 'commands',
            commands: [
              '<tf-write path="a.txt" id="w1">内容A</tf-write>',
              '<tf-read path="a.txt" id="r1"/>',
              '<tf-final id="f1" summary="write-read-done"/>',
            ],
          },
          { type: 'finish', reason: 'stop' },
        ],
      },
    ]);
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      const w1Ok = snap.records.find((r) => r.kind === 'command' && r.id === 'w1' && r.status === 'ok');
      const r1Dispatched = snap.records.find((r) => r.kind === 'command' && r.id === 'r1' && r.status === 'dispatched');
      assert.ok(w1Ok !== undefined && r1Dispatched !== undefined, '缺 write ok 或 read dispatched 记录');
      assert.ok(r1Dispatched.seq > w1Ok.seq, `read 派发必须晚于 write ok（隐式写序）；w1ok=${w1Ok.seq} r1dispatch=${r1Dispatched.seq}`);
      assert.equal(harness.execCounts.read, 1);
      assert.equal(readFileSync(join(harness.sandboxDir, 'a.txt'), 'utf8'), '内容A');
    } finally {
      harness?.cleanup();
    }
  });

  it('T2. 重复 id 幂等：同 id 同内容返回原回执不重执行；同 id 不同内容拒绝', async () => {
    harness = makeHarness('幂等重发', [
      {
        name: 'idempotent-dup',
        match: { promptIncludes: '幂等重发' },
        chunking: { charsPerChunk: 0, delayMs: 0 },
        steps: [
          { type: 'text', text: '写一次；等完成后同内容复用 id，再用同 id 写不同内容。\n' },
          { type: 'commands', commands: ['<tf-write path="a.txt" id="w1">内容A</tf-write>'] },
          { type: 'waitTools', 'count': 1, 'timeoutMs': 5000 },
          {
            type: 'commands',
            commands: [
              '<tf-write path="a.txt" id="w1">内容A</tf-write>',
              '<tf-write path="b.txt" id="w1">内容B</tf-write>',
              '<tf-final id="f1" summary="幂等完成"/>',
            ],
          },
          { type: 'finish', reason: 'stop' },
        ],
      },
    ]);
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      const dupRecord = snap.records.find((r) => r.kind === 'command' && r.id === 'w1' && r.status === 'ok' && String((r as { detail?: string }).detail ?? '').startsWith('duplicate-idempotent'));
      assert.ok(dupRecord !== undefined, '同内容同 id 重复声明应记 duplicate-idempotent 原回执');
      const conflict = snap.records.find((r) => r.kind === 'command' && r.id === 'w1' && r.status === 'rejected' && String((r as { detail?: string }).detail ?? '').includes('换新 id'));
      assert.ok(conflict !== undefined, '同 id 不同内容应被拒绝并提示换新 id');
      assert.equal(harness.execCounts.write, 1, '幂等声明不得重复执行工具');
      assert.equal(readFileSync(join(harness.sandboxDir, 'a.txt'), 'utf8'), '内容A');
    } finally {
      harness?.cleanup();
    }
  });

  it('T3. 乐观 peek 延迟：同流 peek 未就绪句柄 → 流末重试成功，内容注入下一请求', async () => {
    harness = makeHarness('乐观peek', [
      // 注意：mock 按首个命中的剧本选择——s2（含注入文本匹配）必须排在 s1 之前
      {
        name: 'optimistic-peek-final',
        match: { promptIncludes: 'tf-stream:peek' },
        chunking: { charsPerChunk: 0, delayMs: 0 },
        steps: [
          { type: 'text', text: 'peek 内容已取回。\n' },
          { type: 'commands', commands: ['<tf-final id="f1" summary="answer-ERROR-42-l-q"/>'] },
          { type: 'finish', reason: 'stop' },
        ],
      },
      {
        name: 'optimistic-peek',
        match: { promptIncludes: '乐观peek' },
        chunking: { charsPerChunk: 0, delayMs: 0 },
        steps: [
          { type: 'text', text: '读后立即 peek（同流乐观）。\n' },
          {
            type: 'commands',
            commands: ['<tf-read path="log.txt" id="r1"/>', '<tf-peek handle="obs:read:r1@v1" id="p1"/>'],
          },
          { type: 'finish', reason: 'stop' },
        ],
      },
    ], { 'log.txt': 'L1-alpha\nL42-ERROR-42-l-q\nL3-gamma\n' });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      const peekOk = snap.records.filter((r) => r.kind === 'command' && r.id === 'p1' && r.status === 'ok');
      assert.equal(peekOk.length, 1, `延迟重试后 peek 应恰一次 ok：${JSON.stringify(snap.records.filter((r) => r.kind === 'command' && r.id === 'p1'))}`);
      const peekFailed = snap.records.find((r) => r.kind === 'command' && r.id === 'p1' && r.status === 'failed');
      assert.equal(peekFailed, undefined, '乐观 peek 不应失败');
      const req2 = harness.wireRequests[1]!;
      assert.ok(
        req2.contentTexts.some((t) => t.includes('L42-ERROR-42-l-q')),
        '请求 2 应注入 peek 取回的内容',
      );
    } finally {
      harness?.cleanup();
    }
  });

  it('T5. tf-final 同 id 更新答案：重入流内复用 f1 携带新 summary → 覆盖最终答案（last-wins）', async () => {
    harness = makeHarness('final覆盖', [
      // 顺序敏感：s2（注入文本匹配）在前
      {
        name: 'final-update',
        match: { promptIncludes: 'tf-stream:peek' },
        chunking: { charsPerChunk: 0, delayMs: 0 },
        steps: [
          { type: 'text', text: '细节到手，更新最终答案。\n' },
          { type: 'commands', commands: ['<tf-final id="f1" summary="answer-L42-zebra-final"/>'] },
          { type: 'finish', reason: 'stop' },
        ],
      },
      {
        name: 'final-placeholder',
        match: { promptIncludes: 'final覆盖' },
        chunking: { charsPerChunk: 0, delayMs: 0 },
        steps: [
          { type: 'text', text: '读后乐观 peek，占位收尾。\n' },
          {
            type: 'commands',
            commands: [
              '<tf-read path="log.txt" id="r1"/>',
              '<tf-peek handle="obs:read:r1@v1" id="p1"/>',
              '<tf-final id="f1" summary="占位"/>',
            ],
          },
          { type: 'finish', reason: 'stop' },
        ],
      },
    ], { 'log.txt': 'L42-zebra: the answer lives here\n' });
    try {
      const reason = await harness.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const snap = harness.driver.snapshot();
      const finals = snap.records.filter((r) => r.kind === 'final');
      const last = finals[finals.length - 1] as { summary?: string } | undefined;
      assert.ok(last !== undefined);
      assert.equal(last.summary, 'answer-L42-zebra-final', `最终答案应被同 id 新 summary 覆盖，实际：${last.summary}`);
      // 最终 assistant 消息 = 更新后的答案（headless 输出与 checks 的消费面）
      const req2 = harness.wireRequests[1]!;
      assert.ok(req2.contentTexts.some((t) => t.includes('[tf-stream:peek')), '重入流应注入 peek 结果');
    } finally {
      harness?.cleanup();
    }
  });

  it('T4. tf-read offset/limit：parser 接受行范围属性，映射透传数值', () => {
    const parser = new TfStreamParser();
    const events = parser.feed('<tf-read path="big.log" id="r1" offset="100" limit="50"/>');
    const cmdEvent = events.find((e) => e.type === 'command');
    assert.ok(cmdEvent !== undefined && cmdEvent.type === 'command', '带 offset/limit 的 tf-read 应正常闭合');
    const mapped = DEFAULT_TOOL_MAPPING.toToolCall(cmdEvent.command);
    assert.ok(mapped !== null && mapped.name === 'read');
    assert.equal((mapped.arguments as Record<string, unknown>)['offset'], 100);
    assert.equal((mapped.arguments as Record<string, unknown>)['limit'], 50);
    const parser2 = new TfStreamParser();
    const events2 = parser2.feed('<tf-read path="big.log" id="r2" offset="abc"/>');
    const cmdEvent2 = events2.find((e) => e.type === 'command');
    assert.ok(cmdEvent2 !== undefined && cmdEvent2.type === 'command');
    const mapped2 = DEFAULT_TOOL_MAPPING.toToolCall(cmdEvent2.command);
    assert.equal((mapped2!.arguments as Record<string, unknown>)['offset'], undefined, '非数字 offset 不得进参数');
  });
});
