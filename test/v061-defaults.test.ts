// test/v061-defaults.test.ts —— 0.6.1 离线验收：thinkflow 对齐默认层 + 行为预设移除收尾。
//
// 0.6.1 变更（替代原 v060-presets.test.ts 的预设部分）：
//   D1 默认数值面 = THINKFLOW_ALIGNED_LIMITS（xuxiang-thinkflow 出厂预设映射；无 maxSteps）
//   D2 用户 limits 覆盖默认层（显式 0 = 主动"不限制"同样压过）
//   D3 旧预设痕迹的迁移（control.json preset 字段 / config.preset / STREAM_AGENT_PRESET：告警 + 忽略）
//   D4 contextRaw 驱动器强制面（折叠/去重/截断全关；预算类 limits 仍生效）——沿自 P4
//   D5 持久化迁移（v4 → v5；preset 不再写盘；未知字段保留）——沿自 P5
//   D6 桌面路由（POST preset → 400 empty；setSwitches 照常）——沿自 P6
//
// 执行通道「代码」→「PTC兼容模式」的改名断言并入 D7。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { SingleStreamDriver } from '../src/entry/loop.ts';
import type { DriverPorts, StreamDriverConfig } from '../src/entry/loop.ts';
import { controlFileOf, resolveControlState, writePersistedControl } from '../src/entry/control-state.ts';
import { createControlState, interpretKey, switchSummaryLine, renderJson, renderStatusBar } from '../src/kernel/control-bar.ts';
import { getChannel } from '../src/kernel/modes.ts';
import { THINKFLOW_ALIGNED_LIMITS } from '../src/kernel/limits.ts';
import { handleControlRequest } from '../ui/index.js';

// ================================================================ D1：thinkflow 对齐默认层

test('D1-1. 用户层保持纯净：control.json 未设 limits 时不注入默认层（默认层不物化进盘）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-v061-d1-'));
  try {
    const resolved = resolveControlState({}, dir);
    assert.equal(resolved.limits, undefined, '用户未定义 → 状态里没有 limits（默认层只存在于生效面）');
    assert.equal(resolved.limitsSource, 'default');

    writePersistedControl({ channel: 'standard', tier: 'standard', lang: 'zh', limits: { maxSteps: 9 } }, dir);
    const withUser = resolveControlState({}, dir);
    assert.deepEqual(withUser.limits, { maxSteps: 9 }, '文件层 = 纯用户键，不得混入默认层');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D1-2. 驱动器默认生效面：无轮数上限；thinkflow 数值逐项可见', () => {
  const ports: DriverPorts = {
    stream: () => { throw new Error('not used'); },
    executeTools: async () => ({ results: [] }),
  };
  const driver = new SingleStreamDriver(ports, { provider: 'mock', model: 'mock-d1' });
  assert.equal(driver.effectiveLimits().maxSteps, 0, '轮数 = 不限制');
  const snap = driver.limitsSnapshot();
  assert.equal(snap.keepRecent, 30);
  assert.equal(snap.maxSummaryChars, 16_000);
  assert.equal(snap.maxReadChars, 200_000);
  assert.equal(snap.maxReentries, 8);
});

// ================================================================ D2：用户覆盖

test('D2-1. 用户 limits 在生效面覆盖默认层；显式 0 = 主动"不限制"同样压过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-v061-d2-'));
  try {
    const resolved = resolveControlState({ limits: { keepRecent: 5, maxReentries: 0 } }, dir);
    assert.deepEqual(resolved.limits, { keepRecent: 5, maxReentries: 0 }, '用户层如实落盘');
    assert.equal(resolved.limitsSource, 'config');

    // 生效面：用户值压过默认层；未覆盖的键仍取默认层
    const driver = bareDriver({ limits: { keepRecent: 5, maxReentries: 0 } });
    const snap = driver.limitsSnapshot();
    assert.equal(snap.keepRecent, 5);
    assert.equal(snap.maxReentries, 0);
    assert.equal(snap.maxSummaryChars, 16_000, '未覆盖的键仍取默认层');
    assert.equal(driver.effectiveLimits().maxSteps, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ================================================================ D3：旧预设痕迹迁移

test('D3-1. control.json 的 preset 字段：告警 + 忽略 + 不再写盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-v061-d3-'));
  try {
    writeFileSync(controlFileOf(dir), JSON.stringify({
      schema: 5, channel: 'standard', tier: 'standard', lang: 'zh', preset: 'light',
    }), 'utf8');
    const warnings: string[] = [];
    const resolved = resolveControlState({}, dir, (m) => warnings.push(m));
    assert.equal((resolved as Record<string, unknown>)['preset'], undefined);
    assert.ok(warnings.some((w) => w.includes('preset')), warnings.join('|'));

    writePersistedControl({ channel: 'standard', tier: 'standard', lang: 'zh' }, dir);
    const raw = JSON.parse(readFileSync(controlFileOf(dir), 'utf8')) as Record<string, unknown>;
    assert.equal(raw['preset'], undefined, '0.6.1 起写入不再产生 preset 字段');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D3-2. config.preset / STREAM_AGENT_PRESET：告警 + 忽略；开关环境变量照常', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-v061-d4-'));
  const savedPreset = process.env['STREAM_AGENT_PRESET'];
  const savedRaw = process.env['STREAM_AGENT_CONTEXT_RAW'];
  try {
    const warnings: string[] = [];
    const resolved = resolveControlState({ preset: 'light' }, dir, (m) => warnings.push(m));
    assert.equal((resolved as Record<string, unknown>)['preset'], undefined);
    assert.ok(warnings.some((w) => w.includes('preset')), 'config.preset 已无语义，必须告警');

    process.env['STREAM_AGENT_PRESET'] = 'deep';
    const warnings2: string[] = [];
    resolveControlState({}, dir, (m) => warnings2.push(m));
    assert.ok(warnings2.length === 0, '环境变量 STREAM_AGENT_PRESET 不再被读取（静默忽略不告警也可接受）');

    process.env['STREAM_AGENT_CONTEXT_RAW'] = 'on';
    const rawEnv = resolveControlState({}, dir);
    assert.equal(rawEnv.contextRaw, true);
    assert.equal(rawEnv.contextFold, false, '原样开启时折叠强制关');
    assert.equal(rawEnv.contextRawSource, 'env');
  } finally {
    if (savedPreset === undefined) delete process.env['STREAM_AGENT_PRESET'];
    else process.env['STREAM_AGENT_PRESET'] = savedPreset;
    if (savedRaw === undefined) delete process.env['STREAM_AGENT_CONTEXT_RAW'];
    else process.env['STREAM_AGENT_CONTEXT_RAW'] = savedRaw;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ================================================================ D4：contextRaw 强制面（沿自 P4）

function bareDriver(config: Partial<StreamDriverConfig>): SingleStreamDriver {
  const ports: DriverPorts = {
    stream: () => { throw new Error('not used'); },
    executeTools: async () => ({ results: [] }),
  };
  return new SingleStreamDriver(ports, { provider: 'mock', model: 'mock', ...config });
}

test('D4-1. contextRaw=true：折叠/去重/效果折叠/截断全关（即使 limits 设了阈值）；预算类 limits 仍生效', () => {
  const driver = bareDriver({
    contextRaw: true,
    limits: { maxInputTokens: 12_000, segmentMaxChars: 5_000, effectElisionKeepRecent: 2, maxReadChars: 8_000, readFeedbackLimit: 4_000, nativeResultLimit: 3_000, codeValueInjectLimit: 2_000, peekBudgetChars: 1_000 },
  });
  const p = driver.effectiveParams();
  assert.equal(p.contextRaw, true);
  assert.equal(p.contextFold, false);
  assert.equal(p.spanLedger, false);
  assert.equal(p.segmentMaxChars, 0);
  assert.equal(p.effectElisionKeepRecent, 0);
  const limits = driver.limitsSnapshot();
  assert.equal(limits.maxReadChars, 8_000, 'limits 原样保留（用户定义不被改写）');
  assert.equal(p.maxInputTokens, 12_000, '预算类上限仍生效（那是预算，不是内容处理）');
  assert.equal(p.peekBudgetChars, 1_000);
});

test('D4-2. contextRaw=false（默认）：用户阈值原样生效；默认层补齐其余数值', () => {
  const driver = bareDriver({ limits: { segmentMaxChars: 5_000 } });
  const p = driver.effectiveParams();
  assert.equal(p.contextRaw, false);
  assert.equal(p.contextFold, true);
  assert.equal(p.spanLedger, true);
  assert.equal(p.segmentMaxChars, 5_000);
});

// ================================================================ D5：持久化迁移（沿自 P5）

test('D5-1. v4 文件读入 → contextRaw 默认 false；写回 schema 5；未知字段保留；preset 不再写盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-v061-d5-'));
  try {
    writeFileSync(controlFileOf(dir), JSON.stringify({
      schema: 4, channel: 'standard', tier: 'standard', lang: 'zh',
      contextFold: false, finalCheck: true, futureField: { keep: 1 },
    }), 'utf8');
    const resolved = resolveControlState({}, dir);
    assert.equal(resolved.contextRaw, false);
    assert.equal(resolved.contextRawSource, 'default');
    assert.equal(resolved.contextFold, false, 'v4 的 fold=false 保留');

    writePersistedControl({ channel: 'standard', tier: 'standard', lang: 'zh', contextFold: false, contextRaw: true }, dir);
    const raw = JSON.parse(readFileSync(controlFileOf(dir), 'utf8')) as Record<string, unknown>;
    assert.equal(raw['schema'], 5);
    assert.equal(raw['contextRaw'], true);
    assert.equal(raw['preset'], undefined);
    assert.equal(raw['contextFold'], false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ================================================================ D6：桌面路由（沿自 P6）

function makeRes(): any {
  return {
    status: 0, headers: {}, payload: '',
    writeHead(status: number, headers?: Record<string, string>) { this.status = status; this.headers = headers ?? {}; },
    end(chunk?: string) { this.payload = chunk ?? ''; },
  };
}
function makeReq(method: string, body?: string): any {
  const req = new EventEmitter() as any;
  req.method = method;
  req.headers = body === undefined ? {} : { 'content-type': 'application/json' };
  req.socket = { remoteAddress: '127.0.0.1' };
  req.body = body;
  return req;
}
async function invoke(ctx: any, req: any): Promise<any> {
  const res = makeRes();
  const promise = handleControlRequest(ctx, req, res);
  if (req.body !== undefined) {
    req.emit('data', Buffer.from(req.body));
    req.emit('end');
  }
  await promise;
  return res;
}

test('D6-1. POST preset → 400 empty（预设已移除）；POST contextRaw → runtime.setSwitches；非法值 400', async () => {
  const calls: string[] = [];
  const status = {
    version: '0.6.1', takeover: true, channel: 'standard', tier: 'standard', lang: 'zh',
    channelSource: 'file', tierSource: 'file', langSource: 'file',
    channelLocked: false, tierLocked: false, langLocked: false,
    contextFold: true, finalCheck: true, contextRaw: false,
    limits: {}, updatedAt: '2026-11-26T00:00:00.000Z', stateFile: '/tmp/control.json',
    effective: {}, channels: [], tiers: [], legacyModes: [],
  };
  const ctx = {
    get: (name: string) => name === 'streamAgentRuntime'
      ? {
          status: () => status,
          setChannel: () => ({ ok: true }),
          setTier: () => ({ ok: true }),
          setLang: () => ({ ok: true }),
          setSwitches: (patch: Record<string, unknown>) => { calls.push(`switches:${JSON.stringify(patch)}`); return { ok: true }; },
        }
      : undefined,
  };
  const gone = await invoke(ctx, makeReq('POST', JSON.stringify({ preset: 'deep' })));
  assert.equal(gone.status, 400, 'preset 字段不再被接受');
  assert.deepEqual(calls, []);

  const ok2 = await invoke(ctx, makeReq('POST', JSON.stringify({ contextRaw: true })));
  assert.equal(ok2.status, 200);
  assert.deepEqual(calls, ['switches:{"contextRaw":true}']);

  const bad2 = await invoke(ctx, makeReq('POST', JSON.stringify({ contextRaw: 'maybe' })));
  assert.equal(bad2.status, 400);
});

test('D6-2. 降级分支：单字段写入不丢原样开关；limits 照常落盘', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-v061-d6-'));
  const saved = process.env['STREAM_AGENT_STATE_DIR'];
  try {
    process.env['STREAM_AGENT_STATE_DIR'] = dir;
    const ctx = { get: () => undefined };
    const ok = await invoke(ctx, makeReq('POST', JSON.stringify({ contextRaw: true })));
    assert.equal(ok.status, 200);
    const raw = JSON.parse(readFileSync(controlFileOf(dir), 'utf8')) as Record<string, unknown>;
    assert.equal(raw['contextRaw'], true, '降级分支：开关照常落盘');

    // 只改通道：原样开关不得被抹掉
    const ok2 = await invoke(ctx, makeReq('POST', JSON.stringify({ channel: 'code' })));
    assert.equal(ok2.status, 200);
    const raw2 = JSON.parse(readFileSync(controlFileOf(dir), 'utf8')) as Record<string, unknown>;
    assert.equal(raw2['contextRaw'], true, '降级分支改通道不得重置原样开关');
    // 生效面的"原样开 → 折叠强制关"由 resolveControlState 承担（落盘文件不强制改写）
    const resolved = resolveControlState({}, dir);
    assert.equal(resolved.contextRaw, true);
    assert.equal(resolved.contextFold, false);
  } finally {
    if (saved === undefined) delete process.env['STREAM_AGENT_STATE_DIR'];
    else process.env['STREAM_AGENT_STATE_DIR'] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ================================================================ D7：执行通道改名（PTC兼容模式）

test('D7-1. 通道目录：code 的用户可见名 = PTC兼容模式 / PTC-compat（内部 id 不变）', () => {
  const spec = getChannel('code');
  assert.equal(spec.id, 'code');
  assert.equal(spec.label.zh, 'PTC兼容模式');
  assert.equal(spec.label.en, 'PTC-compat');
  const standard = getChannel('standard');
  assert.equal(standard.label.zh, '标准');
});

test('D7-2. 键位与状态面：p 键已回收；renderJson / renderStatusBar 无 preset 字段', () => {
  assert.deepEqual(interpretKey('p'), { kind: 'none' });
  assert.deepEqual(interpretKey('x'), { kind: 'toggle-context-raw' });
  const state = createControlState({ lang: 'zh' });
  const json = JSON.parse(renderJson(state, { version: '0.6.1' }));
  assert.equal('preset' in json, false);
  assert.equal('presets' in json, false);
  const bar = renderStatusBar(state, { version: '0.6.1' });
  assert.ok(!bar.includes('preset'), bar);
  assert.ok(bar.includes('standard'), bar);
});

test('D7-3. PTC兼容模式无验收闸的文案如实灰显', () => {
  const state = createControlState({ lang: 'zh', channel: 'code' });
  const line = switchSummaryLine(state, 'zh');
  assert.ok(line.includes('PTC兼容模式无验收闸'), line);
});
