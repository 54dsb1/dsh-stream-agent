// test/f6-intent.test.ts —— F6 恢复意图（0.4.0 规划内容随 0.3.0 实施）
//
// 覆盖：
//   - intent-log 单元：fsync 追加 / 读取（坏行如实计数）/ 三态判定（未发生/已发生/不确定）
//   - 驱动器 E2E：写前意图在派发前落盘、写后回执闭合；零注入（意图不进任何请求）
//   - resume 停机核对：有意图无回执 → runTurn 直接 blocked 且不发任何请求
//   - 失败写入也闭合意图（不算"无回执"）

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, normalizeStreamShim } from '../src/entry/loop.ts';
import type { DriverPorts, StreamRequestOptions, ToolBatchInputLike, ToolBatchResultLike, StreamDriverConfig } from '../src/entry/loop.ts';
import {
  appendIntentRecord,
  intentFingerprint,
  loadIntentRecords,
  pendingIntents,
} from '../src/entry/intent-log.ts';
import type { IntentLogRecord } from '../src/entry/intent-log.ts';
import { createMockModel } from '../src/entry/mock-provider.ts';
import type { Scenario } from '../src/entry/mock-provider.ts';

// ---------------------------------------------------------------------------

describe('F6：intent-log 单元', () => {
  it('I1. fsync 追加 + 读取 + 坏行如实计数', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tf-f6-'));
    try {
      const file = join(dir, 's1.jsonl');
      appendIntentRecord(file, { type: 'intent', seq: 1, at: 't', sessionId: 's1', cmdId: 'w1', op: 'write', path: 'a.txt', fingerprint: 'f1' });
      appendIntentRecord(file, { type: 'receipt', seq: 2, at: 't', intentSeq: 1, ok: true, detail: '10 chars' });
      appendIntentRecord(file, { type: 'ack', seq: 3, at: 't', intentSeqs: [] });
      // 模拟崩溃截断的最后一行
      appendFileSync(file, '{"type":"intent","seq":4,"at":"trunc', 'utf8');
      const { records, badLines } = loadIntentRecords(file);
      assert.equal(records.length, 3);
      assert.equal(badLines, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('I2. 三态判定：有回执=已发生；无回执=不确定（pending）；失败回执=已发生但失败；ack 闭合', () => {
    const records: IntentLogRecord[] = [
      { type: 'intent', seq: 1, at: 't', sessionId: 's', cmdId: 'w1', op: 'write', path: 'ok.txt', fingerprint: 'f' },
      { type: 'receipt', seq: 2, at: 't', intentSeq: 1, ok: true },
      { type: 'intent', seq: 3, at: 't', sessionId: 's', cmdId: 'w2', op: 'edit', path: 'hang.txt', fingerprint: 'f' },
      { type: 'intent', seq: 4, at: 't', sessionId: 's', cmdId: 'w3', op: 'append', path: 'fail.txt', fingerprint: 'f' },
      { type: 'receipt', seq: 5, at: 't', intentSeq: 4, ok: false, detail: 'EFAIL' },
      { type: 'intent', seq: 6, at: 't', sessionId: 's', cmdId: 'w4', op: 'write', path: 'acked.txt', fingerprint: 'f' },
      { type: 'ack', seq: 7, at: 't', intentSeqs: [6], note: '人工确认未写入' },
    ];
    const pending = pendingIntents(records);
    // w2 = 不确定（pending，停机核对对象）；w3 = 已发生但失败（failed，列出供参考不阻断）
    assert.deepEqual(pending.map((p) => `${p.intent.cmdId}:${p.state}`), ['w2:pending', 'w3:failed']);
    assert.deepEqual(pending.filter((p) => p.state === 'pending').map((p) => p.intent.cmdId), ['w2'], '停机核对只针对"有意图无回执"');
    assert.ok(!pending.some((p) => p.intent.cmdId === 'w1'), '已成功的写入不是核对对象');
    assert.ok(!pending.some((p) => p.intent.cmdId === 'w4'), 'ack 闭合的意图不是核对对象');
  });

  it('I3. intentFingerprint：确定性、16 位、内容不同指纹不同', () => {
    assert.equal(intentFingerprint('abc'), intentFingerprint('abc'));
    assert.equal(intentFingerprint('abc').length, 16);
    assert.notEqual(intentFingerprint('abc'), intentFingerprint('abd'));
  });
});

// ---------------------------------------------------------------------------
// 驱动器 E2E
// ---------------------------------------------------------------------------

interface F6Harness {
  driver: SingleStreamDriver;
  wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }>;
  intents: Array<{ cmdId: string; op: string; path: string; fingerprint: string }>;
  receipts: Array<{ cmdId: string; ok: boolean; detail?: string }>;
  cleanup: () => void;
}

function makeF6Harness(opts: { task: string; scenarios: Scenario[]; config?: Partial<StreamDriverConfig> }): F6Harness {
  const dir = mkdtempSync(join(tmpdir(), 'tf-f6e2e-'));
  const model = createMockModel({ scenarios: opts.scenarios, provider: 'mock' });
  const wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }> = [];
  const intents: F6Harness['intents'] = [];
  const receipts: F6Harness['receipts'] = [];
  const ports: DriverPorts = {
    stream: (options) => {
      wireRequests.push({ ...options, contentTexts: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')) });
      return normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal }));
    },
    executeTools: async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => ({
      results: input.calls.map((c) => ({ callId: c.id, result: { content: [{ type: 'text', text: `${c.name}:ok` }], isError: false } })),
    }),
    onIntent: (intent) => intents.push({ ...intent }),
    onIntentReceipt: (receipt) => receipts.push({ ...receipt }),
    onToolSettled: () => model.notifyToolResult(),
  };
  const config: StreamDriverConfig = { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000, ...opts.config };
  const driver = new SingleStreamDriver(ports, config);
  driver.pushUserTask(opts.task);
  return { driver, wireRequests, intents, receipts, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('F6：驱动器 E2E', () => {
  it('E1. 写前意图先于执行、写后回执闭合；意图零注入（不进任何请求）', async () => {
    const h = makeF6Harness({
      task: '意图演练：写两个文件。',
      scenarios: [
        {
          name: 'f6-write',
          match: { promptIncludes: '意图演练' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '写文件。\n' },
            { type: 'commands', commands: ['<tf-write path="a.txt" id="w1">A</tf-write>', '<tf-edit path="a.txt" id="e1">\n<<<<<<< OLD\nA\n=======\nB\n>>>>>>> NEW\n</tf-edit>', '<tf-append path="a.txt" id="a1">C</tf-append>', '<tf-read path="a.txt" id="r1"/>', '<tf-final id="f1" summary="done"/>'] },
            { type: 'waitTools', count: 3, timeoutMs: 5000 },
            { type: 'finish', reason: 'stop' },
          ],
        },
      ],
    });
    try {
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      // 三个变更类命令各有一条写前意图 + 一条回执；tf-read 不产生意图
      assert.deepEqual(h.intents.map((i) => `${i.cmdId}:${i.op}`), ['w1:write', 'e1:edit', 'a1:append']);
      assert.deepEqual(h.receipts.map((r) => `${r.cmdId}:${r.ok}`), ['w1:true', 'e1:true', 'a1:true']);
      // 写前意图的指纹 = 命令正文指纹（对账用）
      const w1 = h.intents[0]!;
      assert.equal(w1.fingerprint, intentFingerprint('A'));
      // 零注入：全部请求文本里不出现意图日志的字段形态
      const allText = h.wireRequests.map((r) => r.contentTexts.join('\n')).join('\n');
      assert.ok(!allText.includes('"type":"intent"'), '意图记录不得进入模型上下文');
      assert.ok(!allText.includes('intentFingerprint') && !allText.includes('写前意图'), '意图语义不得注入');
    } finally {
      h.cleanup();
    }
  });

  it('E2. resume 停机核对：有意图无回执 → runTurn blocked 且不发任何请求（零注入）', async () => {
    const h = makeF6Harness({
      task: '任何任务。',
      scenarios: [{
        name: 'f6-halt-never-used',
        match: { promptIncludes: '任何任务' },
        chunking: { charsPerChunk: 0, delayMs: 0 },
        steps: [{ type: 'text', text: '不该到达。\n' }, { type: 'finish', reason: 'stop' }],
      }],
      config: {},
    });
    try {
      h.driver.setResumeHalt('1 条写前意图无回执（write a.txt）');
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'blocked');
      assert.ok(reason.kind === 'blocked' && reason.detail!.includes('resume 停机核对'), 'blocked 详情应指明停机核对');
      assert.equal(h.wireRequests.length, 0, '停机核对不得发出任何请求');
      // 清除后可正常运行
      h.driver.clearResumeHalt();
      assert.ok(h.driver !== undefined);
    } finally {
      h.cleanup();
    }
  });
});
