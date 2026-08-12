# 0003 — Balanced launches compose a prefix, never touch the spec

Launches are balanced by default: `agentusage balance` picks the account
from live observations, and the runner composes the swap tool's public
contract around the untouched launch spec — `cswap run <slot>
--share-history -- …` for claude, `codex-swap run|resume --claim <lease>
-- …` for codex, `codex-swap pi run --claim <lease> -- …` for pi. The
harness argv after the wrapper's `--` is byte-identical to the unbalanced
command, so runner-mode's inject-nothing rule holds inside the prefix.

Selection intent rides the model: `--model` forwards to balance (fable
intent, codex lanes; pi ids are stripped of their provider prefix), and a
claude resume routes on the session file's last-used model because a resume
keeps spending that model's window. Refusals are loud: no capacity, stale
observations, or a missing stack fail the launch with a recovery naming the
fix — a silent fallback to an unbalanced launch would quietly drain
whatever account is active. The escape hatches are explicit: `--x-account`
pins (still gated by the swap tool), `--x-no-balance` launches raw once,
`AGENTSURFACE_NO_BALANCE=1` defaults a machine to raw. Dry runs balance
without reserving or claiming, so codex/pi dry runs print the copy-runnable
`--account` spelling rather than a lease that was never minted.

Rejected: linking agentusage as a library (the JSON CLI is its documented
boundary, and the launcher contract predates this slice); balancing inside
the harness adapters (account choice is not a harness asymmetry); and
defaulting to unbalanced with balance opt-in (the point of the stack is
that every launch participates).
