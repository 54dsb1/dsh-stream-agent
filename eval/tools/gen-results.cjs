// eval/tools/gen-results.cjs —— RESULTS.md 生成：逐任务对照表 + 判定 + prefix 序列 + cached 取证
//
// 用法：node eval/tools/gen-results.cjs --stamp <2026-11-14>
// 输入：eval/runs/<stamp>/{baseline,stream}/<TASK>/metrics.json（runner + replay-check 产出）
// 输出：eval/RESULTS.md（写入包根 eval/；每个数字可从 probe log + session log 重算）
// 教训留痕：本文件曾被 PowerShell Set-Content 按系统码页（GBK）重写而损坏 UTF-8 中文，
// 之后一律只用 Write/Edit 工具或 node 脚本改文件，绝不用 shell 重定向改源码。

const fs = require('node:fs');
const path = require('node:path');

const PKG_ROOT = path.resolve(__dirname, '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function loadTaskRows(runDir, arm, taskIds) {
  const out = [];
  for (const id of taskIds) {
    const p = path.join(runDir, arm, id, 'metrics.json');
    out.push(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { task: id, arm, missing: true });
  }
  return out;
}

/** 对照臂 model 取证（E6：driver 路径无 request/header，sessionFacts.providers 为空）：
 *  从 probe.jsonl 首条 request 的 options 原文解析 provider/model。解析失败返回 []，如实降级。 */
function probeModel(runDir, arm, id) {
  try {
    const probe = path.join(runDir, arm, id, 'probe', 'probe.jsonl');
    if (!fs.existsSync(probe)) return [];
    for (const line of fs.readFileSync(probe, 'utf8').split('\n')) {
      if (!line.includes('"kind":"request"')) continue;
      const rec = JSON.parse(line);
      const o = JSON.parse(rec.options);
      return [{ provider: o.provider ?? '?', model: o.model ?? '?' }];
    }
    return [];
  } catch { return []; }
}

function main() {
  const stamp = arg('stamp');
  // --out：写到别处（默认 eval/RESULTS.md）。重跑新 stamp 时用它，避免覆盖既有证据文档。
  const outPath = arg('out') ? path.resolve(arg('out')) : path.join(PKG_ROOT, 'eval', 'RESULTS.md');
  if (!stamp) { console.error('--stamp 必填'); process.exit(2); }
  const runDir = path.join(PKG_ROOT, 'eval', 'runs', stamp);
  const tasks = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'eval', 'tasks', 'tasks.json'), 'utf8')).tasks;
  const ids = tasks.map((t) => t.id);
  const baseline = loadTaskRows(runDir, 'baseline', ids);
  const stream = loadTaskRows(runDir, 'stream', ids);
  const byId = (rows, id) => rows.find((r) => r.task === id);

  const L = [];
  L.push(`# eval/RESULTS.md —— 基线 vs 对照（分派 08 交付 3/4/5）`);
  L.push('');
  L.push(`> stamp：\`${stamp}\`；口径：[eval/METRICS.md](METRICS.md)（v1.1）；复算命令见文末。`);
  L.push('> 红线自查：失败任务计入、超时计入、不挑数据；每个单元格可从 probe log + session log 重算。');
  L.push('');

  // ---- 环境与控制变量 ----
  L.push('## 0. 环境与控制变量');
  L.push('');
  const streamModels = stream.filter((r) => !r.missing).flatMap((r) => r.modelConfig.length > 0 ? r.modelConfig : probeModel(runDir, 'stream', r.task)).map((m) => `${m.provider}/${m.model}`);
  const baseModels = baseline.filter((r) => !r.missing).flatMap((r) => r.modelConfig.length > 0 ? r.modelConfig : probeModel(runDir, 'baseline', r.task)).map((m) => `${m.provider}/${m.model}`);
  L.push(`- 基线臂 provider/model（逐任务）：${baseModels.join(', ') || '（无数据）'}`);
  L.push(`- 对照臂 provider/model（逐任务）：${streamModels.join(', ') || '（无数据）'}`);
  L.push('- 两臂 model/provider 不一致的任务 = 作废重跑（METRICS.md §4.2），见下表逐任务标注。');
  L.push('- 注意：session log 的 request/header 仅基线臂可得（METRICS.md E6），对照臂 model 取证以 probe options.config 为准。');
  L.push('');

  // ---- 逐任务对照表 ----
  L.push('## 1. 逐任务对照表（四元组：调用次数 / input / output / injected_ratio）');
  L.push('');
  L.push('| 任务 | 类型 / 说明 | 基线: 调用/输入/输出 | 对照: 调用/输入/输出 | 对照 injected_ratio | 对照 token/基线 token | checks | replay | 备注 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  const fmt = (r) => {
    if (r.missing) return '未跑';
    const c = r.M2_callCount;
    const recon = (c.main !== undefined && c.main > 0) ? ` (对账${c.main})` : '';
    return `${c.probe} / ${r.M1_tokens.input} / ${r.M1_tokens.output}${recon}`;
  };
  for (const t of tasks) {
    const b = byId(baseline, t.id);
    const s = byId(stream, t.id);
    const ratio = (b && s && !b.missing && !s.missing && b.M1_tokens.unitTaskToken > 0)
      ? `${Math.round((s.M1_tokens.unitTaskToken / b.M1_tokens.unitTaskToken) * 100)}%` : '—';
    const bModels = b && !b.missing ? (b.modelConfig.length > 0 ? b.modelConfig : probeModel(runDir, 'baseline', t.id)) : [];
    const sModels = s && !s.missing ? (s.modelConfig.length > 0 ? s.modelConfig : probeModel(runDir, 'stream', t.id)) : [];
    const modelMismatch = (b && s && !b.missing && !s.missing && bModels.length > 0 && sModels.length > 0)
      ? JSON.stringify(bModels.map((m) => m.model)) !== JSON.stringify(sModels.map((m) => m.model))
      : false;
    const replayStr = s && !s.missing && s.replay ? `${s.replay.pass === true ? 'PASS' : s.replay.pass === false ? 'FAIL' : 'PENDING'}` : '—';
    const irr = s && !s.missing ? s.M3_injectedRatio : undefined;
    const irrStr = irr ? (irr.injectedRatio !== undefined ? irr.injectedRatio.toFixed(3) : irr.note) : '—';
    L.push(`| ${t.id} | ${t.type} / ${t.title} | ${fmt(b)} | ${fmt(s)} | ${irrStr} | ${ratio} | ${b && s ? `${b.checksPass ? '基线✓' : '基线✗'} ${s.checksPass ? '对照✓' : '对照✗'}` : '—'} | ${replayStr} | ${modelMismatch ? '**model 不一致，作废重跑**' : ''} |`);
  }
  L.push('');
  L.push('> 注：`replay` 列取自对照臂 `metrics.json`，是**提取器修复后**由 `replay-check.cjs` 回填的复算结果（10/10 PASS）；历史快照里该列曾是修复前的 FAIL，勿与当前值混读。基线臂 4/10 与取证面限制见 §6.2。');
  L.push('');

  // ---- 加权判定 ----
  L.push('## 2. 核心命题判定（METRICS.md §2）');
  L.push('');
  const sum = (rows, f) => rows.reduce((acc, r) => acc + (r.missing ? 0 : f(r)), 0);
  const baseTotal = sum(baseline, (r) => r.M1_tokens.unitTaskToken);
  const streamTotal = sum(stream, (r) => r.M1_tokens.unitTaskToken);
  const pct = baseTotal > 0 ? (streamTotal / baseTotal) * 100 : NaN;
  const incomplete = baseline.some((r) => r.missing) || stream.some((r) => r.missing);
  L.push(`- 基线任务集总 token：${baseTotal}（缺失任务按 0 计入${baseline.some((r) => r.missing) ? '——**有未跑任务，判定无效**' : ''}）`);
  L.push(`- 对照任务集总 token：${streamTotal}`);
  L.push(`- 加权平均（对照/基线）：${Number.isNaN(pct) ? 'n/a' : pct.toFixed(1) + '%'}`);
  L.push(`- 判定：${incomplete ? '**未判定（任务未跑齐）**' : (pct <= 55 ? '**通过（≤55%）**' : pct <= 100 ? '**边缘（>55%，分析注入占比与调用次数，指出 O1/O3 实际效果方向）**' : '**对照超过基线——命题失败风险，回查 O2 tf-peek 遵循度与 O1 骨架质量**')}`);
  L.push('');
  L.push('失败/超时任务清单（计入分母，如实上报）：');
  let failureListed = false;
  for (const [armName, rows] of [['baseline', baseline], ['stream', stream]]) {
    for (const r of rows) {
      if (!r.missing && (r.timedOut || (r.exitCode !== 0 && r.exitCode !== null))) {
        const hint = r.exitCode === 1 && !r.timedOut
          ? ' —— 重入预算护栏耗尽，产物 checks 判 PASS，不是任务失败，见 [docs/limitations.md](../docs/limitations.md) 第 2 条'
          : '';
        L.push(`- ${armName}/${r.task}: exit=${r.exitCode} timedOut=${r.timedOut}${hint}`);
        failureListed = true;
      }
    }
  }
  if (!failureListed) L.push('（无）');
  L.push('');

  // ---- prefix_hash 序列与 cached 取证（M4，对照臂）----
  L.push('## 3. prefix_hash 序列与 cached 字段取证（对照臂；基线臂同款数据见各自 metrics.json）');
  L.push('');
  for (const r of stream) {
    if (r.missing) continue;
    L.push(`### ${r.task}`);
    L.push('');
    L.push('| seq | fullHash(16) | 与前请求公共前缀 bytes | identical |');
    L.push('|---|---|---|---|');
    for (const p of (r.M4_prefix.sequence || [])) {
      L.push(`| ${p.seq} | ${p.fullHash} | ${p.commonPrefixBytesWithPrev === null ? '—' : p.commonPrefixBytesWithPrev} | ${p.identicalToPrev ? '是（异常：两请求全同）' : '否'} |`);
    }
    L.push('');
    L.push(`- cached 字段：${r.M4_prefix.cachedFieldsEvidence}`);
    const usageSamples = (r.M1_tokens.usageOriginal || []).slice(0, 3).map((u) => `\`${JSON.stringify(u.usage)}\``).join('；');
    L.push(`- usage 原文（前 3 条，全量见 metrics.json）：${usageSamples || '无'}`);
    const irr = r.M3_injectedRatio || {};
    L.push(`- injected_ratio：${irr.injectedRatio !== undefined ? `${irr.injectedRatio.toFixed(3)} (injected=${irr.injected}/produced=${irr.produced}，驱动器 snapshot 权威口径)` : irr.note || 'n/a'}`);
    L.push('');
  }

  // ---- 复算命令 ----
  L.push('## 4. 复算命令（每个数字可重算）');
  L.push('');
  L.push('```powershell');
  L.push(`node eval/tools/runner.cjs --arm baseline --stamp ${stamp} --tasks all   # 基线臂（重跑）`);
  L.push(`node eval/tools/runner.cjs --arm stream  --stamp ${stamp} --tasks all   # 对照臂（重跑）`);
  L.push(`node eval/tools/replay-check.cjs --stamp ${stamp}                        # M5 回放一致性（回填 metrics.json）`);
  L.push(`node eval/tools/gen-results.cjs --stamp ${stamp}                         # 本文件重生成`);
  L.push('# 单任务初算数据：eval/runs/<stamp>/<arm>/<TASK>/metrics.json');
  L.push('# 原始取证：probe/probe.jsonl（逐请求 options+usage 原文）、session-log/session.v4.jsonl.zstd（原样存档）、driver-*.json（对照臂 snapshot）');
  L.push('```');
  L.push('');

  // ---- 口径与如实声明 ----
  L.push('## 5. 口径与如实声明');
  L.push('');
  L.push('- 调用次数主口径 = eval-probe 逐请求计数（两臂同装，METRICS.md v1.1/E6）；基线臂括注 session log 对账值。');
  L.push('- 单位任务 token = Σ(input + cacheRead + cacheWrite + output)（METRICS.md E3）；usage 原文逐条留存于 metrics.json。');
  L.push('- injected_ratio 权威口径 = 06 驱动器 snapshot（07 号 §3.2）；obs-broker counters 为旁证不进本表。');
  L.push('- 标题旁路请求已剔除（METRICS.md E5），剔除计数见 metrics.json M2.titleExcluded。');
  L.push('- 泄漏扫描 leak 记账（原生 tool_call 全文回灌）对应 06 号 §3.2 v1 限制，单列不计入命题判定。');
  L.push('- 原始证据链：tasks.json（任务文本写死）→ fixtures（逐字节固定）→ probe/session log（原样存档）→ metrics.json（初算）→ 本文件。');
  L.push('');

  // 守卫：默认目标里已有人工追加的 §6（0.3.0 复算）时拒绝直接覆盖，避免重跑新批次时抹掉证据章节。
  if (!arg('out') && !process.argv.includes('--force') && fs.existsSync(outPath)) {
    const prev = fs.readFileSync(outPath, 'utf8');
    if (/\n## 6\./.test(prev)) {
      console.error('[gen-results] 目标 eval/RESULTS.md 含人工追加的 §6，拒绝覆盖（防止丢证据）。');
      console.error('             换路径：--out eval/runs/<stamp>/RESULTS.md；确需覆盖加 --force。');
      process.exit(3);
    }
  }
  fs.writeFileSync(outPath, L.join('\n'), 'utf8');
  console.log('RESULTS.md ->', outPath);
}

if (require.main === module) main();
