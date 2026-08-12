# 0028 — Yolo is each harness's own unattended setting, not a bypass

Claude's yolo spelling is `--permission-mode auto`, not
`--dangerously-skip-permissions`: auto mode still classifies each action, so
an unattended claude keeps a judgement in the loop that a blanket bypass
throws away, and the launcher should ask for the softest setting that still
runs unattended rather than the loudest one. Codex and pi keep their
spellings, because neither publishes a middle setting.

This makes a yolo spelling a token *sequence* (`--flag value`) rather than
one flag, and gives claude a **gate flag** — `--permission-mode` — whose
value is the caller's own decision however it is written: any mode but
`auto` is treated like pi's `--no-approve` and never injected over, while
`--dangerously-skip-permissions` stays recognized (so it is never duplicated
and `--x-no-yolo` still redacts it) but is no longer emitted.
