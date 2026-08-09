export const VERSION = "0.1.0";

export const COMMANDS = [
  { name: "open", summary: "Open a harness in place: claude, codex, or pi in this terminal" },
  { name: "resume", summary: "Reopen a stored session by id, detecting which harness owns it" },
  { name: "doctor", summary: "Report harness binaries, session stores, and env overrides" },
  { name: "help", summary: "Show help for a command" },
] as const;

const COMMAND_LINES = COMMANDS.map(
  (command) => `  ${command.name.padEnd(8)} ${command.summary}`,
).join("\n");

export const TOP_HELP = `agentsurface — one launcher for agent harnesses

Usage:
  agentsurface <command> [options] [-- <harness args>]

Global options:
  --json             Emit the stable JSON envelope (launch commands: with --dry-run)
  --help, -h         Show this help

Top-level options (before any command):
  --version, -V      Show the version
  --agent-help       Show the agent runbook
  --agent-teaser     Show a one-line capability summary

Commands:
${COMMAND_LINES}

Everything after -- goes to the harness verbatim. Launch commands exit with
the harness's exit code. Run agentsurface help <command> for details.
`;

export const HELP: Record<string, string> = {
  open: `agentsurface open <harness> [prompt] [options] [-- <harness args>]

Open claude, codex, or pi in this terminal and cwd. The wrapper execs the
harness and exits with its exit code.

Options:
  --model <model>    Model, passed through untranslated
  --effort <level>   Reasoning effort; per-harness values:
                       claude  low|medium|high|xhigh|max
                       codex   minimal|low|medium|high|xhigh
                       pi      off|minimal|low|medium|high|xhigh|max
                     (spelled --thinking on pi, -c model_reasoning_effort= on codex)
  --name <name>      Run name; claude and pi only, codex is refused
  --yolo, --no-yolo  Override the config's yolo (permission bypass) default
  --x-account <sel>  Pin the balanced launch to one account (claude: route or
                     cN; codex/pi: account key or email) — still gated
  --x-no-balance     Launch unbalanced (raw harness command, no account pick)
  --dry-run          Print the command instead of launching; balances without
                     reserving or claiming anything
  --json             With --dry-run, print the envelope (data: harness,
                     session_id, cwd, command, balance, utility, yolo)

Launches are balanced by default: agentusage picks the account and the
command is wrapped as cswap run <slot> --share-history -- … (claude) or
codex-swap [pi] run --claim <lease> -- … (codex, pi). Set
AGENTSURFACE_NO_BALANCE=1 to default a machine to unbalanced.

Yolo mode drops the harness's permission gates when the personal config
(~/.config/agentsurface/config.json) enables it: claude
--dangerously-skip-permissions, codex
--dangerously-bypass-approvals-and-sandbox, pi --approve. Utility
invocations after -- (codex login, claude mcp, …) never get the flag.

Examples:
  agentsurface open claude --model fable --effort max "fix the failing tests"
  agentsurface open codex --effort xhigh -- --search
  agentsurface open pi --model sonnet:high
`,
  resume: `agentsurface resume <session-id> [options] [-- <harness args>]

Reopen a stored session in this terminal. Without --harness the id is looked
up in the claude, codex, and pi session stores; ambiguity and absence are
errors that say which harnesses matched.

Options:
  --harness <name>   claude|codex|pi — skip store detection
  --yolo, --no-yolo  Override the config's yolo (permission bypass) default
  --x-account <sel>  Pin the balanced launch to one account
  --x-no-balance     Launch unbalanced (raw harness command)
  --dry-run          Print the command instead of launching
  --json             With --dry-run, print the envelope

Resumes inject yolo exactly like opens, from the same config.

Resumes balance like opens: cross-account resume is safe because claude
launches share history (--share-history), codex keeps one canonical
CODEX_HOME, and pi profiles share one canonical session store. A claude
resume routes on the session's last-used model (an explicit --model after
-- wins).

Session stores scanned (env overrides honored):
  claude  $CLAUDE_CONFIG_DIR|~/.claude/projects/*/<id>.jsonl
  codex   $CODEX_HOME|~/.codex/{sessions/**,archived_sessions}/rollout-*-<id>.jsonl[.zst]
  pi      $PI_CODING_AGENT_DIR|~/.pi/agent/sessions/*/*_<id>.jsonl

Pi is resumed with --session <id>; its --resume flag is a picker, not a
by-id resume.
`,
  doctor: `agentsurface doctor [--json]

Report, per harness: the binary on PATH, the session store root, whether it
exists, how many sessions it holds, and whether a relocating env override
(CLAUDE_CONFIG_DIR, CODEX_HOME, PI_CODING_AGENT_DIR) is active. Also the
personal config (~/.config/agentsurface/config.json): its path, validity,
and per-harness yolo state.
`,
  help: `agentsurface help [command]

Show top-level help, or the help for one command.
`,
};

export const AGENT_TEASER =
  "Open and resume agent harnesses (claude, codex, pi) in place with one flag vocabulary: open <harness> [prompt] --model --effort, resume <session-id> with cross-store detection, doctor for install health.";

export const AGENT_HELP = `agentsurface agent runbook

What it is
  One launcher for agent harnesses (claude, codex, pi). Today it is a runner:
  open starts a fresh interactive session in this terminal and cwd, resume
  reopens a stored session by id. Surface behavior (landing runs on a managed
  surface, controlling them) arrives later behind reserved --x-* flags.

Commands
  agentsurface open <harness> [prompt] [--model <m>] [--effort <level>]
                    [--name <n>] [--yolo|--no-yolo] [--dry-run [--json]]
                    [-- <harness args>]
  agentsurface resume <session-id> [--harness claude|codex|pi]
                    [--yolo|--no-yolo] [--dry-run [--json]]
                    [-- <harness args>]
  agentsurface doctor [--json]

Rules
  - Everything after -- is passed to the harness verbatim.
  - --effort is one flag with per-harness values: claude low|medium|high|
    xhigh|max, codex minimal|low|medium|high|xhigh, pi off|minimal|low|
    medium|high|xhigh|max. It maps to pi --thinking and codex
    -c model_reasoning_effort=… under the hood.
  - --name sets a run name on claude and pi; codex has no run names and is
    refused with a usage fault.
  - resume without --harness scans the three session stores for the id and
    errors when it is missing or ambiguous; --harness skips the scan. Pi is
    resumed via --session <id> (pi's own --resume is a picker flag).
  - Launches are balanced by default: agentusage balance picks the account,
    and the command is composed as cswap run <slot> --share-history -- …
    (claude) or codex-swap [pi] run --claim <lease> -- … (codex, pi). The
    harness argv after the wrapper's -- is byte-identical to the unbalanced
    command. --x-account <sel> pins the account (still gated); --x-no-balance
    launches raw; AGENTSURFACE_NO_BALANCE=1 defaults a machine to raw. A
    refused balance (no capacity, stale observation, missing stack) is a
    domain error whose recovery names the fix — never a silent unbalanced
    launch.
  - Yolo: ~/.config/agentsurface/config.json ({"yolo": true} or a
    per-harness map) injects the permission-bypass flag at spec build —
    claude --dangerously-skip-permissions, codex
    --dangerously-bypass-approvals-and-sandbox, pi --approve. --yolo /
    --no-yolo override per launch. Utility invocations and flags already
    present after -- are never double-flagged. A malformed config fails
    the launch (config_invalid); doctor reports it instead.
  - --dry-run prints the command instead of launching; add --json for the
    {schema_version, ok, error, data} envelope whose data carries
    {harness, session_id, cwd, command, balance, utility, yolo}. Dry runs balance without
    reserving: codex/pi print the --account spelling since no lease was
    claimed. --json without --dry-run on a launch command is a usage fault,
    because launching is interactive.
  - Exit codes: open and resume exit with the harness's own exit code.
    Non-launching outcomes use the family contract: 0 success, 1 domain
    error (ok:false envelope under --json, stderr prose otherwise), 2 usage
    fault (help on stderr, never an envelope).

Examples
  agentsurface open claude --model fable --effort max "fix the failing tests"
  agentsurface open codex --effort xhigh -- --search
  agentsurface open pi --model sonnet --effort high
  agentsurface resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60
  agentsurface resume 019fcb41-6f70-7283-aa42-97510cb09818 --harness codex
  agentsurface open claude --dry-run --json
`;
