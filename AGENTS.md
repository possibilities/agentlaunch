# agentsurface — repository guidance

One launcher for agent harnesses (claude, codex, pi): a passthrough runner
today, a surface client later. Read `README.md` for usage and `CONTEXT.md`
for the glossary — use its canonical terms in code, comments, and commit
messages. `docs/outline.md` is the roadmap and records which slices exist.

## Commands

`package.json` has the scripts; `bun run check` is the gate for every
commit. `bash scripts/smoke.sh` drives every documented command against a
throwaway HOME. The check beyond both is `bun src/main.ts doctor` on a real
machine, because the session-store layouts are transcribed from what the
harnesses actually write, not from their documentation.

## Map

`src/` is flat, one module per concern:

- `harness.ts` owns the three adapters: open/resume argv builders, the
  per-harness effort sets, run-name support, and session store locations
  with their relocating env vars. Every harness asymmetry lives here and
  nowhere else.
- `resolve.ts` finds a session id across the stores and counts sessions;
  ids are validated glob-literal before they touch a pattern.
- `balance.ts` composes the account-balancing prefix around a spec
  (ADR 0003): shells `agentusage balance --json`, wraps with cswap /
  codex-swap [pi] run, never edits the harness argv after the wrapper's
  `--`.
- `launch.ts` spawns a spec with inherited stdio and reports the child's
  exit as our own, spelling fatal signals as 128+n.
- `commands.ts` returns either a launch or a printable result per command;
  `main.ts` is dispatch, envelope emission, and exit codes; `help.ts` is
  all prose.
- `flags.ts`, `envelope.ts`, `errors.ts`, `paths.ts` are byte-identical
  copies shared with the agentwiki family; port fixes across, never fork
  them.

## Load-bearing decisions

`docs/adr/` holds them, one per file. Read them before touching dispatch or
the adapters; append a new numbered record rather than editing an old one.

## Conventions

- Exit codes: 0 success, 1 domain error, 2 usage fault — except open and
  resume, which exit with the launched harness's code (ADR 0002).
- Machine outcomes are one `{schema_version, ok, error, data}` envelope on
  stdout under `--json`; usage faults exit before a command runs and are
  never envelopes. Error codes are snake_case; `recovery` is a runnable
  suggestion.
- `--` splits our grammar from the harness's: everything after it is
  forwarded verbatim and the strict parser never sees it.
- The `--x-*` flag namespace is reserved for surface behavior; runner flags
  never use it.
- Pi is resumed with `--session <id>`; pi's `--resume` is a picker boolean.
  (cass emits the broken `pi --resume <id>` form — do not copy commands
  from it.)
- Runner mode injects nothing: no generated session ids, no extra flags.
  What the user asked for is what the harness receives.
- Comments state constraints the code can't show; no narration.
