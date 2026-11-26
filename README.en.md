# dsh-stream-agent

![ci](https://github.com/54dsb1/dsh-stream-agent/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)

[简体中文](./README.md) · English

**A single-stream heart for the DeepSeek Harness.** It replaces turn-based tool calling with a
single-stream protocol: the model writes every command in one request, commands dispatch as soon
as they close, independent commands run in parallel; tool results return handles by default and
details are fetched on demand by line range; the context is append-only and byte-for-byte
prefix-asserted before each request.

| Item | Value |
| --- | --- |
| Current version | `0.5.0` (protocol spec v1.5.0, see [PROTOCOL-v1.md](./PROTOCOL-v1.md)) |
| npm | [`@hugesb/dsh-stream-agent`](https://www.npmjs.com/package/@hugesb/dsh-stream-agent) |
| Host | DeepSeek Harness ≥ `0.2.2-rc.1` (type anchor; runtime tested on rc.3) |
| Runtime | Node ≥ 22.18 (native type stripping, zero npm dependencies) |
| Tests | 623 cases / 622 passed / 0 failed / 1 intentional skip (zero API) |
| Build | `dist/` — 39 files (committed; patches reference `../dist/` directly) |
| License | Apache-2.0 (third-party notices in [NOTICE](./NOTICE)) |

---

## Quick start

**Production form: install into a dedicated profile** (only `stream` / `stream-headless` are
allowed; installing into `web` / `desktop` is rejected up front, and bypassing that fails with a
named `E_DOUBLE_LOOP` — never silent coexistence):

```bash
cp -r profiles/stream ~/.dsh/profiles/stream                  # 1) copy the template (use link: for local dev)
node scripts/install-check.mjs --profile ~/.dsh/profiles/stream --dry-run   # 2) read-only pre-check
dsh --profile stream                                          # 3) startup proof: stderr shows TAKEOVER-ACTIVE … profile=stream
dsh plugin remove @hugesb/dsh-stream-agent --profile stream   # uninstall: the bundle layer disappears, host loop restored atomically
```

For the headless entry use the `profiles/stream-headless` template (no preset bundle). Optional
install/uninstall regression drill: `node scripts/install-cycle.mjs --dsh dsh --profile stream --rounds 10`.

**Zero-install trial** (`--patch` is a temporary overlay; no profile changes, gone when the
command ends; exercises "takeover + protocol + single-stream execution" without the four sidecars):

```bash
export DEEPSEEK_API_KEY=sk-...            # the only required credential
cd <package root>
dsh --profile headless --patch ./patches/takeover.yml headless "Create hello.txt here with one line hello, then read it back"
dsh-stream-agent bar                      # to tune caps first: press u to edit limits
```

**Evaluation harness** (four arms: L0 native / L1 PTC only / L2 this plugin·A / L3 this plugin·B;
missing credentials → `exit 3` with no conclusions written):

```bash
node eval/tools/four-arm-real.mjs --plan                    # print the commands only, zero requests
DEEPSEEK_API_KEY=... node eval/tools/four-arm-real.mjs --stamp 2026-11-24
```

---

## How it works

The plugin describes itself with two **orthogonal axes**: the **execution channel** decides how
commands run; the **context tier** only provides reference numbers.

| | Standard channel `standard` (A) | PTC-compat `code` (B) |
| --- | --- | --- |
| Model-side entry | `tf-*` commands (one XML tag each) | a single `run_code` program (or restricted `tf-code`) |
| Who executes | the plugin driver: parse → dispatch → map to host tools | `preset` source: host PTC owns everything; `bridge` source: plugin narrow bridge |
| Protocol injection | 8 base sections (full measured at 3,673 chars) | `preset` 0 chars (full deference); `bridge` 222 + 117 chars |
| Acceptance gate | yes (`tf-plan` + `accepts` receipts + premature-final interception) | none (stream ends normally with no open reason → done) |
| Fits | everyday read/write/edit tasks that need verifiable completion | multi-step data crunching, batch jobs, compute in code |

**B-mode source resolution is explicit-first**: `codeChannelSource: 'preset' | 'bridge'` pins it;
`'auto'` probes the host PTC preset tool surface first, then `ctx.ptcRuntime`. The probe is
**lazy and live** — driver construction and channel switching re-probe the host services on the
spot, so a PTC preset mounted later (per window/session) can still enter. With neither source
available B **refuses to enter and falls back to A** (no silent degradation). The `bridge` source
supports `sandbox_permissions` **single-shot escalation** (paired with `justification`, approved
via the host, covers only that one execution).

**Context governance** (shared by both channels — the main increment over plain host PTC):
handle-based observation (large results return a handle + summary; `tf-peek` fetches on demand),
span-ledger dedup, line-anchor indexes, deterministic compaction, effect elision, planned rebases,
and a byte-level prefix assertion — a non-monotonic prefix is **accepted pre-send as a cache reset
point**: the same request goes out as-is (0 extra requests / 0 injected text), the baseline
advances with it, and later requests are monotonic again (cache hits resume); only an explicit
`prefixPolicy: 'fail'` keeps refuse-to-send + same-turn auto-continue (≤2 times).

**Wire transport surface** (thinkflow request-assembly semantics; the defaults are the thinkflow
factory preset and are editable at any time):

| Setting | limits key | Default (thinkflow preset) | Behavior |
| --- | --- | --- | --- |
| Output budget | `maxTokens` | `0` | `>0` → request carries `max_tokens`; `0` = delegate to the provider, field omitted |
| Thinking budget | `thinkingBudget` | `0` | `>0` → request carries `thinking.budget_tokens` (≥1024 to enable) |
| Thinking mode | `thinkingMode` (assembly) | `disabled` | `enabled` or a provider-specific type → request carries `thinking`; when `enabled` and no effort is given explicitly, `high` is used |
| Stream usage | `streamUsage` | `0` | `1` → request carries `stream_options: {include_usage: true}` |
| Setup retries | `maxRetries` / `retryBackoffMs` | `2` / `1000` | connection-setup failures retry within budget (setup only — mid-stream errors never retry, re-sending a half stream would double-bill) |

With native tools declared in the surface → the request carries `tools` + `tool_choice: 'auto'`;
without → neither field is sent. Transport settings are assembled per request from the effective
limits right before sending; the desktop panel / `limits --set` / assembly config take effect on
the very next request.

**Reasoning strategy** (`reasoningStrategy`, assembly config; visible via `status --json`):

- `provider-required` (default): assistant messages carry `source` verbatim, including the host
  provider-session continuation state.
- `drop-stale`: keep the `source` shell but **strip `replayState`** — reasoning/replay state is
  never sent back; requests are plain text and stateless per request (thinkflow-equivalent:
  caching rides on prefix monotonicity, not provider session continuation).

**Security**: secret protection denies reading `.env` / `*.pem` / `*.key` and 15 basename patterns
(structured `[secret]` failure) and redacts model-visible output before registration
(key-like assignments → `[REDACTED]`); mutating commands fsync an intent before writing; a
hard kill at any of three points has defined semantics; on resume an "intent without receipt"
blocks the turn, closed manually via `intents --ack`.

---

## Configuration

**The default numeric face is the thinkflow-aligned layer** (mapped from the thinkflow factory
preset): `keepRecent=30` / `maxSummaryChars=16000` / `maxReadChars=200000` / `maxReentries=8`,
plus the five transport keys (table above). **The round cap (maxSteps) is never preset** — the
plugin never decides for you how many rounds are enough; unset = no cap (`0` = explicitly
unlimited), and user-defined keys override the default layer per key.

### Three behavior switches

`contextFold` (context folding, default on) / `finalCheck` (final acceptance, default on; greyed
out on the PTC-compat channel) / `contextRaw` (no processing at all, default off; when on it forces
compaction/folding/dedup/truncation off — budget-type limits still apply). Entries: terminal
`f` / `v` / `x`, `dsh-stream-agent fold|final|raw on|off|toggle`, assembly config, desktop page.

### User limits (29 keys)

```bash
dsh-stream-agent limits                                   # list all 29 keys and current values
dsh-stream-agent limits --set maxTokens=8192,maxRetries=3
dsh-stream-agent limits --replace codeMaxWallMs=120000    # whole-set replace
dsh-stream-agent limits --reset
STREAM_AGENT_LIMITS="maxTokens=8192;keepRecent=50" dsh ...   # one-off trial, nothing written
```

Grouped digest (full table in [docs/limits.md](docs/limits.md)):

| Group | Keys (unset behavior) |
| --- | --- |
| Budget | `maxSteps` / `maxInputTokens` (compacts when hit) / `observeBudgetTokens` (observe only) |
| Retrieval | `peekBudgetChars` / `peekAnchorEvery` (unset 200) / `maxReadChars` / `readFeedbackLimit` / `readFeedbackBudgetPerRequest` / `codeValueInjectLimit` / `nativeResultLimit` |
| Compaction | `keepRecent` / `maxSummaryChars` / `segmentMaxChars` (unset: no segmenting) / `effectElisionKeepRecent` |
| Rebase/re-entry | `maxRebasesPerTurn` / `maxRebasesPerSession` (`0` = forbid rebasing) / `maxReentries` / `stallReentries` / `closeOutRequests` |
| Execution | `maxParallelToolCalls` (unset 3, a scheduling constant — not a task cap) / `maxParallelBindings` |
| Transport | `maxTokens` / `thinkingBudget` / `streamUsage` (0=off 1=on) / `maxRetries` / `retryBackoffMs` |
| Code | `codeMaxSubcalls` / `codeMaxOutputBytes` / `codeMaxWallMs` |

Three-level precedence (low → high): `control.json` < `STREAM_AGENT_LIMITS` < assembly
`config.limits`; then `limitsByChannel` / `limitsByTier` and runtime `setLimits()`.
**Changing limits never wipes the channel; changing the channel never wipes limits.**

"No caps" cannot loop forever — convergence rests on an **information-based criterion**: once the
same rejection reason has been shown and no new ok command appears, it is not repeated and the
step closes as `blocked`; each wall-hit reason closes out once; new productive work resets the
criterion. "Unlimited" hands the count to you; the plugin keeps "it never says the same sentence
twice" — that is dedup, not a cap.

---

## Command reference: 17 commands

Syntax authority: `src/kernel/parser.ts` (`COMMAND_NAMES`); closed-loop semantics in
[docs/protocol.md](docs/protocol.md).

| Command | Purpose | Result disposition |
| --- | --- | --- |
| `tf-write` | write a file (body = raw text) | success → ledger only; failure injects `[tf-stream:error]` |
| `tf-read` | read a file (`offset`/`limit`) | full injection on first/changed read; self-written paths also inject in full by default |
| `tf-edit` | exact replacement (`OLD`/`NEW` three-part block) | success → ledger; mismatch is a structured error, never fuzzy matching |
| `tf-append` | append only (optional `anchor`) | success → ledger |
| `tf-grep` | content search, matching lines with numbers | full injection on first/changed; handle beyond caps |
| `tf-glob` | filename search, paths only | same as above |
| `tf-bash` | run a command (Windows → `pwsh`) | success → ledger; use `tf-peek` to see output |
| `tf-peek` | fetch by handle (line range / symbol / `offset` / `query`) | on demand; misses return top-3 candidates |
| `tf-plan` | declare/revise plan & acceptance items (`- [id] text`) | state lives driver-side; requests inject deltas only |
| `tf-final` | wrap up (`summary` must contain the answer verbatim) | premature while acceptance items are unverified; stream-end prose delivers in the same turn |
| `tf-code` | programmatic tool calling (off by default in A; B's main entry) | value injected in full within caps; skeleton + handle beyond |
| `tf-ask` | blocking question (`q` required) | answer injected in full |
| `tf-skill` | load a skill (`name` = skill id) | skill instructions injected in full |
| `tf-call` | generic call channel: `name` = host tool, body = JSON args | per host-tool family (reads inject, writes receipt) |
| `tf-changes` | change-receipt directory (optional `path` filter) | injected in full (id/status/revertability/expected hash) |
| `tf-diff` | snapshot diff for one receipt (`change` = receipt id) | injected in full |
| `tf-revert` | guarded rollback (`change` + `expected` double check) | restores before-content; undo receipt registered; conflicts fail structurally |

Common attributes: `id` (auto-numbered by default), `depends_on` (cycles fail with a named error),
`accepts` (acceptance linkage). Two protocol disciplines: **don't re-read what you just wrote**,
**don't search with `tf-bash`**. Successful `tf-write` / `tf-edit` / `tf-append` automatically
register a revertible change receipt (snapshots persisted outside model input).

**Protocol injection cost** (measured source-text chars, not token estimates): `protocolLevel:
'full'` (default) 3,673 → `lean` 3,161 → `minimal` 2,283 → `minimal` with the plan section off
1,998. Optional enhanced sections (v11/v12/v14/v15) are not assembled by default. Preview:

```bash
dsh-stream-agent protocol --stats-only                 # per-section chars + total
dsh-stream-agent protocol --level minimal --no-plan    # preview a slimmer build
```

---

## Control surfaces

Three entries operate on the same `<stateDir>/control.json` (atomic writes; a corrupt file warns
and falls back — never blocks loading):

- **Terminal bar**: `dsh-stream-agent bar` — `1-5` channel/tier, `c`/`t` quick switch, `u` edit
  limits, `f`/`v`/`x` switches, `l` language, `?` guide, `r` reset, `q` quit.
- **CLI subcommands**: `channel` / `tier` / `fold` / `final` / `raw` / `lang` / `limits` /
  `intents` / `protocol` / `status --json` / `help`.
- **Desktop page**: sidebar "Control bar" — takeover state, channel & source, effective params,
  channel/tier cards, the 29-key editor (blank = unset, includes the transport group), switch
  section (acceptance greyed out on the PTC-compat channel), read-only host preset roster, zh/en
  toggle. Writes go through the runtime back to the loop; concurrent windows get 409 with a
  refresh notice; assembly-locked controls are greyed; read-only when not taken over.

**Explicit assembly config always beats panel choices.**

---

## Quality gates

```bash
npm test          # 623 cases / 622 passed / 1 intentional skip (zero API; node --test native TS type stripping)
npm run build     # dist/ — 39 files + full smoke import
npm run check     # 7 assembly & doc consistency checks (entry set / inject / load order /
                  #   README command table / ≤17 command cap / preset ↔ matrix / NOTICE)
npm run gate -- --offline   # three offline release gates (G1–G3); on-host items honestly marked pending
npm run release:dry         # release rehearsal
```

The build is **pure type stripping** (no type checking) — undeclared variables only explode at
runtime; after editing `src/` always re-run `npm run build` (`dist/` is committed and referenced
by patches; CI checks src ↔ dist sync).

```
src/kernel/   zero-dep, no IO: parser / render / obs / gate / state / limits / control-bar /
              protocol / compaction / assembly / changes / change-store / security / delivery ...
src/entry/    Cordis shells: loop (driver) / ptc-bridge / intent-log / json-persistence /
              control-state / control-session / control-bar-cli / obs-broker / context-render /
              tool-surface / ra0-probe ...
ui/           desktop control page subpackage (standalone dsh.client)   dist/  build output (committed)
profiles/ preset/ patches/ eval/ docs/ scripts/ test/
```

---

## Known boundaries (verified item by item)

Only issues that can be pointed at in code.

| Area | Fact |
| --- | --- |
| Evidence | The four-arm benchmark / R3 two-arm / on-host scenes are not backfilled here; this README states no "saves X%" figures |
| Execution | In B `preset` mode the plugin executes no code at all; B has no acceptance gate; the escalation how-to lives only in optional section v14 (not injected by default); the sandbox covers file effects only, Windows tier `partial` |
| Transport | max_tokens / stream_options / thinking travel through the host `llm.stream` passthrough — the host writes them into the HTTP body when recognized and ignores them otherwise; the plugin owns request assembly and values, not the raw HTTP connection |
| Semantics | `tf-plan` acceptance items live in memory only (re-declare after resume); protocol level is frozen at construction (changes need a new session); no `tf-python` and no diff stats (use `tf-bash python3` / `git diff --stat`) |
| Copy | Two stable-prefix protocol texts disagree with actual behavior (self-read receipt vs full re-injection; `tf-final` required vs same-turn delivery) — changing them would overturn prefix assertions and golden files, a protocol version bump, so they remain listed |
| Display | Live frames carry reasoning only; prose appears once the step is persisted |

Convergence, recovery and long-session semantics: [docs/limitations.md](docs/limitations.md).

---

## Docs index

| Doc | Contents |
| --- | --- |
| [PROTOCOL-v1.md](PROTOCOL-v1.md) | protocol spec (commands / attributes / enhanced sections, incl. `sandbox_permissions`) |
| [docs/protocol.md](docs/protocol.md) | syntax & closed-loop semantics |
| [docs/limits.md](docs/limits.md) | all 29 keys, precedence, structural convergence, switches |
| [docs/channel-matrix.md](docs/channel-matrix.md) | channel × tier capability matrix |
| [docs/porting-matrix.md](docs/porting-matrix.md) | thinkflow 47-module disposition + PTC contract alignment |
| [docs/architecture.md](docs/architecture.md) | layering & assembly (kernel zero-IO / sidecar order) |
| [docs/limitations.md](docs/limitations.md) | known-limitations long list |
| [docs/adr-001-segment-boundary.md](docs/adr-001-segment-boundary.md) / [adr-002-change-commands.md](docs/adr-002-change-commands.md) | segment boundary / change commands ADRs |
| [eval/METRICS.md](eval/METRICS.md) · [eval/RESULTS.md](eval/RESULTS.md) | measurement method & measured figures |
| [profiles/stream/README.md](profiles/stream/README.md) | dedicated profile install / uninstall / fallback |
| [CONTRIBUTING.md](CONTRIBUTING.md) | contribution discipline |

## License

Apache-2.0. Third-party notices and derivation statements in [NOTICE](./NOTICE)
(thinkflow derivation / PTC dependency, column-based).
