// scripts/build.mjs —— 零依赖构建：Node 24 原生 stripTypeScriptTypes → dist/
//
// 宿主 loader 只加载 .js（patches/test-preset.yml 引 ../dist/entry/mock-provider.js 的先例，
// 05 号 results §4），因此 src/*.ts 需要产出 dist/*.js：
//   1. module.stripTypeScriptTypes(code, { mode: 'strip' }) 擦除类型
//      （本包无 enum/namespace/参数属性，strip 模式安全；出现不可擦除语法会快速报错）
//   2. 相对 import/export 的 .ts 后缀重写为 .js（Node ESM 不解析 .ts 说明符）
//   3. 产物导入冒烟：dist/entry/loop.js 与 dist/entry/mock-provider.js 必须可加载
//
// 用法：npm run build

import { stripTypeScriptTypes } from 'node:module';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(pkgRoot, 'src');
const distRoot = join(pkgRoot, 'dist');

function listTs(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) out.push(...listTs(full));
    else if (name.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** 相对说明符 .ts → .js（仅 import/export 的 from '...' 子句；本包无动态相对导入） */
function rewriteSpecifiers(code) {
  return code.replace(
    /(from\s+|import\s*\(\s*)(['"])(\.\.?\/[^'"]+)\.ts\2/g,
    (_m, head, quote, path) => `${head}${quote}${path}.js${quote}`,
  );
}

rmSync(distRoot, { recursive: true, force: true });
const files = listTs(srcRoot);
for (const file of files) {
  const rel = relative(srcRoot, file);
  const outPath = join(distRoot, rel.replace(/\.ts$/, '.js'));
  const code = readFileSync(file, 'utf8');
  let js;
  try {
    js = stripTypeScriptTypes(code, { mode: 'strip' });
  } catch (error) {
    console.error(`[build] 类型擦除失败（不可擦除语法）: ${rel}\n${error.message}`);
    process.exit(1);
  }
  js = rewriteSpecifiers(js);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, js, 'utf8');
  console.log(`[build] ${rel} -> dist/${rel.replace(/\.ts$/, '.js')}`);
}

// 冒烟：产物必须能作为 ESM 加载（kernel 零依赖；entry 动态 import 有 try/catch 包裹）
for (const entry of ['dist/kernel/state.js', 'dist/kernel/obs.js', 'dist/kernel/parser.js', 'dist/kernel/gate.js', 'dist/kernel/render.js', 'dist/kernel/protocol.js', 'dist/entry/mock-provider.js', 'dist/entry/loop.js', 'dist/entry/adapter-kit.js', 'dist/entry/state-handle.js', 'dist/entry/obs-broker.js', 'dist/entry/action-gate.js', 'dist/entry/context-render.js', 'dist/entry/eval-probe.js', 'dist/kernel/modes.js', 'dist/kernel/control-bar.js', 'dist/entry/control-state.js', 'dist/entry/control-bar.js', 'dist/entry/control-session.js', 'dist/entry/control-bar-cli.js', 'dist/version.js']) {
  try {
    await import(pathToFileURL(join(pkgRoot, entry)).href);
    console.log(`[build] smoke import OK: ${entry}`);
  } catch (error) {
    console.error(`[build] smoke import FAILED: ${entry}\n${error.message}`);
    process.exit(1);
  }
}
console.log(`[build] done: ${files.length} files`);

// 桌面控制页的子包完整性：dsh-client-modules 以“包”为单位扫描 dsh.client，
// 主包已被六个 entry 引用——主包若声明 dsh.client 会直接抛多源错误，整页 boot 失败。
const rootPkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
const uiPkg = JSON.parse(readFileSync(join(pkgRoot, 'ui', 'package.json'), 'utf8'));
if (rootPkg.dsh?.client !== undefined) {
  console.error('[build] 主包不得声明 dsh.client：会与六个 entry 形成多个 Loader 源，dsh-client-modules 装载期抛错');
  process.exit(1);
}
if (uiPkg.dsh?.client?.platform !== 'web' || uiPkg.exports?.['./client'] === undefined) {
  console.error('[build] ui/package.json 必须声明 dsh.client.platform = "web" 且导出 "./client"');
  process.exit(1);
}

try {
  await import(pathToFileURL(join(pkgRoot, 'ui', 'index.js')).href);
  console.log('[build] smoke import OK: ui/index.js');
} catch (error) {
  console.error(`[build] smoke import FAILED: ui/index.js\n${error.message}`);
  process.exit(1);
}

// 浏览器半边不执行（顶层 window 由客户端提供），只做语法闸门 + 协议标记检查。
const clientSource = readFileSync(join(pkgRoot, 'ui', 'client.js'), 'utf8');
try {
  new Function(clientSource);
} catch (error) {
  console.error(`[build] ui/client.js 语法错误（会让整个客户端 boot 失败）\n${error.message}`);
  process.exit(1);
}
if (!clientSource.includes('window.__ModuleLoader__.load') || !clientSource.includes('"@hugesb/dsh-stream-agent-ui"')) {
  console.error('[build] ui/client.js 缺少 __ModuleLoader__ 包装或模块 id 不匹配');
  process.exit(1);
}
console.log('[build] client bundle OK: ui/client.js');
