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
for (const entry of ['dist/kernel/state.js', 'dist/kernel/obs.js', 'dist/kernel/parser.js', 'dist/kernel/gate.js', 'dist/kernel/render.js', 'dist/entry/mock-provider.js', 'dist/entry/loop.js', 'dist/entry/adapter-kit.js', 'dist/entry/state-handle.js', 'dist/entry/obs-broker.js', 'dist/entry/action-gate.js', 'dist/entry/context-render.js', 'dist/entry/eval-probe.js']) {
  try {
    await import(pathToFileURL(join(pkgRoot, entry)).href);
    console.log(`[build] smoke import OK: ${entry}`);
  } catch (error) {
    console.error(`[build] smoke import FAILED: ${entry}\n${error.message}`);
    process.exit(1);
  }
}
console.log(`[build] done: ${files.length} files`);
