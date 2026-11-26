// kernel/security.ts —— 默认密钥保护（0.6.0 正式版，对齐 thinkflow security.py 的插件侧子功能）
//
// 覆盖核验（2026-11-25 独立审计）确认的两个缺口之一：
//   · 默认密钥文件拒读（[TF]/security.py:15-31 DEFAULT_SECRET_PATTERNS + :193-199 读拒绝）；
//   · 模型可见输出脱敏（[TF]/security.py:33-35 SENSITIVE_ASSIGNMENT_RE + :223-225 redact_text；
//     [TF]/output_capture.py:19-41 落盘/回显前脱敏）。
// 宿主沙箱只做路径根约束（dsh-fs-sandbox），dsh-client-ui-secret-mask 自述 "Pure UI"——
// 两者都不覆盖"进模型请求的内容"，因此本子功能落在插件观测管线（entry 接线，内核纯函数）。
//
// 内核纪律：零 IO、零框架依赖。路径判定只看 basename（与 TF 一致）；
// 沙箱根约束 / 危险命令审批 / 进程持有仍属宿主职责（porting-matrix §5）。

/** 与 [TF]/security.py:15-31 逐项一致的默认密钥文件名模式（fnmatch 语义）。 */
export const DEFAULT_SECRET_PATTERNS                    = [
  '.env',
  '.env.*',
  'config.json',
  'config.local.json',
  'config.*.local.json',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa',
  'id_ed25519',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'secrets.*',
];

/** fnmatch 风格（* ? [...]）→ 正则；只用于 basename，不跨路径分隔符。 */
function globToRegExp(pattern        )         {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '[^/\\\\]*';
    else if (ch === '?') out += '[^/\\\\]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

const SECRET_REGEXPS = DEFAULT_SECRET_PATTERNS.map(globToRegExp);

/** 路径 basename 是否命中默认密钥模式（大小写不敏感，与 fnmatch 在 Windows 的行为一致）。 */
export function isSecretPath(path        )          {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (base === '') return false;
  return SECRET_REGEXPS.some((re) => re.test(base));
}

/**
 * tf-call 旁路封堵（0.6.0 收口，核验 P1-1）：通用调用体的 JSON 参数里，
 * 任何"路径形态"的键值命中密钥模式即返回该值（read/grep/glob 等宿主工具都能被这样指向 .env）。
 * 只检查常见路径键（值须像路径且非空）；解析失败（非 JSON）返回 null——不猜测，交给宿主沙箱。
 */
export const PATH_ARG_KEYS = ['path', 'file', 'file_path', 'filepath', 'filename', 'target', 'target_path']         ;

export function secretPathInArgs(bodyJson        )                {
  let parsed         ;
  try {
    parsed = JSON.parse(bodyJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed                           ;
  for (const key of PATH_ARG_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value !== '' && isSecretPath(value)) return value;
  }
  return null;
}

/** 拒读文案（结构化失败注入；fail-closed 但给出明确出路，不是"让用户去操作"的死路）。 */
export function secretReadRefusalDetail(path        )         {
  return `[secret] 拒绝读取疑似密钥文件: ${path}（默认密钥保护，对齐 thinkflow security.py）。`
    + '如确需读取，请在装配 config 显式设置 allowSensitivePaths: true；否则请改用不含密钥的副本或脱敏后的内容。';
}

/**
 * 敏感赋值正则（基线对齐 [TF]/security.py:33-35，0.6.0 正式版两处加固）：
 * ① 键名允许尾随复合词（AWS_SECRET_ACCESS_KEY / SECRET_ACCESS_KEY 等，上游原式漏命中）；
 * ② 引号内的值允许空格/逗号（password="my secret pass"，上游原式整条漏匹配）。
 * 键名/引号形状保留，值 → [REDACTED]。
 */
const SENSITIVE_ASSIGNMENT_RE =
  /(["']?(?:api[_-]?key|token|secret|password|access[_-]?token|refresh[_-]?token|bearer[_-]?token)[A-Za-z0-9_]*["']?\s*[:=]\s*)(?:(["'])([^"']+)\2|([^"'\s,}]+))/gi;

/** 模型可见文本脱敏（观测登记前调用；幂等：[REDACTED] 不再二次命中值形态）。 */
export function redactSecrets(text        )         {
  if (text === '') return text;
  return text.replace(SENSITIVE_ASSIGNMENT_RE, (_match, prefix        , quote                    , quoted                    , bare                    ) => {
    if (quote !== undefined && quoted !== undefined) return `${prefix}${quote}[REDACTED]${quote}`;
    return `${prefix}[REDACTED]`;
  });
}

/** 文本是否含可脱敏内容（快照可用性判定用，对齐 [TF]/changes.py:153 sensitive_content）。 */
export function hasSensitiveContent(text        )          {
  SENSITIVE_ASSIGNMENT_RE.lastIndex = 0;
  const found = SENSITIVE_ASSIGNMENT_RE.test(text);
  SENSITIVE_ASSIGNMENT_RE.lastIndex = 0;
  return found;
}