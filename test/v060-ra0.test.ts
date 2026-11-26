// test/v060-ra0.test.ts —— RA-0 六项探针产物（计划 §2.4 门禁）
//
// 门禁：6 项全部有结论；unknown ≤1；不支持项写入 docs/limitations.md（文档检查在
// scripts/check-consistency 之外由本用例显式断言，避免"写了结论没归档"）。
// 结论作用域固定 plugin-seam，宿主侧 hostVerification 必须为 pending（不许冒充真机验证）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assemblyRoute, renderRa0Summary, runRa0Probes, writeRa0Artifacts } from '../src/entry/ra0-probe.ts';

test('RA0-1. 六项探针都有结论；unknown ≤1；每项带证据（文件:行）与 3 个请求快照', async () => {
  const results = await runRa0Probes();
  assert.equal(results.length, 6, '6 项探针必须全部产出结论');
  assert.deepEqual(results.map((r) => r.id), ['U1', 'U2', 'U3', 'U4', 'U5', 'U6']);
  const unknown = results.filter((r) => r.verdict === 'unknown');
  assert.ok(unknown.length <= 1, `unknown 必须 ≤1（实际 ${unknown.length}：${unknown.map((r) => r.id).join(',')}）`);
  for (const r of results) {
    assert.ok(['supported', 'unsupported', 'unknown'].includes(r.verdict), `${r.id}: 结论只允许三种`);
    assert.equal(r.scope, 'plugin-seam', `${r.id}: 作用域必须如实标注`);
    assert.equal(r.hostVerification, 'pending', `${r.id}: 宿主侧确认一律 pending（离线不冒充真机）`);
    assert.ok(r.evidence.length > 0, `${r.id}: 必须附证据`);
    for (const e of r.evidence) {
      // 证据必须真实定位到行（不接受"只有文件名"的软证据）
      const [, file, line] = /^(.+\.ts):(\d+)$/.exec(e.at) ?? [];
      assert.ok(file !== undefined && Number(line) > 0, `${r.id}: 证据必须可定位（file.ts:line），实际 ${e.at}`);
      assert.ok(e.quote.length > 0, `${r.id}: 证据必须带原文行`);
    }
    assert.equal(r.requests.length, 3, `${r.id}: 必须跑 3 个连续请求`);
  }
});

test('RA0-2. 决策树：U5 不支持 → 不做历史改写路线；产物 7 个文件（6 JSON + summary）', async () => {
  const results = await runRa0Probes();
  const route = assemblyRoute(results);
  const u5 = results.find((r) => r.id === 'U5')!;
  assert.equal(u5.verdict, 'unsupported', '本插件契约没有 surfaceOp：U5 必须判 unsupported');
  assert.equal(route.route, 'system-tools-only', `路线必须是 system/tools 投影（实际 ${route.route}）`);
  assert.ok(route.detail.includes('append-only'), '路线说明必须写清 messages 保持 append-only');

  const dir = mkdtempSync(join(tmpdir(), 'tf-ra0-'));
  try {
    const files = writeRa0Artifacts(dir, results);
    assert.equal(files.length, 7, '产物 = U1..U6 + summary.md');
    const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
    assert.ok(summary.includes('unknown=1'), 'summary 必须写明 unknown 计数（门禁判据）');
    assert.ok(summary.includes('hostVerification=pending'), 'summary 必须写明宿主侧未验证');
    for (const id of ['U1', 'U2', 'U3', 'U4', 'U5', 'U6']) {
      assert.ok(summary.includes(`| ${id} |`), `summary 缺 ${id} 行`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('RA0-3. 不支持项已归档到 docs/limitations.md（结论与文档一致，不各说各话）', async () => {
  const results = await runRa0Probes();
  const limitations = readFileSync(join(process.cwd(), 'docs', 'limitations.md'), 'utf8');
  const unsupported = results.filter((r) => r.verdict === 'unsupported').map((r) => r.id);
  for (const id of unsupported) {
    assert.ok(limitations.includes(`${id}`), `docs/limitations.md 必须登记 ${id} 的不支持结论`);
  }
  assert.ok(limitations.includes('RA-0'), 'docs/limitations.md 必须有 RA-0 段落');
});

test('RA0-4. summary 渲染确定性：同一批结论渲染两次逐字节一致（产物可复算）', async () => {
  const results = await runRa0Probes();
  const a = renderRa0Summary(results);
  const b = renderRa0Summary(results);
  assert.equal(a, b);
  assert.ok(a.startsWith('# RA-0 宿主装配接缝探针'));
});
