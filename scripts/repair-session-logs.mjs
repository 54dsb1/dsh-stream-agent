// scripts/repair-session-logs.mjs —— 存量会话日志的 v4 工具生命周期修复（0.3.0）
//
// 背景：0.3.0 及更早版本的插件在派发 tf-* 命令时只让宿主管线落 `tool/call` +
// `tool/result`，从未写 v4 格式要求的 `assistant/message`（content 带 `tool-call` 块）。
// 宿主读取该日志时抛 `tool/call <id> has no advertised tool lifecycle`，把整条会话判为
// corrupt——桌面端表现为"历史加载失败"。本脚本为存量日志补入缺失的广告事件，并重排
// seq 与全部 seq 引用；写入前先备份，写入后用本地复核规则再验一遍。
//
// 用法：
//   node scripts/repair-session-logs.mjs                 # dry-run：只报告哪些会话需要修
//   node scripts/repair-session-logs.mjs --write         # 落盘（.bak-<时间戳> 备份 + 删投影缓存）
//   node scripts/repair-session-logs.mjs --session <id>  # 只处理一个会话
//   node scripts/repair-session-logs.mjs --root <dir>    # 指定 dsh 状态根（缺省 ~/.dsh）
//
// 纪律：零依赖；只改被判定为"缺广告"的会话；已有广告的会话一个字节都不动。

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const valueOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const WRITE = has('--write');
const STATE_ROOT = resolve(valueOf('--root', join(homedir(), '.dsh')));
const ONLY_SESSION = valueOf('--session', undefined);
const SESSIONS_ROOT = join(STATE_ROOT, 'sessions');
const PROJ_CACHE = join(STATE_ROOT, 'storages', 'session_projcache', 'sessions');

if (!existsSync(SESSIONS_ROOT)) {
  console.error(`[repair] 找不到会话目录：${SESSIONS_ROOT}（用 --root 指定 dsh 状态根）`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// zstd 多帧解码 / 单帧编码（宿主的日志是"每次 append 一帧"）
// ---------------------------------------------------------------------------

function frameEnd(buf, start) {
  let p = start;
  if (buf.readUInt32LE(p) !== 0xFD2FB528) throw new Error(`zstd magic 不符（byte ${p}）`);
  p += 4;
  const fhd = buf[p++];
  const fcs = fhd >> 6;
  const singleSegment = (fhd >> 5) & 1;
  const checksum = (fhd >> 2) & 1;
  const dictFlag = fhd & 3;
  if (!singleSegment) p += 1;
  p += [0, 1, 2, 4][dictFlag];
  p += [singleSegment ? 1 : 0, 2, 4, 8][fcs];
  for (;;) {
    const header = buf.readUIntLE(p, 3);
    p += 3;
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >> 3;
    if (type === 3) throw new Error('zstd block type 3（reserved）');
    p += size;
    if (last) break;
  }
  if (checksum) p += 4;
  return p;
}

function decodeZstdFrames(buf) {
  let p = 0;
  const chunks = [];
  while (p < buf.length) {
    const end = frameEnd(buf, p);
    chunks.push(zstdDecompressSync(buf.subarray(p, end)));
    p = end;
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// 修复：补广告 + 重排 seq
// ---------------------------------------------------------------------------

/**
 * 第二类 corrupt（0.3.0 的 finalAnswer）：assistant/message 写在 step/end 之后。
 * 把它移到该 step 的 step/end 之前（保持原来的先后顺序），v4 才认为它落在打开的 step 内。
 */
function reorderClosedStepMessages(events) {
  /** @type {Map<number, number[]>} step/end 下标 -> 需要移到它前面的消息下标 */
  const moveBefore = new Map();
  let turn = null;
  let step = null;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const data = event.data ?? {};
    if (event.type === 'turn/start') { turn = data.turn ?? null; step = null; continue; }
    if (event.type === 'step/start') { step = data.step ?? null; continue; }
    if (event.type === 'step/end') { step = null; continue; }
    if (event.type === 'turn/end') { turn = null; step = null; continue; }
    if (step !== null) continue;
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue;
    if (turn === null || data.turn !== turn) continue;
    // 往回找同一 turn 最近的 step/end（没有就找 turn/end）
    let target = -1;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (events[j].type === 'step/end' && events[j].data?.turn === turn) { target = j; break; }
      if (events[j].type === 'turn/start' && events[j].data?.turn === turn) break;
    }
    if (target < 0) {
      for (let j = i - 1; j >= 0; j -= 1) {
        if (events[j].type === 'turn/end' && events[j].data?.turn === turn) { target = j; break; }
      }
    }
    if (target < 0) continue;
    const list = moveBefore.get(target) ?? [];
    list.push(i);
    moveBefore.set(target, list);
  }
  if (moveBefore.size === 0) return events;
  const moved = new Set([...moveBefore.values()].flat());
  const out = [];
  for (let i = 0; i < events.length; i += 1) {
    if (moved.has(i)) continue;
    const list = moveBefore.get(i);
    if (list !== undefined) for (const index of list) out.push(events[index]);
    out.push(events[i]);
  }
  return out;
}

function repairedRows(rows, sessionId) {
  const [headerRow, ...rawEvents] = rows;
  if (headerRow?.type !== 'session') throw new Error('首行不是 session header');
  const events = reorderClosedStepMessages(rawEvents);

  /** @type {Map<number, Array<{type:'tool-call', id:string, name:string, arguments:string}>>} */
  const insertBefore = new Map();
  let turn = null;
  let step = null;
  const advertised = new Set();
  let unadvertised = 0;

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const data = event.data ?? {};
    if (event.type === 'turn/start') {
      turn = data.turn ?? null;
      step = null;
      advertised.clear();
      continue;
    }
    if (event.type === 'step/start') {
      step = data.step ?? null;
      advertised.clear();
      continue;
    }
    if (event.type === 'step/end') {
      step = null;
      advertised.clear();
      continue;
    }
    if (event.type === 'assistant/message') {
      for (const block of data.message?.content ?? []) {
        if (block?.type === 'tool-call' && typeof block.id === 'string') advertised.add(block.id);
      }
      continue;
    }
    if (event.type === 'tool/call') {
      const callId = data.callId;
      if (typeof callId !== 'string') throw new Error(`tool/call#${event.seq} 缺 callId`);
      if (advertised.has(callId)) continue;
      unadvertised += 1;
      const blocks = insertBefore.get(i) ?? [];
      blocks.push({ type: 'tool-call', id: callId, name: String(data.name ?? 'unknown'), arguments: String(data.arguments ?? '{}') });
      insertBefore.set(i, blocks);
      advertised.add(callId); // 同一 step 内只插一条广告
    }
  }

  const reordered = events !== rawEvents;
  /** 以原事件对象为锚重建 seq 与全部 seq 引用（重排/插入后旧 seq 不再等于下标）。 */
  const rebuild = (list) => {
    const map = new Map();
    rawEvents.forEach((event, index) => {
      const newIndex = list.indexOf(event);
      if (newIndex >= 0) map.set(typeof event.seq === 'number' ? event.seq : index, newIndex);
    });
    list.forEach((event, index) => { event.seq = index; });
    for (const event of list) remapReferences(event, map);
    return list;
  };

  if (insertBefore.size === 0) {
    if (!reordered) return { changed: false, rows, inserted: 0, unadvertised: 0, reordered: false };
    const out = rebuild([...events]);
    return { changed: true, rows: [headerRow, ...out], inserted: 0, unadvertised: 0, reordered: true };
  }

  const out = [];
  for (let i = 0; i < events.length; i += 1) {
    const blocks = insertBefore.get(i);
    if (blocks !== undefined) {
      const first = events[i];
      out.push({
        type: 'assistant/message',
        time: typeof first.time === 'number' ? first.time - 1 : Date.now(),
        data: {
          turn: first.data?.turn,
          step: first.data?.step,
          message: { id: `repaired-ad-${randomUUID()}`, role: 'assistant', content: blocks, source: { kind: 'model' } },
          stream: [],
        },
        surfaceOp: 'append',
      });
    }
    out.push(events[i]);
  }
  rebuild(out);

  return { changed: true, rows: [headerRow, ...out], inserted: insertBefore.size, unadvertised, reordered };
}

function remapReferences(event, map) {
  const m = (value) => (typeof value === 'number' && map.has(value) ? map.get(value) : value);
  if (Array.isArray(event.sourceEventSeqs)) event.sourceEventSeqs = event.sourceEventSeqs.map(m);
  if (event.surfaceOp !== null && typeof event.surfaceOp === 'object') {
    event.surfaceOp.startSeq = m(event.surfaceOp.startSeq);
    event.surfaceOp.endSeq = m(event.surfaceOp.endSeq);
  }
  const data = event.data;
  if (data === null || typeof data !== 'object') return;
  if (Array.isArray(data.messageSeqs)) data.messageSeqs = data.messageSeqs.map(m);
  if (typeof data.throughSeq === 'number') data.throughSeq = m(data.throughSeq);
  if (typeof data.headerSeq === 'number') data.headerSeq = m(data.headerSeq);
  if (Array.isArray(data.shadowedSeqs)) data.shadowedSeqs = data.shadowedSeqs.map(m);
  if (data.shadowedRange !== null && typeof data.shadowedRange === 'object') {
    data.shadowedRange.start = m(data.shadowedRange.start);
    data.shadowedRange.end = m(data.shadowedRange.end);
  }
  if (typeof data.startSeq === 'number') data.startSeq = m(data.startSeq);
  if (typeof data.endSeq === 'number') data.endSeq = m(data.endSeq);
}

// ---------------------------------------------------------------------------
// 复核：与 dsh-session-format-v3-to-v4 的 tool()/closeTools 同规则
// ---------------------------------------------------------------------------

function assertLifecycle(rows) {
  const events = rows.filter((row) => row.type !== 'session');
  const pending = new Map();
  let turn = null;
  let step = null;
  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'turn/start') { turn = data.turn ?? null; step = null; pending.clear(); continue; }
    if (event.type === 'step/start') { step = data.step ?? null; continue; }
    if (event.type === 'step/end') {
      if (pending.size !== 0) throw new Error(`step/end 仍有未解调用：${[...pending.keys()].join(',')}`);
      step = null;
      continue;
    }
    if (event.type === 'assistant/message') {
      if (data.turn !== undefined && (data.turn !== turn || data.step !== step)) {
        throw new Error(`assistant/message#${event.seq} 不在打开的 turn+step 内`);
      }
      for (const block of data.message?.content ?? []) {
        if (block?.type !== 'tool-call') continue;
        if (pending.has(block.id)) throw new Error(`assistant/message 重复广告 ${block.id}`);
        pending.set(block.id, { name: block.name, arguments: block.arguments, started: false });
      }
      continue;
    }
    if (event.type === 'tool/call') {
      const entry = pending.get(data.callId);
      if (entry === undefined) throw new Error(`tool/call ${data.callId} 没有广告`);
      if (entry.name !== data.name || entry.arguments !== data.arguments) throw new Error(`tool/call ${data.callId} 与广告不一致`);
      entry.started = true;
      continue;
    }
    if (event.type === 'tool/result') {
      const id = data.message?.toolCallId;
      const entry = pending.get(id);
      if (entry === undefined) throw new Error(`tool/result ${id} 没有对应调用`);
      if (!entry.started) {
        const message = data.message ?? {};
        const error = event.error ?? {};
        const repaired = typeof message.id === 'string' && message.id.startsWith(`interrupted-tool-result-${id}-`)
          && message.isError === true && error.name === 'ToolNotStartedError' && error.code === 'TOOL_NOT_STARTED';
        if (!repaired) throw new Error(`未开始调用 ${id} 的 result 不是 TOOL_NOT_STARTED 修复形状`);
      }
      pending.delete(id);
    }
  }
  for (const event of events) {
    const max = events.length - 1;
    const check = (value, label) => {
      if (typeof value === 'number' && (value < 0 || value > max)) throw new Error(`${label} 越界：${value}`);
    };
    check(event.seq, `${event.type} seq`);
    for (const seq of event.sourceEventSeqs ?? []) check(seq, `${event.type} sourceEventSeqs`);
    for (const seq of event.data?.messageSeqs ?? []) check(seq, `${event.type} messageSeqs`);
    check(event.data?.throughSeq, `${event.type} throughSeq`);
  }
}

// ---------------------------------------------------------------------------
// 遍历 / 落盘
// ---------------------------------------------------------------------------

function findSessionFiles(root) {
  const found = [];
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project);
    if (!statSync(projectDir).isDirectory()) continue;
    for (const sessionId of readdirSync(projectDir)) {
      const sessionDir = join(projectDir, sessionId);
      if (!statSync(sessionDir).isDirectory()) continue;
      if (ONLY_SESSION !== undefined && !sessionId.includes(ONLY_SESSION)) continue;
      const file = readdirSync(sessionDir).find((name) => name.endsWith('.jsonl.zstd'));
      if (file === undefined) continue;
      found.push({ sessionId, file: join(sessionDir, file) });
    }
  }
  return found;
}

function readRows(file) {
  const buf = readFileSync(file);
  const text = file.endsWith('.zstd') ? decodeZstdFrames(buf) : buf.toString('utf8');
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

let scanned = 0;
let needRepair = 0;
let written = 0;

// 可选：用宿主自己的 v4 校验器复核（设 DSH_HOST_MODULES=<dsh 安装目录>/node_modules/@deepseek-ai）。
// 缺省只用本地生命周期规则——插件仓库不依赖宿主包。
const hostModules = process.env.DSH_HOST_MODULES;
let hostValidate;
if (hostModules !== undefined && hostModules.trim() !== '') {
  const base = hostModules.replace(/\\/g, '/').replace(/\/$/, '');
  const { KNOWN_SESSION_EVENT_TYPES } = await import(`file:///${base}/dsh-session/lib/index.js`);
  const { restoreReleasedV4Artifact, assertReleasedV4Relationships } = await import(`file:///${base}/dsh-session-format-v3-to-v4/lib/index.js`);
  hostValidate = (rows) => {
    const [headerRow, ...events] = rows;
    const { type: _type, ...header } = headerRow;
    const artifact = { header, inheritedEventCount: header.isSeeded === true ? (headerRow.inheritedEventCount ?? 0) : 0, events };
    restoreReleasedV4Artifact(artifact, KNOWN_SESSION_EVENT_TYPES);
    assertReleasedV4Relationships(artifact, KNOWN_SESSION_EVENT_TYPES);
  };
  console.log(`[host] 使用宿主校验器复核：${base}`);
}
for (const { sessionId, file } of findSessionFiles(SESSIONS_ROOT)) {
  scanned += 1;
  let rows;
  try {
    rows = readRows(file);
  } catch (error) {
    console.log(`[skip] ${sessionId}：日志无法解码（${error.message}）`);
    continue;
  }
  let result;
  try {
    result = repairedRows(rows, sessionId);
  } catch (error) {
    console.log(`[skip] ${sessionId}：${error.message}`);
    continue;
  }
  if (!result.changed) {
    console.log(`[ok]   ${sessionId}：无缺失广告`);
    continue;
  }
  needRepair += 1;
  console.log(`[fix]  ${sessionId}：补 ${result.inserted} 条广告（覆盖 ${result.unadvertised} 个 tool/call）`);
  try {
    assertLifecycle(result.rows);
    hostValidate?.(result.rows);
  } catch (error) {
    console.log(`[fail] ${sessionId}：修复后复核不通过（${error.message}），不落盘`);
    continue;
  }
  if (!WRITE) continue;
  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(file, backup);
  const jsonl = `${result.rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, zstdCompressSync(Buffer.from(jsonl, 'utf8')));
  renameSync(tmp, file);
  const cache = join(PROJ_CACHE, `${sessionId}.json`);
  if (existsSync(cache)) rmSync(cache, { force: true });
  written += 1;
  console.log(`        已写入（备份：${backup}；投影缓存已清除）`);
}

console.log('');
console.log(`扫描 ${scanned} 个会话，需修复 ${needRepair} 个，${WRITE ? `已写入 ${written} 个` : 'dry-run 未写入（加 --write 落盘）'}`);
