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
