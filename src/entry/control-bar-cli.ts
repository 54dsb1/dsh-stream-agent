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

import { MODES, getMode, isModeId } from '../kernel/modes.ts';
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
    '  dsh-stream-agent status [--json]            ' + (zh ? '当前模式与语言' : 'current mode and language'),
    '  dsh-stream-agent mode <balanced|lean|compat|power>',
    '  dsh-stream-agent lang <zh|en>',
    '  dsh-stream-agent help                       ' + (zh ? '全模式指南' : 'full mode guide'),
    '',
    zh ? '状态文件' : 'State file',
    `  ${controlFileOf()}`,
    '',
    zh
      ? '发布提示：v0.2.1 的 npm 源最多 3 天内可用；在此之前请用仓库路径安装'
      : 'Release note: the v0.2.1 npm source lands within 3 days; install from the repo path until then',
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

    case 'mode': {
      const target = rest[1];
      if (target === undefined) {
        print([`${t('mode', state.lang)}: ${MODES.map((m) => `${m.order}=${m.id}`).join('  ')}`]);
        return 1;
      }
      if (!isModeId(target)) {
        print([t('unknownMode', state.lang)]);
        return 2;
      }
      const next: ControlState = { ...state, mode: target };
      const file = save(next);
      if (json) {
        process.stdout.write(`${renderJson(next, { version: VERSION })}\n`);
      } else {
        print([`${t('mode', state.lang)} → ${getMode(target).order} ${getMode(target).label[state.lang]}（${target}）`,
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
      print([`${t('usage', state.lang)}: dsh-stream-agent [bar|status|mode|lang|help]`, t('unknownMode', state.lang)]);
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
