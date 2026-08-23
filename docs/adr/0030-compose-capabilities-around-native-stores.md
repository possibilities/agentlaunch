# 0030: Compose capabilities around native stores

AgentLaunch renders AgentStart capability packs through each harness's
session-native surface: a synthetic Claude `agent` plugin, process-local skill
roots on an ephemeral account-bound App Server for interactive Codex, exact
command-local config for non-interactive Codex, and explicit Pi resource
paths. It stores only pack receipts beside its own state; Claude, Codex, and Pi
keep their canonical history stores so native resume, cross-account resume,
and external indexing remain one merged history.

The Codex server is a caller-owned foreground invocation over codex-swap's
public `run` contract: codex-swap pins the selected account and heartbeats the
ordinary invocation lease, while AgentLaunch owns the listener, control
connection, remote TUI, and termination. No resident server, endpoint
registry, or attach lifecycle is introduced. After setting extra roots,
AgentLaunch also supplies session-flag `skills.config` entries for the exact
selected `SKILL.md` paths, so those skills win over lower-layer user disable
rules without globally installing them. Both the App Server and its remote TUI
receive the desktop compatibility-plugin disable: the TUI resolves local
plugins independently before connecting, while `skills.config` remains solely
on the server that owns the session projection.

The App Server transport is exclusive to Codex's interactive TUI. Codex
`exec` (including `e`) and `review` are account-bound model sessions but their
CLI rejects `--remote`; AgentLaunch therefore keeps those commands inside the
ordinary codex-swap `run` pin and injects the same exact `skills.config`,
compatibility-plugin disable, and merged guidance directly into the native
non-interactive command. Session classification still controls balancing and
receipts; transport classification only decides whether an App Server exists.
Codex parses every `-c` value as TOML, so the generated `skills.config` is an
array of TOML inline tables (`[{path="…",enabled=true}]`), never JSON objects.

The account-bound App Server spawn also removes the retired sidecar
environment's runtime-proxy kill switches. Long-lived parent sessions may
still carry them after cleanup, but a managed launch must not let stale
environment disable the credential proxy required by `codex-swap` pinning.

AgentLaunch keeps the control and interactive phases non-overlapping: it
connects to initialize and set roots, detaches, then gives the native remote
TUI ownership of the session. For a fresh session needing a non-default-pack
receipt, it reconnects after the TUI exits and compares loaded thread ids.
This makes connection ownership deterministic without depending on concurrent
client behavior from the experimental App Server transport.

The account-pinning server intentionally reports no local ChatGPT account
object even though its runtime proxy is authenticated. Codex's remote TUI
otherwise interprets that null account through its local built-in provider and
opens onboarding before connecting. AgentLaunch therefore gives only the TUI
a no-auth placeholder provider. Remote thread parameters omit
`model_provider`, so the server retains the real account-bound runtime proxy;
the placeholder never handles a model request.
