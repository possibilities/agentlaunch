export const VERSION = "agentlaunch 0.1.0";

export const TOP_HELP = `agentlaunch — resolve, balance, and launch claude, codex, or pi

Usage:
  agentlaunch --x-harness <claude|codex|pi> [--x-level <model>:<effort>] [native tokens…]
  agentlaunch --x-level <model>:<effort> [native tokens…]
  agentlaunch --x-surface
  agentlaunch x-resume <native-session-id> [--x-harness <name>] [native tokens…]
  agentlaunch x-doctor [--x-json]
  agentlaunch x-catalog [--x-json]

Commands:
  launch       Any invocation not beginning with x-. Resolve the harness,
               model, effort, yolo policy, and account, then become it.
  --x-surface  One-screen interactive launch form. Instead of launching, each
               submit emits a session directive to the file named by
               AGENTSURFACE_DIRECTIVES, for a surface host (agentsurface) to
               realize as a herdr session. Takes no other arguments.
  x-resume     Detect a native session store and resume in its recorded cwd.
  x-doctor     Report harness binaries, native stores, config, and catalog.
  x-catalog    Report the resolved catalog: models and efforts per harness.

Extension flags are the reserved --x-* namespace. Every other token is
forwarded in order and interpreted only by the native harness.

Common:
  --x-harness <name>     claude|codex|pi
  --x-level <m>:<e>      Resolve and inject one catalog model/effort pair
  --x-account <selector> Pin a balanced launch to an eligible account
  --x-no-balance         Run the native harness without the account stack
  --x-prompt-file <path> Append the file's text as the final native token
  --x-yolo [harness]     Enable the harness's unattended permission setting
  --x-no-yolo [harness]  Disable it; removes a forwarded positive spelling
  --x-dry-run            Print the resolved command instead of launching
  --x-json               Machine envelope; requires --x-dry-run for launches
  --x-verbose            Add mechanism rows to the stderr narrative
  --x-help               Command help

Other:
  --version, -V          Print the version
  --agent-help           Print the agent-oriented runbook
  --agent-teaser         Print the one-line agent summary

Config and catalog:
  ~/.config/agentlaunch/config.json
  ~/.config/agentlaunch/catalog.json

Environment:
  AGENTLAUNCH_NO_BALANCE=1   Default launches to unbalanced
  AGENTLAUNCH_LAUNCH=1       Recursion sentinel used by bare harness shims

Examples:
  agentlaunch --x-harness claude "fix the failing tests"
  agentlaunch --x-level gpt-5.6-sol:ultra "hard problem"
  agentlaunch --x-harness pi --x-level gpt-5.6-luna:max --x-dry-run --x-json
  agentlaunch x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60
`;

export const HELP: Record<string, string> = {
  launch: `agentlaunch [extension flags] [native harness tokens…]

At least one of --x-harness or --x-level is required. --x-harness alone
uses that harness's catalog defaults. --x-level alone selects the earliest
catalog harness offering the pair. Together they pin and validate all three
dimensions.

If no native model or effort argument is present, AgentLaunch injects the
resolved native spelling. A forwarded native model or effort wins unless
--x-level was explicit, in which case the duplicate decision is a usage fault.
Native tokens such as --name are opaque: AgentLaunch forwards them unchanged
and neither interprets nor records them.

--x-prompt-file <path> reads the file (UTF-8) and appends its exact text as
one final native token — for callers whose own argv cannot carry the text,
such as a shell-typed line that refuses control characters. The file is read
once at launch and never deleted; an unreadable or empty file is an error.

Management invocations such as codex login, claude doctor, pi auth, and bare
--version pass through unbalanced and receive no yolo injection.

Launches balance by default through agentusage, then compose cswap for Claude
or codex-swap for Codex/Pi. --x-account pins the selection while retaining the
swap tool's eligibility gate. --x-no-balance (or AGENTLAUNCH_NO_BALANCE=1)
executes the raw harness.

The launch narrative goes to stderr; stdout remains the dry-run command or JSON
envelope. Real launches exit with the native harness's exit status.
`,
  "x-resume": `agentlaunch x-resume <native-session-id> [flags] [native tokens…]

Without --x-harness, AgentLaunch scans the native Claude, Codex, and Pi session
stores. No match and multiple matches are explicit errors. --x-harness skips
detection and selects the native resume spelling directly.

The resumed process starts in the cwd stored in the native session metadata.
If that directory is gone or unavailable, the narrative says so and the
process starts where AgentLaunch was invoked. A resume never injects a model or
effort: the native session continues with its own state. A forwarded Claude
--model is used only to guide account balancing.

Stores (environment overrides honored):
  claude  $CLAUDE_CONFIG_DIR|~/.claude/projects/*/<id>.jsonl
  codex   $CODEX_HOME|~/.codex/{sessions/**,archived_sessions}/rollout-*-<id>.jsonl[.zst]
  pi      $PI_CODING_AGENT_DIR|~/.pi/agent/sessions/*/*_<id>.jsonl

Pi resumes with --session <id>; its native --resume is a picker.
`,
  "x-doctor": `agentlaunch x-doctor [--x-json]

Report each native harness binary, session-store path and count, active store
override, the strict yolo config, and the active built-in or custom catalog.
Doctor reads only; it neither repairs nor creates state.
`,
  "x-catalog": `agentlaunch x-catalog [--x-json]

Report the resolved catalog: each harness in priority order with its models,
every model's allowed efforts and default effort, and the harness's default
<model>:<effort> pair. This is the validated pair space --x-level accepts —
tools that offer launch choices consume it at runtime instead of re-reading
or re-resolving catalog files. A custom catalog replaces the built-in when
present, exactly as it does for launches. Reads only.
`,
};

export const AGENT_TEASER =
  "Resolve, balance, launch, and resume native claude/codex/pi sessions: agentlaunch --x-harness <name> [--x-level <model>:<effort>] [native tokens…], x-resume <native-session-id>, x-doctor, and x-catalog.";

export const AGENT_HELP = `agentlaunch agent runbook

Use AgentLaunch when starting or resuming an interactive Claude, Codex, or Pi
session. It owns only pre-launch resolution: harness/model/effort, yolo policy,
account balancing, native session-store detection, and resume cwd recovery.

Grammar
  - Every --x-* token is AgentLaunch's and is never forwarded.
  - Every other token is the native harness's, in the order typed.
  - Unknown --x-* tokens are usage faults; unknown native tokens are forwarded.
  - A native --name/-n is ordinary forwarded input. AgentLaunch has no naming,
    identity, registry, or post-launch lifecycle.

Machine use
  - Add --x-dry-run --x-json for a schema_version 1 envelope containing the
    final argv, cwd, balance decision, yolo/redactions, and model/effort report.
  - --x-json without --x-dry-run is a usage fault for interactive launches.
  - Domain failures are ok:false envelopes with exit 1; usage faults are help
    on stderr with exit 2; real launches adopt the native harness exit code.
  - --x-surface is the operator's interactive form for a surface host; it
    needs a TTY and AGENTSURFACE_DIRECTIVES, so agents should not run it.

Examples
  agentlaunch --x-harness codex --x-dry-run --x-json
  agentlaunch --x-level gpt-5.6-sol:ultra "hard problem"
  agentlaunch x-resume <native-session-id> --x-dry-run --x-json
  agentlaunch x-catalog --x-json
`;
