# 0023 — A placement anchors its harness to the workspace

A placement tells the harness which directory it is working in, with an
absolute path, at the moment the workspace exists. Today only codex needs
telling: `--cd <workspace>`. claude and pi already run in the terminal's own
directory and record it.

**Because a codex session does not know where it is.** A codex TUI reaching
its model through a shared app-server — which every balanced launch does, via
`--remote` — has its thread created *server-side*, so the thread records the
app-server's working directory instead of the terminal's. The servers are
started by launchd, so that directory is `/`. Verified against codex-cli
0.147.0, in `thread/read` and in the rollout's own `session_meta` alike, with
dated evidence either side of the change: codex rollouts on 2026-08-08 and
08-09 record real paths, and every one from 08-10 — when the account-pinned
app-server supervisor landed — records `/`.

Everything that identifies a codex session by where it is working breaks on
that: the bus cannot place a peer in a workspace, and session discovery
(ADR 0014) matches a directory that never occurs, so `x-run` reports "session
not yet discovered" permanently rather than until the first turn.

**Absolute, because nothing else survives.** `--cd .` does not reach the
thread and neither does the inherited process directory; only an explicit
absolute path does. Verified all three ways.

**At the `prepare` seam, appended.** The path is not knowable when argv is
composed — a workspace the placement is about to create has none — so the
arguments come from the callback ADR 0021 introduced, which already fires with
the real path before any attachment starts. They are appended, because the
tail of a composed command is the harness's own argv: a balancing wrapper
contributes a head and a `--` and never a tail, so appending reaches the
harness whether or not the launch was wrapped. That keeps the rule
backend-generic and wrapper-generic, while `harness.ts` keeps owning that
`--cd` is codex's spelling and that the other two need nothing.

**This is a workaround for someone else's regression, and should not outlive
it.** The honest fix is for a codex session to know its own directory —
whether from the TUI forwarding it on remote attach or from codex-swap's
app-server path supplying it. When that lands, this becomes redundant rather
than wrong, and the anchoring seam stays useful for the next harness that
needs something only a real path can express.

Rejected: composing `--cd` before the placement, which cannot know a path that
does not exist yet; inserting the arguments after the executable, which lands
them in the balancing wrapper's argv rather than the harness's; a relative
path, which does not survive; and leaving runner-mode launches to the same
treatment — they run in the terminal's directory already, and the regression
that afflicts them is not a placement's to paper over.
