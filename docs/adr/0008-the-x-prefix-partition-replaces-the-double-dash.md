# 0008 — The x-prefix partitions launcher and native input

A token starting `--x-` is AgentLaunch's wherever it sits; a bare `x-*` word
in command position is an AgentLaunch command; every other token is the native
harness's and is forwarded in order. Harness selection lives in
`--x-harness`, or is inferred from `--x-level`; `x-resume` and `x-doctor` live
in command position.

Strictness applies only to x-space. An unknown `--x-*` is a usage fault; an
unknown native token is forwarded unjudged, so a harness upgrade never changes
how AgentLaunch parses it. Extension flags may add or remove native flags
(yolo is the current case), and every removal is narrated. Native `--name` and
`-n` have no launcher meaning.

Rejected: a strict-head `--` door or unprefixed launcher flags, which shadow
native spellings and oblige the launcher to track every harness vocabulary.
