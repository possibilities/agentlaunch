_Superseded by [ADR 0031](0031-claude-yolo-is-the-bypass-and-its-permit.md)._

# 0033: Yolo is each harness's own unattended setting, not a bypass

Identifier corrected 2026-09-08: formerly `0028-yolo-is-each-harness-s-own-unattended-setting.md`. The old number
was shared by another decision; this record retains its original rationale.
See the [identifier history](README.md#identifier-history).

Claude's yolo spelling is `--permission-mode auto`, not
`--dangerously-skip-permissions`: auto mode still classifies each action, so
an unattended claude keeps a judgement in the loop that a blanket bypass
throws away, and the launcher should ask for the softest setting that still
runs unattended rather than the loudest one. Codex keeps its spelling because
it publishes no middle setting.

This makes a yolo spelling a token *sequence* (`--flag value`) rather than
one flag, and gives claude a **gate flag** — `--permission-mode` — whose
value is the caller's own decision however it is written: any mode but
`auto` is never injected over, while
`--dangerously-skip-permissions` stays recognized (so it is never duplicated
and `--x-no-yolo` still redacts it) but is no longer emitted.
