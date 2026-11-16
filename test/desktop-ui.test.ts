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
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
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
    version: '0.2.1',
    takeover: true,
    mode: 'balanced',
    modeSource: 'file',
    modeLocked: false,
    lang: 'zh',
    langSource: 'file',
    langLocked: false,
    effective: {
      selfReadFeedback: 'receipt',
      enableCode: 'auto',
      persistFallback: true,
      maxParallelToolCalls: 3,
      maxReentries: 8,
      budgetTokens: null,
    },
    modes: [],
    updatedAt: '2026-11-16T00:00:00.000Z',
    stateFile: '/tmp/control.json',
    ...overrides,
  };
  return {
    calls,
    status: () => status,
    setMode(mode: string) {
      calls.push(`mode:${mode}`);
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

test('路由 GET：运行时在位时返回接管状态与四模式目录', async () => {
  const runtime = runtimeStub();
  const res = await invoke(ctxWith({ streamAgentRuntime: runtime }), makeReq());
  assert.equal(res.status, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.ok, true);
  assert.equal(body.status.takeover, true);
  assert.equal(body.status.mode, 'balanced');
  assert.equal(body.status.modeSource, 'file');
});

test('路由 POST：切模式/语言走运行时服务，并回报 persisted', async () => {
  const runtime = runtimeStub();
  const ctx = ctxWith({ streamAgentRuntime: runtime });

  const modeRes = await invoke(
    ctx,
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'lean', expectedUpdatedAt: '2026-11-16T00:00:00.000Z' }),
    }),
  );
  assert.equal(modeRes.status, 200);
  assert.equal(JSON.parse(modeRes.payload).persisted, true);
  assert.deepEqual(runtime.calls, ['mode:lean']);

  const langRes = await invoke(
    ctx,
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lang: 'en', expectedUpdatedAt: '2026-11-16T00:00:00.000Z' }),
    }),
  );
  assert.equal(langRes.status, 200);
  assert.deepEqual(runtime.calls, ['mode:lean', 'lang:en']);
});

test('路由 POST：过期 expectedUpdatedAt 返回 409 + 最新状态（多窗口不互相覆盖）', async () => {
  const runtime = runtimeStub();
  const res = await invoke(
    ctxWith({ streamAgentRuntime: runtime }),
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'lean', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }),
    }),
  );
  assert.equal(res.status, 409);
  const body = JSON.parse(res.payload);
  assert.equal(body.error.code, 'stale');
  assert.equal(body.status.mode, 'balanced');
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
      body: JSON.stringify({ mode: 'lean', expectedUpdatedAt: null }),
    }),
  );
  assert.equal(first.status, 200);
  assert.deepEqual(virgin.calls, ['mode:lean']);

  const written = runtimeStub();
  const late = await invoke(
    ctxWith({ streamAgentRuntime: written }),
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'lean', expectedUpdatedAt: null }),
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
  const runtime = runtimeStub({ modeSource: 'config', modeLocked: true });
  const res = await invoke(
    ctxWith({ streamAgentRuntime: runtime }),
    makeReq({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'power' }),
    }),
  );
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.payload).error.code, 'locked');
  assert.deepEqual(runtime.calls, []);
});

test('路由边界：未鉴权 401、跨站 403、非 JSON 415、非法模式 400', async () => {
  const deniedCtx = { get: () => ({ admit: () => ({ rejection: 401 }) }) };
  assert.equal((await invoke(deniedCtx, makeReq())).status, 401);

  const cross = await invoke(
    ctxWith({}),
    makeReq({ method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}' }),
  );
  assert.equal(cross.status, 403);

  const notJson = await invoke(
    ctxWith({}),
    makeReq({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'mode=lean' }),
  );
  assert.equal(notJson.status, 415);

  const badMode = await invoke(
    ctxWith({}),
    makeReq({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'turbo' }) }),
  );
  assert.equal(badMode.status, 400);
  assert.equal(JSON.parse(badMode.payload).error.code, 'invalid-mode');
});

test('降级路径：运行时缺席时写状态文件，并明确告知需要重启', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-ui-fallback-'));
  const previous = process.env.STREAM_AGENT_STATE_DIR;
  process.env.STREAM_AGENT_STATE_DIR = dir;
  try {
    const res = await invoke(
      ctxWith({}),
      makeReq({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'compat', lang: 'en' }),
      }),
    );
    assert.equal(res.status, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.degraded, true);
    assert.equal(body.status.takeover, false);
    assert.equal(body.status.mode, 'compat');
    assert.equal(body.status.lang, 'en');
    assert.ok(body.notice.includes('重启'));
    assert.ok(existsSync(join(dir, 'control.json')));
  } finally {
    if (previous === undefined) delete process.env.STREAM_AGENT_STATE_DIR;
    else process.env.STREAM_AGENT_STATE_DIR = previous;
  }
});
