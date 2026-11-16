// eval/tools/f6-kill-drill.worker.cjs —— F6 强杀演练的 worker（被父进程按轮次 SIGKILL）
//
// 职责：
//   1. 铺 3 个变更命令（tf-write ×3）+ tf-final 的 mock 剧本；
//   2. 接真实意图日志端口（fsync 落盘到 --state-dir/intents/<session>.jsonl）；
//   3. 按时点向 stdout 打 READY:<point>，让父进程在精确窗口 SIGKILL：
//      before-write = 第 1 个写命令的意图已落盘、宿主工具未执行
//      mid-write    = 第 1 个写命令的宿主工具执行中（内部挂起 300ms 制造窗口）
//      after-write  = 第 3 个写入已落盘、回执尚未落盘（最宽的"不确定"窗口）
//   4. 工具执行器真实写文件（--ws 工作区），写入内容带唯一标记供对账。
//
// 零 API：mock 模型驱动，不需要 dsh / apikey。

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const PKG_ROOT = path.resolve(__dirname, '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

/** Windows 绝对路径 → file:// URL（ESM 动态导入要求）。 */
function importDist(rel) {
  return import(pathToFileURL(path.join(PKG_ROOT, rel)).href);
}

const point = arg('point', 'before-write');
const stateDir = arg('state-dir');
const wsDir = arg('ws');
const sessionId = arg('session', 'drill');

process.env['STREAM_AGENT_STATE_DIR'] = stateDir;

async function main() {
  const { SingleStreamDriver, normalizeStreamShim } = await importDist('dist/entry/loop.js');
  const { createMockModel } = await importDist('dist/entry/mock-provider.js');
  const { appendIntentRecord, intentFileOf, intentFingerprint, loadIntentRecords } = await importDist('dist/entry/intent-log.js');

  const intentFile = intentFileOf(stateDir, sessionId);
  const intentBook = new Map();
  let seq = 0;
  try { seq = loadIntentRecords(intentFile).records.length; } catch { /* 首轮无文件 */ }

  let toolLog = [];
  /** 模拟"写入中"：先落半个文件 → 长窗口（父进程在此 SIGKILL）→ 落全量。
   *  mid-write 被杀时磁盘上是部分内容——这正是"不确定"态的物证。 */
  const write = async (file, content) => {
    fs.mkdirSync(path.dirname(path.join(wsDir, file)), { recursive: true });
    fs.writeFileSync(path.join(wsDir, file), content.slice(0, Math.max(1, Math.floor(content.length / 2))), 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.writeFileSync(path.join(wsDir, file), content, 'utf8');
    toolLog.push(file);
  };

  const scenario = {
    name: 'f6-drill',
    match: { promptIncludes: 'drill' },
    chunking: { charsPerChunk: 0, delayMs: 0 },
    steps: [
      { type: 'text', text: 'drill\n' },
      { type: 'commands', commands: [
        '<tf-write path="a.txt" id="w1">content-a-unique-' + sessionId + '</tf-write>',
        '<tf-write path="b.txt" id="w2">content-b-unique-' + sessionId + '</tf-write>',
        '<tf-write path="c.txt" id="w3">content-c-unique-' + sessionId + '</tf-write>',
        '<tf-final id="f1" summary="done"/>',
      ] },
      { type: 'waitTools', count: 3, timeoutMs: 20000 },
      { type: 'finish', reason: 'stop' },
    ],
  };
  const model = createMockModel({ scenarios: [scenario], provider: 'mock' });

  let sawIntentW1 = false;
  let sawReceiptW3 = false;
  const driver = new SingleStreamDriver(
    {
      stream: (options) => normalizeStreamShim(model.adapter.stream({ provider: options.provider, model: options.model, messages: options.messages, signal: options.signal })),
      executeTools: async (input) => {
        const results = [];
        for (const call of input.calls) {
          const a = JSON.parse(call.arguments);
          if (call.name === 'write') {
            // before-write：意图已落盘（onIntent 先于本函数）、写入未发生——挂死等 SIGKILL
            if (point === 'before-write') {
              process.stdout.write('READY:before-write\n');
              await new Promise(() => {});
            }
            // mid-write：半个文件已落盘、写入进行中——先报点再进入 1.5s 写入窗口
            if (point === 'mid-write' && toolLog.length === 0) {
              process.stdout.write('READY:mid-write\n');
            }
            await write(path.basename(a['file_path']), a['content']);
            results.push({ callId: call.id, result: { content: [{ type: 'text', text: `written ${a['file_path']}` }], isError: false } });
          } else {
            results.push({ callId: call.id, result: { content: [{ type: 'text', text: `${call.name}:ok` }], isError: false } });
          }
        }
        // after-write：第 3 个写回执之后
        if (point === 'after-write' && toolLog.length >= 3 && !sawReceiptW3) {
          sawReceiptW3 = true;
          process.stdout.write(`READY:after-write\n`);
          await new Promise((resolve) => setTimeout(resolve, 4000)); // 留出父进程杀的时间窗
        }
        return { results, additionalContexts: [], concluded: false };
      },
      onIntent: (event) => {
        seq += 1;
        intentBook.set(event.cmdId, seq);
        appendIntentRecord(intentFile, { type: 'intent', seq, at: new Date().toISOString(), sessionId, ...event });
      },
      onIntentReceipt: (event) => {
        seq += 1;
        appendIntentRecord(intentFile, { type: 'receipt', seq, at: new Date().toISOString(), intentSeq: intentBook.get(event.cmdId) ?? -1, ok: event.ok, detail: event.detail });
      },
      onToolSettled: () => model.notifyToolResult(),
      onWarning: () => {},
    },
    { provider: 'mock', model: 'mock-scenario', streamIdleTimeoutMs: 30_000 },
  );
  driver.pushUserTask('drill task');
  const reason = await driver.runTurn();
  process.stdout.write(`DONE:${reason.kind}\n`);
}

main().catch((error) => {
  process.stderr.write(`worker-error: ${error && error.message ? error.message : String(error)}\n`);
  process.exit(1);
});
