# 0035: Explicit roles own their complete resource layer

Accepted September 14, 2026.

AgentStart's fixed resources remain the default for ordinary AgentLaunch
sessions. A direct Claude or Codex invocation prepared by AgentRoles instead
owns its complete skill and MCP layer, including deliberate omissions.
AgentLaunch preserves the role's native arguments and does not add the fixed
fleet plugin, Codex skill policy, or MCP definitions.

AgentRoles identifies this boundary with
`AGENTLAUNCH_ROLE_RESOURCES=agentroles-v1` alongside the existing absolute
`AGENTROLES_ROLE` and matching `AGENTROLES_NAME`. AgentLaunch rejects an
unsupported, orphaned, mismatched, missing, or unreadable source rather than
falling back to global resources. This is a local process contract, not an
authentication claim.

The marker is one-shot. AgentLaunch removes it before starting the native
harness while retaining the role path and name for role-aware skills. A nested
invocation that reaches AgentLaunch therefore receives the ordinary fixed
fleet resources unless it is explicitly invoked through AgentRoles again.
The recursion sentinel still lets already-managed bare shims bypass AgentLaunch.
This contract does not disable unrelated native ambient configuration or
change AgentVoice native subagent tool inheritance. Balanced role dry-runs include
the validated one-shot environment in `reprepare_command`, preserving account,
yolo, model, effort, native argument, and resource behavior without making the
marker sticky.

This record narrows [ADR 0030](0030-use-fixed-resources-with-native-codex.md)’s statement that every managed session receives
the fixed fleet set. It does not restore selectable AgentLaunch capability
flags or let AgentLaunch inspect, filter, or rewrite a role's resources.

Evidence: `src/role-resources.ts`, `src/commands.ts`, `src/launch.ts`,
`test/launch-command.test.ts`, `test/balance.test.ts`, and
`test/codex-launch.test.ts`.
