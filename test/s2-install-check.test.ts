// test/s2-install-check.test.ts —— S2 安装前置校验（误装 100% 被拒；dry-run 可读）
//
// 直接跑 scripts/install-check.mjs（子进程，退出码判定）：
//   - web / desktop / headless（既有 profile）一律拒绝（exit 2）
//   - stream / stream-headless 允许（exit 0）且 dry-run 打印装配面
//   - 无 --profile = 用法错误（exit 3）
// 只读检查：脚本本身不做任何写操作（S2 红线：校验发生在写入之前）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const script = join(import.meta.dirname, '..', 'scripts', 'install-check.mjs');

function run(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('S2：安装前置校验', () => {
  it('V7. 既有 profile（web/desktop/headless）100% 被拒，拒绝信息含目标 profile 与允许列表', () => {
    for (const profile of ['web', 'desktop', 'headless']) {
      const r = run(['--profile', profile]);
      assert.equal(r.code, 2, `profile=${profile} 必须拒绝`);
      assert.ok(r.out.includes(`"${profile}"`), `拒绝信息应含目标 profile 名：${r.out.slice(0, 200)}`);
      assert.ok(r.out.includes('stream'), '拒绝信息应给出允许列表');
    }
  });

  it('V7b. 专用 profile 允许且 dry-run 可读（目标/patch/entry）', () => {
    const r = run(['--profile', 'stream', '--dry-run']);
    assert.equal(r.code, 0);
    assert.ok(r.out.includes('stream'), '目标 profile 应打印');
    assert.ok(r.out.includes('cordis.patch.yml'), '应列出将应用的 patch');
    assert.ok(r.out.includes('stream-agent'), '应列出受影响 entry');
    const r2 = run(['--profile', 'stream-headless', '--dry-run']);
    assert.equal(r2.code, 0);
    assert.ok(r2.out.includes('不引入 preset'), 'headless 变体应说明不引入 preset');
  });

  it('V7c. 无 --profile = 用法错误（exit 3）', () => {
    const r = run([]);
    assert.equal(r.code, 3);
  });
});
