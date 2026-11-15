// entry/adapter-kit.ts —�?四个 07 �?entry 共用的适配胶水（分�?07�?//
// 不是业务逻辑，只有四类翻译助手：告警出口、entry 私有台账、文本提取�?// BlobSink �?DSH storage 桥。纪律与 loop.ts 一致：�?@deepseek-ai 静�?import�?// 宿主依赖全部 duck-type；内核只 import 公开接口（state.ts �?BlobSink/StateStore）�?
import { StateStore } from '../kernel/state.js';
                                                   

/** 告警出口签名（红�?5：不许静默）�?*/
                                                               

/** 宿主 logger �?duck-type 面（dsh-cordis-host-runner 装配；缺省落 stderr）�?*/
                      
                               
                                
 

                              
                                 
                                                  
                                                                       
                                                        
 

/** 可序列化的单条事实（Error �?message；对�?�?JSON）�?*/
export function detailString(detail         )         {
  if (detail instanceof Error) return detail.message;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/** 告警出口：优先宿�?logger，否�?stderr（与 loop.ts �?apply 同款，绝不静默）�?*/
export function makeWarn(ctx             , tag        )       {
  return (message, detail) => {
    const logger = (ctx.get?.('logger') ?? null)                     ;
    const text = `[${tag}] ${message}${detail === undefined ? '' : ` :: ${detailString(detail)}`}`;
    if (logger?.warn !== undefined) logger.warn(text);
    else console.error(text);
  };
}

/** entry 私有台账：内�?append-only 事实流（红线 5 �?不许静默"载体）�?*/
export class EntryLedger {
           records                                                                                  = [];
  #seq = 0;

  push(kind        , data                          = {})       {
    this.records.push({ seq: ++this.#seq, at: Date.now(), kind, data });
  }

  count(kind        )         {
    return this.records.filter((r) => r.kind === kind).length;
  }
}

/** ContentBlock[]（dsh-llm/lib/types/types.d.ts �?text 块族）→ 纯文本�?*/
export function contentTextOf(content         )         {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block !== null && typeof block === 'object' && 'text' in block && typeof (block                      ).text === 'string') {
          return (block                    ).text;
        }
        return '';
      })
      .filter((t) => t !== '')
      .join('\n');
  }
  return String(content);
}

/** 线格式消息（GenerateOptions.messages）→ 拼接文本（content �?text 块数组）�?*/
export function wireMessageText(m                                                         )         {
  return m.content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
}

// ---------------------------------------------------------------------------
// BlobSink �?DSH storage 桥（state-handle / obs-broker 共用�?IO 胶水，非业务逻辑�?// ---------------------------------------------------------------------------

/** 镜像 dsh-storage/lib/types/backend.d.ts KvUnit（rc.1 :82-159；duck-type�?*/
                             
                                                                                           
                                                                       
                         
 
/** 镜像 dsh-storage/lib/types/index.d.ts Storage + registry.d.ts BackendRegistry（duck-type�?*/
                              
                                                                                               
 

/**
 * per-record 布局的表键须匹配 [a-zA-Z0-9_-]+（backend.d.ts:96-98），而键族含
 * sha256 hex（天然安全）与句柄串（含 ':' '@' '/'）——统一确定性净化；
 * read 走同一映射。理论碰撞（'a:b' vs 'a_b'）对内容寻址键族不构成实际问题，如实记录�? */
export function safeKvKey(key        )         {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_') || 'root';
}

export function bytesToB64(data            )         {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}

export function b64ToBytes(b64        )             {
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * 内核 BlobSink 适配：内存覆盖读 + 写回后异�?putRecord 持久�? * 内核 write 是同�?void——异步层不回压，持久化失败告警留痕不毁任务（红线 5）�? * attach() 前写入只进内存（fail-open 降级窗口）；attach 时用持久层水合内存�? */
export class DurableBlobSink                     {
           #mem = new Map                    ();
           #warn      ;
           #onFault                                                       ;
  #unit                        ;
  #pending                       = [];

  constructor(warn      , onFault                                                       ) {
    this.#warn = warn;
    this.#onFault = onFault;
  }

  get attached()          {
    return this.#unit !== undefined;
  }

  attach(unit            , hydrate                             )       {
    this.#unit = unit;
    for (const [key, data] of hydrate) this.#mem.set(key, data);
  }

  write(key        , data            )       {
    this.#mem.set(key, data);
    const unit = this.#unit;
    if (unit === undefined) return;
    const put = unit
      .putRecord('blobs', safeKvKey(key), { b64: bytesToB64(data) })
      .catch((error) => {
        this.#onFault('persist-error', { key, error: String(error) });
        this.#warn(`blob ${key.slice(0, 12)}�?持久化失败（内存继续服务）`, error);
      });
    this.#pending.push(put);
  }

  read(key        )                         {
    return this.#mem.get(key);
  }

  /** 内核 obs �?BlobSink 面（put(ref, string)）桥接�?*/
  asTextSink()                                                                                        {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    return {
      put: (ref, content) => this.write(ref, encoder.encode(content)),
      readRaw: (ref) => {
        const data = this.read(ref);
        return data === undefined ? undefined : decoder.decode(data);
      },
    };
  }

  async flush()                {
    await Promise.allSettled([...this.#pending]);
    this.#pending = [];
  }
}

/** 从持久层水合 blobs �?�?attach 用的键值对（state-handle 启动路径）�?*/
export function hydrateFromUnit(unit            )                                       {
  return unit.loadAll().then((all) => {
    const out                              = [];
    for (const [key, value] of Object.entries(all.tables['blobs'] ?? {})) {
      const b64 = (value                     )?.b64;
      if (typeof b64 === 'string') out.push([key, b64ToBytes(b64)]);
    }
    return out;
  });
}

/** 打开 staging/state 共用�?KvUnit（后端固�?'json'；失败返�?undefined 由调用方降级）�?*/
export async function openKvUnit(storage                         , unit        , tables                   )                                  {
  return (await storage?.backend?.get('json')?.kv?.open({ name: unit, version: 1, tables: [...tables], hasGlobal: false, layout: 'per-record' })) ?? undefined;
}

/** 复用内核逐行 diff 的临时载体（action-gate diffStaged 用；零业务逻辑重写）�?*/
export function kernelDiffer()             {
  return new StateStore();
}

