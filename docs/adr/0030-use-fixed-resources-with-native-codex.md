# 0030: Use fixed resources with native Codex

AgentLaunch loads AgentStart's one fixed private resource set: a session-only
Claude plugin and qualified Codex skills from the globally installed
skills-only `agent` plugin. Codex
skills are persistently inert outside managed sessions and name-enabled by
session config, so AgentLaunch can launch native `codex-swap run/resume`
without an App Server, extra roots, a Unix socket, a remote TUI, or a fake
provider; Codex therefore owns linked-worktree trust and its complete native
session lifecycle again.

The former selectable packs, immutable projections, receipts,
`AGENTSTART_CAPABILITIES_ROOT`, `--x-capability`, and `--x-no-common` are
retired. This deliberately loses alternate and isolated session resource sets,
and changes Codex invocation names from bare `$<skill>` to
`$agent:<skill>`; balancing, claims, native history/resume, model/effort,
guidance, shims, and Herdr integration remain.
