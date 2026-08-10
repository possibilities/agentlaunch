# 0015 — Provenance is stated, never inferred

A landing says what it descends from, and the backend records exactly that.
`--x-from <ref>` names it and `--x-no-from` says nothing did; both qualify
`--x-new-workspace` only, because lineage is set where a workspace is
created and landing a run in an existing one is not a reason to rewrite
what it already had. **Omission is a decision, not a gap**: with neither
flag the backend is told *none* explicitly, because a backend that would
otherwise consult its own environment has to be told not to — Orca infers
a parent from `ORCA_WORKTREE_ID` in the calling terminal, so silence there
means "whatever tab this was typed in", and nothing at all when
agentsurface runs from outside Orca, which is the ordinary case. The ref
is our vocabulary before it is anyone's: `run:<run-id>` resolves through
our own registry to that run's workspace, so an agent naming what it
spawned from never learns a backend's selector spelling, and the run
record keeps what was stated whether or not the backend could act on it.
Anything else is the backend's own selector, carried opaquely as
`--x-workspace` already is. What a parent *means* stays each backend's
flavor — Orca's is an arbitrary reassignable link decoupled from git, and
another ADE's may be structural and unsettable — so `Landing.provenance`
reports what was recorded and an adapter that cannot express a request
says so rather than dropping it silently. Rejected: reading
`ORCA_WORKTREE_ID` ourselves or threading an `AGENTSURFACE_RUN` sentinel
to auto-fill provenance, both of which recreate ambient inference one
level up and make a command mean different things depending on where it
was typed; and modelling provenance as free text, which cannot be resolved
to a workspace or checked against the registry.
