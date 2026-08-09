# 0001 — One CLI, surface behavior as progressive enhancement

The runner and the surface client are one binary. Bare commands are a
passthrough wrapper around the harness CLIs; surface behavior arrives as
reserved `--x-*` flags on those same commands, and both paths consume the
same launch spec. Rejected: separate runner and surface programs, which
would fork the flag vocabulary and the harness adapters the day they
diverged.
