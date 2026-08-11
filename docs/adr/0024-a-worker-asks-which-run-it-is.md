# 0024 — A worker asks which run it is

`agentsurface x-whoami` reports the run the caller is, asked from inside it.
Not being on a surface is a refusal (`not_placed`), so the command is also the
gate for anything that only applies to a placed worker.

**Because nothing can be stamped for this.** The obvious design is the one
herdr uses — an environment variable the launcher sets, checked by the worker.
It cannot work here: a codex session's tools inherit the *app-server's*
environment rather than the session's, verified by stamping two different
values and watching the agent read the server's. A variable set on the launch
would be absent for codex, or worse, silently wrong. Anything a worker must be
able to trust about itself therefore cannot be carried in the environment the
launcher controls.

**So it is asked, not told.** Both halves of the answer already exist: the
harness names its own session to the commands its agent runs, and the run
registry holds the mapping. Nothing new is written, and nothing has to survive
a restart, a resume, or a re-attach.

**Matched exactly where possible, by workspace otherwise.** The session id is
tried first, from `CLAUDE_CODE_SESSION_ID` (paired with claude's own marker, so
a variable inherited by an unrelated process cannot pass for one) or
`CODEX_THREAD_ID`. Pi exports neither, and a session placed moments ago has no
discovered id yet, so the fallback is the workspace the caller is working in.
That fallback carries the ambiguity a workspace always has — two open runs of
one harness there resolve to neither, the refusal the Placement lease
(ADR 0020) exists to make rare.

**A runner launch anchors itself**, which this ADR also settles (and which
ADR 0025 later corrects on one point: the anchoring is the supported path, not
a temporary patch): ADR 0023
rejected anchoring runner-mode launches on the reasoning that they "run in the
terminal's directory already". That was wrong. They reach the same shared
app-server through the same wrapper and record the same `/`, so a runner-mode
codex session is equally unable to say where it is — and equally invisible to
ADR 0014 discovery. Unlike a Placement it needs no callback, because the
directory is the invocation's own cwd, known before argv is composed. A
forwarded `--cd` or `-C` wins, as every dimension's native spelling does.

Rejected: an environment stamp, which codex cannot see; a marker file in the
workspace, which puts launcher state in the operator's checkout and in git's
way; and answering "not on a surface" as a successful empty result, which
makes the common gate two checks instead of one.
