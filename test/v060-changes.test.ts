// test/v060-changes.test.ts —— 0.6.0 正式版离线验收：变更回执与守卫式回滚（changes 缺口）
// + request:N 别名补登记（conversation 缺口）+ v15 协议段可达。
//
// 对齐 [TF]/changes.py：begin/complete（:157-196）、_metadata（:198-215）、
// revert 双重校验（:255-272）、快照可用性（:135-155）。
// 宿主工具映射在测试里用真实 fs 执行（write/edit/apply_patch），保证 before/after 快照真实。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, normalizeStreamShim } from '../src/entry/loop.ts';
import type { DriverPorts, StreamChunkLike, StreamDriverConfig, ToolBatchInputLike, ToolBatchResultLike } from '../src/entry/loop.ts';
import { ChangeStore, planRevert, receiptMetadata, snapshotReason, unifiedDiff } from '../src/kernel/change-store.ts';
import type { ChangeEntry } from '../src/kernel/change-store.ts';
import { composeProtocolText } from '../src/kernel/protocol.ts';
import { createHash } from 'node:crypto';

const sha = (s: string): string => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

// ================================================================ C1：内核状态机

test('C1-1. begin/complete/list：成功后 canRevert=true；新建文件不可回滚删除；未结算不可回滚', () => {
  const store = new ChangeStore();
  const before = 'old\n';
  const after = 'new\n';
  const entry = store.begin({
    id: 'a'.repeat(32), workspace: '/w', path: 'f.txt', operation: 'edit', commandId: 'w1',
    beforeHash: sha(before), afterHash: sha(after), beforeBytes: before.length, afterBytes: after.length,
    unavailableReason: '', snapshots: { before: Buffer.from(before).toString('base64'), after: Buffer.from(after).toString('base64') },
  });
  assert.equal(entry.status, 'unknown');
  assert.equal(receiptMetadata(entry).canRevert, false, '未结算 = unconfirmed_change');
  const settled = store.complete(entry.id, sha(after));
  assert.equal(settled.ok, true);
  const meta = receiptMetadata(store.get(entry.id)!);
  assert.equal(meta.canRevert, true);
  assert.equal(meta.expectedRevision, sha(after));
  assert.equal(store.complete(entry.id, sha(after)).reason, 'change_already_settled');
  assert.equal(store.complete(entry.id, 'wrong').ok, false);

  // 新建文件（before = missing）
  const created = store.begin({
    id: 'b'.repeat(32), workspace: '/w', path: 'new.txt', operation: 'write', commandId: 'w2',
    beforeHash: 'missing', afterHash: sha(after), beforeBytes: 0, afterBytes: after.length,
    unavailableReason: '', snapshots: { before: null, after: Buffer.from(after).toString('base64') },
  });
  store.complete(created.id, sha(after));
  const createdMeta = receiptMetadata(store.get(created.id)!);
  assert.equal(createdMeta.canRevert, false);
  assert.equal(createdMeta.unavailableReason, 'new_file_requires_manual_recovery');
  assert.equal(store.list().length, 2);
});

test('C1-2. 快照可用性：超大 / 二进制 / 敏感内容 → 元数据-only（与 TF _snapshot_reason 同口径）', () => {
  assert.equal(snapshotReason('a', 'b'), '');
  assert.equal(snapshotReason('a', 'b', { binary: true }), 'binary_file');
  assert.equal(snapshotReason('a', 'b', { sensitive: true }), 'sensitive_content');
  assert.equal(snapshotReason('a', 'api_key=abc'), 'sensitive_content');
  assert.equal(snapshotReason('a', 'x\u0000y'), 'binary_file');
  assert.equal(snapshotReason('a', 'x'.repeat(2 * 1024 * 1024)), 'snapshot_too_large');
});

test('C1-3. planRevert 双重校验：expected 必须 == after_hash 且 == 当前哈希', () => {
  const store = new ChangeStore();
  const before = 'old\n';
  const after = 'new\n';
  const entry = store.begin({
    id: 'c'.repeat(32), workspace: '/w', path: 'f.txt', operation: 'edit', commandId: 'w1',
    beforeHash: sha(before), afterHash: sha(after), beforeBytes: before.length, afterBytes: after.length,
    unavailableReason: '', snapshots: { before: Buffer.from(before).toString('base64'), after: Buffer.from(after).toString('base64') },
  });
  store.complete(entry.id, sha(after));
  const e = store.get(entry.id)!;
  assert.equal(planRevert(e, 'wrong', sha(after)).ok, false);
  assert.equal(planRevert(e, sha(after), 'external-edit').ok, false);
  const ok = planRevert(e, sha(after), sha(after));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.before, before);
});

test('C1-4. unifiedDiff：快照对快照；无差异返回空串； hunks 含上下文', () => {
  assert.equal(unifiedDiff('a\nb\n', 'a\nb\n', 'f.txt'), '');
  const diff = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f.txt');
  assert.ok(diff.includes('--- a/f.txt'));
  assert.ok(diff.includes('+++ b/f.txt'));
  assert.ok(diff.includes('-b'));
  assert.ok(diff.includes('+B'));
  const created = unifiedDiff(null, 'x\n', 'f.txt');
  assert.ok(created.includes('--- /dev/null'));
});

// ================================================================ 设施（真实 fs 工具管线）

type Chunk = StreamChunkLike;
async function* scripted(chunks: readonly Chunk[]): AsyncGenerator<Chunk, void, undefined> {
  for (const c of chunks) yield c;
}
const text = (t: string): Chunk => ({ type: 'text-delta', index: 1, text: t }) as Chunk;
const stop = (): Chunk => ({ type: 'finish', reason: { kind: 'stop' } }) as Chunk;

interface Harness {
  driver: SingleStreamDriver;
  prompts: string[];
  root: string;
  receipts: ChangeEntry[];
  outputs: () => Array<{ name?: string; status?: string; output?: string; detail?: string }>;
  cleanup: () => void;
}

function makeHarness(responses: ReadonlyArray<readonly Chunk[]>, config: Partial<StreamDriverConfig> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'tf-v060-chg-'));
  const prompts: string[] = [];
  const receipts: ChangeEntry[] = [];
  let call = 0;
  const ports: DriverPorts = {
    stream: (options) => {
      prompts.push(options.messages.map((m) => m.content.map((b) => b.text ?? '').join('')).join('\n'));
      const chunks = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return normalizeStreamShim(scripted(chunks) as never) as AsyncIterable<Chunk>;
    },
    executeTools: async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => ({
      results: input.calls.map((c) => {
        const args = JSON.parse(c.arguments) as Record<string, unknown>;
        const file = join(root, String(args['file_path'] ?? ''));
        try {
          if (c.name === 'write') {
            writeFileSync(file, String(args['content'] ?? ''), 'utf8');
            return { callId: c.id, result: { content: [{ type: 'text', text: `Created ${args['file_path']}` }], isError: false } };
          }
          if (c.name === 'edit') {
            const old = readFileSync(file, 'utf8');
            const next = old.replace(String(args['old_string']), String(args['new_string']));
            writeFileSync(file, next, 'utf8');
            return { callId: c.id, result: { content: [{ type: 'text', text: 'Edited' }], isError: false } };
          }
          if (c.name === 'read') {
            return { callId: c.id, result: { content: [{ type: 'text', text: readFileSync(file, 'utf8') }], isError: false } };
          }
        } catch (error) {
          return { callId: c.id, result: { content: [{ type: 'text', text: String(error) }], isError: true } };
        }
        return { callId: c.id, result: { content: [{ type: 'text', text: `ok:${c.name}` }], isError: false } };
      }),
    }),
    onChangeReceipt: (entry) => { receipts.push(entry); },
    events: {
      turnStart: () => {}, stepStart: () => {}, stepEnd: () => {}, turnEnd: () => {},
      assistantMessage: () => ({ eventType: 'assistant/message', seq: 0 }),
      toolLog: () => undefined,
      finalAnswer: () => {},
    },
  };
  const driver = new SingleStreamDriver(ports, { provider: 'mock', model: 'mock', projectDir: root, requireFinal: true, ...config });
  return {
    driver, prompts, root, receipts,
    outputs: () => {
      // 命令记录生命周期 pending → dispatched → ok/failed：按 id 取最后一条（终态）。
      const recs = driver.snapshot().records as Array<{ kind?: string; id?: string; name?: string; status?: string; output?: string; detail?: string }>;
      const byId = new Map<string, { name?: string; status?: string; output?: string; detail?: string }>();
      for (const r of recs) {
        if (r.kind === 'command' && typeof r.id === 'string') byId.set(r.id, r);
      }
      return [...byId.values()];
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const finalStep = (n: number): readonly Chunk[] => [text(`<tf-final id="f${n}" summary="完成"/>\n`), stop()];

// ================================================================ C2：端到端回执 + 回滚

test('C2-1. tf-write → 回执登记（onChangeReceipt）；tf-changes 列出；tf-diff 出补丁；tf-revert 恢复', async () => {
  const h = makeHarness([
    [text('<tf-write path="f.txt" id="w1">v1\n</tf-write>\n'), stop()],
    [text('<tf-write path="f.txt" id="w2">v2\n</tf-write>\n'), stop()],
    [text('<tf-changes id="ch1"/>\n'), stop()],
    finalStep(1),
  ]);
  try {
    h.driver.pushUserTask('写两次');
    await h.driver.runTurn();
    assert.equal(h.receipts.length, 2, '两次成功写 = 两条回执');
    assert.equal(h.receipts[0]!.operation, 'write');
    assert.equal(h.receipts[0]!.beforeHash, 'missing');
    assert.equal(h.receipts[1]!.beforeHash, sha('v1\n'));
    assert.equal(h.receipts[1]!.afterHash, sha('v2\n'));
    const changes = h.outputs().find((r) => r.name === 'tf-changes');
    assert.equal(changes?.status, 'ok');
    const joined = h.prompts.join('\n');
    assert.ok(joined.includes(h.receipts[1]!.id), '目录必须含完整回执 id（且模型可见）');
    assert.ok(joined.includes(`expected=${sha('v2\n')}`), 'expected 哈希必须可见（revert 要用）');
    assert.ok(joined.includes('revert=no(new_file_requires_manual_recovery)'), '新建文件不可回滚删除');
    assert.ok(joined.includes('revert=yes'), '第二次写可回滚');
  } finally {
    h.cleanup();
  }
});

test('C2-2. tf-revert：双重校验恢复 before；undo 回执登记；重复 revert / 外部改动 → revision_conflict', async () => {
  const h = makeHarness([
    [text('<tf-write path="f.txt" id="w1">v1\n</tf-write>\n'), stop()],
    [text('<tf-write path="f.txt" id="w2">v2\n</tf-write>\n'), stop()],
    [text('<tf-changes id="ch1"/>\n'), stop()],
    finalStep(1),
  ]);
  try {
    h.driver.pushUserTask('写两次');
    await h.driver.runTurn();
    const target = h.receipts[1]!;
    const expected = target.afterHash;

    // 外部改动 → 拒绝（不覆盖外部编辑）
    writeFileSync(join(h.root, 'f.txt'), 'external\n', 'utf8');
    const h2 = makeHarness([
      [text(`<tf-revert change="${target.id}" expected="${expected}" id="r1"/>\n`), stop()],
      finalStep(2),
    ]);
    try {
      // 把外部改动后的文件放进 h2 的沙箱，并加载 h 的回执（模拟 resume）
      writeFileSync(join(h2.root, 'f.txt'), 'external\n', 'utf8');
      h2.driver.loadChangeReceipts(h.receipts.map((r) => ({ ...r, workspace: h2.root })));
      h2.driver.pushUserTask('回滚');
      await h2.driver.runTurn();
      const revert = h2.outputs().find((r) => r.name === 'tf-revert');
      assert.equal(revert?.status, 'failed');
      assert.ok(revert?.detail?.includes('revision_conflict'), revert?.detail);
      assert.equal(readFileSync(join(h2.root, 'f.txt'), 'utf8'), 'external\n', '外部编辑不得被覆盖');
    } finally {
      h2.cleanup();
    }

    // 正常回滚（当前 == after）
    const h3 = makeHarness([
      [text(`<tf-revert change="${target.id}" expected="${expected}" id="r1"/>\n`), stop()],
      [text(`<tf-revert change="${target.id}" expected="${expected}" id="r2"/>\n`), stop()],
      finalStep(3),
    ]);
    try {
      writeFileSync(join(h3.root, 'f.txt'), 'v2\n', 'utf8');
      h3.driver.loadChangeReceipts(h.receipts.map((r) => ({ ...r, workspace: h3.root })));
      h3.driver.pushUserTask('回滚');
      await h3.driver.runTurn();
      const reverts = h3.outputs().filter((r) => r.name === 'tf-revert');
      assert.equal(reverts[0]?.status, 'ok', reverts[0]?.detail);
      assert.equal(readFileSync(join(h3.root, 'f.txt'), 'utf8'), 'v1\n', '恢复到 before');
      assert.equal(h3.receipts.length, 1, 'undo 回执');
      assert.equal(h3.receipts[0]!.operation, 'revert');
      assert.equal(h3.receipts[0]!.undoOf, target.id);
      // 第二次同 expected → 当前哈希已变（v1）→ revision_conflict
      assert.equal(reverts[1]?.status, 'failed');
      assert.ok(reverts[1]?.detail?.includes('revision_conflict'), reverts[1]?.detail);
    } finally {
      h3.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test('C2-3. tf-diff：快照补丁；未知回执 / 不可 diff 结构化失败', async () => {
  const h = makeHarness([
    [text('<tf-write path="f.txt" id="w1">a\nb\n</tf-write>\n'), stop()],
    [text('<tf-edit path="f.txt" id="e1"><<<<<<< OLD\nb\n=======\nB\n>>>>>>> NEW\n</tf-edit>\n'), stop()],
    [text('<tf-changes id="ch1"/>\n'), stop()],
    finalStep(1),
  ]);
  try {
    h.driver.pushUserTask('写后改');
    await h.driver.runTurn();
    const editReceipt = h.receipts.find((r) => r.operation === 'edit')!;
    assert.ok(editReceipt !== undefined);
    const h2 = makeHarness([
      [text(`<tf-diff change="${editReceipt.id}" id="d1"/>\n`), stop()],
      [text('<tf-diff change="ffffffffffffffffffffffffffffffff" id="d2"/>\n'), stop()],
      finalStep(2),
    ]);
    try {
      h2.driver.loadChangeReceipts(h.receipts.map((r) => ({ ...r, workspace: h2.root })));
      h2.driver.pushUserTask('看差分');
      await h2.driver.runTurn();
      const diffs = h2.outputs().filter((r) => r.name === 'tf-diff');
      assert.equal(diffs[0]?.status, 'ok');
      const joined = h2.prompts.join('\n');
      assert.ok(joined.includes('-b'), joined.slice(0, 800));
      assert.ok(joined.includes('+B'), joined.slice(0, 800));
      assert.equal(diffs[1]?.status, 'failed');
      assert.ok(diffs[1]?.detail?.includes('unknown-change'));
    } finally {
      h2.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

test('C2-4. 敏感内容变更：快照不可用（sensitive_content），canRevert=false；changeReceipts=false 回退点', async () => {
  const h = makeHarness([
    [text('<tf-write path="s.txt" id="w1">api_key=abc123\n</tf-write>\n'), stop()],
    finalStep(1),
  ]);
  try {
    h.driver.pushUserTask('写敏感文件');
    await h.driver.runTurn();
    assert.equal(h.receipts.length, 1);
    assert.equal(h.receipts[0]!.unavailableReason, 'sensitive_content');
    assert.equal(h.receipts[0]!.snapshots, undefined, '敏感内容不得存快照');
    assert.equal(receiptMetadata(h.receipts[0]!).canRevert, false);
  } finally {
    h.cleanup();
  }

  const off = makeHarness([
    [text('<tf-write path="f.txt" id="w1">v1\n</tf-write>\n'), stop()],
    finalStep(2),
  ], { changeReceipts: false });
  try {
    off.driver.pushUserTask('写');
    await off.driver.runTurn();
    assert.equal(off.receipts.length, 0, 'changeReceipts=false = 回退点');
  } finally {
    off.cleanup();
  }
});

test('C2-5. loadChangeReceipts：跨工作区回执拒绝；快照哈希损坏拒绝', () => {
  const h = makeHarness([]);
  try {
    const entry: ChangeEntry = {
      version: 1, id: 'd'.repeat(32), workspace: '/other', path: 'f.txt', operation: 'write',
      commandId: 'w1', status: 'success', createdAt: 1, beforeHash: 'missing', afterHash: sha('x'),
      beforeBytes: 0, afterBytes: 1, unavailableReason: '', undoOf: '',
      snapshots: { before: null, after: Buffer.from('x').toString('base64') },
    };
    const foreign = h.driver.loadChangeReceipts([entry]);
    assert.equal(foreign.loaded, 0);
    assert.equal(foreign.rejected, 1);
    const bad: ChangeEntry = { ...entry, workspace: h.root, afterHash: 'wrong' };
    const corrupted = h.driver.loadChangeReceipts([bad]);
    assert.equal(corrupted.rejected, 1, '快照哈希不符必须拒绝');
    const good: ChangeEntry = { ...entry, workspace: h.root };
    assert.equal(h.driver.loadChangeReceipts([good]).loaded, 1);
  } finally {
    h.cleanup();
  }
});

// ================================================================ C3：request:N 别名

test('C3-1. 任务起点原文登记 request:N：未压缩回合 tf-peek handle="request:1" 可取回', async () => {
  const h = makeHarness([
    [text('<tf-peek handle="request:1" id="p1"/>\n'), stop()],
    finalStep(1),
  ]);
  try {
    h.driver.pushUserTask('这是任务原文：核对约定 XYZ-42。');
    await h.driver.runTurn();
    const peek = h.outputs().find((r) => r.name === 'tf-peek');
    assert.equal(peek?.status, 'ok');
    const joined = h.prompts.join('\n');
    assert.ok(joined.includes('XYZ-42'), `request:1 必须能取回任务原文：${joined.slice(0, 600)}`);
  } finally {
    h.cleanup();
  }
});

// ================================================================ C4：v15 协议段

test('C4-1. v15 段默认不进装配（金样不变）；显式开启后 tf-revert 语法模型可见', () => {
  const base = composeProtocolText();
  assert.ok(!base.includes('tf-revert'), '默认装配不得含 v15（前缀缓存零回归）');
  const enhanced = composeProtocolText({ sections: { v15: true } });
  assert.ok(enhanced.includes('tf-revert'));
  assert.ok(enhanced.includes('tf-changes'));
  assert.ok(enhanced.includes('tf-diff'));
  assert.ok(enhanced.startsWith(base), 'v15 是追加段，不改默认 8 段');
});