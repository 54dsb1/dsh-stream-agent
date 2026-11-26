/**
 * kernel/delivery.ts —— 交付物机器判定（1.2，对齐 thinkflow delivery.py）
 *
 * 内核纪律：零 IO、零框架依赖、纯函数。判定所需的文件事实由调用方通过
 * `DeliveryFacts` 注入；命令序列只产出 `VerificationCommand[]`，由驱动器经
 * executeTools 端口派发（不自建进程/文件系统访问）。
 *
 * 对齐依据：[TF]/delivery.py
 *   - verify_delivery(:120)：无 node_modules 时先 npm install，再 npm run build；任一步失败即短路。
 *   - DeliveryChecks.observe(:141)：记录每个成功写操作的 revision；脚本文件待验证。
 *   - script_feedback(:159)：提示逐个直接运行可运行脚本。
 *
 * 验收谓词语法（tf-plan 验收项文本尾部 `:: <predicate>`，见 §2.4）：
 *   exists(path)              文件存在
 *   sha256(path, hex...)      sha256 摘要精确匹配（大小写不敏感）
 *   bytes(path, op, n)        op ∈ {min,max,eq}；字节数比较
 *   regex(path, /pattern/)    文件内容正则命中（flags 由 /.../flags 给出）
 */

export interface DeliveryFacts {
  /** 读取文件事实；不存在返回 null。只读，不抛错。 */
  stat(path: string): { exists: boolean; bytes?: number; sha256?: string; text?: string } | null;
}

export type AcceptancePredicate =
  | { kind: 'exists'; path: string }
  | { kind: 'sha256'; path: string; hash: string }
  | { kind: 'bytes'; path: string; op: 'min' | 'max' | 'eq'; n: number }
  | { kind: 'regex'; path: string; pattern: string; flags: string };

export interface VerificationCommand {
  /** 命令名（映射宿主 native tool，通常 'bash'）与 argv 字符串。 */
  name: 'bash';
  cmd: string;
  cwd?: string;
  /** 该步的目的，供 ledger/注入说明。 */
  purpose: 'install' | 'build';
}

export interface PredicateResult {
  ok: boolean;
  /** 机器可读原因；可注入 [tf-stream:error] 供模型修正。 */
  detail: string;
}

const PREDICATE_RE = /::\s*(exists|sha256|bytes|regex)\((.*)\)\s*$/;

/** 从验收项文本解析尾部谓词。无谓词返回 null（该验收项仍走回执语义）。 */
export function parseAcceptancePredicate(text: string): { text: string; predicate: AcceptancePredicate | null } {
  const m = PREDICATE_RE.exec(text);
  if (m === null) return { text: text.trim(), predicate: null };
  const base = text.slice(0, m.index).trim();
  const kind = m[1]!;
  const args = splitArgs(m[2] ?? '');
  try {
    switch (kind) {
      case 'exists':
        if (args.length !== 1 || args[0]!.trim() === '') return { text: base, predicate: null };
        return { text: base, predicate: { kind: 'exists', path: args[0]!.trim() } };
      case 'sha256':
        if (args.length !== 2 || !/^[0-9a-f]{64}$/i.test(args[1]!.trim())) return { text: base, predicate: null };
        return { text: base, predicate: { kind: 'sha256', path: args[0]!.trim(), hash: args[1]!.trim().toLowerCase() } };
      case 'bytes': {
        if (args.length !== 3) return { text: base, predicate: null };
        const op = args[1]!.trim();
        if (op !== 'min' && op !== 'max' && op !== 'eq') return { text: base, predicate: null };
        if (!/^\d+$/.test(args[2]!.trim())) return { text: base, predicate: null };
        return { text: base, predicate: { kind: 'bytes', path: args[0]!.trim(), op, n: Number(args[2]!.trim()) } };
      }
      case 'regex': {
        // 语法 regex(path, /pattern/flags)：args[0]=path，其余拼回正则（pattern 内可含逗号）。
        if (args.length < 2) return { text: base, predicate: null };
        const path = args[0]!.trim();
        const spec = args.slice(1).join(',').trim();
        const rm = /^\/(.*)\/([gimsuy]*)$/.exec(spec);
        if (rm === null || path === '') return { text: base, predicate: null };
        return { text: base, predicate: { kind: 'regex', path, pattern: rm[1]!, flags: rm[2] ?? '' } };
      }
    }
  } catch {
    return { text: base, predicate: null };
  }
}

/**
 * 逗号分词：路径含 `/`（dist/x.js）是合法值，不能把每个 `/` 当正则定界符。
 * 只有"参数起始处的 `/`"才开启 regex 模式（前面是逗号/左括号/空白且已跳过空白）；
 * regex 内的第二个 `/` 后跟 flags 时结束。regex 内的逗号不切分。
 */
function splitArgs(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let inRegex = false;
  let regexClosed = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const prev = i === 0 ? '' : raw[i - 1]!;
    if (ch === '/' && !inRegex && !regexClosed && (prev === '' || prev === ',' || prev === ' ' || prev === '(')) {
      inRegex = true;
      cur += ch;
      continue;
    }
    if (ch === '/' && inRegex) {
      inRegex = false;
      regexClosed = true;
      cur += ch;
      continue;
    }
    if (!inRegex && ch === '(') depth++;
    if (!inRegex && ch === ')') depth--;
    if (ch === ',' && depth === 0 && !inRegex) {
      out.push(cur);
      cur = '';
      regexClosed = false;
    } else {
      cur += ch;
    }
  }
  if (cur !== '' || raw.endsWith(',')) out.push(cur);
  return out;
}

/** 求值一条谓词。文件事实缺失一律判 false（fail-closed），不猜测。 */
export function evaluatePredicate(predicate: AcceptancePredicate, facts: DeliveryFacts): PredicateResult {
  const stat = facts.stat(predicate.path);
  const label = describePredicate(predicate);
  if (stat === null || !stat.exists) {
    return { ok: false, detail: `${label}：文件不存在或不可读（${predicate.path}）` };
  }
  switch (predicate.kind) {
    case 'exists':
      return { ok: true, detail: `${label}：存在` };
    case 'sha256': {
      const actual = (stat.sha256 ?? '').toLowerCase();
      const ok = actual === predicate.hash;
      return { ok, detail: ok ? `${label}：匹配` : `${label}：摘要不符（实际 ${actual || '未知'}，期望 ${predicate.hash}）` };
    }
    case 'bytes': {
      const actual = stat.bytes;
      if (actual === undefined) return { ok: false, detail: `${label}：无法取得字节数` };
      const ok = predicate.op === 'min' ? actual >= predicate.n : predicate.op === 'max' ? actual <= predicate.n : actual === predicate.n;
      const opText = predicate.op === 'min' ? '≥' : predicate.op === 'max' ? '≤' : '=';
      return { ok, detail: ok ? `${label}：${actual} ${opText} ${predicate.n}` : `${label}：实际 ${actual} 不满足 ${opText} ${predicate.n}` };
    }
    case 'regex': {
      if (stat.text === undefined) return { ok: false, detail: `${label}：无法读取文本` };
      let re: RegExp;
      try {
        re = new RegExp(predicate.pattern, predicate.flags);
      } catch (error) {
        return { ok: false, detail: `${label}：正则无效（${String(error)}）` };
      }
      const ok = re.test(stat.text);
      return { ok, detail: ok ? `${label}：命中` : `${label}：未命中` };
    }
  }
}

export function describePredicate(predicate: AcceptancePredicate): string {
  switch (predicate.kind) {
    case 'exists': return `exists(${predicate.path})`;
    case 'sha256': return `sha256(${predicate.path})`;
    case 'bytes': return `bytes(${predicate.path}, ${predicate.op}, ${predicate.n})`;
    case 'regex': return `regex(${predicate.path}, /${predicate.pattern}/${predicate.flags})`;
  }
}

/**
 * 交付构建步骤（对齐 verify_delivery:120）：无 package.json 时无需构建；有则
 * 无 node_modules 时先 npm install，再 npm run build。调用方按序执行，任一步失败短路。
 * 纯函数：不检查真实文件存在性，`hasPackageJson` / `hasNodeModules` 由注入事实给出。
 */
export function buildVerificationPlan(opts: {
  hasPackageJson: boolean;
  hasNodeModules: boolean;
  cwd?: string;
}): VerificationCommand[] {
  if (!opts.hasPackageJson) return [];
  const out: VerificationCommand[] = [];
  if (!opts.hasNodeModules) out.push({ name: 'bash', cmd: 'npm install', cwd: opts.cwd, purpose: 'install' });
  out.push({ name: 'bash', cmd: 'npm run build', cwd: opts.cwd, purpose: 'build' });
  return out;
}

/** 可运行脚本的验证提示（对齐 script_feedback:159）：路径逐条、每次一个、失败即修。 */
export function scriptFeedback(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  const list = paths.map((p) => `- ${p}`).join('\n');
  return `[THINKFLOW 等价] 可运行脚本等待验证：\n${list}\n请用 tf-bash 逐个直接运行，每次一条；失败后修复并重新运行。`;
}
