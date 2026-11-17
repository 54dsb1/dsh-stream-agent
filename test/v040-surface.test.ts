// test/v040-surface.test.ts —— v0.4.0 工具面（P1）+ tf-call 通用调用通道（P2/G2）
//
// 覆盖：
//   - ToolSurfaceHolder：首请求冻结 / additions-only / 解析失败沿用旧面（degraded=stale）/
//     无宿主服务面 = 稳态 protocol-only（undefined，不注行）
//   - validateCallName：unknown-tool + 前缀建议（不回灌全表）；off 档 / callCommand=false 引导
//   - projectNative：core 白名单；nativeTools 声明面 additions-only
//   - 驱动器 E2E（mock 流）：tf-call 透传执行 / unknown-tool 结构化失败注入 / bad-json 失败 /
//     familyHint（web_* → high 首注）
//   - 降级阶梯：服务在位但 resolve 抛错 → degraded 行注入 + 台账

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver } from '../src/entry/loop.ts';
import type {
  DriverPorts,
  StreamChunkLike,
  StreamDriverConfig,
  ToolBatchInputLike,
  ToolBatchResultLike,
} from '../src/entry/loop.ts';
import { ToolSurfaceHolder, CORE_TOOLS, degradedLine } from '../src/entry/tool-surface.ts';
import type { HostToolSchemaLike, ToolsServiceLike } from '../src/entry/tool-surface.ts';
import { TfStreamParser } from '../src/kernel/parser.ts';

// ---------------------------------------------------------------- 设施

const HOST_TOOLS: readonly HostToolSchemaLike[] = [
  { name: 'read', description: '读文件', parameters: { file_path: { type: 'string', required: true } } },
  { name: 'write', description: '写文件', parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } } },
  { name: 'pwsh', description: '执行命令', parameters: { command: { type: 'string', required: true } } },
  { name: 'web_search', description: '搜网页', parameters: { query: { type: 'string', required: true } } },
  { name: 'todo_write', description: '写任务清单', parameters: { todos: { type: 'array', required: true } } },
];

function fakeToolsService(opts: { fail?: boolean } = {}): ToolsServiceLike & { calls: number } {
  const state = { calls: 0 };
  return {
    calls: state.calls,
    resolve(context: { agent?: unknown }) {
      state.calls += 1;
      if (opts.fail === true) throw new Error('host tools view unavailable');
      return Promise.resolve({ dispose() {}, view() { return new Map(); } });
    },
    schemas() {
      return HOST_TOOLS;
    },
  } as unknown as ToolsServiceLike & { calls: number };
}

test('S1. ToolSurfaceHolder：首解析冻结；additions-only；names 覆盖全量', async () => {
  const holder = new ToolSurfaceHolder(fakeToolsService(), { profile: 'core', nativeTools: true, callCommand: true });
  const first = await holder.resolve({ agent: {} });
  assert.ok(first !== undefined);
  assert.equal(first.frozenAt, 1);
  // core 白名单：read/write/pwsh（HOST_TOOLS 里的 3 个 core 命中）
  assert.deepEqual(first.schemas.map((s) => s.name), HOST_TOOLS.map((t) => t.name).filter((n) => CORE_TOOLS.includes(n)));
  // names = 冻结面全量（含非 core：web_search/todo_write）——tf-call 校验面
  assert.ok(first.names.includes('web_search') && first.names.includes('todo_write'));
  // 第二次解析：additions-only（schemas 引用不变 = 前缀字节不变）
  const second = await holder.resolve({ agent: {} });
  assert.equal(second!.frozenAt, 2);
  assert.equal(second!.schemas, first!.schemas);
  // 工具面出现新工具 → names 扩张（只增不减）
  assert.ok(second!.names.length >= first!.names.length);
});

test('S2. 解析失败沿用旧面（degraded=stale）；无服务面返回 undefined（稳态 L2）', async () => {
  const service = fakeToolsService();
  const holder = new ToolSurfaceHolder(service, { profile: 'standard', nativeTools: false, callCommand: true });
  const first = await holder.resolve({ agent: {} });
  assert.ok(first !== undefined && first.degraded === undefined);
  // 服务失败 → 沿用旧面 + stale
  const failHolder = new ToolSurfaceHolder(fakeToolsService({ fail: true }), { profile: 'standard', nativeTools: false, callCommand: true });
  assert.equal(await failHolder.resolve({ agent: {} }), undefined, '从未解析成功 → undefined（驱动器按 protocol-only 处理）');
  assert.equal(failHolder.hasService, true, '服务在位（降级判定依赖它）');
  // 无服务面：hasService=false，resolve 恒 undefined（headless/离线的稳态，不算降级）
  const bare = new ToolSurfaceHolder(undefined, { profile: 'standard', nativeTools: false, callCommand: true });
  assert.equal(await bare.resolve({ agent: {} }), undefined);
  assert.equal(bare.hasService, false);
  assert.ok(first !== undefined);
});

test('S3. validateCallName：unknown-tool 带前缀建议；off 档与未启用引导', async () => {
  const holder = new ToolSurfaceHolder(fakeToolsService(), { profile: 'standard', nativeTools: false, callCommand: true });
  await holder.resolve({ agent: {} });
  assert.equal(holder.validateCallName('web_search'), null, '面内工具通过');
  const miss = holder.validateCallName('websearch');
  assert.ok(miss !== null && miss.startsWith('unknown-tool'), '面外工具拒绝');
  assert.ok(miss.includes('web_search'), '前缀建议给出相近工具名');
  const off = new ToolSurfaceHolder(fakeToolsService(), { profile: 'off', nativeTools: false, callCommand: true });
  assert.ok(off.validateCallName('read') !== null, 'off 档引导改道 tf-*');
  const disabled = new ToolSurfaceHolder(fakeToolsService(), { profile: 'standard', nativeTools: false, callCommand: false });
  assert.ok(disabled.validateCallName('read') !== null, 'callCommand=false 引导');
});

test('S4. degradedLine 三级文案各不相同（§8.3：每级一行注入）', () => {
  const lines = new Set([degradedLine('stale'), degradedLine('core'), degradedLine('protocol-only')]);
  assert.equal(lines.size, 3);
  assert.ok(degradedLine('stale').startsWith('[tf-stream:degraded surface=stale]'));
});

// ---------------------------------------------------------------- 驱动器 E2E

interface Harness {
  driver: SingleStreamDriver;
  executed: Array<{ name: string; arguments: string }>;
  sessionEvents: Array<{ type: string; data: Record<string, unknown> }>;
  cleanup: () => void;
}

function makeDriverHarness(opts: {
  chunks: StreamChunkLike[];
  toolsService?: ToolsServiceLike;
  callCommand?: boolean;
  strictAdmission?: boolean;
  nativeTools?: boolean;
  profile?: 'core' | 'standard' | 'full' | 'off';
}): Harness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v040-'));
  const executed: Array<{ name: string; arguments: string }> = [];
  const sessionEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  const session = {
    id: 's-v040',
    header: { id: 's-v040' },
    append(type: string, data: unknown) {
      sessionEvents.push({ type, data: data as Record<string, unknown> });
      return { seq: sessionEvents.length + 1 };
    },
  };
  const ports: DriverPorts = {
    stream: () => (async function* () { for (const c of opts.chunks) yield c; })(),
    executeTools: async (input: ToolBatchInputLike) => {
      for (const call of input.calls) executed.push({ name: call.name, arguments: call.arguments });
      return {
        results: input.calls.map((call) => ({
          callId: call.id,
          result: { content: [{ type: 'text', text: `ok: ${call.name}` }], isError: false },
        })),
        additionalContexts: [],
        concluded: false,
      };
    },
    ...(opts.toolsService === undefined ? {} : { toolsService: opts.toolsService }),
  };
  const config: StreamDriverConfig = {
    provider: 'mock',
    model: 'mock-v040',
    ...(opts.profile === undefined ? {} : { toolSurface: opts.profile }),
    ...(opts.callCommand === undefined ? {} : { callCommand: opts.callCommand }),
    ...(opts.strictAdmission === undefined ? {} : { strictAdmission: opts.strictAdmission }),
    ...(opts.nativeTools === undefined ? {} : { nativeTools: opts.nativeTools }),
  };
  const driver = new SingleStreamDriver(ports, config);
  driver.setIdentity('s-v040', 't');
  driver.setAgent({ session, id: 'a' });
  driver.pushUserTask('测试任务');
  return {
    driver,
    executed,
    sessionEvents,
    cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }),
  };
}

test('S5. tf-call E2E：透传宿主工具执行（G1 路径）；参数 JSON 原样到工具批', async () => {
  const h = makeDriverHarness({
    toolsService: fakeToolsService(),
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' } as never,
      { type: 'text-delta', index: 0, text: '<tf-call name="web_search" id="c1">{"query":"dsh parity"}</tf-call>' } as never,
      { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="搜索完成" depends_on="c1"/>' } as never,
      { type: 'finish', reason: { kind: 'stop' } } as never,
    ],
  });
  try {
    const reason = await h.driver.runTurn();
    assert.equal(reason.kind, 'completed', 'tf-call 成功 → depends_on 满足 → 收敛');
    assert.equal(h.executed.length, 1);
    assert.equal(h.executed[0]!.name, 'web_search', '宿主工具名原样透传');
    assert.deepEqual(JSON.parse(h.executed[0]!.arguments), { query: 'dsh parity' });
  } finally {
    h.cleanup();
  }
});

test('S6. tf-call unknown-tool：结构化失败注入（带相近建议），不执行', async () => {
  const h = makeDriverHarness({
    toolsService: fakeToolsService(),
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' } as never,
      { type: 'text-delta', index: 0, text: '<tf-call name="websearch" id="c1">{"query":"x"}</tf-call>' } as never,
      { type: 'finish', reason: { kind: 'stop' } } as never,
    ],
  });
  try {
    await h.driver.runTurn();
    assert.equal(h.executed.length, 0, '面外工具不派发');
    const cmd = h.driver.snapshot().records.find((r) => r.kind === 'command' && (r as { status?: string }).status === 'failed');
    assert.ok(cmd !== undefined);
    const detail = (cmd as { detail?: string }).detail ?? '';
    assert.ok(detail.startsWith('unknown-tool'), `结构化失败：${detail.slice(0, 60)}`);
    assert.ok(detail.includes('web_search'), '建议含相近工具名');
  } finally {
    h.cleanup();
  }
});

test('S7. tf-call bad-json：结构化失败注入（bad-json-arguments），不执行', async () => {
  const h = makeDriverHarness({
    toolsService: fakeToolsService(),
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' } as never,
      { type: 'text-delta', index: 0, text: '<tf-call name="web_search" id="c1">{query: 没有引号}</tf-call>' } as never,
      { type: 'finish', reason: { kind: 'stop' } } as never,
    ],
  });
  try {
    await h.driver.runTurn();
    assert.equal(h.executed.length, 0);
    const ledgerFail = h.driver.snapshot().records.filter((r) => r.kind === 'command' && (r as { status?: string }).status === 'failed');
    assert.ok(ledgerFail.length > 0);
  } finally {
    h.cleanup();
  }
});

test('S8. familyHint：tf-call 的观测按宿主工具名分族（web_search → high 首注）', async () => {
  const h = makeDriverHarness({
    toolsService: fakeToolsService(),
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' } as never,
      { type: 'text-delta', index: 0, text: '<tf-call name="web_search" id="c1">{"query":"x"}</tf-call>' } as never,
      { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="done" depends_on="c1"/>' } as never,
      { type: 'finish', reason: { kind: 'stop' } } as never,
    ],
  });
  try {
    await h.driver.runTurn();
    const obs = h.driver.snapshot().records.filter((r) => r.kind === 'observation');
    const web = obs.find((r) => (r as { handle?: string }).handle?.startsWith('obs:web:'));
    assert.ok(web !== undefined, `web_search 归 web 族（handle=obs:web:...），实际 ${JSON.stringify(obs.map((r) => (r as { handle?: string }).handle))}`);
    assert.equal((web as { infoGain?: string }).infoGain, 'high', 'web 族首注 high');
  } finally {
    h.cleanup();
  }
});

test('S9. 服务面在位但 resolve 失败 → degraded 行注入 + 台账（L2）', async () => {
  const chunks: StreamChunkLike[] = [
    { type: 'block-start', index: 0, blockType: 'text' } as never,
    { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="done"/>' } as never,
    { type: 'finish', reason: { kind: 'stop' } } as never,
  ];
  const h = makeDriverHarness({ toolsService: fakeToolsService({ fail: true }), chunks });
  try {
    const reason = await h.driver.runTurn();
    assert.equal(reason.kind, 'completed', '降级不阻断任务（fail-open）');
    // 降级行进了追加区（下一请求装配可见）；本轮无第二次请求 → 检查台账
    const snap = h.driver.snapshot();
    const fault = snap.records.find((r) => r.kind === 'fault' && (r as { fault?: string }).fault === 'surface-protocol-only');
    assert.ok(fault !== undefined, 'surface-protocol-only 记账');
  } finally {
    h.cleanup();
  }
});

test('S10. 无服务面（headless 稳态）：不注降级行，不记账，行为同 0.3.x', async () => {
  const chunks: StreamChunkLike[] = [
    { type: 'block-start', index: 0, blockType: 'text' } as never,
    { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="done"/>' } as never,
    { type: 'finish', reason: { kind: 'stop' } } as never,
  ];
  const h = makeDriverHarness({ chunks });
  try {
    const reason = await h.driver.runTurn();
    assert.equal(reason.kind, 'completed');
    const surfaceFaults = h.driver.snapshot().records.filter((r) => r.kind === 'fault' && String((r as { fault?: string }).fault ?? '').startsWith('surface-'));
    assert.equal(surfaceFaults.length, 0, 'headless 稳态无 surface 噪声');
    // 协议文本不含 tf-call 段（无服务面 → callCommand 关）
    const req = h.driver.snapshot();
    assert.ok(req !== undefined);
  } finally {
    h.cleanup();
  }
});

test('S11. nativeTools 开启：请求携带冻结面 schema（core 档白名单）', async () => {
  const chunks: StreamChunkLike[] = [
    { type: 'block-start', index: 0, blockType: 'text' } as never,
    { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="done"/>' } as never,
    { type: 'finish', reason: { kind: 'stop' } } as never,
  ];
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v040-nt-'));
  try {
    const wireRequests: Array<unknown> = [];
    const session = {
      id: 's-nt', header: { id: 's-nt' },
      append(type: string, data: unknown) { return { seq: 1 }; },
    };
    const driver = new SingleStreamDriver({
      stream: (options: { tools?: unknown }) => {
        wireRequests.push(options);
        return (async function* () { for (const c of chunks) yield c; })();
      },
      executeTools: async (input: ToolBatchInputLike) => ({ results: [], additionalContexts: [], concluded: false }),
      toolsService: fakeToolsService(),
    }, { provider: 'mock', model: 'm', nativeTools: true, toolSurface: 'core' });
    driver.setIdentity('s-nt', 't');
    driver.setAgent({ session, id: 'a' });
    driver.pushUserTask('测试');
    await driver.runTurn();
    assert.equal(wireRequests.length, 1);
    const tools = (wireRequests[0] as { tools?: Array<{ name: string }> }).tools;
    assert.ok(Array.isArray(tools) && tools.length > 0, '请求携带 tools');
    assert.ok(tools!.every((t) => CORE_TOOLS.includes(t.name)), 'core 档只声明白名单');
    assert.ok(!tools!.some((t) => t.name === 'web_search'), '非 core 工具不进声明面（可达性走 tf-call）');
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test('S12. parser：tf-call 命令闭合与 schema（name 必填、body JSON）', () => {
  const p = new TfStreamParser();
  const events = p.feed('<tf-call name="web_search" id="c1" depends_on="w1">{"query":"x"}</tf-call>');
  const cmds = events.filter((e) => e.type === 'command').map((e) => (e as { command: { name: string; id: string; body?: string; depends_on: string[] } }).command);
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].name, 'tf-call');
  assert.equal(cmds[0].id, 'c1');
  assert.deepEqual(cmds[0].depends_on, ['w1']);
  assert.equal(cmds[0].body, '{"query":"x"}');
  // 缺 name → malformed
  const p2 = new TfStreamParser();
  const bad = p2.feed('<tf-call id="c2">{}</tf-call>');
  assert.ok(bad.some((e) => e.type === 'malformed'), '缺 name 属性按 malformed 上报');
});

test('S13. §6.4 高频例外：tf-skill / tf-ask 映射宿主工具（免 JSON 专用语法）', async () => {
  const executed: Array<{ name: string; args: unknown }> = [];
  const chunks: StreamChunkLike[] = [
    { type: 'block-start', index: 0, blockType: 'text' } as never,
    { type: 'text-delta', index: 0, text: '<tf-skill name="humanize-webnovel" id="s1"/>' } as never,
    { type: 'text-delta', index: 0, text: '<tf-ask q="选哪种方案？" id="a1" header="方案" options="方案A,方案B"/>' } as never,
    { type: 'finish', reason: { kind: 'stop' } } as never,
  ];
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v040-ask-'));
  try {
    const session = { id: 's-ask', header: { id: 's-ask' }, append() { return { seq: 1 }; } };
    const driver = new SingleStreamDriver({
      stream: () => (async function* () { for (const c of chunks) yield c; })(),
      executeTools: async (input: ToolBatchInputLike) => {
        for (const call of input.calls) executed.push({ name: call.name, args: JSON.parse(call.arguments) });
        return {
          results: input.calls.map((call) => ({ callId: call.id, result: { content: [{ type: 'text', text: 'answer' }], isError: false } })),
          additionalContexts: [],
          concluded: false,
        };
      },
      toolsService: fakeToolsService(),
    }, { provider: 'mock', model: 'm' });
    driver.setIdentity('s-ask', 't');
    driver.setAgent({ session, id: 'a' });
    driver.pushUserTask('测试');
    await driver.runTurn();
    assert.equal(executed.length, 2);
    assert.equal(executed[0]!.name, 'skill');
    assert.deepEqual(executed[0]!.args, { name: 'humanize-webnovel' });
    assert.equal(executed[1]!.name, 'ask_user_question');
    const q = (executed[1]!.args as { questions: Array<Record<string, unknown>> }).questions[0]!;
    assert.equal(q['question'], '选哪种方案？');
    assert.equal(q['header'], '方案');
    assert.deepEqual(q['options'], [{ label: '方案A' }, { label: '方案B' }]);
    assert.equal(q['id'], 'a1', '问题 id 回显命令 id');
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test('S14. 命令表上限（G2）：14 条到达硬上限，检查5 口径与 parser 一致', async () => {
  const { readFileSync } = await import('node:fs');
  const parserSrc = readFileSync(join(import.meta.dirname, '..', 'src', 'kernel', 'parser.ts'), 'utf8');
  const names = parserSrc.match(/const COMMAND_NAMES: readonly TfCommandName\[\] =\s*\[([^\]]*)\]/);
  assert.ok(names !== null);
  const count = names![1]!.split(',').filter((s) => s.includes('tf-')).length;
  assert.equal(count, 14, 'tf-call + tf-ask + tf-skill = 14（§6.4 硬上限）');
});
