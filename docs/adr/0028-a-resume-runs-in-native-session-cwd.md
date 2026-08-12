# 0028 — A resume runs in the native session cwd

`x-resume <native-session-id>` reads the owning harness's native metadata and
starts the native resume command in the cwd recorded there. A conversation is
about files in one place; silently picking it up elsewhere hands the harness a
history describing files that are not present.

If the native directory is unknown or gone, AgentLaunch states that and keeps
the invocation cwd. It does not invent a workspace, consult a launch registry,
or refuse an otherwise native-resumable session. `--x-harness` skips store
detection, while metadata lookup remains best-effort for cwd and Claude balance
routing.

Rejected: a launcher-owned session/run reference. Native session IDs are the
portable identity, and post-launch names or environment identities belong to
their native owners.
