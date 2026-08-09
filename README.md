# agentsurface

One launcher for agent harnesses. `agentsurface claude` (or `codex`, or
`pi`) starts that harness in this terminal; `agentsurface x-resume` reopens
a stored session by id no matter which harness owns it. Today it is a
runner — a passthrough wrapper around the harness CLIs. Later slices land
the same launches on a surface (a managed environment; Orca first) behind
more `--x-*` flags, and the launch spec the runner execs is exactly what a
surface will consume.

## Install

    bash scripts/install.sh

Links `~/.local/bin/agentsurface` to this checkout (no build step) and
writes the deployed SHA to `~/.local/state/agentsurface/deployed-sha`.
`scripts/install.sh --uninstall` removes both.

## Use

    agentsurface claude "fix the failing tests"
    agentsurface claude --model fable "fix the failing tests"
    agentsurface codex -c 'model_reasoning_effort="xhigh"' --search
    agentsurface pi --model sonnet:high
    agentsurface x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60
    agentsurface x-resume 019fcb41-6f70-7283-aa42-97510cb09818 --x-harness codex
    agentsurface x-doctor

One partition rule (ADR 0008): a token starting `--x-` is agentsurface's,
and every other token is the harness's, forwarded in the order typed —
prompts, flags, and subcommands alike, native spellings only. Unknown
`--x-*` flags are usage faults; unknown harness flags are the harness's to
judge, so a harness upgrade never changes how a command parses here. Bare
`x-*` words in command position are reserved for agentsurface (`x-resume`,
`x-doctor`). `x-resume` without `--x-harness` detects which session store
owns the id and refuses, with the candidates named, when that is
ambiguous. `--x-dry-run` prints the command instead of launching; add
`--x-json` for the machine envelope.

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
which the loader accepts and ignores.

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

On this machine, bare `claude`/`codex`/`pi` are funk-installed PATH shims
that exec `agentsurface <harness> "$@"` — every launch balances however it
was typed. The `AGENTSURFACE_LAUNCH=1` sentinel marks already-routed
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
