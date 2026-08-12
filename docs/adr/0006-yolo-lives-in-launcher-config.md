# 0006 — Yolo lives in launcher config, not in callers

Unattended permission policy is launcher configuration: one config file (or a
per-launch `--x-yolo`) injects each harness's native setting at spec build —
Claude `--permission-mode auto`, Codex
`--dangerously-bypass-approvals-and-sandbox`, Pi `--approve` — skipped for
utility invocations and native gate flags the caller already forwarded.
Callers stop encoding per-harness permission flags: they launch the native
command and the config decides. Rejected: per-caller flags in every
integration, which drift, double-inject, and break utility subcommands.
