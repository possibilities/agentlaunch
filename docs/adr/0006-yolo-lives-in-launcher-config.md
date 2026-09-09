# 0006 — Yolo lives in launcher config, not in callers

Status review 2026-09-08: partially superseded.
[ADR 0009](0009-yolo-defaults-on.md) changes the default; [ADR 0031](0031-claude-yolo-is-the-bypass-and-its-permit.md) replaces Claude’s native flag spelling. Launcher ownership and forwarded native gates remain.

Unattended permission policy is launcher configuration: one config file (or a
per-launch `--x-yolo`) injects each harness's native setting at spec build —
Claude `--permission-mode auto`, Codex
`--dangerously-bypass-approvals-and-sandbox` — skipped for
utility invocations and native gate flags the caller already forwarded.
Callers stop encoding per-harness permission flags: they launch the native
command and the config decides. Rejected: per-caller flags in every
integration, which drift, double-inject, and break utility subcommands.
