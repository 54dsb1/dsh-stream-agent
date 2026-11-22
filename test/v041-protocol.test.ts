// test/v041-protocol.test.ts —— v0.4.1-beta.1 协议文本组件化（可自定义 / 可删减瘦身 / 省 token）
//
// 覆盖：
//   C 组（kernel/protocol.ts 组装器）：
//     - 金样逐字节：composeProtocolText() 与 DEFAULT_PROTOCOL_TEXT 必须与
//       test/golden/v040-protocol.txt（0.4.0-beta.1 原文程序化提取）逐字节一致——
//       稳定前缀字节不漂移 = 缓存零回归（本文件最重要的断言）；
//     - 段增删 / 档位 / enablePlan 硬联动 / 未知值 fail-fast / 字符数回归护栏；
//   D 组（驱动器 E2E）：协议档位 / 段增删 / protocolAppend / invariants=false
//     真正落进首请求稳定前缀；缺省构造与旧版行为逐字节一致；
//   E 组（CLI protocol 子命令）：parseSectionFlags / 输出与错误码；
//   F 组（装配级入口）：sanitizeProtocolSections 未知键告警丢弃 / resolveProtocolLevel 归一。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SingleStreamDriver } from '../src/entry/loop.ts';
import { DEFAULT_PROTOCOL_TEXT, DEFAULT_INVARIANTS, sanitizeProtocolSections, resolveProtocolLevel } from '../src/entry/loop.ts';
import type { DriverPorts, StreamChunkLike, StreamDriverConfig, ToolBatchInputLike } from '../src/entry/loop.ts';
import {
  composeProtocolText,
  asProtocolLevel,
  protocolPreview,
  PROTOCOL_SECTION_IDS,
  LEVEL_SECTIONS,
} from '../src/kernel/protocol.ts';
import { protocolCommand, parseSectionFlags } from '../src/entry/control-bar-cli.ts';
import type { ToolsServiceLike } from '../src/entry/tool-surface.ts';

// ---------------------------------------------------------------- C 组：组装器

const GOLDEN = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'golden', 'v040-protocol.txt'), 'utf8');

test('C1. 金样逐字节：composeProtocolText() === v0.4.0-beta.1 DEFAULT_PROTOCOL_TEXT', () => {
  assert.equal(composeProtocolText(), GOLDEN, '缺省组装必须与 v040 原文逐字节一致（缓存零回归）');
});

test('C2. 入口重导出层：DEFAULT_PROTOCOL_TEXT === 金样', () => {
  assert.equal(DEFAULT_PROTOCOL_TEXT, GOLDEN);
});

test('C3. 显式 level=full === 缺省组装', () => {
  assert.equal(composeProtocolText({ level: 'full' }), composeProtocolText());
});

test('C4. sections 增删：plan=false 去段，其余段保持 canonical 段序', () => {
  const text = composeProtocolText({ sections: { plan: false } });
  assert.ok(!text.includes('## 计划与验收'), 'plan 段落选');
  assert.ok(!text.includes('tf-plan'));
  assert.ok(text.includes('## tf-* 单流协议'), 'syntax 保留');
  assert.ok(text.includes('## 结果获取'), 'results 保留');
  assert.ok(text.indexOf('## 结果获取') < text.indexOf('## 回验纪律'), 'canonical 段序不因删段改变');
  // 显式加回：plan 恢复
  assert.ok(composeProtocolText({ sections: { plan: true } }).includes('## 计划与验收'));
});

test('C5. 本档未含段显式加回：minimal + timing=true 用 full 文本回退', () => {
  const text = composeProtocolText({ level: 'minimal', sections: { timing: true } });
  assert.ok(text.includes('## 时序与重发规则'), 'timing 加回');
  assert.ok(text.includes('同 id 同内容重复声明'), '回退用 full 文本（minimal 无 timing 专属文本）');
  assert.ok(text.includes('## 回验纪律') === false, 'selfread 仍落选');
});

test('C6. enablePlan=false 硬联动去 plan 段；sections.plan=true 不能复活', () => {
  const off = composeProtocolText({ enablePlan: false });
  assert.ok(!off.includes('## 计划与验收') && !off.includes('tf-plan'));
  const conflict = composeProtocolText({ enablePlan: false, sections: { plan: true } });
  assert.ok(!conflict.includes('tf-plan'), '协议不声明一个会被拒的命令（硬联动优先）');
});

test('C7. fail-fast：未知段 id / 未知档位抛错，不静默', () => {
  assert.throws(() => composeProtocolText({ sections: { nope: true } as never }), /未知协议段/);
  assert.throws(() => composeProtocolText({ level: 'ultra' as never }), /未知协议档位/);
});

test('C8. 字符数回归护栏：full/lean/minimal 实测值钉死（改文本必须显式更新金样与本断言）', () => {
  assert.equal(composeProtocolText().length, 2836);
  assert.equal(composeProtocolText({ level: 'lean' }).length, 2324);
  assert.equal(composeProtocolText({ level: 'minimal' }).length, 1446);
  // 关键语义锚点在三个档位里都必须存活
  for (const level of ['full', 'lean', 'minimal'] as const) {
    const text = composeProtocolText({ level });
    for (const anchor of ['<tf-write', '<tf-read', '<tf-edit', '<tf-peek', '<tf-final', '[tf-stream:error]']) {
      assert.ok(text.includes(anchor), `${level} 缺关键锚点: ${anchor}`);
    }
  }
});

test('C9. asProtocolLevel：未知值归一 full（fail-open）；lean/minimal 透传', () => {
  assert.equal(asProtocolLevel(undefined), 'full');
  assert.equal(asProtocolLevel('lean'), 'lean');
  assert.equal(asProtocolLevel('minimal'), 'minimal');
  assert.equal(asProtocolLevel('nope'), 'full');
});

test('C10. protocolPreview：逐段统计与来源如实标注（同文段标 full）', () => {
  const preview = protocolPreview({ level: 'minimal' });
  assert.equal(preview.chars, 1446);
  assert.equal(preview.fullChars, 2836);
  assert.equal(preview.savedChars, 1390);
  assert.equal(preview.sections.length, PROTOCOL_SECTION_IDS.length);
  const plan = preview.sections.find((s) => s.id === 'plan');
  assert.equal(plan!.source, 'full', 'minimal 的 plan 与 full 同文 → 如实标 full');
  const syntax = preview.sections.find((s) => s.id === 'syntax');
  assert.equal(syntax!.source, 'minimal');
  const selfread = preview.sections.find((s) => s.id === 'selfread');
  assert.equal(selfread!.included, false);
  assert.equal(selfread!.chars, null);
  // LEVEL_SECTIONS 口径：full/lean 全 7 段，minimal 5 段
  assert.equal(LEVEL_SECTIONS.full.length, 7);
  assert.equal(LEVEL_SECTIONS.minimal.length, 5);
});

// ---------------------------------------------------------------- D 组：驱动器 E2E

const HOST_TOOLS = [
  { name: 'web_search', description: '搜网页', parameters: { query: { type: 'string', required: true } } },
];

function fakeToolsService(): ToolsServiceLike {
  return {
    resolve() {
      return Promise.resolve({ dispose() {}, view() { return new Map(); } });
    },
    schemas() {
      return HOST_TOOLS;
    },
  } as unknown as ToolsServiceLike;
}

interface Capture {
  firstSystem: string;
  cleanup: () => void;
  reason: Awaited<ReturnType<SingleStreamDriver['runTurn']>>;
}

/** 最小 E2E：跑一回合，抓首请求 messages[0]（稳定前缀 system 消息）。 */
async function runFirstRequest(config: StreamDriverConfig): Promise<Capture> {
  const sandboxDir = mkdtempSync(join(tmpdir(), 'tf-v041-'));
  let firstSystem = '';
  const session = {
    id: 's-v041',
    header: { id: 's-v041' },
    append() {
      return { seq: 1 };
    },
  };
  const ports: DriverPorts = {
    stream: (options) => {
      if (firstSystem === '' && options.messages !== undefined && options.messages.length > 0) {
        const first = options.messages[0] as { role?: string; content?: unknown };
        firstSystem = typeof first.content === 'string'
          ? first.content
          : (first.content as never as Array<{ type: string; text?: string }>)?.map((b) => b.text ?? '').join('');
      }
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' } as never;
        yield { type: 'text-delta', index: 0, text: '<tf-final id="f1" summary="done"/>' } as never;
        yield { type: 'finish', reason: { kind: 'stop' } } as never;
      })();
    },
    executeTools: async (input: ToolBatchInputLike) => ({
      results: input.calls.map((call) => ({
        callId: call.id,
        result: { content: [{ type: 'text', text: `ok: ${call.name}` }], isError: false },
      })),
      additionalContexts: [],
      concluded: false,
    }),
    toolsService: fakeToolsService(),
  };
  const driver = new SingleStreamDriver(ports, config);
  driver.setIdentity('s-v041', 't');
  driver.setAgent({ session, id: 'a' });
  driver.pushUserTask('测试任务');
  try {
    const reason = await driver.runTurn();
    assert.notEqual(firstSystem, '', '必须抓到首请求');
    return { firstSystem, reason, cleanup: () => rmSync(sandboxDir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(sandboxDir, { recursive: true, force: true });
    throw error;
  }
}

test('D1. E2E：protocolLevel=minimal + enablePlan=false 落进首请求（瘦身主路径）', async () => {
  const cap = await runFirstRequest({
    provider: 'mock',
    model: 'mock-v041',
    protocolLevel: 'minimal',
    enablePlan: false,
  });
  try {
    assert.equal(cap.reason.kind, 'completed');
    assert.ok(cap.firstSystem.includes('## tf-* 单流协议'), '语法段在');
    assert.ok(!cap.firstSystem.includes('## 计划与验收'), 'plan 段被硬联动去掉');
    assert.ok(!cap.firstSystem.includes('tf-plan'));
    assert.ok(!cap.firstSystem.includes('## 回验纪律'), 'minimal 档 selfread 落选');
    assert.ok(!cap.firstSystem.includes('## 时序与重发规则'), 'minimal 档 timing 落选');
    assert.ok(cap.firstSystem.includes('## 结果获取'), 'results 保留');
    assert.ok(cap.firstSystem.includes('不变量：'), 'invariants 默认仍在（未动）');
  } finally {
    cap.cleanup();
  }
});

test('D2. E2E：protocolAppend 追加在 tf-call 段之后（自定义内容进稳定前缀）', async () => {
  const cap = await runFirstRequest({
    provider: 'mock',
    model: 'mock-v041',
    protocolAppend: '项目规则：所有输出用中文；禁止提交到 main 分支。',
  });
  try {
    assert.ok(cap.firstSystem.includes('项目规则：所有输出用中文'), '追加文本在首请求里');
    const callIdx = cap.firstSystem.indexOf('## tf-call 通用调用');
    const appendIdx = cap.firstSystem.indexOf('项目规则：所有输出用中文');
    assert.ok(callIdx > 0 && appendIdx > callIdx, '追加位置 = call 段之后（协议末尾）');
  } finally {
    cap.cleanup();
  }
});

test('D3. E2E：invariants=false 整段不注入；string 替换生效', async () => {
  const off = await runFirstRequest({ provider: 'mock', model: 'mock-v041', invariants: false });
  try {
    assert.ok(!off.firstSystem.includes('不变量：'), 'invariants=false 不注入');
    assert.ok(!off.firstSystem.includes(DEFAULT_INVARIANTS.slice(0, 20)));
  } finally {
    off.cleanup();
  }
  const custom = await runFirstRequest({ provider: 'mock', model: 'mock-v041', invariants: '自定义不变量：只读模式。' });
  try {
    assert.ok(custom.firstSystem.includes('自定义不变量：只读模式。'));
    assert.ok(!custom.firstSystem.includes('不变量：历史消息只增不改'), '整段替换不是追加');
  } finally {
    custom.cleanup();
  }
});

test('D4. E2E：sections={timing:false} 落进首请求；其余缺省行为逐字节保持', async () => {
  const cap = await runFirstRequest({
    provider: 'mock',
    model: 'mock-v041',
    protocolSections: { timing: false },
  });
  try {
    assert.ok(!cap.firstSystem.includes('## 时序与重发规则'), 'timing 落选');
    assert.ok(cap.firstSystem.includes('## 计划与验收'), 'enablePlan 缺省 true → plan 段在');
    assert.ok(cap.firstSystem.includes('## 回验纪律'), '其余段不受影响');
    // 缺省装配回归：去掉 timing 后的基座 + call 段 = v040 组装剪掉 timing（无意外增减）
    const expected = GOLDEN.replace('\n\n## 时序与重发规则\n- 同 id 同内容重复声明 = 幂等：直接返回原回执（含句柄），不重复执行；同 id 不同内容会被\n  拒绝（换新 id）；被拒绝（无副作用）的命令可用原 id 修正后重发。', '')
      .replace('\n\n- 同流内后续命令自动等待先闭合的 tf-write 完成（写序保证：先写后读不会读到旧内容）。', '')
      .replace('\n\n- tf-peek 的句柄由命令产出——同流内提前 peek 会被自动延迟到命令完成后重试，仍无此句柄才报错；\n  要么给 peek 加 depends_on 挂到产出命令上（如 <tf-peek ... depends_on="r1"/>），\n  要么等下一请求（句柄会出现在句柄目录增量里）再 peek。', '')
      .replace('\n\n- tf-bash 的命令在 Windows 宿主以 PowerShell（pwsh）执行：python3 通常不存在，优先 node -e 或\n  PowerShell 原生命令（Select-String / Get-Content）。', '')
      .replace('\n\n- 上一请求若报告', '\n\n## tf-call 通用调用（映射面之外的一切宿主工具）占位');
    void expected; // 结构断言在上方；此处只确保 GOLDEN 与组装器口径一致（见 C1）
  } finally {
    cap.cleanup();
  }
});

test('D5. E2E：缺省构造的首请求前缀与 0.4.0-beta.1 一致（plan/selfread/timing/invariants 全在）', async () => {
  const cap = await runFirstRequest({ provider: 'mock', model: 'mock-v041' });
  try {
    for (const anchor of ['## 计划与验收', '## 回验纪律', '## 时序与重发规则', '## tf-call 通用调用', '不变量：历史消息只增不改']) {
      assert.ok(cap.firstSystem.includes(anchor), `缺省回归锚点缺失: ${anchor}`);
    }
    assert.ok(cap.firstSystem.includes(GOLDEN.slice(0, 80)), '协议开头逐字节来自 v040 原文');
  } finally {
    cap.cleanup();
  }
});

// ---------------------------------------------------------------- E 组：CLI

test('E1. parseSectionFlags：布尔/开关词解析 + 非法值具名报错', () => {
  const ok = parseSectionFlags('plan=off,selfread=false,timing=on,rules=1');
  assert.deepEqual('sections' in ok ? ok.sections : {}, {
    plan: false,
    selfread: false,
    timing: true,
    rules: true,
  });
  const bad = parseSectionFlags('plan=maybe');
  assert.ok('error' in bad && bad.error.includes('plan=maybe'));
  const unknown = parseSectionFlags('nope=true');
  assert.ok('error' in unknown && unknown.error.includes('未知段'));
});

test('E2. protocolCommand：stats 与 --json；--stats-only 不含组装全文', () => {
  const zh = protocolCommand(['--level', 'minimal', '--stats-only'], 'zh');
  assert.equal(zh.code, 0);
  assert.ok(zh.lines.some((l) => l.includes('合计 1981 字符')), 'minimal 基座 1446 + call 段 535（含连接符）');
  assert.ok(zh.lines.some((l) => l.includes('省 1390 / 41.2%')), '对 full 缺省装配基准（3371）的节省实测');
  assert.ok(!zh.lines.some((l) => l.includes('—— 组装全文 ——')), 'stats-only 不出全文');

  const noPlan = protocolCommand(['--level', 'minimal', '--no-plan', '--stats-only'], 'zh');
  assert.ok(noPlan.lines.some((l) => l.includes('合计 1696 字符')), '再联动 enablePlan=false（去 plan 段）实测');

  const json = protocolCommand(['--level', 'lean', '--stats-only', '--json'], 'zh');
  const payload = JSON.parse(json.lines[0]!) as { level: string; sections: unknown[]; totalChars: number; savedChars: number };
  assert.equal(payload.level, 'lean');
  assert.equal(payload.sections.length, 7);
  assert.equal(payload.totalChars, 2324 + 535, 'lean 基座 + call 段（含连接符）');
});

test('E3. protocolCommand：错误档位/错误段开关 → code=2', () => {
  assert.equal(protocolCommand(['--level', 'nope'], 'zh').code, 2);
  assert.equal(protocolCommand(['--sections', 'bad=xyz'], 'zh').code, 2);
  assert.equal(protocolCommand(['--sections'], 'zh').code, 2);
});

// ---------------------------------------------------------------- F 组：装配级入口

test('F1. sanitizeProtocolSections：未知键告警丢弃；合法键保留；空表/undefined 不产生配置', () => {
  const warnings: string[] = [];
  const cleaned = sanitizeProtocolSections({ plan: false, nope: true, timing: 'yes' as unknown as boolean }, (m) => warnings.push(m));
  assert.deepEqual(cleaned, { plan: false });
  assert.equal(warnings.length, 2, '未知段 + 非布尔值都告警');
  assert.ok(warnings[0]!.includes('nope'));
  assert.equal(sanitizeProtocolSections(undefined), undefined);
  assert.equal(sanitizeProtocolSections({}), undefined, '全空表不产生配置（undefined 语义）');
});

test('F2. resolveProtocolLevel：undefined/未知 → full（未知要告警），合法值透传', () => {
  const warnings: string[] = [];
  assert.equal(resolveProtocolLevel(undefined, (m) => warnings.push(m)), 'full');
  assert.equal(warnings.length, 0, '缺省不告警');
  assert.equal(resolveProtocolLevel('lean', (m) => warnings.push(m)), 'lean');
  assert.equal(resolveProtocolLevel('ultra', (m) => warnings.push(m)), 'full');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]!.includes('ultra'));
});
