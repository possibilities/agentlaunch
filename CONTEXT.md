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
deletes it. _Avoid_: intent file (intent is AgentSurface's word).

**Launch spec** — The resolved native launch: harness, exact command argv, and
native session ID for a resume. `--x-dry-run --x-json` exposes it with the
associated decisions. _Avoid_: run (there is no AgentLaunch run lifecycle).

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
