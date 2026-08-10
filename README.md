# AgentSurface

[![CI](https://github.com/possibilities/agentsurface/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentsurface/actions/workflows/ci.yml)

One launcher for every agent harness. `agentsurface --x-harness claude` (or
`codex`, or `pi`) starts that harness in this terminal; name a level instead
and the catalog picks the harness that offers it.

Every launch is balanced across accounts and yolo'd by default. `x-resume`
reopens a stored session whichever harness owns it, and `--x-surface` lands the
same launch in a managed workspace instead, returning a run id.

## Install

    bash scripts/install.sh

Links `~/.local/bin/agentsurface` to this checkout (no build step) and writes
the deployed SHA to `~/.local/state/agentsurface/deployed-sha`.
`scripts/install.sh --uninstall` removes both.

## Use

    agentsurface --x-harness claude "fix the failing tests"
    agentsurface --x-level gpt-5.6-sol:ultra "hard problem"
    agentsurface --x-harness pi --x-level gpt-5.6-luna:max
    agentsurface --x-harness claude --model sonnet "quick question"
    agentsurface x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60
    agentsurface x-resume 019fcb41-6f70-7283-aa42-97510cb09818 --x-harness codex
    agentsurface x-doctor

One partition rule (ADR 0008): a token starting `--x-` is agentsurface's, and
every other token is the harness's, forwarded in the order typed — prompts,
flags, and subcommands alike, native spellings only. Unknown `--x-*` flags are
usage faults; unknown harness flags are the harness's to judge, so a harness
upgrade never changes how a command parses here. Bare `x-*` words in command
position are reserved for agentsurface (`x-resume`, `x-doctor`).

Every launch names what it runs through two flags (ADR 0018), at least one of
them required. `--x-harness claude` launches that harness on its catalog
defaults. `--x-level gpt-5.6-sol:ultra` names a **level** — a model and an
effort, both parts required — and resolves to the earliest harness in catalog
order offering it. Together they pin and validate. A level keeps its two parts
in one value because the catalog validates them as one pair: which efforts a
model allows is the catalog's to know, not something to match up in your head
before typing.

The resolved model and effort are injected in the harness's own spelling, and
narrated: `--model` everywhere (pi gets `openai-codex/gpt-5.6-sol`), then
`--effort` (claude), `-c model_reasoning_effort="…"` (codex), or `--thinking`
(pi). `--x-level` owns both dimensions, so a native model or effort flag
forwarded beside it is a usage fault. Without one, a launch yields per
dimension: a forwarded `--model sonnet` wins that dimension and only the
effort is injected. Utility invocations (`codex login`, bare `--version`) take
no injection, and resumes never do — a session continues on its own model.

`x-resume` without `--x-harness` detects which session store owns the id, and
refuses with the candidates named when that is ambiguous. `--x-dry-run` prints
the command instead of launching; add `--x-json` for the machine envelope.

## On a surface

    agentsurface --x-harness claude --x-surface "fix the tests"
    agentsurface --x-harness codex --x-surface --x-new-workspace fix-tests --x-json
    agentsurface x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60 --x-surface
    agentsurface x-runs
    agentsurface x-run <run-id>

`--x-surface` lands the launch in a managed workspace, and the command returns
instead of becoming the harness (ADR 0013). The same composed command —
balanced, yolo'd, model and effort injected — starts in a terminal there. The
surface API is backend-generic; Orca is the first backend (ADR 0012), and its
worktrees implement workspaces. Where a launch lands:

- default — the workspace containing the cwd. A resume defaults to the
  workspace containing the *session's own* cwd, so a conversation continues
  where it lived.
- `--x-workspace <sel>` — an existing workspace, selector interpreted by the
  backend (orca: `name:`, `path:`, `branch:`, `id:`).
- `--x-new-workspace <name>` — created on demand, with **ensure** (ADR 0013):
  the project it belongs to is registered automatically, from `--x-project` (a
  registered name, or `path:<repo>` to register one), else the cwd's git
  repository. Ensure never invents a name — no flags and no enclosing workspace
  is a loud fault, not a conjured worktree.

A new workspace also says what it came from. **Provenance is stated, never
inferred** (ADR 0015): `--x-from run:<run-id-or-name>` names a previous run — resolved
through agentsurface's own registry, so an agent naming what it spawned from
never learns a backend's selector spelling — or takes the backend's own
workspace selector; `--x-no-from` says nothing did. Saying nothing *means*
nothing: the backend is told "none" explicitly, because one that would
otherwise read its own environment (Orca infers a parent from the calling
terminal) has to be told not to, and a command should not change meaning with
the tab it was typed in. What a parent means is each backend's own flavor, so
the envelope reports what was actually recorded rather than assuming it took.

A run can carry the operator's own label. `--x-name <name>` is passed to the
harness where one has a launch-time name (claude and pi `--name`; codex has
none, so a runner launch narrates the drop rather than failing), and on a
surface it titles the terminal, labels a workspace the landing created, and
lands in the run record — so codex loses nothing there. **A name is a label,
not an identity** (ADR 0017): free text, never unique, never invented. It reads
back wherever a run id does — `x-run auth-flow`, `--x-from run:auth-flow`,
`x-land run:auth-flow` — with the id tier matched first and several runs
sharing a name refused by name rather than guessed between.

Every landing writes a **run record** (ADR 0014): one JSON file under
`~/.local/state/agentsurface/runs/`, whose run id is printed. Under `--x-json`,
legal here without `--x-dry-run`, the envelope carries `run_id` and
`surface {backend, project, workspace, terminal, provenance}`.

The session id is *discovered*, never assigned. Codex mints its id only at
startup, so `x-run <run-id>` matches the store entry born in the run's
workspace and backfills the record; `x-runs` lists everything landed. The
record's terminal handle is the backend's address for the future steer verb.

A surface dry run resolves read-only. A refused surface (runtime unreachable,
workspace missing) fails the launch loudly, never falling back to this
terminal. Utility invocations cannot land.

## Landing finished work

    agentsurface x-land name:fix-tests --x-dry-run
    agentsurface x-land name:fix-tests
    agentsurface x-land run:<run-id> --x-force

`x-land` is the other end of a run's life: it merges a workspace's finished
work back to the main line and lets the surface go, in that order (ADR 0016).
Survey, refuse, merge, release, reconcile — a checkout is never removed until
its work provably landed somewhere else. The workspace is named the way
`--x-from` names one: `run:<run-id-or-name>` through our own registry, or the
backend's own selector.

Git work is done with git, in the repository's primary checkout, which is found
with `git worktree list` rather than asked of the backend. The surface is
consulted only for what it alone knows — which workspace, whose repo, what is
still attached — and does only what it alone can: stop terminals, remove the
workspace.

**Nothing half-happens.** A merge conflict is rolled back with `git merge
--abort` and raised as `land_conflict` naming the conflicted files, with the
target branch exactly as it was; resolve it in the workspace and run `x-land`
again. Refusals name what is in the way and the flag that clears it:

| Blocker | Means | Cleared by |
|---|---|---|
| `dirty` | uncommitted or untracked changes | `--x-abandon` |
| `terminals` | live terminals in the workspace | `--x-force` |
| `children` | workspaces descend from this one | `--x-force` |
| `base_branch` | the primary checkout is on another branch | `git switch` |
| `base_dirty` | the primary checkout is unclean | commit or stash |

The two force flags are deliberately separate: `--x-force` clears operational
obstacles and can lose no work, `--x-abandon` discards work and skips the merge
entirely, and neither implies the other. Committing is judgment, so a dirty
workspace is refused rather than committed for you. The repository's own
primary checkout is refused unconditionally. Merging is local — nothing is
pushed. `--x-dry-run` reports the same survey and blockers and changes nothing,
which is how to ask "can this be landed?" without a second command.

Run records are **stamped, not deleted**: `closed_at` and `closed_as`
(`landed` | `abandoned`). A record is the last thing tying a run id to a
session id, and the session outlives the workspace it was born in.

## The catalog

`catalog.json`, shipped with the checkout, is the ordered description of
harnesses, their models, and their effort sets (ADR 0010). A custom
`~/.config/agentsurface/catalog.json` replaces it outright — no merging.
`catalog.schema.json` describes the file for editors, generated from the zod
source of truth (`bun run generate:schemas`).

- **Families** define a model list once. The `claude` family is included by the
  claude harness, and the `gpt` family as-is by codex and through the
  `openai-codex` provider by pi — so `gpt-5.6-sol` means the same thing on
  both, and only the emitted spelling differs. What a provider means is each
  harness's own semantics; claude and codex have none, so a provider on their
  includes is a fault.
- **Spellings** let a model be typed one way and emitted another. A member's
  optional `spelling` is what reaches the harness's `--model`, so a name the
  typed grammar forbids stays reachable: the claude family offers `opus-1m`
  and `sonnet-1m`, emitted as claude's own `opus[1m]` / `sonnet[1m]` long-
  context aliases. A provider combines with the spelling, not the typed name.
- **Efforts** inherit model > family > harness — a member's own set wins, else
  the family's, else the harness's — so `ultra` is allowed exactly where it is
  real.
- **Defaults** live in a `defaults` object: per harness, per family (supplying
  any harness that includes it and states none of its own — two
  defaults-bearing includes without own defaults is a fault), and per model
  (`{"effort": …}` only, overriding the harness's resolved default when that
  model is chosen). There is no default harness; every launch names one.
- **Resolution** is the two launch flags: `--x-harness` alone launches that
  harness's defaults, `--x-level` alone walks the harness order and the
  earliest offering wins (`gpt-5.6-sol:ultra` picks codex over pi), and both
  together pin and validate.
- **Validation** is strict and total at load. Unknown keys or families,
  providers without semantics, duplicates after family expansion, missing
  effort chains, and unsatisfiable defaults are all `catalog_invalid`, and a
  malformed custom catalog fails rather than falling back. `x-doctor` reports
  the active catalog's source, order, model counts, and resolved defaults.

## Yolo mode

Yolo is on by default (ADR 0009): every launch gets its harness's own
permission-bypass flag — `--dangerously-skip-permissions` (claude),
`--dangerously-bypass-approvals-and-sandbox` (codex), `--approve` (pi, whose
tools never prompt, so this only auto-trusts project-local files).
`~/.config/agentsurface/config.json` disables it with `{"yolo": false}` or a
per-harness map like `{"yolo": {"codex": false}}`. Per launch, `--x-yolo` and
`--x-no-yolo` override the config; both repeat and take an optional harness
scope (`--x-no-yolo codex`) that only bites when the launch matches.

An explicit `--x-no-yolo` also *removes* a yolo spelling that was explicitly
forwarded, and narrates the removal. A spelling the caller already forwarded is
never duplicated (pi's `-a` alias included), pi's own `--no-approve` is never
overridden, and utility invocations never get the flag. A malformed config
fails the launch loudly; `x-doctor` reports the config's path, validity, and
per-harness state. `config.schema.json` describes the file for editors — name
it in a `"$schema"` key, which the loader accepts and ignores — and is
generated from the same zod schema the loader validates with, so what it
documents is what the launcher accepts.

With the PATH shims installed, upstream tools — orca's per-agent default args
included — stop encoding permission flags per harness: they run the bare
command, and the launcher decides.

## Balanced launches

Every launch and resume is balanced by default (ADR 0003). `agentusage balance`
picks the account from live quota observations, and the command is wrapped in
the swap tool's public contract: `cswap run <slot> --share-history -- …`
(claude), `codex-swap run|resume --claim <lease> -- …` (codex), or `codex-swap
pi run --claim <lease> -- …` (pi, riding the codex account pool). The harness
argv after the wrapper's `--` is byte-identical to the unbalanced command.
Routing reads the native `--model` (or codex's `-m`) from the forwarded tokens;
a claude resume routes on the session's last-used model.

Pins and escape hatches: `--x-account <sel>` pins one account (still gated by
the swap tool), `--x-no-balance` launches raw once, and
`AGENTSURFACE_NO_BALANCE=1` defaults a machine without the stack to raw. A
refused balance (no capacity, stale observations, missing tools) fails the
launch loudly with a recovery, never launching silently unbalanced. Dry runs
balance without reserving or claiming anything.

Utility invocations are the exception (ADR 0005). A leading management or
service word — codex `login`, `app-server`, `mcp`…, claude `doctor`, `mcp`…, pi
`auth`…, or a bare `--help`/`--version` — opens no account-bound session, so it
passes through to the real binary unwrapped even when the balancing stack is
missing. Shimmed `codex login --device-auth` just logs in; `codex exec`,
`review`, `resume`, `fork`, prompts, and flag launches still balance.

On this machine, bare `claude`/`codex`/`pi` are AgentStart-installed PATH shims
that exec `agentsurface --x-harness <harness> "$@"`, so every launch balances
however it was typed. The `AGENTSURFACE_LAUNCH=1` sentinel marks already-routed
children so shims exec the real binary (ADR 0004);
`AGENTSURFACE_SHIM_BYPASS=1` is the manual escape.

## The launch narrative

Every launch and resume reports its decisions on stderr, one labelled row each,
before the harness takes the terminal:

    open    claude
    cwd     ~/code/agentsurface
    yolo    on · --dangerously-skip-permissions
    account claude-swap slot 1 · full-focus
    launch  cswap run 1 --share-history -- claude --dangerously-skip-permissions

stdout stays the result, so `--x-dry-run` remains a runnable line and
`--x-json` a parseable envelope — and `--x-json` silences the rows outright,
since the envelope already carries every fact they would report (ADR 0007).
When an x-flag edits the harness's own tokens, the edit is a row too: `yolo
off · removed --dangerously-skip-permissions · explicitly forwarded ·
--x-no-yolo wins`. `--x-verbose` adds mechanism rows: the config consulted, the
`agentusage` command shelled, the session file a resume matched, the resolved
binary, and the sentinel.

## For agents

`agentsurface --agent-teaser` is the one-line summary and `--agent-help` the
runbook. The top level is agentsurface's own namespace — no harness named,
nothing to forward — so the conventional spellings stay there. Machine outcomes
are one `{schema_version, ok, error, data}` envelope on stdout under `--x-json`.
Exit codes are 0 success, 1 domain error, and 2 usage fault, except harness
launches and `x-resume`, which exit with the launched harness's own code.

## Develop

    bun run check          # lint + typecheck + test — the commit gate
    bash scripts/smoke.sh  # every documented command against a throwaway HOME

`AGENTS.md` carries repository guidance, `CONTEXT.md` the glossary, and
`docs/adr/` the load-bearing decisions. The roadmap and the context behind it
live in the wiki, not here:

    agentwiki get agentsurface-roadmap
    agentwiki get agentsurface-build-context
