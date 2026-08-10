# 0019 — A run name is unique among open runs

`--x-name` refuses a name an open run already answers to, naming the run that
holds it. Closed runs keep theirs, and nothing is generated when a name is
taken — the caller picks another or lands the run that has it.

This revises ADR 0017, which rejected uniqueness as turning a label into an
identity. That reasoning was right for what a name did then: a handle a human
reads back in a status report. It stopped being right once the name became the
handle other agents *address the run by*. Two open runs called `auth-flow`
resolve to neither — `ambiguous_run` here, `ambiguous_peer` on the bus — so
the label that was merely duplicated is now the one that does not work. The
refusal happens where a caller can still choose: at launch, rather than at the
moment somebody tries to reach the run and finds two.

**Among open runs, not historically.** A global name namespace would burn a
word forever the first time it was used, which is a daily cost for a rare
benefit. ADR 0017 already prefers open runs when resolving `run:<name>`, so a
closed run sharing the name resolves correctly; enforcing at the open tier
closes the gap that actually bites without spending the namespace. The
ordinary second attempt at the same task that ADR 0017 worried about still
works, once the first attempt has landed.

**Refused, never suffixed.** Appending an ordinal would invent a name, which
ADR 0017 rules out for good reason: the caller asked for `auth-flow`, and
handing back `auth-flow-2` means everything it recorded or told another agent
now refers to a name that is not the run's. A refusal is one retry; a silent
rename is a divergence discovered later.

**Only landings are checked**, because only landings leave a record. A runner
launch passes `--x-name` straight to the harness and agentsurface keeps no
registry of it, so there is nothing to check against — and nothing that could
be checked without inventing a record of every launch, which is a change to
what a run is (ADR 0014).

Rejected: historical uniqueness, which makes names scarce for no gain the open
tier does not already give; an ordinal suffix, for inventing state nobody
asked for; and refusing only at the moment of ambiguity, which leaves the
caller holding two runs and no way to tell them apart.
