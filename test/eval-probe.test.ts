// test/eval-probe.test.ts —— 分派 08：中立评测探针（透传保真 / 原文留存 / fail-open）
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import applyProbe from '../src/entry/eval-probe.ts';

/** 收集 ctx.on 注册的监听器（duck-type HostCtxLike） */
function captureCtx(): { ctx: Parameters<typeof applyProbe>[0]; listeners: Map<string, (...a: never[]) => unknown>; warns: string[] } {
  const listeners = new Map<string, (...a: never[]) => unknown>();
  const warns: string[] = [];
  const ctx = {
    on(event: string, listener: (...a: never[]) => unknown) { listeners.set(event, listener); },
    get(service: string) {
      return service === 'logger' ? { warn: (m: string) => warns.push(m) } : undefined;
    },
  } as unknown as Parameters<typeof applyProbe>[0];
  return { ctx, listeners, warns };
}

async function* fakeStream(chunks: unknown[]): AsyncIterable<unknown> {
  for (const c of chunks) yield c;
}

function readLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('eval-probe（08 号插桩）', () => {
  it('P1. 透传保真：chunk 逐个原样转发，顺序不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-probe-'));
    try {
      const { ctx, listeners } = captureCtx();
      applyProbe(ctx, { dumpDir: dir });
      const onStream = listeners.get('llm/stream') as unknown as (o: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>;
      assert.ok(onStream, 'llm/stream 监听器应注册');
      const chunks = [
        { type: 'text', text: 'hello' },
        { type: 'usage', usage: { inputTokens: 12, outputTokens: 34, cacheReadTokens: 100, cacheWriteTokens: 5 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ];
      const out: unknown[] = [];
      const stream = onStream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'task' }] }] }, () => fakeStream(chunks));
      for await (const c of stream) out.push(c);
      assert.deepEqual(out, chunks, '探针不得改写任何 chunk');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P2. 原文留存：request 记录含 messages 原文，chunk 记录含 usage 原文 JSON（M1/M4 数据源）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-probe-'));
    try {
      const { ctx, listeners } = captureCtx();
      applyProbe(ctx, { dumpDir: dir });
      const onStream = listeners.get('llm/stream') as unknown as (o: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>;
      const options = {
        sessionId: 'session-test',
        messages: [{ role: 'system', content: [{ type: 'text', text: 'SYS' }] }, { role: 'user', content: [{ type: 'text', text: 'task-body' }] }],
        provider: 'deepseek-official', model: 'deepseek-chat',
      };
      const chunks = [{ type: 'usage', usage: { inputTokens: 0, outputTokens: 9, totalTokens: 9, cacheReadTokens: 512 } }];
      const stream = onStream(options, () => fakeStream(chunks));
      for await (const _c of stream) { void _c; }

      const file = join(dir, 'probe.jsonl');
      assert.ok(existsSync(file), 'probe.jsonl 应落盘');
      const lines = readLines(file);
      const req = lines.find((l) => l.kind === 'request');
      assert.ok(req !== undefined, 'request 记录存在');
      const parsed = JSON.parse(req.options as string);
      assert.equal(parsed.provider, 'deepseek-official');
      assert.equal(parsed.messages.length, 2);
      assert.equal(parsed.messages[0].content[0].text, 'SYS', 'messages 原文逐字留存（prefix_hash 数据源）');
      const usageChunk = lines.find((l) => l.kind === 'chunk');
      assert.ok(usageChunk !== undefined, 'chunk 记录存在');
      const uc = JSON.parse(usageChunk.chunk as string);
      assert.equal(uc.type, 'usage');
      assert.equal(uc.usage.cacheReadTokens, 512, 'usage 原文含 cache 字段（M4 取证）');
      assert.equal(usageChunk.seq, req.seq, 'chunk 归属同请求');
      assert.ok(lines.some((l) => l.kind === 'stream-end'), 'stream-end 收尾记录');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P3. fail-open：落盘不可写 → 停用记录 + 一次告警，流照常透传', async () => {
    const { ctx, listeners, warns } = captureCtx();
    // Windows 上不存在 Z: 盘则 ENOENT；若存在则换一个必败路径（文件作为目录）
    applyProbe(ctx, { dumpDir: 'Z:\\definitely\\not\\writable\\eval-probe' });
    const onStream = listeners.get('llm/stream') as unknown as (o: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>;
    assert.ok(onStream);
    const chunks = [{ type: 'text', text: 'survives' }];
    const out: unknown[] = [];
    const stream = onStream({ messages: [] }, () => fakeStream(chunks));
    for await (const c of stream) out.push(c);
    assert.deepEqual(out, chunks, '记录停用后流必须原样透传');
    assert.ok(warns.some((w) => w.includes('eval-probe')), '必须留痕告警（不许静默）');
  });

  it('P4. 未配置 dumpDir：只透传不记录 + 告警（评测装配遗漏可发现）', async () => {
    const { ctx, listeners, warns } = captureCtx();
    applyProbe(ctx, {});
    const onStream = listeners.get('llm/stream') as unknown as (o: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>;
    const out: unknown[] = [];
    for await (const c of onStream({}, () => fakeStream([{ type: 'finish', reason: { kind: 'stop' } }]))) out.push(c);
    assert.equal(out.length, 1);
    assert.ok(warns.some((w) => w.includes('dumpDir')), '未配置必须告警');
  });

  it('P5. 多请求 seq 单调（M2 对账口径）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-probe-'));
    try {
      const { ctx, listeners } = captureCtx();
      const handle = applyProbe(ctx, { dumpDir: dir });
      const onStream = listeners.get('llm/stream') as unknown as (o: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>;
      for (let i = 0; i < 3; i++) {
        const s = onStream({ messages: [{ role: 'user', content: [{ type: 'text', text: `r${i}` }] }] }, () => fakeStream([]));
        for await (const _c of s) { void _c; }
      }
      assert.equal(handle.requestCount(), 3);
      const reqs = readLines(join(dir, 'probe.jsonl')).filter((l) => l.kind === 'request');
      assert.deepEqual(reqs.map((r) => r.seq), [1, 2, 3]);
      assert.equal(reqs[1].session, '', 'sessionId 缺省记空串不抛');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
