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
| Tests | 187 cases green, zero API calls (full mock pipeline + 20 scenarios) |
| Shape | One bundle package — install/remove with a single `dsh plugin add`; uninstall restores the native loop |
| Release | npm [`@hugesb/dsh-stream-agent`](https://www.npmjs.com/package/@hugesb/dsh-stream-agent) · GitHub [Releases](https://github.com/54dsb1/dsh-stream-agent/releases) |

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
(`dsh plugin add /absolute/path/dsh-stream-agent`).

Uninstall: `dsh plugin --profile <name> remove @hugesb/dsh-stream-agent`, or simply drop the patch — the takeover layer disappears entirely and native behavior returns, zero residue.

> `dsh plugin` requires `pnpm` on PATH (or a configured `pnpmCommand` in your dsh-plugin-manager).

## Results

Real API, 10 tasks, two arms with the same model on the same day; failures and timeouts all counted (metric definitions in [`eval/METRICS.md`](eval/METRICS.md), per-task details in [`eval/RESULTS.md`](eval/RESULTS.md)):

| Metric | Baseline (native loop) | This plugin | Verdict |
|---|---|---|---|
| Total tokens | 446,410 | **129,178 (28.9%)** | ✅ |
| checks | 10/10 | **10/10** | ✅ parity |

Per-task token ratio (ours / baseline): W1 55% · W2 35% · W3 **5%** · R1 35% · R2 36% (checks ✗) · R3 55% · R4 **32%** · C1 **29%** · C2 41% · C3 **22%**.

Read/lookup and composite tasks improve across the board; **write-batch tasks get heavier** — with full feedback, the model spontaneously runs read-back verification loops. That is an explicit "correctness first" trade-off, not a free win.

## How it works

**The `tf-*` protocol** (injected into the system prompt; grammar authority: `src/kernel/parser.ts`):

| Command | Semantics | Result handling |
|---|---|---|
| `tf-write` | Write/modify a file | Success is recorded to the ledger only — never injected |
| `tf-read` | Read a file (optional `offset`/`limit`, 1-based) | Full feedback once on success (≤8000 chars, head/tail kept beyond that); top-ups via `tf-peek` |
| `tf-bash` | Run a command (Windows host uses `pwsh`) | Failures injected; successes ledger-only |
| `tf-peek` | Fetch a line range from a handle | Injected on demand |
| `tf-final` | Declare completion | Triggers convergence; same id with a new summary updates the final answer |

**Six token optimizations**:

| # | Optimization | One-liner |
|---|---|---|
| O1 | Three-tier observation + line skeleton | Full feedback first; degrades to a structural skeleton (< 10% of raw size) over the limit |
| O2 | `tf-peek` | Observation rights reversed: the model decides how much to fetch |
| O3 | Handle-directory delta | Only deltas injected (added / changed / stale); the prefix stays monotonic forever |
| O4 | Dynamic context freeze | Timestamps and directory snapshots always live in the volatile tail — nothing per-request-varying enters the stable prefix |
| O5 | Budget ladder | <70% normal / 70–90% high-only / >90% only `tf-final` with degraded delivery |
| O6 | Preflight assertion | Prefix hash verified before every request; any non-monotonic change refuses to send |

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
├── cordis.patch.yml      # bundle entry: disables the built-in agent-loop, mounts 5 entries
├── preset.yml            # production assembly manifest (declarative, not the takeover path)
├── src/
│   ├── kernel/           # zero framework deps: state / obs / parser / gate / render
│   └── entry/            # Cordis thin shells: translation only, no business logic
├── dist/                 # build output (committed; patches reference it directly)
├── test/                 # 187 cases + 20 mock scenarios
├── patches/              # composition patches for development and evaluation
├── docs/                 # architecture, protocol, limitations
├── scripts/build.mjs     # zero-dependency build (Node native type stripping)
└── eval/                 # metric definitions, 10-task set, two-arm runner, verdicts
```

**The kernel / adapter boundary is the first discipline**: `src/kernel/` imports nothing from `@deepseek-ai/*` — copy the directory out and it unit-tests standalone; upstream API drift only lands on the thin adapter shells. Implementation details in [`docs/architecture.md`](docs/architecture.md) and [`docs/protocol.md`](docs/protocol.md).

## Development

```bash
npm test          # 187/187, zero API calls
npm run build     # emits dist/ (13 files) + full smoke imports
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

## Changelog

Full history in [`CHANGELOG.md`](CHANGELOG.md) (follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); currently written in Chinese).

| Version | Date | Highlights |
|---|---|---|
| 0.1.0 | 2026-11-15 | First installable release: single-stream kernel (five `tf-*` commands) + O1–O6 token optimizations + upstream semantic alignment (implicit write ordering / idempotent ids / optimistic peek / resume reconciliation) + desktop (Electron) real-API adaptation. Verified at 28.9% tokens / checks 10/10. |

## Known limitations

The full list with evidence is in [`docs/limitations.md`](docs/limitations.md). The four you most need to know up front:

1. **Write-batch tasks get heavier** — full feedback + read-back verification loops buy correctness; the big wins are on read/lookup and composite tasks.
2. **`steer` deviates from the built-in** — this implementation queues at the front and takes effect at a turn boundary (single stream: "never interrupt mid-stream"), rather than injecting into the running turn's next step.
3. **Persistence depends on host storage** — without a storage backend (headless), it degrades to in-memory by design (no functional loss, but cross-session resume is unavailable); adding `@deepseek-ai/dsh-storage-json` restores it.
4. **The plugin-record channel may degrade in bundle form** — when host modules are unreachable it falls back to an in-memory ledger (stderr warning, never silent); the cost is that `tf-*` state cannot be replayed after resume.

## Acknowledgements

The design ideas trace upstream to [muxueqingze/xuxiang-thinkflow](https://github.com/muxueqingze/xuxiang-thinkflow) (`tf-*` streamed commands, no success backflow, interrupt only on failure). This package is an independent implementation on top of its v0.10.0 design, adding the driver-level closed loop (implicit write ordering, idempotent ids, optimistic peek, resume reconciliation, and more).

## License

[Apache-2.0](./LICENSE)
