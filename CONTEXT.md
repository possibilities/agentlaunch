# Glossary

**Harness** — One native interactive agent CLI: `claude`, `codex`, or `pi`.
AgentLaunch selects one but does not replace its behavior. _Avoid_: backend.

**Native token** — Any command-line token outside the reserved `--x-*`
namespace. Forwarded in order and judged only by the harness. `--name` and
`-n` are native tokens; AgentLaunch gives them no special meaning. _Avoid_:
passthrough flag (the whole native vocabulary passes through).

**Extension flag** — An AgentLaunch control in the reserved `--x-*`
namespace, removed before the native command runs. Unknown extension flags are
usage errors. _Avoid_: wrapper flag.

**Level** — One catalog pair, `<model>:<effort>`, requested by `--x-level`.
The catalog validates the pair and resolves the harness and native spellings.

**Prompt file** — A path passed as `--x-prompt-file` whose UTF-8 text becomes
the final native token of a launch, appended after every dimension and yolo
decision. For callers whose own argv cannot carry the text (herdr refuses
control characters in a shell-typed line). AgentLaunch reads it once and never
deletes it. _Avoid_: intent file (the intent is the surface form's word for
what the operator typed; a surface host spools it into a prompt file when it
realizes a directive).

**Surface form** — The interactive one-screen launcher `--x-surface` opens:
intent first, then project, worktree, and the harness → model → effort cascade
from the catalog. It renders on stderr and emits session directives on stdout
instead of becoming a harness — the same launch with a different outcome,
which is why the activator is a flag and not a command. _Avoid_: launcher
popup (the popup is the host's chrome, not this form).

**Session directive** — One schema-versioned JSON line describing a session
for a surface host to realize: cwd, worktree, focus, the agent kind with its
launch arguments, the composed intent, and opaque record extras. The
`surface-handoff-protocol` wiki page is the contract. _Avoid_: launch plan
(the plan is form state; the directive is what leaves).

**Directive stream** — stdout under `--x-surface`: the host holds it as a pipe
while the form renders on stderr, and the form writes one directive line per
committed launch, owning nothing past the write. A stdout that is a terminal
means no host is reading, and the form refuses to open. _Avoid_: sink file
(the file channel was the first spelling; the stream replaced it).

**Launch spec** — The resolved native launch: harness, exact command argv, and
native session ID for a resume. `--x-dry-run --x-json` exposes it with the
associated decisions. _Avoid_: run (there is no AgentLaunch run lifecycle).

**Capability pack** — An AgentStart-installed bundle of skills, guidance, and
harness resources under `~/.local/share/agentstart/capabilities/packs`.
`common` is the default; `--x-capability` adds a pack and `--x-no-common`
suppresses the default. _Avoid_: plugin (only Claude's projection is a
plugin), global skill.

**Session projection** — The immutable, content-addressed rendering of one
resolved capability set for one harness launch. Claude receives an `agent`
plugin, interactive Codex receives standalone skill roots through its App
Server, non-interactive Codex receives exact command-local skill config, and
Pi receives explicit resource paths with ambient discovery disabled. _Avoid_:
install (a projection is selected, not globally registered).

**Capability receipt** — AgentLaunch bookkeeping keyed by a native session ID,
containing only non-default pack IDs and their digest so a resume restores the
same selection. It is not conversation history; native stores remain the sole
history authority. _Avoid_: session registry.

**Managed Codex App Server** — The ephemeral account-bound server AgentLaunch
supervises for one interactive Codex TUI so it can set process-local skill
roots before the native client connects. The TUI remains native and connects
with `codex --remote`; codex-swap pins the foreground server through its
ordinary `run`/lease contract, while AgentLaunch owns the listener, client,
and lifetime. It is never used for `codex exec`, `codex e`, or `codex review`,
whose CLI contract rejects `--remote`. _Avoid_: embedded Codex, resident
server, alternate session store.

**Native session** — A conversation owned and persisted by the harness. Its ID,
metadata, name (if any), and lifecycle are native state. AgentLaunch only reads
the ID/store/cwd needed to resume it. _Avoid_: AgentLaunch session.

**Session store** — The harness's own files under the native default or its
environment override (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
`PI_CODING_AGENT_DIR`). AgentLaunch never writes them.

**Resume cwd** — The directory recorded in native session metadata. A resume
starts there when it still exists; otherwise it starts in the invocation cwd
and states the missing/unknown native directory.

**Anchor** — The native Codex `--cd <absolute-cwd>` AgentLaunch adds to a new
Codex launch unless the caller already supplied `--cd`/`-C`. This ensures the
native session records the launch directory. Claude and Pi inherit cwd.

**Utility invocation** — A harness management/service command that opens no
account-bound model session, such as `codex login`, `claude doctor`, `pi auth`,
or bare `--version`. It passes through unbalanced and without yolo injection.

**Balance** — Choosing an eligible account through `agentusage balance`.
AgentLaunch consumes the answer; AgentUsage owns policy and capacity facts.

**Swap** — Starting under the chosen account: `cswap` for Claude,
`codex-swap` for Codex and Pi. Choosing is balance; credential activation is
swap.

**Pin** — `--x-account <selector>`, which forces the candidate account while
retaining the swap tool's eligibility gate. _Avoid_: bypass.

**Yolo** — Each harness's native unattended permission setting, enabled by
default and configurable globally/per harness. An explicit `--x-no-yolo` may
redact a caller-forwarded positive spelling; the narrative reports it.

**Narrative** — Labelled decisions on stderr before the harness starts: cwd,
model, effort, yolo, account, and command. `--x-verbose` adds mechanism;
`--x-json` silences it.

**Envelope** — The `{schema_version, ok, error, data}` JSON result emitted by
machine-format commands. Usage faults happen before command execution and are
not envelopes.

**Recursion sentinel** — `AGENTLAUNCH_LAUNCH=1`, set on launched descendants
so fleet-owned bare harness shims exec the real binary instead of returning to
AgentLaunch.
