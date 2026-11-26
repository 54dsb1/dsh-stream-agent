// test/v052-fixes.test.ts —— 0.5.2 审计修复的回归用例（内核层，零 API）
//
// 覆盖 6 项"曾经不生效/不可达"的修复：
//   F1 行内代码隔离（C-9）：`<tf-*>` 写在反引号里只作散文
//   F2 tf-edit body 兼容上游 <old>/<new>（C-8）
//   F3 版本守卫对"新建文件"放行（D2 配套：否则新建文件主路径死锁）
//   F4 token 估算 CJK 加权（C-11）：ASCII 口径不变、CJK ≈0.7 token/字符
//   F5 tf-code 输出体裁（M10）：logs 与 result 并列、超预算只截 logs
//   F6 bash 成功输出可见（C1）：首次/变化 full，重复 dedup
import test from 'node:test';
import assert from 'node:assert/strict';

import { TfStreamParser, splitEditBody, splitEditBodyByTags } from '../src/kernel/parser.ts';
import { RevisionGuard } from '../src/kernel/changes.ts';
import { ObservationLedger } from '../src/kernel/obs.ts';
import { publicTierCatalog } from '../src/kernel/modes.ts';
import { estimatePromptTokens, joinCodeOutput, codeLogsBody, SingleStreamDriver } from '../src/entry/loop.ts';
import type { DriverPorts, StreamChunkLike, StreamDriverConfig } from '../src/entry/loop.ts';

function feedAll(text: string): Array<{ type: string; text?: string }> {
  const parser = new TfStreamParser();
  const events: Array<{ type: string; text?: string }> = [];
  for (const ch of text) for (const e of parser.feed(ch)) events.push(e as { type: string; text?: string });
  return events;
}

/** 最小驱动（零 API）：只构造、不发请求——F7 只读状态面。 */
function makeDriver(config: Partial<StreamDriverConfig>): SingleStreamDriver {
  const ports: DriverPorts = {
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text-delta', index: 0, text: '继续。\n' } as StreamChunkLike;
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunkLike;
      },
    }),
    executeTools: async () => ({ results: [] }),
  };
  return new SingleStreamDriver(ports, { provider: 'mock', model: 'mock-v052', ...config });
}

test('F1. 行内代码里的 <tf-*> 只作散文（命令 0 执行）', () => {
  const inline = feedAll('示例：`<tf-read path="a.txt" id="r1"/>` 这样写。\n');
  assert.equal(inline.some((e) => e.type === 'command'), false, '反引号内的命令不得解析');
  assert.ok(inline.every((e) => e.type === 'text'), '整行都是正文');

  // 同一行闭合反引号之后、真实命令照常解析
  const mixed = feedAll('看 `<tf-read path="a"/>` 然后真的读 <tf-read path="b.txt" id="r2"/>\n');
  assert.equal(mixed.filter((e) => e.type === 'command').length, 1, '只有反引号外的那个被解析');

  // 围栏隔离（0.5.1）不受影响
  const fenced = feedAll('```\n<tf-read path="a.txt" id="r3"/>\n```\n');
  assert.equal(fenced.some((e) => e.type === 'command'), false, '围栏内仍不解析');
});

test('F2. tf-edit body：三行标记与上游 <old>/<new> 都接受', () => {
  const marked = splitEditBody('<<<<<<< OLD\nold line\n=======\nnew line\n>>>>>>> NEW');
  assert.deepEqual(marked, { old: 'old line', new: 'new line' });

  const tagged = splitEditBody('<old>const a = 1;</old>\n<new>const a = 2;</new>');
  assert.deepEqual(tagged, { old: 'const a = 1;', new: 'const a = 2;' });

  // 只有一半标签 → 结构化失败（不猜、不改全文）
  assert.equal(splitEditBodyByTags('<old>a</old>'), null);
  assert.equal(splitEditBody('随便写点什么'), null);
});

test('F3. 版本守卫：目标文件不存在 + 无读观察 = 新建，放行；已存在且未读 = read_required', () => {
  const guard = new RevisionGuard();
  const missing = { revision: () => null };
  assert.equal(guard.guardEdit('new/file.ts', missing).verdict, 'allow', '新建文件不得被 read_required 拦死');

  const existing = { revision: () => 'sha-abc' };
  const denied = guard.guardEdit('src/a.ts', existing);
  assert.equal(denied.verdict, 'deny');
  assert.equal(denied.verdict === 'deny' ? denied.reason : '', 'read_required');

  // 读过之后允许；版本变化后拒绝
  guard.observeRead('src/a.ts', 'sha-abc');
  assert.equal(guard.guardEdit('src/a.ts', existing).verdict, 'allow');
  const conflict = guard.guardEdit('src/a.ts', { revision: () => 'sha-def' });
  assert.equal(conflict.verdict === 'deny' ? conflict.reason : '', 'revision_conflict');
});

test('F4. token 估算：ASCII 仍是 4 字符/token；CJK 按 0.7；tools 字节额外计入', () => {
  assert.equal(estimatePromptTokens([{ role: 'system', content: 'abcd' }, { role: 'user', content: 'abcde' }]), 3);
  assert.equal(estimatePromptTokens([{ role: 'user', content: '汉字十个字符凑数' }]), Math.ceil(8 * 0.7));
  assert.equal(estimatePromptTokens([{ role: 'user', content: 'abcd' }], 400), 1 + 100);
  assert.ok(
    estimatePromptTokens([{ role: 'user', content: '中'.repeat(100) }])
      > estimatePromptTokens([{ role: 'user', content: 'a'.repeat(100) }]),
    'CJK 必须比同长度 ASCII 估得更多',
  );
});

test('F5. tf-code 输出体裁：logs 与 result 并列；超预算只截 logs 不吞 result', () => {
  const body = joinCodeOutput('{"rows":3}', 'line1\nline2');
  assert.match(body, /^logs:\nline1\nline2\nresult:\n\{"rows":3\}$/);

  const truncated = joinCodeOutput('42', 'x'.repeat(200), undefined, 50);
  assert.ok(truncated.includes('logs（前 50 字符'), '截断必须显式说明');
  assert.ok(truncated.includes('result:\n42'), 'result 不得被截掉');

  assert.equal(codeLogsBody('   ', 10), null, '空日志不产生 logs 段');
  assert.equal(joinCodeOutput(undefined, undefined, 'boom'), 'boom', '失败路径用诊断正文兜底');
  assert.equal(joinCodeOutput('undefined', ''), '', 'undefined 值不产生 "undefined" 文本');
});

test('F6. bash 成功输出可见：首次/变化 full、重复未变 dedup', () => {
  const ledger = new ObservationLedger();
  assert.equal(ledger.observe({ tool: 'tf-bash', ok: true, key: 'git status', content: 'clean', callId: 'b1' }).info_gain, 'full');
  assert.equal(ledger.observe({ tool: 'tf-bash', ok: true, key: 'git status', content: 'clean', callId: 'b2' }).info_gain, 'dedup');
  assert.equal(ledger.observe({ tool: 'tf-bash', ok: true, key: 'git status', content: 'clean\nM a.ts', callId: 'b3' }).info_gain, 'full');
  // 写类仍是回执（不注入正文）
  assert.equal(ledger.observe({ tool: 'tf-write', ok: true, key: 'a.ts', content: 'ok', callId: 'w1' }).info_gain, 'handle');
});

test('F7. 控制栏"生效参数"如实报账：thinkflow 对齐默认层 + 用户 limits（0 = 不限）', () => {
  // ① 档位目录：数值位全 0（不限制）；0.6.1 参考值对齐 thinkflow（maxSteps = 0，轮数不设上限）
  for (const tier of publicTierCatalog()) {
    assert.equal(tier.values.maxSteps, 0, `${tier.id}.values 不得带预设上限`);
    assert.equal(tier.values.maxInputTokens, 0, `${tier.id}.values 不得带预设 token 上限`);
    assert.equal(tier.unset, true, '须显式标注"默认不限制"');
    assert.equal(tier.reference.maxSteps, 0, '参考值轮数 = 不限制（0.6.1 起上限已移除）');
    assert.equal(tier.reference.keepRecent, 30, '参考值 = thinkflow 对齐数值');
  }

  // ② 未设 limits：默认层生效（keepRecent 30 / maxSummaryChars 16k），轮数与 token = 0（不限制）
  const bare = makeDriver({});
  const bareEffective = bare.runtimeStatus().effective;
  for (const key of ['maxSteps', 'maxInputTokens', 'peekBudgetChars']) {
    assert.equal(bareEffective[key], 0, `未设 limits 时 ${key} 必须是 0（不限制）`);
  }
  assert.equal(bareEffective.keepRecent, 30, 'keepRecent 来自 thinkflow 对齐默认层');
  assert.equal(bareEffective.maxSummaryChars, 16_000, 'maxSummaryChars 来自 thinkflow 对齐默认层');
  assert.equal(typeof bareEffective.compactAggressiveness, 'string', '压缩强度来自档位，不是 limits');
  assert.equal(typeof bareEffective.surfacePolicy, 'string', '工具面策略来自装配，不是 limits');

  // ③ 用户设了值：控制栏读到的就是用户值（逐键一致；未覆盖键仍取默认层）
  const withLimits = makeDriver({ limits: { maxSteps: 12, maxInputTokens: 9000, peekBudgetChars: 5000, keepRecent: 3 } });
  const effective = withLimits.runtimeStatus().effective;
  assert.equal(effective.maxSteps, 12);
  assert.equal(effective.maxInputTokens, 9000);
  assert.equal(effective.peekBudgetChars, 5000);
  assert.equal(effective.keepRecent, 3);
  assert.equal(effective.maxSummaryChars, 16_000, '未覆盖的键取默认层，不被其它键带偏');
  // 与预算判定同源：effectiveLimits() 与展示面不得打架
  assert.deepEqual(
    { maxSteps: effective.maxSteps, maxInputTokens: effective.maxInputTokens },
    withLimits.effectiveLimits(),
    '展示面与预算判定必须同源',
  );
});
