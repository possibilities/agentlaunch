# 0014 — Runs are agentsurface's own records; session ids are discovered

A surface landing must return an identifier that exists immediately, and a
session id cannot be it: codex mints its uuid7 during startup, so any
contract built on pre-assigned session ids breaks on one harness of three.
Instead every landing writes a **run record** — one JSON file under
`~/.local/state/agentsurface/runs/<run-id>.json`, run id minted by
agentsurface — carrying the backend, workspace, composed command, the
backend's terminal handle, and `session_id: null` until known. The handle
is an address for steering, not the run's identity: its lifetime is the
backend runtime's. Session ids are **discovered, never assigned**: the
run's session is the store entry born in the run's workspace at or after
the landing (every store records its cwd — codex `session_meta`, pi's
header, claude's in-record field), found lazily on first need (`x-run`)
and backfilled into the record. The registry is the surface layer's own
bookkeeping and nothing is injected into the harness's world — the
no-invented-state convention keeps meaning the harness's argv and stores.
Rejected: injecting `--session-id` where harnesses allow it (non-uniform,
and it writes launcher state into the harness's session), and a
watcher/daemon for discovery (lazy resolution needs no process).
