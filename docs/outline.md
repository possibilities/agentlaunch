# Roadmap

The original feature outline, enriched with what building each slice
taught us. R = runner-level (no surface needed), S = needs a surface.
One slice at a time; status lives here.

## Open harness in place (R) — **built** (slice 1)

`agentsurface open <harness> [prompt] [--model m] [--effort e] [--name n]
[--dry-run [--json]] [-- passthrough]`.

- One flag vocabulary; `--effort` becomes pi `--thinking` and codex
  `-c model_reasoning_effort=…`. Value sets differ per harness: claude
  `low|medium|high|xhigh|max`, codex `minimal|low|medium|high|xhigh`
  (no max), pi `off|minimal|low|medium|high|xhigh|max`.
- `--name` works on claude and pi. Codex has no launch-time run name —
  its sessions do have *names* that `codex resume` accepts, but nothing
  sets one at launch. Run names for codex therefore live on the surface.
- Runner mode injects nothing; `--dry-run` prints the launch spec, which
  is the exact payload a surface will consume.

## Resuming a harness — **runner half built** (slice 1); surface half later

`agentsurface resume <session-id> [--harness h]` scans the stores and
launches the right spelling: `claude --resume <id>`, `codex resume <id>`,
`pi --session <id>` (pi's `--resume` is a picker boolean; cass emits the
broken `pi --resume <id>` form today, which this replaces).

Session stores (env overrides honored everywhere):

- claude — `$CLAUDE_CONFIG_DIR|~/.claude/projects/<cwd-encoded>/<uuid>.jsonl`.
  The cwd encoding is lossy (`/` → `-`), so detection matches filename
  UUIDs and never decodes directory names; a session's true cwd is the
  `cwd` field inside the JSONL.
- codex — `$CODEX_HOME|~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid7>.jsonl`,
  plus `archived_sessions/`, plus optional `.zst` compression.
- pi — `$PI_CODING_AGENT_DIR|~/.pi/agent/sessions/--<cwd-dashes>--/<ts>_<id>.jsonl`;
  header line carries `cwd` and `parentSession`. Pi handles a deleted cwd
  as a first-class case (prompts to continue elsewhere) — relevant when a
  surface resumes into a landed/removed worktree.

**Swap-awareness (verified):** cswap gives each claude account its own
`CLAUDE_CONFIG_DIR` profile under `~/.claude-swap-backup/sessions/<slot>-<slug>/`,
so sessions silo per account unless launched with `cswap run --share-history`
(which links `projects/` and `history.jsonl` back to `~/.claude`). Cross-
account claude resume therefore means scanning profile roots too — or
standardizing on `--share-history`. codex-swap keeps one canonical
`CODEX_HOME` for all accounts, so codex resume is already swap-proof. Pi
has no swap tool yet.

Still open (surface half): resuming a session *onto* a surface — same
resolution, but the launch lands in a surface workspace instead of this
terminal.

## Open harness on surface (S) — first surface slice

Adds `--x-*` flags (e.g. `--x-surface-session`) to the same `open` command;
returns a JSON envelope describing the landed run instead of becoming the
process. Needs, per ADR 0001, no new command shape — a surface backend
consumes the launch spec that `--dry-run` already prints.

- worktree (S): create/choose the worktree the run lands in (Orca manages
  these today under `~/orca/workspaces/<project>/<name>`).
- project (S): which repo/mainline the worktree belongs to.
- **Session-id gap:** claude and pi accept `--session-id <uuid>` at launch,
  so a surface can pre-assign the id and put it in the envelope
  immediately. Codex cannot — its id (uuid7) exists only after launch and
  must be discovered from the newest rollout file in `$CODEX_HOME/sessions`.
  The envelope schema needs `session_id: null → discovered-later` for codex.

## Land worktree (S) — later

Merge a finished worktree back to the mainline with surface bookkeeping.
Orca already has landing machinery; this becomes a thin verb over it.

## Balance harnesses across accounts (R) — **built** (slice 2)

Every open and resume is balanced by default (ADR 0003): `agentusage
balance claude|codex --json [--claim]` picks the account, and the launch
spec is wrapped as `cswap run <slot> --share-history -- …`,
`codex-swap run|resume --claim <lease> -- …`, or `codex-swap pi run
--claim <lease> -- …`. `--x-account` pins, `--x-no-balance` /
`AGENTSURFACE_NO_BALANCE=1` launch raw, refusals are loud with recovery.
What building it taught us:

- Pi rides the codex account pool: codex-swap grew a `pi` command family
  (its ADR 0005) with per-account pi profiles and identity-verified links;
  `balance codex` covers pi, with the `openai-codex/` model prefix
  stripped so lane selection (spark) matches.
- A claude resume routes on the session file's last-used model (cheap
  JSONL sniff) — keeper needed a job registry for this; the session store
  already knows.
- Dry runs must not reserve: claude uses balance `--dry-run`, codex/pi
  skip `--claim` and print the `--account` spelling.
- Never set `PI_CODING_AGENT_SESSION_DIR` (it flattens pi's project-nested
  session layout); pi profiles share history via a sessions symlink.

## Yolo mode (R) — queued next

One config switch that opens every harness with its permission gates down,
so nothing upstream (orca included) has to know per-harness flags.
Spellings verified against the current CLIs:

- claude — `--dangerously-skip-permissions`
- codex — `--dangerously-bypass-approvals-and-sandbox`
- pi — tools already run unprompted (there are no permission gates to
  bypass); its only prompt is project-local trust, so pi yolo maps to
  `--approve` — confirm that scope at build time.

Design intent:

- `~/.config/agentsurface/config.json` (family XDG paths), per-harness:
  `{"yolo": {"claude": true, "codex": true, "pi": true}}`, with `--yolo` /
  `--no-yolo` as per-launch overrides. This is runner behavior, so the
  flags stay unprefixed; `--x-*` remains surface-only.
- Injected by the spec builders before passthrough, and skipped when the
  passthrough already carries the same flag (codex's parser rejects a
  duplicated boolean).
- Funk stows the personal config enabling all three — the same pattern as
  funk's other `.config` packages — which is what makes the setting
  machine-managed.

Consequence, same slice: orca stops sending permission args for our
harnesses. Today they live in Orca's own settings — `agentDefaultArgs`
inside `~/Library/Application Support/Orca/orca-data.json`, not in the
stowed `funk/orca` package — as `claude: --dangerously-skip-permissions`
and `codex: --dangerously-bypass-approvals-and-sandbox` (pi has no entry;
it needs none). Bare `claude`/`codex`/`pi` are already agentsurface shims
on PATH (ADR 0004), so orca launching a harness by name flows through
agentsurface and picks yolo up from config; clearing those two entries —
and stowing orca's settings under funk if we want the absence declared —
finishes the move.

## Chat bus (S) — unexplored

Nothing learned yet. Orca's orchestration (threaded messages, ask/reply)
is the obvious backbone to evaluate first.

## Run names — partly built

- via harness (R): built where supported (claude, pi `--name`); codex
  refused with a clear error.
- on surface (S): surface metadata, so it works for every harness,
  including codex — likely the primary spelling once surfaces exist.

## Status of an agent (R→S) — later

States from the outline: working, stopped, rate limited, api error,
waiting for questions; plus monitors/subagents. What we know so far:

- claude keeps a live-session registry at `~/.claude/sessions/<pid>.json`
  (cswap's process detection reads it) — a real runner-level status
  source.
- agentusage's observation sidecars already normalize rate-limit and
  quota state per account (claude schema v7, codex v1) — status should
  read those, not re-derive them.
- codex/pi live-status sources are unknown; investigation is the first
  task of this slice.

## Controlling agents (S) — later

Steering/queuing, dismissing dialogs, resuming when quota available.
Surface-side terminal control (Orca can read/wait/send terminals today) is
the likely mechanism; quota-resume should key off agentusage observations.

## Suggested slice order (recommendation)

1. **Yolo mode** — small runner slice; unblocks dropping the permission
   args from orca's agent settings.
2. **Open on surface, minimal** — the `--x-*` envelope and an Orca backend
   for `open`; unlocks everything else that is surface-shaped.
3. **Resume on surface** — closes the outline's "resuming (R+S)" item by
   reusing slice 1's resolution plus the new landing path.
4. **Status** — runner-level signals first (claude session registry,
   store mtimes), surfaced through the same envelope.
5. **Swap-aware claude resume** — small, independent; scan cswap profile
   roots when detection misses (mostly moot while balanced claude
   launches share history).
6. Run names on surface, land, controlling agents, chat bus — as usage
   demands.
