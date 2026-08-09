# Glossary

- **Harness** — An agent CLI/TUI that owns a conversation: claude, codex, pi. _Avoid_: agent (that is a running conversation), model.
- **Runner** — agentsurface acting as a passthrough launcher in the current terminal and cwd, no surface involved. _Avoid_: wrapper mode, local mode.
- **Surface** — A managed environment where launches land and can be referred to and controlled afterwards; Orca is the first backend, the API stays backend-generic. _Avoid_: platform, ADE (one backend, not the concept).
- **Open in place** — Starting a fresh harness session as the runner: agentsurface becomes the harness and gets out of the way. _Avoid_: spawn, attach.
- **Launch spec** — The pure description of a launch: harness, command argv, session id when known. `--dry-run` prints it, the runner execs it, a surface will consume it. _Avoid_: plan, invocation.
- **Session** — One harness conversation persisted in its session store, resumable by id. _Avoid_: run (a run is a session plus where it landed), thread, chat.
- **Session store** — The per-harness on-disk session location — claude `…/.claude/projects`, codex `…/.codex/sessions` plus `archived_sessions`, pi `…/.pi/agent/sessions` — each relocatable by env (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`). _Avoid_: history, database.
- **Run name** — The human display label on a session: `--name` on claude and pi; codex has none. _Avoid_: title, label.
- **Passthrough** — Argv after `--`, forwarded to the harness verbatim, invisible to the strict parser. _Avoid_: extra args, rest.
- **Effort** — The one canonical reasoning-depth flag with per-harness value sets, spelled `--thinking` on pi and `-c model_reasoning_effort=` on codex. _Avoid_: thinking (pi's spelling, not the concept).
- **Surface flags** — The reserved `--x-*` namespace (e.g. `--x-surface-session`); their absence means runner mode. _Avoid_: extension flags.
- **Land** — Merging a worktree's finished work back to the main line, with the surface's bookkeeping (later slice). _Avoid_: merge (land is merge plus surface state).
- **Swap** — Running a harness under one specific account's credentials/profile: cswap for claude, codex-swap for codex and pi (`codex-swap pi run`, pi rides the codex account pool). _Avoid_: balancing (choosing the account is balancing; running under it is swap).
- **Balance** — Choosing which account a launch should use, from live quota observations; `agentusage balance` owns this and launchers consume its answer. On by default for every launch (ADR 0003). _Avoid_: swap.
- **Balanced launch** — A launch whose spec is wrapped in the chosen account's swap prefix; the harness argv after the wrapper's `--` stays byte-identical. _Avoid_: routed launch (keeper's term).
- **Utility invocation** — A launch whose first forwarded token is a management or service word (codex `login`, claude `doctor`, pi `auth`, bare `--version`…): it opens no account-bound session, so it passes through unwrapped instead of balancing (ADR 0005). _Avoid_: passthrough (that is the argv after `--`, a different thing).
- **Pin** — Forcing a balanced launch onto one named account with `--x-account`; the swap tool's eligibility gate still judges it. _Avoid_: override (that is `--x-no-balance`).
- **Envelope** — The `{schema_version, ok, error, data}` wrapper every machine-format outcome is emitted in, shared across the agent* family; usage faults exit before a command runs and are not Envelopes. _Avoid_: payload.
