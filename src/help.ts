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
  --dry-run          Print the command instead of launching
  --json             With --dry-run, print the envelope (data: harness,
                     session_id, cwd, command)

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
  --dry-run          Print the command instead of launching
  --json             With --dry-run, print the envelope

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
(CLAUDE_CONFIG_DIR, CODEX_HOME, PI_CODING_AGENT_DIR) is active.
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
                    [--name <n>] [--dry-run [--json]] [-- <harness args>]
  agentsurface resume <session-id> [--harness claude|codex|pi]
                    [--dry-run [--json]] [-- <harness args>]
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
  - --dry-run prints the command instead of launching; add --json for the
    {schema_version, ok, error, data} envelope whose data carries
    {harness, session_id, cwd, command}. --json without --dry-run on a
    launch command is a usage fault, because launching is interactive.
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
