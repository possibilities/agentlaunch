# 0012 — Surfaces are pluggable backends behind one documented API

A surface is a concept with implementations, not a product integration:
launches land on a surface through one backend-generic API, and Orca is
the *first* backend — an adapter behind that seam, the way each harness's
asymmetries live behind the adapters in `harness.ts`. Nothing Orca-shaped
(its CLI, its `orca-data.json`, its worktree layout) may leak past the
adapter into dispatch, the launch spec, the envelope, or the x-flag
grammar; the surface API is a first-class documented contract — schema'd
and versioned the way the catalog is — so writing a new backend (tmux, a
remote box, another ADE) is an adapter plus a registration, never a
rework of the runner. Recorded before the first surface slice so it
constrains that design from the start. Rejected: building directly
against Orca and extracting an interface later, which bakes one backend's
vocabulary into the flags and envelope precisely where they are hardest
to change.
