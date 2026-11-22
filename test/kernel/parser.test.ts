import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TfStreamParser, parseStream, type ParserEvent, type TfCommand } from '../../src/kernel/parser.ts';

function commandsOf(events: ParserEvent[]): TfCommand[] {
  return events.filter((e) => e.type === 'command').map((e) => (e as { command: TfCommand }).command);
}

function feedAll(parser: TfStreamParser, deltas: string[]): ParserEvent[] {
  const out: ParserEvent[] = [];
  for (const d of deltas) out.push(...parser.feed(d));
  out.push(...parser.end());
  return out;
}

// ---------------------------------------------------------------------------
// 基本解析与命令闭合
// ---------------------------------------------------------------------------

test('单条自闭合命令：闭合即产出', () => {
  const p = new TfStreamParser();
  const events = p.feed('<tf-read path="src/app.ts" id="r1"/>');
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].name, 'tf-read');
  assert.equal(cmds[0].id, 'r1');
  assert.equal(cmds[0].attrs['path'], 'src/app.ts');
  assert.deepEqual(cmds[0].depends_on, []);
});

test('tf-write 正文跨 chunk 边界闭合（拆 3 个 delta 喂完一条命令）', () => {
  const p = new TfStreamParser();
  const deltas = [
    '前情提要。<tf-write path="out.txt" id="w1" depends_on="r1">\n第一段正文...',
    '...第二段正文，中间被切断 > 重定向符号也在正文里\n',
    '...最后一段</tf-write>收尾 prose',
  ];
  const events = feedAll(p, deltas);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].id, 'w1');
  assert.equal(
    cmds[0].body,
    '\n第一段正文......第二段正文，中间被切断 > 重定向符号也在正文里\n...最后一段',
  );
  assert.deepEqual(cmds[0].depends_on, ['r1']);
  // prose 透传：开头与结尾的文本原样保留
  const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.equal(text, '前情提要。收尾 prose');
  // 事件顺序：text → command → text（闭合即产出，不等流结束）
  assert.equal(events[0].type, 'text');
  assert.equal(events[1].type, 'command');
  assert.equal(events[2].type, 'text');
});

test('头部属性值含 > （shell 重定向）不破坏头部扫描', () => {
  const p = new TfStreamParser();
  const events = p.feed('<tf-bash cmd="npm run build > out.log 2>&1" id="b1"/>');
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].attrs['cmd'], 'npm run build > out.log 2>&1');
});

test('id 缺省自动编号；空元素配对形式 <tf-read ...></tf-read> 合法', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, ['<tf-read path="a"/><tf-final></tf-final>']);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 2);
  assert.equal(cmds[0].id, 'cmd1');
  assert.equal(cmds[1].id, 'cmd2');
  assert.equal(cmds[1].name, 'tf-final');
});

test('tf-peek 带行号属性；tf-final 带 summary', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, [
    '<tf-peek handle="obs:read:c1@v1" from_line="10" to_line="20" id="p1"/>',
    '<tf-final id="f1" summary="完成了"/>',
  ]);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 2);
  assert.equal(cmds[0].attrs['handle'], 'obs:read:c1@v1');
  assert.equal(cmds[0].attrs['from_line'], '10');
  assert.equal(cmds[0].attrs['to_line'], '20');
  assert.equal(cmds[1].attrs['summary'], '完成了');
});

// ---------------------------------------------------------------------------
// prose 透传（绝不吞非协议文本）
// ---------------------------------------------------------------------------

test('模型 prose 原样透传（含 < 和 > 的普通文本不丢失）', () => {
  const p = new TfStreamParser();
  const prose = '分析如下：if (a < b) { ... } 否则 x > y。结论：需要读文件。';
  const events = feedAll(p, [prose, '<tf-read path="a.ts" id="r1"/>', '读完了，总结。']);
  const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.equal(text, `${prose}读完了，总结。`);
  assert.equal(commandsOf(events).length, 1);
});

test('prose 被 chunk 任意切割后拼接仍逐字还原', () => {
  const p = new TfStreamParser();
  const prose = '这段长文本会被切成很多小块，包括引号 " 与反斜杠 \\ 与单引号 \'，全部保留。';
  const events: ParserEvent[] = [];
  for (const ch of prose) events.push(...p.feed(ch));
  events.push(...p.end());
  const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.equal(text, prose);
});

// ---------------------------------------------------------------------------
// truncated：未闭合即流终止
// ---------------------------------------------------------------------------

test('tf-write 正文未闭合 → truncated（loop 重入依据）', () => {
  const p = new TfStreamParser();
  p.feed('<tf-write path="a.ts" id="w1">\npartial body');
  const events = p.end();
  const truncated = events.find((e) => e.type === 'truncated') as { raw: string; reason: string };
  assert.ok(truncated);
  assert.equal(truncated.reason, 'unclosed-command-body:tf-write');
  assert.ok(truncated.raw.includes('partial body'));
  assert.equal(events[events.length - 1].type, 'done');
});

test('头部标签未闭合 → truncated', () => {
  const p = new TfStreamParser();
  const events = p.feed('ok prose <tf-read path="a.ts"');
  events.push(...p.end());
  const texts = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.equal(texts, 'ok prose ');
  const truncated = events.find((e) => e.type === 'truncated') as { raw: string; reason: string };
  assert.equal(truncated.reason, 'unclosed-command-tag');
  assert.equal(truncated.raw, '<tf-read path="a.ts"');
});

test('<tf- 前缀残片悬在流尾 → truncated；普通 < 残片 → text', () => {
  const p1 = new TfStreamParser();
  const e1 = p1.end();
  assert.deepEqual(e1.map((x) => x.type), ['done']);

  const p2 = new TfStreamParser();
  const e2 = p2.feed('abc');
  e2.push(...p2.end());
  assert.deepEqual(e2.map((x) => x.type), ['text', 'done']);

  const p3 = new TfStreamParser();
  const e3 = p3.feed('<tf-wr'); // need-more：无事件
  e3.push(...p3.end());
  assert.deepEqual(e3.map((x) => x.type), ['truncated', 'done']);
});

test('边界：非 tf 的 < 立即判 prose；悬空的 < 留到 end() 按 text 透传', () => {
  const p1 = new TfStreamParser();
  const e1 = p1.feed('a<b');
  e1.push(...p1.end());
  assert.deepEqual(e1.map((x) => x.type), ['text', 'text', 'done']);
  assert.equal(e1.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join(''), 'a<b');

  const p2 = new TfStreamParser();
  const e2 = p2.feed('abc<'); // '<' 无法判定（need-more），留缓冲
  assert.deepEqual(e2, []);
  e2.push(...p2.end());
  assert.deepEqual(e2.map((x) => x.type), ['text', 'done']);
  assert.equal((e2[0] as { text: string }).text, 'abc<');
});

test('feed 之后再 feed 抛错（流生命周期不可复用）', () => {
  const p = new TfStreamParser();
  p.feed('x');
  p.end();
  assert.throws(() => p.feed('y'), /already ended/);
});

// ---------------------------------------------------------------------------
// malformed：解析失败不静默丢弃
// ---------------------------------------------------------------------------

test('未知 tf-* 命令名 → malformed（不静默）', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, ['<tf-frobnicate path="x"/>']);
  const m = events.find((e) => e.type === 'malformed') as { reason: string; raw: string };
  assert.ok(m, '必须产出 malformed 事件');
  assert.equal(m.reason, 'unknown-command');
  assert.equal(m.raw, '<tf-frobnicate path="x"/>');
});

test('缺必填属性 → malformed；未知属性降级丢弃（命令保留）；非法行号 → malformed', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, [
    '<tf-read id="r1"/>',                       // 缺 path
    '<tf-read path="a" bogus="1"/>',            // 未知属性
    '<tf-peek handle="h" from_line="x"/>',      // 非法整数
  ]);
  const reasons = events.filter((e) => e.type === 'malformed').map((e) => (e as { reason: string }).reason);
  assert.equal(reasons.length, 2);
  assert.ok(reasons[0].startsWith('missing-attribute:path'));
  assert.ok(reasons[1].startsWith('bad-integer-attribute:from_line'));
  // v0.4.2：未知属性降级丢弃而不是拒整条命令（真机 session-ec100f8a seq 91：
  // lines="1-20" 被旧实现整条拒绝，模型重试烧一步）。
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1, '未知属性的 tf-read 应保留');
  assert.equal(cmds[0].name, 'tf-read');
  assert.equal(cmds[0].attrs['bogus'], undefined, '未知属性被丢弃');
});

test('属性语法错误与重复属性 → malformed；重复 id 透传（v0.2 起由驱动器裁决幂等/冲突）', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, [
    '<tf-read path=a.ts/>',                     // 属性值没有引号
    '<tf-read path="a" path="b"/>',             // 重复属性
    '<tf-read path="a" id="dup"/>',
    '<tf-read path="b" id="dup"/>',             // 重复 id：parser 透传，不在本层拦截
  ]);
  const reasons = events.filter((e) => e.type === 'malformed').map((e) => (e as { reason: string }).reason);
  assert.equal(reasons.length, 2);
  assert.ok(reasons[0].startsWith('bad-attribute-syntax'));
  assert.ok(reasons[1].startsWith('duplicate-attribute:path'));
  assert.equal(commandsOf(events).length, 2, '重复 id 命令透传给驱动器（幂等/冲突语义在账本层）');
});

test('非 body 命令带非空正文 → malformed', () => {
  const p = new TfStreamParser();
  const events = p.feed('<tf-read path="a">junk</tf-read>');
  const m = events.find((e) => e.type === 'malformed') as { reason: string };
  assert.ok(m);
  assert.equal(m.reason, 'unexpected-body');
});

// ---------------------------------------------------------------------------
// depends_on：可执行集合与环检测
// ---------------------------------------------------------------------------

test('readyCommands：依赖全部完成才进入可执行集合', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, [
    '<tf-read path="a.ts" id="r1"/>',
    '<tf-write path="b.ts" id="w1" depends_on="r1, s1">',
    'body',
    '</tf-write>',
    '<tf-bash cmd="npm test" id="b1" depends_on="w1"/>',
  ]);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 3);

  // 初始：只有 r1 就绪（w1 依赖 r1 与未出现的 s1；b1 依赖 w1）
  assert.deepEqual(p.readyCommands().map((c) => c.id), ['r1']);
  p.markDone('r1');
  assert.deepEqual(p.readyCommands().map((c) => c.id), []); // s1 未出现，w1 不就绪
});

test('readyCommands：依赖全部完成后逐级解锁', () => {
  const p = new TfStreamParser();
  feedAll(p, [
    '<tf-read path="a.ts" id="r1"/>',
    '<tf-write path="b.ts" id="w1" depends_on="r1">body</tf-write>',
    '<tf-bash cmd="npm test" id="b1" depends_on="w1"/>',
  ]);
  assert.deepEqual(p.readyCommands().map((c) => c.id), ['r1']);
  p.markDone('r1');
  assert.deepEqual(p.readyCommands().map((c) => c.id), ['w1']);
  p.markDone('w1');
  assert.deepEqual(p.readyCommands().map((c) => c.id), ['b1']);
  p.markDone('b1');
  assert.deepEqual(p.readyCommands().map((c) => c.id), []);
});

test('depends_on 去重保序；自依赖 → cycle 事件', () => {
  const p = new TfStreamParser();
  const events = p.feed('<tf-read path="a" id="r1" depends_on="r1, r1, , w2"/>');
  const cmds = commandsOf(events);
  assert.deepEqual(cmds[0].depends_on, ['r1', 'w2']);
  const cycle = events.find((e) => e.type === 'cycle') as { cycle: readonly string[] };
  assert.ok(cycle, '自依赖必须产出 cycle 事件');
  assert.deepEqual([...cycle.cycle], ['r1', 'r1']);
});

test('A↔B 互依赖 → cycle 事件（后闭合的一方触发检测）', () => {
  const p = new TfStreamParser();
  const e1 = p.feed('<tf-write path="a" id="A" depends_on="B"/>');
  assert.equal(e1.find((e) => e.type === 'cycle'), undefined); // B 还没出现
  const e2 = p.feed('<tf-read path="b" id="B" depends_on="A"/>');
  const cycle = e2.find((e) => e.type === 'cycle') as { cycle: readonly string[] };
  assert.ok(cycle, 'B 闭合时 A↔B 环必须被检出');
  assert.deepEqual([...cycle.cycle], ['A', 'B', 'A']);
  // 同一环只报一次
  const e3 = p.end();
  assert.equal(e3.find((e) => e.type === 'cycle'), undefined);
});

test('三节点环 A→B→C→A', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, [
    '<tf-read path="a" id="A" depends_on="C"/>',
    '<tf-read path="b" id="B" depends_on="A"/>',
    '<tf-read path="c" id="C" depends_on="B"/>',
  ]);
  const cycle = events.find((e) => e.type === 'cycle') as { cycle: readonly string[] };
  assert.ok(cycle);
  assert.equal(cycle.cycle.length, 4); // [A, B, C, A]
  assert.equal(cycle.cycle[0], cycle.cycle[3]);
});

// ---------------------------------------------------------------------------
// AsyncIterable 入口与混合流
// ---------------------------------------------------------------------------

test('parseStream：AsyncIterable 全流解析（含 done）', async () => {
  async function* src(): AsyncIterable<string> {
    yield '第一步。<tf-read path="a.ts" id="r1"/>';
    yield '<tf-write path="b.ts" id="w1" depends_on="r1">content</tf-write>';
    yield '<tf-final id="f1"/>';
  }
  const events = await parseStream(src());
  assert.equal(events[events.length - 1].type, 'done');
  const cmds = commandsOf(events);
  assert.deepEqual(cmds.map((c) => c.id), ['r1', 'w1', 'f1']);
  const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.equal(text, '第一步。');
});

test('混合流：prose + 三条命令 + malformed 混合，全部事件齐全', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, [
    '开始。\n',
    '<tf-read path="a.ts" id="r1"/>',
    '\n中间的思考。\n',
    '<tf-bogus/>',
    '<tf-write path="c.ts" id="w1">\n内容\n</tf-write>',
    '<tf-final id="f1" summary="done"/>',
  ]);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'text', 'command', 'text', 'malformed', 'command', 'command', 'done',
  ]);
  const cmds = commandsOf(events);
  assert.equal(cmds[0].id, 'r1');
  assert.equal(cmds[1].body, '\n内容\n');
  assert.equal(cmds[2].name, 'tf-final');
});

// ---------------------------------------------------------------------------
// DSML 噪声归一化（v0.3.1：思考过程乱码修复的解析半边）
// ---------------------------------------------------------------------------

test('DSML 包装行：malformed 上报并丢弃，不进 prose（真机形态）', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, [
    '\n\n<｜｜DSML｜｜ calls>\n',
    '<｜｜DSML｜｜ invoke name="tf-plan" id="p1">\n- [a1] 验收项\n</tf-plan>',
  ]);
  const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.equal(text, '\n\n\n', 'DSML 标签本身不得作为 prose 透传（标签间空白换行保留）');
  const malformed = events.filter((e) => e.type === 'malformed').map((e) => e as { reason: string });
  assert.ok(malformed.some((m) => m.reason === 'dsml-wrapper'), '包装行应按 dsml-wrapper 上报');
  // invoke + 配对闭合 → 命令不丢。v0.4.2 起全部 invoke 统一走块缓冲（含内联属性形态），
  // 正文约定与 parameter 语义一致：剥首尾各一个换行（内容本身不变）。
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].name, 'tf-plan');
  assert.equal(cmds[0].id, 'p1');
  assert.equal(cmds[0].body, '- [a1] 验收项');
});

test('DSML invoke 自闭合：改写回 tf-* 命令（属性透传）', () => {
  const p = new TfStreamParser();
  const events = p.feed('<｜｜DSML｜｜ invoke name="tf-read" path="data/x.md" id="r9" offset="3" limit="4"/>');
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].name, 'tf-read');
  assert.equal(cmds[0].id, 'r9');
  assert.equal(cmds[0].attrs['path'], 'data/x.md');
  assert.equal(cmds[0].attrs['offset'], '3');
  assert.equal(cmds[0].attrs['limit'], '4');
});

test('DSML 残缺属性（真机 mangled 形态）：v0.4.2 起抢救为完整命令，不作为 prose 泄漏', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, [
    '<｜｜DSML｜｜ invoke name="tf-read path="data/big-report.md" id="r1" offset="130" limit="15"/>',
  ]);
  const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.equal(text, '', 'mangled DSML 不得进 prose');
  // v0.4.2：name 值以合法命令名开头 → 抢救为完整命令（旧实现整条丢弃，模型重试烧一步）
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1, `mangled 形态应抢救出命令：${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(cmds[0].name, 'tf-read');
  assert.equal(cmds[0].id, 'r1');
  assert.equal(cmds[0].attrs['path'], 'data/big-report.md');
  assert.equal(cmds[0].attrs['offset'], '130');
  assert.equal(cmds[0].attrs['limit'], '15');
});

test('DSML 尾巴（流终止未闭合）：malformed 上报，不进 prose', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, ['回答正文。<｜｜DSML｜｜ calls']);
  const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.equal(text, '回答正文。');
  assert.ok(events.some((e) => e.type === 'malformed' && (e as { reason: string }).reason === 'dsml-wrapper'));
});

test('全角竖线出现在普通 prose 中（非标签起始）不受影响', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, ['评分 9｜10 分，很好。']);
  const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.equal(text, '评分 9｜10 分，很好。');
  assert.equal(events.filter((e) => e.type === 'malformed').length, 0);
});

test('DSML 跨 chunk 边界：闭合跨流仍能改写（增量喂入）', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, [
    '<｜｜DSM',
    'L｜｜ invoke name="tf-glob" pattern="**/*.md" id="gl1"/>',
  ]);
  const cmds = commandsOf(events);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].name, 'tf-glob');
  assert.equal(cmds[0].id, 'gl1');
});

// ---------------------------------------------------------------------------
// 孤立闭合标签（v0.3.1「任务半途截断」修复）
// 真机证据：模型给自闭合命令又补了一次闭合，`</tf-bash>` 以纯文本落进正文，
// 桌面端过程区里就能看到裸协议残片。
// ---------------------------------------------------------------------------

test('孤立闭合标签不进 prose：记 malformed(stray-close-tag) 后丢弃', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, ['先看一眼\n<tf-glob pattern="**/*" id="gl4"/>\n继续\n</tf-bash>\n']);
  const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.equal(text, '先看一眼\n\n继续\n\n');
  assert.ok(!text.includes('</tf-bash>'), '裸闭合标签不得进正文');
  const mal = events.filter((e) => e.type === 'malformed') as Array<{ reason: string }>;
  assert.equal(mal.length, 1);
  assert.equal(mal[0]!.reason, 'stray-close-tag:tf-bash');
  assert.equal(commandsOf(events).length, 1, '正常命令不受影响');
});

test('孤立的配对式闭合（跨 chunk）同样丢弃', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, ['abc</t', 'f-write>xyz']);
  const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.equal(text, 'abcxyz');
  assert.ok(events.some((e) => e.type === 'malformed' && (e as { reason: string }).reason === 'stray-close-tag:tf-write'));
});

test('流末尾半截闭合标签：不留在 prose 里', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, ['文字</tf-ba']);
  const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.equal(text, '文字');
  assert.ok(events.some((e) => e.type === 'malformed' && (e as { reason: string }).reason.startsWith('stray-close-tag')));
});

test('普通 HTML 闭合标签仍按正文透传（不过度拦截）', () => {
  const p = new TfStreamParser();
  const events = feedAll(p, ['正文 </div> 结束，</tf 不在标签位']);
  const text = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
  assert.ok(text.includes('</div>'), 'HTML 闭合标签属于正常正文');
  assert.equal(events.filter((e) => e.type === 'malformed').length, 0);
});
