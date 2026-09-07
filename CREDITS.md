# Account integration credits

The owned-account integration preserves launch, explicit-pin and native-resume
behavior previously supplied by [codex-swap](https://github.com/possibilities/codex-swap)
(Mike Bannister, MIT) and [claude-swap](https://github.com/realiti4/claude-swap)
(Onur Cetinkol and contributors, MIT), including our claude-swap integration fork.
Codex's former account backend was [codex-multi-auth](https://github.com/ndycode/codex-multi-auth)
(ndycode and contributors, MIT).

The new prepare validation, argument composition and parent-process lease
lifecycle in `src/balance.ts`, `src/account-session.ts` and `src/launch.ts` are
AgentLaunch integration code. Provider account implementations live in
AgentUsage. Its [source credits and license notices](https://github.com/possibilities/agentusage/blob/main/THIRD_PARTY_NOTICES.md)
record the specific upstream revisions, adapted behavior and protocol references.

[OpenAI Codex](https://github.com/openai/codex) (OpenAI and contributors,
Apache-2.0) supplied the native behavior used to establish provider-option
placement and resume compatibility. The bundle's tests exercise the stock CLI;
they do not bundle its Rust implementation.

This note covers the account replacement. AgentLaunch's existing in-house
AgentSurface lineage remains in Git, and package dependencies carry their own
licenses. Original AgentLaunch work is covered by [LICENSE](LICENSE).
