# 0029 — A prompt can arrive as a file

Herdr starts an agent by typing the composed command into the pane's
interactive shell, and it refuses any argument containing a control
character — a literal newline is Enter there, and no quoting survives every
shell. So a multi-line prompt could not ride the launch argv at all: the
surface's whole intent pipeline dead-ended on `invalid_agent_argument` the
moment an operator wrote a second paragraph. **`--x-prompt-file <path>`
carries the text as a control-char-free path; AgentLaunch reads the file and
appends its exact UTF-8 text as one final native token.** The expansion
happens after every dimension and yolo decision has read the stream, so
prompt text is never scanned for model, effort, cwd, or yolo spellings —
which also retires the latent misread of a prompt beginning with `-m`. The
native argv AgentLaunch execs has no shell in between, so the token may
contain anything.

The file is the caller's: AgentLaunch reads it once at launch and never
deletes it. An unreadable or empty file is an explicit error, and a utility
invocation takes no prompt. The flag exists on the launch route only —
x-resume can adopt it if a caller ever needs one.

Rejected: teaching herdr `$'…'` ANSI-C quoting, which is per-shell fragile
and upstream; flattening newlines at the caller, which silently rewrites the
operator's intent; and stdin delivery, which the shell-typed launch line
cannot express either.
