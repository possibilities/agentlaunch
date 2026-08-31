# 0004 — PATH shims route bare harness calls; the sentinel breaks recursion

Bare `claude` and `codex` on this machine are shims (installed by
AgentStart, ahead of the real binaries on PATH) that exec
`agentlaunch --x-harness <harness> "$@"` — every launch balances, however it
was typed. The recursion this invites (agentlaunch → swap tool → harness
from PATH → shim → agentlaunch …) is broken by one env sentinel:
`AGENTLAUNCH_LAUNCH=1`, stamped by `launch()` on every child, means
"already routed" — a shim seeing it execs the real binary, found by
scanning PATH past the shim's own directory.

The sentinel is a shared convention, not a private flag: the swap tools
stamp it on their own children too (codex-swap's ndy containment env and
cswap's session-mode launch), so a manual
`cswap run 3` or `codex-swap run --account …` keeps meaning the account
the user named instead of being silently re-balanced by the shim. It also
rides into every harness's own subprocesses, so a harness shelling out to
another harness gets the real binary — nested launches never re-balance.
The fleet's shim contract may also expose a deliberate human bypass for one
raw call; that belongs to the shim owner, not AgentLaunch's CLI.

Because shimmed argv arrives entirely in the passthrough, routing reads
`--model` from forwarded args when the launcher flag is absent — a shimmed
`claude --model fable` still routes as fable intent.
