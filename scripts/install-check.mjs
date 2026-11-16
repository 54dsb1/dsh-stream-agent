// scripts/install-check.mjs —— S2 安装前置校验：本插件只允许装进专用 profile（stream 及其入口变体）
//
// 用法：
//   node scripts/install-check.mjs --profile <名字|目录> [--dry-run] [--plugin-root <目录>]
//
// 行为：
//   · 校验发生在"写入之前"的语义：只读检查，不做任何写操作；拒绝时给出台 unacceptable 原因，
//     不提供"强制安装"开关（计划硬约束）。
//   · --dry-run 打印：目标 profile、将写入的组合包（dependencies）、将应用的 patch（主 bundle +
//     preset bundle + profile patch）、预计影响的 entry。
//   · 允许列表：stream、stream-headless（计划内 profile 名及其入口变体）。其余（web / desktop /
//     headless 等既有 profile）一律拒绝并说明原因——A-1 的隔离来自"专用 profile 只装这一套"。
//
// 退出码：0 = 允许；2 = 拒绝；3 = 用法错误。

import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(scriptDir, '..');

const ALLOWED_PROFILES = new Set(['stream', 'stream-headless']);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function fail(code, lines) {
  for (const line of lines) console.error(line);
  process.exit(code);
}

const pluginRootArg = arg('plugin-root');
const pluginRoot = pluginRootArg !== undefined ? resolve(pluginRootArg) : pkgRoot;
const profileArg = arg('profile');
if (profileArg === undefined) {
  fail(3, ['用法：node scripts/install-check.mjs --profile <名字|目录> [--dry-run] [--plugin-root <目录>]']);
}

// 目标 profile：名字或目录（含 package.json 的 profile 目录）
let profileName;
let profileDir = null;
if (isAbsolute(profileArg) || profileArg.includes('/') || profileArg.includes('\\')) {
  profileDir = resolve(profileArg);
  const pkgPath = join(profileDir, 'package.json');
  if (!existsSync(pkgPath)) {
    fail(2, [`[install-check] 拒绝：目标目录不是 dsh profile（缺 package.json）：${profileDir}`]);
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    profileName = basename(profileDir);
    void pkg;
  } catch (error) {
    fail(2, [`[install-check] 拒绝：profile package.json 解析失败：${error instanceof Error ? error.message : String(error)}`]);
  }
} else {
  profileName = profileArg;
}

const dryRun = flag('dry-run');
const lines = [];
lines.push(`[install-check] 目标 profile：${profileName}${profileDir !== null ? `（${profileDir}）` : ''}`);

// 1. 允许列表（唯一判定来源；不自动改写用户 profile、不静默覆盖）
if (!ALLOWED_PROFILES.has(profileName)) {
  fail(2, [
    ...lines,
    `[install-check] 拒绝：profile "${profileName}" 不是本插件的专用 profile。`,
    `[install-check] 允许列表：${[...ALLOWED_PROFILES].join('、')}（S2：误装到 web/desktop 等既有 profile 会全局接管其 loop，一律拒绝）。`,
    `[install-check] 处置：用 profiles/stream（web 入口）或 profiles/stream-headless（headless 入口）模板创建专用 profile 后再安装。`,
  ]);
}

// 2. 主 bundle 与 preset bundle 的 patch 在位（ dry-run 打印装配面）
const mainPatch = join(pluginRoot, 'cordis.patch.yml');
const presetPatch = join(pluginRoot, 'preset', 'stream', 'cordis.patch.yml');
if (!existsSync(mainPatch)) {
  fail(2, [...lines, `[install-check] 拒绝：主 bundle patch 缺失：${mainPatch}`]);
}
const pluginPkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
const presetPkg = existsSync(join(pluginRoot, 'preset', 'stream', 'package.json'))
  ? JSON.parse(readFileSync(join(pluginRoot, 'preset', 'stream', 'package.json'), 'utf8'))
  : null;

lines.push(`[install-check] 主 bundle：${pluginPkg.name}@${pluginPkg.version}（patch：cordis.patch.yml）`);
if (profileName === 'stream' && presetPkg !== null) {
  lines.push(`[install-check] preset bundle：${presetPkg.name}（patch：preset/stream/cordis.patch.yml，列在主 bundle 之后）`);
}
if (profileName === 'stream-headless') {
  lines.push('[install-check] headless 入口：不引入 preset bundle（宿主无 registry；工具面由 profile 决定）');
}

if (profileDir !== null) {
  const profilePkgPath = join(profileDir, 'package.json');
  const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'));
  const deps = profilePkg.dependencies ?? {};
  const entryCounts = {
    mainPatchEntries: (readFileSync(mainPatch, 'utf8').match(/- id: stream-agent/g) ?? []).length,
    loopDisabled: readFileSync(mainPatch, 'utf8').includes('agent-loop'),
  };
  lines.push(`[install-check] profile bundles：${JSON.stringify(profilePkg.dsh?.profile?.bundles ?? [])}`);
  lines.push(`[install-check] 现有 dependencies：${JSON.stringify(deps)}`);
  lines.push(`[install-check] 将应用的 patch：主 bundle（停用 agent-loop + 7 entry，loop 最后）${profileName === 'stream' ? ' + preset-stream（工具面）' : ''} + profile patch（registry default 覆盖）`);
  lines.push(`[install-check] 预计影响 entry：stream-agent-state / obs-broker / action-gate / context-render / control-bar / ui / stream-agent(loop)`);
  lines.push(`[install-check] patch 健康检查：agent-loop 停用行在主 bundle patch = ${entryCounts.loopDisabled ? '是（卸载原子性保持，C4）' : '否（缺陷）'}`);
}

lines.push('[install-check] 结论：允许（专用 profile 校验通过；未写入任何东西——实际安装由 dsh plugin add / profile 组合完成）。');
for (const line of lines) console.log(line);
