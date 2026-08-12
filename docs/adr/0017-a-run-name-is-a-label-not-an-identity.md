# 0017 — A run name is a label, not an identity

> Revised by ADR 0019: a name is still a label rather than an identity, but it
> is now unique among *open* runs. The "not unique" paragraph below is the
> position 0019 replaced; everything else here stands.

`--x-name <name>` gives a run the handle a human reads back. It is free
text — it names nothing on disk, so it needs none of the run id's
glob-literal alphabet — and it is **not unique**: nothing enforces
distinctness, and two runs called `auth-flow` are an ordinary thing to have.
The run id minted at landing (ADR 0014) remains the identity; the name only
has to be recognizable.

**The name is stated in every place that has one, and the harness gap is a
warning rather than a fault.** claude and pi take `--name` at launch, so a
runner launch injects it in their own spelling; codex has no launch-time
name at all, so there the runner narrates the drop and passes nothing.
A landing recovers what codex loses: the name titles the terminal, labels a
workspace the landing created, and is written to the run record — which is
why the asymmetry is worth a row in the narrative rather than a refusal.

**`--x-name` owns the name dimension.** A forwarded `--name`, `--name=…`,
or `-n` alongside it is a usage fault, the way a colon harness value faults
on a forwarded `--model` (ADR 0011): choosing between two names the
operator typed is judgment, and the rule everywhere else here is to state
rather than infer. A resume takes no injection at all, as resumes always
have — a name there labels where the conversation was picked up and never
renames the session the harness already knows.

**A reference resolves in tiers: exact run id first, then name.** `run:` is
the one word, because `run:` is already ours and `name:` belongs to a
backend's selector vocabulary — Orca uses it for workspaces — and shadowing
it would break references that never concerned the registry. The id tier
being exact means a name shaped like an id can never hide the record it
names. Several runs answering to one name is an `ambiguous_run` refusal
listing their ids, never a guess; open runs are preferred over landed ones,
whose workspaces are gone. This is what makes the name a handle rather than
decoration: `x-run auth-flow`, `--x-from run:auth-flow`, and
`x-land run:auth-flow` all work.

**The backend states the label rather than leaving it to be derived.** Where
a backend names things a person looks at, the adapter sets that label to
the name as typed, and only for a workspace the landing itself created —
relabelling one that already existed would rename somebody else's card as a
side effect of landing in it. Orca stores both its worktree name and its
display name verbatim, so the checkout keeps the slug it was created with
while the card reads the operator's own words.

Rejected: generating a name for unnamed runs, which invents state nobody
asked for and makes "unnamed" unrepresentable; claiming `name:` as our own
ref, which shadows a backend selector; enforcing uniqueness, which would
turn a label into an identity and refuse an ordinary second attempt at the
same task; and letting a forwarded `--name` win silently, which would make
the record and the harness disagree about what the run is called.
