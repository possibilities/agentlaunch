import { HARNESS_NAMES } from "./harness.ts";

/**
 * The fleet agent contract (config/agent-contract in agentstart), authored
 * once and rendered into --help, --agent-help, and --agent-teaser. This is
 * the single authorship; those renders read this file and add no prose or
 * argument facts of their own.
 *
 * agentlaunch is the launch layer that runs BEFORE an agent exists, so
 * meta.audience is "operator": it owes meta and commands, not guidance or
 * concepts. Every command's audience is "operator" or "internal" — never
 * "agent" — because nothing here is a verb a running agent should be
 * calling on itself.
 */

const HARNESS_CHOICES = [...HARNESS_NAMES];

export const META = {
  name: "agentlaunch",
  version: "0.1.0",
  purpose:
    "Resolve the harness, model, effort, yolo policy, and account for one interactive claude or codex session, then become it or resume a recorded native session.",
  audience: "operator" as const,
};

export const GUIDANCE = `agentlaunch resolves the harness, model, effort, yolo policy, and account for
one interactive claude or codex session, then becomes it (or resumes a
recorded native session). It is invoked by a human at a shell, by herdr panes,
and by agentsurface's launch form — never by a running agent on itself, which
is why every command here is operator- or internal-facing.

Grammar: every --x-* token (anywhere) and every bare x-* word (in command
position) belongs to agentlaunch; every other token belongs to the native
harness and is forwarded unchanged, in order, uninterpreted. A native
--name/-n is ordinary forwarded input — agentlaunch has no naming, identity,
registry, or post-launch lifecycle of its own.

Machine use: pass --x-dry-run --x-json for a schema_version 1 envelope with
the final argv, cwd, balance decision, yolo/redactions, and model/effort
report instead of actually launching. --x-json without --x-dry-run is a usage
fault for an interactive launch or resume. Domain failures are ok:false
envelopes at exit 1; usage faults print help on stderr at exit 2; a real
launch adopts the native harness's own exit code.

x-surface is the operator's interactive launch form for a surface host
(agentsurface); it needs a TTY on stdin/stderr and a host reading stdout, so
nothing that is not a human at a terminal, or that host, should run it.`;

export const TEASER =
  "Resolve, balance, launch, and resume native claude/codex sessions: agentlaunch --x-harness <name> [--x-level <model>:<effort>] [native tokens…], x-resume <native-session-id>, x-doctor, and x-catalog.";

const HARNESS_ARG = {
  name: "--x-harness",
  type: "string" as const,
  description: "Which native harness to run or resume.",
  choices: HARNESS_CHOICES,
};

const LEVEL_ARG = {
  name: "--x-level",
  type: "string" as const,
  description:
    "<model>:<effort> pair to resolve against the catalog and inject as native model/effort arguments.",
};

const ACCOUNT_ARG = {
  name: "--x-account",
  type: "string" as const,
  description:
    "Pin a balanced launch to one eligible account selector, retaining the swap tool's own eligibility gate.",
};

const NO_BALANCE_ARG = {
  name: "--x-no-balance",
  type: "boolean" as const,
  description:
    "Run the raw native harness without the account balancing stack (also AGENTLAUNCH_NO_BALANCE=1).",
};

const DRY_RUN_ARG = {
  name: "--x-dry-run",
  type: "boolean" as const,
  description: "Print the resolved command (or --x-json envelope) instead of launching.",
};

const VERBOSE_ARG = {
  name: "--x-verbose",
  type: "boolean" as const,
  description: "Add mechanism rows to the stderr launch narrative.",
};

function yoloArg(
  name: "--x-yolo" | "--x-no-yolo",
  verb: string,
): {
  name: string;
  type: "string";
  description: string;
  choices: string[];
  repeatable: true;
} {
  return {
    name,
    type: "string",
    description: `${verb} the harness's unattended permission setting. Bare (no value) applies to every harness; a following harness name scopes one occurrence; repeat to scope several.`,
    choices: HARNESS_CHOICES,
    repeatable: true,
  };
}

const YOLO_ARG = yoloArg("--x-yolo", "Enable");
const NO_YOLO_ARG = yoloArg("--x-no-yolo", "Disable; removes a forwarded positive spelling from");

const TOKENS_ARG = {
  name: "tokens",
  type: "string" as const,
  description:
    "Native harness tokens, forwarded to the harness unchanged and in order. Opaque to agentlaunch except for reading (never rewriting) a model/effort/cwd flag already present.",
  positional: true,
  repeatable: true,
};

export interface ContractArgument {
  name: string;
  type: "string" | "boolean" | "integer" | "number";
  description: string;
  format?: "path" | "url" | "duration" | "ref" | "json";
  direction?: "in" | "out";
  required?: boolean;
  positional?: boolean;
  repeatable?: boolean;
  choices?: string[];
  default?: unknown;
  aliases?: string[];
  role?: "call" | "output-format" | "store-selection" | "meta";
}

export interface ContractConstraint {
  kind: "one_of" | "at_least_one" | "conflicts" | "requires";
  arguments: string[];
  required?: boolean;
  description?: string;
}

export interface ContractExample {
  invocation: string;
  description: string;
}

export interface ContractStdin {
  accepts: "text" | "json";
  required?: boolean;
  description: string;
}

export interface ContractCommand {
  name: string;
  summary: string;
  audience: "operator" | "internal";
  guidance?: string;
  mutates?: boolean;
  arguments?: ContractArgument[];
  subcommands?: ContractCommand[];
  stdin?: ContractStdin;
  constraints?: ContractConstraint[];
  examples?: ContractExample[];
  blocking?: boolean;
  aliases?: string[];
  deprecated?: string;
}

export const GLOBAL_ARGUMENTS: ContractArgument[] = [
  {
    name: "--x-json",
    type: "boolean",
    description: "Emit the schema_version 1 machine envelope instead of the human narrative.",
    role: "output-format",
  },
  {
    name: "--x-help",
    type: "boolean",
    description: "Print this command's help text and exit.",
    role: "meta",
  },
];

export const COMMANDS: ContractCommand[] = [
  {
    name: "launch",
    summary: "Resolve harness, model, effort, yolo, and account, then become the native harness",
    audience: "operator",
    mutates: true,
    blocking: true,
    guidance:
      "Any invocation not beginning with x-. At least one of --x-harness or --x-level is required. --x-harness alone uses that harness's catalog defaults; --x-level alone selects the earliest catalog harness offering the pair; together they pin and validate all three dimensions. A forwarded native model or effort wins unless --x-level was explicit, in which case the duplicate decision is a usage fault. --x-prompt-file appends a file's exact text as the final native token, for callers whose own argv cannot carry it (a shell-typed line that refuses control characters). Management invocations such as `codex login`, `claude doctor`, and bare --version pass through unbalanced and receive no yolo injection.",
    arguments: [
      TOKENS_ARG,
      HARNESS_ARG,
      LEVEL_ARG,
      ACCOUNT_ARG,
      {
        name: "--x-prompt-file",
        type: "string",
        description:
          "Read this file (UTF-8) once and append its exact text as the final native token. Unreadable or empty is an error.",
        format: "path",
        direction: "in",
      },
      {
        name: "--x-resume",
        type: "string",
        description:
          "Resume this native session id instead of launching, for invokers that can only append arguments to the bare launch command (a herdr pane typing through the fleet shim). Same as the x-resume command; refuses --x-prompt-file.",
      },
      NO_BALANCE_ARG,
      DRY_RUN_ARG,
      VERBOSE_ARG,
      YOLO_ARG,
      NO_YOLO_ARG,
    ],
    constraints: [
      {
        kind: "one_of",
        arguments: ["--x-harness", "--x-level"],
        required: true,
        description: "A launch names what it runs.",
      },
      {
        kind: "conflicts",
        arguments: ["--x-yolo", "--x-no-yolo"],
        description: "Scoped per harness; the same harness may not appear in both.",
      },
      {
        kind: "conflicts",
        arguments: ["--x-no-balance", "--x-account"],
      },
      {
        kind: "conflicts",
        arguments: ["--x-resume", "--x-prompt-file"],
        description: "A resumed session has no launch intent.",
      },
    ],
    examples: [
      {
        invocation: 'agentlaunch --x-harness claude "fix the failing tests"',
        description: "Launch Claude with its catalog default model/effort.",
      },
      {
        invocation: 'agentlaunch --x-level gpt-5.6-sol:ultra "hard problem"',
        description: "Select the earliest catalog harness offering this model:effort pair.",
      },
      {
        invocation: "agentlaunch --x-harness claude --x-level opus-5:high --x-dry-run --x-json",
        description:
          "Report the resolved argv and decisions as a JSON envelope instead of launching.",
      },
      {
        invocation: "agentlaunch --x-harness codex --x-dry-run --x-json",
        description: "Preview a Codex launch's resolved command without running it.",
      },
    ],
  },
  {
    name: "x-resume",
    summary: "Detect a native session store and resume in its recorded cwd",
    audience: "operator",
    mutates: true,
    blocking: true,
    guidance:
      "Without --x-harness, scans the native Claude and Codex session stores; no match and multiple matches are explicit errors. A resume never injects a model or effort — the native session continues with its own state. If the recorded cwd is gone or unavailable, the session starts where agentlaunch was invoked instead.",
    arguments: [
      {
        name: "session-id",
        type: "string",
        description: "The native session id to resume.",
        positional: true,
        required: true,
      },
      TOKENS_ARG,
      HARNESS_ARG,
      ACCOUNT_ARG,
      NO_BALANCE_ARG,
      DRY_RUN_ARG,
      VERBOSE_ARG,
      YOLO_ARG,
      NO_YOLO_ARG,
    ],
    constraints: [
      {
        kind: "conflicts",
        arguments: ["--x-yolo", "--x-no-yolo"],
        description: "Scoped per harness; the same harness may not appear in both.",
      },
    ],
    examples: [
      {
        invocation: "agentlaunch x-resume 05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60",
        description: "Detect the native store holding this session id and resume it.",
      },
      {
        invocation: "agentlaunch x-resume <native-session-id> --x-dry-run --x-json",
        description: "Preview the resolved resume command as a JSON envelope without resuming.",
      },
    ],
  },
  {
    name: "x-doctor",
    summary: "Report harness binaries, native session stores, config, and catalog",
    audience: "operator",
    mutates: false,
    guidance: "Reads only; it neither repairs nor creates state.",
    arguments: [],
  },
  {
    name: "x-catalog",
    summary: "Report the resolved catalog: models and efforts per harness",
    audience: "operator",
    mutates: false,
    guidance:
      "The validated <model>:<effort> pair space --x-level accepts. Reads only; a custom catalog file replaces the built-in when present, exactly as it does for launches.",
    arguments: [],
    examples: [
      {
        invocation: "agentlaunch x-catalog --x-json",
        description: "Report every harness's models, allowed efforts, and default pair as JSON.",
      },
    ],
  },
  {
    name: "x-surface",
    summary: "Open the one-screen interactive launch form for a surface host",
    audience: "operator",
    mutates: true,
    blocking: true,
    guidance:
      "Renders on stderr; each submitted launch is written to stdout as one session-directive JSON line for a host (agentsurface) to realize as a herdr session. Never launches anything itself. Needs a terminal on stdin and stderr, and refuses a stdout that is a terminal — that means no host is reading. An interrupted form is restored from its draft file on the next open.",
    arguments: [],
  },
  {
    name: "guide",
    summary: "Print this fleet agent contract",
    audience: "internal",
    mutates: false,
    guidance:
      "Renders the same document that --help, --agent-help, and --agent-teaser are generated from. Consumed by fleet tooling, not by a human at a shell.",
    arguments: [],
  },
];

/** The fleet agent contract, version 1 — `data` for `guide --json`'s envelope.
 * meta.audience is "operator", so guidance/concepts are not owed; GUIDANCE
 * and TEASER above still exist because --agent-help and --agent-teaser
 * render from them, not from this shape. */
export function contractData(): {
  contract_version: 1;
  meta: typeof META;
  global_arguments: ContractArgument[];
  commands: ContractCommand[];
} {
  return {
    contract_version: 1,
    meta: META,
    global_arguments: GLOBAL_ARGUMENTS,
    commands: COMMANDS,
  };
}
