// ui/index.js —— 桌面控制页的宿主半边（0.5.0：两区块）
//
// 为什么是独立子包：dsh-client-modules 以 **包** 为单位扫描 dsh.client，
// 同一个包被多个 Loader 行引用时会抛 "resolves from multiple active Loader sources"。
// 主包已经有六个 entry（loop / state / obs / gate / render / control-bar），
// 所以浏览器半边必须住在自己的包（ui/package.json）里，主包不能声明 dsh.client。
//
// 本文件只做三件事：
//   1. 注册同源路由 /stream-agent/control（GET 读状态，POST 改通道/档位/语言）
//   2. 复用宿主的 connection.admit 做鉴权（桌面端是 cookie，Web 端是同一套会话）
//   3. 优先调用 loop 提供的 streamAgentRuntime 服务；服务缺席时降级为只读诊断
//
// 0.5.3 区块 C：POST 面再增 {limits?: {k:v}, limitsReplace?: boolean}——
// 上限一律由用户在控制页定义（未定义/0 = 不限制），路由层只做校验与落盘，不注入任何默认值。
// 0.5.0 两区块（§3.3）：POST 面 = {channel?, tier?, lang?, mode?, budget?}——
// mode 是 0.5.x 别名（0.6.0 移除）；区块 A 不出现"PTC 模式"字样（来源是探测结果）。
//
// 刻意不引入任何 npm 依赖：只 import 本包 dist/ 里已有的内核模块。

import { readPersistedControl, writePersistedControl, parseSwitchValue } from '../dist/entry/control-state.js';
import { isChannelId, isTierId, publicChannelCatalog, publicTierCatalog, publicLegacyModeCatalog, getTier } from '../dist/kernel/modes.js';
import { isLang, switchSummaryLine } from '../dist/kernel/control-bar.js';
// 0.5.2：降级视图要给"生效参数"报账，语义必须与运行时同源（0 = 不限制）
import { limitOf, mergeLimits, publicLimitCatalog, sanitizeLimitPatch, THINKFLOW_ALIGNED_LIMITS } from '../dist/kernel/limits.js';
// v0.4.0（P4）：预设路由（空白会话三向切换的唯一入口；locked 具名识别）
import { createPresetRouter, isPresetLockedError } from '../dist/entry/preset-router.js';
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

/** 可读的降级状态：loop 没接管时仍让用户看到文件里的值与 CLI 指引。 */
function fallbackStatus() {
  const persisted = readPersistedControl();
  const tierValues = getTier(persisted.state.tier).values;
  // 0.5.2：档位不再预设上限（`tier.values` 的数值位全是 0 = 不限制）。
  // 降级视图的"生效参数"必须由用户 limits 报账，不能继续拿档位参考值顶替——
  // 否则面板会显示 0（不限制）当上限，或把 reference 值说成已生效。
  // 0.6.1：状态文件 = 纯用户层（默认层不物化进盘）；"生效参数"投影 = thinkflow 对齐层 + 用户 limits
  const limits = persisted.limits ?? {};
  const effectiveLimits = mergeLimits(THINKFLOW_ALIGNED_LIMITS, limits);
  return {
    version: VERSION,
    takeover: false,
    degraded: true,
    channel: persisted.state.channel,
    channelSource: persisted.found ? 'file' : 'default',
    channelLocked: isChannelId(process.env.STREAM_AGENT_CHANNEL) || isChannelId(process.env.STREAM_AGENT_MODE),
    tier: persisted.state.tier,
    tierSource: persisted.found ? 'file' : 'default',
    tierLocked: isTierId(process.env.STREAM_AGENT_TIER) || isTierId(process.env.STREAM_AGENT_MODE),
    aliased: persisted.aliased === true,
    lang: persisted.state.lang,
    langSource: persisted.found ? 'file' : 'default',
    langLocked: isLang(process.env.STREAM_AGENT_LANG),
    // 0.6.0：降级视图也要暴露两个开关（否则面板无法显示"关了没有"，写回也拿不到现值）
    contextFold: persisted.state.contextFold !== false,
    finalCheck: persisted.state.finalCheck !== false,
    // 0.6.0 正式版：原样档（0.6.1：行为预设已移除——默认面 = thinkflow 对齐层）
    contextRaw: persisted.state.contextRaw === true,
    switchSummary: switchSummaryLine(persisted.state, persisted.state.lang),
    effective: {
      maxSteps: limitOf(effectiveLimits, 'maxSteps'),
      maxInputTokens: limitOf(effectiveLimits, 'maxInputTokens'),
      compactAggressiveness: tierValues.compactAggressiveness,
      peekBudgetChars: limitOf(effectiveLimits, 'peekBudgetChars'),
      keepRecent: limitOf(effectiveLimits, 'keepRecent'),
      maxSummaryChars: limitOf(effectiveLimits, 'maxSummaryChars'),
      surfacePolicy: 'reserved-only',
    },
    limits,
    limitCatalog: publicLimitCatalog(limits),
    channels: publicChannelCatalog(),
    tiers: publicTierCatalog(),
    legacyModes: publicLegacyModeCatalog(),
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
    // v0.4.0（P4）：预设名册 + 默认值（只读展示）。切换面缺席（headless/旧宿主）→ presets: null。
    const router = createPresetRouter(ctx);
    let presets = null;
    if (router !== undefined) {
      try {
        presets = { items: await router.list(), defaultId: router.defaultId ?? null };
      } catch (error) {
        presets = { error: String(error?.message ?? error) };
      }
    }
    sendJson(res, 200, { ok: true, status: currentStatus(ctx), presets });
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

  // 0.5.0 两区块 POST 面：channel（区块 A）/ tier（区块 B）/ lang / budget / mode（0.5.x 别名）
  const wantsChannel = body.channel !== undefined;
  const wantsTier = body.tier !== undefined;
  const wantsBudget = body.budget !== undefined && body.budget !== null;
  const wantsLang = body.lang !== undefined;
  const wantsMode = body.mode !== undefined;
  // 0.5.3（区块 C）：上限由用户定义——`limits` 为增量补丁，`limitsReplace` 为整组替换，
  // `limits: {}` + limitsReplace 等价于"清空为全部不限制"。
  const wantsLimits = body.limits !== undefined;
  const limitsReplace = body.limitsReplace === true || body.limits === null;
  // 0.6.0 正式版：三个行为开关（与终端/CLI 同源）。0.6.1：行为预设已移除。
  const switchPatch = {};
  for (const key of ['contextFold', 'finalCheck', 'contextRaw']) {
    if (body[key] !== undefined) switchPatch[key] = body[key];
  }
  const wantsSwitches = Object.keys(switchPatch).length > 0;
  if (!wantsChannel && !wantsTier && !wantsLang && !wantsMode && !wantsBudget && !wantsLimits && !wantsSwitches) {
    sendJson(res, 400, { ok: false, error: { code: 'empty', message: 'channel, tier, budget, limits, switches or lang required' }, status: live });
    return;
  }
  for (const [key, raw] of Object.entries(switchPatch)) {
    if (typeof raw !== 'boolean' && parseSwitchValue(raw) === undefined) {
      sendJson(res, 400, { ok: false, error: { code: 'invalid-switch', message: `${key} must be a boolean (on/off)` }, status: live });
      return;
    }
  }
  if (wantsChannel && !isChannelId(body.channel)) {
    sendJson(res, 400, { ok: false, error: { code: 'invalid-channel', message: `unknown channel: ${String(body.channel)}（valid: standard | code）` }, status: live });
    return;
  }
  if (wantsTier && !isTierId(body.tier)) {
    sendJson(res, 400, { ok: false, error: { code: 'invalid-tier', message: `unknown tier: ${String(body.tier)}（valid: light | standard | deep）` }, status: live });
    return;
  }
  if (wantsBudget && (typeof body.budget !== 'object' || Array.isArray(body.budget))) {
    sendJson(res, 400, { ok: false, error: { code: 'invalid-budget', message: 'budget must be an object: { maxSteps?, maxInputTokens? }' }, status: live });
    return;
  }
  if (wantsMode && typeof body.mode !== 'string') {
    sendJson(res, 400, { ok: false, error: { code: 'invalid-mode', message: `legacy mode must be a string (balanced|lean|compat|power)` }, status: live });
    return;
  }
  if (wantsLang && !isLang(body.lang)) {
    sendJson(res, 400, { ok: false, error: { code: 'invalid-lang', message: `unknown language: ${String(body.lang)}` }, status: live });
    return;
  }
  // 上限校验走内核 sanitize（与 CLI / control.json 同一套规则：未知键/非整数/负数一律拒绝并回报）
  let limitsPatch = {};
  let limitsWarnings = [];
  if (wantsLimits) {
    if (body.limits !== null && (typeof body.limits !== 'object' || Array.isArray(body.limits))) {
      sendJson(res, 400, { ok: false, error: { code: 'invalid-limits', message: 'limits must be an object: { maxSteps?: 40, ... }' }, status: live });
      return;
    }
    const parsed = sanitizeLimitPatch(body.limits ?? {}, 'control-page');
    limitsWarnings = parsed.warnings;
    if (Object.keys(parsed.values).length === 0 && !limitsReplace && limitsWarnings.length > 0) {
      sendJson(res, 400, {
        ok: false,
        error: { code: 'invalid-limits', message: limitsWarnings.join('; ') },
        status: live,
      });
      return;
    }
    limitsPatch = parsed.values;
  }

  // 锁定判断放在路由层：运行时服务即使实现有出入，也不会绕过装配配置/环境变量。
  if ((wantsChannel && live.channelLocked === true) || (wantsTier && live.tierLocked === true)
    || (wantsMode && (live.channelLocked === true || live.tierLocked === true))
    || (wantsLang && live.langLocked === true)) {
    sendJson(res, 409, {
      ok: false,
      error: { code: 'locked', message: '当前值由装配配置或环境变量锁定' },
      status: live,
    });
    return;
  }

  // 运行时在位：走服务，通道/档位立即对新会话生效并落盘（会话内切换排队到任务边界）。
  if (runtime !== undefined && (typeof runtime.setChannel === 'function' || typeof runtime.setTier === 'function' || typeof runtime.setLang === 'function')) {
    let result = { ok: true, persisted: true };
    if (wantsMode && typeof runtime.setMode === 'function') result = runtime.setMode(body.mode);
    if (result.ok !== false && wantsChannel) result = runtime.setChannel(body.channel);
    if (result.ok !== false && wantsTier) result = runtime.setTier(body.tier);
    if (result.ok !== false && wantsBudget && typeof runtime.setBudget === 'function') result = runtime.setBudget(body.budget);
    // 0.5.3：上限优先走 setLimits（0.6.0 起 24 个键全落点）；老运行时只有 setBudget 时退化为那两个键
    if (result.ok !== false && wantsLimits) {
      if (typeof runtime.setLimits === 'function') {
        const applied = runtime.setLimits(limitsPatch, { replace: limitsReplace });
        if (applied !== null && typeof applied === 'object' && applied.ok === false) {
          result = applied;
        } else {
          const accepted = (applied !== null && typeof applied === 'object' && (applied.accepted ?? applied.limits)) || limitsPatch;
          result = {
            ok: true,
            persisted: true,
            limits: accepted,
            ...(applied !== null && typeof applied === 'object' && applied.ignored !== undefined
              ? { ignored: applied.ignored }
              : {}),
          };
        }
      } else if (typeof runtime.setBudget === 'function') {
        const budgetPatch = {};
        if (limitsPatch.maxSteps !== undefined) budgetPatch.maxSteps = limitsPatch.maxSteps;
        if (limitsPatch.maxInputTokens !== undefined) budgetPatch.maxInputTokens = limitsPatch.maxInputTokens;
        if (Object.keys(budgetPatch).length > 0) result = runtime.setBudget(budgetPatch);
      }
    }
    if (result.ok !== false && wantsSwitches) {
      if (typeof runtime.setSwitches === 'function') {
        const applied = runtime.setSwitches(switchPatch);
        if (applied !== null && typeof applied === 'object' && applied.ok === false) result = applied;
      } else {
        result = { ok: false, code: 'unsupported', detail: '运行时没有 setSwitches（请升级插件运行时）' };
      }
    }
    if (result.ok !== false && wantsLang) result = runtime.setLang(body.lang);
    if (result.ok === false) {
      const statusCode = result.code === 'locked' ? 409 : result.code === 'rebase-limit' ? 409 : 400;
      sendJson(res, statusCode, {
        ok: false,
        error: { code: result.code ?? 'refused', message: result.detail ?? (result.code === 'locked' ? '当前值由装配配置或环境变量锁定' : 'invalid value') },
        status: currentStatus(ctx),
      });
      return;
    }
    if (limitsWarnings.length > 0 || result.ignored !== undefined) {
      sendJson(res, 200, {
        ok: true,
        persisted: result.persisted !== false,
        limits: result.limits ?? limitsPatch,
        warnings: [...limitsWarnings, ...(result.ignored ?? [])],
        status: currentStatus(ctx),
      });
      return;
    }
    sendJson(res, 200, { ok: true, persisted: result.persisted !== false, status: currentStatus(ctx) });
    return;
  }

  // 降级：loop 没接管（装载失败/headless），只改状态文件，并明确告知需要重启。
  const next = {
    channel: wantsMode
      ? ({ balanced: 'standard', lean: 'light', compat: 'deep', power: 'code' }[body.mode] !== undefined
        ? (body.mode === 'power' ? 'code' : 'standard')
        : live.channel)
      : (wantsChannel ? body.channel : live.channel),
    tier: wantsMode
      ? ({ balanced: 'standard', lean: 'light', compat: 'deep', power: 'standard' }[body.mode] ?? live.tier)
      : (wantsTier ? body.tier : live.tier),
    lang: wantsLang ? body.lang : live.lang,
  };
  // BUGFIX（0.5.3）：降级分支此前只写 channel/tier/lang —— 用户定义的上限会在
  // "loop 未接管时改一次通道"时被整组抹掉（writePersistedControl 收到没有 limits 的对象
  // 就按"没有上限"落盘）。这里必须把生效的 limits 一起带上。
  if (wantsLimits) {
    next.limits = limitsReplace ? limitsPatch : mergeLimits(live.limits, limitsPatch);
  } else if (live.limits !== undefined) {
    next.limits = live.limits;
  }
  // 0.6.0：同样的坑在行为开关上——writePersistedControl 对缺字段按默认 true 落盘，
  // 降级分支只写 channel/tier/lang 会把关掉的 contextFold/finalCheck 重置回开。
  if (live.contextFold !== undefined) next.contextFold = live.contextFold;
  if (live.finalCheck !== undefined) next.finalCheck = live.finalCheck;
  if (live.contextRaw !== undefined) next.contextRaw = live.contextRaw;
  // 0.6.1：行为预设应用分支已移除；开关手工修改直接生效。
  if (wantsSwitches) {
    for (const [key, raw] of Object.entries(switchPatch)) {
      next[key] = typeof raw === 'boolean' ? raw : parseSwitchValue(raw);
    }
  }
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
    limits: next.limits ?? {},
    ...(limitsWarnings.length > 0 ? { warnings: limitsWarnings } : {}),
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
