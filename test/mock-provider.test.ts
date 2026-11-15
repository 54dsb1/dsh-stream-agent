// mock-provider E2E 与单测（分派 05 验收）
// 运行：node --test test/   （Node ≥24 原生 TS type-stripping，零依赖，零 API 调用）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateScenario,
  createMockModel,
  MockScenarioError,
  type Scenario,
} from '../src/entry/mock-provider.ts';
import { runStubLoop, parseTfLine } from './helpers/stub-loop.ts';

const SCENARIO_DIR = join(import.meta.dirname, 'scenarios');
const loadScenario = (file: string): Scenario =>
  validateScenario(JSON.parse(readFileSync(join(SCENARIO_DIR, file), 'utf8')), file);

function sandbox(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'mock-e2e-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// 剧本 DSL 校验（fail-fast 负例）
// ---------------------------------------------------------------------------

test('DSL 负例：缺 finish 步骤抛 MockScenarioError', () => {
  assert.throws(
    () =>
      validateScenario(
        { name: 'no-finish', steps: [{ type: 'text', text: 'hi' }] },
        'inline',
      ),
    (e: unknown) => e instanceof MockScenarioError && /缺少 finish/.test(e.message),
  );
});

test('DSL 负例：未知步骤类型与非法 waitTools.count 拒绝', () => {
  assert.throws(() => validateScenario({ name: 'x', steps: [{ type: 'explode' }] }, 'inline'), MockScenarioError);
  assert.throws(
    () => validateScenario({ name: 'x', steps: [{ type: 'waitTools', count: 0 }, { type: 'finish' }] }, 'inline'),
    (e: unknown) => /waitTools\.count/.test((e as Error).message),
  );
  assert.throws(
    () => validateScenario({ name: 'x', steps: [{ type: 'waitTools', count: 1, timeoutMs: -5 }, { type: 'finish' }] }, 'inline'),
    (e: unknown) => /waitTools\.timeoutMs/.test((e as Error).message),
  );
});

test('DSL 负例：fail.mode 白名单外拒绝', () => {
  assert.throws(
    () => validateScenario({ name: 'x', steps: [{ type: 'fail', mode: 'nuke' }, { type: 'finish' }] }, 'inline'),
    (e: unknown) => /fail\.mode/.test((e as Error).message),
  );
});

test('DSL 正例：五种步骤全部通过校验且字段透传', () => {
  const s = validateScenario(
    {
      name: 'all-steps',
      chunking: { charsPerChunk: 3, delayMs: 0 },
      steps: [
        { type: 'text', text: 'a' },
        { type: 'commands', commands: ['tf-final'] },
        { type: 'waitTools', count: 1, timeoutMs: 100 },
        { type: 'fail', mode: 'timeout', delayMs: 1 },
        { type: 'finish', reason: 'max-tokens' },
      ],
    },
    'inline',
  );
  assert.equal(s.steps.length, 5);
  assert.deepEqual(s.chunking, { charsPerChunk: 3, delayMs: 0 });
});

test('parseTfLine：合法命令 / 畸形命令 / 普通文本三分', () => {
  assert.deepEqual(parseTfLine('tf-write a.txt "A"'), { kind: 'tf-write', raw: 'tf-write a.txt "A"', path: 'a.txt', content: 'A' });
  assert.equal(parseTfLine('tf-read a.txt')?.kind, 'tf-read');
  assert.equal(parseTfLine('  tf-final  ')?.kind, 'tf-final');
  assert.equal(parseTfLine('tf-frobnicate x')?.kind, 'malformed');
  assert.equal(parseTfLine('tf-write 没有引号')?.kind, 'malformed');
  assert.equal(parseTfLine('普通注释行'), null);
  assert.equal(parseTfLine(''), null);
});

// ---------------------------------------------------------------------------
// 逐 token 粒度与流契约（硬性要求 2）
// ---------------------------------------------------------------------------

test('chunk 粒度：charsPerChunk=8 时每个 delta ≤8 字符且拼接无损', async () => {
  const text = '0123456789abcdefghij';
  const model = createMockModel({
    scenarios: [{ name: 'g', chunking: { charsPerChunk: 8, delayMs: 0 }, steps: [{ type: 'text', text }, { type: 'finish' }] }],
  });
  const deltas: string[] = [];
  const types: string[] = [];
  for await (const c of model.adapter.stream({
    provider: 'mock',
    model: 'g',
    messages: [{ role: 'user', content: [{ type: 'text', text: 't' }] }],
  })) {
    types.push(c.type);
    if (c.type === 'text-delta') deltas.push(c.text);
  }
  assert.ok(deltas.length >= 3, '应切成多个 delta');
  assert.ok(deltas.every((d) => d.length <= 8), '每个 delta ≤ 8 字符');
  assert.equal(deltas.join(''), text, '拼接无损');
  assert.equal(types[0], 'block-start');
  assert.equal(types[types.length - 1], 'finish');
});

test('chunk 间隔：delayMs=10、3 个 chunk 时整流耗时 ≥ 20ms', async () => {
  const t0 = Date.now();
  const model = createMockModel({
    scenarios: [{ name: 'd', chunking: { charsPerChunk: 1, delayMs: 10 }, steps: [{ type: 'text', text: 'abc' }, { type: 'finish' }] }],
  });
  for await (const c of model.adapter.stream({
    provider: 'mock',
    model: 'd',
    messages: [{ role: 'user', content: [{ type: 'text', text: 't' }] }],
  })) {
    void c;
  }
  assert.ok(Date.now() - t0 >= 20, '应真实延迟（默认 20ms/chunk 模拟真实 delta 粒度）');
});

test('流契约：usage 在 finish 之前、finish 终止、block-end 携带全量文本', async () => {
  const model = createMockModel({
    scenarios: [{ name: 'c', steps: [{ type: 'text', text: 'hello' }, { type: 'finish' }] }],
  });
  const chunks: import('../src/entry/mock-provider.ts').StreamChunk[] = [];
  for await (const c of model.adapter.stream({
    provider: 'mock',
    model: 'c',
    messages: [{ role: 'user', content: [{ type: 'text', text: '1234' }] }],
  })) {
    chunks.push(c);
  }
  const usageIdx = chunks.findIndex((c) => c.type === 'usage');
  const finishIdx = chunks.findIndex((c) => c.type === 'finish');
  assert.ok(usageIdx >= 0 && finishIdx === chunks.length - 1 && usageIdx === finishIdx - 1, 'usage 紧邻 finish 之前');
  const end = chunks.find((c) => c.type === 'block-end');
  assert.equal(end && end.type === 'block-end' ? end.block.text : undefined, 'hello');
  const usage = chunks[usageIdx]!;
  assert.ok(usage.type === 'usage' && usage.usage.inputTokens > 0 && usage.usage.outputTokens > 0);
  const finish = chunks[finishIdx]!;
  assert.ok(finish.type === 'finish' && finish.reason.kind === 'stop');
});

test('剧本选择：match.model 命中优先，无 match 首个剧本兜底', async () => {
  const model = createMockModel({
    scenarios: [
      { name: 'fallback', steps: [{ type: 'text', text: 'fallback' }, { type: 'finish' }] },
      { name: 'by-model', match: { model: 'special' }, steps: [{ type: 'text', text: 'by-model' }, { type: 'finish' }] },
    ],
  });
  const collect = async (id: string) => {
    let out = '';
    for await (const c of model.adapter.stream({
      provider: 'mock',
      model: id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    })) {
      if (c.type === 'text-delta') out += c.text;
    }
    return out;
  };
  assert.equal(await collect('special'), 'by-model');
  assert.equal(await collect('anything-else'), 'fallback');
});

// ---------------------------------------------------------------------------
// E2E：正常剧本（验收：3 文件任务写入成功，模型调用次数 = 1）
// ---------------------------------------------------------------------------

test('E2E 正常剧本：3 文件写入成功且模型调用次数 = 1（零 API）', async () => {
  const { dir, cleanup } = sandbox();
  try {
    const model = createMockModel({ scenarios: [loadScenario('3-file-basic.json')] });
    const r = await runStubLoop({ task: '请写三个文件 a.txt b.txt c.txt', model, sandboxDir: dir });
    assert.equal(r.modelCalls, 1, '单流协议：整个任务 1 次模型调用');
    assert.equal(r.finish?.kind, 'stop');
    assert.deepEqual([...r.writtenFiles.keys()].sort(), ['a.txt', 'b.txt', 'c.txt']);
    // 沙箱磁盘上真实存在且内容正确（不走内存假象）
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'A');
    assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'B');
    assert.equal(readFileSync(join(dir, 'c.txt'), 'utf8'), 'C');
    const toolRecords = r.ledger.filter((e) => e.kind === 'tool');
    assert.equal(toolRecords.length, 3, 'ledger 记录 3 条工具成功');
    assert.ok(toolRecords.every((e) => e.kind !== 'tool' || e.ok), '全部成功');
    assert.ok(r.ledger.some((e) => e.kind === 'final'), 'tf-final 有记录');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// E2E：waitTools 挂起-重入
// ---------------------------------------------------------------------------

test('E2E waitTools：流未终止时挂起等工具、回灌后续流、调用次数仍 = 1', async () => {
  const { dir, cleanup } = sandbox();
  try {
    const model = createMockModel({ scenarios: [loadScenario('wait-tools.json')] });
    const r = await runStubLoop({ task: '先写两个文件再读回来', model, sandboxDir: dir });
    assert.equal(r.modelCalls, 1, '挂起-重入不产生第二次模型调用');
    assert.equal(r.finish?.kind, 'stop');
    // 时间线：write 工具执行发生在流 finish 之前（挂起），且 resume 文本在工具之后
    const order = r.timeline.map((e) => e.what);
    const firstTool = order.indexOf('tool-executed');
    const finishIdx = order.indexOf('finish-seen');
    assert.ok(firstTool >= 0 && finishIdx > firstTool, '工具在流终止前执行（挂起-重入）');
    assert.equal(order.filter((w) => w === 'tool-executed').length, 3, '2 写 + 1 读');
    assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), '内容A');
    assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), '内容B');
    assert.equal(r.readFiles.get('a.txt'), '内容A', 'tf-read 读回了写入内容');
    assert.ok(r.assistantText.includes('前两个文件已写'), '回灌后剧本继续输出');
    assert.ok(r.assistantText.includes('读回确认'), '第二轮 waitTools 也重入成功');
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// E2E：四种故障剧本（验收：对应处理路径被触发且 ledger 有记录）
// ---------------------------------------------------------------------------

test('E2E 故障 midstream_abort：流中断 → 归一化 error finish + ledger 记录', async () => {
  const { dir, cleanup } = sandbox();
  try {
    const model = createMockModel({ scenarios: [loadScenario('fault-midstream-abort.json')] });
    const r = await runStubLoop({ task: '故障注入：流中断', model, sandboxDir: dir });
    assert.equal(r.finish?.kind, 'error', '桩 loop 经归一化 shim 收到终止 error finish');
    assert.equal(r.finish?.code, 'MOCK_ADAPTER_THROWN');
    assert.ok(r.ledger.some((e) => e.kind === 'tool' && e.ok), '中断前写入的工具仍有 ledger 记录');
    assert.equal(r.ledger.at(-1)?.kind, 'finish', 'ledger 以 finish 记录收尾');
  } finally {
    cleanup();
  }
});

test('E2E 故障 timeout：消费方超时 abort → aborted finish，快速返回', async () => {
  const { dir, cleanup } = sandbox();
  try {
    const model = createMockModel({ scenarios: [loadScenario('fault-timeout.json')] });
    const r = await runStubLoop({ task: '故障注入：流超时', model, sandboxDir: dir, timeoutMs: 200 });
    assert.ok(r.elapsedMs < 5000, `应在超时后快速返回，实际 ${r.elapsedMs}ms`);
    assert.equal(r.finish?.kind, 'aborted', 'mock 尊重 signal，吐 aborted finish');
    const faults = r.ledger.filter((e) => e.kind === 'fault' && e.fault === 'timeout');
    assert.equal(faults.length, 1, 'ledger 有 timeout 故障记录');
  } finally {
    cleanup();
  }
});

test('E2E 故障 timeout 的 fail-fast 反面：消费方从不 abort → 适配器快速抛错而非挂死', async () => {
  const model = createMockModel({
    scenarios: [{ name: 'no-abort', steps: [{ type: 'fail', mode: 'timeout', delayMs: 80 }, { type: 'finish' }] }],
  });
  const it = model.adapter.stream({
    provider: 'mock',
    model: 'no-abort',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  })[Symbol.asyncIterator]();
  await it.next(); // 开始
  await assert.rejects(() => it.next(), MockScenarioError, 'delayMs 耗尽仍无人 abort 时快速抛错');
});

test('E2E 故障 malformed_command：畸形行进 ledger、loop 不中断继续收尾', async () => {
  const { dir, cleanup } = sandbox();
  try {
    const model = createMockModel({ scenarios: [loadScenario('fault-malformed-command.json')] });
    const r = await runStubLoop({ task: '故障注入：畸形命令', model, sandboxDir: dir });
    assert.equal(r.finish?.kind, 'stop', 'loop 对畸形命令 fail-soft，流程继续');
    const malformed = r.ledger.filter((e) => e.kind === 'malformed-command');
    assert.equal(malformed.length, 2, '两条畸形行各有一条 ledger 记录');
    assert.deepEqual(malformed.map((e) => (e.kind === 'malformed-command' ? e.line : '')), [
      'tf-frobnicate x y z',
      'tf-write 没有引号的内容',
    ]);
    assert.ok(r.ledger.some((e) => e.kind === 'final'), '后续 tf-final 仍被处理');
  } finally {
    cleanup();
  }
});

test('E2E 故障 saturating_output：预算掐断 → aborted finish + ledger 记录', async () => {
  const { dir, cleanup } = sandbox();
  try {
    const model = createMockModel({ scenarios: [loadScenario('fault-saturating-output.json')] });
    const r = await runStubLoop({ task: '故障注入：饱和输出', model, sandboxDir: dir, budgetChars: 2000 });
    assert.ok(r.assistantText.length > 2000, '确实吐出了超过预算的输出');
    assert.equal(r.finish?.kind, 'aborted', '预算触发 abort，mock 吐 aborted finish');
    assert.ok(r.ledger.some((e) => e.kind === 'fault' && e.fault === 'budget-exceeded'), 'ledger 有预算故障记录');
  } finally {
    cleanup();
  }
});

test('E2E waitTools fail-fast：等不到回灌信号 → MOCK_WAITTOOLS_TIMEOUT error finish', async () => {
  const model = createMockModel({
    scenarios: [{ name: 'stuck', steps: [{ type: 'waitTools', count: 5, timeoutMs: 100 }, { type: 'finish' }] }],
  });
  let finishCode: string | undefined;
  for await (const c of model.adapter.stream({
    provider: 'mock',
    model: 'stuck',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  })) {
    if (c.type === 'finish') finishCode = (c.reason as { code?: string }).code;
  }
  assert.equal(finishCode, 'MOCK_WAITTOOLS_TIMEOUT', '快速失败而非挂死');
});

// ---------------------------------------------------------------------------
// entry 装配（不连真实宿主，用 duck-type 假 ctx）
// ---------------------------------------------------------------------------

test('entry apply：注册 adapter + 目录条目 + 挂 mockModel + effect 释放', async () => {
  const { default: apply } = await import('../src/entry/mock-provider.ts');
  const registered: { routes: string[]; count: number } = { routes: [], count: 0 };
  const disposers: (() => void)[] = [];
  const ctx = {
    llm: {
      registerAdapter(providers: string[], _adapter: unknown) {
        registered.routes = providers;
        const d = () => disposers.push(() => {});
        disposers.push(d);
        return d;
      },
      registerConfigurableProviders(_entries: readonly unknown[]) {
        registered.count += 1;
        return () => {};
      },
    },
    effect(fn: () => () => void) {
      disposers.push(fn());
    },
  };
  const model = apply(ctx, { scenarios: [{ name: 'e', steps: [{ type: 'finish' }] }], provider: 'mock-test' });
  assert.ok(model);
  assert.deepEqual(registered.routes, ['mock-test']);
  assert.equal(registered.count, 1, 'F10 目录条目已登记');
  assert.equal((ctx as { mockModel?: unknown }).mockModel, model, 'loop 侧信号源已挂上');
  for (const d of disposers.splice(0)) d();
});

test('entry apply：ctx.llm 缺失时 fail-fast 返回 undefined 并打印明确错误', async () => {
  const { default: apply } = await import('../src/entry/mock-provider.ts');
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  try {
    const r = apply({}, { scenarios: [{ name: 'noop', steps: [{ type: 'finish' }] }] });
    assert.equal(r, undefined);
  } finally {
    console.error = orig;
  }
  assert.ok(errors.some((m) => /ctx\.llm 不可用/.test(m)), '错误信息明确（红线 5 反面：快速失败）');
});

// ---------------------------------------------------------------------------
// 调用记录（供 08 号重放比对）
// ---------------------------------------------------------------------------

test('calls 记录：每次 stream 留痕（chunk 序列 / 文本 / finish）', async () => {
  const model = createMockModel({
    scenarios: [{ name: 'rec', steps: [{ type: 'text', text: 'hi' }, { type: 'finish' }] }],
  });
  for await (const c of model.adapter.stream({
    provider: 'mock',
    model: 'rec',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
  })) {
    void c;
  }
  assert.equal(model.calls.length, 1);
  const rec = model.calls[0]!;
  assert.equal(rec.scenario, 'rec');
  assert.ok(rec.finished && rec.finishKind === 'stop');
  assert.ok(rec.chunkTypes.includes('text-delta') && rec.chunkTypes.at(-1) === 'finish');
  assert.equal(rec.emittedText, 'hi');
});
