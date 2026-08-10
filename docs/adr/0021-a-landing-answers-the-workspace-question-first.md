# 0021 — A landing answers the harness's workspace question first

Before anything starts inside a workspace, a landing writes the answer to the
question the harness would otherwise stop and ask about a directory it has not
seen. Today that is codex alone, and the answer is a `[projects."<path>"]`
entry with `trust_level = "trusted"` in its own `config.toml`.

**Because an unattended launch that stops on a question is simply stuck.**
Verified against codex-cli 0.147.0: codex asks once per directory, before it
will do anything at all — the dialog's own words say trusting the directory is
what allows project-local config, hooks, and exec policies to load — and no
launch flag skips it. `--dangerously-bypass-approvals-and-sandbox` covers tool
approvals and leaves this untouched, which was checked directly: a fresh
directory prompts under it. So a landed codex run in a new worktree never
starts.

**Answered where the dialog itself writes it, for a directory the operator's
own tooling just created.** This is not suppression: it is pre-answering, by
the vendor's own supported means, a question whose answer was never in doubt —
the workspace was cut seconds earlier by a command the operator ran. An
existing entry is never rewritten, so a directory the operator has already
judged keeps their judgement, a refusal included.

**At the seam between materializing a workspace and starting anything in it.**
The surface API grew one hook for this (`prepare`), called with the
workspace's own path once it exists and before any attachment starts, because
only the backend knows that path — for a workspace it just created, nobody
else could. It is backend-generic: every backend must materialize a workspace
before running a command in it, so every backend has this moment. Throwing
from it refuses the placement before anything is started.

Rejected: writing the entry before the landing, which cannot know the path of
a workspace the backend has not created yet; blanket-trusting a parent
directory, which answers for directories nobody asked about; and leaving the
dialog to be answered by hand once per workspace, which makes the harness this
project exists to launch the one that cannot run unattended.
