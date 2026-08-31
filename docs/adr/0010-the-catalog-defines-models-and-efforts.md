# 0010 — The catalog defines models and efforts; its order is the tiebreak

Model and effort return as data, not flags-with-adapters: the catalog —
built-in `catalog.json`, replaced outright by
`~/.config/agentlaunch/catalog.json` when that exists — is the ordered
description of harnesses, their models, and their effort sets. Families
define a model list once (a top-level map), and a harness includes one as-is.
A member's typed name is identical everywhere it is included; only an explicit
member spelling changes what is emitted. Effort sets attach per harness and per
model (the model's set replaces the harness's), and every level declares
its default — required default harness, required per-harness default model
and effort, optional per-model default effort — with one naming rule
throughout: a plural key names the offering, its singular names the
default. Resolution walks the harnesses in catalog order; the earliest
entry offering the requested model at the requested effort wins, defaults
fill what the request left unspecified after selection (the default model
steps aside rather than contradict an explicit effort), and
nothing-requested resolves to the default harness. Validation is strict
and total at load (`catalog_invalid`) — unknown keys and families,
duplicates after family expansion, and every default satisfiable where it is
declared — and a malformed custom catalog
fails rather than falling back to the built-in. This record also adopts
the fleet's config conventions — zod 4 as the schema source of truth, a
generated `catalog.schema.json`, a drift test — and with them
agentlaunch's first runtime dependency. Rejected: merging custom over
built-in (merge semantics on an ordered list are a swamp); `{min, max}`
effort ranges (custom efforts break any global ordering); and a raw model
prefix (native spelling belongs on the model member explicitly).
