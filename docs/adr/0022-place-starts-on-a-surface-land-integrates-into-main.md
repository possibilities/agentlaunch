# 0022 — Place starts on a Surface; Land integrates into the main line

**Place** puts a finished Launch spec on a Surface and produces a **Placement**; **Land** later merges that Placement's Workspace into the main line and releases it. Current glossary, help, code, and tests use the two terms exclusively; ADRs 0012–0015, 0017, and 0019–0021 remain immutable historical records whose use of “landing” for arrival now reads as “Placement,” without changing their mechanics.

The public `landing_in_flight` refusal becomes `placement_in_flight`, and its internal lease symbols change with it: keeping the old word as a compatibility alias would preserve the very ambiguity this decision removes. `closed_as: "landed"` remains correct because it records the later Land outcome, not the earlier Placement. Rejected: using “landing” for both lifecycle ends, which makes instructions such as “land the run” ambiguous exactly where `x-land` must be precise.
