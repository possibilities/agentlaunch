# 0016 — Landing merges, then releases, and never half-happens

`x-land <ref>` takes a workspace whose work is finished and completes it in
one command: survey the workspace, refuse if anything is in the way, merge
its branch into the main line, release the workspace from the surface, and
reconcile the run registry — **in that order**, because the order is the
safety property. A checkout is never removed until its work provably landed
somewhere else. The surface API therefore grows from one operation to
three: `place` puts a finished spec down (ADR 0013), `survey` reports an
existing workspace read-only, and `release` stops what is attached and
removes it. `survey` and `release` are backend-generic like `place`, and
Orca's spellings (`worktree show`, `repo show`, `terminal list/stop`,
`worktree rm`) stay inside its adapter.

**Git work is done with git; the surface is asked only for what it alone
knows.** The backend answers which workspace, whose repo, what its base ref
is, and what is still running inside it; git answers everything about the
commits — dirtiness, ahead/behind, the merge itself — read directly from
the checkouts. The repository's primary checkout is found with `git worktree
list --porcelain`, whose first entry is always the main working tree, rather
than asked of the backend, so it stays correct for checkouts the backend
never made. This keeps the seam narrow enough that a second ADE implements
five calls, not a git client.

**Nothing half-happens.** Every step that could fail leaves the world as it
was: a conflicted merge is rolled back with `git merge --abort` and raised
as `land_conflict` naming the conflicted paths, with the target branch
untouched, so the calling agent resolves it in the workspace and runs the
same command again. This is why the merge is not delegated to the caller
and also why it comes before the teardown — the destructive half only ever
runs after the constructive half succeeded.

**Judgment stays with the caller; the refusal carries the facts.** A dirty
workspace is refused rather than committed for it, because inventing a
commit message is judgment and this is a primitive. Each blocker names the
flag that clears it — `dirty` → `--x-abandon`, `terminals` and `children` →
`--x-force`, `base_branch`/`base_dirty` → nothing, go fix the repository —
and the two force flags are deliberately separate: `--x-force` clears
operational obstacles and can lose no work, `--x-abandon` discards work and
skips the merge entirely, and neither implies the other. `--x-dry-run`
reports the same survey and blockers and changes nothing, which is how an
agent asks "can this be landed?" without a second command. The repository's
own primary checkout is refused unconditionally; no flag makes landing it a
good idea. Merging is local — nothing is pushed, because publishing is
outward-facing and belongs to the operator.

**Run records are stamped, not deleted.** `closed_at` and `closed_as`
(`landed` | `abandoned`) mark the records whose workspace is gone, absent on
older records the way `from` is. A record is the last thing tying a run id
to a session id and the session outlives the workspace it was born in, so
deleting on release would throw away exactly what discovery (ADR 0014) went
to trouble to find. What to prune, and when, stays an open question this
does not pre-empt.

Rejected: performing the merge outside the command and having `x-land` only
verify-and-tear-down, which reads well but makes the common case two
commands and leaves the safety-critical ordering to the caller; passing
Orca's `worktree rm --force` through to clear blockers, which force-removes
the checkout and discards uncommitted work under a flag an operator would
reasonably type to close a dev server; and deleting run records on release,
which is cheap now and unrecoverable later.
