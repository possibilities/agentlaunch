# 0009 — Yolo defaults on

Yolo is the launcher default: with no config at all, every launch gets its
harness's own permission-bypass flag (amends ADR 0006, where the config
enabled it). The config and flags exist to disable — `{"yolo": false}` or a
per-harness map in `~/.config/agentlaunch/config.json`, or per launch
`--x-no-yolo [harness]` / `--x-yolo [harness]`, repeatable, optionally
scoped, and read before the config so they still work while it is broken.
An explicit `--x-no-yolo` also redacts a yolo spelling the caller
explicitly forwarded, and the redaction is narrated; a config off only
declines to inject. Injection still skips utility invocations, never
duplicates a forwarded spelling (aliases included: pi `-a`), and never
overrides pi's own `--no-approve`. A malformed config still fails the
launch — silently misreading a config meant to disable would launch with
the gates down against the operator's wishes. Rejected: default-off with
an enabling config, which makes every caller carry policy state.
