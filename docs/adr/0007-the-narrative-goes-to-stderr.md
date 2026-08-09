# 0007 — The launch narrative goes to stderr

Bare `claude` now balances accounts, injects permission flags, and wraps
itself in a swap prefix before anything appears on screen, so every launch
narrates those decisions. That narration is commentary, not the result:
stdout carries the result — a dry run's runnable shell line, or the JSON
envelope — and prose there would corrupt both. On a terminal the two
streams are indistinguishable, so the story costs a human nothing and costs
a pipe nothing. `--json` silences it entirely, because the envelope already
carries every fact the story would tell. Rejected: narrating to stdout and
suppressing it under `--json`, which still breaks `--dry-run | sh`.
