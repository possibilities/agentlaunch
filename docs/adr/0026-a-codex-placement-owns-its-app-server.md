# 0026 — A codex Placement owns its app-server, retiring the lease

Every balanced codex Placement carries `--server unix://<socket>` into
codex-swap, which starts a dedicated, exclusive, account-pinned app-server for
that one session and tears it down with it (codex-swap ADR 0006). The socket
is derived from the run id and written to the run record, so the record and
the socket point at each other, and the one thread that appears on that
socket can only be the run's session — thread↔run is identity now, not
inference. Session discovery asks the run's own socket first
(`codex-swap app-server threads`), which answers from the moment the TUI
attaches, before any turn writes anything to disk; the store scan remains as
the fallback for ended runs and other harnesses.

**The Placement lease (ADR 0020) retires with this.** The lease ordered what
it could not identify — at most one *uncorrelated* codex session per
workspace — and there are no uncorrelated placed sessions anymore: two codex
Placements into one workspace now simply get two sockets, concurrently, and
each is addressable from birth. Everything ADR 0020 catalogued as tried and
rejected (timestamps, symlinked cwds, env stamps, self-report) stays
rejected; this is the one mechanical escape that note recorded, taken.

**Fail-hard, not fail-shared.** A placement whose server cannot start is
refused by codex-swap (`--server` is explicit there), never quietly attached
to a shared server — that would reintroduce every ambiguity this exists to
end. An unbalanced placement (`--x-no-balance`) composes no wrapper and so no
server; its record says `server: null` and discovery falls back to the store
scan, which is the old behavior.

The cost is one ~25MB process per live placed codex run and ~0.1–0.3s of
server startup, measured; the placement command itself returns as fast as
before, since the server starts inside the placed terminal.
