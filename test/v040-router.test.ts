// test/v040-router.test.ts —— v0.4.0 P4：PresetRouter（G3 模式切换）+ 能力档维度
//
// 语义锚（design §7.3/§8，宿主 rc.3 取证 dsh-agent-preset-registry/lib/index.js:766-775）：
//   - 空白会话（lastTurn===0 且无 open turn）可切；已开回合 select 抛 agent-preset/locked——
//     路由器**不自行判断、不包装**，原样上抛（G3 的具名失败用例依赖宿主错误形状）。
//   - 服务缺席（headless/旧宿主）→ createPresetRouter 返回 undefined（无切换面，不静默）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPresetRouter, isPresetLockedError } from '../src/entry/preset-router.ts';
import type { AgentPresetsServiceLike } from '../src/entry/preset-router.ts';
import { getMode, modeConfig, publicModeCatalog } from '../src/kernel/modes.ts';

function fakeRegistry(opts: { lastTurn?: number; openTurn?: boolean } = {}): AgentPresetsServiceLike {
  return {
    async list() {
      return [
        { id: 'standard', name: 'Standard', order: 1 },
        { id: 'ptc', name: 'PTC', order: 2 },
        { id: 'stream', name: 'Stream', description: '单流协议工具面', order: 99 },
        { id: 'broken-one', broken: 'activation failed', order: 50 },
      ];
    },
    async select(agent: unknown, agentPreset: string) {
      const state = agent as { lastTurn?: number; openTurn?: boolean };
      if ((state.lastTurn ?? 0) > 0 || state.openTurn === true) {
        const err = new Error('This session has already started');
        (err as Error & { code?: string }).code = 'agent-preset/locked';
        throw err;
      }
      return agentPreset;
    },
    presetForSession(session: unknown) {
      return (session as { preset?: string })?.preset ?? null;
    },
    defaultId: 'standard',
  };
}

test('R1. createPresetRouter：list 投影完整（broken 如实）；defaultId 透传', async () => {
  const router = createPresetRouter({ get: (s: string) => (s === 'agentPresets' ? fakeRegistry() : undefined) });
  assert.ok(router !== undefined);
  const items = await router.list();
  assert.equal(items.length, 4);
  const broken = items.find((d) => d.id === 'broken-one');
  assert.equal(broken?.broken, 'activation failed');
  assert.equal(router.defaultId, 'standard');
});

test('R2. 空白会话三向切换成功（standard→stream→ptc→standard）', async () => {
  const router = createPresetRouter({ get: (s: string) => (s === 'agentPresets' ? fakeRegistry() : undefined) })!;
  const blank = { lastTurn: 0, openTurn: false };
  assert.equal(await router.select(blank, 'stream'), 'stream');
  assert.equal(await router.select(blank, 'ptc'), 'ptc');
  assert.equal(await router.select(blank, 'standard'), 'standard');
});

test('R3. 已开回合切换：agent-preset/locked 原样上抛（不包装、不吞）', async () => {
  const router = createPresetRouter({ get: (s: string) => (s === 'agentPresets' ? fakeRegistry() : undefined) })!;
  const started = { lastTurn: 3 };
  await assert.rejects(() => router.select(started, 'stream'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'agent-preset/locked');
    return true;
  });
  const openTurn = { lastTurn: 0, openTurn: true };
  await assert.rejects(() => router.select(openTurn, 'stream'), (error: unknown) => isPresetLockedError(error));
});

test('R4. current()：presetForSession 优先；服务缺方法/缺席 = null（如实不知道）', () => {
  const router = createPresetRouter({ get: (s: string) => (s === 'agentPresets' ? fakeRegistry() : undefined) })!;
  assert.equal(router.current({ preset: 'stream' }), 'stream');
  assert.equal(router.current({}), null);
  const bare = createPresetRouter({ get: () => ({ list: async () => [], select: async () => 'x' }) });
  assert.equal(bare!.current({ preset: 'stream' }), null, '宿主无 presetForSession 方法 → null');
  assert.equal(createPresetRouter({ get: () => undefined }), undefined, '无服务 → 无路由器');
  assert.equal(createPresetRouter({}), undefined, '无 get 方法 → 无路由器');
});

test('R5. 能力档维度：模式提供 toolSurface 默认值（不是第五个模式）', () => {
  const catalog = publicModeCatalog();
  assert.equal(catalog.length, 4, '模式数不变（能力档不是模式）');
  // lean = core（首请求 schema 最省）；compat = off（0.3.x 回退）；balanced/power = standard
  assert.equal(modeConfig('lean').toolSurface, 'core');
  assert.equal(modeConfig('compat').toolSurface, 'off');
  assert.equal(modeConfig('balanced').toolSurface, 'standard');
  assert.equal(modeConfig('power').toolSurface, 'standard');
  // getMode fail-open：未知 id → 默认模式，config 带 tier
  assert.equal(getMode('nope').config.toolSurface, 'standard');
});
