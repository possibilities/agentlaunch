export const VERSION = "0.1.0";

export const TOP_HELP = `agentsurface — one launcher for agent harnesses

Usage:
  agentsurface --x-harness <value> [tokens…]    Launch a harness here
  agentsurface x-resume <session-id> [tokens…]  Reopen a stored session by id
  agentsurface x-doctor                         Report binaries, stores, config, catalog

The --x-harness value (run \`agentsurface --x-help\` for the full story):
  claude                 That harness, launched on its catalog defaults
  gpt-5.6-sol:high       The earliest harness offering model:effort wins
  codex:gpt-5.5:xhigh    Pinned: the model and effort must be valid there

One partition rule: a token starting --x- is agentsurface's, and every other
token is the harness's, forwarded in the order typed. Unknown --x-* flags
are usage faults; unknown harness flags are the harness's to judge. Bare
x-* words in command position are reserved for agentsurface.

Launch x-flags:
  --x-harness <value>    Which harness/model/effort to launch (required)
  --x-yolo [harness]     Force this launch's permission gates down
  --x-no-yolo [harness]  Keep gates up — removes a forwarded yolo flag too
  --x-account <sel>      Pin the balanced launch to one account
  --x-no-balance         Launch unbalanced (raw harness command)
  --x-dry-run            Print the command instead of launching
  --x-json               With --x-dry-run: print the machine envelope
  --x-verbose            Add mechanism rows to the stderr narrative
  --x-help               Show a command's help

Top level only (nothing to forward): --help, -h · --version, -V ·
--agent-help · --agent-teaser

The resolved model and effort are injected in the harness's own spelling,
and yolo is on by default. Launch commands exit with the harness's code.
`;

export const HELP: Record<string, string> = {
  launch: `agentsurface --x-harness <value> [tokens…]

Launch a harness in this terminal and cwd. Every token that does not start
with --x- is the harness's and is forwarded in the order typed — prompts,
flags, and subcommands alike. The wrapper execs the harness and exits with
its exit code.

The --x-harness value (ADR 0011), resolved against the catalog:
  <harness>                    claude | codex | pi — launched on its
                               catalog defaults (model and effort filled)
  <model>:<effort>             both parts required; the earliest harness in
                               catalog order offering that combination wins
  <harness>:<model>:<effort>   all parts required; pinned — the model and
                               effort must be valid there or the launch is
                               a usage fault

The resolved model and effort are injected at the head of the forwarded
tokens in the harness's own spelling — --model everywhere (pi gets the
provider-combined form, e.g. openai-codex/gpt-5.6-sol), and --effort
(claude), -c model_reasoning_effort="…" (codex), or --thinking (pi).
A colon form owns both dimensions: a forwarded native model/effort flag
beside it is a usage fault. The bare-harness form yields per dimension —
a forwarded --model (or --effort/--thinking/-c model_reasoning_effort=…)
wins and nothing is injected for that dimension. Utility invocations
(codex login, claude mcp, bare --version…) get no injection at all, and a
colon form on one is a usage fault.

Other x-flags (processed here, never forwarded):
  --x-yolo [harness]     Force permission gates down for this launch
  --x-no-yolo [harness]  Keep gates up; also removes a yolo flag that was
                         explicitly forwarded (the removal is narrated).
                         Both repeat; an optional harness name scopes one
                         occurrence.
  --x-account <sel>      Pin the balanced launch to one account (claude:
                         route or cN; codex/pi: account key or email) —
                         still gated by the swap tool
  --x-no-balance         Launch unbalanced (raw harness command)
  --x-dry-run            Print the command instead of launching; balances
                         without reserving or claiming anything
  --x-json               With --x-dry-run, print the envelope (data adds
                         model, model_source, effort, effort_source,
                         redactions)
  --x-verbose            Add mechanism rows to the stderr narrative
  --x-help               This help

Yolo is on by default (ADR 0009): the launch gets the harness's own
permission-bypass flag — claude --dangerously-skip-permissions, codex
--dangerously-bypass-approvals-and-sandbox, pi --approve. Disable it in
~/.config/agentsurface/config.json ({"yolo": false} or a per-harness map)
or per launch with --x-no-yolo.

Launches are balanced by default: agentusage picks the account and the
command is wrapped as cswap run <slot> --share-history -- … (claude) or
codex-swap [pi] run --claim <lease> -- … (codex, pi); routing follows the
resolved model. Set AGENTSURFACE_NO_BALANCE=1 to default a machine to
unbalanced.

Every launch reports its decisions to stderr as labelled rows before the
harness starts: open, cwd, model, effort, yolo, account, launch. stdout
stays the result, so --x-dry-run remains a runnable line and --x-json a
parseable envelope (which silences the rows).

Examples:
  agentsurface --x-harness claude "fix the failing tests"
  agentsurface --x-harness gpt-5.6-sol:ultra "hard problem"
  agentsurface --x-harness pi:gpt-5.6-luna:max
  agentsurface --x-harness claude --model sonnet "quick question"
  agentsurface --x-harness codex --x-dry-run --x-json
`,
  "x-resume": `agentsurface x-resume <session-id> [tokens…]

Reopen a stored session in this terminal. Without --x-harness the id is
looked up in the claude, codex, and pi session stores; ambiguity and
absence are errors that say which harnesses matched. Tokens after the id
follow the partition rule: --x-* is agentsurface's, everything else is
forwarded to the harness after the resume spelling. Resumes take no
model/effort injection — a session continues on its own model.

x-flags:
  --x-harness <name>     claude|codex|pi — skip store detection (names
                         only here; colon forms belong to launches)
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
missing. And the catalog: which file is active (built-in or the custom
~/.config/agentsurface/catalog.json), its validity, harness order, model
counts, and resolved defaults.
`,
};

export const AGENT_TEASER =
  "Launch agent harnesses (claude, codex, pi) in place: agentsurface --x-harness <harness | model:effort | harness:model:effort> [tokens…] resolves against the catalog and injects the model/effort in the harness's own spelling; x-resume <session-id> reopens a session with cross-store detection; x-doctor reports install health.";

export const AGENT_HELP = `agentsurface agent runbook

What it is
  One launcher for agent harnesses (claude, codex, pi). Today it is a
  runner: \`agentsurface --x-harness <value> [tokens…]\` starts a session in
  this terminal and cwd, \`x-resume\` reopens a stored session by id.
  Surface behavior (landing runs on a managed surface, controlling them)
  arrives later as more --x-* flags on the same commands.

Commands
  agentsurface --x-harness <value> [tokens…]
  agentsurface x-resume <session-id> [tokens…]  [--x-harness claude|codex|pi]
  agentsurface x-doctor [--x-json]

Rules
  - The partition rule (ADR 0008): a token starting --x- is agentsurface's
    and is processed before launch, never forwarded; every other token is
    the harness's, forwarded in the order typed. Unknown --x-* flags are
    usage faults; unknown harness tokens are forwarded, not judged. Bare
    x-* words in command position are reserved for agentsurface.
  - The --x-harness value (ADR 0011) resolves against the catalog
    (built-in catalog.json, replaced outright by
    ~/.config/agentsurface/catalog.json): a harness name launches its
    defaults; <model>:<effort> picks the earliest harness in catalog order
    offering the combination; <harness>:<model>:<effort> pins and
    validates. No sparse colon forms. The resolved model and effort are
    injected at the head of the forwarded tokens in the harness's own
    spelling. A colon form owns both dimensions and faults on a forwarded
    native counterpart; the bare-harness form yields per dimension to a
    forwarded --model / --effort / --thinking / -c
    model_reasoning_effort=…. Utility invocations get no injection, and a
    colon form on one is a usage fault.
  - Yolo is on by default (ADR 0009): claude
    --dangerously-skip-permissions, codex
    --dangerously-bypass-approvals-and-sandbox, pi --approve —
    config-disabled ({"yolo": false} or per-harness), overridden per
    launch by --x-yolo/--x-no-yolo (repeatable, optional harness scope).
    An explicit --x-no-yolo also redacts a forwarded yolo spelling,
    narrated.
  - x-resume without --x-harness scans the three session stores for the id
    and errors when missing or ambiguous. Pi is resumed via --session <id>
    (pi's own --resume is a picker flag). Resumes take no model/effort
    injection; a claude resume routes on the session's last-used model.
  - Launches are balanced by default: agentusage balance picks the
    account, and the command is composed as cswap run <slot>
    --share-history -- … (claude) or codex-swap [pi] run --claim <lease>
    -- … (codex, pi). Routing follows the resolved model. --x-account
    pins; --x-no-balance and AGENTSURFACE_NO_BALANCE=1 launch raw. A
    refused balance is a domain error with a recovery — never a silent
    unbalanced launch.
  - Every launch reports decisions to stderr as "label value" rows (open,
    cwd, model, effort, yolo, account, launch); --x-verbose adds mechanism
    rows. stdout carries only the result. --x-json silences the rows.
  - --x-dry-run prints the command instead of launching; with --x-json the
    envelope's data carries {harness, session_id, cwd, command, balance,
    utility, yolo, redactions, model, model_source, effort,
    effort_source}. --x-json without --x-dry-run on a launch is a usage
    fault.
  - Exit codes: launches and x-resume exit with the harness's own code;
    otherwise 0 success, 1 domain error (ok:false envelope under
    --x-json), 2 usage fault (help on stderr, never an envelope).

Examples
  agentsurface --x-harness claude "fix the failing tests"
  agentsurface --x-harness gpt-5.6-sol:ultra "hard problem"
  agentsurface --x-harness pi:gpt-5.6-luna:max --x-dry-run --x-json
  agentsurface x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60
`;
