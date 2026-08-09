#!/usr/bin/env bash
set -euo pipefail

# Every documented command end-to-end against a throwaway HOME and empty
# session stores. Launch paths only ever run with --x-dry-run, so the smoke
# can never start a real harness.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Raw launch grammar: balancing off, exactly what the harness receives.
run() {
  env -i PATH="$PATH" HOME="$WORK/home" AGENTSURFACE_NO_BALANCE=1 \
    CLAUDE_CONFIG_DIR="$WORK/claude" CODEX_HOME="$WORK/codex" PI_CODING_AGENT_DIR="$WORK/pi" \
    bun "$ROOT/src/main.ts" "$@"
}

# Balanced grammar: a fake agentusage first on PATH answers selection, so
# composition is exercised without the real stack or any reservation.
run_balanced() {
  env -i PATH="$WORK/bin:$PATH" HOME="$WORK/home" \
    CLAUDE_CONFIG_DIR="$WORK/claude" CODEX_HOME="$WORK/codex" PI_CODING_AGENT_DIR="$WORK/pi" \
    bun "$ROOT/src/main.ts" "$@"
}

install_fake_balance() {
  mkdir -p "$WORK/bin"
  cat >"$WORK/bin/agentusage" <<'FAKE'
#!/usr/bin/env bash
if [ "$2" = "claude" ]; then
  printf '{"schema_version":1,"provider":"claude","ok":true,"route":{"id":"claude-swap:1","kind":"managed","slot":1},"reason":"selected"}\n'
else
  printf '{"schema_version":1,"provider":"codex","ok":true,"accountKey":"account:org-smoke","lease":null,"reason":"selected"}\n'
fi
FAKE
  chmod +x "$WORK/bin/agentusage"
}

expect_exit() {
  local expected="$1"
  shift
  local actual=0
  "$@" >"$WORK/out" 2>"$WORK/err" || actual=$?
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: expected exit $expected, got $actual: $*" >&2
    cat "$WORK/out" "$WORK/err" >&2
    exit 1
  fi
}

expect_out() {
  if ! grep -q -- "$1" "$WORK/out"; then
    echo "FAIL: output does not contain: $1" >&2
    cat "$WORK/out" >&2
    exit 1
  fi
}

# Help, version, doctor
expect_exit 0 run --version
expect_exit 0 run --agent-teaser
expect_exit 0 run --agent-help
expect_exit 0 run claude --x-help
expect_exit 0 run x-doctor
expect_exit 0 run x-doctor --x-json
expect_out '"harnesses"'
expect_out '"catalog"'

# Launches, dry runs only. Yolo is on by default (ADR 0009).
expect_exit 0 run claude --x-dry-run
expect_out "claude --dangerously-skip-permissions"
expect_exit 0 run codex --x-dry-run
expect_out "codex --dangerously-bypass-approvals-and-sandbox"
expect_exit 0 run pi --x-dry-run
expect_out "pi --approve"

# Unprefixed tokens forward verbatim, in the order typed.
expect_exit 0 run claude "hello there" --model fable --x-no-yolo --x-dry-run
expect_out "claude 'hello there' --model fable"
expect_exit 0 run claude --permission-mode plan --x-no-yolo --x-dry-run --x-json
expect_out '"--permission-mode"'
expect_exit 0 run codex --totally-unknown-flag --x-no-yolo --x-dry-run
expect_out "codex --totally-unknown-flag"

# --x-no-yolo redacts an explicitly forwarded yolo flag; the removal is
# narrated on stderr and recorded in the envelope.
expect_exit 0 run claude --dangerously-skip-permissions --x-no-yolo --x-dry-run --x-json
expect_out '"redactions":\["--dangerously-skip-permissions"\]'
expect_exit 0 run claude --dangerously-skip-permissions --x-no-yolo --x-dry-run
if grep -q -- "--dangerously" "$WORK/out"; then
  echo "FAIL: --x-no-yolo did not redact the forwarded flag" >&2
  exit 1
fi
grep -q "removed --dangerously-skip-permissions" "$WORK/err" || {
  echo "FAIL: redaction was not narrated" >&2
  exit 1
}

# The config file disables yolo; --x-yolo forces it back per launch.
mkdir -p "$WORK/home/.config/agentsurface"
printf '{"yolo":false}\n' >"$WORK/home/.config/agentsurface/config.json"
expect_exit 0 run claude --x-dry-run
if grep -q -- "--dangerously" "$WORK/out"; then
  echo "FAIL: a disabling config still injected the flag" >&2
  exit 1
fi
expect_exit 0 run claude --x-yolo --x-dry-run
expect_out "claude --dangerously-skip-permissions"
expect_exit 2 run pi --x-yolo --x-no-yolo --x-dry-run
rm "$WORK/home/.config/agentsurface/config.json"

# Utility invocations pass through unwrapped and unflagged.
expect_exit 0 run codex --x-dry-run login
expect_out "codex login"
expect_exit 0 run claude --x-dry-run --version
expect_out "claude --version"

# Usage faults exit 2 before anything runs
expect_exit 2 run cursor --x-dry-run
expect_exit 2 run claude --x-bogus
expect_exit 2 run claude x-something
expect_exit 2 run claude --x-json
expect_exit 2 run x-resume a/b --x-dry-run
expect_exit 2 run open claude
expect_exit 2 run resume abc
expect_exit 2 run doctor
expect_exit 2 run bogus-command

# Resume against a fixture store
SESSION_ID="05c42ef4-93a2-4a5c-9d3e-1b2c3d4e5f60"
mkdir -p "$WORK/claude/projects/-somewhere"
printf '{}\n' >"$WORK/claude/projects/-somewhere/$SESSION_ID.jsonl"
expect_exit 0 run x-resume "$SESSION_ID" --x-no-yolo --x-dry-run
expect_out "claude --resume $SESSION_ID"
expect_exit 0 run x-resume "$SESSION_ID" --x-dry-run
expect_out "claude --resume $SESSION_ID --dangerously-skip-permissions"
expect_exit 0 run x-resume "$SESSION_ID" --x-harness pi --x-no-yolo --x-dry-run
expect_out "pi --session $SESSION_ID"
expect_exit 1 run x-resume 99999999-9999-4999-9999-999999999999
expect_exit 1 run x-resume 99999999-9999-4999-9999-999999999999 --x-dry-run --x-json
expect_out '"code":"session_not_found"'

# Balanced launches compose the swap prefix (fake stack, dry runs only)
install_fake_balance
expect_exit 0 run_balanced claude --model fable --x-no-yolo --x-dry-run
expect_out "cswap run 1 --share-history -- --model fable"
expect_exit 0 run_balanced codex --x-no-yolo --x-dry-run
expect_out "codex-swap run --account account:org-smoke --"
expect_exit 0 run_balanced pi --x-no-yolo --x-dry-run
expect_out "codex-swap pi run --account account:org-smoke --"
expect_exit 0 run_balanced x-resume "$SESSION_ID" --x-no-yolo --x-dry-run
expect_out "cswap run 1 --share-history -- --resume $SESSION_ID"
expect_exit 0 run_balanced claude --x-no-balance --x-no-yolo --x-dry-run
expect_out "claude"
expect_exit 2 run_balanced claude --x-account c1 --x-no-balance --x-dry-run

# The narrative is on stderr, so stdout stays exactly the command
expect_exit 0 run claude --model fable --x-no-yolo --x-dry-run
if [[ "$(cat "$WORK/out")" != "claude --model fable" ]]; then
  echo "FAIL: narrative leaked into stdout" >&2
  cat "$WORK/out" >&2
  exit 1
fi
grep -q "^open    claude$" "$WORK/err" || { echo "FAIL: no narrative on stderr" >&2; exit 1; }
grep -q "^yolo    off" "$WORK/err" || { echo "FAIL: yolo row missing" >&2; exit 1; }
expect_exit 0 run claude --x-dry-run --x-json --x-verbose
if [[ -s "$WORK/err" ]]; then
  echo "FAIL: --x-json did not silence the narrative" >&2
  cat "$WORK/err" >&2
  exit 1
fi
expect_exit 0 run claude --x-dry-run --x-verbose
grep -q "^config  " "$WORK/err" || { echo "FAIL: --x-verbose printed no mechanism" >&2; exit 1; }

echo "smoke: all commands behaved"
