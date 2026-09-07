# 0032 — AgentUsage owns account preparation

AgentLaunch now starts Claude and Codex directly after a bounded, validated
`agentusage prepare` response. AgentUsage owns the account pool, provider
credentials, policy and one authenticated loopback proxy in its existing daemon.
Native homes and history do not move. No swap executable participates.

The existing launcher parent maintains the private 90-second lease and releases
it on native exit or every failure after prepare. It stops and awaits renewals
before release. It terminates the native child if the lease expires or is
rejected. Credentials and private environment stay outside argv, narration and
result data. Utilities, including AgentVoice’s `codex app-server`, remain native
without provider injection; Realtime is outside this Responses transport.

Dry runs reserve nothing. Human output is a credential-free AgentLaunch
re-prepare invocation pinned to the preview account. JSON keeps planned native
`command`, `command_requires_prepare` and `reprepare_command` in the reported
cwd. Eligibility is checked afresh when executed.

Stock Codex 0.153.4 demonstrated that subcommand-local config discards global
`-c` values. Transport overrides therefore follow user/resource options and
precede the first literal `--`. Resources enter the nested `exec resume` scope.
Native acceptance covers profiles, user config, resource overlays, exec,
nested exec resume and interactive resume against isolated mock upstreams.

Automatic Codex leases may change account following an explicit quota rejection
of a self-contained request before streaming, with at most three accounts.
Pins never switch; generic failures and account-bound continuations do not
replay. Renewal reports the current account identity. Every resume prepares a
fresh account without finding or killing a per-session proxy.

This supersedes ADR 0003’s swap prefixes, ADR 0004’s swap-child implementation
details and ADR 0030’s swap transport. Their native-history, recursion-sentinel,
utility-bypass and fixed-resource decisions remain.
