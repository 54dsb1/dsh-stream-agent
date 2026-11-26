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
import { LEGACY_MODE_ALIAS, publicLegacyModeCatalog, publicChannelCatalog, publicTierCatalog } from '../src/kernel/modes.ts';

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

test('R5. 0.5.0 两轴目录：旧模式目录变成别名投影（deprecated + 移除版本），工具面不再随预设变化', () => {
  // 0.5.0（§4.2/§4.4）：四档变两轴——旧四模式只保留别名映射（0.6.0 移除），
  // 别名不携带任何 toolSurface/enableCode 副作用（D2/D3 的成因正是预设顺手改工具面）。
  const legacy = publicLegacyModeCatalog();
  assert.equal(legacy.length, 4, '旧模式目录保留 4 条（别名期）');
  assert.deepEqual(legacy.map((m) => m.aliasTarget), [
    { channel: 'standard', tier: 'standard' },
    { channel: 'standard', tier: 'light' },
    { channel: 'standard', tier: 'deep' },
    { channel: 'code', tier: 'standard' },
  ]);
  for (const m of legacy) assert.equal('deprecated' in m, false, '目录不带版本标注');
  // 新轴目录：通道 2（模型看到什么）× 档位 3（只改数值）
  assert.equal(publicChannelCatalog().length, 2);
  assert.equal(publicTierCatalog().length, 3);
  // power → code 通道；compat/lean 的工具面副作用已删除（D2/D3 修复）
  assert.equal(LEGACY_MODE_ALIAS.power.channel, 'code');
  assert.ok(!('toolSurface' in LEGACY_MODE_ALIAS.lean));
});
