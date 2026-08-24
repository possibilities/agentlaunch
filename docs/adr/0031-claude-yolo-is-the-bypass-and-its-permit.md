# 0031 — Claude's yolo is the bypass and the flag that permits it

Claude's yolo spelling is
`--dangerously-skip-permissions --allow-dangerously-skip-permissions`, not
`--permission-mode auto`. Auto mode still stops on the actions its
classifier dislikes, which is exactly the interruption a managed launch
exists to remove; the permitting flag is needed alongside the bypass
because claude only offers the bypass to a session that was launched with
it. This supersedes ADR 0028.

A canonical spelling is therefore a pair of independent flags rather than a
flag and its value: injection emits only the half a caller has not already
typed, and `--permission-mode` stays a **gate flag** whose every value —
`auto` included — is the caller's own decision, never injected over and
never redacted by `--x-no-yolo`.
