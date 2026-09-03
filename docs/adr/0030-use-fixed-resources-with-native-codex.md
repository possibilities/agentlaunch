# 0030: Use fixed resources with native Codex

AgentLaunch loads AgentStart's one fixed private resource set: a session-only
Claude plugin containing skills and shadcn, plus qualified Codex skills from
the globally installed skills-only `agent` plugin. Codex skills are
persistently inert outside managed sessions, while the same session config
name-enables them and injects the fixed shadcn MCP definition. This keeps both
resource kinds out of unmanaged sessions while AgentLaunch launches native
`codex-swap run/resume` without an App Server, extra roots, a Unix socket, a
remote TUI, or a fake provider; Codex therefore owns linked-worktree trust and
its complete native session lifecycle again.

The former selectable packs, immutable projections, receipts,
`AGENTSTART_CAPABILITIES_ROOT`, `--x-capability`, and `--x-no-common` are
retired. This deliberately loses alternate and isolated session resource sets,
and changes Codex invocation names from bare `$<skill>` to
`$agent:<skill>`; balancing, claims, native history/resume, model/effort,
guidance, unrelated ambient MCPs, shims, and Herdr integration remain. LiveKit
is deliberately absent rather than carried into the fixed set.
