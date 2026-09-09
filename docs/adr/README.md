# agentlaunch decision log

Read the relevant records before changing a boundary they explain. Current
implementation and procedures live in the repository's guidance and architecture
documents; an old record preserves why an earlier choice was made.

“Recorded” means the original record did not declare an acceptance status.
It does not invent an approval date or promise that every implementation detail
remains current. Explicit supersession below names the changed scope; the
record itself retains the original reasoning and replacement links. A dash adds
no status claim beyond the record; it does not certify every detail as current.

| Decision | Status | Replacement or current scope |
|---|---|---|
| [0001: One CLI ends at the native launch boundary](0001-one-cli-native-launch-boundary.md) | Recorded | — |
| [0002: Launch commands adopt the harness's exit code](0002-launch-commands-adopt-the-harness-exit-code.md) | Recorded | — |
| [0003: Balanced launches compose a prefix, never touch the spec](0003-balanced-launches-compose-a-prefix.md) | Partially superseded | [0032](0032-agentusage-owns-account-preparation.md) replaces swap transport; native arguments/history remain owned by the harness. |
| [0004: PATH shims route bare harness calls; the sentinel breaks recursion](0004-shims-route-bare-calls-the-sentinel-breaks-recursion.md) | Partially superseded | [0032](0032-agentusage-owns-account-preparation.md) replaces swap transport; shim recursion ownership remains. |
| [0005: Utility invocations pass through unbalanced](0005-utility-invocations-pass-through-unbalanced.md) | Recorded | — |
| [0006: Yolo lives in launcher config, not in callers](0006-yolo-lives-in-launcher-config.md) | Partially superseded | [ADR 0009](0009-yolo-defaults-on.md) changes the default; [ADR 0031](0031-claude-yolo-is-the-bypass-and-its-permit.md) replaces Claude’s native flag spelling. Launcher ownership and forwarded native gates remain. |
| [0007: The launch narrative goes to stderr](0007-the-narrative-goes-to-stderr.md) | Recorded | — |
| [0008: The x-prefix partitions launcher and native input](0008-the-x-prefix-partition-replaces-the-double-dash.md) | Recorded | — |
| [0009: Yolo defaults on](0009-yolo-defaults-on.md) | Recorded | — |
| [0010: The catalog defines models and efforts; its order is the tiebreak](0010-the-catalog-defines-models-and-efforts.md) | Recorded | — |
| [0011: The harness value carries model and effort, on --x-harness](0011-the-harness-value-carries-model-and-effort.md) | Superseded for flag grammar | [ADR 0018](0018-a-level-is-its-own-flag.md) separates harness selection from model/effort level selection; the original rejected grammar follows. |
| [0018: A level is its own flag](0018-a-level-is-its-own-flag.md) | Recorded | — |
| [0028: A resume runs in the native session cwd](0028-a-resume-runs-in-native-session-cwd.md) | Recorded | — |
| [0029: A prompt can arrive as a file](0029-a-prompt-can-arrive-as-a-file.md) | Recorded | — |
| [0030: Use fixed resources with native Codex](0030-use-fixed-resources-with-native-codex.md) | Partially superseded | [0032](0032-agentusage-owns-account-preparation.md) replaces account transport; fixed resources remain. |
| [0031: Claude's yolo is the bypass and the flag that permits it](0031-claude-yolo-is-the-bypass-and-its-permit.md) | Recorded | — |
| [0032: AgentUsage owns account preparation](0032-agentusage-owns-account-preparation.md) | Recorded | — |
| [0033: Yolo is each harness's own unattended setting, not a bypass](0033-yolo-is-each-harness-s-own-unattended-setting.md) | Superseded | [0031](0031-claude-yolo-is-the-bypass-and-its-permit.md). Identifier was corrected after the successor was written. |
| [0034: Compose capabilities around native stores](0034-compose-capabilities-around-native-stores.md) | Superseded; restored history | [0030](0030-use-fixed-resources-with-native-codex.md). |

## Identifier history

Corrected 2026-09-08. Each old filename below identifies one specific record;
the old number alone was ambiguous. Existing record bodies were retained, with
updated references and explicit status annotations. Do not reuse retired
identifiers for unrelated decisions or renumber the rest of the log.

| Former file | Current record |
|---|---|
| `0028-yolo-is-each-harness-s-own-unattended-setting.md` | [0033](0033-yolo-is-each-harness-s-own-unattended-setting.md) |
| `0030-compose-capabilities-around-native-stores.md` | [0034](0034-compose-capabilities-around-native-stores.md) |

The earlier capability record was deleted when the fixed-resource record reused
its number. Its restoration receives a new identifier and remains superseded.

New records take an unused identifier above the highest current number. Check
the landing branch before assigning it and coordinate shared ADR edits. Cite
complete relative file links; a title change must not redirect a citation to a
different decision. Keep this navigation index and the record's status together.
