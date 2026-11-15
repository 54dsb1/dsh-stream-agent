import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ObservationLedger,
  InMemoryBlobSink,
  classify,
  classifyTool,
  renderSkeleton,
  skeletonToText,
  UNCHANGED_TEXT,
  type ObservationInput,
} from '../../src/kernel/obs.ts';

function obs(partial: Partial<ObservationInput>): ObservationInput {
  return { tool: 'tf-read', ok: true, key: 'a.ts', content: 'x', ...partial };
}

// ---------------------------------------------------------------------------
// 分类器四条规则（每条 ≥2 用例）
// ---------------------------------------------------------------------------

test('规则1: read/grep 族首次输出 = high', () => {
  const ledger = new ObservationLedger();
  const r1 = ledger.observe(obs({ tool: 'tf-read', key: 'src/a.ts', content: 'line1\nline2' }));
  assert.equal(r1.info_gain, 'high');
  const r2 = ledger.observe(obs({ tool: 'grep', key: 'TODO', content: 'a.ts:1: TODO x' }));
  assert.equal(r2.info_gain, 'high');
  assert.equal(r2.payload.kind, 'skeleton');
});

test('规则1(变体): web/test 首次输出 = high', () => {
  const ledger = new ObservationLedger();
  assert.equal(ledger.observe(obs({ tool: 'web_fetch', key: 'http://x', content: '<html>hi</html>' })).info_gain, 'high');
  assert.equal(ledger.observe(obs({ tool: 'test', key: 'npm test', content: 'all green' })).info_gain, 'high');
});

test('规则2: write/append/mkdir 成功回执 = low（句柄化不注入）', () => {
  const ledger = new ObservationLedger();
  const w = ledger.observe(obs({ tool: 'tf-write', key: 'src/a.ts', content: 'written' }));
  assert.equal(w.info_gain, 'low');
  assert.equal(w.payload.kind, 'receipt');
  const m = ledger.observe(obs({ tool: 'mkdir', key: 'src/lib', content: 'ok' }));
  assert.equal(m.info_gain, 'low');
  const ap = ledger.observe(obs({ tool: 'append', key: 'log.txt', content: 'ok' }));
  assert.equal(ap.info_gain, 'low');
});

test('规则2(变体): bash 成功 = low（README §5：成功记 ledger），bash 失败见规则4', () => {
  const ledger = new ObservationLedger();
  assert.equal(ledger.observe(obs({ tool: 'tf-bash', key: 'npm test', content: 'ok' })).info_gain, 'low');
  assert.equal(ledger.observe(obs({ tool: 'tf-bash', key: 'npm build', content: 'ok' })).info_gain, 'low');
});

test('规则3: 重复观测（内容哈希未变）= none', () => {
  const ledger = new ObservationLedger();
  ledger.observe(obs({ tool: 'tf-read', key: 'a.ts', content: 'same' }));
  const again = ledger.observe(obs({ tool: 'tf-read', key: 'a.ts', content: 'same' }));
  assert.equal(again.info_gain, 'none');
  assert.equal(again.reason, 'duplicate-observation');
  const third = ledger.observe(obs({ tool: 'tf-read', key: 'a.ts', content: 'same' }));
  assert.equal(third.info_gain, 'none');
  assert.deepEqual(third.payload, { kind: 'unchanged', text: UNCHANGED_TEXT });
});

test('规则3(变体): 空输出 = none，且句柄目录不更新', () => {
  const ledger = new ObservationLedger();
  const e = ledger.observe(obs({ tool: 'grep', key: 'nothing', content: '' }));
  assert.equal(e.info_gain, 'none');
  assert.equal(e.handle, null);
  // 空输出不产生目录条目
  assert.deepEqual(ledger.directoryDelta(0), { added: [], changed: [], stale: [] });
});

test('规则4: 一切执行失败 = high（含 write/bash 失败）', () => {
  const ledger = new ObservationLedger();
  const f1 = ledger.observe(obs({ tool: 'tf-read', key: 'missing.ts', ok: false, content: 'ENOENT' }));
  assert.equal(f1.info_gain, 'high');
  const f2 = ledger.observe(obs({ tool: 'tf-bash', key: 'npm test', ok: false, content: 'exit 1' }));
  assert.equal(f2.info_gain, 'high');
  const f3 = ledger.observe(obs({ tool: 'tf-write', key: 'ro/a.ts', ok: false, content: 'EACCES' }));
  assert.equal(f3.info_gain, 'high');
});

test('规则4(变体): 重复读但内容失败 = high；classify 纯函数可直接用', () => {
  const ledger = new ObservationLedger();
  ledger.observe(obs({ tool: 'tf-read', key: 'a.ts', content: 'v1' }));
  const fail = ledger.observe(obs({ tool: 'tf-read', key: 'a.ts', ok: false, content: 'EIO' }));
  assert.equal(fail.info_gain, 'high');
  // 内容变化的新版本也是 high
  const changed = ledger.observe(obs({ tool: 'tf-read', key: 'a.ts', content: 'v2' }));
  assert.equal(changed.info_gain, 'high');
  assert.equal(changed.reason, 'content-changed:read');
});

test('classify 纯函数：不依赖 ledger 状态即可判定', () => {
  assert.equal(classify(obs({ content: 'x' })).info_gain, 'high'); // 无历史 → 首次
  assert.equal(classify(obs({ ok: false, content: 'boom' })).info_gain, 'high');
  assert.equal(classify(obs({ tool: 'tf-write', content: 'ok' })).info_gain, 'low');
  assert.equal(classify(obs({ content: '' })).info_gain, 'none');
  assert.equal(classify(obs({ tool: 'unknown_thing', content: 'x' })).info_gain, 'low');
});

test('classifyTool：tf-* 与常见工具名映射正确，未知归 other', () => {
  assert.equal(classifyTool('tf-read'), 'read');
  assert.equal(classifyTool('tf-write'), 'write');
  assert.equal(classifyTool('tf-bash'), 'bash');
  assert.equal(classifyTool('tf-peek'), 'read');
  assert.equal(classifyTool('grep'), 'grep');
  assert.equal(classifyTool('web_fetch'), 'web');
  assert.equal(classifyTool('some_custom_tool'), 'other');
});

// ---------------------------------------------------------------------------
// 行骨架（O1）
// ---------------------------------------------------------------------------

function bigFile(): string {
  const lines: string[] = [
    "import { foo } from './foo';",
    "const bar = require('bar');",
    '',
    'class Widget {',
    '  // padding comment with long body --------------------------------------------------------',
    '  render() { return 1; }',
    '}',
    '',
    'function helper(a, b) {',
    ...Array.from({ length: 180 }, (_, i) => `  const pad${i} = '${'x'.repeat(80)}'; // body filler line ${i}`),
    '  return 0;',
    '}',
    '# Title',
    '## Error handling',
    'failed step detected here',
  ];
  return lines.join('\n');
}

test('renderSkeleton：totalLines / nonEmptyRanges / keyLines 正确', () => {
  const s = renderSkeleton('import x\n\nclass A {}\n\ndef f():\n  pass\n# Heading\nerror: boom\n');
  assert.equal(s.totalLines, 8); // 末尾换行产生的空行不计
  assert.deepEqual(s.nonEmptyRanges, [[1, 1], [3, 3], [5, 8]]);
  const tags = s.keyLines.map((k) => [k.line, k.tag]);
  assert.deepEqual(tags, [[1, 'import'], [3, 'class'], [5, 'def'], [7, 'heading'], [8, 'error']]);
});

test('行骨架注入 token < 原文 10%（O1 断言）', () => {
  const text = bigFile();
  const skeleton = renderSkeleton(text);
  const injected = skeletonToText(skeleton);
  assert.ok(text.length > 10000, `fixture too small: ${text.length}`);
  assert.ok(
    injected.length < text.length * 0.1,
    `skeleton ${injected.length} chars vs raw ${text.length} chars`,
  );
});

test('重复读：第二次注入（"内容未变化"字面量）< 首次骨架 10%', () => {
  const ledger = new ObservationLedger();
  const text = bigFile();
  const first = ledger.observe(obs({ key: 'big.ts', content: text }));
  assert.equal(first.payload.kind, 'skeleton');
  const second = ledger.observe(obs({ key: 'big.ts', content: text }));
  assert.equal(second.payload.kind, 'unchanged');
  assert.ok(
    UNCHANGED_TEXT.length < (first.payload as { rendered: string }).rendered.length * 0.1,
  );
});

// ---------------------------------------------------------------------------
// tf-peek（O2）
// ---------------------------------------------------------------------------

test('peek：按行段取回，1-based 闭区间', () => {
  const ledger = new ObservationLedger();
  const r = ledger.observe(obs({ key: 'a.ts', content: 'l1\nl2\nl3\nl4\nl5' }));
  const handle = r.handle!;
  assert.equal(ledger.peek(handle, 2, 4), 'l2\nl3\nl4');
  assert.equal(ledger.peek(handle, 1, 1), 'l1');
  assert.equal(ledger.peek(handle, 5, 5), 'l5');
});

test('peek：越界收敛；空段返回空串；未知句柄返回 null', () => {
  const ledger = new ObservationLedger();
  const r = ledger.observe(obs({ key: 'a.ts', content: 'l1\nl2\nl3' }));
  const handle = r.handle!;
  assert.equal(ledger.peek(handle, -5, 99), 'l1\nl2\nl3');
  assert.equal(ledger.peek(handle, 7, 9), '');
  assert.equal(ledger.peek('obs:read:nope@v1', 1, 2), null);
});

// ---------------------------------------------------------------------------
// 句柄目录差分（O3）
// ---------------------------------------------------------------------------

test('directoryDelta：added / changed / stale 三列表', () => {
  const ledger = new ObservationLedger();
  const r1 = ledger.observe(obs({ tool: 'tf-write', key: 'a.ts', content: 'v1' }));
  const delta1 = ledger.directoryDelta(0);
  assert.deepEqual(delta1.added.map((e) => e.key), ['a.ts']);
  assert.deepEqual(delta1.changed, []);
  assert.deepEqual(delta1.stale, []);

  ledger.observe(obs({ tool: 'tf-read', key: 'b.ts', content: 'read v1' })); // b.ts 新增
  ledger.observe(obs({ tool: 'tf-write', key: 'a.ts', content: 'v2' })); // a.ts 变更
  const staleSeq = ledger.markStale('b.ts');
  assert.notEqual(staleSeq, null);
  assert.equal(ledger.markStale('no-such-key'), null); // 未知 key 返回 null

  const delta = ledger.directoryDelta(r1.seq);
  // 每个条目只按"当前状态"出现在一个列表里：b.ts 新增后又失效 → 记 stale
  assert.deepEqual(delta.added.map((e) => e.key), []);
  assert.deepEqual(delta.changed.map((e) => e.key), ['a.ts']);
  assert.deepEqual(delta.stale.map((e) => e.key), ['b.ts']);
  // 游标推进到 staleSeq 之后无新增/变更/失效
  const empty = ledger.directoryDelta(staleSeq!);
  assert.deepEqual(empty.added, []);
  assert.deepEqual(empty.changed, []);
  assert.deepEqual(empty.stale, []);
});

test('句柄版本语义：同 key 新内容版本递增，handle 形如 obs:<family>:<callId>@v<n>', () => {
  const ledger = new ObservationLedger();
  const r1 = ledger.observe(obs({ tool: 'tf-write', key: 'a.ts', callId: 'c1', content: 'v1' }));
  const r2 = ledger.observe(obs({ tool: 'tf-write', key: 'a.ts', callId: 'c2', content: 'v2' }));
  assert.equal(r1.handle, 'obs:write:c1@v1');
  assert.equal(r2.handle, 'obs:write:c2@v2');
  assert.notEqual(r1.handle, r2.handle);
});

// ---------------------------------------------------------------------------
// 饥饿防线（M2 关键防线）
// ---------------------------------------------------------------------------

test('饥饿防线：连续 5 步无 high 注入，第 5 步触发升级注入', () => {
  const ledger = new ObservationLedger({ starvationThreshold: 5 });
  const write = ledger.observe(obs({ tool: 'tf-write', key: 'out.ts', content: 'result\n'.repeat(20) }));
  assert.equal(write.info_gain, 'low');

  for (let step = 1; step <= 4; step++) {
    const promoted = ledger.noteStep(false);
    assert.equal(promoted, null, `step ${step} 不应触发`);
  }
  const fifth = ledger.noteStep(false);
  assert.ok(fifth, '第 5 步必须触发升级注入');
  assert.equal(fifth!.reason, 'starvation-promotion');
  assert.equal(fifth!.info_gain, 'high');
  assert.equal(fifth!.handle, write.handle);
  assert.equal(fifth!.payload.kind, 'skeleton');
});

test('饥饿防线：有 high 注入的步清零计数；触发后重新计数', () => {
  const ledger = new ObservationLedger({ starvationThreshold: 3 });
  ledger.observe(obs({ tool: 'tf-write', key: 'a', content: 'x1' }));
  ledger.noteStep(false);
  ledger.noteStep(false);
  ledger.noteStep(true); // high 注入 → 清零
  assert.equal(ledger.noteStep(false), null);
  assert.equal(ledger.noteStep(false), null);
  const third = ledger.noteStep(false);
  assert.ok(third, '清零后重新累计到阈值应再次触发');
});

test('饥饿防线：无 low 观测时不触发也不清零', () => {
  const ledger = new ObservationLedger({ starvationThreshold: 2 });
  assert.equal(ledger.noteStep(false), null);
  assert.equal(ledger.noteStep(false), null); // 无 low 可升级 → 不触发
  ledger.observe(obs({ tool: 'tf-write', key: 'a', content: 'x' }));
  // drySteps 已是 2 ≥ 阈值，下一个 dry step 应立即升级
  assert.ok(ledger.noteStep(false));
});

test('饥饿防线阈值可配置且校验非法值', () => {
  assert.throws(() => new ObservationLedger({ starvationThreshold: 0 }), RangeError);
  assert.throws(() => new ObservationLedger({ starvationThreshold: 1.5 }), RangeError);
  const ledger = new ObservationLedger({ starvationThreshold: 1 });
  ledger.observe(obs({ tool: 'tf-write', key: 'a', content: 'x' }));
  assert.ok(ledger.noteStep(false)); // 阈值 1：一步即触发
});

// ---------------------------------------------------------------------------
// 计数器与 injected_ratio（08 号 METRICS.md 口径）
// ---------------------------------------------------------------------------

test('injected_ratio：模拟 10 次 write 任务，ratio ≤ 0.2', () => {
  const ledger = new ObservationLedger(); // 默认阈值 5
  for (let i = 1; i <= 10; i++) {
    ledger.observe(obs({ tool: 'tf-write', key: `f${i}.ts`, content: `content ${i}\n`.repeat(10) }));
    ledger.noteStep(false); // write 任务无 high 注入
  }
  const c = ledger.counters();
  assert.equal(c.produced, 10);
  assert.equal(c.injected, 2); // 第 5、10 步各升级一次
  assert.equal(c.peeked, 0);
  assert.equal(ledger.injectedRatio(), 0.2);
  assert.ok(ledger.injectedRatio() <= 0.2);
});

test('injected_ratio：produced=0 时为 0；peek 计入 peeked 与 injected', () => {
  const ledger = new ObservationLedger();
  assert.equal(ledger.injectedRatio(), 0);
  const r = ledger.observe(obs({ key: 'a.ts', content: 'l1\nl2' }));
  ledger.peek(r.handle!, 1, 1);
  const c = ledger.counters();
  assert.equal(c.peeked, 1);
  assert.equal(c.produced, 1);
  assert.equal(c.injected, 2); // high 骨架 1 + peek 片段 1
  assert.equal(ledger.injectedRatio(), 2);
});

test('reset：全部状态清零', () => {
  const ledger = new ObservationLedger();
  ledger.observe(obs({ key: 'a.ts', content: 'x' }));
  ledger.noteStep(false);
  ledger.reset();
  assert.deepEqual(ledger.counters(), { injected: 0, produced: 0, peeked: 0 });
  assert.deepEqual(ledger.records(), []);
  assert.deepEqual(ledger.directoryDelta(0), { added: [], changed: [], stale: [] });
});

// ---------------------------------------------------------------------------
// BlobSink 注入（红线：IO 只经 sink 出口）
// ---------------------------------------------------------------------------

test('BlobSink：内容经注入的 sink 落盘，内核自身无 IO 副作用', () => {
  const sink = new InMemoryBlobSink();
  const ledger = new ObservationLedger({ sink });
  const r = ledger.observe(obs({ key: 'a.ts', content: 'blob-content' }));
  assert.equal(sink.get(r.handle!), 'blob-content');
});
