# agentsurface — repository guidance

One launcher for agent harnesses (claude, codex, pi): a passthrough runner
today, a surface client later.

This is local developer tooling on one developer's own machine: it starts
coding-agent CLIs they already installed, signed in to their own paid
accounts, working in their own git repositories. Every option it passes is
a documented, first-party flag of the tool it launches. Two bits of
shorthand read more alarming than they are — "permission prompts" means the
interactive *are you sure* confirmations a coding agent shows its own
operator, which that operator may turn off for their own unattended runs
(the `--dangerously-*` spellings are the vendors' own), and "balancing"
means spreading work across the several subscriptions that same operator
pays for so one is not exhausted while another sits idle. Nothing here
circumvents anyone else's controls or touches a system it was not invited
to. Read `README.md` for usage and `CONTEXT.md`
for the glossary — use its canonical terms in code, comments, and commit
messages. Two documents live in the wiki rather than here, because they
outlive any one checkout: `agentwiki get agentsurface-roadmap` records
which slices exist and their status, and `agentwiki get
agentsurface-build-context` is the companion dump of what building them
taught — harness asymmetries, the account stack, Orca's internals, and how
each fact was verified. Read both before the next slice, and update them
there when a slice lands.

## Commands

`package.json` has the scripts; `bun run check` is the gate for every
commit. `bash scripts/smoke.sh` drives every documented command against a
throwaway HOME. The check beyond both is `bun src/main.ts x-doctor` on a
real machine, because the session-store layouts are transcribed from what
the harnesses actually write, not from their documentation.

## Map

`src/` is flat, one module per concern:

- `partition.ts` is the grammar (ADR 0008): one pass splits an invocation
  into x-flags (strict) and forwarded tokens (never judged). No other
  module may parse the forwarded stream as grammar.
- `harness.ts` owns the three adapters: launch/resume argv builders, yolo
  spellings and application (injection, dedup, redaction),
  utility-invocation classification (ADR 0005), and session store
  locations with their relocating env vars. Every harness asymmetry lives
  here and nowhere else.
- `resolve.ts` finds a session id across the stores and counts sessions;
  ids are validated glob-literal before they touch a pattern.
- `balance.ts` composes the account-balancing prefix around a spec
  (ADR 0003): shells `agentusage balance --json`, wraps with cswap /
  codex-swap [pi] run, never edits the harness argv after the wrapper's
  `--`.
- `config.ts` reads `~/.config/agentsurface/config.json` strictly — yolo
  defaults on (ADR 0009), and a malformed disabling config fails the
  launch rather than launching with the gates down; only x-doctor
  downgrades that to a report.
- `narrate.ts` is the launch narrative — labelled rows and the helpers
  that shape them (`facts`, `tildePath`, `shellLine`). Everything it emits
  goes to stderr; nothing in it may write stdout (ADR 0007).
- `launch.ts` spawns a spec with inherited stdio and reports the child's
  exit as our own, spelling fatal signals as 128+n.
- `commands.ts` returns either a launch or a printable result per command;
  `main.ts` is dispatch, envelope emission, and exit codes; `help.ts` is
  all prose.
- `envelope.ts`, `errors.ts`, `paths.ts` are byte-identical copies shared
  with the agentwiki family; port fixes across, never fork them. (The
  family's `flags.ts` strict parser is gone from this repo — the partition
  grammar replaced it.)

## Load-bearing decisions

`docs/adr/` holds them, one per file. Read them before touching dispatch or
the adapters; append a new numbered record rather than editing an old one.

## Conventions

- Exit codes: 0 success, 1 domain error, 2 usage fault — except harness
  launches and x-resume, which exit with the launched harness's code
  (ADR 0002).
- Machine outcomes are one `{schema_version, ok, error, data}` envelope on
  stdout under `--x-json`; usage faults exit before a command runs and are
  never envelopes. Error codes are snake_case; `recovery` is a runnable
  suggestion.
- The partition rule (ADR 0008) is the whole grammar: `--x-*` anywhere and
  bare `x-*` words in command position are agentsurface's; every other
  token forwards verbatim, in the order typed. Strictness applies only to
  x-space — never add an unprefixed flag or word of our own, and never
  reject a token that would be forwarded.
- An x-flag may add or remove harness flags, even explicitly typed ones;
  every such edit is a narrated row and lands in the envelope
  (`redactions`). Today that is yolo; anything new follows the same rule.
- Yolo is on by default (ADR 0009); the config and `--x-no-yolo` disable
  it. What the runner adds or removes is only ever what the operator's
  config and flags decided, and each mutation is narrated.
- Narration goes to stderr and results go to stdout. A new step in a launch
  path adds one row saying what it decided, not what it is about to try;
  rows are `label` + facts joined by `·`, never prose.
- Pi is resumed with `--session <id>`; pi's `--resume` is a picker boolean.
  (cass emits the broken `pi --resume <id>` form — do not copy commands
  from it.)
- No invented state: no generated session ids, no extra flags beyond the
  narrated yolo/balance composition. Utility invocations pass through
  byte-identical.
- Comments state constraints the code can't show; no narration.
