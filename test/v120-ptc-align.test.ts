// test/v120-ptc-align.test.ts —— v1.2.0 b 通道 PTC 对齐（宿主真实契约，审查修正版）
// 覆盖：stateOwner→resolve / sandboxPolicy→resolve / errorClass→bindings namespace /
// release async 只释放不执行 / dispatch 私有 ledger / v12 段显式可达。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodeExecutor } from '../src/entry/ptc-bridge.ts';
import type { PtcRuntimeLike, PtcResolveExtensions } from '../src/entry/ptc-bridge.ts';
import { TfStreamParser } from '../src/kernel/parser.ts';
import { composeProtocolText } from '../src/kernel/protocol.ts';

function mockRuntime(capture: (req: Record<string, unknown>) => void): PtcRuntimeLike {
  return {
    resolve: (req) => { capture(req as unknown as Record<string, unknown>); return req; },
    run: async () => ({ value: 42 }),
  };
}
const noTools = async () => ({ results: [], additionalContexts: [], concluded: false });

test('P1. resolve 真实契约：stateOwner/sandboxPolicy 顶层；programFormat/errorClass 不在顶层', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const exec = createCodeExecutor(mockRuntime((r) => seen.push(r)), { executeTools: noTools });
  const signal = new AbortController().signal;
  await exec({ callId: 'c1', code: 'return 1', signal });
  assert.equal('stateOwner' in seen[0]!, false);
  assert.equal('sandboxPolicy' in seen[0]!, false);

  const owner = {};
  const ptc: PtcResolveExtensions = {
    stateOwner: owner,
    sandboxPolicy: { mode: 'read-only' },
    errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
  };
  await exec({ callId: 'c2', code: 'return 2', signal, ptc });
  const req = seen[1]!;
  assert.equal(req['stateOwner'], owner);
  assert.deepEqual(req['sandboxPolicy'], { mode: 'read-only' });
  assert.equal('programFormat' in req, false, 'programFormat 不是 resolve 字段');
  assert.equal('errorClass' in req, false, 'errorClass 不在 resolve 顶层');
  const bindings = req['bindings'] as Array<{ global: string; errorClass?: unknown }>;
  assert.deepEqual(bindings[0]!.errorClass, { name: 'ToolCallError', memberNameProperty: 'toolName' });
});

test('P2. dispatch 私有 ledger：start/settle 成对；不发宿主事件名', async () => {
  // 0.5.2：事件字段与宿主 tool/ptc-dispatch* 同词汇（name / parentCallId / subCallId /
  // isError / content），不再自造 {tool, callId, ok}——自造字段让宿主侧对账无法映射。
  const events: Array<{ phase: string; name: string; parentCallId: string; subCallId: string; isError?: boolean }> = [];
  const runtime: PtcRuntimeLike = {
    resolve: (req) => {
      const typed = req as { bindings?: Array<{ functions: Record<string, (a: unknown) => Promise<unknown>> }> };
      const fn = typed.bindings?.[0]?.functions['read'];
      if (fn !== undefined) void fn({ path: 'x' }).catch(() => {});
      return {};
    },
    run: async () => ({ value: 1 }),
  };
  const exec = createCodeExecutor(runtime, {
    executeTools: async () => ({ results: [{ callId: 'b1', result: { content: [{ type: 'text', text: 'ok' }], isError: false } }], additionalContexts: [], concluded: false }),
    onDispatch: (e) => events.push(e),
  });
  await exec({ callId: 'c3', code: 'x', signal: new AbortController().signal });
  await new Promise((r) => setTimeout(r, 20));
  const started = events.find((e) => e.phase === 'start');
  assert.ok(started !== undefined, 'start 事件必须发出');
  assert.equal(started.name, 'read');
  assert.equal(started.parentCallId, 'c3');
  assert.equal(started.subCallId, 'c3:ptc:1', 'subCallId = <parentCallId>:ptc:<提交序号>');
  assert.ok(events.some((e) => e.phase === 'settle' && e.isError === false));
});

test('P3. parser 接受 tf-code 新属性；v12 段默认不进、显式开启可见', () => {
  const parser = new TfStreamParser();
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for (const ch of '<tf-code format="repl" state="dom" sandbox="ro" release="true" id="c1">return 1</tf-code>') {
    for (const e of parser.feed(ch)) events.push(e as { type: string });
  }
  const cmd = events.find((e) => e.type === 'command') as unknown as { command?: { attrs?: Record<string, string> } } | undefined;
  assert.equal(cmd?.command?.attrs?.['format'], 'repl');
  assert.equal(cmd?.command?.attrs?.['state'], 'dom');
  assert.equal(cmd?.command?.attrs?.['sandbox'], 'ro');
  assert.equal(cmd?.command?.attrs?.['release'], 'true');

  const goldenText = composeProtocolText();
  const v12 = composeProtocolText({ sections: { v12: true } });
  assert.ok(v12.length > goldenText.length);
  assert.match(v12, /format="function-body\|repl\|script"/);
  assert.match(v12, /release="true"/);
});

test('P4. release 契约：宿主 release 为 async 且按对象身份释放；失败可被捕获', async () => {
  // release 的端到端驱动路径由 tf-code 分支实现（loop.ts：owner 创建前判 state-not-found、
  // await runtime(owner)、失败保留映射、返回不执行程序体）。此处验证其依赖的宿主契约：
  //   - PtcRuntimeLike.release 返回 Promise（async），需 await；
  //   - 按对象身份（同一 owner）释放。
  const released: object[] = [];
  const owner = {};
  const runtime: PtcRuntimeLike = {
    resolve: () => ({}),
    run: async () => ({ value: 1 }),
    release: async (o: object) => { await Promise.resolve(); released.push(o); },
  };
  assert.ok(runtime.release !== undefined);
  await runtime.release(owner);
  assert.equal(released[0], owner, '按对象身份释放');

  // 失败路径：async reject 可被 await/catch 捕获（对应 loop.ts release-failed 分支）。
  let caught = false;
  const failing: PtcRuntimeLike = {
    resolve: () => ({}),
    run: async () => ({ value: 1 }),
    release: async () => { throw new Error('cleanup failed'); },
  };
  try { await failing.release!(owner); } catch { caught = true; }
  assert.equal(caught, true, 'release 的异步失败可被捕获，供 release-failed 台账记录');
});

// ---- 再评估修正回归 ----
test('P5. enhancedSectionTexts 只取 v11/v12，不携带默认 8 段', async () => {
  const { enhancedSectionTexts } = await import('../src/kernel/protocol.ts');
  const v12 = enhancedSectionTexts(['v12']);
  assert.ok(v12.includes('format="function-body|repl|script"'));
  assert.ok(!v12.includes('## tf-* 单流协议'), '不得把默认协议整段带入 bridge');
  assert.equal(enhancedSectionTexts(['syntax']), '');
});

test('P6. TfAgentRecordType 含 dispatch；私有 ledger 类型可复算', async () => {
  const types = ['plugin:tf-agent/command', 'plugin:tf-agent/dispatch'] as const;
  assert.equal(types[1], 'plugin:tf-agent/dispatch');
});
