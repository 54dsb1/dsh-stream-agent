// kernel/state.ts 单测（分派 02 验收）
// 运行：node --test test/   （Node ≥24 原生 TS type-stripping，零依赖）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StateStore,
  MemoryBlobSink,
  InvalidStateWriteError,
  UnknownHandleError,
  CycleError,
  formatHandle,
  parseHandle,
  type BlobSink,
  type StateHandle,
} from '../src/kernel/state.ts';

// ---------------------------------------------------------------------------
// I2 不变量（验收：至少 3 个负例）
// ---------------------------------------------------------------------------

test('I2 负例 1：derived 写入不填 derivedFrom 必须抛 InvalidStateWriteError', () => {
  const store = new StateStore();
  assert.throws(
    () => store.set('n1', 'v', { confidence: 'derived' }),
    (e: unknown) => e instanceof InvalidStateWriteError && /I2 violation/.test(e.message),
  );
});

test('I2 负例 2：derived 写入 derivedFrom 为空数组必须抛错（不许静默修正）', () => {
  const store = new StateStore();
  assert.throws(
    () => store.set('n2', 'v', { confidence: 'derived', derivedFrom: [] }),
    InvalidStateWriteError,
  );
});

test('I2 负例 3：stated 写入携带 derivedFrom 必须抛错', () => {
  const store = new StateStore();
  assert.throws(
    () => store.set('n3', 'v', { confidence: 'stated', derivedFrom: ['src'] }),
    InvalidStateWriteError,
  );
});

test('I2 负例 4：derivedFrom 含空字符串条目必须抛错', () => {
  const store = new StateStore();
  assert.throws(
    () => store.set('n4', 'v', { confidence: 'derived', derivedFrom: ['ok', ''] }),
    InvalidStateWriteError,
  );
});

test('I2 正例：stated（缺省）与 derived（带来源）都合法，节点只读', () => {
  const store = new StateStore();
  const a = store.set('a', 1);
  assert.equal(a.confidence, 'stated');
  assert.equal(a.derivedFrom, undefined);
  const b = store.set('b', 2, { confidence: 'derived', derivedFrom: ['a'] });
  assert.deepEqual(b.derivedFrom, ['a']);
  assert.throws(() => {
    (b as { confidence: string }).confidence = 'stated';
  });
});

test('I2 附带不变量：同一 id 重复写入抛错（节点不可变）', () => {
  const store = new StateStore();
  store.set('dup', 1);
  assert.throws(() => store.set('dup', 2), InvalidStateWriteError);
});

// ---------------------------------------------------------------------------
// trace 来源链（验收：三级 derived 链，断言顺序与去重；含环检测）
// ---------------------------------------------------------------------------

test('trace：三级 derived 链返回完整来源（顺序：自身 → 逐级向上）', () => {
  const store = new StateStore();
  store.set('root', 'r'); // stated
  store.set('l1', 'a', { confidence: 'derived', derivedFrom: ['root'] });
  store.set('l2', 'b', { confidence: 'derived', derivedFrom: ['l1'] });
  store.set('l3', 'c', { confidence: 'derived', derivedFrom: ['l2'] });

  const chain = store.trace('l3');
  assert.deepEqual(
    chain.map((n) => n.id),
    ['l3', 'l2', 'l1', 'root'],
  );
  assert.equal(chain[chain.length - 1].confidence, 'stated');
});

test('trace：菱形依赖去重（两个父节点共享同一祖先，祖先只出现一次）', () => {
  const store = new StateStore();
  store.set('r', 0);
  store.set('x', 1, { confidence: 'derived', derivedFrom: ['r'] });
  store.set('y', 2, { confidence: 'derived', derivedFrom: ['r'] });
  store.set('top', 3, { confidence: 'derived', derivedFrom: ['x', 'y'] });

  const chain = store.trace('top');
  assert.deepEqual(
    chain.map((n) => n.id),
    ['top', 'x', 'r', 'y'],
  );
  const ids = chain.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, '必须无重复节点');
});

test('trace：环检测抛 CycleError（前向引用构造 A→B→A）', () => {
  const store = new StateStore();
  // 前向引用：写入时引用尚未存在的节点，环在 trace 展开期被检测
  store.set('a', 1, { confidence: 'derived', derivedFrom: ['b'] });
  store.set('b', 2, { confidence: 'derived', derivedFrom: ['a'] });
  assert.throws(() => store.trace('a'), CycleError);
  assert.throws(() => store.trace('b'), CycleError);
});

test('trace：未知节点抛 UnknownHandleError；来源节点缺失也抛 UnknownHandleError', () => {
  const store = new StateStore();
  assert.throws(() => store.trace('ghost'), UnknownHandleError);
  store.set('orphan', 1, { confidence: 'derived', derivedFrom: ['ghost'] });
  assert.throws(() => store.trace('orphan'), UnknownHandleError);
});

// ---------------------------------------------------------------------------
// 内容寻址幂等性（验收：同一内容写两次 handle 深比较相等）
// ---------------------------------------------------------------------------

test('同一内容写两次返回的 handle 深比较相等（blob 句柄）', () => {
  const store = new StateStore();
  const h1 = store.put('hello world');
  const h2 = store.put('hello world');
  assert.deepEqual(h1, h2);
  assert.equal(formatHandle(h1), formatHandle(h2));
  assert.match(formatHandle(h1), /^blob:[0-9a-f]{8}@v1$/);
  assert.equal(h1.version, 1);
});

test('同一内容写两次返回的 handle 深比较相等（file 句柄）', () => {
  const store = new StateStore();
  const h1 = store.put('file content', { kind: 'file', path: 'src/app.ts' });
  const h2 = store.put('file content', { kind: 'file', path: 'src/app.ts' });
  assert.deepEqual(h1, h2);
  assert.equal(formatHandle(h1), 'file:src/app.ts@v1');
});

test('同路径不同内容版本递增；重写旧内容版本号复用', () => {
  const store = new StateStore();
  const v1 = store.put('A', { kind: 'file', path: 'f.txt' });
  const v2 = store.put('B', { kind: 'file', path: 'f.txt' });
  assert.equal(v2.version, 2);
  assert.notEqual(v1.hash, v2.hash);
  const v1again = store.put('A', { kind: 'file', path: 'f.txt' });
  assert.deepEqual(v1again, v1, '旧内容重写必须复用 v1');
  const v3 = store.put('C', { kind: 'file', path: 'f.txt' });
  assert.equal(v3.version, 3, '新内容接续最大版本号');
});

test('obs 句柄格式 obs:<tool>:<callId>@v<n>；file 缺 path / obs 缺 tool+callId 抛错', () => {
  const store = new StateStore();
  const h = store.put('stdout text', { kind: 'obs', tool: 'tf-bash', callId: 'call-7' });
  assert.equal(formatHandle(h), 'obs:tf-bash:call-7@v1');
  assert.deepEqual(store.put('stdout text', { kind: 'obs', tool: 'tf-bash', callId: 'call-7' }), h);
  assert.throws(() => store.put('x', { kind: 'file' }), InvalidStateWriteError);
  assert.throws(() => store.put('x', { kind: 'obs', tool: 't' }), InvalidStateWriteError);
});

test('get：字符串写入还原 string，字节写入还原 Uint8Array', () => {
  const store = new StateStore();
  const hs = store.put('中文文本');
  assert.equal(store.get(hs), '中文文本');
  const bytes = new Uint8Array([1, 2, 3, 0xff]);
  const hb = store.put(bytes);
  assert.deepEqual(store.get(hb), bytes);
});

test('get：伪造/版本不符/未知 kind 句柄抛 UnknownHandleError', () => {
  const store = new StateStore();
  const h = store.put('data', { kind: 'file', path: 'a.txt' });
  assert.throws(
    () => store.get({ ...h, version: 9 }),
    (e: unknown) => e instanceof UnknownHandleError && /actual version/.test(e.message),
  );
  assert.throws(
    () => store.get({ kind: 'weird' as never, path: 'a.txt', version: 1, hash: h.hash }),
    UnknownHandleError,
  );
  assert.throws(() => store.get(null as never), UnknownHandleError);
});

test('handles：句柄目录按创建顺序返回且去重', () => {
  const store = new StateStore();
  const h1 = store.put('one', { kind: 'file', path: '1.txt' });
  const h2 = store.put('blob-two');
  store.put('one', { kind: 'file', path: '1.txt' }); // 重复，不应新增目录项
  const all = store.handles();
  assert.deepEqual(all.map(formatHandle), [formatHandle(h1), formatHandle(h2)]);
});

test('parseHandle：合法句柄往返解析；非法格式抛 UnknownHandleError', () => {
  const h = parseHandle('file:src/app.ts@v3');
  assert.equal(h.kind, 'file');
  assert.equal(h.path, 'src/app.ts');
  assert.equal(h.version, 3);
  assert.equal(parseHandle('obs:tf-read:call-1@v2').kind, 'obs');
  assert.equal(parseHandle('blob:1a2b3c4d@v1').path, '1a2b3c4d');
  for (const bad of ['file:x@v0', 'file:x', 'file:@v1', 'weird:x@v1', 'blob:xyz@v1', 'file:x@vX']) {
    assert.throws(() => parseHandle(bad), UnknownHandleError, `应拒绝: ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

test('diff：内容一致返回空串', () => {
  const store = new StateStore();
  const a = store.put('same\nlines', { kind: 'file', path: 'x.ts' });
  const b = store.put('same\nlines', { kind: 'file', path: 'x.ts' });
  assert.equal(store.diff(a, b), '');
});

test('diff：混合增删改输出 unified 风格差异（无上下文行）', () => {
  const store = new StateStore();
  const from = store.put('a\nb\nc\nd\ne', { kind: 'file', path: 'f' });
  const to = store.put('a\nX\nc\nd\ne\nf\ng', { kind: 'file', path: 'f' });
  const text = store.diff(from, to);
  assert.equal(text, [
    `--- ${formatHandle(from)}`,
    `+++ ${formatHandle(to)}`,
    '@@ -2,1 +2,1 @@',
    '-b',
    '+X',
    '@@ -5,0 +6,2 @@',
    '+f',
    '+g',
  ].join('\n'));
});

test('diff：纯删除（count=0 用变更点前一行约定）与句柄头部还原内容', () => {
  const store = new StateStore();
  const from = store.put('keep\ndrop1\ndrop2\nkeep2', { kind: 'file', path: 'f' });
  const to = store.put('keep\nkeep2', { kind: 'file', path: 'f' });
  const text = store.diff(from, to);
  assert.ok(text.includes('@@ -2,2 +1,0 @@'), text);
  assert.ok(text.includes('-drop1') && text.includes('-drop2'), text);
  // diff 结果可由句柄重新取回原文
  assert.equal(store.get(from), 'keep\ndrop1\ndrop2\nkeep2');
});

test('diff：尾部纯删除（from 比 to 多出结尾行）', () => {
  const store = new StateStore();
  const from = store.put('head\nextra1\nextra2', { kind: 'file', path: 'f' });
  const to = store.put('head', { kind: 'file', path: 'f' });
  const text = store.diff(from, to);
  assert.equal(text, [
    `--- ${formatHandle(from)}`,
    `+++ ${formatHandle(to)}`,
    '@@ -2,2 +1,0 @@',
    '-extra1',
    '-extra2',
  ].join('\n'));
});

// ---------------------------------------------------------------------------
// BlobSink 注入与错误传播
// ---------------------------------------------------------------------------

test('自定义 BlobSink 被用于读写（依赖注入走构造参数）', () => {
  const writes: string[] = [];
  const backing = new Map<string, Uint8Array>();
  const sink: BlobSink = {
    write(key, data) {
      writes.push(key);
      backing.set(key, data);
    },
    read(key) {
      return backing.get(key);
    },
  };
  const store = new StateStore(sink);
  const h = store.put('sink test');
  assert.deepEqual(writes, [h.hash]);
  assert.equal(store.get(h), 'sink test');
});

test('sink 数据丢失时 get 抛 UnknownHandleError（BlobSink 是唯一 IO 出口）', () => {
  const store = new StateStore({
    write: () => {},
    read: () => undefined,
  });
  const h = store.put('lost');
  assert.throws(
    () => store.get(h),
    (e: unknown) => e instanceof UnknownHandleError && /blob missing/.test(e.message),
  );
});

test('MemoryBlobSink 基本语义：写入可读回，未写键返回 undefined', () => {
  const sink = new MemoryBlobSink();
  const data = new Uint8Array([9, 8, 7]);
  sink.write('k', data);
  assert.deepEqual(sink.read('k'), data);
  assert.equal(sink.read('missing'), undefined);
});

// ---------------------------------------------------------------------------
// sha256 正确性抽查
// ---------------------------------------------------------------------------

test('hash 是内容 sha256 hex（与已知向量比对）', () => {
  const store = new StateStore();
  const h = store.put('hello');
  // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
  assert.equal(h.hash, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  const hb = store.put(new Uint8Array([0xfc]));
  // blob 句柄的 path 就是 hash 前 8 位（内容寻址一致性）
  assert.equal(hb.path, hb.hash.slice(0, 8));
  assert.equal(hb.kind, 'blob');
});

// ---------------------------------------------------------------------------
// 句柄类型完整性（供 06/07 适配层引用的形状断言）
// ---------------------------------------------------------------------------

test('StateHandle / StateNode 形状符合分派 02 接口设计', () => {
  const store = new StateStore();
  const handle: StateHandle = store.put('x', { kind: 'file', path: 'p' });
  assert.equal(new Set(['file', 'blob', 'obs']).has(handle.kind), true);
  assert.equal(typeof handle.version, 'number');
  assert.equal(typeof handle.hash, 'string');

  const node = store.set('shape', { any: 'value' }, { confidence: 'derived', derivedFrom: ['a'] });
  void node; // derivedFrom 前向引用合法（'a' 尚未写入），见 trace 负例
  assert.equal(typeof node.createdAt, 'number');
  assert.deepEqual(node.derivedFrom, ['a']);
});
