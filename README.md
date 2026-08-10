# agentsurface

[![CI](https://github.com/possibilities/agentsurface/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/possibilities/agentsurface/actions/workflows/ci.yml)

One launcher for agent harnesses. `agentsurface --x-harness claude` (or
`codex`, or `pi`) starts that harness in this terminal; `agentsurface
x-resume` reopens a stored session by id no matter which harness owns it;
`--x-surface` lands the same launch on a surface instead — a managed
environment behind a pluggable backend API (Orca is the first backend,
ADR 0012) — and returns a run id. The launch spec the runner execs is
exactly what a surface backend consumes (ADR 0013).

## Install

    bash scripts/install.sh

Links `~/.local/bin/agentsurface` to this checkout (no build step) and
writes the deployed SHA to `~/.local/state/agentsurface/deployed-sha`.
`scripts/install.sh --uninstall` removes both.

## Use

    agentsurface --x-harness claude "fix the failing tests"
    agentsurface --x-harness gpt-5.6-sol:ultra "hard problem"
    agentsurface --x-harness pi:gpt-5.6-luna:max
    agentsurface --x-harness claude --model sonnet "quick question"
    agentsurface x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60
    agentsurface x-resume 019fcb41-6f70-7283-aa42-97510cb09818 --x-harness codex
    agentsurface x-doctor

One partition rule (ADR 0008): a token starting `--x-` is agentsurface's,
and every other token is the harness's, forwarded in the order typed —
prompts, flags, and subcommands alike, native spellings only. Unknown
`--x-*` flags are usage faults; unknown harness flags are the harness's to
judge, so a harness upgrade never changes how a command parses here. Bare
`x-*` words in command position are reserved for agentsurface (`x-resume`,
`x-doctor`).

Every launch names what it runs through the **harness value** (ADR 0011):
`--x-harness claude` launches that harness on its catalog defaults;
`--x-harness gpt-5.6-sol:ultra` resolves to the earliest harness in
catalog order offering that model at that effort; `--x-harness
pi:gpt-5.6-luna:max` pins and validates. The resolved model and effort are
injected in the harness's own spelling — `--model` everywhere (pi gets
`openai-codex/gpt-5.6-sol`), then `--effort` (claude), `-c
model_reasoning_effort="…"` (codex), or `--thinking` (pi) — and narrated.
A colon form owns both dimensions: a forwarded native model/effort flag
beside it is a usage fault. The bare-name form yields per dimension: a
forwarded `--model sonnet` wins that dimension and only the effort is
injected. Utility invocations (`codex login`, bare `--version`) take no
injection; resumes never do — a session continues on its own model.

`x-resume` without `--x-harness` detects which session store owns the id
and refuses, with the candidates named, when that is ambiguous.
`--x-dry-run` prints the command instead of launching; add `--x-json` for
the machine envelope.

## On a surface

    agentsurface --x-harness claude --x-surface "fix the tests"
    agentsurface --x-harness codex --x-surface --x-new-workspace fix-tests --x-json
    agentsurface x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60 --x-surface
    agentsurface x-runs
    agentsurface x-run <run-id>

`--x-surface` lands the launch in a managed workspace and the command
returns instead of becoming the harness (ADR 0013). The same composed
command — balanced, yolo'd, model/effort injected — starts in a terminal
there; the surface API is backend-generic and Orca is the first backend
(ADR 0012), its worktrees implementing workspaces. Where it lands:

- default — the workspace containing the cwd (a resume's default is the
  workspace containing the *session's own* cwd, so a conversation
  continues where it lived);
- `--x-workspace <sel>` — an existing workspace, selector interpreted by
  the backend (orca: `name:`, `path:`, `branch:`, `id:`);
- `--x-new-workspace <name>` — created on demand, with **ensure**
  (ADR 0013): the project it belongs to is registered automatically —
  from `--x-project` (a registered name, or `path:<repo>` to register
  one), else the cwd's git repository. Ensure never invents a name: no
  flags and no enclosing workspace is a loud fault, not a conjured
  worktree.

Every landing writes a **run record** (ADR 0014) — one JSON file under
`~/.local/state/agentsurface/runs/` — and prints its run id (the envelope
under `--x-json`, legal here without `--x-dry-run`, carries `run_id` and
`surface {backend, project, workspace, terminal}`). The session id is
*discovered*, never assigned: codex mints its id only at startup, so
`x-run <run-id>` matches the store entry born in the run's workspace and
backfills the record; `x-runs` lists everything landed. The terminal
handle in the record is the backend's address for the future steer verb.
A surface dry run resolves read-only, and a refused surface (runtime
unreachable, workspace missing) fails the launch loudly — never a silent
fall-back to this terminal. Utility invocations cannot land.

## The catalog

`catalog.json` (shipped with the checkout) is the ordered description of
harnesses, their models, and their effort sets (ADR 0010); a custom
`~/.config/agentsurface/catalog.json` replaces it outright — no merging.
`catalog.schema.json` describes the file for editors, generated from the
zod source of truth (`bun run generate:schemas`).

- **Families** define a model list once: the `claude` family is included
  by the claude harness, and the `gpt` family as-is by codex and through
  the `openai-codex` provider by pi — so `gpt-5.6-sol` means the same
  thing on both, and only the emitted spelling differs. What a provider
  means is each harness's own semantics; claude and codex have none, and a
  provider on their includes is a fault.
- **Spellings** let a model be typed one way and emitted another. A
  member's optional `spelling` is what reaches the harness's `--model`, so
  a name the typed grammar forbids stays reachable: the claude family
  offers `opus-1m` and `sonnet-1m`, emitted as claude's own `opus[1m]` /
  `sonnet[1m]` long-context aliases. A provider combines with the
  spelling, not the typed name.
- **Efforts** inherit model > family > harness — a member's own set wins,
  else the family's, else the harness's — so `ultra` is allowed exactly
  where it is real.
- **Defaults** live in a `defaults` object: per harness, per family
  (supplying any harness that includes it and states none of its own —
  two defaults-bearing includes without own defaults is a fault), and per
  model (`{"effort": …}` only, overriding the harness's resolved default
  when that model is chosen). There is no default harness — every launch
  names one through the harness value.
- **Resolution**: the `--x-harness` value consumes it — a harness name
  launches its defaults, `model:effort` walks the harness order and the
  earliest offering wins (`gpt-5.6-sol:ultra` picks codex over pi), a full
  triple pins and validates.
- Validation is strict and total at load: unknown keys or families,
  providers without semantics, duplicates after family expansion, missing
  effort chains, and unsatisfiable defaults are all `catalog_invalid`, and
  a malformed custom catalog fails rather than falling back. `x-doctor`
  reports the active catalog's source, order, model counts, and resolved
  defaults.

## Yolo mode

Yolo is on by default (ADR 0009): every launch gets its harness's own
permission-bypass flag — `--dangerously-skip-permissions` (claude),
`--dangerously-bypass-approvals-and-sandbox` (codex), `--approve` (pi —
its tools never prompt; this only auto-trusts project-local files).
`~/.config/agentsurface/config.json` disables it: `{"yolo": false}` or a
per-harness map like `{"yolo": {"codex": false}}`. Per launch, `--x-yolo`
and `--x-no-yolo` override the config; both repeat and take an optional
harness scope (`--x-no-yolo codex`), which only bites when the launch
matches — useful in aliases that wrap every launch alike.

An explicit `--x-no-yolo` also *removes* a yolo spelling that was
explicitly forwarded, and the removal is narrated. A spelling the caller
already forwarded is never duplicated (pi's `-a` alias included), pi's own
`--no-approve` is never overridden, and utility invocations never get the
flag. A malformed config fails the launch loudly; `x-doctor` reports the
config's path, validity, and per-harness state. `config.schema.json` in
this repo describes the file for editors — name it in a `"$schema"` key,
which the loader accepts and ignores — and is generated from the same zod
schema the loader validates with (`bun run generate:schemas`), so what it
documents is what the launcher accepts.

With the PATH shims installed, this is what lets upstream tools — orca's
per-agent default args included — stop encoding permission flags per
harness: they run the bare command, and the launcher decides.

## Balanced launches

Every launch and resume is balanced by default (ADR 0003): `agentusage
balance` picks the account from live quota observations and the command is
wrapped in the swap tool's public contract — `cswap run <slot>
--share-history -- …` (claude), `codex-swap run|resume --claim <lease> --
…` (codex), `codex-swap pi run --claim <lease> -- …` (pi, riding the codex
account pool). The harness argv after the wrapper's `--` is byte-identical
to the unbalanced command. Routing reads the native `--model` (or codex's
`-m`) from the forwarded tokens; a claude resume routes on the session's
last-used model.

Pins and escape hatches: `--x-account <sel>` pins one account (still gated
by the swap tool), `--x-no-balance` launches raw once, and
`AGENTSURFACE_NO_BALANCE=1` defaults a machine without the stack to raw. A
refused balance (no capacity, stale observations, missing tools) fails the
launch loudly with a recovery — never a silent unbalanced launch. Dry runs
balance without reserving or claiming anything.

Utility invocations are the exception (ADR 0005): a leading management or
service word — codex `login`, `app-server`, `mcp`…, claude `doctor`,
`mcp`…, pi `auth`…, or a bare `--help`/`--version` — opens no account-bound
session, so it passes through to the real binary unwrapped, even when the
balancing stack is missing. Shimmed `codex login --device-auth` just logs
in; `codex exec`, `review`, `resume`, `fork`, prompts, and flag launches
still balance.

On this machine, bare `claude`/`codex`/`pi` are agentdots-installed PATH
shims that exec `agentsurface --x-harness <harness> "$@"` — every launch
balances however it was typed. The `AGENTSURFACE_LAUNCH=1` sentinel marks already-routed
children so shims exec the real binary (ADR 0004);
`AGENTSURFACE_SHIM_BYPASS=1` is the manual escape.

## The launch narrative

Every launch and resume reports its decisions on stderr, one labelled row
each, before the harness takes the terminal:

    open    claude
    cwd     ~/code/agentsurface
    yolo    on · --dangerously-skip-permissions
    account claude-swap slot 1 · full-focus
    launch  cswap run 1 --share-history -- claude --dangerously-skip-permissions

stdout stays the result, so `--x-dry-run` remains a runnable line and
`--x-json` a parseable envelope — and `--x-json` silences the rows
outright, since the envelope already carries every fact they would report
(ADR 0007). When an x-flag edits the harness's own tokens, the edit is a
row too: `yolo    off · removed --dangerously-skip-permissions ·
explicitly forwarded · --x-no-yolo wins`. `--x-verbose` adds mechanism
rows: the config consulted, the `agentusage` command shelled, the session
file a resume matched, the resolved binary, the sentinel.

## For agents

`agentsurface --agent-teaser` is the one-line summary, `--agent-help` the
runbook (top level is agentsurface's own namespace — no harness named,
nothing to forward — so the conventional spellings stay there). Machine
outcomes are one `{schema_version, ok, error, data}` envelope on stdout
under `--x-json`. Exit codes are 0 success, 1 domain error, 2 usage fault —
except harness launches and `x-resume`, which exit with the launched
harness's own code.

## Develop

    bun run check          # lint + typecheck + test — the commit gate
    bash scripts/smoke.sh  # every documented command against a throwaway HOME

`AGENTS.md` carries repository guidance, `CONTEXT.md` the glossary, and
`docs/adr/` the load-bearing decisions. The roadmap and the context behind
it live in the wiki, not here:

    agentwiki get agentsurface-roadmap
    agentwiki get agentsurface-build-context
