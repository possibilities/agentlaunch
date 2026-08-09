# agentsurface

One launcher for agent harnesses. `agentsurface open` starts claude, codex,
or pi in this terminal with one flag vocabulary; `agentsurface resume`
reopens a stored session by id no matter which harness owns it. Today it is
a runner — a passthrough wrapper around the harness CLIs. Later slices land
the same launches on a surface (a managed environment; Orca first) behind
reserved `--x-*` flags, and the launch spec the runner execs is exactly what
a surface will consume.

## Install

    bash scripts/install.sh

Links `~/.local/bin/agentsurface` to this checkout (no build step) and
writes the deployed SHA to `~/.local/state/agentsurface/deployed-sha`.
`scripts/install.sh --uninstall` removes both.

## Use

    agentsurface open claude --model fable --effort max "fix the failing tests"
    agentsurface open codex --effort xhigh -- --search
    agentsurface open pi --model sonnet --effort high
    agentsurface resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60
    agentsurface resume 019fcb41-6f70-7283-aa42-97510cb09818 --harness codex
    agentsurface doctor

Everything after `--` goes to the harness verbatim. `--effort` is one flag
with per-harness values (claude `low…max`, codex `minimal…xhigh`, pi
`off…max`); it is spelled `--thinking` on pi and `-c
model_reasoning_effort=…` on codex. `--name` names the run on claude and pi;
codex has no run names. `resume` without `--harness` detects which session
store owns the id and refuses, with the candidates named, when that is
ambiguous. `--dry-run` prints the command instead of launching; add `--json`
for the machine envelope.

## Balanced launches

Every open and resume is balanced by default (ADR 0003): `agentusage
balance` picks the account from live quota observations and the command is
wrapped in the swap tool's public contract — `cswap run <slot>
--share-history -- …` (claude), `codex-swap run|resume --claim <lease> --
…` (codex), `codex-swap pi run --claim <lease> -- …` (pi, riding the codex
account pool). The harness argv after the wrapper's `--` is byte-identical
to the unbalanced command. `--model` drives fable intent and codex lane
selection; a claude resume routes on the session's last-used model.

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
that exec `agentsurface open <harness> -- "$@"` — every launch balances
however it was typed. The `AGENTSURFACE_LAUNCH=1` sentinel marks
already-routed children so shims exec the real binary (ADR 0004);
`AGENTSURFACE_SHIM_BYPASS=1` is the manual escape.

## For agents

`agentsurface --agent-teaser` is the one-line summary, `--agent-help` the
runbook. Machine outcomes are one `{schema_version, ok, error, data}`
envelope on stdout under `--json`. Exit codes are 0 success, 1 domain error,
2 usage fault — except open and resume, which exit with the launched
harness's own code.

## Develop

    bun run check          # lint + typecheck + test — the commit gate
    bash scripts/smoke.sh  # every documented command against a throwaway HOME

`AGENTS.md` carries repository guidance, `CONTEXT.md` the glossary,
`docs/adr/` the load-bearing decisions, and `docs/outline.md` the roadmap of
slices built and pending.
