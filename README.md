# AgentLaunch

AgentLaunch resolves, balances, and starts native Claude Code and Codex
sessions, including Codex's non-interactive session commands. It can also find
a native session by ID and resume it in the directory recorded by that harness.

Its boundary ends at the native session: AgentLaunch has no workspace, pane,
agent identity, naming, presence, steering, conversation registry, App Server,
socket, or remote TUI. AgentLaunch starts the native binary with an AgentUsage
account lease, so Codex itself owns linked-worktree trust, history,
resume, and terminal behavior. A native flag such as Claude's `--name` is
forwarded unchanged and is never interpreted or persisted here.

## Install

Requirements: Bun 1.3.14 or newer, the desired native harnesses, and—unless
launching with `--x-no-balance`—AgentUsage with enrolled accounts and its daemon
running. See AgentUsage’s README for `accounts login` / `accounts import` and
cutover. Claude/Codex swap tools and codex-multi-auth are not dependencies.

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
agentlaunch --x-harness codex --x-level gpt-5.6-luna:max
agentlaunch --x-harness codex --x-dry-run --x-json
```

A launch must name `--x-harness`, `--x-level`, or both:

- `--x-harness claude|codex` uses that harness's catalog defaults.
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

## Fleet resources

Every managed session receives AgentStart's one fixed private resource set at
`~/.local/share/agentstart/resources`. It is not selectable: the retired
`--x-capability` and `--x-no-common` flags are explicit usage errors.

- Claude receives `--plugin-dir` for one synthetic plugin named `agent`, so
  skills are `/agent:<skill>` and the plugin's configured MCP servers are
  session-only.
- Codex uses the globally installed skills-only `agent@agentstart-managed`
  plugin. Its `$agent:<skill>` names are persistently disabled outside managed
  sessions and name-enabled through session config on native interactive,
  resume, `exec`/`e`, and `review` launches. The same session config injects
  the same MCP definitions without adding them to ambient Codex configuration.
  AgentStart currently supplies Executor for shared fleet tools and a direct
  shadcn connection that retains the project working directory.

The native homes do not move: Claude and Codex keep their configuration and
shared history in the usual homes (including environment overrides). Resume
prepares a fresh account without copying history. Utility invocations such as
`codex login` and `codex app-server` receive no fleet resources or proxy config.
LiveKit is absent from the fixed set and is not injected into either harness.

## Surface form

```sh
agentlaunch --x-surface
```

The one-screen interactive launcher: intent first, then project, worktree,
and the harness → model → effort cascade from the catalog. It runs under a
surface host (agentsurface hosts it in a herdr popup) and never launches
anything itself: the form renders on stderr, and each submitted launch is
written to stdout as one session-directive JSON line for the host to
realize as a herdr session. The form takes no other arguments, needs a terminal
on stdin and stderr, and refuses a stdout that is a terminal — that means
no host is reading. Project roots and priming choices come from the config
(`roots`, `priming`); an interrupted form is restored from its draft on the
next open. Priming spells Claude skills as `/agent:<skill>` and Codex as
`$agent:<skill>`. An intent that already leads with a slash command is its own
invocation, so the priming row reads `none` and stops taking input until the
intent does not. The `surface-handoff-protocol` wiki page documents the
directive contract.

## Resume

```sh
agentlaunch x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60
agentlaunch x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60 --x-harness claude
```

Without `--x-harness`, AgentLaunch searches both native stores. It
refuses absent or ambiguous IDs. With `--x-harness`, it skips detection and
uses that harness's native resume spelling.

The resumed process starts in the cwd recorded by the native session. If the
directory is unavailable, AgentLaunch says so and starts where it was invoked.
Resume injects no model or effort; the session continues with its native state.

| Harness | Store (override honored) | Native resume |
| --- | --- | --- |
| Claude | `$CLAUDE_CONFIG_DIR` or `~/.claude/projects` | `claude --resume <id>` |
| Codex | `$CODEX_HOME` or `~/.codex` | `codex resume <id>` |

## Accounts and permissions

Session launches call `agentusage prepare claude|codex --json` by default.
AgentUsage owns accounts, usage, policy and the single loopback proxy. It returns
native arguments, private environment and a 90-second lease. AgentLaunch’s
existing parent renews every 25 seconds and releases on exit or failed spawn.
Credentials stay out of argv, narration and JSON results. Native homes remain
unchanged. A rejected/expired lease terminates the child with resume guidance;
a parent suspended beyond the TTL cannot revive it.

`--x-account <key|ordinal|email|label>` pins an account while retaining eligibility
checks. Every launch and resume prepares afresh. An automatic Codex session can
switch after an explicit quota rejection of a self-contained request, before
streaming, with at most three accounts attempted. Pins stay fixed. Generic
throttling, timeouts, disconnects and account-bound continuations do not replay.
The next lease renewal reports any changed account. If a session has stopped
for quota, `x-resume <id>` selects again from the available accounts.

Explicit native provider/auth overrides are rejected before preparing a lease.
Ambient credentials are cleared only as specified by AgentUsage’s `unset_env`;
use `--x-no-balance` for intentional native authentication. Codex transport
config is appended after native/resource options and before the first literal
`--`, in the effective native subcommand scope. This preserves profile, user
config and resource overlays on exec and resume.

`--x-no-balance` runs the raw harness.
Configure the default in `~/.config/agentlaunch/config.json` (or under
`$XDG_CONFIG_HOME/agentlaunch`). Disable both with `"balance": false`, or
choose separately:

```json
{
  "balance": {
    "claude": false,
    "codex": true
  }
}
```

An omitted setting or harness defaults to balancing on. Disabled launches and
resumes use the native harness's configured authentication, skipping AgentUsage
preparation; fleet resources and yolo policy still apply.

Environment switches override config for processes inheriting them:

```sh
export AGENTLAUNCH_NO_BALANCE=1        # disable both
export AGENTLAUNCH_CLAUDE_NO_BALANCE=1 # disable Claude only
export AGENTLAUNCH_CODEX_NO_BALANCE=1  # disable Codex only
```

Each nonempty value disables balancing, including `0` or `false`; unset or
empty means no override. The global switch disables both regardless of the
per-harness switches. `--x-no-balance` always disables for that invocation.
These controls only disable: remove them to use the config default again.
An account pin (`--x-account`) is rejected when balancing is disabled.
Already-running processes must inherit the updated environment for environment
changes to apply; config is read on each launch.

Yolo is on by default and means each harness's own unattended setting:

- Claude: `--dangerously-skip-permissions --allow-dangerously-skip-permissions`
- Codex: `--dangerously-bypass-approvals-and-sandbox`

Use `--x-no-yolo`, optionally followed by a harness scope. A caller-supplied
native gate flag wins; explicit `--x-no-yolo` removes a forwarded positive
yolo spelling and reports that redaction. Utility invocations such as
`codex login` and `claude doctor` pass through without balance or yolo injection.

## Output and machine use

Before a launch, labelled decision rows go to stderr. Stdout remains the
result. A balanced `--x-dry-run` reserves nothing and prints a credential-free
AgentLaunch invocation, pinned to the previewed account, which prepares again
when run. It includes the launch cwd. It needs no live daemon.

With `--x-json`, `command` is the planned native argv;
`command_requires_prepare: true` means it needs private environment from a fresh
prepare and is not directly runnable. Execute `reprepare_command` in `cwd` to
reproduce the preview. No lease or bearer is emitted. Unbalanced and utility
dry runs have `command_requires_prepare: false` and `reprepare_command: null`.

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
  "yolo": { "claude": true, "codex": false },
  "roots": ["~/code", "~/source"],
  "priming": ["collab", "build"]
}
```

The built-in [catalog.json](catalog.json) defines harness order, models,
efforts, defaults, and native spellings. A custom
`~/.config/agentlaunch/catalog.json` replaces it outright. Both formats have
checked-in JSON Schemas generated from strict Zod sources.

## Bare harness shims

Fleet installations may route bare `claude` and `codex` through
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

[Account integration credits](CREDITS.md) acknowledge the predecessor projects
and link to AgentUsage's detailed source and license notices.
