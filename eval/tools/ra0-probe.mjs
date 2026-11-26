// eval/tools/ra0-probe.mjs —— RA-0 六项探针（0.6.0 计划 §2）
//
// 用法：node eval/tools/ra0-probe.mjs [--out eval/runs/ra0]
// 产物：U1-messages.json … U6-usage.json + summary.md（六项结论 + 对装配路线的影响）
//
// 说明：探针只测**插件掌握的那条接缝**（DriverPorts.stream 入参契约 + 适配器行为）；
// 宿主侧真实校验无法离线判定，结论里的 hostVerification 一律 pending（见 summary.md）。

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..', '..');

const outIndex = process.argv.indexOf('--out');
const outDir = outIndex >= 0 && process.argv[outIndex + 1] !== undefined
  ? resolve(process.argv[outIndex + 1])
  : join(pkgRoot, 'eval', 'runs', 'ra0');

const mod = await import(pathToFileURL(join(pkgRoot, 'src', 'entry', 'ra0-probe.ts')).href);
const results = await mod.runRa0Probes();
const files = mod.writeRa0Artifacts(outDir, results);

const route = mod.assemblyRoute(results);
for (const r of results) {
  console.log(`[ra0] ${r.id} ${r.verdict.padEnd(11)} ${r.reason.slice(0, 80)}`);
}
console.log(`[ra0] 路线判定：${route.route} — ${route.detail}`);
console.log(`[ra0] 产物 ${files.length} 个 → ${outDir}`);
