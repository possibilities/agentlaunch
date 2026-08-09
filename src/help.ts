export const VERSION = "0.1.0";

export const TOP_HELP = `agentsurface — one launcher for agent harnesses

Usage:
  agentsurface <harness> [tokens…]              Launch claude, codex, or pi here
  agentsurface x-resume <session-id> [tokens…]  Reopen a stored session by id
  agentsurface x-doctor                         Report binaries, stores, config

One partition rule: a token starting --x- is agentsurface's, and every other
token is the harness's, forwarded in the order typed. Unknown --x-* flags
are usage faults; unknown harness flags are the harness's to judge, so a
harness upgrade never changes how a command parses here. Bare x-* words in
command position are reserved for agentsurface.

Launch x-flags (run \`agentsurface claude --x-help\` for the full story):
  --x-yolo [harness]     Force this launch's permission gates down
  --x-no-yolo [harness]  Keep gates up — removes a forwarded yolo flag too
  --x-account <sel>      Pin the balanced launch to one account
  --x-no-balance         Launch unbalanced (raw harness command)
  --x-dry-run            Print the command instead of launching
  --x-json               With --x-dry-run: print the machine envelope
  --x-verbose            Add mechanism rows to the stderr narrative
  --x-help               Show a command's help

Top level only (no harness named, nothing to forward):
  --help, -h · --version, -V · --agent-help · --agent-teaser

Yolo is on by default: a launch gets its harness's own permission-bypass
flag unless ~/.config/agentsurface/config.json or --x-no-yolo disables it.
Launch commands exit with the harness's exit code.
`;

export const HELP: Record<string, string> = {
  launch: `agentsurface <harness> [tokens…]        harness: claude | codex | pi

Launch the harness in this terminal and cwd. Every token that does not start
with --x- is the harness's and is forwarded in the order typed — prompts,
flags, and subcommands alike, exactly as the bare CLI would receive them.
The wrapper execs the harness and exits with its exit code.

x-flags (processed here, never forwarded):
  --x-yolo [harness]     Force permission gates down for this launch
  --x-no-yolo [harness]  Keep gates up; also removes a yolo flag that was
                         explicitly forwarded (the removal is narrated).
                         Both repeat, and an optional harness name scopes
                         one occurrence — useful in aliases that wrap every
                         launch alike.
  --x-account <sel>      Pin the balanced launch to one account (claude:
                         route or cN; codex/pi: account key or email) —
                         still gated by the swap tool
  --x-no-balance         Launch unbalanced (raw harness command, no account
                         pick)
  --x-dry-run            Print the command instead of launching; balances
                         without reserving or claiming anything
  --x-json               With --x-dry-run, print the envelope (data:
                         harness, session_id, cwd, command, balance,
                         utility, yolo, redactions)
  --x-verbose            Add mechanism rows to the stderr narrative
  --x-help               This help

Yolo is on by default: the launch gets the harness's own permission-bypass
flag — claude --dangerously-skip-permissions, codex
--dangerously-bypass-approvals-and-sandbox, pi --approve (pi's tools never
prompt; this only auto-trusts project-local files). Disable it in
~/.config/agentsurface/config.json ({"yolo": false} or a per-harness map)
or per launch with --x-no-yolo. A spelling the caller already forwarded is
never duplicated, pi's own --no-approve is never overridden, and utility
invocations (codex login, claude mcp, bare --version…) never get the flag.

Launches are balanced by default: agentusage picks the account and the
command is wrapped as cswap run <slot> --share-history -- … (claude) or
codex-swap [pi] run --claim <lease> -- … (codex, pi). Utility invocations
pass through unwrapped. Set AGENTSURFACE_NO_BALANCE=1 to default a machine
to unbalanced.

Every launch reports its decisions to stderr as labelled rows before the
harness starts: open, cwd, yolo, account, launch. stdout stays the result,
so --x-dry-run remains a runnable line and --x-json a parseable envelope
(which silences the rows).

Examples:
  agentsurface claude "fix the failing tests"
  agentsurface claude --model fable "fix the failing tests"
  agentsurface codex -c 'model_reasoning_effort="xhigh"' --search
  agentsurface pi --model sonnet:high
  agentsurface claude --x-no-yolo --x-dry-run
`,
  "x-resume": `agentsurface x-resume <session-id> [tokens…]

Reopen a stored session in this terminal. Without --x-harness the id is
looked up in the claude, codex, and pi session stores; ambiguity and
absence are errors that say which harnesses matched. Tokens after the id
follow the partition rule: --x-* is agentsurface's, everything else is
forwarded to the harness after the resume spelling.

x-flags:
  --x-harness <name>     claude|codex|pi — skip store detection
  --x-yolo, --x-no-yolo  As on a launch; resumes inject and redact the same
  --x-account <sel>      Pin the balanced launch to one account
  --x-no-balance         Launch unbalanced (raw harness command)
  --x-verbose            Add mechanism rows to the stderr narrative
  --x-dry-run            Print the command instead of launching
  --x-json               With --x-dry-run, print the envelope
  --x-help               This help

Resumes balance like launches: cross-account resume is safe because claude
launches share history (--share-history), codex keeps one canonical
CODEX_HOME, and pi profiles share one canonical session store. A claude
resume routes on the session's last-used model (an explicit --model in the
forwarded tokens wins).

Session stores scanned (env overrides honored):
  claude  $CLAUDE_CONFIG_DIR|~/.claude/projects/*/<id>.jsonl
  codex   $CODEX_HOME|~/.codex/{sessions/**,archived_sessions}/rollout-*-<id>.jsonl[.zst]
  pi      $PI_CODING_AGENT_DIR|~/.pi/agent/sessions/*/*_<id>.jsonl

Pi is resumed with --session <id>; its --resume flag is a picker, not a
by-id resume.
`,
  "x-doctor": `agentsurface x-doctor [--x-json]

Report, per harness: the binary on PATH, the session store root, whether it
exists, how many sessions it holds, and whether a relocating env override
(CLAUDE_CONFIG_DIR, CODEX_HOME, PI_CODING_AGENT_DIR) is active. Also the
personal config (~/.config/agentsurface/config.json): its path, validity,
and per-harness yolo state — yolo is on everywhere when the file is
missing.
`,
};

export const AGENT_TEASER =
  "Launch agent harnesses (claude, codex, pi) in place: agentsurface <harness> [tokens…] forwards every non---x-* token verbatim, x-resume <session-id> reopens a session with cross-store detection, x-doctor reports install health.";

export const AGENT_HELP = `agentsurface agent runbook

What it is
  One launcher for agent harnesses (claude, codex, pi). Today it is a runner:
  \`agentsurface <harness> [tokens…]\` starts a session in this terminal and
  cwd, \`x-resume\` reopens a stored session by id. Surface behavior (landing
  runs on a managed surface, controlling them) arrives later as more --x-*
  flags on the same commands.

Commands
  agentsurface <harness> [tokens…]              harness: claude | codex | pi
  agentsurface x-resume <session-id> [tokens…]  [--x-harness claude|codex|pi]
  agentsurface x-doctor [--x-json]

Rules
  - The partition rule (ADR 0008): a token starting --x- is agentsurface's
    and is processed before launch, never forwarded; every other token is
    the harness's, forwarded in the order typed. Unknown --x-* flags are
    usage faults; unknown harness tokens are forwarded, not judged. Bare
    x-* words in command position are reserved for agentsurface — a prompt
    that must start with "x-" needs the harness's -p spelling.
  - x-flags may add or remove harness flags. Today that is yolo: on by
    default (ADR 0009), it injects the harness's own permission-bypass
    spelling — claude --dangerously-skip-permissions, codex
    --dangerously-bypass-approvals-and-sandbox, pi --approve — skipping
    utility invocations, never duplicating a forwarded spelling, and never
    overriding pi's own --no-approve. ~/.config/agentsurface/config.json
    ({"yolo": false} or a per-harness map) disables it; --x-yolo /
    --x-no-yolo override per launch, repeat, and take an optional harness
    scope. An explicit --x-no-yolo also removes a yolo spelling the caller
    explicitly forwarded, and the removal is narrated. A malformed config
    fails the launch (config_invalid); x-doctor reports it instead.
  - x-resume without --x-harness scans the three session stores for the id
    and errors when it is missing or ambiguous. Pi is resumed via
    --session <id> (pi's own --resume is a picker flag).
  - Launches are balanced by default: agentusage balance picks the account,
    and the command is composed as cswap run <slot> --share-history -- …
    (claude) or codex-swap [pi] run --claim <lease> -- … (codex, pi). The
    harness argv after the wrapper's -- is byte-identical to the unbalanced
    command. --x-account <sel> pins the account (still gated);
    --x-no-balance launches raw; AGENTSURFACE_NO_BALANCE=1 defaults a
    machine to raw. A refused balance (no capacity, stale observation,
    missing stack) is a domain error whose recovery names the fix — never a
    silent unbalanced launch. Routing reads the native --model/-m from the
    forwarded tokens; a claude resume routes on the session's last-used
    model.
  - Utility invocations (first harness token is a management word: codex
    login, claude mcp, pi auth, bare --version/--help…) pass through
    unwrapped: no balancing, no yolo flag.
  - Every launch reports its decisions to stderr as "label value" rows
    (open, cwd, yolo, account, launch); --x-verbose adds mechanism rows
    (config, balance, session, bin, env). stdout carries only the result,
    so a dry run stays pipeable. --x-json silences the rows entirely,
    because the envelope already carries every fact they report.
  - --x-dry-run prints the command instead of launching; add --x-json for
    the {schema_version, ok, error, data} envelope whose data carries
    {harness, session_id, cwd, command, balance, utility, yolo,
    redactions}. Dry runs balance without reserving: codex/pi print the
    --account spelling since no lease was claimed. --x-json without
    --x-dry-run on a launch command is a usage fault, because launching is
    interactive.
  - Exit codes: launch commands exit with the harness's own exit code.
    Non-launching outcomes use the family contract: 0 success, 1 domain
    error (ok:false envelope under --x-json, stderr prose otherwise), 2
    usage fault (help on stderr, never an envelope).

Examples
  agentsurface claude "fix the failing tests"
  agentsurface codex --search
  agentsurface pi --model sonnet:high
  agentsurface claude --x-no-yolo --x-dry-run --x-json
  agentsurface x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60
  agentsurface x-resume 019fcb41-6f70-7283-aa42-97510cb09818 --x-harness codex
`;
