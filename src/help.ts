export const VERSION = "0.1.0";

export const TOP_HELP = `agentsurface — one launcher for agent harnesses

Usage:
  agentsurface --x-harness <harness> [tokens…]  Launch a harness here
  agentsurface x-resume <session-id> [tokens…]  Reopen a stored session by id
  agentsurface x-runs                           List recorded surface runs
  agentsurface x-run <run-id|name>              Show one run; discover its session id
  agentsurface x-land <workspace-ref>           Merge a workspace back and release it
  agentsurface x-doctor                         Report binaries, stores, config, catalog, surface

What runs, in two flags (run \`agentsurface --x-help\` for the full story):
  --x-harness claude                 That harness on its catalog defaults
  --x-level gpt-5.6-sol:high         The earliest harness offering the
                                     level wins — here, codex
  --x-harness codex --x-level gpt-5.5:xhigh
                                     Pinned: the level must be valid there

One partition rule: a token starting --x- is agentsurface's, and every other
token is the harness's, forwarded in the order typed. Unknown --x-* flags
are usage faults; unknown harness flags are the harness's to judge. Bare
x-* words in command position are reserved for agentsurface.

Launch x-flags:
  --x-harness <harness>  claude|codex|pi — which harness to launch
  --x-level <model>:<effort>
                         What it runs at; both parts required. One of
                         --x-harness and --x-level is required.
  --x-name <name>        Name this run (claude/pi --name; codex has none)
  --x-surface [backend]  Land on a surface instead of this terminal
  --x-workspace <sel>    Surface workspace to land in (default: current)
  --x-new-workspace <n>  Create the workspace, registering its project
  --x-project <sel>      Project for --x-new-workspace (default: inferred)
  --x-from <ref>         What the new workspace descends from
  --x-no-from            Say it descends from nothing (also the default)
  --x-yolo [harness]     Force this launch's permission gates down
  --x-no-yolo [harness]  Keep gates up — removes a forwarded yolo flag too
  --x-account <sel>      Pin the balanced launch to one account
  --x-no-balance         Launch unbalanced (raw harness command)
  --x-dry-run            Print the command instead of launching
  --x-json               Print the machine envelope (launches need
                         --x-dry-run unless they land on a surface)
  --x-verbose            Add mechanism rows to the stderr narrative
  --x-help               Show a command's help

Top level only (nothing to forward): --help, -h · --version, -V ·
--agent-help · --agent-teaser

The resolved model and effort are injected in the harness's own spelling,
and yolo is on by default. Launch commands exit with the harness's code;
a surface landing returns a run id instead and exits 0.
`;

export const HELP: Record<string, string> = {
  launch: `agentsurface --x-harness <harness> [--x-level <model>:<effort>] [tokens…]

Launch a harness in this terminal and cwd. Every token that does not start
with --x- is the harness's and is forwarded in the order typed — prompts,
flags, and subcommands alike. The wrapper execs the harness and exits with
its exit code.

What runs is two flags (ADR 0018), resolved against the catalog:
  --x-harness <harness>        claude | codex | pi. Alone, the harness is
                               launched on its catalog defaults (model and
                               effort filled).
  --x-level <model>:<effort>   The level: both parts required, and one
                               value because the catalog validates them as
                               one — which efforts a model allows is the
                               catalog's to know. Alone, the earliest
                               harness in catalog order offering that level
                               wins; it is a usage fault if none does.
  both                         Pinned — the level must be valid on that
                               harness or the launch is a usage fault.
At least one of the two is required, so a typo can never launch anything.

The resolved model and effort are injected at the head of the forwarded
tokens in the harness's own spelling — --model everywhere (pi gets the
provider-combined form, e.g. openai-codex/gpt-5.6-sol), and --effort
(claude), -c model_reasoning_effort="…" (codex), or --thinking (pi).
--x-level owns both dimensions: a forwarded native model/effort flag beside
it is a usage fault. Without it the launch yields per dimension — a
forwarded --model (or --effort/--thinking/-c model_reasoning_effort=…)
wins and nothing is injected for that dimension. Utility invocations
(codex login, claude mcp, bare --version…) get no injection at all, and
--x-level on one is a usage fault.

Surface x-flags (ADR 0012/0013 — the launch lands on a surface and the
command returns an envelope instead of becoming the harness):
  --x-surface [backend]  Land on a surface. The optional value names the
                         backend; bare means the default (orca).
  --x-workspace <sel>    Land in an existing workspace (selector is the
                         backend's own; orca takes name:, path:, branch:,
                         id:). Default: the workspace containing the cwd.
  --x-new-workspace <n>  Create workspace <n> and land there. Its project
                         is registered on demand (ensure): from
                         --x-project, else the cwd's git repository.
  --x-project <sel>      Project for --x-new-workspace — a registered name,
                         or path:<repo> to register one on demand.
  --x-from <ref>         What the new workspace descends from:
                         run:<run-id-or-name> (resolved through our own run
                         registry, so an agent naming what it spawned from
                         needs no backend spelling), or the backend's own
                         workspace selector.
  --x-no-from            It descends from nothing.

  --x-name <name>        Name this run. Passed to the harness where it has
                         a launch-time name (claude and pi --name); codex
                         has none, so a runner launch narrates the drop.
                         On a surface it is the terminal title, the label
                         of a workspace this landing created, and the run
                         record's name — so codex loses nothing there.
                         A name is a label, not an identity: run:<name>
                         reads a run back wherever run:<run-id> does, and
                         several runs sharing one is a refusal naming them.

Provenance is stated, never inferred (ADR 0015). --x-from and --x-no-from
qualify --x-new-workspace only: lineage is set where a workspace is
created, and an existing one keeps what it has. Saying nothing means
nothing — the backend is told "none" explicitly, because one that would
otherwise read its own environment (orca infers a parent from the calling
terminal) has to be told not to. What a parent means is each backend's own
flavor; the envelope reports what was actually recorded, so an adapter that
cannot express a request says so instead of dropping it.

A landing writes a run record and prints its run id on stdout; --x-json
works without --x-dry-run here and the envelope adds run_id and surface
{backend, project, workspace, terminal, provenance}. The session id is
discovered later (x-run <run-id>), never assigned. A utility invocation
cannot land.

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
                         without reserving or claiming anything, and a
                         surface dry run resolves read-only (nothing
                         registered or created)
  --x-json               With --x-dry-run (or --x-surface), print the
                         envelope (data adds model, model_source, effort,
                         effort_source, redactions)
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
  agentsurface --x-level gpt-5.6-sol:ultra "hard problem"
  agentsurface --x-harness pi --x-level gpt-5.6-luna:max
  agentsurface --x-harness claude --model sonnet "quick question"
  agentsurface --x-harness codex --x-dry-run --x-json
  agentsurface --x-harness claude --x-surface "fix the tests"
  agentsurface --x-harness codex --x-surface --x-new-workspace fix-tests --x-json
`,
  "x-resume": `agentsurface x-resume <session-id> [tokens…]

Reopen a stored session in this terminal. Without --x-harness the id is
looked up in the claude, codex, and pi session stores; ambiguity and
absence are errors that say which harnesses matched. Tokens after the id
follow the partition rule: --x-* is agentsurface's, everything else is
forwarded to the harness after the resume spelling. Resumes take no
model/effort injection — a session continues on its own model.

x-flags:
  --x-harness <name>     claude|codex|pi — skip store detection
  --x-surface [backend]  Resume onto a surface: the session continues in a
                         workspace instead of this terminal. Defaults to
                         the workspace containing the session's own cwd;
                         --x-workspace / --x-new-workspace (+ --x-project,
                         --x-from) override, as on a launch. Lands a run
                         record.
  --x-yolo, --x-no-yolo  As on a launch; resumes inject and redact the same
  --x-account <sel>      Pin the balanced launch to one account
  --x-no-balance         Launch unbalanced (raw harness command)
  --x-verbose            Add mechanism rows to the stderr narrative
  --x-dry-run            Print the command instead of launching
  --x-json               With --x-dry-run (or --x-surface), print the envelope
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
missing. The catalog: which file is active (built-in or the custom
~/.config/agentsurface/catalog.json), its validity, harness order, model
counts, and resolved defaults. And the surface backends: each one's
reachability and version, plus how many runs are recorded.
`,
  "x-runs": `agentsurface x-runs [--x-json]

List recorded surface runs, newest first: run id, name (when the landing
gave one), backend, harness, workspace, session id (or "not yet
discovered"), and landing time. Records
live one file per run under ~/.local/state/agentsurface/runs/ and are
written by every non-dry surface landing (ADR 0014).
`,
  "x-run": `agentsurface x-run <run-id | run-name> [--x-json]

Show one recorded run, named by its id or by the name --x-name gave it —
the id tier is exact, so a name never shadows a record. Names are labels
rather than identities: several runs sharing one is an ambiguous_run
refusal naming the candidates, and open runs are preferred over landed
ones. When its session id is still unknown, the harness's
session store is searched for the session born in the run's workspace at or
after the landing (every store records the cwd); a discovery is written
back to the record, so it happens at most once. The terminal field is the
backend's handle for the landed terminal — the address a future steer
command will use.
`,
  "x-land": `agentsurface x-land <run:<run-id-or-name> | backend-selector> [flags]

  --x-surface [backend]   Which surface holds the workspace (default: orca)
  --x-into <branch>       Merge target; default is the repo's own base ref
  --x-force               Proceed past live terminals and child workspaces
  --x-abandon             Discard the work: skip the merge, release anyway
  --x-dry-run             Report the survey and the blockers; change nothing
  --x-json                The envelope instead of the rows

Merge a workspace's finished work back to the main line and let the surface
go (ADR 0016). The order is the safety property — survey, refuse, merge,
release, reconcile — so a checkout is never removed until its work provably
landed somewhere else.

Git work is done with git, in the repository's own primary checkout, which
is found with git rather than asked of the backend. The surface is consulted
only for what it alone knows (which workspace, whose repo, what is attached)
and does only what it alone can (stop terminals, remove the workspace).

Nothing half-happens. A merge conflict is rolled back with git merge --abort
and raised as land_conflict with the conflicted paths, leaving the target
branch exactly as it was; resolve it in the workspace and run x-land again.

Refusals name what is in the way, each with the flag that clears it:

  dirty          uncommitted or untracked changes  → --x-abandon
  terminals      live terminals in the workspace   → --x-force
  children       workspaces descend from this one  → --x-force
  base_branch    the primary checkout is elsewhere → git switch <branch>
  base_dirty     the primary checkout is unclean   → commit or stash it

Committing is judgment, so x-land never invents a commit; a dirty workspace
is refused rather than guessed at. The repository's primary checkout is
refused unconditionally — no flag makes landing it a good idea. Merging is
local: nothing is pushed, and the unpushed count is reported, not acted on.

Run records are stamped closed_at/closed_as rather than deleted — a record
is the last thing tying a run id to a session id, and the session outlives
the workspace it was born in.
`,
};

export const AGENT_TEASER =
  "Launch agent harnesses (claude, codex, pi) in place or on a surface: agentsurface --x-harness <harness> [--x-level <model>:<effort>] [tokens…] resolves against the catalog and injects the model/effort in the harness's own spelling; --x-surface lands the launch in a managed workspace (Orca) and returns a run id; x-resume <session-id> reopens a session with cross-store detection; x-runs/x-run inspect landed runs; x-land merges a finished workspace back to the main line and releases it; x-doctor reports install health.";

export const AGENT_HELP = `agentsurface agent runbook

What it is
  One launcher for agent harnesses (claude, codex, pi). As a runner,
  \`agentsurface --x-harness <harness> [tokens…]\` starts a session in this
  terminal and cwd, and \`x-resume\` reopens a stored session by id. With
  --x-surface the same launch lands on a surface instead — a managed
  workspace behind a pluggable backend API (Orca is the first backend) —
  and the command returns a run id instead of becoming the harness.

Commands
  agentsurface --x-harness <harness> [--x-level <model>:<effort>] [tokens…]  [--x-surface [backend]]
  agentsurface x-resume <session-id> [tokens…]  [--x-harness claude|codex|pi] [--x-surface]
  agentsurface x-runs [--x-json]
  agentsurface x-run <run-id | run-name> [--x-json]
  agentsurface x-land <run:<run-id-or-name> | selector> [--x-into <branch>] [--x-force] [--x-abandon] [--x-dry-run] [--x-json]
  agentsurface x-doctor [--x-json]

Rules
  - The partition rule (ADR 0008): a token starting --x- is agentsurface's
    and is processed before launch, never forwarded; every other token is
    the harness's, forwarded in the order typed. Unknown --x-* flags are
    usage faults; unknown harness tokens are forwarded, not judged. Bare
    x-* words in command position are reserved for agentsurface.
  - What runs is two flags (ADR 0018), resolved against the catalog
    (built-in catalog.json, replaced outright by
    ~/.config/agentsurface/catalog.json): --x-harness <harness> alone
    launches that harness's defaults; --x-level <model>:<effort> alone
    picks the earliest harness in catalog order offering that level; both
    together pin and validate. At least one is required. A level takes
    both parts — it is one value because the catalog validates the pair as
    one. The resolved model and effort are injected at the head of the
    forwarded tokens in the harness's own spelling. --x-level owns both
    dimensions and faults on a forwarded native counterpart; without it a
    launch yields per dimension to a forwarded --model / --effort /
    --thinking / -c model_reasoning_effort=…. Utility invocations get no
    injection, and --x-level on one is a usage fault.
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
  - --x-surface lands the launch on a surface (ADR 0012/0013): the same
    composed command starts in a managed workspace — the one containing
    the cwd (or the session's cwd on a resume) by default, --x-workspace
    <sel> picks one, --x-new-workspace <n> creates one with its project
    registered on demand (--x-project names or registers it; ensure). The
    command returns an envelope with run_id and surface {backend, project,
    workspace, terminal} instead of becoming the harness, and exits 0 on a
    successful landing. Utility invocations cannot land. A refused surface
    (backend unreachable, workspace missing) is a domain error — never a
    silent fall-back to this terminal.
  - Runs are agentsurface's own records (ADR 0014), one JSON file per run
    under ~/.local/state/agentsurface/runs/. The run id is the immediate
    identifier every landing returns; session ids are discovered — x-run
    <run-id> matches the store entry born in the run's workspace and
    backfills the record — never assigned. The terminal handle in the
    record is the backend's address for steering, not the run's identity.
  - Every launch reports decisions to stderr as "label value" rows (open,
    cwd, model, effort, yolo, account, surface, project, workspace, run,
    launch); --x-verbose adds mechanism rows. stdout carries only the
    result. --x-json silences the rows.
  - --x-dry-run prints the command instead of launching; with --x-json the
    envelope's data carries {harness, session_id, cwd, command, balance,
    utility, yolo, redactions, model, model_source, effort,
    effort_source}. --x-json without --x-dry-run is a usage fault unless
    the launch lands on a surface. A surface dry run resolves read-only:
    nothing registered, created, or recorded.
  - Exit codes: launches and x-resume exit with the harness's own code —
    except surface landings, which return (0 landed, 1 refused);
    otherwise 0 success, 1 domain error (ok:false envelope under
    --x-json), 2 usage fault (help on stderr, never an envelope).

Examples
  agentsurface --x-harness claude "fix the failing tests"
  agentsurface --x-level gpt-5.6-sol:ultra "hard problem"
  agentsurface --x-harness pi --x-level gpt-5.6-luna:max --x-dry-run --x-json
  agentsurface x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60
`;
