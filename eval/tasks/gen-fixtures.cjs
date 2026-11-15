// eval/tasks/gen-fixtures.cjs —— 任务集固定 fixtures（逐字节确定性；评测两臂共用同一份）
// 用法：node eval/tasks/gen-fixtures.cjs   （幂等；产物写入本目录 fixtures/）
const fs = require('fs');
const path = require('path');
const out = path.join(__dirname, 'fixtures');
fs.mkdirSync(out, { recursive: true });

const lines = [];

// big-report.md：300 行确定性报告；L137 是探针行（R1 考察 tf-peek 精确取回）
lines.length = 0;
lines.push('# Quarterly Platform Report (fixture)');
lines.push('');
const w = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
for (let i = 1; i <= 296; i++) {
  if (i === 135) { // 文件行号 = i+2（前两行是标题+空行）→ 探针行落在文件 L137
    lines.push('L137-quirk-quokka: the secret calibration constant is 424242');
    continue;
  }
  const section = i % 40 === 1 ? `## Section ${Math.floor(i / 40) + 1}` : `entry ${i}: ${w[i % 10]}-${(i * 37) % 997} status=ok`;
  lines.push(section);
}
fs.writeFileSync(path.join(out, 'big-report.md'), lines.join('\n') + '\n', 'utf8');

// error.log：200 行；唯一 ERROR 在 L173（R3 考察骨架关键行定位）
lines.length = 0;
for (let i = 1; i <= 200; i++) {
  if (i === 173) lines.push(`2026-01-01T10:${String(i).padStart(2, '0')}:00Z ERROR disk-quota-exceeded volume=D trace-id=tr-9f87`);
  else lines.push(`2026-01-01T10:${String(i).padStart(2, '0')}:00Z INFO worker heartbeat seq=${i} ok`);
}
fs.writeFileSync(path.join(out, 'error.log'), lines.join('\n') + '\n', 'utf8');

// config 三件套（R2 跨文件改配置：revision 7 → 9）
for (const name of ['settings', 'features', 'deploy']) {
  const body = [
    `# ${name}.yaml (fixture)`,
    'service: platform',
    'revision: 7',
    name === 'settings' ? 'locale: zh-CN' : name === 'features' ? 'flags: [a, b]' : 'replicas: 2',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(out, `${name}.yaml`), body, 'utf8');
}

// R4 双 JSON 找共同记录：共同 id 有 4 个（u-0009/0024/0041/0058），其中 tier=pro 的唯一 = u-0041（score 91）
const usersA = Array.from({ length: 60 }, (_, i) => ({ id: `u-${String(i + 1).padStart(4, '0')}`, name: `user${i + 1}`, tier: ['free', 'pro', 'team'][i % 3] }));
const usersB = [
  { id: 'u-0009', score: 33 },
  { id: 'u-0024', score: 57 },
  { id: 'u-0041', score: 91 },
  { id: 'u-0058', score: 12 },
];
fs.writeFileSync(path.join(out, 'users-roster.json'), JSON.stringify({ users: usersA }, null, 2), 'utf8');
fs.writeFileSync(path.join(out, 'users-scores.json'), JSON.stringify({ scored: usersB }, null, 2), 'utf8');

// C1 销售数据：60 行，sum(amount) 确定性 = 60 * (100+i) = 4830？行 i+1: amount=100+i → sum=Σ(100..159)=7770
lines.length = 0;
lines.push('region,amount');
for (let i = 0; i < 60; i++) lines.push(`zone-${i % 5},${100 + i}`);
fs.writeFileSync(path.join(out, 'sales-q1.csv'), lines.join('\n') + '\n', 'utf8');

// C2 指针配置：指向缺失文件（考察失败改道）
fs.writeFileSync(path.join(out, 'pipeline.yaml'), [
  '# pipeline.yaml (fixture)',
  'source: data/missing-source.json',
  'fallback: none',
  'output: out/result.json',
  '',
].join('\n'), 'utf8');

// C3 清单（读清单 → 逐项写文件 → 报告）
fs.writeFileSync(path.join(out, 'build-manifest.txt'), [
  '# build-manifest.txt (fixture)',
  'docs/intro.md = Stream agent intro, three paragraphs, plain markdown.',
  'docs/design.md = Single-stream protocol design notes, mention tf-write and tf-peek.',
  'docs/eval.md = Evaluation plan summary, mention METRICS and baseline.',
  'docs/roadmap.md = Roadmap: M0 through M10 one line each.',
].join('\n'), 'utf8');

console.log('fixtures written to', out);
