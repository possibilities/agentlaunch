# 0001 — One CLI ends at the native launch boundary

AgentLaunch is one CLI for resolving, balancing, launching, and resuming the
two native harnesses. Its state ends at config and catalog. The harness owns
the session; an agent development environment owns workspaces, panes, identity,
presence, and steering.

Every token outside the reserved `--x-*` namespace is native input. AgentLaunch
does not interpret or persist native naming flags. Resume reads native stores
by session ID and cwd only; there is no launch registry or alternate identity.

Rejected: retaining AgentSurface lifecycle concepts in a launcher, because it
duplicates both the harness's session state and the environment's orchestration
state while coupling otherwise portable command resolution to one environment.
