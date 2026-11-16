// entry/json-persistence.ts —— 插件本地持久化兜底（修复已知限制 3 / 4）
//
// 职责：宿主缺 storage backend、缺 sessionPersistence、或 dsh-session 模块不可达
// （bundle 形态 bare import 解析不到宿主同一副本）时，提供零依赖的本地文件持久化面：
//   ① JsonFileKvUnit      —— KvUnit 的本地 JSON 文件实现（state-handle 降级用：
//                            句柄目录 + blob 落盘，resume 可重建，不再是易失内存）；
//   ② createJsonlPersistence —— 会话事件 JSONL 持久化（AgentFactory.create/resume 的
//                            persistence 降级实现；headless 未挂 sessionPersistence 时
//                            跨会话 resume 真正可用）；
//   ③ FileLedgerSink      —— plugin:tf-agent/* 台账的 JSONL 落点（bundle 形态 plugin
//                            record 通道降级时的可重放落点，不再是易失内存台账）；
//   ④ withEventCapture    —— 会话 append 代理：事件镜像进 ② 的 JSONL（仅降级路径用）。
//
// 纪律（与 adapter-kit 一致）：零 @deepseek-ai 依赖；fail-open（红线 5）——
// IO 失败向上抛错或走告警出口，绝不静默吞事实。

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
                                                         

// ---------------------------------------------------------------------------
// 状态目录
// ---------------------------------------------------------------------------

/** 状态根目录解析：config 显式指定 → env STREAM_AGENT_STATE_DIR → ~/.dsh-stream-agent */
export function resolveStateDir(configDir         )         {
  if (configDir !== undefined && configDir.trim() !== '') return configDir;
  const env = process.env.STREAM_AGENT_STATE_DIR;
  if (env !== undefined && env.trim() !== '') return env;
  return join(homedir(), '.dsh-stream-agent');
}

/** 文件名安全化（session id 可能含 ':' '/' 等路径字符）。 */
export function safeFileName(id        )         {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_') || 'session';
}

// ---------------------------------------------------------------------------
// ① KvUnit —— JSON 文件实现（镜像 adapter-kit.KvUnitLike）
// ---------------------------------------------------------------------------

                      
                                                  
 

function loadJsonKv(file        , warn      )             {
  if (!existsSync(file)) return { tables: {} };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))                       ;
    return { tables: (raw.tables ?? {})                                            };
  } catch (error) {
    warn(`本地 KvUnit 文件损坏，按空库打开（原文件保留在 ${file}.corrupt 语义之外，不做改写）`, error);
    return { tables: {} };
  }
}

/** 原子写：tmp + rename，避免半截 JSON。 */
function flushJsonKv(file        , data            )       {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), 'utf8');
  renameSync(tmp, file);
}

/**
 * 本地 JSON 文件 KvUnit。open 时创建目录并真实写一次（可写性探针失败即抛，
 * 由调用方走最终内存降级——绝不带着假 durable 面）。putRecord 走串行队列
 * 防读改写竞态；每次写全量重写文件（插件规模的状态量下足够，简单优先）。
 */
export class JsonFileKvUnit                       {
           #file        ;
           #warn      ;
           #cache            ;
  #queue                = Promise.resolve();
  #closed = false;

  constructor(dir        , name        , warn      ) {
    this.#warn = warn;
    mkdirSync(dir, { recursive: true });
    this.#file = join(dir, `${safeFileName(name)}.json`);
    // 可写性探针：文件缺失时落一次空库（rename 原子性同时验证目录可写）
    if (!existsSync(this.#file)) flushJsonKv(this.#file, { tables: {} });
    this.#cache = loadJsonKv(this.#file, warn);
  }

  /** 实际落盘文件路径（排障/日志用）。 */
  get file()         {
    return this.#file;
  }

  async loadAll()                                                                                {
    return { tables: this.#cache.tables, global: null };
  }

  async putRecord(table        , key        , value         )                {
    const op = this.#queue.then(() => {
      if (this.#closed) throw new Error('kv unit closed');
      const t = this.#cache.tables[table] ?? (this.#cache.tables[table] = {});
      t[key] = value;
      flushJsonKv(this.#file, this.#cache);
    });
    this.#queue = op.catch(() => {}); // 队列不因单次失败卡死；错误由 await 侧上抛
    await op;
  }

  async close()                {
    await this.#queue;
    this.#closed = true;
  }
}

// ---------------------------------------------------------------------------
// ② 会话事件 JSONL 持久化（AgentFactory.create/resume 的 persistence 降级实现）
// ---------------------------------------------------------------------------

const HEADER_KIND = '__tf_agent_header__';

                                     
                         
                                                    
                                                                                    
                  
                               
 

                                   
                                                                                                                      
                                                                                               
 

/**
 * 逐会话一个 JSONL 文件：<sessionsDir>/<sessionId>.jsonl。
 * 首行 header（kind=__tf_agent_header__），后续每行一个会话事件（原样对象）。
 * append 同步落盘（appendFileSync；会话事件频度低，简单优先于缓冲）。
 */
class JsonlSessionFile {
           #file        ;
           #warn      ;
           #sessionId        ;
  #header          = undefined;
  #inheritedEventCount                     = undefined;
  #events            = [];
  #loaded = false;

  constructor(sessionsDir        , sessionId        , warn      ) {
    this.#warn = warn;
    this.#sessionId = sessionId;
    mkdirSync(sessionsDir, { recursive: true });
    this.#file = join(sessionsDir, `${safeFileName(sessionId)}.jsonl`);
  }

  /** create 路径：写 header 行（已存在文件 → 抛错，上层转 resume 语义打开）。 */
  initHeader(header         , inheritedEventCount         )       {
    if (existsSync(this.#file)) {
      throw new Error(`session already exists: ${this.#sessionId}`);
    }
    appendFileSync(this.#file, `${JSON.stringify({ kind: HEADER_KIND, header, inheritedEventCount })}\n`, 'utf8');
    this.#header = header;
    this.#inheritedEventCount = inheritedEventCount;
    this.#loaded = true;
  }

  /** open 路径：冷读全部行（坏行跳过 + 告警，不静默吞事件）。 */
  load()       {
    this.#events = [];
    if (!existsSync(this.#file)) {
      throw new Error(`session log not found: ${this.#sessionId}`);
    }
    const lines = readFileSync(this.#file, 'utf8').split('\n');
    let first = true;
    for (const line of lines) {
      if (line.trim() === '') continue;
      let parsed         ;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        this.#warn(`会话 JSONL 坏行跳过（${this.#file}）`, error);
        continue;
      }
      const rec = parsed                                                                       ;
      if (first && rec?.kind === HEADER_KIND) {
        this.#header = rec.header;
        this.#inheritedEventCount = typeof rec.inheritedEventCount === 'number' ? rec.inheritedEventCount : undefined;
        first = false;
        continue;
      }
      first = false;
      this.#events.push(parsed);
    }
    this.#loaded = true;
  }

  async append(events                    )                {
    if (!this.#loaded) throw new Error('session jsonl not initialized');
    for (const event of events) {
      appendFileSync(this.#file, `${JSON.stringify(event)}\n`, 'utf8');
      this.#events.push(event);
    }
  }

  async read(from        )                                                                {
    if (!this.#loaded) throw new Error('session jsonl not initialized');
    const start = Math.max(0, Math.floor(from));
    return { events: this.#events.slice(start) };
  }

  async close()                {
    // appendFileSync 直写，无需 flush
  }

  get headerValue()          {
    return this.#header;
  }

  get inheritedCount()                     {
    return this.#inheritedEventCount;
  }
}

/** 创建 per-session 的 JSONL persistence 工厂（AgentFactory 降级接驳点）。 */
export function createJsonlPersistence(sessionsDir        , sessionId        , warn      )                   {
  return {
    async create(header, opts) {
      const f = new JsonlSessionFile(sessionsDir, sessionId, warn);
      f.initHeader(header, opts?.inheritedEventCount);
      return f;
    },
    async open(id) {
      const f = new JsonlSessionFile(sessionsDir, id, warn);
      f.load();
      return f;
    },
  };
}

// ---------------------------------------------------------------------------
// ③ plugin:tf-agent/* 台账 JSONL（bundle 形态 plugin record 通道降级落点）
// ---------------------------------------------------------------------------

                                     
                                                  
                                            
                
 

export function ledgerFileOf(stateDir        , sessionId        )         {
  return join(stateDir, 'ledger', `${safeFileName(sessionId)}.jsonl`);
}

/** 追加一条台账记录（同步落盘；目录缺则建）。IO 失败向上抛——驱动器侧告警不静默。 */
export function appendLedgerRecord(file        , type        , data         )       {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), type, data })}\n`, 'utf8');
}

/** 读回台账记录（resume 重放用；坏行跳过并计数，由调用方决定是否告警）。 */
export function loadLedgerRecords(file        )                                                                       {
  if (!existsSync(file)) return { records: [], skipped: 0 };
  const records                                         = [];
  let skipped = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const rec = JSON.parse(line)                                      ;
      if (typeof rec?.type === 'string') records.push({ type: rec.type, data: rec.data });
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

// ---------------------------------------------------------------------------
// ④ 会话事件捕获代理（仅降级持久化路径使用）
// ---------------------------------------------------------------------------

/**
 * 会话 append 代理：事件镜像进 JSONL，其余方法/属性原型链透传
 * （snapshotEvents / header / seq 等行为不变）。宿主 checkpoint 机制依赖
 * sessionPersistence 存在；降级路径没有它，事件捕获只能在这里做。
 */
export function withEventCapture(
  session         ,
  sink                                                    ,
  warn      ,
)          {
  if (session === null || typeof session !== 'object') return session;
  const target = session                                                                         ;
  if (typeof target.append !== 'function') return session;
  const wrapped = Object.create(session)                           ;
  wrapped.append = (type        , data         , opts          ) => {
    const appended = target.append (type, data, opts);
    // 落盘对象：宿主返回的完整事件优先（保真 seq/type/data），拿不到事件对象则用最小形状
    const event = appended !== null && typeof appended === 'object'
      ? { type, data, ...(appended                           ) }
      : { type, data };
    try {
      sink.appendEvents([event]);
    } catch (error) {
      warn('会话事件镜像落盘失败（fail-open：内存事实不丢，本事件不再重试）', error);
    }
    return appended;
  };
  return wrapped;
}
