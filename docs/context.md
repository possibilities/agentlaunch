# Context dump

What the first four slices learned, written for whoever builds the fifth.
`outline.md` says *what* is built and what is next; this says *what is
true* — the facts, the surprises, and the ways they were verified. Nothing
here is derivable from the code alone.

## The shape of the thing

agentsurface is one CLI that grows by progressive enhancement (ADR 0001).
A bare command is a passthrough runner; agentsurface's own controls live
in `--x-*`; harness-shaped options (`--model`, `--effort`, `--name`,
`--yolo`) stay unprefixed. Surface behavior will be `--x-*` flags on the
same commands, not new commands.

The load-bearing abstraction is the **launch spec** — `{harness, command,
sessionId}`, pure, built without touching a terminal. Everything composes
around it: balancing wraps it in a swap prefix, yolo injects into it, the
narrative describes it, `--dry-run` prints it, and a surface will consume
it. Keep new features as transformations of the spec and they stay
testable and surface-ready for free.

Read `AGENTS.md` for repository guidance and `CONTEXT.md` for the
glossary before writing anything; the ADRs in `docs/adr/` carry the
decisions that are expensive to reverse.

## The three harnesses, as they actually behave

Verified against the installed CLIs (codex 0.147.0, claude 2.1.x, pi
0.84.1). Re-verify on upgrades — several of these are version-shaped.

**Launch flags.** Model is `--model` on all three. Effort is where they
diverge: claude `--effort low|medium|high|xhigh|max`, pi `--thinking
off|minimal|low|medium|high|xhigh|max`, and codex has *no effort flag at
all* — it only takes `-c model_reasoning_effort="…"`, a TOML config
override, and its set has no `max`. Run names are `--name` on claude and
pi; codex has none at launch (its sessions do have names that `codex
resume` accepts, but nothing assigns one).

**Resume is asymmetric, and this is the trap.** `claude --resume <id>` and
`codex resume <id>` take an id. **Pi's `--resume` is a boolean that opens a
picker** — resuming pi by id is `pi --session <id>`. Emitting `pi --resume
<id>` strands the id as a prompt. `cass resume --agent pi` emits exactly
that broken form today, so do not copy commands from it.

**Session id assignment.** claude and pi both accept `--session-id` at
launch, so a caller can pre-assign an id and know it before the process
starts. **Codex cannot** — its id is a uuid7 minted during startup, so a
surface that wants to refer to a codex run must discover it afterward
from the newest rollout file. Any envelope that promises a session id has
to model codex as "known later".

**Session stores** (every one relocatable by env, which is what makes
resume work under swap profiles):

- claude — `$CLAUDE_CONFIG_DIR|~/.claude/projects/<cwd-encoded>/<uuid>.jsonl`.
  The directory encoding replaces `/` with `-` and is **lossy** — a real
  dash is indistinguishable from a separator. Never decode a directory
  name; match the filename uuid, and read the true cwd from the `cwd`
  field inside the JSONL.
- codex — `$CODEX_HOME|~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid7>.jsonl`,
  plus a flat `archived_sessions/`, plus optional `.zst` compression. The
  first line is `session_meta` carrying `session_id` and `cwd`.
- pi — `$PI_CODING_AGENT_DIR|~/.pi/agent/sessions/--<cwd-dashes>--/<ts>_<id>.jsonl`.
  The `--…--` sentinels make this encoding less ambiguous than claude's.
  The header line carries `cwd` and `parentSession` (forks). Pi treats a
  missing cwd as a first-class case and prompts to continue elsewhere —
  which is what a surface will hit when it resumes into a landed worktree.
- Never set `PI_CODING_AGENT_SESSION_DIR`: it flattens pi's project-nested
  layout.

**Utility invocations.** A first token that is a management or service
word (`codex login`, `claude mcp`, `pi auth`, bare `--version`) opens no
account-bound session. These must not be balanced — `codex login` is
refused outright under an account pin — and must not receive yolo flags.
`utilityInvocation()` in `harness.ts` classifies on the first token only,
deliberately: a flag ahead of a subcommand classifies as a session, which
fails the same way the raw CLI would. Anything that injects arguments has
to inject *after* the first token or it defeats the classifier.

## The account stack

Three tools, each owning one job, and agentsurface owns none of them:

- **agentusage** decides *which account*: `agentusage balance claude|codex
  --json`. It reads normalized observation sidecars under
  `~/.local/state/agentusage/` (claude keeper schema v7, codex v1),
  refreshed by a daemon every ~3 minutes; balance refuses on observations
  older than 5 minutes. Its refusal vocabulary is two-shaped — `{error:
  {code, message}}` and `{refusal, detail}` — and both must be surfaced
  verbatim.
- **cswap** (claude-swap) and **codex-swap** run the harness *as* that
  account. Contracts: `cswap run <slot> --share-history -- …`,
  `codex-swap run|resume --account|--claim … -- …`, and `codex-swap pi run
  … -- …`.
- **agentsurface** composes: it asks, wraps, and launches. The harness
  argv after the wrapper's `--` stays byte-identical to the unbalanced
  command (ADR 0003). Keep it that way; it is what makes balancing
  invisible to everything downstream.

Facts worth not rediscovering:

- **Pi rides the codex account pool.** codex-swap grew a `pi` command
  family with per-account pi profiles, identity-verified via
  `chatgpt_account_id` claims (ndy's org-style accountId never matches).
  `balance codex` covers pi, with the `openai-codex/` model prefix
  stripped so lane selection matches.
- **Cross-account resume is safe, for three different reasons.** claude
  because `--share-history` links `projects/` and `history.jsonl` back to
  `~/.claude` (without it, sessions silo per account under
  `~/.claude-swap-backup/sessions/<slot>-<slug>/`); codex because all
  accounts share one canonical `CODEX_HOME`; pi because its profiles
  symlink one canonical session store.
- **A claude resume routes on the session's last-used model**, sniffed
  from the JSONL. The session store already knows what a job registry
  would have had to track.
- **Dry runs must never reserve.** claude passes balance `--dry-run`;
  codex/pi skip `--claim` and print the `--account` spelling instead — a
  real command a human can copy and run through the same gate.
- Codex "stale + `decisionGrade: true`" is the healthy adaptive-pacing
  state, not a fault.
- The spark lane refuses with `no-spark-capacity` until a spark 5h window
  has ever been observed. Known, unfixed.

## Shims, and the recursion problem

Bare `claude`/`codex`/`pi` on this machine are funk-installed shims at
`~/.local/share/agentsurface/shims` that exec `agentsurface open <harness>
-- "$@"`. That is what makes every launch balanced however it was typed —
and it is also a recursion hazard, since agentsurface then launches
`claude` itself.

The sentinel breaks it (ADR 0004): `AGENTSURFACE_LAUNCH=1` is stamped on
every managed child, and the shim, seeing it, execs the *real* binary
found by scanning PATH past the shim directory. The stamp is applied by
agentsurface's own `launch()`, by codex-swap's containment env and pi
runner, and by cswap's session exec. `AGENTSURFACE_SHIM_BYPASS=1` is the
manual escape. Note the deliberate asymmetry: `cswap run` is left
*unstamped*, because typing it should mean "as if you typed claude", i.e.
balanced.

PATH order matters: funk's `.zshrc` prepends the shim directory *below*
the nvm prepend so the shims win over the real binaries.

## Yolo, and why it lives here

Permission posture is launcher configuration (ADR 0006):
`~/.config/agentsurface/config.json` holds `{"yolo": true}` or a
per-harness map, and the spec builders inject `--dangerously-skip-permissions`
(claude), `--dangerously-bypass-approvals-and-sandbox` (codex), or
`--approve` (pi). Callers stop encoding permission flags of their own.

- **Pi's yolo is a narrower thing wearing the same name.** Pi has no
  tool-permission gate at all — tools run unprompted — so `--approve`
  only auto-trusts project-local files. This is why the trust-dialog work
  in the outline is mostly already done for pi and not at all for the
  others.
- Injection skips utility invocations and never duplicates a flag the
  caller already forwarded.
- A malformed config **fails the launch** (`config_invalid`) rather than
  quietly launching gated; `doctor` is the only command that downgrades
  that to a report. `--yolo`/`--no-yolo` are read before the config, so an
  explicit override still works while the file is broken.

## Orca, from the outside

Orca is where these launches land today, and integrating with it taught
more than expected. All of this came from reading
`/Applications/Orca.app/Contents/Resources/app.asar` — `grep -ao` against
the packed archive works well, and `app.asar.unpacked/out/shared/` holds a
few readable modules.

- **Its settings cannot be stow-adopted, by construction.** There is no
  standalone preferences file: settings share `orca-data.json` with
  projects, worktrees, sessions, and account state, and Orca atomically
  replaces the whole file when saving. funk's `configure-orca` refuses a
  symlink there and merges chosen keys into the active profile instead —
  and refuses to write at all while Orca runs, exiting 75 (`EX_TEMPFAIL`)
  rather than racing its writer.
- The active profile is `~/Library/Application Support/orca/profiles/<id>/orca-data.json`,
  with `<id>` from `orca-profile-index.json` (`local-default` here); older
  installs used a flat file one level up. Note the case: the lowercase
  `orca` directory is the live one.
- `settings.agentDefaultArgs` is a map of agent id to a *string* of extra
  args. Empty string is Orca's own spelling for "manual" — its
  `applyAgentPermissionMode` writes `''` — and it is safe, because Orca
  guards tokenization on the trimmed value being truthy and `.trim()`s the
  assembled command. It never prunes keys, so an added key persists.
- Which agent ids matter: `claude`, `codex`, and `pi` have bare
  `launchCmd`s, so the shims intercept them. `claude-agent-teams` launches
  `orca claude-teams` and `openclaude` is a different binary — neither is
  shimmed. (Both are emptied here anyway, because they are no longer used
  on this machine.)
- Toggling Orca's own permission switch to yolo rewrites the emptied
  entries back to bypass flags; `funk configure-orca` re-converges them.
  With some agents manual and some yolo, Orca's indicator reads "mixed".
  That is expected.
- The orca CLI has no settings-write command, so there is no race-free
  path other than quitting the app.

**A bug worth remembering as a class.** funk's `configure-orca` compared
desired against actual with jq's `contains()`. `contains()` does
*substring* matching on strings, so a desired value of `""` matched
anything and reported every setting as already converged — the removal
would silently never have been written. It now compares leaf by leaf. Any
declarative overlay that can express an empty value has this bug latent.

## How things were verified

Worth repeating, because guessing here is expensive:

- Harness behavior: read `--help` from the installed binary, never memory.
- Orca behavior: `grep -ao '.\{120\}<symbol>.\{160\}'` against
  `app.asar`, plus the readable modules in `app.asar.unpacked/out/shared/`.
- Destructive-looking convergence: copy the real state file into a temp
  `HOME`, run the tool against it with its own test hook
  (`FUNK_TEST_ORCA_RUNNING=0`), and diff the result. This proved the
  `agentDefaultArgs` write — the right keys emptied, 21 other agents and
  183 settings keys preserved, idempotent on rerun — without touching the
  live profile.
- jq semantics: test the expression against a fixture before trusting it.

## Conventions that will bite if ignored

- The family stack is Bun + TypeScript, **no build step** (`bin` points at
  `src/main.ts`), zero runtime dependencies, hand-rolled flag parsing.
  `flags.ts`, `envelope.ts`, `errors.ts`, `paths.ts` are byte-identical
  copies shared with agentwiki — port fixes across, never fork.
- Exit codes: 0 success, 1 domain error, 2 usage fault — **except** open
  and resume, which exit with the harness's own code (ADR 0002).
- One `{schema_version, ok, error, data}` envelope on stdout under
  `--json`; usage faults exit before a command runs and are never
  envelopes.
- Narration goes to stderr, results to stdout (ADR 0007). stdout must stay
  pipeable.
- `bun run check` is the commit gate; `bash scripts/smoke.sh` drives every
  documented command against a throwaway HOME with dry runs only, so it
  can never launch a real harness or spend a real account.
- Tests spawn the CLI with a private HOME and empty session stores, and
  set `AGENTSURFACE_NO_BALANCE=1` unless they are specifically testing
  balancing (which uses a fake `agentusage` first on PATH).
