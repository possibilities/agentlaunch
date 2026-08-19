# AgentLaunch

AgentLaunch resolves, balances, and starts interactive Claude Code, Codex, and
Pi sessions. It can also find a native session by ID and resume it in the
directory recorded by that harness.

Its boundary ends when the native process starts. AgentLaunch has no workspace,
pane, agent identity, naming, presence, steering, or post-launch registry. A
native flag such as Claude's `--name` is forwarded unchanged and is never
interpreted or persisted here.

## Install

Requirements: Bun 1.3.14 or newer, the desired native harnesses, and—unless
launching with `--x-no-balance`—AgentUsage plus `cswap` and `codex-swap`.

```sh
git clone https://github.com/possibilities/agentlaunch.git ~/code/agentlaunch
~/code/agentlaunch/scripts/install.sh --install
```

The hardened, rerunnable installer links `~/.local/bin/agentlaunch` to the
checkout and writes a deployment receipt under
`~/.local/state/agentlaunch/`. It accepts `--uninstall` and refuses foreign or
unsafe paths instead of replacing them.

## Launch

```sh
agentlaunch --x-harness claude "fix the failing tests"
agentlaunch --x-level gpt-5.6-sol:ultra "hard problem"
agentlaunch --x-harness pi --x-level gpt-5.6-luna:max
agentlaunch --x-harness codex --x-dry-run --x-json
```

A launch must name `--x-harness`, `--x-level`, or both:

- `--x-harness claude|codex|pi` uses that harness's catalog defaults.
- `--x-level <model>:<effort>` chooses the earliest catalog harness offering
  the pair.
- Together, the flags pin and validate the full request.

AgentLaunch injects the resolved model and effort using each harness's native
spelling. Without `--x-level`, an explicitly forwarded native model or effort
argument owns that dimension. With `--x-level`, a duplicate native decision is
a usage error.

The partition rule is simple: every `--x-*` token belongs to AgentLaunch;
everything else belongs to the harness and remains in order. Unknown
`--x-*` flags fail. Unknown native flags—including `--name` or `-n`—are
forwarded without inspection.

## Surface form

```sh
agentlaunch x-surface
```

The one-screen interactive launcher: intent first, then project, worktree,
and the harness → model → effort cascade from the catalog. It runs under a
surface host (agentsurface hosts it in a herdr popup) and never launches
anything itself: the form renders on stderr, and each submitted launch is
written to stdout as one session-directive JSON line for the host to
realize as a herdr session. The form takes no arguments, needs a terminal
on stdin and stderr, and refuses a stdout that is a terminal — that means
no host is reading. Project roots and priming choices come from the config
(`roots`, `priming`); an interrupted form is restored from its draft on the
next open. The `surface-handoff-protocol` wiki page documents the directive
contract.

## Resume

```sh
agentlaunch x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60
agentlaunch x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60 --x-harness claude
```

Without `--x-harness`, AgentLaunch searches all three native stores. It
refuses absent or ambiguous IDs. With `--x-harness`, it skips detection and
uses that harness's native resume spelling.

The resumed process starts in the cwd recorded by the native session. If the
directory is unavailable, AgentLaunch says so and starts where it was invoked.
Resume injects no model or effort; the session continues with its native state.

| Harness | Store (override honored) | Native resume |
| --- | --- | --- |
| Claude | `$CLAUDE_CONFIG_DIR` or `~/.claude/projects` | `claude --resume <id>` |
| Codex | `$CODEX_HOME` or `~/.codex` | `codex resume <id>` |
| Pi | `$PI_CODING_AGENT_DIR` or `~/.pi/agent/sessions` | `pi --session <id>` |

## Accounts and permissions

Session launches balance by default:

- Claude: `agentusage balance claude`, then `cswap run <slot> --share-history`.
- Codex and Pi: `agentusage balance codex`, then `codex-swap run|resume` or
  `codex-swap pi run` with the selected account/claim.

`--x-account <selector>` pins a balanced launch but keeps the swap tool's
eligibility checks. `--x-no-balance` runs the raw harness.
`AGENTLAUNCH_NO_BALANCE=1` makes that the machine default.

Yolo is on by default and means each harness's own unattended setting:

- Claude: `--permission-mode auto`
- Codex: `--dangerously-bypass-approvals-and-sandbox`
- Pi: `--approve`

Use `--x-no-yolo`, optionally followed by a harness scope. A caller-supplied
native gate flag wins; explicit `--x-no-yolo` removes a forwarded positive
yolo spelling and reports that redaction. Utility invocations such as
`codex login`, `claude doctor`, and `pi auth` pass through without balance or
yolo injection.

## Output and machine use

Before a launch, labelled decision rows go to stderr. Stdout remains the
result. `--x-dry-run` prints a shell-runnable command; adding `--x-json`
prints a schema-versioned envelope with the exact argv and decisions.

```sh
agentlaunch --x-harness codex --x-dry-run --x-json
agentlaunch x-resume <id> --x-dry-run --x-json
agentlaunch x-doctor --x-json
agentlaunch x-catalog --x-json
```

`--x-json` requires `--x-dry-run` for interactive launches. Real launches
adopt the native harness's exit status. Domain failures exit 1; usage faults
exit 2.

`x-doctor` reports native binaries, store paths/counts and overrides, config,
and catalog health. It is read-only.

`x-catalog` reports the resolved catalog — each harness's models, allowed
efforts, and defaults: the validated pair space `--x-level` accepts. Tools
that offer launch choices (AgentSurface's launcher, for one) consume it at
runtime instead of re-reading catalog files. It is read-only.

## Configuration and catalog

The optional strict config is `~/.config/agentlaunch/config.json`:

```json
{
  "$schema": "/path/to/config.schema.json",
  "yolo": { "claude": true, "codex": false, "pi": true },
  "roots": ["~/code", "~/src"],
  "priming": ["collab", "build"]
}
```

The built-in [catalog.json](catalog.json) defines harness order, models,
efforts, defaults, and native spellings. A custom
`~/.config/agentlaunch/catalog.json` replaces it outright. Both formats have
checked-in JSON Schemas generated from strict Zod sources.

## Bare harness shims

Fleet installations may route bare `claude`, `codex`, and `pi` through
AgentLaunch. The child receives `AGENTLAUNCH_LAUNCH=1`; the shims use that
sentinel to exec the real binary rather than recur. The shims are installed by
the fleet owner, not this repository.

## Development

```sh
bun install --frozen-lockfile
bun run check
bash scripts/smoke.sh
```

The project is MIT licensed. Historical AgentSurface commits are retained in
Git; the current product intentionally contains only native launch and resume.
