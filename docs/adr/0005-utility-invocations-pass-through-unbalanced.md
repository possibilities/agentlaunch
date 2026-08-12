# 0005 — Utility invocations pass through unbalanced

A first forwarded token that is a management or service word (codex
`login`/`app-server`/…, claude `doctor`/`mcp`/…, pi `auth`/…, and bare
`--help`/`--version`) makes the launch a utility invocation: it opens no
account-bound model session, so balancing it spends nothing and means
nothing, and the swap wrappers reject several outright — ndy refuses
`codex login` under an account pin. The launcher therefore skips the balance
prefix for these and launches the argv verbatim; the launch sentinel
(ADR 0004) still makes PATH shims exec the real binary. Classification is
first-token only and per-harness in `harness.ts`, mirroring each CLI's own
subcommand-over-prompt parsing; an unknown word stays a session launch, so
misclassification can only fail the way the raw CLI would.
