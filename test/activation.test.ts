// test/activation.test.ts —— v0.2.1 装载期回归（事故：桌面端 "1 entry did not activate stream-agent"）
//
// 现场两行报错：
//   dsh: warning: 1 entry did not activate stream-agent
//   Error: cannot get property "ptcRuntime" without inject
//
// 两个独立缺陷，本文件分别钉住：
//   缺陷 1｜可选服务裸读：Cordis 4.x 的 ctx 是 Proxy，未 inject 的属性读取直接抛错。
//            这里用 strictCtx 复刻该行为（未声明的属性读取抛同款错误）。
//   缺陷 2｜返回值契约：函数式插件的返回值被当作 effect 收集，普通对象 = Invalid effect。
//            这里断言每个 entry 的返回值可调用。
//
// 断言口径：apply() 在"严格 ctx（会抛 inject 错）+ 无 ptcRuntime"下必须装载成功，
// 且不得因为可选服务缺失而抛错——这是 v0.2.0 完全不可用的直接原因。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import applyLoop from '../src/entry/loop.ts';
import applyStateHandle from '../src/entry/state-handle.ts';
import applyObsBroker from '../src/entry/obs-broker.ts';
import applyActionGate from '../src/entry/action-gate.ts';
import applyContextRender from '../src/entry/context-render.ts';
import applyControlBar from '../src/entry/control-bar.ts';
import { asPluginEffect, getService } from '../src/entry/cordis-compat.ts';

/**
 * 复刻 Cordis 4.x 的 context proxy：
 *   · 方法面（get/provide/on/effect）直接可读；
 *   · 服务只能通过 ctx.get(name) 取（无 inject 要求）；
 *   · **未声明注入**的属性读取一律抛 `cannot get property "X" without inject`。
 */
function strictCtx(services: Record<string, unknown>, injected: readonly string[] = []): Record<string, unknown> {
  const base: Record<string, unknown> = {
    get(name: string): unknown {
      return services[name];
    },
    provide(): void {},
    on(): void {},
    effect(): void {},
  };
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (injected.includes(prop) && services[prop] !== undefined) return services[prop];
      throw new Error(`cannot get property "${prop}" without inject`);
    },
    has(target, prop) {
      if (Reflect.has(target, prop)) return true;
      return injected.includes(String(prop)) && services[String(prop)] !== undefined;
    },
  });
}

function makeServices(): { services: Record<string, unknown>; factory: () => unknown } {
  let registered: unknown = null;
  return {
    services: {
      llm: { stream: () => (async function* () {})() },
      tools: { execute: async () => ({ results: [] }), guard: () => () => {} },
      agents: {
        setFactory: (factory: unknown) => {
          registered = factory;
          return () => { registered = null; };
        },
      },
      sessions: { prepare: async () => ({}) },
      logger: { warn: () => {}, error: () => {} },
      storage: {
        backend: {
          get: () => ({
            kv: {
              open: async () => ({
                loadAll: async () => ({ tables: {}, global: null }),
                putRecord: async () => {},
                close: async () => {},
              }),
            },
          }),
        },
      },
    },
    factory: () => registered,
  };
}

test('strictCtx 复刻了 Cordis 的 inject 守卫（负向对照）', () => {
  const ctx = strictCtx({}, []);
  assert.throws(() => (ctx as Record<string, unknown>)['ptcRuntime'], /cannot get property "ptcRuntime" without inject/);
  assert.equal(ctx.get('ptcRuntime'), undefined, 'ctx.get 不要求 inject，缺失时返回 undefined');
});

test('getService：可选服务缺失 / 守卫抛错 / 桩对象属性三条路径都降级为 undefined', () => {
  const strict = strictCtx({ llm: { stream: () => {} } }, []);
  assert.equal(getService(strict, 'ptcRuntime'), undefined);
  assert.notEqual(getService(strict, 'llm'), undefined, 'ctx.get 命中的服务必须返回');

  // 非 Cordis 测试桩：服务直接挂在 ctx 上（历史用法），属性回退仍要能用
  const stub = { llm: { stream: () => {} } };
  assert.notEqual(getService(stub, 'llm'), undefined);

  // 极端桩：get 自己抛错 → 仍然不能冒泡
  const broken = { get() { throw new Error('boom'); } };
  assert.equal(getService(broken, 'anything'), undefined);
});

test('缺陷 1 回归：无 ptcRuntime 时 loop entry 必须装载成功（不再裸读属性）', () => {
  const { services, factory } = makeServices();
  const ctx = strictCtx(services, ['llm', 'tools', 'agents', 'sessions']);
  const handle = applyLoop(ctx as never, { announceTakeover: false, maxParallelToolCalls: 3, maxReentries: 8, streamIdleTimeoutMs: 30000 });
  assert.notEqual(handle, undefined);
  assert.notEqual(factory(), null, 'setFactory 必须被调用（接管才算成立）');
  assert.equal(typeof handle, 'function', '缺陷 2：返回值必须是可调用 disposer');
  handle();
  assert.equal(factory(), null, 'disposer 必须卸载 factory');
});

test('缺陷 1 回归：ptcRuntime / sessionProjections / loader / agentDefaultModel 全部缺失也不抛错', () => {
  const { services } = makeServices();
  const ctx = strictCtx(services, ['llm', 'tools', 'agents', 'sessions']);
  assert.doesNotThrow(() => {
    const handle = applyLoop(ctx as never, {});
    assert.equal(typeof handle, 'function');
  });
});

test('缺陷 1 回归：ptcRuntime 形状不符只告警、不阻断（tf-code 通道关闭）', () => {
  const { services } = makeServices();
  services['ptcRuntime'] = { notARuntime: true };
  const warnings: string[] = [];
  services['logger'] = { warn: (m: string) => warnings.push(m), error: () => {} };
  const ctx = strictCtx(services, ['llm', 'tools', 'agents', 'sessions']);
  assert.doesNotThrow(() => applyLoop(ctx as never, {}));
  assert.ok(warnings.some((w) => w.includes('ptcRuntime')), '形状不符必须告警，不静默');
});

test('缺陷 2 回归：五个 entry 的返回值都是 Cordis 合法 effect（function / null）', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'tf-activation-'));
  const { services } = makeServices();
  const handles: unknown[] = [
    applyStateHandle(strictCtx(services, ['storage']) as never, { unit: 'tfAgentState', stateDir, announce: false }),
    applyObsBroker(strictCtx(services, ['tools']) as never, { announce: false }),
    applyActionGate(strictCtx(services, ['tools', 'storage']) as never, { announce: false }),
    applyContextRender(strictCtx(services, []) as never, { announce: false }),
    applyControlBar(strictCtx(services, []) as never, { announce: false, stateDir }),
  ];
  for (const handle of handles) {
    assert.equal(typeof handle, 'function', `entry 返回值必须是函数（实际 ${typeof handle}）`);
    assert.doesNotThrow(() => (handle as () => void)());
  }
});

test('asPluginEffect：句柄属性照旧可读，调用即执行 dispose', () => {
  let disposed = 0;
  const handle = asPluginEffect({ service: 'x', dispose: () => { disposed += 1; } });
  assert.equal(typeof handle, 'function');
  assert.equal(handle.service, 'x');
  handle();
  assert.equal(disposed, 1);
});

test('asPluginEffect：没有 dispose 字段时调用不抛错', () => {
  const handle = asPluginEffect({ value: 1 });
  assert.equal(handle.value, 1);
  assert.doesNotThrow(() => handle());
});

test('loop entry 兼容老式测试桩（服务直接挂在 ctx 上）', () => {
  const { services, factory } = makeServices();
  // 老桩：没有 get 方法，服务是普通属性
  const plain = { llm: services['llm'], tools: services['tools'], agents: services['agents'] };
  const handle = applyLoop(plain as never, {});
  assert.equal(typeof handle, 'function');
  assert.notEqual(factory(), null);
});

test('版本常量与 package.json 一致（发版口径唯一）', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; bin?: Record<string, string> };
  const source = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8');
  assert.match(source, new RegExp(`VERSION = '${pkg.version.replace(/\./g, '\\.')}'`), 'src/version.ts 必须与 package.json 同版本');
  assert.ok(pkg.bin?.['dsh-stream-agent'] !== undefined, 'package.json 必须暴露 dsh-stream-agent 命令');
});
