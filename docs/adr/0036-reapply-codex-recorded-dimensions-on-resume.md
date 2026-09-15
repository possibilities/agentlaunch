# 0036 — Reapply Codex's recorded dimensions on resume

Recorded September 15, 2026.

Codex 0.154 does not necessarily resume with the model that the session used
last. A canary session whose final turn recorded `gpt-5.6-sol` with `xhigh`
resumed under the invocation defaults `gpt-6-astra` with `high`, and Codex
warned that the recorded and resumed models differed. Native session ownership
therefore does not by itself preserve these two launch dimensions.

For a Codex resume, AgentLaunch reads the final `turn_context` from the native
rollout and reapplies its model and reasoning effort using Codex's native
arguments. It reports each value with source `session`, and the recorded model
also drives AgentUsage routing. An explicitly forwarded native model or effort
continues to own that dimension and suppresses only the corresponding recorded
injection. `--x-level` remains invalid because a resume is not a catalog-level
selection.

The read is bounded in memory and scans an uncompressed rollout backward in
chunks so the latest turn wins. Session stores remain read-only. Missing,
malformed, or compressed metadata yields unknown dimensions and no guessed
injection; the native session remains resumable. Claude behavior is unchanged:
AgentLaunch does not recover or inject Claude resume dimensions.

This replaces [ADR 0011](0011-the-harness-value-carries-model-and-effort.md)
and [ADR 0018](0018-a-level-is-its-own-flag.md)'s claims that resumes never
inject model or effort. It extends [ADR 0028](0028-a-resume-runs-in-native-session-cwd.md)'s
read-only native metadata rule without changing its cwd decision.

Rejected: trusting current invocation defaults, which caused the observed
model drift; taking a launcher level on resume, which would turn recovery into
a fresh catalog choice; and rewriting native session files, which would cross
the launch boundary and make recovery destructive.
