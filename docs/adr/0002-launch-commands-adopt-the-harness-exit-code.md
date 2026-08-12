# 0002 — Launch commands adopt the harness's exit code

open and resume exist to become the harness, so they exit with the
harness's own code (fatal signals spelled 128+n), not the family 0/1/2
contract — a wrapper reporting 0 while claude died would lie to everything
scripted around it. The family contract still governs whatever does not
launch: dry runs, doctor, and every refusal that happens before the spawn.
