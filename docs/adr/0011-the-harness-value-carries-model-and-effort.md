# 0011 — The harness value carries model and effort, on --x-harness

Every launch names what it runs through one flag: `--x-harness` takes a
*harness value* — `<harness>` launches that harness on its catalog
defaults; `<model>:<effort>` resolves to the earliest harness in catalog
order offering the combination; `<harness>:<model>:<effort>` pins and
validates. Colons claim the value strictly: both/all parts required, no
sparse forms, no default harness — an invocation with no harness value is
a usage fault, so a typo can never launch anything. The resolved model and
effort are injected at the head of the forwarded stream in the harness's
own spelling (`--model` everywhere, with pi's provider-combined form;
`--effort` / `-c model_reasoning_effort="…"` / `--thinking`), and both are
narrated rows and envelope fields with their source. A colon form owns
both dimensions and hard-faults on a forwarded native counterpart —
presence-based, because comparing values across spellings is a swamp; the
bare-name form yields per dimension, the caller's forwarded spelling
winning unjudged. Utility invocations take no injection, and a colon form
on one is a fault; resumes take none ever — a session continues on its own
model. Balance routing follows the resolved model name. The catalog
reshapes to carry this (amending ADR 0010): defaults live in a `defaults`
object — per harness, per family (supplying a harness that includes it
and states none; two defaults-bearing includes without own defaults is a
fault), and per model (effort only) — effort sets inherit model > family
> harness, harness-level sets and defaults turn optional, and the
top-level default harness is gone. Moving the harness off the command
position keeps agentlaunch shaped like the harnesses it launches: argv
is nothing but x-flags and forwarded tokens, and the shims exec
`agentlaunch --x-harness <name> "$@"`. Rejected: the harness value as a
positional (colon-parsing at argv[0], name-vs-token ambiguity, and a
none-route that could swallow typos as prompts); sparse colon forms
(`claude:opus:`), whose fill rules made ownership ambiguous; value-based
conflict comparison.
