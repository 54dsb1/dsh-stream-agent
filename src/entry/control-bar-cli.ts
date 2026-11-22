#!/usr/bin/env node
// entry/control-bar-cli.ts —— 控制栏命令行（v0.2.1）
//
//   dsh-stream-agent            进入交互控制栏（TTY）
//   dsh-stream-agent bar        同上（显式）
//   dsh-stream-agent bar --once 打印一次面板就退出（非 TTY 自动如此）
//   dsh-stream-agent status     一行状态（--json 输出机器可读）
//   dsh-stream-agent mode lean  直接切模式（balanced / lean / compat / power）
//   dsh-stream-agent lang en    直接切语言（zh / en）
//   dsh-stream-agent help       全模式指南
//
// 交互键位：1-4 选模式 · ↑↓/jk 移动 · Enter 应用 · l 中/英 · ? 帮助 · r 重置 · q 退出
//
// 零依赖：只用 node:process 与内核渲染（kernel/control-bar.ts 是唯一输出源，
// 保证 CLI 与插件装载横幅的中英文案、宽度、语义完全一致）。

import { readdirSync } from 'node:fs';
import { CHANNEL_SPECS, TIER_SPECS, getChannel, getTier, isChannelId, isLegacyModeId, isTierId, resolveLegacyMode } from '../kernel/modes.ts';
import { PROTOCOL_LEVELS, PROTOCOL_SECTION_IDS, protocolPreview, SECTION_TEXTS } from '../kernel/protocol.ts';
import type { ComposeProtocolOptions, ProtocolLevel, ProtocolSectionId } from '../kernel/protocol.ts';
import { DEFAULT_CODE_PROTOCOL_SECTION, DEFAULT_CALL_PROTOCOL_SECTION } from './loop.ts';
import {
  createControlState,
  isLang,
  renderBanner,
  renderHelp,
  renderJson,
  renderPanel,
  renderStatusBar,
  t,
} from '../kernel/control-bar.ts';
import type { ControlState, Lang } from '../kernel/control-bar.ts';
import { VERSION } from '../version.ts';
import { controlFileOf, readPersistedControl, writePersistedControl } from './control-state.ts';
import { ControlSession } from './control-session.ts';
import { resolveStateDir } from './json-persistence.ts';
import { appendIntentRecord, intentFileOf, loadIntentRecords, pendingIntents } from './intent-log.ts';

const CLEAR = '\x1b[2J\x1b[H';

function columns(): number {
  return process.stdout.columns ?? 80;
}

function loadState(): ControlState {
  const { state } = readPersistedControl();
  return createControlState(state);
}

function save(state: ControlState): string {
  return writePersistedControl(state);
}

function print(lines: readonly string[]): void {
  process.stdout.write(`${lines.join('\n')}\n`);
}

function usage(lang: Lang): string[] {
  const zh = lang === 'zh';
  return [
    zh ? '用法' : 'Usage',
    '  dsh-stream-agent [bar] [--once] [--json]    ' + (zh ? '控制栏（交互 / 一次性）' : 'control bar (interactive / once)'),
    '  dsh-stream-agent status [--json]            ' + (zh ? '当前通道/档位与语言' : 'current channel/tier and language'),
    '  dsh-stream-agent channel <standard|code>    ' + (zh ? '① 执行通道' : 'block A: execution channel'),
    '  dsh-stream-agent tier <light|standard|deep> ' + (zh ? '② 上下文档位（只改数值）' : 'block B: context tier (numbers only)'),
    '  dsh-stream-agent mode <balanced|lean|compat|power>',
    '        ' + (zh ? '旧模式值（0.5.x 别名 → channel/tier，0.6.0 移除）' : 'legacy mode value (0.5.x alias → channel/tier, removed in 0.6.0)'),
    '  dsh-stream-agent lang <zh|en>',
    '  dsh-stream-agent intents [--ack <sessionId>] ' + (zh ? 'F6 意图核对：列出"有意图无回执"（--ack 人工确认后闭合）' : 'F6 intent triage: list intents without receipts (--ack to close)'),
    '  dsh-stream-agent protocol [--level <full|lean|minimal>] [--sections plan=off,...]',
    '        ' + (zh ? '协议组装预览：逐段字符数 + 总量对比 full + 组装全文（--stats-only 只看数字）'
      : 'protocol composition preview: per-section chars, total vs full, composed text (--stats-only)'),
    '  dsh-stream-agent help                       ' + (zh ? '两区块指南' : 'two-block guide'),
    '',
    zh ? '状态文件' : 'State file',
    `  ${controlFileOf()}`,
  ];
}

// ---------------------------------------------------------------------------
// 交互模式
// ---------------------------------------------------------------------------

function runInteractive(initial: ControlState): void {
  const session = new ControlSession(initial, {
    save: (next) => save(next),
    columns: () => process.stdout.columns,
  });

  const draw = (): void => {
    process.stdout.write(session.frame());
  };

  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  draw();

  let finished = false;
  const cleanup = (): void => {
    if (finished) return;
    finished = true;
    stdin.off('data', onData);
    stdin.setRawMode?.(false);
    stdin.pause();
    process.stdout.write(`${CLEAR}${renderStatusBar(session.state, { version: VERSION })}\n`);
    process.exit(0);
  };

  function onData(chunk: string): void {
    for (const key of splitKeys(chunk)) {
      const result = session.handle(key);
      if (result.quit) {
        cleanup();
        return;
      }
      if (result.changed) draw();
    }
  }

  process.on('SIGINT', cleanup);
  stdin.on('data', onData);
}

/** 把一次 data chunk 拆成按键序列（方向键是 \x1b[A / \x1b[B 三字节）。 */
export function splitKeys(chunk: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === '\x1b' && chunk[i + 1] === '[' && i + 2 < chunk.length) {
      keys.push(chunk.slice(i, i + 3));
      i += 3;
      continue;
    }
    keys.push(chunk[i]);
    i += 1;
  }
  return keys;
}

// ---------------------------------------------------------------------------
// v0.4.1 协议组装预览（protocol 子命令；纯函数导出供测试，main 只负责打印）
// ---------------------------------------------------------------------------

/** 把 `k=v` 逗号表解析成段开关：v ∈ true/on/1 | false/off/0；其余值返回错误行。 */
export function parseSectionFlags(spec: string): { sections: Partial<Record<ProtocolSectionId, boolean>> } | { error: string } {
  const sections: Partial<Record<ProtocolSectionId, boolean>> = {};
  for (const pair of spec.split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return { error: trimmed };
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim().toLowerCase();
    if (!(PROTOCOL_SECTION_IDS as readonly string[]).includes(key)) return { error: `${trimmed}（未知段）` };
    if (raw === 'true' || raw === 'on' || raw === '1') sections[key as ProtocolSectionId] = true;
    else if (raw === 'false' || raw === 'off' || raw === '0') sections[key as ProtocolSectionId] = false;
    else return { error: trimmed };
  }
  return { sections };
}

/** protocol 子命令本体：组装 + 逐段统计 + 文本（--stats-only 只给数字；--json 机器可读）。 */
export function protocolCommand(args: readonly string[], lang: Lang): { code: number; lines: string[] } {
  const zh = lang === 'zh';
  const json = args.includes('--json');
  const statsOnly = args.includes('--stats-only');
  const noCall = args.includes('--no-call');
  const withCode = args.includes('--code');
  const noPlan = args.includes('--no-plan');
  const appendIdx = args.indexOf('--append');
  const append = appendIdx >= 0 ? args[appendIdx + 1] : undefined;

  let level: ProtocolLevel = 'full';
  const levelIdx = args.indexOf('--level');
  if (levelIdx >= 0) {
    const raw = args[levelIdx + 1];
    if (raw === undefined || !(PROTOCOL_LEVELS as readonly string[]).includes(raw)) {
      return { code: 2, lines: [`${zh ? '未知档位' : 'Unknown level'}: ${raw ?? '（缺参）'}（${PROTOCOL_LEVELS.join('|')}）`] };
    }
    level = raw as ProtocolLevel;
  }

  let sections: Partial<Record<ProtocolSectionId, boolean>> | undefined;
  const sectionsIdx = args.indexOf('--sections');
  if (sectionsIdx >= 0) {
    const spec = args[sectionsIdx + 1];
    if (spec === undefined) return { code: 2, lines: [zh ? '--sections 缺参（如 plan=off,timing=on）' : '--sections needs a value (e.g. plan=off,timing=on)'] };
    const parsed = parseSectionFlags(spec);
    if ('error' in parsed) return { code: 2, lines: [`${zh ? '段开关格式错' : 'Bad section flag'}: ${parsed.error}`] };
    sections = parsed.sections;
  }
  if (typeof append === 'string' && appendIdx >= 0 && args[appendIdx + 1] === undefined) {
    return { code: 2, lines: [zh ? '--append 缺参' : '--append needs a value'] };
  }

  const opts: ComposeProtocolOptions = { level, sections, enablePlan: noPlan ? false : undefined };
  const preview = protocolPreview(opts);

  // 通道段与追加段（与驱动器组装同序：基座 + code + call + append；这里如实计入总量）
  const codeSection = withCode ? `\n\n${DEFAULT_CODE_PROTOCOL_SECTION}` : '';
  const callSection = noCall ? '' : `\n\n${DEFAULT_CALL_PROTOCOL_SECTION}`;
  const appendSection = append !== undefined && append !== '' ? `\n\n${append}` : '';
  const extra = codeSection.length + callSection.length + appendSection.length;
  const total = preview.chars + extra;
  const fullWithChannels = preview.fullChars
    + DEFAULT_CALL_PROTOCOL_SECTION.length + 2; // full 基准 = 缺省装配（call 段默认在）
  const saved = fullWithChannels - total;

  if (json) {
    return {
      code: 0,
      lines: [JSON.stringify({
        level,
        enablePlan: opts.enablePlan !== false,
        channels: { code: withCode, call: !noCall },
        appendChars: appendSection.length > 0 ? appendSection.length - 2 : 0,
        sections: preview.sections,
        baseChars: preview.chars,
        totalChars: total,
        fullBaselineChars: fullWithChannels,
        savedChars: saved,
        ...(statsOnly ? {} : { text: preview.text + codeSection + callSection + appendSection }),
      })],
    };
  }

  const lines: string[] = [
    zh ? '协议组装预览（v0.4.1 组件化）' : 'Protocol composition preview (v0.4.1)',
    `  level=${level}  enablePlan=${opts.enablePlan !== false}  code=${withCode ? 'on' : 'off'}  call=${noCall ? 'off' : 'on'}  append=${appendSection.length > 0 ? `${appendSection.length - 2}${zh ? '字符' : ' chars'}` : 'off'}`,
    '',
  ];
  const width = Math.max(...preview.sections.map((s) => s.id.length));
  for (const s of preview.sections) {
    const name = s.id.padEnd(width);
    if (!s.included) {
      const dropped = SECTION_TEXTS.full[s.id]?.length ?? 0;
      lines.push(zh
        ? `  ${name}   落选（省 ${dropped} 字符）`
        : `  ${name}   excluded (saves ${dropped} chars)`);
    } else {
      const fallback = s.source !== level ? (zh ? 'full（回退）' : 'full (fallback)') : level;
      lines.push(`  ${name}   ${String(s.chars).padStart(5)}  ${fallback}`);
    }
  }
  lines.push('',
    zh
      ? `合计 ${total} 字符（full 缺省装配基准 ${fullWithChannels}；${saved >= 0 ? `省 ${saved} / ${(saved / fullWithChannels * 100).toFixed(1)}%` : `多 ${-saved} 字符（加回段/追加）`}）`
      : `Total ${total} chars (full default baseline ${fullWithChannels}; ${saved >= 0 ? `saved ${saved} / ${(saved / fullWithChannels * 100).toFixed(1)}%` : `${-saved} chars added back`})`);
  if (!statsOnly) {
    lines.push('', zh ? '—— 组装全文 ——' : '—— composed text ——', preview.text + codeSection + callSection + appendSection);
  }
  return { code: 0, lines };
}

// ---------------------------------------------------------------------------
// 命令分发
// ---------------------------------------------------------------------------

function main(argv: readonly string[]): number {
  const args = [...argv];
  const json = args.includes('--json');
  const once = args.includes('--once');
  const rest = args.filter((a) => a !== '--json' && a !== '--once');
  const command = rest[0] ?? 'bar';
  const state = loadState();

  switch (command) {
    case '--version':
    case '-v':
    case 'version':
      process.stdout.write(`${VERSION}\n`);
      return 0;

    case '--help':
    case '-h':
    case 'help': {
      // 帮助 = 全模式指南（新人真正要看的）+ 用法；不再重复引导横幅
      print(renderHelp(state, { version: VERSION, columns: columns() }));
      print(['', ...usage(state.lang)]);
      return 0;
    }

    case 'status': {
      if (json) {
        process.stdout.write(`${renderJson(state, { version: VERSION })}\n`);
      } else {
        print([
          renderStatusBar(state, { version: VERSION }),
          `${t('docs', state.lang)}: README.md#control-bar`,
        ]);
      }
      return 0;
    }

    case 'channel': {
      // 0.5.0 区块 A：执行通道（standard / code）
      const target = rest[1];
      if (target === undefined) {
        print([`${t('blockA', state.lang)}: ${CHANNEL_SPECS.map((c) => `${c.order}=${c.id}`).join('  ')}`]);
        return 1;
      }
      if (!isChannelId(target)) {
        print([t('unknownChannel', state.lang)]);
        return 2;
      }
      const next: ControlState = { ...state, channel: target };
      const file = save(next);
      if (json) {
        process.stdout.write(`${renderJson(next, { version: VERSION })}\n`);
      } else {
        print([`${t('blockA', state.lang)} → ${getChannel(target).label[state.lang]}（${target}）`,
          `${t('saved', state.lang)}: ${file}`]);
      }
      return 0;
    }

    case 'tier': {
      // 0.5.0 区块 B：上下文档位（light / standard / deep——只改数值）
      const target = rest[1];
      if (target === undefined) {
        print([`${t('blockB', state.lang)}: ${TIER_SPECS.map((x) => `${x.order + 2}=${x.id}`).join('  ')}`]);
        return 1;
      }
      if (!isTierId(target)) {
        print([t('unknownTier', state.lang)]);
        return 2;
      }
      const next: ControlState = { ...state, tier: target };
      const file = save(next);
      if (json) {
        process.stdout.write(`${renderJson(next, { version: VERSION })}\n`);
      } else {
        print([`${t('blockB', state.lang)} → ${getTier(target).label[state.lang]}（${target}）`,
          `${t('saved', state.lang)}: ${file}`]);
      }
      return 0;
    }

    case 'mode': {
      // 0.5.x 别名（0.6.0 移除）：旧模式值 → (channel, tier)，输出一行 warn
      const target = rest[1];
      if (target === undefined) {
        print([`${t('mode', state.lang)}: balanced / lean / compat / power（${state.lang === 'zh' ? '旧值，走别名' : 'legacy values, aliased'}）`]);
        return 1;
      }
      if (!isLegacyModeId(target)) {
        print([`${t('unknownChannel', state.lang)} / ${t('unknownTier', state.lang)}（${state.lang === 'zh' ? '旧模式值可选: balanced|lean|compat|power' : 'legacy values: balanced|lean|compat|power'}）`]);
        return 2;
      }
      const mapped = resolveLegacyMode(target);
      const next: ControlState = { ...state, channel: mapped.channel, tier: mapped.tier };
      const file = save(next);
      if (json) {
        process.stdout.write(`${renderJson(next, { version: VERSION })}\n`);
      } else {
        print([`${state.lang === 'zh' ? '旧模式' : 'legacy mode'} ${target} → channel=${mapped.channel} tier=${mapped.tier}（${state.lang === 'zh' ? '别名映射；0.5.x 保留，0.6.0 移除' : 'aliased; kept in 0.5.x, removed in 0.6.0'}）`,
          `${t('saved', state.lang)}: ${file}`]);
      }
      return 0;
    }

    case 'lang': {
      const target = rest[1];
      if (!isLang(target)) {
        print([t('unknownLang', state.lang)]);
        return 2;
      }
      const next: ControlState = { ...state, lang: target };
      save(next);
      print([renderStatusBar(next, { version: VERSION, columns: columns() })]);
      return 0;
    }

    case 'intents': {
      // F6 停机核对出口：列出各会话"有意图无回执"（pending）与失败意图（failed）；
      // --ack <sessionId> 追加 ack 记录闭合全部 pending（人工确认"未发生/放弃"后执行）。
      const stateRoot = resolveStateDir();
      const intentsDir = `${stateRoot}/intents`;
      const ackTarget = rest[1] === '--ack' ? rest[2] : undefined;
      const zh = state.lang === 'zh';
      let sessions: string[] = [];
      try {
        sessions = readdirSync(intentsDir).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, ''));
      } catch {
        sessions = [];
      }
      if (sessions.length === 0) {
        print([zh ? '没有意图日志（无写入或 F6 未启用）。' : 'No intent logs (no writes, or F6 disabled).']);
        return 0;
      }
      if (ackTarget !== undefined) {
        const file = intentFileOf(stateRoot, ackTarget);
        if (!sessions.includes(ackTarget)) {
          print([zh ? `未知会话：${ackTarget}` : `Unknown session: ${ackTarget}`]);
          return 2;
        }
        const { records } = loadIntentRecords(file);
        const open = pendingIntents(records).filter((p) => p.state === 'pending');
        if (open.length === 0) {
          print([zh ? `会话 ${ackTarget} 没有待核对的意图。` : `Session ${ackTarget} has no pending intents.`]);
          return 0;
        }
        appendIntentRecord(file, { type: 'ack', seq: records.length + 1, at: new Date().toISOString(), intentSeqs: open.map((p) => p.intent.seq), note: 'cli --ack' });
        print([zh
          ? `已确认 ${open.length} 条意图（会话 ${ackTarget}）：下一次 resume 不再停机核对。`
          : `Acked ${open.length} intent(s) for session ${ackTarget}: next resume will not halt.`]);
        return 0;
      }
      const lines: string[] = [zh ? '写前意图核对（F6）：' : 'Intent triage (F6):'];
      for (const session of sessions) {
        const { records, badLines } = loadIntentRecords(intentFileOf(stateRoot, session));
        const pending = pendingIntents(records).filter((p) => p.state === 'pending');
        const failed = pendingIntents(records).filter((p) => p.state === 'failed');
        lines.push(`  ${session}: ${zh ? '待核对' : 'pending'} ${pending.length} · ${zh ? '失败已闭合' : 'failed(closed)'} ${failed.length}${badLines > 0 ? ` · ${zh ? '坏行' : 'bad lines'} ${badLines}` : ''}`);
        for (const p of pending) {
          lines.push(`    - [seq ${p.intent.seq}] ${p.intent.op} ${p.intent.path} (cmd=${p.intent.cmdId} fp=${p.intent.fingerprint} at=${p.intent.at})`);
        }
      }
      lines.push('', zh
        ? '待核对 = 写入可能已发生（进程在写入中被杀）。人工核对文件后：dsh-stream-agent intents --ack <sessionId> 闭合；'
        : 'Pending = the write MAY have happened (process killed mid-write). Verify files, then run: dsh-stream-agent intents --ack <sessionId>');
      print(lines);
      return 0;
    }

    case 'protocol': {
      // main() 已把 --json 从 rest 里滤掉，这里按需回传给 protocolCommand
      const result = protocolCommand(json ? [...rest.slice(1), '--json'] : rest.slice(1), state.lang);
      print(result.lines);
      return result.code;
    }

    case 'bar': {
      const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true && !once;
      if (!interactive) {
        print(renderPanel(state, { version: VERSION, columns: columns() }));
        if (process.stdin.isTTY !== true) print(['', `  ${t('notTty', state.lang)}`]);
        return 0;
      }
      runInteractive(state);
      return 0;
    }

    default:
      print([`${t('usage', state.lang)}: dsh-stream-agent [bar|status|channel|tier|mode|lang|intents|protocol|help]`]);
      return 2;
  }
}

const invokedDirectly = (process.argv[1] ?? '').endsWith('control-bar-cli.js')
  || (process.argv[1] ?? '').endsWith('control-bar-cli.ts');

if (invokedDirectly) {
  // 管道下游提前关闭（`| head`）不是错误：安静退出，别把 EPIPE 栈打到用户脸上
  process.stdout.on('error', (error: { code?: string }) => {
    if (error?.code === 'EPIPE') process.exit(0);
  });
  process.exitCode = main(process.argv.slice(2));
}
