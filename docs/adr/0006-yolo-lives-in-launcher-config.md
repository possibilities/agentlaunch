# 0006 — Yolo lives in launcher config, not in callers

Permission bypass is launcher configuration: one config file (or a
per-launch `--yolo`) injects each harness's own flag at spec build —
`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`,
`--approve` — skipped for utility invocations and for flags the caller
already forwarded. Upstream tools (orca's per-agent default args, scripts,
shims) stop encoding per-harness permission flags: they launch the bare
command and the config decides. Rejected: per-caller flags in every
integration, which drift, double-inject, and break utility subcommands.
