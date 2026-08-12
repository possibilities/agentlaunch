# 0013 — One surface operation lands a finished spec; ensure materializes what it implies

The surface API has a single operation: a backend receives a finished,
composed launch spec — exactly what `--x-dry-run` prints, catalog, yolo,
and balancing already applied — plus a workspace intent and a title, and
returns where it landed. Open and resume differ only in the spec handed
over, so the seam never grows a second verb. Intents are three: the
workspace containing the anchor path (the cwd on a launch, the session's
own cwd on a resume), an existing workspace by backend selector, or a new
workspace by name. **Ensure**: landing materializes the backend entities
the request implies — a project is registered on demand from the path the
request already names, and a workspace is created when the operator named
one — with every ensured entity narrated and reported created-or-found.
Ensure never invents a name or a checkout: with no workspace flags and no
enclosing workspace, the launch faults with both ways out named. Dry runs
resolve read-only (nothing registered, created, or recorded), refusals are
domain errors — never a silent fall-back to launching in this terminal —
and a landing returns an envelope and exits 0; ADR 0002's
adopt-the-harness-exit rule applies only when agentsurface becomes the
harness. Rejected: pre-registering projects as an operator chore, and a
per-entity CRUD surface (`x-workspace create` …), which would re-state the
backend's own CLI one verb at a time.
