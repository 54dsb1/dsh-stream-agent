// test/v060-fixes.test.ts —— 0.6.0 复查轮（收口维护）修复的回归用例。
//
// 覆盖（对应 CHANGELOG 0.6.0 Fixed / 收口维护条目）：
//   R1 预设 replace 语义对当前会话生效（global 层用户部分清除、装配层保留）
//   R2 CLI 手工改上限清除预设标记（与 presets.ts 契约、进程内路径一致）
//   R3 tf-changes path 过滤：projectDir ≠ cwd 时相对路径两侧同基准（此前恒空目录）
//   R4 loadChangeReceipts：畸形回执逐条拒绝，不中止整批加载
//
// 端到端链路复用 v060-changes.test.ts 的真实 fs 工具管线（write/edit/read）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, normalizeStreamShim } from '../src/entry/loop.ts';
import type { DriverPorts, StreamChunkLike, StreamDriverConfig, ToolBatchInputLike, ToolBatchResultLike } from '../src/entry/loop.ts';
import { controlFileOf, readPersistedControl, updatePersistedLimits, writePersistedControl } from '../src/entry/control-state.ts';

// ================================================================ 设施

type Chunk = StreamChunkLike;
async function* scripted(chunks: readonly Chunk[]): AsyncGenerator<Chunk, void, undefined> {
  for (const c of chunks) yield c;
}
const text = (t: string): Chunk => ({ type: 'text-delta', index: 1, text: t }) as Chunk;
const stop = (): Chunk => ({ type: 'finish', reason: { kind: 'stop' } }) as Chunk;
const finalStep = (n: number): readonly Chunk[] => [text(`<tf-final id="f${n}" summary="完成"/>\n`), stop()];

function makeHarness(
  responses: ReadonlyArray<readonly Chunk[]>,
  config: Partial<StreamDriverConfig> = {},
): { driver: SingleStreamDriver; prompts: string[]; root: string; outputs: () => Array<{ name?: string; status?: string; output?: string }>; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'tf-v060-fix-'));
  const prompts: string[] = [];
  let call = 0;
  const ports: DriverPorts = {
    stream: (options) => {
      prompts.push(options.messages.map((m) => m.content.map((b) => b.text ?? '').join('')).join('\n'));
      const chunks = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return normalizeStreamShim(scripted(chunks) as never) as AsyncIterable<Chunk>;
    },
    executeTools: async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => ({
      results: input.calls.map((c) => {
        const args = JSON.parse(c.arguments) as Record<string, unknown>;
        const file = join(root, String(args['file_path'] ?? ''));
        try {
          if (c.name === 'write') {
            writeFileSync(file, String(args['content'] ?? ''), 'utf8');
            return { callId: c.id, result: { content: [{ type: 'text', text: `Created ${args['file_path']}` }], isError: false } };
          }
          if (c.name === 'read') {
            return { callId: c.id, result: { content: [{ type: 'text', text: readFileSync(file, 'utf8') }], isError: false } };
          }
        } catch (error) {
          return { callId: c.id, result: { content: [{ type: 'text', text: String(error) }], isError: true } };
        }
        return { callId: c.id, result: { content: [{ type: 'text', text: `ok:${c.name}` }], isError: false } };
      }),
    }),
  };
  const driver = new SingleStreamDriver(ports, { provider: 'mock', model: 'mock', projectDir: root, requireFinal: true, ...config });
  return {
    driver, prompts, root,
    outputs: () => {
      const recs = driver.snapshot().records as Array<{ kind?: string; id?: string; name?: string; status?: string; output?: string }>;
      const byId = new Map<string, { name?: string; status?: string; output?: string }>();
      for (const r of recs) {
        if (r.kind === 'command' && typeof r.id === 'string') byId.set(r.id, r);
      }
      return [...byId.values()];
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ================================================================ R1：预设 replace 语义（当前会话生效）

test('R1-1. setLimits(replace) 清除 global 层的用户部分：空补丁后旧上限不再生效', () => {
  const h = makeHarness([finalStep(0)], { limits: { maxSteps: 40, maxInputTokens: 48000 } });
  try {
    assert.equal(h.driver.runtimeStatus().effective.maxSteps, 40, '构造期 global 层生效');
    const result = h.driver.setLimits({}, { replace: true });
    assert.equal(result.ok, true);
    assert.equal(h.driver.runtimeStatus().effective.maxSteps, 0, 'replace 后旧 maxSteps 不得残留（raw/unlimited 预设场景）');
    assert.equal(h.driver.runtimeStatus().effective.maxInputTokens, 0, 'replace 后旧 maxInputTokens 不得残留');
  } finally {
    h.cleanup();
  }
});

test('R1-2. setLimits(replace) 保留装配层：assemblyLimits 传入时只清用户层', () => {
  const h = makeHarness([finalStep(0)], {
    limits: { maxSteps: 40, maxInputTokens: 48000, peekBudgetChars: 900 },
    assemblyLimits: { maxSteps: 5, peekBudgetChars: 300 },
  });
  try {
    h.driver.setLimits({}, { replace: true });
    const snap = h.driver.runtimeStatus().effective;
    assert.equal(snap.maxSteps, 5, '装配层 maxSteps 保留（装配 > 面板的层级不因预设破坏）');
    assert.equal(h.driver.limitsSnapshot().peekBudgetChars, 300, '装配层 peekBudgetChars 保留');
    assert.equal(snap.maxInputTokens, 0, '用户层 maxInputTokens 被清空');
  } finally {
    h.cleanup();
  }
});

test('R1-3. replace 之后的增量 setLimits 落在 session 层，与装配层正常合并', () => {
  const h = makeHarness([finalStep(0)], {
    limits: { maxSteps: 40 },
    assemblyLimits: { maxSteps: 5 },
  });
  try {
    h.driver.setLimits({}, { replace: true });
    assert.equal(h.driver.runtimeStatus().effective.maxSteps, 5);
    h.driver.setLimits({ maxInputTokens: 12000 });
    const snap = h.driver.runtimeStatus().effective;
    assert.equal(snap.maxSteps, 5, '增量不清装配层');
    assert.equal(snap.maxInputTokens, 12000, '增量生效');
  } finally {
    h.cleanup();
  }
});

// ================================================================ R2：旧预设标记的迁移（0.6.1 行为预设已移除）

test('R2-1. 旧 control.json 的 preset 标记：告警 + 忽略；limits --set 照常合并', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-v060-fix2-'));
  try {
    const file = controlFileOf(dir);
    writePersistedControl({
      channel: 'standard', tier: 'standard', lang: 'zh',
      limits: { maxSteps: 16 },
    }, dir);
    // 直接写入旧版才有的 preset 字段（0.6.1 起不再产生）
    const raw0 = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    raw0['preset'] = 'light';
    writeFileSync(file, JSON.stringify(raw0, null, 2), 'utf8');

    const warnings: string[] = [];
    const before = readPersistedControl(dir, (m) => warnings.push(m));
    assert.equal((before.state as Record<string, unknown>)['preset'], undefined, '0.6.1：preset 不再进入状态');
    assert.ok(warnings.some((w) => w.includes('preset')), warnings.join('|'));

    updatePersistedLimits({ maxSteps: 10 }, { stateDir: dir });
    const after = readPersistedControl(dir);
    assert.equal((after.state as Record<string, unknown>)['preset'], undefined);
    assert.equal(after.limits.maxSteps, 10, 'limits 本身照常合并');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.equal(raw['preset'], undefined, '下次写入不再携带 preset 字段');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ================================================================ R3：tf-changes path 过滤（fileRoot ≠ cwd）

test('R3-1. tf-changes path= 在 projectDir ≠ cwd 时按相对路径命中回执', async () => {
  // 测试进程 cwd = 仓库根，projectDir = tmpdir——两根不同正是触发条件。
  // 结果正文经 need_result 回灌通道进 prompts（records.output 不存正文），断言对齐 C2-1 范式。
  const h = makeHarness([
    [text('<tf-write path="f.txt" id="w1">v1\n</tf-write>\n'), stop()],
    [text('<tf-changes id="ch1" path="f.txt" depends_on="w1"/>\n'), stop()],
    [text('<tf-changes id="ch2" path="other.txt" depends_on="ch1"/>\n'), stop()],
    finalStep(1),
  ]);
  try {
    h.driver.pushUserTask('写文件并查询回执');
    await h.driver.runTurn();
    const changesAll = h.outputs().filter((r) => r.name === 'tf-changes');
    assert.equal(changesAll.length, 2, '两次 tf-changes 都有输出');
    const joined = h.prompts.join('\n');
    assert.ok(/ write f\.txt status=success/.test(joined),
      'path=f.txt 必须命中回执行（此前过滤左侧相对路径被 resolve 到 cwd 基准，恒返回空目录）');
    assert.ok(joined.includes('本会话没有变更回执'),
      'path=other.txt 无回执 → 空目录文案（过滤本身仍然生效，不是不过滤）');
  } finally {
    h.cleanup();
  }
});

// ================================================================ R4：畸形回执逐条拒绝

test('R4-1. loadChangeReceipts：一个形状不全的回执不中止整批（坏条 rejected，好条 loaded）', () => {
  const h = makeHarness([finalStep(0)]);
  try {
    const good = {
      version: 1, id: 'a'.repeat(32), workspace: h.root, path: 'f.txt', operation: 'write' as const,
      commandId: 'w1', status: 'success' as const, createdAt: 0, completedAt: 1,
      beforeHash: 'missing', afterHash: 'deadbeef', beforeBytes: 0, afterBytes: 4,
      unavailableReason: '', undoOf: '',
    };
    // 畸形：workspace 为数字（samePath 会抛 TypeError）；snapshots 为数字（verifySnapshots 会抛）。
    const malformed1 = { ...good, id: 'b'.repeat(32), workspace: 12345 } as unknown as typeof good;
    const malformed2 = { ...good, id: 'c'.repeat(32), snapshots: 42 } as unknown as typeof good;
    const result = h.driver.loadChangeReceipts([good, malformed1, malformed2, good]);
    assert.equal(result.loaded, 2, '两条好回执都加载（此前第 2 条抛错中止整批）');
    assert.equal(result.rejected, 2, '两条畸形回执逐条拒绝');
  } finally {
    h.cleanup();
  }
});
