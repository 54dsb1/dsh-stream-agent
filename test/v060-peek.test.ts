// test/v060-peek.test.ts —— 0.6.0 TF-PEEK 四项（计划 §3：PE-1 命中率 / PE-2 锚点密度 /
// PE-3 过期识别 / PE-4 预算文案），全部离线可判。
//
// 断言对着**可观测面**：命令输出文本、request 记录、wire 消息；不看驱动器私有字段。
// 20 个大文件用例的目标行段命中率 ≥80%（PE-1）、改文件后 peek 10/10 返回 [stale]（PE-3）、
// 预算拒绝 100% 含剩余额度且 [unchanged] 不增预算（PE-4）、间隔 100 锚点更多且默认不变（PE-2）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SingleStreamDriver, normalizeStreamShim } from '../src/entry/loop.ts';
import type { DriverPorts, StreamChunkLike, StreamDriverConfig, ToolBatchInputLike, ToolBatchResultLike } from '../src/entry/loop.ts';
import { queryCandidates, renderReadIndex } from '../src/kernel/obs.ts';

// ================================================================ 内核：PE-1 / PE-2

function bigFile(lines: number, targetLine: number, needle: string): string {
  const out: string[] = [];
  for (let i = 1; i <= lines; i += 1) {
    if (i === targetLine) {
      // 目标行命中 2 次（定义 + 注释）——排序必须把它排在"只命中 1 次"的干扰行之前
      out.push(`const ${needle} = 'find-me-${i}'; // ${needle}`);
    } else if (i % 97 === 0) {
      // 干扰行：提到同一查询词但只命中 1 次（考察"按命中数排序"，不是"按出现顺序"）
      out.push(`const decoy${i} = 0; // mention ${needle} only once`);
    } else {
      out.push(`const row${i} = ${i}; // filler line ${i}`);
    }
  }
  return out.join('\n');
}

test('PE-1a. 20 个大文件：未命中时首条候选即目标行段的命中率 ≥80%，且整条 ≤2000 字符', () => {
  let hits = 0;
  const total = 20;
  for (let n = 0; n < total; n += 1) {
    const target = 137 + n * 53;
    const needle = `targetSymbol${n}`;
    const content = bigFile(1200, target, needle);
    const candidates = queryCandidates(content, needle, { limit: 3, maxChars: 2000 });
    assert.equal(candidates.length, 3, `用例 ${n}: 未命中必须给满 3 条候选`);
    const joined = candidates.map((c) => `L${c.line} ${c.text}`).join('\n');
    assert.ok(joined.length <= 2000, `用例 ${n}: 候选总长 ≤2000（实际 ${joined.length}）`);
    if (candidates[0]!.line === target) hits += 1;
  }
  assert.ok(hits / total >= 0.8, `首次命中目标行段 ${hits}/${total} 必须 ≥80%`);
});

test('PE-1b. 零命中也必须有候选（不返回空），并如实标注"无查询词命中"', () => {
  const content = ['alpha', 'beta', 'gamma', 'delta'].join('\n');
  const candidates = queryCandidates(content, 'zzz-not-present', { limit: 3 });
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every((c) => c.score === 0));
});

test('PE-2. 锚点间隔 100 → 锚点更多；索引硬上限 2000 字符；未设时与默认 200 逐字节一致', () => {
  const lines: string[] = [];
  for (let i = 1; i <= 1000; i += 1) lines.push(i % 50 === 0 ? `function fn${i}() {` : `  // line ${i}`);
  const content = lines.join('\n');
  const at200 = renderReadIndex(content, { anchorEvery: 200 });
  const at100 = renderReadIndex(content, { anchorEvery: 100 });
  const dflt = renderReadIndex(content);
  const countAnchors = (text: string): number => text.split('\n').filter((l) => /^\s{2}L\d+ /.test(l)).length;
  assert.ok(countAnchors(at100) > countAnchors(at200), '间隔 100 的锚点数必须多于 200');
  assert.equal(dflt, at200, '未显式设置 = 200（默认行为逐字节不变）');
  assert.ok(at100.length <= 2000, `索引 ≤2000 字符（实际 ${at100.length}）`);
});

// ================================================================ 驱动器：PE-3 / PE-4

type Chunk = StreamChunkLike;

async function* scripted(chunks: readonly Chunk[]): AsyncGenerator<Chunk, void, undefined> {
  for (const c of chunks) yield c;
}

const text = (t: string): Chunk => ({ type: 'text-delta', index: 1, text: t }) as Chunk;
const stop = (): Chunk => ({ type: 'finish', reason: { kind: 'stop' } }) as Chunk;

interface Harness {
  driver: SingleStreamDriver;
  outputs: string[];
  /** 每个请求的正文快照（peek 结果注入下一请求，故可观测面在 prompts 里） */
  prompts: string[];
  root: string;
  cleanup: () => void;
}

/** 真实文件系统执行器：tf-read 直接读盘（PE-3 需要真实 mtime/size）。
 *  onToolSettled：工具落定后的确定性钩子（PE-3 用它"读完之后再改文件"，不靠时序猜）。 */
function makeFsHarness(
  responses: ReadonlyArray<readonly Chunk[]>,
  config: Partial<StreamDriverConfig> = {},
  onToolSettled?: () => void,
  rootDir?: string,
): Harness {
  const root = rootDir ?? mkdtempSync(join(tmpdir(), 'tf-peek-'));
  const outputs: string[] = [];
  const prompts: string[] = [];
  let call = 0;
  const ports: DriverPorts = {
    stream: (options) => {
      prompts.push(options.messages.map((m) => m.content.map((b) => b.text ?? '').join('')).join('\n'));
      const chunks = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return normalizeStreamShim(scripted(chunks) as never) as AsyncIterable<Chunk>;
    },
    executeTools: async (input: ToolBatchInputLike): Promise<ToolBatchResultLike> => {
      const results = [];
      for (const c of input.calls) {
        const args = JSON.parse(c.arguments || '{}') as { path?: string; file_path?: string; offset?: number; limit?: number };
        let body = '';
        try {
          const full = join(root, args.path ?? args.file_path ?? '');
          const content = readFileSync(full, 'utf8');
          const lines = content.split('\n');
          const start = args.offset === undefined ? 1 : Math.max(1, args.offset);
          const end = args.limit === undefined ? lines.length : Math.min(lines.length, start + args.limit - 1);
          body = lines.slice(start - 1, end).join('\n');
        } catch (error) {
          results.push({ callId: c.id, result: { content: [{ type: 'text', text: `ENOENT ${String(error)}` }], isError: true } });
          continue;
        }
        outputs.push(body);
        results.push({ callId: c.id, result: { content: [{ type: 'text', text: body }], isError: false } });
      }
      return { results };
    },
    ...(onToolSettled === undefined ? {} : { onToolSettled }),
    events: {
      turnStart: () => {}, stepStart: () => {}, stepEnd: () => {}, turnEnd: () => {},
      assistantMessage: () => ({ eventType: 'assistant/message', seq: 0 }),
      toolLog: () => undefined,
      finalAnswer: () => {},
    },
  };
  const driver = new SingleStreamDriver(ports, {
    provider: 'mock',
    model: 'mock-v060-peek',
    projectDir: root,
    requireFinal: true,
    ...config,
  });
  // rootDir 由调用方持有（多轮共用）时不在 harness 内清理——否则第二轮会写进已删除的目录。
  return { driver, outputs, prompts, root, cleanup: () => { if (rootDir === undefined) rmSync(root, { recursive: true, force: true }); } };
}

/** tf-peek 的 detail 序列（只取终态 ok 记录；dispatched/中间态不算一次取回）。 */
const peekDetails = (h: Harness): string[] => {
  const records = h.driver.snapshot().records as Array<{ kind: string; name?: string; status?: string; detail?: string }>;
  return records
    .filter((r) => r.kind === 'command' && r.name === 'tf-peek' && r.status === 'ok')
    .map((r) => r.detail ?? '');
};

/** 句柄命名 = obs:read:<命令 id>@v1（观测登记以命令 id 为 key，v0.4.x 起稳定）。 */
const readHandle = (id: string): string => `obs:read:${id}@v1`;

test('PE-3a. 改文件后 peek 10/10 返回 [stale]（含新 mtime/size + 重读建议），旧文不冒充当前内容', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tf-peek-stale-'));
  try {
    for (let n = 0; n < 10; n += 1) {
      const name = `f${n}.txt`;
      writeFileSync(join(root, name), `line1-${n}\nline2\nline3\n`, 'utf8');
      let mutated = false;
      const h = makeFsHarness([
        [text(`读 ${name}。\n`), text(`<tf-read path="${name}" id="r1"/>\n`), stop()],
        // 流内 peek：驱动在同一回合的下一个请求前派发
        [text('再看一次。\n'), text(`<tf-peek handle="${readHandle('r1')}" from_line="1" to_line="3" id="p1"/>\n`), stop()],
        [text('收尾。\n'), text('<tf-final id="f1" summary="已核对文件内容与取回结果，行数与示例一致，无未完成项。"/>\n'), stop()],
      ], { projectDir: root, readFeedbackLimit: 10 }, () => {
        // 读已落定 → 确定性改文件（不是靠 sleep/时序猜）
        if (!mutated) {
          mutated = true;
          writeFileSync(join(root, name), `line1-${n}-CHANGED\nline2\nline3\nline4\n`, 'utf8');
        }
      }, root);
      try {
        h.driver.pushUserTask(`读 ${name} 并取回。`);
        await h.driver.runTurn();
        const details = peekDetails(h);
        assert.equal(details.length, 1, `用例 ${n}: 恰一次 peek`);
        assert.equal(details[0], 'peek-stale', `用例 ${n}: 必须判 peek-stale（实际：${details[0]}）`);
        const tail = h.prompts.at(-1) ?? '';
        const staleLineText = tail.split('\n').find((l) => l.includes('[stale]')) ?? '';
        assert.ok(staleLineText !== '', `用例 ${n}: 下一请求必须携带 [stale] 一行`);
        assert.ok(/mtime=\d+/.test(staleLineText), `用例 ${n}: 必须带新 mtime`);
        assert.ok(/size=\d+/.test(staleLineText), `用例 ${n}: 必须带新 size`);
        assert.ok(staleLineText.includes('重新 tf-read'), `用例 ${n}: 必须给重读建议`);
        assert.ok(!staleLineText.includes('line2'), `用例 ${n}: [stale] 行不得夹带旧正文`);
      } finally {
        h.cleanup();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PE-3b. 未改文件 10/10 正常取回（不误报 stale）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tf-peek-fresh-'));
  try {
    for (let n = 0; n < 10; n += 1) {
      const name = `g${n}.txt`;
      writeFileSync(join(root, name), `alpha-${n}\n${'beta-'.repeat(40)}\ngamma\n`, 'utf8');
      const h = makeFsHarness([
        [text('读。\n'), text(`<tf-read path="${name}" id="r1"/>\n`), stop()],
        [text('取回。\n'), text(`<tf-peek handle="${readHandle('r1')}" from_line="1" to_line="2" id="p1"/>\n`), stop()],
        [text('收尾。\n'), text('<tf-final id="f1" summary="内容已核对：alpha/beta 两行与示例一致，无未完成项。"/>\n'), stop()],
      ], { projectDir: root, readFeedbackLimit: 10 }, undefined, root);
      try {
        h.driver.pushUserTask(`读 ${name} 并取回。`);
        await h.driver.runTurn();
        const details = peekDetails(h);
        assert.equal(details.length, 1, `用例 ${n}: 恰一次 peek`);
        assert.notEqual(details[0], 'peek-stale', `用例 ${n}: 未改文件不得报 stale`);
        const tail = h.prompts.at(-1) ?? '';
        assert.ok(tail.includes('alpha'), `用例 ${n}: 必须返回正文`);
        assert.ok(!tail.includes('[stale]'), `用例 ${n}: 不得出现 [stale]`);
      } finally {
        h.cleanup();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PE-4a. 预算拒绝文案必含已用/上限/剩余 + 建议窗口（超限 100% 有剩余额度）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tf-peek-budget-'));
  try {
    mkdirSync(root, { recursive: true });
    const big = Array.from({ length: 60 }, (_, i) => `row-${i}-${'x'.repeat(40)}`).join('\n');
    writeFileSync(join(root, 'big.txt'), big, 'utf8');
    const h = makeFsHarness([
      [text('读。\n'), text('<tf-read path="big.txt" id="r1"/>\n'), stop()],
      [text('取回大段。\n'), text('<tf-peek handle="obs:read:r1@v1" from_line="1" to_line="60" id="p1"/>\n'), stop()],
      [text('再取回。\n'), text('<tf-peek handle="obs:read:r1@v1" from_line="1" to_line="60" id="p2"/>\n'), stop()],
      [text('收尾。\n'), text('<tf-final id="f1" summary="取回窗口已核对：预算拒绝文案包含已用与剩余额度，无未完成项。"/>\n'), stop()],
    ], { projectDir: root, peekBudgetChars: 1000, readFeedbackLimit: 10 }, undefined, root);
    try {
      h.driver.pushUserTask('读大文件并连续取回。');
      await h.driver.runTurn();
      const details = peekDetails(h);
      const budgeted = details.filter((d) => d.includes('peek-budget-exhausted'));
      assert.equal(budgeted.length, 2, `两次超限 peek 各自都要被拒（实际 ${budgeted.length}/2）`);
      const all = h.prompts.join('\n');
      for (const line of all.split('\n').filter((l) => l.trimStart().startsWith('[budget]'))) {
        assert.ok(line.includes('已用'), `必须给已用量：${line.slice(0, 120)}`);
        assert.ok(line.includes('上限'), '必须给上限');
        assert.ok(line.includes('剩余'), '必须给剩余额度');
        assert.ok(/窗口/.test(line), '必须给建议窗口');
      }
    } finally {
      h.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PE-4b. [unchanged] 只计命令数：连续两次同区间取回，预算消耗不因第二次而增长', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tf-peek-unchanged-'));
  try {
    // 第一份 600 字符；预算 700 → 首取用掉 600，剩 100；[unchanged]（~40 字符）若计入
    // 则剩 60，第三取（80 字符）会被拒；不计入则剩 100，第三取成功。
    const first = Array.from({ length: 12 }, (_, i) => `a${i}-${'y'.repeat(45)}`).join('\n');
    writeFileSync(join(root, 'one.txt'), first, 'utf8');
    writeFileSync(join(root, 'two.txt'), 'b0-' + 'z'.repeat(75), 'utf8');
    const h = makeFsHarness([
      [text('读两份。\n'), text('<tf-read path="one.txt" id="r1"/>\n'), text('<tf-read path="two.txt" id="r2"/>\n'), stop()],
      [text('首次取回。\n'), text('<tf-peek handle="obs:read:r1@v1" from_line="1" to_line="12" id="p1"/>\n'), stop()],
      [text('再次取回同区间。\n'), text('<tf-peek handle="obs:read:r1@v1" from_line="1" to_line="12" id="p2"/>\n'), stop()],
      [text('取第二份。\n'), text('<tf-peek handle="obs:read:r2@v1" from_line="1" to_line="1" id="p3"/>\n'), stop()],
      [text('收尾。\n'), text('<tf-final id="f1" summary="两份文件均已取回：同区间第二次返回 unchanged，第三取未被预算拒绝，无未完成项。"/>\n'), stop()],
    ], { projectDir: root, peekBudgetChars: 700, readFeedbackLimit: 10 }, undefined, root);
    try {
      h.driver.pushUserTask('读两份并连续取回。');
      await h.driver.runTurn();
      const details = peekDetails(h);
      assert.equal(details.length, 3, `三次 peek 全部有输出（实际 ${details.length}）`);
      assert.ok(details[1]!.includes('span 命中'), `第二次同区间必须是 [unchanged] 形态（实际：${details[1]}）`);
      assert.ok(!details[2]!.includes('peek-budget'), `[unchanged] 不得消耗正文预算（实际：${details[2]}）`);
      const tail = h.prompts.at(-1) ?? '';
      assert.ok(tail.includes('b0-'), '第三取应返回正文');
    } finally {
      h.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PE-1c. 驱动端 query 未命中的整条响应 ≤2000 字符（内核截断 + 驱动端兜底）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tf-peek-miss-'));
  try {
    // 大文件 + 大量干扰行：候选文本要长到必须被截断
    const lines: string[] = [];
    for (let i = 1; i <= 800; i += 1) lines.push(`row-${i} ${'filler-'.repeat(8)}`);
    writeFileSync(join(root, 'big.txt'), lines.join('\n'), 'utf8');
    const h = makeFsHarness([
      [text('读。\n'), text('<tf-read path="big.txt" id="r1"/>\n'), stop()],
      [text('找不存在的词。\n'), text('<tf-peek handle="obs:read:r1@v1" query="not-there-at-all" id="p1"/>\n'), stop()],
      [text('收尾。\n'), text('<tf-final id="f1" summary="未命中已核实并拿到候选行段，无未完成项可用示例结论占位说明。"/>\n'), stop()],
    ], { projectDir: root, readFeedbackLimit: 10 });
    try {
      h.driver.pushUserTask('读文件后找词。');
      await h.driver.runTurn();
      const details = peekDetails(h);
      assert.ok(details[0] === 'query-not-found', `必须走 query-not-found（实际 ${details[0]}）`);
      const missLine = h.prompts.map((p) => p.split('\n').find((l) => l.startsWith('query 未命中'))).filter((x) => x !== undefined)[0];
      assert.ok(missLine !== undefined, '未命中响应必须出现在下一请求里');
      assert.ok(missLine!.length <= 2000, `整条响应必须 ≤2000 字符（实际 ${missLine!.length}）`);
      assert.ok(missLine!.includes('候选行段'), '必须给出候选行段');
    } finally {
      h.cleanup();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
