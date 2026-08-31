# 0018 — A level is its own flag

`--x-harness` took three shapes (ADR 0011), and two of them named no
harness: `--x-harness fable:xhigh` read as a lie about its own value, and
`--x-resume --x-harness` had already quietly kept the honest meaning —
a harness name and nothing else. The value splits along the seam that was
always there. **`--x-harness <harness>` takes a harness name, on a launch
and on x-resume alike. `--x-level <model>:<effort>` takes the level.** One
of the two is required, so a typo still launches nothing; each alone keeps
the route ADR 0011 gave it — `--x-harness` alone the harness's catalog
defaults, `--x-level` alone the earliest harness in catalog order offering
that level — and both together pin and validate.

**A level keeps both parts, because the pair is one decision.** Which
efforts a model allows is the catalog's to know, not the operator's to
remember, and separating the flags would make an operator match a model
against an effort set in their head before typing — with a `--x-model` that
silently filled a default effort as the reward for guessing wrong. So
`--x-level` takes `<model>:<effort>`, both parts, and the catalog validates
them as one: no lone model, no lone effort, no sparse forms — the same
strictness ADR 0011 applied to its colon forms, now applied to a value that
carries only what colons were ever good at joining.

**Ownership moves to the flag's presence, unchanged in substance.**
`--x-level` owns both dimensions and hard-faults on a forwarded native
counterpart; a launch without one yields per dimension, the caller's
forwarded spelling winning unjudged. That is ADR 0011's rule with "a colon
form" replaced by "the flag" — the three request shapes reaching the
catalog are the same three, so resolution, injection, narration, and
balance routing are untouched. A level on a utility invocation is still a
fault; a resume still takes no injection ever, and now says so in its own
words rather than reporting `--x-level` as an unknown option.

The union value is retired loudly: a colon anywhere in `--x-harness` names
the replacement (`pass --x-harness codex --x-level gpt-5.6-luna:max`) rather
than reporting an unknown harness, because the old spelling is in every
README, help block, and operator's muscle memory. The shims are unaffected
— they exec `agentlaunch --x-harness <harness> "$@"`, which is now simply
the honest form.

Rejected: renaming the union flag (`--x-use`, `--x-target`), which fixes the
lie and keeps the polymorphic value; three flags, one per dimension, which
buys grammatical purity by making the operator hold every model's effort set
in their head; and keeping the colon triple as a shorthand, which is two
spellings for one selection.
