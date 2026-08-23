# AgentLaunch

AgentLaunch is the fleet's public pre-launch resolver for Claude Code, Codex,
and Pi. It chooses a harness/model/effort, composes capability packs, applies
yolo policy, balances an account, composes the native command, and executes
it. `x-resume` reads native
session stores to detect the harness and recover the session's cwd.
`--x-surface` opens the interactive launch form: the same launch, spoken to
a surface instead of executed — it renders on stderr and writes session
directives to stdout for a surface host. Launching is the one job either
way; the flag only redirects the outcome, and keeping the two outcomes
consistent is this repository's responsibility.

The boundary is strict: native harness behavior begins where AgentLaunch ends.
This repository owns no agent names, identities, workspaces, panes, presence,
steering, run registry, or placement lifecycle. It owns one narrow App Server
topology: an ephemeral server supervised for an interactive Codex launch so
process-local skill roots can be set before the native remote TUI connects.
The server is a caller-owned foreground invocation over codex-swap's public
`run` contract, not a resident or registered sidecar. Anything outside
`--x-*` is a native token and stays opaque, including `--name`/`-n`.
The surface form does not soften this: it describes sessions declaratively
(the directive's worktree/focus/cwd vocabulary) and never calls herdr or
agentsurface — realizing a directive is entirely the host's.

## Commands

- `bun run check` — lint, typecheck, and unit/integration tests.
- `bash scripts/smoke.sh` — hermetic CLI/installer smoke suite.
- `bun run generate:schemas` — regenerate checked-in JSON Schemas.
- `bash scripts/install.sh --install` — hardened rerunnable source-link install.
- `bash scripts/install.sh --uninstall` — remove only a verified managed install.

## Architecture

- `main.ts` owns top-level routing, strict per-route `--x-*` grammar, envelope
  rendering, and exit semantics. Routes are launch, `x-resume`, `x-doctor`,
  `x-catalog`, and the `--x-surface` form — a launch-modality flag, not a
  command.
- `surface/` is the interactive launch form and its handoff: a pure form
  model (`model.ts`), the OpenTUI shell (`app.ts`, rendering on stderr so
  stdout stays the host's), Signal Room theme, overlay, kill ring, project
  scan, form-side state, and `directive.ts` — session directives written to
  stdout as JSON lines, refused when stdout is a terminal (no host is
  reading). The `surface-handoff-protocol` wiki page is the protocol
  contract.
- `commands.ts` resolves launch/resume decisions and produces either a native
  launch spec or a result. Keep it free of post-launch state.
- `partition.ts` claims known `--x-*` tokens anywhere and forwards every other
  token in order. Unknown native syntax is never AgentLaunch's to reject.
- `catalog*.ts` strictly load and validate the built-in catalog or a custom
  replacement at `~/.config/agentlaunch/catalog.json`.
- `config*.ts` strictly load yolo policy from
  `~/.config/agentlaunch/config.json`; absence means yolo on everywhere.
- `harness.ts` is the native asymmetry boundary: argument spellings, utility
  classification, yolo gates, session metadata, store layouts, and Codex cwd
  anchoring.
- `balance.ts` calls AgentUsage and composes `cswap`/`codex-swap` prefixes.
  AgentLaunch never reads provider credential stores.
- `capabilities.ts` strictly loads AgentStart packs, renders immutable session
  projections, injects harness-native resources, and owns capability receipts.
- `launch.ts` resolves final executables, supervises the per-launch Codex App
  Server through codex-swap's foreground account-pin contract when needed,
  sets exact skill policy, sets `AGENTLAUNCH_LAUNCH=1`, connects the terminal,
  and adopts native exit status/signal semantics. `codex-app-server.ts` and
  `unix-websocket.ts` are its owner-only control connection.
- `help.ts`, `README.md`, and `CONTEXT.md` are product contract, operator guide,
  and vocabulary. Removed AgentSurface concepts must not reappear there.

## Invariants

- No AgentSurface runtime coupling: never spawn agentsurface or herdr, and
  never read surface state. Product paths and environment variables are
  `agentlaunch` / `AGENTLAUNCH_*` only; the surface handoff is exactly the
  stdout directive stream, nothing environmental.
- A native `--name` is forwarded untouched. Do not parse, inject, deduplicate,
  narrate, persist, or assign meaning to it.
- `x-resume` accepts a native session ID only. No `run:` references or local
  registry fallback.
- Session stores are native and read-only. Honor their environment overrides;
  capability receipts live separately under AgentLaunch state.
- Every managed session includes `common` unless `--x-no-common` is explicit.
  Claude projects it as `/agent:<skill>`, Codex as bare `$skill`, and Pi as
  bare `/skill`. Utility invocations receive no capability arguments.
- A real launch always either balances successfully or fails; never silently
  fall back to unbalanced. Utility invocations and explicit no-balance are the
  stated exceptions.
- Dry-run balance must not claim capacity. Real Codex/Pi balance consumes the
  AgentUsage claim and passes it to codex-swap.
- JSON is a single schema-versioned envelope on stdout. Narration is stderr;
  usage faults are stderr/help and exit 2, never envelopes. The `--x-surface`
  directive stream is the one stated exception: schema-versioned directive
  lines for the host's pipe, never an envelope.
- Installers refuse foreign files, unsafe paths, mismatched origins, and
  uncorroborated receipts. Tests use temporary roots only.

## Validation

Before landing a change:

```sh
bun install --frozen-lockfile
bun run generate:schemas
bun run check
bash -n scripts/install.sh scripts/smoke.sh
bash scripts/smoke.sh
```

Also grep tracked current files for removed product terms. Historical Git
commits retain the AgentSurface lineage by design; the current tree must not
contain its runtime concepts — herdr calls, agent names, workspaces, panes.
The directive vocabulary (worktree/focus fields, the surface form) is
legitimate handoff language, not a regression.

## The fleet

This checkout is one of the agent* fleet under `~/code`. Shared machinery
lives in two siblings, and some changes here must cascade:

- Skills under `skills/<name>/` ship into AgentStart's default `common`
  capability pack (`~/code/agentstart/scripts/sync-skills`, run six-hourly
  by the scheduled updater). AgentLaunch composes the pack into managed
  sessions: Claude Code exposes `/agent:<name>`, while Codex uses `$<name>`
  and Pi uses `/<name>`. A SKILL.md edit is live within six hours, or on
  demand by running that script. Whether a new skill earns a TOOLS.md
  advertisement line is a deliberate decision —
  `agentwiki get tool-advertisement-policy`.
- Adding or removing a call to another fleet tool changes the fleet map:
  update `~/code/agentstart/skills/fleet/MAP.md` (served by the `fleet`
  skill, every edge with evidence) in the same change.
- General agent doctrine — collab, build, maintain, story, the resource
  skills — is `~/code/agentguidance`; tool-specific runbooks stay here.
