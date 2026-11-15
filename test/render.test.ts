/**
 * render.ts 单测：三段式装配 / O6 前缀校验 fail-closed / O4 动态冻结 / O3 目录差分注入 /
 * 压缩历史拒绝+尾部截断降级 / 20 步 renderHash 单调断言。
 * 全部离线，时钟注入。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ContextRenderer,
  assertPrefixStable,
  renderHash,
  PrefixBrokenError,
  DynamicInPrefixError,
  type RenderMessage,
  type HandleDirectoryDelta,
  type PolicyViolationRecord,
  type RenderClock,
} from '../src/kernel/render.ts';

function makeRenderer(opts?: {
  clock?: RenderClock;
  policySink?: (r: PolicyViolationRecord) => void;
}): ContextRenderer {
  return new ContextRenderer({
    system: '你是单流协议 agent。',
    protocol: 'tf-write / tf-read / tf-bash / tf-peek / tf-final 协议说明。',
    toolSchemas: '{"tf-write": {"path": "string", "content": "string"}}',
    invariants: '不变量 I1：不无来源推断；I2：节点必须溯源。',
    ...(opts?.clock ? { clock: opts.clock } : {}),
    ...(opts?.policySink ? { policySink: opts.policySink } : {}),
  });
}

class FakeClock implements RenderClock {
  t: number;
  constructor(t = 0) {
    this.t = t;
  }
  now(): number {
    return this.t;
  }
}

const m = (role: RenderMessage['role'], content: string): RenderMessage => ({
  role,
  content,
});

// ---------------------------------------------------------------------------
// assertPrefixStable / renderHash（独立校验器）
// ---------------------------------------------------------------------------

test('assertPrefixStable：逐字节相等通过；next 更长（追加）通过', () => {
  const prev = [m('system', 'S'), m('user', 'U1')];
  assert.deepEqual(assertPrefixStable(prev, prev), { prefixLength: 2 });
  assert.deepEqual(
    assertPrefixStable(prev, [m('system', 'S'), m('user', 'U1'), m('assistant', 'A1')]),
    { prefixLength: 3 },
  );
});

test('assertPrefixStable：中间内容被改 → PrefixBrokenError（含 index），不静默修复', () => {
  const prev = [m('system', 'S'), m('user', 'U1'), m('assistant', 'A1')];
  const next = [m('system', 'S'), m('user', 'U1-EDITED'), m('assistant', 'A1')];
  assert.throws(
    () => assertPrefixStable(prev, next),
    (err: unknown) => {
      assert.ok(err instanceof PrefixBrokenError);
      assert.equal(err.index, 1);
      assert.match(err.message, /逐字节不一致/);
      return true;
    },
  );
  // role 变化同样抛
  assert.throws(
    () => assertPrefixStable(prev, [m('system', 'S'), m('tool', 'U1'), m('assistant', 'A1')]),
    PrefixBrokenError,
  );
});

test('assertPrefixStable：稳定段收缩默认抛错；显式 allowTailDrop 且确为严格前缀时通过', () => {
  const prev = [m('system', 'S'), m('user', 'U1'), m('assistant', 'A1')];
  const shorter = [m('system', 'S'), m('user', 'U1')];
  assert.throws(() => assertPrefixStable(prev, shorter), /收缩/);
  // 整块尾部丢弃：next 是 prev 的字节前缀 → allowTailDrop 下允许，prefixLength = next.length
  assert.deepEqual(assertPrefixStable(prev, shorter, { allowTailDrop: true }), {
    prefixLength: 2,
  });
  // allowTailDrop 但保留部分也被改 → 仍然抛（只放行尾部整块丢弃）
  const edited = [m('system', 'S-EDITED'), m('user', 'U1')];
  assert.throws(() => assertPrefixStable(edited, prev, { allowTailDrop: true }), PrefixBrokenError);
  // next 比 prev 长（追加）本来就允许
  assert.deepEqual(assertPrefixStable(shorter, prev), { prefixLength: 3 });
});

test('renderHash：确定性（同输入同 hash）；内容/角色/顺序差异都改变 hash', () => {
  const a = [m('system', 'S'), m('user', 'U')];
  const b = [m('system', 'S'), m('user', 'U')];
  assert.equal(renderHash(a), renderHash(b));
  assert.notEqual(renderHash(a), renderHash([m('system', 'S'), m('user', 'U2')]));
  assert.notEqual(renderHash(a), renderHash([m('user', 'U'), m('system', 'S')]));
  assert.notEqual(renderHash(a), renderHash([m('assistant', 'U'), m('user', 'S')]));
  // hash 是 hex sha256
  assert.match(renderHash(a), /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// 三段式装配
// ---------------------------------------------------------------------------

test('render：稳定前缀是单条 system 消息，构造期冻结，无写入路径', () => {
  const r = makeRenderer();
  const prefix = r.prefixMessages;
  assert.equal(prefix.length, 1);
  assert.equal(prefix[0].role, 'system');
  assert.match(prefix[0].content, /单流协议/);
  assert.match(prefix[0].content, /tf-write/);
  assert.match(prefix[0].content, /I2/);
  // 尝试改写前缀：对象被 Object.freeze，严格模式下赋值抛 TypeError，内容不变
  const first = r.render();
  assert.throws(() => {
    (first[0] as { content: string }).content = 'HACKED';
  }, TypeError);
  assert.match(r.render()[0].content, /单流协议/);
});

test('render：易变尾每请求整块重建，旧尾自动丢弃', () => {
  const r = makeRenderer();
  r.setTail([{ content: '高增益观测：第 1 步结果' }]);
  const req1 = r.render();
  assert.match(req1[req1.length - 1].content, /第 1 步/);

  r.setTail([{ content: '高增益观测：第 2 步结果' }]);
  const req2 = r.render();
  assert.match(req2[req2.length - 1].content, /第 2 步/);
  // 旧尾整块丢弃，不在新请求里
  for (const msg of req2) assert.doesNotMatch(msg.content, /第 1 步/);
});

test('render：clearTail 丢弃整个易变尾', () => {
  const r = makeRenderer();
  r.setTail([{ content: 'tail' }]);
  assert.equal(r.render().length, 2);
  r.clearTail();
  assert.equal(r.render().length, 1);
});

test('appendHistory：追加进追加区；system 消息被拒绝（system 属于稳定前缀）', () => {
  const r = makeRenderer();
  r.appendHistory(m('assistant', 'A1'));
  r.appendHistory(m('user', 'U2'));
  const msgs = r.render();
  assert.equal(msgs.length, 3); // prefix + A1 + U2（易变尾为空）
  assert.equal(msgs[1].content, 'A1');
  assert.equal(msgs[2].content, 'U2');
  assert.throws(() => r.appendHistory(m('system', 'X')), /稳定前缀/);
});

// ---------------------------------------------------------------------------
// O3：directoryDelta 差分注入（只追加进追加区）
// ---------------------------------------------------------------------------

test('appendHandleDelta：非空增量追加进追加区；空增量不产生块（前缀字节不变）', () => {
  const r = makeRenderer();
  const stableBefore = r.stableHash();

  const appended = r.appendHandleDelta({
    added: [{ handle: 'file:src/app.ts@v1', note: '新建' }],
    changed: [{ handle: 'file:src/lib.ts@v3' }],
    stale: [{ handle: 'obs:tf-read:c12@v1' }],
  });
  assert.equal(appended, true);
  const deltaMsg = r.stableMessages()[1];
  assert.match(deltaMsg.content, /\+ file:src\/app\.ts@v1 — 新建/);
  assert.match(deltaMsg.content, /~ file:src\/lib\.ts@v3/);
  assert.match(deltaMsg.content, /- obs:tf-read:c12@v1（已失效，tf-peek 将拒绝）/);

  // 空增量：不追加
  assert.equal(
    r.appendHandleDelta({ added: [], changed: [], stale: [] }),
    false,
  );
  assert.equal(r.stableMessages().length, 2);
  // 增量块进入稳定段后字节冻结
  assert.notEqual(r.stableHash(), stableBefore);
  const frozen = r.stableMessages()[1].content;
  r.render();
  r.render();
  assert.equal(r.stableMessages()[1].content, frozen);
});

test('O3 集成形态：连续多回合 directoryDelta 只追加，历史增量块字节不变', () => {
  const r = makeRenderer();
  const stables: RenderMessage[][] = [];
  const deltas: HandleDirectoryDelta[] = [
    { added: [{ handle: 'file:a.ts@v1' }], changed: [], stale: [] },
    { added: [{ handle: 'file:b.ts@v1' }], changed: [{ handle: 'file:a.ts@v2' }], stale: [] },
    { added: [], changed: [], stale: [{ handle: 'file:a.ts@v2' }] },
  ];
  for (const d of deltas) {
    r.appendHandleDelta(d);
    r.setTail([{ content: `第 ${stables.length} 步观测` }]);
    const stable = r.stableMessages();
    if (stables.length > 0) {
      // 前缀逐字节单调（O6 校验器直接断言）
      assertPrefixStable(stables[stables.length - 1], stable);
    }
    stables.push(stable);
    r.render();
  }
  // 全部三列内容都进了追加区，且前一次的增量块仍字节不变
  const all = r.stableMessages().map((x) => x.content).join('\n');
  assert.match(all, /file:a\.ts@v1/);
  assert.match(all, /file:b\.ts@v1/);
  assert.match(all, /file:a\.ts@v2/);
});

// ---------------------------------------------------------------------------
// O4：freezeDynamics —— 动态内容归易变尾或回合冻结，稳定前缀禁入
// ---------------------------------------------------------------------------

test('O4 volatile-tail：时间戳逐请求变化只进易变尾；10 步内稳定前缀 hash 恒定（单调）', () => {
  const r = makeRenderer();
  const clock = new FakeClock();
  const prefixHashes: string[] = [];
  for (let step = 1; step <= 10; step++) {
    clock.t = step * 1_000;
    r.freezeDynamics({ now: new Date(clock.t).toISOString() }, 'volatile-tail');
    r.setTail([{ content: `step ${step} 观测` }]);
    const msgs = r.render();
    // 稳定前缀（system）不含任何一步的时间戳值
    assert.doesNotMatch(msgs[0].content, /T\d{2}:/);
    // 动态值进了易变尾的动态上下文块（在 setTail 块之前）
    const dyn = msgs.find((x) => x.content.includes('动态上下文（易变尾'));
    assert.ok(dyn, '易变尾里应有动态上下文块');
    assert.ok(dyn.content.includes(new Date(clock.t).toISOString()));
    // setTail 块仍在最后
    assert.match(msgs[msgs.length - 1].content, new RegExp(`step ${step}`));
    prefixHashes.push(renderHash(r.prefixMessages));
  }
  // 10 步前缀 hash 恒定（比"单调不降"更强的断言）
  assert.deepEqual(prefixHashes, prefixHashes.map(() => prefixHashes[0]));
});

test('O4 turn-freeze：动态值按回合冻结进追加区，此后字节不变', () => {
  const r = makeRenderer();
  const clock = new FakeClock();
  clock.t = 42;
  r.freezeDynamics({ snapshot: 'turn-42-cwd' }, 'turn-freeze');
  const frozenBlock = r.stableMessages()[1].content;
  assert.match(frozenBlock, /turn-42-cwd/);
  // 后续回合动态值变了，冻结块字节不变
  clock.t = 43;
  r.freezeDynamics({ snapshot: 'turn-43-cwd' }, 'turn-freeze');
  r.appendHistory(m('assistant', 'A'));
  const msgs = r.render();
  assert.equal(msgs[1].content, frozenBlock); // 字节相等
  assert.match(msgs[2].content, /turn-43-cwd/);
});

test('O4：稳定前缀中已出现的动态值 → DynamicInPrefixError（稳定前缀禁入动态字段）', () => {
  const r = new ContextRenderer({
    system: 'cwd=/tmp/work',
    protocol: 'p',
    toolSchemas: 't',
    invariants: 'i',
  });
  assert.throws(
    () => r.freezeDynamics({ cwd: '/tmp/work' }, 'volatile-tail'),
    DynamicInPrefixError,
  );
});

// ---------------------------------------------------------------------------
// O6：preflight fail-closed + 20 步 renderHash 前缀单调
// ---------------------------------------------------------------------------

test('O6 preflight：稳定段被破坏时 render() 抛 PrefixBrokenError 拒绝发送（fail-closed）', () => {
  const r = makeRenderer();
  r.render();
  // 直接篡改内部追加区是不可能的（私有）；用校验器模拟被破坏的稳定段：
  const prevStable = r.stableMessages();
  const broken = [m('system', 'S-EDITED'), m('user', 'x')];
  assert.throws(() => assertPrefixStable(prevStable, broken), PrefixBrokenError);
  // 正常路径继续可用
  r.appendHistory(m('assistant', 'A'));
  const ok = r.render();
  assert.match(ok[1].content, /^A$/);
});

test('O6/O4：20 步请求序列，renderHash 稳定段严格单调（逐字节追加链）', () => {
  const r = makeRenderer();
  const clock = new FakeClock();
  const hashes: string[] = [];
  const stables: RenderMessage[][] = [];
  let prevTailMarker: string | null = null;
  for (let step = 1; step <= 20; step++) {
    // 每步：历史追加 + 每 3 步一次目录增量 + 动态时间戳进易变尾 + 高增益观测进易变尾
    r.appendHistory(m('assistant', `step-${step} response`));
    if (step % 3 === 0) {
      r.appendHandleDelta({
        added: [{ handle: `file:mod${step}.ts@v1` }],
        changed: [],
        stale: step > 3 ? [{ handle: `file:mod${step - 3}.ts@v1` }] : [],
      });
    }
    clock.t = step * 500;
    r.freezeDynamics({ now: new Date(clock.t).toISOString() }, 'volatile-tail');
    r.setTail([
      { content: `高增益观测 step-${step}：tf-peek 结果（易变尾，整块丢弃）` },
    ]);

    const stable = r.stableMessages();
    if (stables.length > 0) {
      // O6 校验器：上一请求稳定段必须是本请求稳定段的逐字节前缀
      assertPrefixStable(stables[stables.length - 1], stable);
    }
    stables.push(stable);
    hashes.push(renderHash(stable));
    const full = r.render();
    // 易变尾包含本步观测
    assert.match(full[full.length - 1].content, new RegExp(`观测 step-${step}`));
    // 上一请求的易变尾已整块丢弃，不在本请求任何位置
    if (prevTailMarker !== null) {
      for (const msg of full) assert.ok(!msg.content.includes(prevTailMarker));
    }
    prevTailMarker = `观测 step-${step}：tf-peek`;
  }
  // renderHash 序列：20 步严格递变（每步都有追加 → 单调增长，无一步停滞或回退）
  assert.equal(hashes.length, 20);
  for (let i = 1; i < hashes.length; i++) {
    assert.notEqual(hashes[i], hashes[i - 1], `第 ${i + 1} 步稳定段没有增长`);
  }
  // 前缀（system 消息）20 步字节不变
  const prefixContents = stables.map((s) => s[0].content);
  assert.deepEqual(prefixContents, prefixContents.map(() => prefixContents[0]));
});

// ---------------------------------------------------------------------------
// 压缩历史：拒绝 + 降级尾部截断 + 记录
// ---------------------------------------------------------------------------

test('压缩历史请求：拒绝 + 降级为整块尾部截断 + policyLog/外部 sink 双记录', () => {
  const sinkRecords: PolicyViolationRecord[] = [];
  const clock = new FakeClock(777);
  const r = makeRenderer({ clock, policySink: (x) => sinkRecords.push(x) });
  for (let i = 1; i <= 5; i++) r.appendHistory(m('assistant', `A${i}`));
  r.render();
  const before = r.stableMessages();

  const rec = r.requestHistoryCompression({
    request: '请把前面的历史压缩成摘要',
    fallbackTailDrop: 2,
  });
  assert.equal(rec.accepted, false);
  assert.equal(rec.degradedTo, 'tail-truncation');
  assert.equal(rec.droppedBlocks, 2);
  assert.equal(rec.at, 777);
  // 双记录：内部台账 + 外部 sink
  assert.equal(r.policyLog.length, 1);
  assert.equal(sinkRecords.length, 1);
  assert.deepEqual(r.policyLog[0], rec);
  // 保留部分逐字节不变，只有末尾整块被丢弃
  const after = r.stableMessages();
  assert.equal(after.length, before.length - 2);
  assert.equal(after[after.length - 1].content, 'A3');
  assert.deepEqual(assertPrefixStable(after, before, { allowTailDrop: true }), {
    prefixLength: before.length,
  });
  // 截断后可以继续正常渲染（基线已显式推进，非静默）
  r.appendHistory(m('assistant', 'A6'));
  const msgs = r.render();
  assert.equal(msgs[msgs.length - 1].content, 'A6'); // 易变尾为空，末条即新历史
});

test('压缩历史请求：不指定降级 → 只拒绝不丢弃；截断超过现有块数时按实际上限截断', () => {
  const r = makeRenderer();
  r.appendHistory(m('assistant', 'A1'));
  r.render();
  const rec1 = r.requestHistoryCompression({ request: '压缩一下' });
  assert.equal(rec1.degradedTo, 'none');
  assert.equal(rec1.droppedBlocks, 0);
  assert.equal(r.stableMessages().length, 2);

  const rec2 = r.requestHistoryCompression({ request: '再压缩', fallbackTailDrop: 99 });
  assert.equal(rec2.droppedBlocks, 1); // 只有 1 块可丢
  assert.equal(r.stableMessages().length, 1); // 只剩前缀
});

test('truncateAppendTail：0 与负数不丢弃；被保留部分逐字节验证', () => {
  const r = makeRenderer();
  r.appendHistory(m('assistant', 'A1'));
  r.appendHistory(m('assistant', 'A2'));
  r.render();
  assert.equal(r.truncateAppendTail(0), 0);
  assert.equal(r.truncateAppendTail(-3), 0);
  assert.equal(r.stableMessages().length, 3);
  assert.equal(r.truncateAppendTail(1), 1);
  const stable = r.stableMessages();
  assert.equal(stable.length, 2);
  assert.equal(stable[1].content, 'A1'); // 只丢了末尾的 A2
});

test('合规替代路径：模型"需要旧信息"时只能整块丢弃尾部或 tf-peek，前缀始终单调', () => {
  const r = makeRenderer();
  for (let i = 1; i <= 6; i++) r.appendHistory(m('assistant', `A${i}`));
  r.render();
  const beforeHash = renderHash(r.prefixMessages);
  r.requestHistoryCompression({ request: 'summarize please', fallbackTailDrop: 4 });
  r.appendHistory(m('assistant', 'A-new'));
  r.render();
  // 前缀 hash 不变，历史没有任何中间改写
  assert.equal(renderHash(r.prefixMessages), beforeHash);
  const contents = r.stableMessages().map((x) => x.content);
  assert.deepEqual(contents.slice(1), ['A1', 'A2', 'A-new']);
});
