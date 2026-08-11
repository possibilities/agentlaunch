# 0025 — Anchoring is the supported path, not a workaround

ADR 0023 and ADR 0024 both describe `--cd` as "a workaround for a regression
that belongs to codex's app-server path" which "should not outlive the real
fix". Reading codex's source says otherwise, and this record corrects the
framing without changing the behaviour either ADR introduced.

**In remote mode, `--cd` is the only input for a thread's working directory.**
From `codex-rs/tui/src/app_server_session.rs`:

```rust
match thread_params_mode {
    Embedded => Some(config.cwd…),          // the process directory, always
    Remote   => remote_cwd_override.map(…), // only what was passed explicitly
}
```

and `remote_cwd_override` is `cli.cwd` — the `-C, --cd` flag — filtered on
`app_server_target.uses_remote_workspace()`. So a remote-attached thread has no
working directory unless one is given, by design: a remote app-server may be on
another machine, where the client's directory would be meaningless. Ours is
remote *transport* over a unix socket with a local workspace, a case that
predicate does not separate.

**That also explains the dated evidence** the earlier records cite. Codex
sessions recorded real paths until 2026-08-10 because they ran **embedded**;
they record `/` afterwards because an account-pinned app-server put them in
**remote** mode with nothing supplying a directory. The behaviour change was
real and ours to absorb; codex's part of it was not a defect.

**So the anchoring is permanent until codex changes its mind, not pending.**
Neither ADR should be read as scheduling its own removal. Upstream issue
openai/codex#31317 shows `--remote … --cd` is a recognised combination with its
own rough edges, which is corroboration that this is the intended path rather
than an accident we are riding.

**What remains genuinely open is upstream, and small**: a unix-socket
app-server on the same machine could reasonably default a thread's directory to
the client's, or imply `--cd`. Worth filing; not worth waiting for.

This record changes no behaviour. It exists because a comment that tells the
next reader to delete working code as soon as someone else fixes something is
worse than no comment at all, when there is nothing to fix.
