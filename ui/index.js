// ui/index.js —— 桌面控制页的宿主半边（v0.2.1）
//
// 为什么是独立子包：dsh-client-modules 以 **包** 为单位扫描 dsh.client，
// 同一个包被多个 Loader 行引用时会抛 "resolves from multiple active Loader sources"。
// 主包已经有六个 entry（loop / state / obs / gate / render / control-bar），
// 所以浏览器半边必须住在自己的包（ui/package.json）里，主包不能声明 dsh.client。
//
// 本文件只做三件事：
//   1. 注册同源路由 /stream-agent/control（GET 读状态，POST 改模式/语言）
//   2. 复用宿主的 connection.admit 做鉴权（桌面端是 cookie，Web 端是同一套会话）
//   3. 优先调用 loop 提供的 streamAgentRuntime 服务；服务缺席时降级为只读诊断
//
// 刻意不引入任何 npm 依赖：只 import 本包 dist/ 里已有的内核模块。

import { readPersistedControl, writePersistedControl } from '../dist/entry/control-state.js';
import { isModeId, modeConfig, publicModeCatalog } from '../dist/kernel/modes.js';
import { isLang } from '../dist/kernel/control-bar.js';
import { VERSION } from '../dist/version.js';

export const name = 'stream-agent-ui';
/** 宿主侧不需要任何服务才能装载；webServer 在 apply 里可选等待。 */
export const inject = [];
export const CONTROL_ROUTE = '/stream-agent/control';
const MAX_BODY_BYTES = 4096;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function publicModes() {
  return publicModeCatalog();
}

/** 可读的降级状态：loop 没接管时仍让用户看到文件里的值与 CLI 指引。 */
function fallbackStatus() {
  const persisted = readPersistedControl();
  const preset = modeConfig(persisted.state.mode);
  return {
    version: VERSION,
    takeover: false,
    degraded: true,
    mode: persisted.state.mode,
    modeSource: persisted.found ? 'file' : 'default',
    modeLocked: isModeId(process.env.STREAM_AGENT_MODE),
    lang: persisted.state.lang,
    langSource: persisted.found ? 'file' : 'default',
    langLocked: isLang(process.env.STREAM_AGENT_LANG),
    effective: {
      selfReadFeedback: preset.selfReadFeedback,
      enableCode: preset.enableCode === 'auto' ? 'auto' : preset.enableCode,
      persistFallback: preset.persistFallback,
      maxParallelToolCalls: preset.maxParallelToolCalls,
      maxReentries: preset.maxReentries,
      budgetTokens: preset.budgetTokens ?? null,
    },
    modes: publicModes(),
    updatedAt: persisted.updatedAt ?? null,
    stateFile: persisted.file,
  };
}

function currentStatus(ctx) {
  const runtime = ctx.get?.('streamAgentRuntime');
  if (runtime !== undefined && typeof runtime.status === 'function') {
    try {
      return runtime.status();
    } catch {
      // 运行时服务坏了不该让页面 500：退回文件视图，保留诊断信息
      return { ...fallbackStatus(), degraded: true, runtimeError: true };
    }
  }
  return fallbackStatus();
}

/**
 * 复用宿主的连接鉴权：桌面端由 preload 注入 cookie，Web 端是同一套会话 cookie。
 * connection 缺席时只允许回环地址（测试/极简宿主）。
 */
function admitted(ctx, req) {
  const connection = ctx.get?.('connection');
  if (connection !== undefined && typeof connection.admit === 'function') {
    try {
      const admission = connection.admit(req);
      return admission === undefined || admission === null || !('rejection' in admission);
    } catch {
      return false;
    }
  }
  const address = req.socket?.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error('body too large'), { code: 'too-large' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text === '' ? {} : JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('invalid json'), { code: 'bad-json' }));
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function sameOriginOnly(req) {
  const site = req.headers?.['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

function expectedMatches(body, status) {
  if (!Object.prototype.hasOwnProperty.call(body, 'expectedUpdatedAt')) return true;
  const expected = body.expectedUpdatedAt;
  if (expected === null) return status.updatedAt === null || status.updatedAt === undefined;
  return expected === status.updatedAt;
}

function conflict(res, status) {
  sendJson(res, 409, {
    ok: false,
    error: { code: 'stale', message: '状态已被其他窗口或 CLI 修改，请刷新后重试' },
    status,
  });
}

/** 路由处理函数（导出供测试直接调用，不经过 http 服务器）。 */
export async function handleControlRequest(ctx, req, res) {
  if (!admitted(ctx, req)) {
    sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: 'unauthorized' } });
    return;
  }
  if (!sameOriginOnly(req)) {
    sendJson(res, 403, { ok: false, error: { code: 'origin', message: 'cross-origin request refused' } });
    return;
  }

  if (req.method === 'GET') {
    sendJson(res, 200, { ok: true, status: currentStatus(ctx) });
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: { code: 'method', message: 'GET or POST only' } }));
    return;
  }

  const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    sendJson(res, 415, { ok: false, error: { code: 'content-type', message: 'application/json required' } });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    const code = error?.code === 'too-large' ? 'too-large' : 'bad-json';
    sendJson(res, code === 'too-large' ? 413 : 400, {
      ok: false,
      error: { code, message: code === 'too-large' ? 'body too large' : 'invalid json' },
    });
    return;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { ok: false, error: { code: 'bad-body', message: 'object body required' } });
    return;
  }

  const runtime = ctx.get?.('streamAgentRuntime');
  const live = currentStatus(ctx);
  if (!expectedMatches(body, live)) {
    conflict(res, live);
    return;
  }

  const wantsMode = body.mode !== undefined;
  const wantsLang = body.lang !== undefined;
  if (!wantsMode && !wantsLang) {
    sendJson(res, 400, { ok: false, error: { code: 'empty', message: 'mode or lang required' }, status: live });
    return;
  }
  if (wantsMode && !isModeId(body.mode)) {
    sendJson(res, 400, { ok: false, error: { code: 'invalid-mode', message: `unknown mode: ${String(body.mode)}` }, status: live });
    return;
  }
  if (wantsLang && !isLang(body.lang)) {
    sendJson(res, 400, { ok: false, error: { code: 'invalid-lang', message: `unknown language: ${String(body.lang)}` }, status: live });
    return;
  }

  // 锁定判断放在路由层：运行时服务即使实现有出入，也不会绕过装配配置/环境变量。
  if ((wantsMode && live.modeLocked === true) || (wantsLang && live.langLocked === true)) {
    sendJson(res, 409, {
      ok: false,
      error: { code: 'locked', message: '当前值由装配配置或环境变量锁定' },
      status: live,
    });
    return;
  }

  // 运行时在位：走服务，模式立即对新会话生效并落盘。
  if (runtime !== undefined && (typeof runtime.setMode === 'function' || typeof runtime.setLang === 'function')) {
    let result = { ok: true, persisted: true };
    if (wantsMode) result = runtime.setMode(body.mode);
    if (result.ok !== false && wantsLang) result = runtime.setLang(body.lang);
    if (result.ok === false) {
      const statusCode = result.code === 'locked' ? 409 : 400;
      sendJson(res, statusCode, {
        ok: false,
        error: { code: result.code ?? 'refused', message: result.code === 'locked' ? '当前值由装配配置或环境变量锁定' : 'invalid value' },
        status: currentStatus(ctx),
      });
      return;
    }
    sendJson(res, 200, { ok: true, persisted: result.persisted !== false, status: currentStatus(ctx) });
    return;
  }

  // 降级：loop 没接管（装载失败/headless），只改状态文件，并明确告知需要重启。
  const next = {
    mode: wantsMode ? body.mode : live.mode,
    lang: wantsLang ? body.lang : live.lang,
  };
  try {
    writePersistedControl(next);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: { code: 'write-failed', message: String(error?.message ?? error) },
      status: live,
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    persisted: true,
    degraded: true,
    notice: 'loop 未接管：已写入状态文件，修复装载后重启生效',
    status: currentStatus(ctx),
  });
}

/** Cordis 宿主插件体：webServer 是可选的（headless 组合里没有它）。 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: CONTROL_ROUTE,
        handler: (req, res) => { void handleControlRequest(ctx, req, res); },
      }),
      'stream-agent-ui: control route',
    );
  });
}
