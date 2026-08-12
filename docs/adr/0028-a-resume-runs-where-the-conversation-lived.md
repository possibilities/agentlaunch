# 0028 — A resume runs where the conversation lived

`x-resume` took a session id and started the harness in whatever directory the
operator happened to be standing in. Both halves are now different: a resume
names the directory it is picking the conversation up in, and it can be
addressed by the Run that placed it.

**A resume runs in the session's own directory.** Every session store records
a cwd, and a Run record names the Workspace it was placed in; a resume uses
that directory and says so on the `cwd` row. The reason is the same one behind
Anchor (ADR 0023/0024): a harness cannot see where it is, and a conversation
is *about* the files in one place. Resuming it somewhere else hands an agent a
history describing files that are not there, which it will act on.

**`run:<run-id-or-name>` resumes what a Placement recorded**, in the tiers
`x-land` and `--x-from` already resolve — exact run id, then name (ADR
0017/0019). A bare token is still a session id, so nothing about the old form
moves. The record names the harness, so a run reference never scans the stores
and refuses `--x-harness`, the flag that exists to skip that scan.

**A run whose Workspace is gone refuses, and names what it knows.** Land
releases a Workspace precisely because its work left, so there is no directory
that resumption obviously belongs in; picking one would be inference wearing a
default's clothes, and the plausible pick — the repository's primary checkout
— is the actively bad one, since an agent resumed there holds a conversation
about a branch that no longer exists. The refusal names the repo the run was
cut from and the two ways forward: place it somewhere with
`--x-surface --x-new-workspace`, or resume the session itself, which the
refusal spells out in full. That escape is why this can refuse without taking
anything away.

**A bare session id in the same situation does not refuse.** It reports that
the directory is gone and continues where the operator stands. The asymmetry is
deliberate: a Run knows its repo and can offer something better, while a
session knows only a path that no longer resolves — and refusing there would
remove a resume that works today, for nothing gained.

**A Run record gains `repo`, stated at Placement** rather than looked up later
(ADR 0015's habit): the refusal above has to name where a session came from
with the backend unreachable and the checkout deleted, which is the state every
closed Run is in. `Placement.project` therefore reports the repository for
every Placement rather than only the ones that named a project — a repo merely
found reports `created: false`. Records written before this simply lack the
field, the way `from` and `level` did.

Rejected: resuming into the repo's primary checkout automatically, for the
reason above; and inferring the directory from the operator's cwd when the
recorded one is missing, which is what the old behavior did silently and what
the `cwd` row now states out loud.
