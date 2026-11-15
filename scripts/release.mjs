#!/usr/bin/env node
/**
 * 一键发布：构建 → 测试 → 版本 → GitHub（commit/tag/Release）→ npm。
 *
 *   node scripts/release.mjs                  # 版本已手动改过就沿用，否则 patch+1
 *   node scripts/release.mjs --minor          # 需要新特性时
 *   node scripts/release.mjs --set 0.2.0-rc.1 # 显式指定（预发布自动发 alpha dist-tag）
 *   node scripts/release.mjs --dry-run        # 只演练，不提交不推送不发布
 *
 * 常用开关：--no-npm  --no-github  --skip-tests  --message "..."  --yes  --force-tag
 *
 * 设计约束（踩过的坑，别改）：
 * - 版本沿用规则：package.json 的 version 比最近 tag 新 → 认为已手动 bump，不再加一。
 * - tag 必须与 package.json 一致，否则中止（CI/Release 链接会错位）。
 * - 构建后校验 dist 与 src 同步：dist 是入库产物且被 patch 直接引用，忘了重建会静默落后。
 * - 任何一步失败立即中止，绝不"继续发布后半段"。
 */
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const NPM = WIN ? 'npm.cmd' : 'npm';
const DRY = has('dry-run');
const YES = has('yes');

/* ── 输出 ─────────────────────────────────────────────── */
const C = process.stdout.isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', d: '', b: '', x: '' };
const step = (n, s) => console.log(`\n${C.b}[${n}]${C.x} ${s}`);
const ok = (s) => console.log(`  ${C.g}✓${C.x} ${s}`);
const warn = (s) => console.log(`  ${C.y}!${C.x} ${s}`);
const info = (s) => console.log(`  ${C.d}${s}${C.x}`);
function die(s, detail) {
  console.error(`\n  ${C.r}✗ ${s}${C.x}`);
  if (detail) console.error(`  ${C.d}${String(detail).trim().split('\n').slice(0, 12).join('\n  ')}${C.x}`);
  process.exit(1);
}

function has(name) {
  return process.argv.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function sh(cmd, argv = [], { inherit = false, input } = {}) {
  return execFileSync(cmd, argv, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    input,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}
/**
 * npm 在 Windows 上是 npm.cmd，execFileSync 直接调会 ENOENT，必须过 shell；
 * 这里参数都是固定标识符（--access public 之类），拼接无注入风险。
 */
function npmRun(argv, { inherit = false, input } = {}) {
  const line = [NPM, ...argv].join(' ');
  return execSync(line, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    input,
    env: { ...process.env, NO_COLOR: '1' },
  });
}
function shOk(cmd, argv = []) {
  try {
    sh(cmd, argv);
    return true;
  } catch {
    return false;
  }
}
const gitOut = (argv) => sh('git', argv).trim();

/* ── 版本工具 ─────────────────────────────────────────── */
const parseVer = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
  if (!m) throw new Error(`版本号不合法：${v}`);
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
};
const fmtVer = (v) => `${v.major}.${v.minor}.${v.patch}${v.pre ? '-' + v.pre : ''}`;
function bump(v, kind) {
  const n = { ...v, pre: '' };
  if (kind === 'major') return { ...n, major: n.major + 1, minor: 0, patch: 0 };
  if (kind === 'minor') return { ...n, minor: n.minor + 1, patch: 0 };
  return { ...n, patch: n.patch + 1 };
}
const cmp = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/* ════════════════════════════════════════════════════════ */
console.log(`${C.b}dsh-stream-agent${C.x} · 一键发布${DRY ? `  ${C.y}(dry-run)${C.x}` : ''}`);
console.log(`${C.d}${ROOT}${C.x}`);

/* ── 0. 前置检查 ──────────────────────────────────────── */
step(0, '前置检查');

if (!shOk('git', ['rev-parse', '--is-inside-work-tree'])) die('当前目录不在 git 仓库内');

const branch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main' && !has('force-branch')) die(`当前分支是 ${branch}，发布只允许在 main（--force-branch 可跳过）`);
ok(`分支 ${branch}`);

if (!shOk('git', ['remote', 'get-url', 'origin'])) die('未配置 origin 远端');
const remote = gitOut(['remote', 'get-url', 'origin']);
ok(`远端 ${remote.replace(/\/\/[^@]*@/, '//***@')}`);

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
ok(`包名 ${pkg.name} · 当前版本 ${pkg.version}`);

const npmUser = (() => {
  try {
    return npmRun(['whoami']).trim();
  } catch {
    return '';
  }
})();
if (!has('no-npm')) {
  if (!npmUser) die('npm 未登录', '先在终端执行：npm login --auth-type=web');
  ok(`npm 已登录：${npmUser}`);
  const scope = pkg.name.startsWith('@') ? pkg.name.split('/')[0].slice(1) : '';
  if (scope && scope !== npmUser) {
    die(
      `包名 scope 是 @${scope}，但当前 npm 账号是 ${npmUser}`,
      'scoped 包只能发到自己的用户名或自己所属的组织下，请改 package.json 的 name',
    );
  }
  if (scope === npmUser) info(`scope @${scope} 与账号一致 ✓`);
}

/* ── 1. 计算目标版本 ──────────────────────────────────── */
step(1, '确定版本');

let lastTag = '';
try {
  lastTag = gitOut(['describe', '--tags', '--abbrev=0', '--match', 'v*']);
} catch {
  warn('仓库还没有任何 v* 标签，视为首次发布');
}
const lastVer = lastTag ? parseVer(lastTag.replace(/^v/, '')) : parseVer('0.0.0');
const curVer = parseVer(pkg.version);
const explicit = opt('set');
const kind = has('major') ? 'major' : has('minor') ? 'minor' : 'patch';

let target;
if (explicit) {
  target = explicit.replace(/^v/, '');
  ok(`显式指定版本 ${target}`);
} else if (has('keep')) {
  target = pkg.version;
  ok(`沿用 package.json 版本 ${target}（--keep）`);
} else if (lastTag && cmp(curVer, lastVer) > 0) {
  target = pkg.version;
  ok(`沿用 package.json 已 bump 的版本 ${target}（上一 tag ${lastTag}）`);
} else {
  target = fmtVer(bump(lastVer, kind));
  ok(`按 ${kind} 递增：${lastTag || '(无)'} → ${target}`);
}
const targetVer = parseVer(target);
const tagName = `v${target}`;

if (existsTag(tagName) && !has('force-tag')) {
  const pointsAt = gitOut(['rev-list', '-n', '1', tagName]);
  const head = gitOut(['rev-parse', 'HEAD']);
  if (pointsAt !== head) die(`标签 ${tagName} 已存在且不指向当前 HEAD`, '确需覆盖请加 --force-tag');
  warn(`标签 ${tagName} 已存在并指向 HEAD，将跳过打标签`);
}

function existsTag(name) {
  return shOk('git', ['rev-parse', '-q', '--verify', `refs/tags/${name}`]);
}

/* ── 2. 构建 + 测试 ───────────────────────────────────── */
if (!has('skip-tests')) {
  step(2, '构建（dist 与 src 必须同步）');
  try {
    npmRun(['run', 'build'], { inherit: true });
  } catch (e) {
    die('构建失败', e.stdout || e.message);
  }
  // 判定方式：连跑两次构建，若 dist 相对 HEAD 的变化集合在第二次仍相同，说明构建幂等、
  // dist 已与 src 对齐。不能用 `git diff --exit-code -- dist` —— 本次要提交的 dist 改动
  // 本来就会显示为 diff，那样会把正常发布误判成"dist 过期"。
  const dirty1 = gitOut(['status', '--porcelain', '--', 'dist']);
  try {
    npmRun(['run', 'build']);
  } catch (e) {
    die('二次构建失败（构建不确定）', e.stdout || e.message);
  }
  const dirty2 = gitOut(['status', '--porcelain', '--', 'dist']);
  if (dirty1 !== dirty2) die('构建结果不稳定：连续两次构建产出不同的 dist');
  if (dirty2) warn('dist 相对 HEAD 有变化，将随本次提交一并入库');
  ok('dist 与 src 同步（构建幂等）');

  step(3, '测试');
  try {
    npmRun(['test'], { inherit: true });
  } catch (e) {
    die('测试未通过，已中止发布', e.stdout || e.message);
  }
} else {
  warn('已跳过构建与测试（--skip-tests）');
}

/* ── 4. 写入版本号 ────────────────────────────────────── */
step(4, `写入版本 ${target}`);
if (pkg.version !== target) {
  if (DRY) {
    warn(`dry-run：本应把 package.json 从 ${pkg.version} 改为 ${target}`);
  } else {
    pkg.version = target;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    ok(`package.json → ${target}`);
  }
} else {
  ok('package.json 已是目标版本');
}

// CHANGELOG 必须有一条对应小节，否则 Release 说明是空的
const changelogPath = path.join(ROOT, 'CHANGELOG.md');
const changelog = readFileSync(changelogPath, 'utf8');
const hasSection = new RegExp(`^## \\[${target.replace(/\./g, '\\.')}\\]`, 'm').test(changelog);
if (!hasSection) {
  warn(`CHANGELOG.md 缺少「## [${target}]」小节——Release 说明将退回 git log`);
}

/* ── 5. 提交 ──────────────────────────────────────────── */
step(5, '提交改动');
const dirty = gitOut(['status', '--porcelain', '--untracked-files=all']) !== '';
let commitMsg = opt('message', '');
if (dirty) {
  const files = gitOut(['status', '--porcelain', '--untracked-files=all'])
    .split('\n')
    .map((l) => l.slice(3))
    .filter(Boolean);
  info(`待提交 ${files.length} 个文件`);
  if (!commitMsg) {
    commitMsg = `chore(release): ${tagName}\n\n${files.slice(0, 20).map((f) => `- ${f}`).join('\n')}${
      files.length > 20 ? `\n- …共 ${files.length} 个` : ''
    }`;
  }
  if (DRY) {
    warn('dry-run：跳过 git add/commit');
  } else {
    sh('git', ['add', '-A']);
    sh('git', ['commit', '-q', '-F', '-'], { input: commitMsg });
    ok(`已提交 ${gitOut(['rev-parse', '--short', 'HEAD'])}`);
  }
} else {
  ok('工作区干净，无需提交');
}

/* ── 6. 打标签 ────────────────────────────────────────── */
step(6, `标签 ${tagName}`);
if (existsTag(tagName)) {
  ok('标签已存在，跳过');
} else if (DRY) {
  warn(`dry-run：本应创建 ${tagName}`);
} else {
  sh('git', ['tag', '-a', tagName, '-m', `${tagName} —— ${pkg.description || pkg.name}`]);
  ok(`已创建注解标签 ${tagName}`);
}

/* ── 7. 推 GitHub ─────────────────────────────────────── */
const ghToken = (() => {
  if (has('no-github')) return '';
  try {
    const out = sh('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' });
    return (/^password=(.+)$/m.exec(out) || [])[1] || '';
  } catch {
    return '';
  }
})();

if (!has('no-github')) {
  step(7, '推送 GitHub');
  if (DRY) {
    warn('dry-run：跳过 git push');
  } else {
    let pushed = false;
    // 先试直连（无代理时更快），失败再走环境代理
    for (const attempt of [1, 2]) {
      try {
        sh('git', ['push', 'origin', branch, '--follow-tags'], { inherit: true, timeout: 180000 });
        pushed = true;
        break;
      } catch {
        if (attempt === 1) warn('推送失败，用环境代理重试…');
      }
    }
    if (!pushed) die('git push 失败（网络/代理问题）', '确认代理可用后重试；本地提交与标签都已就绪');
    ok('main 与标签已推送');

    /* Release */
    if (!ghToken) {
      warn('没拿到 GitHub 凭据，跳过 Release 创建（标签已推，可手动补）');
    } else {
      try {
        const body = renderReleaseBody(target, changelog);
        const res = await fetch(`https://api.github.com/repos/${repoSlug()}/releases`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'dsh-stream-agent-release',
          },
          body: JSON.stringify({
            tag_name: tagName,
            name: `${tagName} —— ${pkg.name.split('/').pop()}`,
            body,
            draft: false,
            prerelease: Boolean(targetVer.pre),
          }),
        });
        const j = await res.json();
        if (j.html_url) ok(`Release：${j.html_url}`);
        else if (String(j.message || '').includes('already_exists')) warn('Release 已存在，跳过');
        else warn(`Release 创建失败：${String(j.message || JSON.stringify(j)).slice(0, 160)}`);
      } catch (e) {
        warn(`Release 创建异常：${e.message}`);
      }
    }
  }
}

/* ── 8. npm 发布 ──────────────────────────────────────── */
if (!has('no-npm')) {
  step(8, `发布 npm ${pkg.name}@${target}`);
  const exists = (() => {
    try {
      return npmRun(['view', `${pkg.name}@${target}`, 'version']).trim() === target;
    } catch {
      return false;
    }
  })();
  if (exists) {
    die(`${pkg.name}@${target} 已存在于 npm`, '版本号必须递增：改 CHANGELOG 后加 --minor 或 --set x.y.z');
  }
  const distTag = targetVer.pre ? 'alpha' : 'latest';
  const pubArgs = ['publish', '--access', 'public', '--tag', distTag];
  if (DRY) {
    warn(`dry-run：本节将执行 npm ${pubArgs.join(' ')}`);
    try {
      npmRun(['pack', '--dry-run'], { inherit: true });
    } catch {
      /* 演练失败不算错 */
    }
  } else {
    try {
      npmRun(pubArgs, { inherit: true });
    } catch (e) {
      die('npm publish 失败', e.stdout || e.message);
    }
    ok(`已发布 ${pkg.name}@${target}（dist-tag: ${distTag}）`);
  }
}

/* ── 收尾 ─────────────────────────────────────────────── */
if (DRY) {
  console.log(`\n${C.y}${C.b}dry-run 结束${C.x}  目标 ${pkg.name}@${target}（未提交、未推送、未发布）`);
  process.exit(0);
}
console.log(`\n${C.g}${C.b}发布完成${C.x}  ${pkg.name}@${target}`);
console.log(`  安装：dsh plugin --profile headless add ${pkg.name}`);
console.log(`  npm ：https://www.npmjs.com/package/${pkg.name}`);
console.log(`  仓库：https://github.com/${repoSlug()}/releases/tag/${tagName}`);

/* ── 辅助 ─────────────────────────────────────────────── */
function repoSlug() {
  const url = gitOut(['remote', 'get-url', 'origin']);
  const m = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : 'unknown/unknown';
}

function renderReleaseBody(version, md) {
  const start = md.indexOf(`## [${version}]`);
  if (start >= 0) {
    const rest = md.slice(start);
    const end = rest.indexOf('\n## [', 1);
    const section = (end > 0 ? rest.slice(0, end) : rest).replace(/^## \[[^\]]+\][^\n]*\n+/, '');
    return `${section.trim()}\n\n---\n\n安装：\`dsh plugin --profile headless add ${pkg.name}\``;
  }
  // 没有 CHANGELOG 条目时退回提交列表
  let log = '';
  try {
    log = gitOut(['log', '--pretty=format:- %s', `${lastTag || ''}..HEAD`]);
  } catch {
    log = '';
  }
  return `${log || '- 见提交历史'}\n\n---\n\n安装：\`dsh plugin --profile headless add ${pkg.name}\``;
}
