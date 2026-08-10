# 0020 — Codex landings serialize per workspace

A codex landing takes a lease on the workspace it lands in and holds it for a
minute. A second codex landing into the same workspace meanwhile is a
`landing_in_flight` refusal whose recovery is to retry. Claude and pi take no
lease.

**Because a codex session is invisible until it speaks.** Verified against
codex-cli 0.147.0: a thread that has taken no turn has written nothing at all
— no rollout file, no row in codex's state database, nothing on disk — and
appears only in its app-server's memory, where `thread/read` reports its
working directory. So the only fact tying a codex session to a run before it
takes a turn is the workspace it sits in, and that is enough exactly while a
workspace holds at most one *uncorrelated* codex session. The lease is what
guarantees that. Naming is sticky once made, so only the uncorrelated window
needs protecting, never the workspace's whole life: a workspace that has
hosted ten codex runs has one candidate, not ten.

**Serialized, not forbidden.** Two codex runs in one workspace remain
possible; they arrive one after another instead of together. That is the whole
cost, and it falls only on same-workspace codex landings, which
worktree-per-run makes rare.

**Time-bounded, because nothing else can bound it.** The lease expires on its
own rather than being released when the session appears, since observing that
would mean speaking the app-server's protocol from here — a WebSocket client
in the launcher for one fact. A minute is longer than a codex start and short
enough that a stale lease from a landing that never returned clears itself; a
landing that fails releases its lease immediately, because nothing was
started.

Every other way of telling two codex sessions apart was tried and rejected:
creation timestamps, whose ordering inverts under load with no way to detect
it; a per-run symlinked working directory, which makes the agent live at a
path that is not its own; an environment stamp, which cannot work because a
codex session's tools and hooks inherit the *app-server's* environment rather
than the session's; and asking the agent to report its own identity, which
makes the correlation depend on a model choosing to run a command.

Rejected: a global lease, which serializes landings that could never be
confused; refusing the second landing outright, which forbids what only needed
ordering; and leasing claude or pi, whose names travel into the harness itself
and come back out without correlation.
