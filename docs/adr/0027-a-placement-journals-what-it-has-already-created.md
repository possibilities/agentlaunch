# 0027 — A placement journals what it has already created

A Placement claims an account, creates a Workspace, starts a terminal in it,
and only then writes the run record describing all three. Each completed phase
is now journaled first, under `runs/.placing/<run-id>.json`: `reserved`,
`account-claimed`, `workspace-created`, `terminal-created`. The fifth state,
open, is the run record itself — writing it is the commit, and the commit is
what clears the journal.

Until this, a Placement that failed late left nothing behind that said so. A
`worktree create` that succeeded and a `terminal create` that failed left an
Orca worktree belonging to no run, and the caller got a refusal naming neither
it nor the account claim that had already been spent. The run registry could
only ever describe Placements that finished.

**Journaled forward, never rolled back automatically.** Compensation is only
what is safe without a decision: the run name reservation goes back (ADR 0019),
and everything else is written down for the operator. Releasing a Workspace is
Land's operation precisely because it can discard work, and an interrupted
Placement is the case where nobody yet knows whether the checkout holds any. A
Workspace the Placement *created* is named as an orphan; one it merely found
belonged to somebody else before this Placement and still does.

**Surfaced, not hidden.** `x-runs` lists an interrupted Placement beside the
records, and `x-doctor` counts them. A journal is interrupted when its own
process stamped the failure, or when nothing has touched it for longer than a
Placement can plausibly still be in flight — the same bound the name
reservations use. A Placement genuinely running in another process is neither,
and reporting it as interrupted would be a lie.

**Ours, not the backend's.** The journal is agentsurface's own bookkeeping,
like the records it sits beside; nothing about it crosses the surface API
(ADR 0012). The one backend-generic seam it needs already exists: Prepare
(ADR 0021/0022) is the moment the Workspace exists and nothing has started in
it, which is exactly where a Workspace a later failure would orphan becomes
knowable. Prepare's return is now awaited, because a durable write is not
synchronous.

Rejected: automatic release of a created Workspace, which turns a failed
Placement into lost work; a transaction log of intended steps written before
they run, which cannot distinguish a step that was attempted from one that
took effect; and leaving the journal out of `x-runs` on the grounds that it
holds no run, which is exactly the state an operator most needs to see.
