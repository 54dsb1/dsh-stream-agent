// eval/tools/session-log.cjs —— session log 解析与工作区取证（分派 08 工具链共用库）
// 事实锚点（METRICS.md E1/E2）：
//   - session log: %USERPROFILE%\.dsh\sessions\<slug>\session-*\session.v4.jsonl.zstd（zstd JSONL 原样保留）
//   - request/header 不含 messages；usage chunk 在 assistant/attempt.data.stream 里
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

/** cwd → session 工作区 slug（实测对照 %USERPROFILE%\.dsh\sessions 目录名：'--'+路径净化+'--'；
 *  实测规则：冒号丢弃（C:\Users → C-Users，双字符不产生双横线），\/空白 → '-'） */
function workspaceSlug(cwd) {
  return '--' + cwd.replace(/:/g, '').replace(/[/\\\s]/g, '-') + '--';
}

/** 找 cwd 下最新的 session 目录（按 session.v4.jsonl.zstd mtime） */
function newestSessionDir(cwd, userProfile = process.env.USERPROFILE || '') {
  const root = path.join(userProfile, '.dsh', 'sessions', workspaceSlug(cwd));
  if (!fs.existsSync(root)) return undefined;
  let best;
  let bestTime = -1;
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name, 'session.v4.jsonl.zstd');
    if (!fs.existsSync(p)) continue;
    const t = fs.statSync(p).mtimeMs;
    if (t > bestTime) { bestTime = t; best = { sessionDir: path.join(root, name), logPath: p, mtime: t }; }
  }
  return best;
}

/** 解压解析 session log → 记录数组（zstd 原样文件解压，只读） */
function parseSessionLog(logPath) {
  const buf = zlib.zstdDecompressSync(fs.readFileSync(logPath));
  const records = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (line.trim() === '') continue;
    try { records.push(JSON.parse(line)); } catch { records.push({ type: 'PARSE_ERROR', raw: line.slice(0, 500) }); }
  }
  return records;
}

/** 文本抽取：content blocks → 纯文本 */
function contentText(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
  }
  return String(content);
}

/** 从 session log 记录提取评测四元组所需事实（METRICS.md M1/M2/任务成败） */
function summarizeSession(records) {
  const out = {
    requestHeaderCount: 0,
    providers: [], // request/header 的 provider/model（控制变量取证）
    usageChunks: [], // assistant/attempt 里 type=usage 的原文（M1 对账 + M4 cached 字段取证）
    finishReasons: [],
    finalMessages: [], // assistant/message 全文（final-contains 检查输入）
    turnEnds: [],
    titleRequests: [], // session/title-llm-request（M1 剔除项取证）
    recordTypes: {},
  };
  for (const r of records) {
    out.recordTypes[r.type] = (out.recordTypes[r.type] || 0) + 1;
    if (r.type === 'request/header') {
      out.requestHeaderCount += 1;
      const cfg = r.data && r.data.header && r.data.header.config ? r.data.header.config : {};
      out.providers.push({ provider: cfg.provider, model: cfg.model, at: r.time });
    } else if (r.type === 'assistant/attempt') {
      for (const s of (r.data && r.data.stream) || []) {
        if (s.chunk && s.chunk.type === 'usage') out.usageChunks.push({ at: s.time, usage: s.chunk.usage });
        if (s.chunk && s.chunk.type === 'finish') out.finishReasons.push({ at: s.time, reason: s.chunk.reason });
      }
    } else if (r.type === 'assistant/message') {
      out.finalMessages.push({ turn: r.data && r.data.turn, text: contentText(r.data && r.data.message && r.data.message.content) });
    } else if (r.type === 'turn/end') {
      out.turnEnds.push({ turn: r.data && r.data.turn, reason: r.data && r.data.reason });
    } else if (r.type === 'session/title-llm-request') {
      out.titleRequests.push({ at: r.time, route: r.data && r.data.route });
    }
  }
  return out;
}

/** 工作区树哈希：相对路径排序 + 逐文件 sha256 → 单一 manifest（M5 的"实跑后哈希"） */
function workspaceManifest(wsDir) {
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else files.push({ rel: path.relative(wsDir, p).replace(/\\/g, '/'), size: st.size });
    }
  })(wsDir);
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const entries = files.map((f) => {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(wsDir, f.rel))).digest('hex');
    return { ...f, sha256: hash };
  });
  const root = crypto.createHash('sha256').update(entries.map((e) => `${e.rel}:${e.sha256}`).join('\n')).digest('hex');
  return { root, files: entries };
}

module.exports = { workspaceSlug, newestSessionDir, parseSessionLog, summarizeSession, contentText, workspaceManifest };
