// test/f5-plan.test.ts —— F5 计划与验收（0.4.0 规划内容随 0.3.0 实施）
//
// 覆盖：
//   - parser：tf-plan body 命令；accepts 公共属性在 tf-write/tf-bash 上合法
//   - parsePlanItems：`- [id] 描述` 行解析、去重、忽略非验收行
//   - 驱动器 E2E：tf-plan 全量注入一次 → accepts 回执差分 → 未验证验收项拦截过早 tf-final
//     → 全部验证后收敛；请求里只注差分（后续请求不再重复全量计划）
//   - enablePlan: false → tf-plan 结构化失败（回退点），tf-final 不做验收拦截
//   - 自述不算证据：没有命令回执的验收项永远 open

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, normalizeStreamShim, parsePlanItems } from '../src/entry/loop.ts';
import type { DriverPorts, StreamRequestOptions, ToolBatchInputLike, ToolBatchResultLike, StreamDriverConfig } from '../src/entry/loop.ts';
import { TfStreamParser } from '../src/kernel/parser.ts';
import { createMockModel } from '../src/entry/mock-provider.ts';
import type { MockModel, Scenario } from '../src/entry/mock-provider.ts';

// ---------------------------------------------------------------------------
// 测试设施
// ---------------------------------------------------------------------------

function createSandboxExecutor(): (input: ToolBatchInputLike) => Promise<ToolBatchResultLike> {
  return async (input) => ({
    results: input.calls.map((c) => ({ callId: c.id, result: { content: [{ type: 'text', text: `${c.name}:ok` }], isError: false } })),
  });
}

interface Harness {
  driver: SingleStreamDriver;
  wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }>;
  cleanup: () => void;
}

function makeHarness(opts: { task: string; scenarios: Scenario[]; config?: Partial<StreamDriverConfig> }): Harness {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-f5-'));
  const model = createMockModel({ scenarios: opts.scenarios, provider: 'mock' });
  const wireRequests: Array<StreamRequestOptions & { contentTexts: string[] }> = [];
  const ports: DriverPorts = {
    stream: (options) => {
      wireRequests.push({ ...options, contentTexts: options.messages.map((m) => m.content.map((b) => b.text ?? '').join('\n')) });
      return normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal }));
    },
    executeTools: createSandboxExecutor(),
    onToolSettled: () => model.notifyToolResult(),
  };
  const config: StreamDriverConfig = { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000, ...opts.config };
  const driver = new SingleStreamDriver(ports, config);
  driver.pushUserTask(opts.task);
  return { driver, wireRequests, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
}

function joinTexts(h: Harness): string {
  return h.wireRequests.map((r) => r.contentTexts.join('\n')).join('\n=====\n');
}

// ---------------------------------------------------------------------------

describe('F5：parser 与计划解析', () => {
  it('P1. tf-plan body 命令闭合即派发；accepts 属性在 tf-write / tf-bash 上合法', () => {
    const parser = new TfStreamParser();
    const events = parser.feed(
      '<tf-plan id="p1">\n- [a1] 生成 intro.md\n- [a2] 生成 summary.md\n</tf-plan>'
      + '<tf-write path="intro.md" id="w1" accepts="a1">x</tf-write>'
      + '<tf-bash cmd="ls" id="b1" accepts="a2"/>',
    );
    const commands = events.filter((e): e is Extract<typeof e, { type: 'command' }> => e.type === 'command').map((e) => e.command);
    assert.equal(commands.length, 3, '三个命令都应闭合');
    assert.equal(commands[0]!.name, 'tf-plan');
    assert.equal(commands[1]!.attrs['accepts'], 'a1');
    assert.equal(commands[2]!.attrs['accepts'], 'a2');
  });

  it('P2. parsePlanItems：解析验收项行、去重、忽略普通文本行', () => {
    const items = parsePlanItems('说明文字\n- [a1] 第一项\n* [a2] 第二项\n- [a1] 重复忽略\n没有标记的行\n- [a3_1] 带下划线的 id');
    assert.deepEqual(items.map((i) => i.id), ['a1', 'a2', 'a3_1']);
    assert.equal(items[0]!.text, '第一项');
  });
});

describe('F5：驱动器 E2E', () => {
  const planTask = '计划演练：两个文件。';

  it('E1. 全量计划注入一次 → accepts 回执差分 → 未验证拦截过早 final → 验证后收敛', async () => {
    const h = makeHarness({
      task: planTask,
      scenarios: [
        {
          name: 'f5-premature',
          match: { promptIncludes: 'tf-final 过早' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '补齐验收项。\n' },
            { type: 'commands', commands: ['<tf-write path="summary.md" id="w2" accepts="a2">s</tf-write>', '<tf-final id="f2" summary="a1: intro.md；a2: summary.md"/>'] },
            { type: 'waitTools', count: 1, timeoutMs: 5000 },
            { type: 'finish', reason: 'stop' },
          ],
        },
        {
          name: 'f5-first',
          match: { promptIncludes: '计划演练' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '声明计划并完成第一项。\n' },
            { type: 'commands', commands: [
              '<tf-plan id="p1">\n- [a1] 生成 intro.md\n- [a2] 生成 summary.md\n</tf-plan>',
              '<tf-write path="intro.md" id="w1" accepts="a1">i</tf-write>',
              '<tf-final id="f1" summary="占位"/>',
            ] },
            { type: 'waitTools', count: 1, timeoutMs: 5000 },
            { type: 'finish', reason: 'stop' },
          ],
        },
      ],
    });
    try {
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed', `应收敛：${JSON.stringify(reason)}`);

      // 请求 2：全量计划一次（带 a1 已验证状态）+ 过早 final 拦截
      const req2 = h.wireRequests[1]!.contentTexts.join('\n');
      assert.ok(req2.includes('[tf-stream:plan v1]'), '请求 2 应注入全量计划');
      assert.ok(req2.includes('- [a1] 生成 intro.md'), '计划清单应含验收项');
      assert.ok(req2.includes('✓ 已验证（回执：w1'), 'a1 的验证状态与回执应在全量清单中');
      assert.ok(req2.includes('[a2] 生成 summary.md（未验证）'), 'a2 应标未验证');
      assert.ok(req2.includes('tf-final 过早'), '未验证的 a2 应拦截过早 final');

      // 任务收敛后不再有请求 3；即使有，也不重复全量计划
      const req3 = h.wireRequests[2]?.contentTexts.join('\n') ?? '';
      assert.ok(!req3.includes('[tf-stream:plan v1]'), `请求 3 不得重复全量计划：${req3.slice(0, 400)}`);

      // 台账：plan 与 plan-accept 各有记录
      const records = h.driver.snapshot().records;
      assert.ok(records.some((r) => r.kind === 'plan' && r.kind === 'plan' && r.total === 2), '应有 plan 记录');
      assert.ok(records.some((r) => r.kind === 'plan-accept' && r.acceptId === 'a1'), 'a1 应有验证记录');
    } finally {
      h.cleanup();
    }
  });

  it('E2. 自述不算证据：没有命令回执的验收项保持 open，final 一直被拦截', async () => {
    const h = makeHarness({
      task: planTask,
      scenarios: [
        {
          name: 'f5-claim',
          match: { promptIncludes: 'tf-final 过早' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '我声称完成了。\n' },
            { type: 'commands', commands: ['<tf-final id="f9" summary="全部完成（自述）"/>'] },
            { type: 'finish', reason: 'stop' },
          ],
        },
        {
          name: 'f5-first',
          match: { promptIncludes: '计划演练' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '声明计划，不执行任何命令。\n' },
            { type: 'commands', commands: ['<tf-plan id="p1">\n- [a1] 生成 intro.md\n</tf-plan>', '<tf-final id="f1" summary="占位"/>'] },
            { type: 'finish', reason: 'stop' },
          ],
        },
      ],
      config: { maxReentries: 2 },
    });
    try {
      const reason = await h.driver.runTurn();
      // 无回执 → 验收项永远 open → 回合以 blocked（重入上限）结束，绝不 completed
      assert.equal(reason.kind, 'blocked', `自述不得通过验收：${JSON.stringify(reason)}`);
      const text = joinTexts(h);
      assert.ok(!text.includes('✓ [a1]'), '无命令回执不得产生验证差分');
    } finally {
      h.cleanup();
    }
  });

  it('E3. enablePlan: false → tf-plan 结构化失败（回退点），tf-final 不做验收拦截', async () => {
    const h = makeHarness({
      task: planTask,
      scenarios: [
        {
          name: 'f5-off',
          match: { promptIncludes: 'plan-disabled' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '计划关闭，直接收尾。\n' },
            { type: 'commands', commands: ['<tf-final id="f2" summary="done"/>'] },
            { type: 'finish', reason: 'stop' },
          ],
        },
        {
          name: 'f5-first',
          match: { promptIncludes: '计划演练' },
          chunking: { charsPerChunk: 0, delayMs: 0 },
          steps: [
            { type: 'text', text: '尝试声明计划。\n' },
            { type: 'commands', commands: ['<tf-plan id="p1">\n- [a1] 生成 intro.md\n</tf-plan>'] },
            { type: 'waitTools', count: 1, timeoutMs: 5000 },
            { type: 'finish', reason: 'stop' },
          ],
        },
      ],
      config: { enablePlan: false },
    });
    try {
      const reason = await h.driver.runTurn();
      assert.equal(reason.kind, 'completed');
      const req2 = h.wireRequests[1]!.contentTexts.join('\n');
      assert.ok(req2.includes('plan-disabled'), 'tf-plan 应结构化失败');
      assert.ok(!req2.includes('[tf-stream:plan'), '关闭时不得注入任何计划块');
    } finally {
      h.cleanup();
    }
  });
});
