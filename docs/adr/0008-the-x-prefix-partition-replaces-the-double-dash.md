# 0008 — The x-prefix partition replaces the -- door

Launch grammar is one partition rule: a token starting `--x-` is
agentsurface's wherever it sits, a bare `x-*` word in command position is
agentsurface's, and every other token is the harness's, forwarded in the
order typed. The harness name is the command — `agentsurface claude …` —
so `open` is retired along with `--model`, `--effort`, `--name`, and the
`--` separator; resume and doctor move into x-space as `x-resume` and
`x-doctor`, and `--dry-run`/`--json`/help respell as `--x-dry-run`/
`--x-json`/`--x-help`. Strictness applies only to x-space: an unknown
`--x-*` is a usage fault, an unknown harness token is forwarded unjudged —
so a harness upgrade never changes how a command parses here, and nothing
agentsurface owns can shadow a harness spelling. x-flags may add or remove
harness flags, even explicitly typed ones (yolo is the first); every such
edit is narrated at launch. The forwarded stream is untouched beyond that
today — a description of the present, not a promise. ADR 0001's core
stands: surface behavior still arrives as more `--x-*` flags on these same
commands. Rejected: the strict-head `--`-door grammar, whose unprefixed
harness-shaped flags (`--model`, `--effort`, `--name`) shadowed native
spellings and obliged agentsurface to track every harness's vocabulary to
stay coherent.
