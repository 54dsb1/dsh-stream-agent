# dsh-stream-agent

[![ci](https://github.com/54dsb1/dsh-stream-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/54dsb1/dsh-stream-agent/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

[简体中文](./README.md) | English

**A single-stream heart for DeepSeek Harness.** Turns "what the model sees, and when it gets interrupted" from turn-based into a single-stream protocol: the model writes all its operation commands inside one streamed request, commands execute as they close mid-stream, and a follow-up request is sent only when the model genuinely needs more information.

Verified against the real API (10 tasks, two arms, same model `deepseek-flash`): **token usage drops to 28.9% of the native loop, task correctness unchanged (10/10)**.

| | |
|---|---|
| Host | DeepSeek Harness `0.2.2-rc.1` (type anchor) / `rc.3` (runtime-tested) |
| Dependencies | Zero npm dependencies; Node ≥ 22.18 (native type stripping) |
| Tests | 250 cases green, zero API calls (full mock pipeline + 20 scenarios + activation/desktop-page regression) |
| Shape | One bundle package — install/remove with a single `dsh plugin add`; uninstall restores the native loop |
| Control bar | `dsh-stream-agent bar`: four modes + zh/en switching, with a startup guide on activation |
| Desktop page | Left-rail **Control bar**: status + four modes + zh/en switch, **without touching the Electron shell** |
| Release | npm [`@hugesb/dsh-stream-agent`](https://www.npmjs.com/package/@hugesb/dsh-stream-agent) · GitHub [Releases](https://github.com/54dsb1/dsh-stream-agent/releases) |

> **npm source notice**: the npm source for `v0.2.1` will be **available in no more than 3 days**
> (by 2026-11-19; it lands on
> [`@hugesb/dsh-stream-agent`](https://www.npmjs.com/package/@hugesb/dsh-stream-agent)).
> Until then install from the **absolute repo path** or a GitHub Release tarball; once published,
> `dsh plugin --profile desktop add @hugesb/dsh-stream-agent@0.2.1` works directly.
> Do not install 0.2.0: it fails to activate inside dsh (root cause and fix in the section below).

---

## What problem does it solve

The native loop is turn-based: one request per step, tool results stuffed back into context in full, the model reads everything before deciding what's next. Three things happen at once — **too many requests, observations re-injected repeatedly, and the prefix cache broken over and over**.

This plugin takes over that layer and changes exactly three things:

1. **Single stream** — the model writes all its `tf-*` commands consecutively inside one stream; the parser parses chunk by chunk and dispatches each command the moment it closes, executing independent commands in parallel without waiting for the stream to end.
2. **No observation backflow** — tool output returns a handle by default; the model sends `tf-peek` to fetch details by line range. Injection volume flips from "we guess" to "the model decides".
3. **Monotonic prefix** — context assembly only ever appends to the tail; a hash assertion runs before every request and refuses to send on any non-monotonic change (fail-closed). Better a clean failure than a burnt cache.

No model retraining, no upstream source changes — everything exists as plugin entries + patches.

## Install

```bash
# Option 1: bundle install (recommended — goes into the profile, survives restarts)
dsh plugin --profile headless add @hugesb/dsh-stream-agent

# Option 2: temporary overlay (development/verification — not persisted, dies with the command)
dsh --profile headless --patch ./patches/takeover.yml headless "your task"

# Option 3: desktop client (install into the desktop profile, then restart the client — bundles have no HMR)
dsh plugin --profile desktop add @hugesb/dsh-stream-agent
```

Offline, or when hacking on local sources, swap the package name above for the repo's absolute path
(`dsh plugin add /absolute/path/dsh-stream-agent`). Until the npm source is live, that is the
supported path:

```bash
dsh plugin --profile desktop add /absolute/path/dsh-stream-agent
dsh-stream-agent status          # confirms you actually loaded 0.2.1
```

Uninstall: `dsh plugin --profile <name> remove @hugesb/dsh-stream-agent`, or simply drop the patch — the takeover layer disappears entirely and native behavior returns, zero residue.

> `dsh plugin` requires `pnpm` on PATH (or a configured `pnpmCommand` in your dsh-plugin-manager).
> After installing, run `dsh-stream-agent status` once: if it prints a mode line, both the CLI and
> the state file are in place.

<a id="control-bar"></a>

## Control bar: read this first

The control bar is the 0.2.1 learning surface for new users. It has **three faces** backed by
**the same state and the same string table**:

> Do not confuse "install mode" with "runtime mode": bundle / temporary overlay / desktop are
> **install modes** (the three commands above), while balanced / lean / compat / power are
> **runtime modes** (this section). They are orthogonal — any install can switch modes at will.

| Face | When it shows up | What it is for |
|---|---|---|
| Startup banner | Once at plugin activation (stderr) | Prove takeover is active, report the mode, list the four steps |
| Interactive bar `dsh-stream-agent bar` | Any time you open it | Compare the four modes, switch mode/language directly |
| Desktop page (new in 0.2.1) | Left rail: **Control bar** | Graphical status, click-to-switch modes, zh/en; no Electron change |

The banner looks like this (`STREAM_AGENT_NO_BANNER=1` silences it; `announce: false` in the patch
does the same):

```
╭─ dsh-stream-agent v0.2.1 - CONTROL BAR ────────────────────────────────────╮
│ * TAKEOVER ACTIVE: single-stream protocol owns agent creation              │
│ Mode: 1 Balanced (balanced) | receipt | code auto | parallel 3             │
│ Use when  First run, everyday read/write and lookup tasks, or when         │
│           unsure: start here.                                              │
│                                                                            │
│ Four steps                                                                 │
│   1 Install   dsh plugin --profile desktop add <package or local path>     │
│   2 Pick mode  dsh-stream-agent mode lean (or press 1-4 in the bar)        │
│   3 Ask   describe the task; the model runs tf-* in one stream             │
│   4 Verify   dsh-stream-agent status                                       │
│                                                                            │
│ Open control bar  dsh-stream-agent bar                                     │
│ Keys  Interactive bar: 1-4 mode, l language, ? full guide                  │
│ Docs: README.md#control-bar                                                │
╰────────────────────────────────────────────────────────────────────────────╯
```

### Open and drive it

```bash
dsh-stream-agent bar          # interactive (TTY): 1-4 mode, l language, ? full guide
dsh-stream-agent bar --once   # print one panel and exit (automatic when not a TTY)
dsh-stream-agent status       # one line: current mode + parameters (takeover state comes from the banner)
dsh-stream-agent status --json  # machine readable (CI / scripts)
dsh-stream-agent mode lean    # set mode: balanced / lean / compat / power
dsh-stream-agent lang en      # set language: zh / en
dsh-stream-agent help         # full mode guide
```

Keys (identical in both languages; `--json` exposes the same fields):

| Key | Action |
|---|---|
| `1` `2` `3` `4` | Switch straight to that mode |
| `Up` / `Down` (or `k` / `j`) | Move the focus without applying |
| `Enter` | Apply the focused mode |
| `l` | Switch Chinese / English (persisted immediately) |
| `?` / `h` | Full mode guide (`q` goes back) |
| `r` | Reset to the default mode (balanced) |
| `q` / `Esc` / `Ctrl-C` | Quit |

### Four modes: which one to pick

Modes only map **existing** config knobs — they are not a second set of switches; `balanced` is
equivalent to the 0.2.0 factory default.

| Mode | One-liner | Pick it when | Trade-off |
|---|---|---|---|
| `balanced` (default) | Saves where it is safe, keeps what you need to see | First run, everyday read/write/lookup, or unsure | Write-batch re-reads of your own file return a receipt; use `tf-peek` for full text |
| `lean` | Cost-first: the budget ladder engages early | Long sessions, batch scripts, read-heavy tasks with a clear answer | A 60k budget degrades output (after 70% only high-gain observations, after 90% only `tf-final`) |
| `compat` | Closest to the native turn-based feel, commands run serially | Behavior looks off, you are diffing against the native loop, a tool needs full read-back | Highest token cost: full read-back and parallelism 1, also slower |
| `power` | Write `tf-code` programs inside the single stream | Multi-step data work (filter/aggregate/transform), large-log analysis | Without `ctx.ptcRuntime` the channel stays off; longer protocol section means slightly higher fixed cost |

One-line decision: **default to `balanced`; switch to `lean` when the bill matters; `compat` to debug
and compare; `power` to process data programmatically.**

How modes map to config (changing a mode changes these values; explicit config in the composition
still wins):

| Mode | `selfReadFeedback` | `enableCode` | `persistFallback` | Parallel | Reentries | `budgetTokens` |
|---|---|---|---|---|---|---|
| balanced | `receipt` | `auto` (on when the host has PTC) | `true` | 3 | 8 | off |
| lean | `receipt` | `false` | `true` | 2 | 6 | 60000 |
| compat | `full` | `false` | `true` | 1 | 12 | off |
| power | `receipt` | `true` | `true` | 3 | 10 | off |

### Language switching and the state file

- Switch language: press `l` in the bar, or run `dsh-stream-agent lang en`. The startup banner and
  the CLI panel read **one string table**, so you never get "Chinese banner, English commands".
- State file: `~/.dsh-stream-agent/control.json` (override with `STREAM_AGENT_STATE_DIR`):
  ```json
  { "schema": 1, "mode": "balanced", "lang": "zh", "updatedAt": "2026-11-16T13:00:00.000Z" }
  ```
- Precedence: **explicit `mode`/`lang` in the composition > `STREAM_AGENT_MODE`/`STREAM_AGENT_LANG`
  > `control.json` > built-in default (`balanced` / `zh`)**. A corrupt file only warns and falls
  back; it never blocks activation.
- A mode applies to the **next agent creation** (no dsh restart needed; already-open sessions keep
  the config they were created with).

<a id="desktop-control-page"></a>

### Desktop control page (v0.2.1)

Install into the `desktop` profile, then **restart the client**. The left rail gains a
**Control bar** icon (slider glyph). Clicking it opens a full page — no Electron edits, no client
rebuild. It rides dsh's own client-plugin mechanism (`dsh.client` + `ctx.slots`) and reads its
same-origin data from the local Host.

> Manually accepted in a real dsh desktop window: rail icon, full-page render, the four mode cards,
> zh/en switching, light and dark themes, and the page surviving a client restart.

What the page does:

| Area | Content |
|---|---|
| Header | Version, **takeover active / not taking over**, current mode, current language |
| Current state | Mode, source (composition config / environment / state file / default), language, updated time, state-file path |
| Runtime mode | Four cards: `balanced` / `lean` / `compat` / `power`, each with "when to choose" and "trade-off"; one click applies |
| Effective parameters | Self-read feedback, tf-code, local fallback, parallel commands, max re-entries, token budget |
| Language | Chinese / English, persisted to `control.json` immediately |
| Footer | Equivalent CLI commands for scripting |

Rules and boundaries:

- **New sessions only**: after a switch, agents created later use the new parameters; open sessions
  keep the config they were created with.
- **Composition wins**: if the profile patch pins `mode`/`lang`, or `STREAM_AGENT_MODE` /
  `STREAM_AGENT_LANG` is set, the page disables the control and explains why. The UI never
  overrides explicit configuration — that is the 0.2.1 precedence rule.
- **Multiple windows**: the page carries an `updatedAt` fence. If another window or the CLI changed
  the state, the write returns 409 and the page refreshes instead of silently overwriting.
- **Honest degradation**: if the loop is not taking over (activation failure), the page still opens,
  shows "not taking over", allows writing the state file, and says a restart is required after the
  load failure is fixed — it never pretends success.
- **Install path unchanged**: still `dsh plugin --profile desktop add ...`; bundles have no HMR, so a
  client restart is required after an upgrade.
- **Not a native window**: no new Electron `BrowserWindow`, no `app.asar` change, no preload IPC.
  That also means plugin upgrades never have to ride a client release. Full assessment:
  [`docs/desktop-ui-feasibility.md`](docs/desktop-ui-feasibility.md).

> No icon after restart? Run `dsh plugin --profile desktop list` to confirm 0.2.1 is installed,
> then check the client log for a `stream-agent-ui` activation error. The page depends on
> `dsh-client-modules`' dynamic client-plugin mechanism (verified on dsh desktop `0.2.2-rc.3`).

## v0.2.1: why 0.2.0 could not be used

**Symptom** (dsh desktop profile, right after installing 0.2.0):

```
启用失败：dsh: warning: 1 entry did not activate stream-agent
(file:///.../@hugesb/dsh-stream-agent/dist/entry/loop.js):
Error: cannot get property "ptcRuntime" without inject
```

**Root cause: two independent Cordis 4.x contract violations; the first one fires and masks the second.**

1. **Bare read of an optional service.** `apply()` contained
   `(ctx as { ptcRuntime?: unknown }).ptcRuntime ?? ctx.get?.('ptcRuntime')`. The `??` left side
   evaluates first, and Cordis 4.x contexts are proxies: reading a property that was **not injected**
   throws `cannot get property "ptcRuntime" without inject`, so the `ctx.get` fallback never runs.
   `ptcRuntime` is optional (absent when the host does not mount PTC), so the entry threw during
   activation.
2. **Functional-plugin return value.** All five entries ended with `return { ...handle }`.
   Cordis collects a functional plugin's return value as an **effect**, accepting only
   function / null / thenable / iterator — a plain object throws `TypeError: Invalid effect`.
   Fixing the first defect just exposes this one, with a harder-to-read error.

**Why the symptom is "completely unusable":** the entry throws → the fiber goes to failed → its
registrations are rolled back → `setFactory` never happens → the bundle has already disabled the
built-in `agent-loop` → that profile cannot create a single agent.

**Fix** (`src/entry/cordis-compat.ts`):

- `getService(ctx, name)`: reads only via `ctx.get(name)` (reflect.get has no inject requirement),
  with a `try/catch` property fallback for test stubs. `ptcRuntime` / `loader` /
  `sessionProjections` / `agentDefaultModel` / `storage` / `logger` all go through it. Optional
  services never enter the inject array (an array entry means "required" in Cordis and would
  suspend the entry forever when absent).
- `asPluginEffect(handle)`: wraps the handle into a callable disposer with the handle's properties
  attached — callers keep reading `handle.x`, Cordis receives a legal effect.

**Verification**: a minimal host on dsh's own Cordis 4.1.0, mounting all seven entries with the exact
inject lists from the patch:

```
ACTIVE  stream-agent-state / obs-broker / action-gate / context-render / control-bar / stream-agent-ui / stream-agent (7/7, state 2)
factory registered: true
control route GET: 200 (takeover: true, modes: 4)
```

The regression lives in the repo: `test/activation.test.ts` (strict inject-guard ctx + effect
contract, 10 cases).

## Results

Real API, 10 tasks, two arms with the same model on the same day; failures and timeouts all counted (metric definitions in [`eval/METRICS.md`](eval/METRICS.md), per-task details in [`eval/RESULTS.md`](eval/RESULTS.md)):

| Metric | Baseline (native loop) | This plugin | Verdict |
|---|---|---|---|
| Total tokens | 446,410 | **129,178 (28.9%)** | ✅ |
| checks | 10/10 | **10/10** | ✅ parity |

Per-task token ratio (ours / baseline): W1 55% · W2 35% · W3 **5%** · R1 35% · R2 36% (checks ✗) · R3 55% · R4 **32%** · C1 **29%** · C2 41% · C3 **22%**.

Read/lookup and composite tasks improve across the board; write-batch tasks are the weak spot of the 0.1.0 measurement — v0.2.0's O7 self-write receipt targets exactly that loop (fresh two-arm numbers pending).

## How it works

**The `tf-*` protocol** (injected into the system prompt; grammar authority: `src/kernel/parser.ts`):

| Command | Semantics | Result handling |
|---|---|---|
| `tf-write` | Write/modify a file | Success is recorded to the ledger only — never injected |
| `tf-read` | Read a file (optional `offset`/`limit`, 1-based) | Full feedback once on success (≤8000 chars, head/tail kept beyond that); top-ups via `tf-peek` |
| `tf-bash` | Run a command (Windows host uses `pwsh`) | Failures injected; successes ledger-only |
| `tf-peek` | Fetch a line range from a handle | Injected on demand |
| `tf-code` | Programmatic tool call (PTC bridge; body = async TS function body) | Return value (lossless JSON) handle-ized into the `code` family, first/changed results inject a skeleton; failures inject structured errors. Requires host `ctx.ptcRuntime`; degrades to a command-level failure with reroute guidance when absent |
| `tf-final` | Declare completion | Triggers convergence; same id with a new summary updates the final answer |

**Seven token optimizations**:

| # | Optimization | One-liner |
|---|---|---|
| O1 | Three-tier observation + line skeleton | Full feedback first; degrades to a structural skeleton (< 10% of raw size) over the limit |
| O2 | `tf-peek` | Observation rights reversed: the model decides how much to fetch |
| O3 | Handle-directory delta | Only deltas injected (added / changed / stale); the prefix stays monotonic forever |
| O4 | Dynamic context freeze | Timestamps and directory snapshots always live in the volatile tail — nothing per-request-varying enters the stable prefix |
| O5 | Budget ladder | <70% normal / 70–90% high-only / >90% only `tf-final` with degraded delivery |
| O6 | Preflight assertion | Prefix hash verified before every request; any non-monotonic change refuses to send |
| O7 | Self-write receipt | Reading back a file this task wrote returns only a receipt (lines + fingerprint), cutting the write→read-back loop |

**PTC bridge (0.2.0)**: orthogonal to the official PTC mode (`run_code` tool) — PTC changes the tool-calling medium, this package changes the loop layer. When the host `ctx.ptcRuntime` is present, the model can write `<tf-code>` programs inside the single stream for heavy data processing (filter/aggregate/transform); return values are handle-ized and intermediate results never enter context; the bound `tools.write/read/pwsh` go through the same host guard pipeline. When the channel is absent it shuts off automatically and the protocol never declares it — zero residue.

**Lifecycle of one turn**:

```
User task ─► open 1 streaming request
            │ the model outputs, in one stream: thinking + consecutive tf-* commands + depends_on
            ▼
       parser parses chunk by chunk ─► commands dispatch as they close
            │                    │
            │              gate.admit()      reversibility ruling / rewrite / reject
            │                    │
            │              tools.execute()   independent commands in parallel (worker pool ≤3)
            │                    │
            │              results go to blob + ledger, not injected by default
            ▼                    ▼
       stream ended && queue drained && no unmet dependencies
            │
            ├─ nothing more needed ─► finish (1 model call)
            └─ injections needed ─► only high-gain observations are folded in, next request sent
                                    (request count = number of command batches)
```

## Repository structure

```
dsh-stream-agent/
├── cordis.patch.yml      # bundle entry: disables the built-in agent-loop, mounts 7 entries
├── preset.yml            # production assembly manifest (declarative, not the takeover path)
├── src/
│   ├── kernel/           # zero framework deps: state / obs / parser / gate / render / modes / control-bar
│   └── entry/            # Cordis thin shells: translation only (+ cordis-compat discipline)
├── ui/                   # desktop page subpackage: Host route + browser bundle (own dsh.client)
├── dist/                 # build output (committed; patches reference it directly)
├── test/                 # 250 cases (activation regression + control-bar i18n/layout + desktop route) + 20 mock scenarios
├── patches/              # composition patches for development and evaluation
├── docs/                 # architecture, protocol, limitations
├── scripts/build.mjs     # zero-dependency build (Node native type stripping)
└── eval/                 # metric definitions, 10-task set, two-arm runner, verdicts
```

**The kernel / adapter boundary is the first discipline**: `src/kernel/` imports nothing from `@deepseek-ai/*` — copy the directory out and it unit-tests standalone; upstream API drift only lands on the thin adapter shells. Implementation details in [`docs/architecture.md`](docs/architecture.md) and [`docs/protocol.md`](docs/protocol.md).

## Development

```bash
npm test          # 250/250, zero API calls
npm run build     # emits dist/ (24 files) + full smoke imports
```

`dist/` is a committed release artifact that patches reference directly. **Always run `npm run build` after touching `src/`** — CI uses `git diff --exit-code -- dist` to catch the silent "edited source, forgot to rebuild" failure.

Real-API evaluation (needs `DEEPSEEK_API_KEY`, or route through the account channel with `patches/eval-account.yml`):

```powershell
node eval/tools/runner.cjs --arm baseline --stamp <YYYY-MM-DD> --tasks all
node eval/tools/runner.cjs --arm stream   --stamp <YYYY-MM-DD> --tasks all
node eval/tools/replay-check.cjs --stamp <YYYY-MM-DD>
node eval/tools/gen-results.cjs --stamp <YYYY-MM-DD>   # recomputes the verdict section of eval/RESULTS.md
```

Desktop troubleshooting: set `STREAM_LOOP_DEBUG=1` to enable per-milestone driver tracing (`createAgent.enter` / `agent.scope.minted` / `projection.modelSelection.registered` / `resume.suffix.flushed` / `stream.call` / `stream.finish`).

## Known limitations

The full list with evidence is in [`docs/limitations.md`](docs/limitations.md). v0.2.0 fixes the original four in a targeted way:

1. ~~**Write-batch tasks get heavier**~~ → **O7 self-write receipt**: reading back a file this task just wrote returns only a receipt (line count + fingerprint) instead of the full content; full feedback for external files is unchanged (`selfReadFeedback: 'full'` restores the old behavior).
2. ~~**`steer` deviates from the built-in**~~ → **mid-turn injection**: steer is injected into the running turn's next request (appended `[tf-stream:steer]` user block); "never interrupt mid-stream" remains a structural premise of the single-stream protocol.
3. ~~**Persistence depends on host storage**~~ → **local fallback**: without a storage backend / sessionPersistence, it falls back to local JSON files (`~/.dsh-stream-agent`, override with `STREAM_AGENT_STATE_DIR`); cross-session resume works. Set `persistFallback: false` to restore in-memory degradation.
4. ~~**plugin-record channel may degrade to memory**~~ → **local file ledger**: when host modules are unreachable, the ledger degrades to a replayable JSONL file, and on resume the final answer is rehydrated into the new driver; command records are deliberately not replayed (idempotent fingerprints cannot be recomputed).

Still worth knowing:

- **Write-batch gains need a fresh eval run** — the 28.9% figure in `eval/` is the 0.1.0 measurement (before the receipt); O7 should improve write-heavy tasks, but the numbers must come from a new two-arm run.
- **The local fallback creates a state directory** — enabled by default (`~/.dsh-stream-agent/{sessions,ledger,storage,control.json}`); opt out with `persistFallback: false`. `control.json` only stores the control-bar mode and language; delete it to return to defaults.
- **0.2.0 fails to activate inside dsh** — fixed in 0.2.1 (bare optional-service read + return-value contract, see "v0.2.1: why 0.2.0 could not be used" above). Upgrade any profile still on 0.2.0; a plain restart will not help.
- **`tf-code` depends on the host PTC runtime** — when `ctx.ptcRuntime` is missing or malformed, the channel shuts off automatically (never declared in the protocol); declared `<tf-code>` commands fail at command level with reroute guidance; see [`docs/limitations.md`](docs/limitations.md).
- **The desktop control page depends on dsh's dynamic client-plugin mechanism** — requires dsh `>=0.2.2-rc.1` (tested on desktop `rc.3`); bundles have no HMR, so restart the client after an upgrade; the page affects new sessions only, and it is not a native window (no tray/menu/shortcut).
- **`dsh plugin` needs pnpm**, **the replay tool has 0 hits on real session logs**, **`injected_ratio` measurement bias** — see [`docs/limitations.md`](docs/limitations.md) 4 / 8 / 9.

## Changelog

Full history in [`CHANGELOG.md`](CHANGELOG.md) (follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); currently written in Chinese).

| Version | Date | Highlights |
|---|---|---|
| 0.2.1 | 2026-11-16 | Activation hotfix: fixes the two Cordis 4.x contract violations that made 0.2.0 unusable inside dsh (bare read of an optional service; functional-plugin return value collected as an effect). Adds the control bar (startup banner + `dsh-stream-agent bar`) and four runtime modes (balanced / lean / compat / power) with a persisted zh/en switch. |
| 0.2.0 | 2026-11-16 | Targeted fixes for the four known limitations (O7 self-write receipt, mid-turn steer injection, local persistence fallback, local file ledger) + PTC bridge: new `tf-code` command brings the host `ctx.ptcRuntime` into the single-stream execution channels (programmatic data processing, intermediate results stay out of context; declared only when the channel is available, degrades automatically otherwise). |
| 0.1.0 | 2026-11-15 | First installable release: single-stream kernel (five `tf-*` commands) + O1–O6 token optimizations + upstream semantic alignment (implicit write ordering / idempotent ids / optimistic peek / resume reconciliation) + desktop (Electron) real-API adaptation. Verified at 28.9% tokens / checks 10/10. |

## Acknowledgements

The design ideas trace upstream to [muxueqingze/xuxiang-thinkflow](https://github.com/muxueqingze/xuxiang-thinkflow) (`tf-*` streamed commands, no success backflow, interrupt only on failure). This package is an independent implementation on top of its v0.10.0 design, adding the driver-level closed loop (implicit write ordering, idempotent ids, optimistic peek, resume reconciliation, and more).

## License

[Apache-2.0](./LICENSE)
