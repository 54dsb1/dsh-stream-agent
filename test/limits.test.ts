// test/limits.test.ts —— 0.5.2：所有行为上限由用户定义（插件不预设）
//
// 断言口径（不看私有字段）：
//   · 未定义 = 不限制（0），且档位/通道不再携带任何预设数值；
//   · 用户定义即可生效（全局 → 档位 → 通道 → 运行期，后层覆盖）；
//   · 非法键/值一律丢弃并告警（不静默）；
//   · 三层来源（control.json / env / 装配 config）的优先级与落盘往返。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LIMIT_KEYS,
  THINKFLOW_ALIGNED_LIMITS,
  deriveLimits,
  formatLimitValue,
  formatLimitsLine,
  limitOf,
  mergeLimits,
  parseLimitAssignments,
  publicLimitCatalog,
  sanitizeLimitPatch,
} from '../src/kernel/limits.ts';
import { TIER_SPECS, publicTierCatalog } from '../src/kernel/modes.ts';
import { controlFileOf, readPersistedControl, resolveControlState, updatePersistedLimits, writePersistedControl } from '../src/entry/control-state.ts';
import { SingleStreamDriver } from '../src/entry/loop.ts';
import type { DriverPorts, StreamChunkLike, StreamDriverConfig } from '../src/entry/loop.ts';

// ---------------------------------------------------------------- 内核：无预设

test('L1. 档位不再预设任何行为上限：生效值全为 0（不限制）；默认面 = thinkflow 对齐层且无 maxSteps', () => {
  for (const tier of TIER_SPECS) {
    assert.deepEqual(
      { steps: tier.values.maxSteps, input: tier.values.maxInputTokens, peek: tier.values.peekBudgetChars, keep: tier.values.keepRecent },
      { steps: 0, input: 0, peek: 0, keep: 0 },
      `${tier.id} 不得携带预设上限`,
    );
  }
  const catalog = publicTierCatalog();
  assert.ok(catalog.every((t) => t.unset === true));
  // 参考档位移除；唯一内置数值面 = thinkflow 对齐层（xuxiang-thinkflow 出厂预设映射），
  // 且刻意不含 maxSteps——轮数上限一律不预设；传输五键 = thinkflow wire 出厂值。
  assert.deepEqual(THINKFLOW_ALIGNED_LIMITS, {
    keepRecent: 30,
    maxSummaryChars: 16_000,
    maxReadChars: 200_000,
    maxReentries: 8,
    maxTokens: 0,
    thinkingBudget: 0,
    streamUsage: 0,
    maxRetries: 2,
    retryBackoffMs: 1_000,
  });
  assert.equal('maxSteps' in THINKFLOW_ALIGNED_LIMITS, false, '轮数上限不得出现在默认层');
});

test('L2. 未定义 = 不限制（limitOf 返回 0）；显式 0 也是 0', () => {
  assert.equal(limitOf({}, 'maxSteps'), 0);
  assert.equal(limitOf(undefined, 'maxSteps'), 0);
  assert.equal(limitOf({ maxSteps: 0 }, 'maxSteps'), 0);
  assert.equal(limitOf({ maxSteps: 40 }, 'maxSteps'), 40);
});

test('L3. 校验：未知键/负数/非整数一律丢弃并告警（不静默）', () => {
  const parsed = sanitizeLimitPatch({ maxSteps: 40, nope: 1, maxInputTokens: -5, keepRecent: 1.5, peekBudgetChars: '8000' }, 'test');
  assert.deepEqual(parsed.values, { maxSteps: 40, peekBudgetChars: 8000 });
  assert.equal(parsed.warnings.length, 3, parsed.warnings.join('|'));
  assert.ok(parsed.warnings.some((w) => w.includes('nope')));
  assert.ok(parsed.warnings.some((w) => w.includes('maxInputTokens')));
  assert.ok(parsed.warnings.some((w) => w.includes('keepRecent')));
});

test('L4. 字符串形态（env/CLI）与别名归一', () => {
  const parsed = sanitizeLimitPatch('maxRequests=32; budgetTokens=60000;maxSubcalls=8', 'env');
  assert.deepEqual(parsed.values, { maxSteps: 32, observeBudgetTokens: 60000, codeMaxSubcalls: 8 });
  const assignments = parseLimitAssignments(['maxSteps=40', 'codeMaxWallMs=600000', 'bad']);
  assert.deepEqual(assignments.patch, { maxSteps: 40, codeMaxWallMs: 600000 });
  assert.equal(assignments.errors.length, 1);
});

test('L5. 合并优先级：后层覆盖前层（含显式 0）', () => {
  const merged = mergeLimits({ maxSteps: 10, keepRecent: 5 }, { maxSteps: 20 }, { maxSteps: 0 });
  assert.deepEqual(merged, { maxSteps: 0, keepRecent: 5 });
});

test('L6. 派生规则只做同一份用户意图的换算：stall 缺省跟 maxReentries；墙钟缺省跟宿主', () => {
  assert.deepEqual(deriveLimits({ maxReentries: 4 }), { maxReentries: 4, stallReentries: 4 });
  assert.deepEqual(deriveLimits({}, 600_000), { codeMaxWallMs: 600_000 });
  // 用户显式值不被宿主默认覆盖
  assert.deepEqual(deriveLimits({ codeMaxWallMs: 10_000 }, 600_000), { codeMaxWallMs: 10_000 });
});

test('L7. 展示：0/未设与单位换算（CLI/控制栏同一投影）', () => {
  assert.equal(formatLimitValue('maxSteps', 0), '不限制');
  assert.equal(formatLimitValue('maxInputTokens', 48_000), '48k');
  assert.equal(formatLimitValue('codeMaxOutputBytes', 256 * 1024), '256KiB');
  assert.equal(formatLimitValue('codeMaxWallMs', 600_000), '600s');
  const line = formatLimitsLine({ maxSteps: 40 });
  assert.ok(line.includes('轮数 40'), line);
  assert.ok(line.includes('未设'), line);
  const catalog = publicLimitCatalog({ maxSteps: 40 });
  assert.equal(catalog.find((c) => c.key === 'maxSteps')!.configured, true);
  assert.equal(catalog.find((c) => c.key === 'maxInputTokens')!.configured, false);
  assert.equal(LIMIT_KEYS.length, catalog.length);
});

// ---------------------------------------------------------------- 落盘与优先级

test('L8. control.json：limits 往返 + 非法值告警 + 旧文件无 limits 时为空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-limits-'));
  try {
    writePersistedControl({ channel: 'standard', tier: 'standard', lang: 'zh', limits: { maxSteps: 40, maxInputTokens: 48_000 } }, dir);
    const raw = JSON.parse(readFileSync(controlFileOf(dir), 'utf8')) as { schema: number; limits: Record<string, number> };
    assert.equal(raw.schema, 5, '0.6.0 正式版 schema 升 5（contextRaw / preset 之后）');
    assert.deepEqual(raw.limits, { maxSteps: 40, maxInputTokens: 48_000 });
    const round = readPersistedControl(dir);
    assert.deepEqual(round.limits, { maxSteps: 40, maxInputTokens: 48_000 });

    // 手改坏值：丢弃 + 告警，不炸装载
    writeFileSync(controlFileOf(dir), JSON.stringify({ schema: 3, channel: 'standard', tier: 'standard', lang: 'zh', limits: { maxSteps: -1, keepRecent: 5 } }), 'utf8');
    const warnings: string[] = [];
    const bad = readPersistedControl(dir, (m) => warnings.push(m));
    assert.deepEqual(bad.limits, { keepRecent: 5 });
    assert.ok(warnings.some((w) => w.includes('maxSteps')), warnings.join('|'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L9. updatePersistedLimits：增量合并、replace 覆盖、保留通道/档位', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-limits2-'));
  try {
    writePersistedControl({ channel: 'code', tier: 'deep', lang: 'en', limits: { maxSteps: 10 } }, dir);
    const merged = updatePersistedLimits({ maxInputTokens: 20_000 }, { stateDir: dir });
    assert.deepEqual(merged.limits, { maxSteps: 10, maxInputTokens: 20_000 });
    const state = readPersistedControl(dir).state;
    assert.equal(state.channel, 'code');
    assert.equal(state.tier, 'deep');
    const replaced = updatePersistedLimits({ keepRecent: 3 }, { stateDir: dir, replace: true });
    assert.deepEqual(replaced.limits, { keepRecent: 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L10. 三层优先级：control.json < env < 装配 config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-limits3-'));
  const previous = process.env.STREAM_AGENT_LIMITS;
  try {
    writePersistedControl({ channel: 'standard', tier: 'standard', lang: 'zh', limits: { maxSteps: 10, keepRecent: 7 } }, dir);
    process.env.STREAM_AGENT_LIMITS = 'maxSteps=20';
    const fileOnly = resolveControlState({}, dir);
    assert.equal(fileOnly.limits?.maxSteps, 20, 'env 覆盖文件');
    assert.equal(fileOnly.limits?.keepRecent, 7, '文件里未被 env 覆盖的键保留');
    assert.equal(fileOnly.limitsSource, 'env');

    const explicit = resolveControlState({ limits: { maxSteps: 30 } }, dir);
    assert.equal(explicit.limits?.maxSteps, 30, '装配显式最高');
    assert.equal(explicit.limitsSource, 'config');
  } finally {
    if (previous === undefined) delete process.env.STREAM_AGENT_LIMITS;
    else process.env.STREAM_AGENT_LIMITS = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 驱动器生效

function streamOf(text: string): AsyncIterable<StreamChunkLike> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'text-delta', index: 0, text } as StreamChunkLike;
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunkLike;
    },
  };
}

function makeDriver(config: Partial<StreamDriverConfig>): { driver: SingleStreamDriver; requests: () => number } {
  let calls = 0;
  const ports: DriverPorts = {
    stream: () => {
      calls += 1;
      return streamOf('继续。\n');
    },
    executeTools: async () => ({ results: [] }),
  };
  const driver = new SingleStreamDriver(ports, { provider: 'mock', model: 'mock-limits', ...config });
  return { driver, requests: () => calls };
}

test('L11. 默认不设轮数上限：反复无产出也不会被 maxSteps 截断（仅零产出护栏兜底）', async () => {
  const { driver, requests } = makeDriver({ requireFinal: true });
  driver.pushUserTask('不设上限的探测。');
  const reason = await driver.runTurn();
  // 未设 maxSteps → 不会出现 "请求数已达上限"；收束来自零产出护栏
  assert.notEqual(reason.kind, 'completed');
  assert.ok(requests() >= 2, `应至少 nudge 一次，实际 ${requests()}`);
  assert.ok(!JSON.stringify(reason).includes('maxSteps'), JSON.stringify(reason));
});

test('L12. 用户定义 maxSteps 后即生效（通道维度覆盖全局）', async () => {
  const global = makeDriver({ requireFinal: true, limits: { maxSteps: 2 } });
  global.driver.pushUserTask('全局 2 步。');
  await global.driver.runTurn();
  assert.equal(global.requests(), 2, '全局 maxSteps=2 → 最多 2 请求');
  assert.equal(global.driver.effectiveLimits().maxSteps, 2);

  // 通道层覆盖全局：全局 1 步会被标准通道的 3 步覆盖（值先落到 cfg，再受零产出护栏约束）
  const byChannel = makeDriver({ requireFinal: true, limits: { maxSteps: 1 }, limitsByChannel: { standard: { maxSteps: 3 } } });
  byChannel.driver.pushUserTask('标准通道 3 步。');
  assert.equal(byChannel.driver.effectiveLimits().maxSteps, 3, '通道层覆盖全局');
  await byChannel.driver.runTurn();
  assert.ok(byChannel.requests() > 1, `通道层放宽后不应只有 1 请求，实际 ${byChannel.requests()}`);

  // 反向：全局 5 步、标准通道收紧到 1 步 → 只 1 请求
  const tightened = makeDriver({ requireFinal: true, limits: { maxSteps: 5 }, limitsByChannel: { standard: { maxSteps: 1 } } });
  tightened.driver.pushUserTask('标准通道 1 步。');
  await tightened.driver.runTurn();
  assert.equal(tightened.requests(), 1, '通道层收紧到 1 → 1 请求');
});

test('L13. 运行期 setLimits：允许放宽（不再有"装配上限"拒绝），0 = 不限制', () => {
  const { driver } = makeDriver({});
  assert.equal(driver.setLimits({ maxSteps: 80 }).ok, true);
  assert.equal(driver.effectiveLimits().maxSteps, 80);
  assert.equal(driver.setLimits({ maxSteps: 0 }).ok, true);
  assert.equal(driver.effectiveLimits().maxSteps, 0);
  // 非法键：不静默——返回 ignored，值不变
  const rejected = driver.setLimits({ bogus: 5 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ignored.length, 1);
  assert.equal(driver.effectiveLimits().maxSteps, 0);
});

test('L14. 运行期状态面暴露用户上限（控制页/CLI 同源）', () => {
  const { driver } = makeDriver({ limits: { maxSteps: 12, peekBudgetChars: 5000 } });
  const status = driver.runtimeStatus();
  assert.equal(status.limits.maxSteps, 12);
  assert.equal(status.limits.peekBudgetChars, 5000);
  assert.equal(status.effective.maxInputTokens, 0, '未设上下文上限 = 不限制');
});
