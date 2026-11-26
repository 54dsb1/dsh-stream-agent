// test/desktop-ui.test.ts —— 桌面控制页的静态契约与宿主路由（v0.2.1）
//
// 这组测试盯的是两个"装错就整页起不来"的点：
//   1. dsh-client-modules 以包为单位扫描 dsh.client。主包已有七个 entry，
//      若主包声明 dsh.client 会抛多源错误，整个客户端 boot 失败。
//   2. ui/client.js 由宿主原样拼接进 boot 包，语法错误同样会炸 boot。
//      这里用 new Function 只编译不执行（顶层 window 由浏览器提供）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleControlRequest } from '../ui/index.js';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path: string): any {
  return JSON.parse(readFileSync(join(pkgRoot, path), 'utf8'));
}

function makeRes(): any {
  return {
    status: 0,
    headers: {},
    payload: '',
    writeHead(status: number, headers?: Record<string, string>) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(chunk?: string) {
      this.payload = chunk ?? '';
    },
  };
}

function makeReq(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  remoteAddress?: string;
} = {}): any {
  const req = new EventEmitter() as any;
  req.method = options.method ?? 'GET';
  req.headers = options.headers ?? {};
  req.socket = { remoteAddress: options.remoteAddress ?? '127.0.0.1' };
  req.body = options.body;
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

function runtimeStub(overrides: Record<string, unknown> = {}): any {
  const calls: string[] = [];
  const status = {
    version: '0.5.0',
    takeover: true,
    channel: 'standard',
    channelSource: 'file',
    channelLocked: false,
    tier: 'standard',
    tierSource: 'file',
    tierLocked: false,
    lang: 'zh',
    langSource: 'file',
    langLocked: false,
    effective: {
      maxSteps: 24,
      maxInputTokens: 20000,
      compactAggressiveness: 'balanced',
      surfacePolicy: 'reserved-only',
    },
    channels: [],
    tiers: [],
    legacyModes: [],
    updatedAt: '2026-11-22T00:00:00.000Z',
    stateFile: '/tmp/control.json',
    ...overrides,
  };
  return {
    calls,
    status: () => status,
    setChannel(channel: string) {
      calls.push(`channel:${channel}`);
      return { ok: true, persisted: true };
    },
    setTier(tier: string) {
      calls.push(`tier:${tier}`);
      return { ok: true, persisted: true };
    },
    setLang(lang: string) {
      calls.push(`lang:${lang}`);
      return { ok: true, persisted: true };
    },
  };
}

function ctxWith(services: Record<string, unknown>): any {
  return {
    get(name: string) {
      if (name === 'connection') return { admit: () => ({ peer: {} }) };
      return services[name];
    },
  };
}

test('包声明：主包不得有 dsh.client，UI 子包必须声明 web + ./client', () => {
  const root = readJson('package.json');
  const ui = readJson('ui/package.json');
  assert.equal(root.dsh.client, undefined, '主包声明 dsh.client 会让 dsh-client-modules 抛多源错误');
  assert.equal(ui.dsh?.client?.platform, 'web');
  assert.equal(ui.exports?.['./client'], './client.js');
  assert.ok(ui.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'));
  assert.ok(ui.dsh.client.external.includes('react'));
  assert.ok(root.files.includes('ui/'), 'npm 包必须带上 ui/');
});

test('客户端 bundle：__ModuleLoader__ 包装、id、apply/inject 全部合规', () => {
  const source = readFileSync(join(pkgRoot, 'ui', 'client.js'), 'utf8');
  let captured: any;
  const fakeWindow = { __ModuleLoader__: { load(definition: any) { captured = definition; } } };
  const fakeRequire = () => ({
    createElement() {},
    useState() {},
    useEffect() {},
    useCallback() {},
    useMemo() {},
  });

  assert.doesNotThrow(() => new Function('window', 'require', source)(fakeWindow, fakeRequire));
  assert.equal(captured?.id, '@hugesb/dsh-stream-agent-ui');

  const exports = captured.factory(fakeRequire);
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(exports.inject, ['slots']);
  assert.equal(exports.ROUTE, '/stream-agent/control');
});

test('文案表：中英键集合完全一致，且没有空串或遗漏翻译', () => {
  const source = readFileSync(join(pkgRoot, 'ui', 'client.js'), 'utf8');
  let captured: any;
  const fakeWindow = { __ModuleLoader__: { load(definition: any) { captured = definition; } } };
  new Function('window', 'require', source)(fakeWindow, () => ({}));
  const TEXT = captured.factory(() => ({})).TEXT;

  const flatten = (node: any, prefix = ''): Map<string, unknown> => {
    const out = new Map<string, unknown>();
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object') {
        for (const [k, v] of flatten(value, path)) out.set(k, v);
      } else {
        out.set(path, value);
      }
    }
    return out;
  };

  const zh = flatten(TEXT.zh);
  const en = flatten(TEXT.en);
  // 专有名词与命令行示例在两语言里本来就该一样（tf-code 是产品内部叫法，命令不能翻译）。
  const sameOnPurpose = new Set(['params.enableCode', 'cliHint']);
  assert.deepEqual([...en.keys()].sort(), [...zh.keys()].sort(), '两个语言表的键路径必须一一对应');
  for (const [path, value] of zh) {
    assert.equal(typeof value, 'string', `zh.${path} 必须是字符串`);
    assert.notEqual(value.trim(), '', `zh.${path} 不能为空`);
    const other = en.get(path);
    assert.equal(typeof other, 'string', `en.${path} 必须是字符串`);
    assert.notEqual(String(other).trim(), '', `en.${path} 不能为空`);
    if (!sameOnPurpose.has(path)) {
      assert.notEqual(String(other), value, `en.${path} 与中文完全相同，疑似漏翻`);
    }
  }
});

test('路由 GET：运行时在位时返回接管状态与两轴目录', async () => {
  const runtime = runtimeStub();
  const res = await invoke(ctxWith({ streamAgentRuntime: runtime }), makeReq());
  assert.equal(res.status, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.ok, true);
  assert.equal(body.status.takeover, true);
  assert.equal(body.status.channel, 'standard');
  assert.equal(body.status.channelSource, 'file');
  assert.equal(body.status.tier, 'standard');
});

test('路由 GET：降级分支的目录投影带通道/档位/旧别名（页面据此渲染，不自己编）', async () => {
  // 运行时缺席时走 fallbackStatus()，它自己拼 channels/tiers/legacyModes——
  // 专门在降级分支上断言，避免"有 loop 时页面有目录、没 loop 时没有"。
  const res = await invoke(ctxWith({}), makeReq());
  const body = JSON.parse(res.payload);
  assert.equal(body.status.channels.length, 2);
  assert.equal(body.status.tiers.length, 3);
  assert.ok(body.status.tiers.every((x) => x.values && typeof x.values.maxSteps === 'number'), '档位目录带实际数值');
  assert.equal(body.status.legacyModes.length, 4);
  assert.ok(body.status.legacyModes.every((m) => 'aliasTarget' in m && !('removal' in m)), '旧模式目录只带别名映射，不带版本标注');
});

test('路由 POST：切通道/档位/语言走运行时服务，并回报 persisted', async () => {
  const runtime = runtimeStub();
  const ctx = ctxWith({ streamAgentRuntime: runtime });

  const channelRes = await invoke(
    ctx,
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'code', tier: 'light', expectedUpdatedAt: '2026-11-22T00:00:00.000Z' }),
    }),
  );
  assert.equal(channelRes.status, 200);
  assert.equal(JSON.parse(channelRes.payload).persisted, true);
  assert.deepEqual(runtime.calls, ['channel:code', 'tier:light']);

  const langRes = await invoke(
    ctx,
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang: 'en', expectedUpdatedAt: '2026-11-22T00:00:00.000Z' }),
    }),
  );
  assert.equal(langRes.status, 200);
  assert.deepEqual(runtime.calls, ['channel:code', 'tier:light', 'lang:en']);
});

test('路由 POST：过期 expectedUpdatedAt 返回 409 + 最新状态（多窗口不互相覆盖）', async () => {
  const runtime = runtimeStub();
  const res = await invoke(
    ctxWith({ streamAgentRuntime: runtime }),
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'code', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }),
    }),
  );
  assert.equal(res.status, 409);
  const body = JSON.parse(res.payload);
  assert.equal(body.error.code, 'stale');
  assert.equal(body.status.channel, 'standard');
  assert.deepEqual(runtime.calls, []);
});

test('路由 POST：expectedUpdatedAt=null 只在文件尚未写入时放行（首次写入不加锁）', async () => {
  // 客户端总是发送 expectedUpdatedAt = status.updatedAt ?? null。
  // null 的语义是"我以为这文件还不存在"，所以只有真正未写入时才该放行；
  // 若别人已经写过，null 必须被判为过期，否则两个窗口的首次点击会互相覆盖。
  const virgin = runtimeStub({ updatedAt: null });
  const first = await invoke(
    ctxWith({ streamAgentRuntime: virgin }),
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'code', expectedUpdatedAt: null }),
    }),
  );
  assert.equal(first.status, 200);
  assert.deepEqual(virgin.calls, ['channel:code']);

  const written = runtimeStub();
  const late = await invoke(
    ctxWith({ streamAgentRuntime: written }),
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'code', expectedUpdatedAt: null }),
    }),
  );
  assert.equal(late.status, 409);
  assert.equal(JSON.parse(late.payload).error.code, 'stale');
  assert.deepEqual(written.calls, [], '被判过期时不得触碰运行时');

  // 不发送该字段 = 显式放弃栅栏（终端 curl 手改场景），保持向后兼容。
  const bare = runtimeStub();
  const unfenced = await invoke(
    ctxWith({ streamAgentRuntime: bare }),
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang: 'en' }),
    }),
  );
  assert.equal(unfenced.status, 200);
  assert.deepEqual(bare.calls, ['lang:en']);
});

test('路由 POST：装配配置/环境变量锁定时拒绝修改', async () => {
  const runtime = runtimeStub({ channelSource: 'config', channelLocked: true });
  const res = await invoke(
    ctxWith({ streamAgentRuntime: runtime }),
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'code' }),
    }),
  );
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.payload).error.code, 'locked');
  assert.deepEqual(runtime.calls, []);
});

test('路由边界：未鉴权 401、跨站 403、非 JSON 415、非法通道/档位 400', async () => {
  const deniedCtx = { get: () => ({ admit: () => ({ rejection: 401 }) }) };
  assert.equal((await invoke(deniedCtx, makeReq())).status, 401);

  const cross = await invoke(
    ctxWith({}),
    makeReq({ method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' }),
  );
  assert.equal(cross.status, 403);

  const notJson = await invoke(
    ctxWith({}),
    makeReq({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'channel=code' }),
  );
  assert.equal(notJson.status, 415);

  const badChannel = await invoke(
    ctxWith({}),
    makeReq({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'turbo' }) }),
  );
  assert.equal(badChannel.status, 400);
  assert.equal(JSON.parse(badChannel.payload).error.code, 'invalid-channel');

  const badTier = await invoke(
    ctxWith({}),
    makeReq({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tier: 'ultra' }) }),
  );
  assert.equal(badTier.status, 400);
  assert.equal(JSON.parse(badTier.payload).error.code, 'invalid-tier');
});

test('降级路径：运行时缺席时写状态文件（旧 mode 值按别名映射），并明确告知需要重启', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-ui-fallback-'));
  const previous = process.env.STREAM_AGENT_STATE_DIR;
  process.env.STREAM_AGENT_STATE_DIR = dir;
  try {
    const res = await invoke(
      ctxWith({}),
      makeReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'standard', tier: 'deep', lang: 'en' }),
      }),
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.degraded, true);
    assert.equal(body.status.takeover, false);
    assert.equal(body.status.channel, 'standard');
    assert.equal(body.status.tier, 'deep');
    assert.equal(body.status.lang, 'en');
    assert.ok(body.notice.includes('重启'));
    assert.ok(existsSync(join(dir, 'control.json')));
  } finally {
    if (previous === undefined) delete process.env.STREAM_AGENT_STATE_DIR;
    else process.env.STREAM_AGENT_STATE_DIR = previous;
  }
});

test('降级视图的生效参数来自用户 limits（0 = 不限），不拿档位参考值冒充', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-ui-effective-'));
  const previous = process.env.STREAM_AGENT_STATE_DIR;
  process.env.STREAM_AGENT_STATE_DIR = dir;
  try {
    // 先落一份带 limits 的状态（deep 档的参考值 = 40/48000，若被冒充就会露馅）
    writeFileSync(
      join(dir, 'control.json'),
      JSON.stringify({ schema: 3, channel: 'standard', tier: 'deep', lang: 'zh', limits: { maxSteps: 9 } }),
      'utf8',
    );

    const res = await invoke(ctxWith({}), makeReq({ method: 'GET', headers: {} }));
    assert.equal(res.status, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status.degraded, true, '运行时缺席 → 降级视图');

    // ① 用户设过的键如实回报
    assert.equal(body.status.effective.maxSteps, 9);
    // ② 未设过的键 = thinkflow 对齐默认层（0.6.1：keepRecent 30 / maxSummaryChars 16k）；
    //    token/取回无默认层 → 0（不限制），不得回落到 deep 档的旧参考值 48000
    assert.equal(body.status.effective.maxInputTokens, 0, '不得用档位参考值顶替生效值');
    assert.equal(body.status.effective.peekBudgetChars, 0);
    assert.equal(body.status.effective.keepRecent, 30);
    assert.equal(body.status.effective.maxSummaryChars, 16_000);
    // ③ 非 limits 的两项仍要给出（来自档位/装配）
    assert.equal(typeof body.status.effective.compactAggressiveness, 'string');
    assert.equal(typeof body.status.effective.surfacePolicy, 'string');
    // ④ 原始 limits（纯用户层）一并投影，供控制页展示"你设了什么"
    assert.deepEqual(body.status.limits, { maxSteps: 9 });
  } finally {
    if (previous === undefined) delete process.env.STREAM_AGENT_STATE_DIR;
    else process.env.STREAM_AGENT_STATE_DIR = previous;
  }
});

// ---------------------------------------------------------------- 区块 C 用户上限（0.5.3）

function postBody(body: unknown): any {
  return makeReq({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('路由 POST limits：走 setLimits（23 键全落点），并把 accepted/ignored 原样回报', async () => {
  const runtime = runtimeStub();
  const seen: any[] = [];
  runtime.setLimits = (patch: unknown, options: unknown) => {
    seen.push({ patch, options });
    return { ok: true, accepted: patch, ignored: ['stray=1'] };
  };
  const ctx = ctxWith({ streamAgentRuntime: runtime });
  const res = await invoke(ctx, postBody({ limits: { maxSteps: 40, maxInputTokens: 48000 }, limitsReplace: true }));
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.payload);
  assert.equal(payload.ok, true);
  assert.deepEqual(seen, [{ patch: { maxSteps: 40, maxInputTokens: 48000 }, options: { replace: true } }]);
  assert.ok(Array.isArray(payload.warnings) && payload.warnings.includes('stray=1'), 'ignored 键必须回报');
});

test('路由 POST limits：非法/未知/负数被内核校验拒绝（400），不落盘也不调运行时', async () => {
  const runtime = runtimeStub();
  const seen: any[] = [];
  runtime.setLimits = (patch: unknown) => { seen.push(patch); return { ok: true }; };
  const ctx = ctxWith({ streamAgentRuntime: runtime });

  const unknown = await invoke(ctx, postBody({ limits: { nosuch: 3 } }));
  assert.equal(unknown.status, 400, JSON.parse(unknown.payload).error.message);
  const negative = await invoke(ctx, postBody({ limits: { maxSteps: -1 } }));
  assert.equal(negative.status, 400);
  const notObject = await invoke(ctx, postBody({ limits: [1, 2] }));
  assert.equal(notObject.status, 400);
  assert.deepEqual(seen, [], '被拒的补丁不得进入运行时');
});

test('路由 POST limits：limits:null + limitsReplace = 清空为"全部不限制"', async () => {
  const runtime = runtimeStub();
  const seen: any[] = [];
  runtime.setLimits = (patch: unknown, options: unknown) => { seen.push({ patch, options }); return { ok: true, persisted: {} }; };
  const ctx = ctxWith({ streamAgentRuntime: runtime });
  const res = await invoke(ctx, postBody({ limits: null }));
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [{ patch: {}, options: { replace: true } }]);
});

test('降级分支不再抹掉用户上限：只改通道时 limits 原样保留（0.5.2 真 bug 回归）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-ui-limits-'));
  const prev = process.env.STREAM_AGENT_STATE_DIR;
  process.env.STREAM_AGENT_STATE_DIR = dir;
  try {
    const { writePersistedControl, readPersistedControl } = await import('../dist/entry/control-state.js');
    writePersistedControl({ channel: 'standard', tier: 'standard', lang: 'zh', limits: { maxSteps: 40 } });
    const ctx = ctxWith({}); // 无 streamAgentRuntime → 降级分支
    const res = await invoke(ctx, postBody({ channel: 'code' }));
    assert.equal(res.status, 200);
    const after = readPersistedControl();
    assert.equal(after.state.channel, 'code');
    assert.deepEqual(after.limits, { maxSteps: 40 }, '改通道不得抹掉用户定义的上限');
  } finally {
    if (prev === undefined) delete process.env.STREAM_AGENT_STATE_DIR;
    else process.env.STREAM_AGENT_STATE_DIR = prev;
  }
});

test('路由 POST 降级分支：改通道不得把关掉的 contextFold/finalCheck 写回 true', async () => {
  // 0.6.0：writePersistedControl 对缺字段按默认 true 落盘，降级分支若只写
  // channel/tier/lang，就把用户关掉的开关整个抹掉（与 0.5.3 "改通道丢 limits" 同源）。
  const dir = mkdtempSync(join(tmpdir(), 'tf-ui-degrade-'));
  const saved = process.env['STREAM_AGENT_STATE_DIR'];
  try {
    process.env['STREAM_AGENT_STATE_DIR'] = dir;
    writeFileSync(join(dir, 'control.json'), JSON.stringify({
      schema: 4, channel: 'standard', tier: 'standard', lang: 'zh', contextFold: false, finalCheck: false,
    }), 'utf8');
    // 无 streamAgentRuntime = loop 未接管的降级分支
    const res = await invoke(
      ctxWith({}),
      makeReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'code' }),
      }),
    );
    assert.equal(res.status, 200);
    const raw = JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(raw['channel'], 'code', '通道要写对');
    assert.equal(raw['contextFold'], false, '降级分支不得把 contextFold 写回 true');
    assert.equal(raw['finalCheck'], false, '降级分支不得把 finalCheck 写回 true');
  } finally {
    if (saved === undefined) delete process.env['STREAM_AGENT_STATE_DIR'];
    else process.env['STREAM_AGENT_STATE_DIR'] = saved;
  }
});
