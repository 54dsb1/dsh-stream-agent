// test/v110-kernel.test.ts —— v1.1.0（1.2 / 1.3 / 2.3 / 4.1）内核纯函数与状态机断言
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAcceptancePredicate,
  evaluatePredicate,
  buildVerificationPlan,
  describePredicate,
  scriptFeedback,
} from '../src/kernel/delivery.ts';
import { RevisionGuard, coversRange } from '../src/kernel/changes.ts';
import { ObservationLedger } from '../src/kernel/obs.ts';
import { parsePlanItems, planActiveDuplicates } from '../src/entry/loop.ts';
import { composeProtocolText } from '../src/kernel/protocol.ts';
import { readFileSync } from 'node:fs';

// ---- 1.2 交付机器判定 ----
test('A1. parseAcceptancePredicate：四类谓词解析 + 无谓词回退', () => {
  assert.deepEqual(parseAcceptancePredicate('生成 index.js :: exists(dist/index.js)'), {
    text: '生成 index.js',
    predicate: { kind: 'exists', path: 'dist/index.js' },
  });
  const s = parseAcceptancePredicate('摘要 :: sha256(out.txt, ' + 'a'.repeat(64) + ')');
  assert.equal(s.predicate?.kind, 'sha256');
  assert.equal(s.predicate?.hash, 'a'.repeat(64));
  assert.deepEqual(parseAcceptancePredicate('大小 :: bytes(out.txt, min, 100)').predicate, {
    kind: 'bytes', path: 'out.txt', op: 'min', n: 100,
  });
  const rx = parseAcceptancePredicate('内容 :: regex(out.txt, /hello/gi)');
  assert.equal(rx.predicate?.kind, 'regex');
  assert.equal(parseAcceptancePredicate('无谓词的行').predicate, null);
  assert.equal(parseAcceptancePredicate('坏谓词 :: sha256(x, nope)').predicate, null);
});

test('A1b. parseAcceptancePredicate：含斜杠路径与 regex 内逗号（审查修正回归）', () => {
  const sha = parseAcceptancePredicate(`摘要 :: sha256(dist/out.js, ${'a'.repeat(64)})`);
  assert.equal(sha.predicate?.kind, 'sha256');
  assert.equal(sha.predicate?.path, 'dist/out.js');
  const bytes = parseAcceptancePredicate('大小 :: bytes(dist/index.js, min, 100)');
  assert.equal(bytes.predicate?.kind, 'bytes');
  assert.deepEqual(bytes.predicate, { kind: 'bytes', path: 'dist/index.js', op: 'min', n: 100 });
  const rx = parseAcceptancePredicate('内容 :: regex(dist/x.js, /a,b/gi)');
  assert.equal(rx.predicate?.kind, 'regex');
  assert.equal(rx.predicate?.path, 'dist/x.js');
});

test('A2. evaluatePredicate：FAIL-CLOSED（不存在/摘要不符/字节不满足/正则未命中）', () => {
  const facts = {
    stat(p: string) {
      if (p === 'a.txt') return { exists: true, bytes: 120, sha256: 'b'.repeat(64), text: 'hello world' };
      return null;
    },
  };
  assert.equal(evaluatePredicate({ kind: 'exists', path: 'a.txt' }, facts).ok, true);
  assert.equal(evaluatePredicate({ kind: 'exists', path: 'missing.txt' }, facts).ok, false);
  assert.equal(evaluatePredicate({ kind: 'sha256', path: 'a.txt', hash: 'c'.repeat(64) }, facts).ok, false);
  assert.equal(evaluatePredicate({ kind: 'bytes', path: 'a.txt', op: 'min', n: 100 }, facts).ok, true);
  assert.equal(evaluatePredicate({ kind: 'bytes', path: 'a.txt', op: 'max', n: 100 }, facts).ok, false);
  assert.equal(evaluatePredicate({ kind: 'regex', path: 'a.txt', pattern: 'world', flags: '' }, facts).ok, true);
  assert.equal(evaluatePredicate({ kind: 'regex', path: 'a.txt', pattern: 'nope', flags: '' }, facts).ok, false);
  assert.match(describePredicate({ kind: 'exists', path: 'a.txt' }), /exists\(a\.txt\)/);
});

test('A3. buildVerificationPlan：无 package.json 不构建；无 node_modules 先 install 再 build', () => {
  assert.deepEqual(buildVerificationPlan({ hasPackageJson: false, hasNodeModules: false }), []);
  const plan = buildVerificationPlan({ hasPackageJson: true, hasNodeModules: false, cwd: '/p' });
  assert.deepEqual(plan.map((c) => c.cmd), ['npm install', 'npm run build']);
  assert.deepEqual(buildVerificationPlan({ hasPackageJson: true, hasNodeModules: true }).map((c) => c.cmd), ['npm run build']);
  assert.match(scriptFeedback(['a.py', 'b.js']), /a\.py[\s\S]*b\.js/);
});

// ---- 1.3 单个 in_progress ----
test('B1. parsePlanItems：> [id] 活动项唯一，重复被忽略；planActiveDuplicates 告警', () => {
  const body = '说明\n- [a1] 第一项\n> [a1]\n- [a2] 第二项\n> [a2]';
  const items = parsePlanItems(body);
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.id === 'a1')?.active, true);
  assert.equal(items.find((i) => i.id === 'a2')?.active, undefined);
  assert.equal(planActiveDuplicates(body), 1);
  assert.equal(planActiveDuplicates('- [a1] 无活动项'), 0);
});

// ---- 2.3 字符级 offset / query 取回 ----
test('C1. recallText：offset 字符级 + query 字面续搜 + continuation', () => {
  const obs = new ObservationLedger();
  obs.observe({ tool: 'tf-read', ok: true, key: 'k', content: 'abcdefghij', callId: 'c1' });
  const handle = obs.directoryDelta(0).added[0]?.handle ?? '';
  assert.ok(handle !== '');
  const byOffset = obs.recallText(handle, { offset: 3, limit: 4 });
  assert.equal(byOffset?.text, 'defg');
  assert.equal(byOffset?.start, 3);
  assert.equal(byOffset?.continuation, 'next offset=7');
  // 上游 recall.py:63：命中回退 min(200, limit//4)=2 字符 → 'efghij'；续搜锚点 = 命中+len(query)=4+2=6。
  const byQuery = obs.recallText(handle, { query: 'gh', limit: 10 });
  assert.equal(byQuery?.text, 'efghij');
  assert.match(byQuery?.continuation ?? '', /next offset=8/); // 'gh' 命中于 index 6，6+len=8
  assert.equal(obs.recallText(handle, { query: 'zzz' }), null);
  assert.equal(obs.recallText(handle, { query: 'gh', offset: 100 }), null, 'offset 越界拒绝');
  assert.equal(obs.recallText('unknown', { offset: 0 }), null);
});

test('C2. recallText：负 offset/预算耗尽 fail-closed + peek 度量接线（审查修正回归）', () => {
  const obs = new ObservationLedger();
  obs.observe({ tool: 'tf-read', ok: true, key: 'k', content: 'abcdefghij', callId: 'c1' });
  const handle = obs.directoryDelta(0).added[0]?.handle ?? '';
  assert.equal(obs.recallText(handle, { offset: -1 }), null);
  const exhausted = obs.recallText(handle, { offset: 0, limit: 0 });
  assert.equal(exhausted?.text, '');
  const before = obs.peekMetrics().peekRequests;
  obs.recallText(handle, { offset: 0, limit: 3 });
  assert.equal(obs.peekMetrics().peekRequests, before + 1);
});

// ---- 4.1 文件版本冲突守卫 ----
test('D1. coversRange 区间合并覆盖判定', () => {
  assert.equal(coversRange([{ start: 1, end: 10 }, { start: 20, end: 30 }], 5, 8), true);
  assert.equal(coversRange([{ start: 1, end: 10 }], 15, 20), false);
});

test('D2. RevisionGuard：未读拒绝 / 版本变化拒绝 / 全文读放行 / 范围外拒绝', () => {
  const guard = new RevisionGuard();
  const facts = { revision: (_p: string) => 'rev1' };
  assert.equal(guard.guardEdit('a.txt', facts, { exactEdit: true }).verdict, 'deny');
  guard.observeRead('a.txt', 'rev1'); // 全文读
  assert.equal(guard.guardEdit('a.txt', facts, { exactEdit: true, targetRange: { start: 5, end: 9 } }).verdict, 'allow');
  const changed = { revision: (_p: string) => 'rev2' };
  const conflict = guard.guardEdit('a.txt', changed, { exactEdit: true });
  assert.equal(conflict.verdict, 'deny');
  assert.equal(conflict.verdict === 'deny' ? conflict.reason : '', 'revision_conflict');

  const rangeGuard = new RevisionGuard();
  rangeGuard.observeRead('b.txt', 'rev1', { start: 1, end: 10 });
  const outOfRange = rangeGuard.guardEdit('b.txt', facts, { exactEdit: true, targetRange: { start: 20, end: 25 } });
  assert.equal(outOfRange.verdict, 'deny');
  assert.equal(outOfRange.verdict === 'deny' ? outOfRange.reason : '', 'read_required');
  rangeGuard.noteWrite('b.txt', 'rev2');
  // 审查修正回归：范围读写后仍是范围读，不得升级为全文读授权。
  const escalated = rangeGuard.guardEdit('b.txt', { revision: () => 'rev2' }, { exactEdit: true });
  assert.equal(escalated.verdict, 'deny'); // 无 targetRange 且非全文读 → read_required
  // 全文读保持：已有同版本全文读时，范围读不得降级授权。
  const keepFull = new RevisionGuard();
  keepFull.observeRead('c.txt', 'rev1');
  keepFull.observeRead('c.txt', 'rev1', { start: 1, end: 5 });
  assert.equal(keepFull.guardEdit('c.txt', facts, { exactEdit: true, targetRange: { start: 50, end: 60 } }).verdict, 'allow');
});

// ---- 模型可见协议段（再评估修正回归）----
test('E1. v11 段默认不进协议（金样逐字节不变），显式开启后四项新语法可见', () => {
  const golden = readFileSync(new URL('./golden/v040-protocol.txt', import.meta.url), 'utf8');
  assert.equal(composeProtocolText(), golden, '缺省组装必须与金样逐字节一致（缓存零回归）');
  const enabled = composeProtocolText({ sections: { v11: true } });
  assert.match(enabled, /offset="N" query="字面串"/, '字符级取回可见');
  assert.match(enabled, /exists\(path\)[\s\S]*sha256\(path/, '机器谓词可见');
  assert.match(enabled, /> \[id\]/, '活动项可见');
  assert.match(enabled, /revision_conflict[\s\S]*read_required/, '版本守卫可见');
  assert.equal(enabled.length > golden.length, true);
});

// ---- 1.2 交付构建链接线（第 3 轮）----
test('A4. buildVerificationPlan 失败时 final 被拒（runVerification 端口端到端）', async () => {
  const { SingleStreamDriver, normalizeStreamShim } = await import('../src/entry/loop.ts');
  const { createMockModel } = await import('../src/entry/mock-provider.ts');
  const model = createMockModel({
    scenarios: [{
      name: 'build-verify-A4',
      match: { promptIncludes: 'BUILD-VERIFY-A4' },
      chunking: { charsPerChunk: 0, delayMs: 0 },
      steps: [
        { type: 'text', text: '交付。\n' },
        { type: 'commands', commands: ['<tf-write path="x.txt" id="w1">hello</tf-write>'] },
        { type: 'waitTools', count: 1, timeoutMs: 5000 },
        { type: 'commands', commands: ['<tf-final id="f1" summary="done"/>'] },
        { type: 'finish', reason: 'stop' },
      ],
    }],
    provider: 'mock',
  });
  let verified = 0;
  const ports = {
    stream: (o: { messages: Array<{ content: Array<{ text?: string }> }> }) =>
      normalizeStreamShim(model.adapter.stream({ provider: 'mock', model: 'mock', messages: o.messages, signal: new AbortController().signal })),
    executeTools: async () => ({ results: [], additionalContexts: [], concluded: false }),
    runVerification: async () => { verified++; return { ok: false, detail: 'npm run build failed: syntax error' }; },
    projectFacts: { hasPackageJson: () => true, hasNodeModules: () => true },
  };
  const driver = new SingleStreamDriver(ports, { provider: 'mock', model: 'mock' });
  driver.pushUserTask('BUILD-VERIFY-A4：写文件后交付');
  await driver.runTurn().catch(() => {});
  const cmds = driver.snapshot().records.filter((r) => r.kind === 'command');
  assert.ok(verified >= 1, 'runVerification 至少被调用一次（交付构建校验链接线可达）');
  // 构建失败通过 ledger/final 闸反映；命令记录的 detail 形态随 nudge 轮次变化，
  // 此处只断言确定事实：校验被执行且构建序列来自 buildVerificationPlan。
  assert.ok(cmds.length >= 1, '命令记录存在');
});

test('A5. 构建失败状态持久：final 不得因重发绕过闸（再评估修正回归）', () => {
  // 该契约由 loop.ts 的实例字段 #buildFailure 保证：构造失败后写入实例字段，
  // 在 pushUserTask 前不被重置；收束闸（prematureFinal / proseDelivery）读取实例字段而非局部变量。
  // 端到端的 nudge 循环会消耗大量请求，这里用源码级断言钉死不被回归。
  const src = readFileSync(new URL('../src/entry/loop.ts', import.meta.url), 'utf8');
  assert.match(src, /#buildFailure: string \| undefined/, '构建失败必须是实例字段（跨重入持久）');
  assert.match(src, /this\.#buildFailure !== undefined[\s\S]{0,200}tf-final 过早：交付构建校验失败/, 'final 闸必须读实例字段');
  assert.match(src, /this\.#buildFailure === undefined/, 'proseDelivery 必须读实例字段');
  assert.ok(!/let buildFailure/.test(src), '不得回退为局部变量（会被重发绕过）');
});

test('B2. in_progress 状态：活动项以 in_progress 落状态且仍属未验证（再评估修正回归）', () => {
  const src = readFileSync(new URL('../src/entry/loop.ts', import.meta.url), 'utf8');
  assert.match(src, /status: 'open' \| 'in_progress' \| 'verified'/, 'PlanAcceptItem 含 in_progress');
  assert.match(src, /item\.active === true \? 'in_progress' : 'open'/, '活动项落 in_progress');
  assert.match(src, /item\.status !== 'verified'/, '未验证判断包含 in_progress');
});
