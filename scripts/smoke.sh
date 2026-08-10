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
expect_exit 0 run --x-help
expect_exit 0 run x-doctor
expect_exit 0 run x-doctor --x-json
expect_out '"harnesses"'
expect_out '"catalog"'

# Launches resolve the --x-harness value against the catalog and inject the
# resolved model and effort in the harness's own spelling. Yolo is on by
# default (ADR 0009).
expect_exit 0 run --x-harness claude --x-dry-run
expect_out "claude --dangerously-skip-permissions --model opus --effort medium"
expect_exit 0 run --x-harness codex --x-no-yolo --x-dry-run
expect_out "codex --model gpt-5.6-sol -c 'model_reasoning_effort=\"high\"'"
expect_exit 0 run --x-harness pi --x-no-yolo --x-dry-run
expect_out "pi --model openai-codex/gpt-5.6-sol --thinking high"

# Colon forms: model:effort walks catalog order, harness:model:effort pins.
expect_exit 0 run --x-harness gpt-5.6-sol:ultra --x-no-yolo --x-dry-run
expect_out "codex --model gpt-5.6-sol -c 'model_reasoning_effort=\"ultra\"'"
expect_exit 0 run --x-harness sonnet:high --x-no-yolo --x-dry-run
expect_out "claude --model sonnet --effort high"
expect_exit 0 run --x-harness pi:gpt-5.6-luna:max --x-no-yolo --x-dry-run
expect_out "pi --model openai-codex/gpt-5.6-luna --thinking max"

# The name route yields per dimension to forwarded native flags.
expect_exit 0 run --x-harness claude --model sonnet --x-no-yolo --x-dry-run
expect_out "claude --effort medium --model sonnet"
expect_exit 0 run --x-harness claude "hello there" --x-no-yolo --x-dry-run --x-json
expect_out '"model_source":"default"'

# Colon forms own both dimensions; conflicts and misses are usage faults.
expect_exit 2 run --x-harness claude:opus:high --model sonnet --x-dry-run
expect_exit 2 run --x-harness claude:opus:high --effort low --x-dry-run
expect_exit 2 run --x-harness gpt-5.5:ultra --x-dry-run
expect_exit 2 run --x-harness opus --x-dry-run
expect_exit 2 run --x-harness claude:opus --x-dry-run
expect_exit 2 run --x-harness cursor:m:e --x-dry-run

# --x-no-yolo redacts an explicitly forwarded yolo flag, narrated.
expect_exit 0 run --x-harness claude --dangerously-skip-permissions --x-no-yolo --x-dry-run
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
expect_exit 0 run --x-harness claude --x-dry-run
if grep -q -- "--dangerously" "$WORK/out"; then
  echo "FAIL: a disabling config still injected the flag" >&2
  exit 1
fi
expect_exit 0 run --x-harness claude --x-yolo --x-dry-run
expect_out "claude --dangerously-skip-permissions"
expect_exit 2 run --x-harness pi --x-yolo --x-no-yolo --x-dry-run
rm "$WORK/home/.config/agentsurface/config.json"

# Utility invocations pass through uninjected; colon forms refuse them.
expect_exit 0 run --x-harness codex --x-dry-run login
expect_out "codex login"
expect_exit 0 run --x-harness claude --x-dry-run --version
expect_out "claude --version"
expect_exit 2 run --x-harness codex:gpt-5.5:high login --x-dry-run

# Usage faults exit 2 before anything runs
expect_exit 2 run --x-bogus
expect_exit 2 run x-something
expect_exit 2 run --x-harness claude --x-json
expect_exit 2 run x-resume a/b --x-dry-run
expect_exit 2 run claude
expect_exit 2 run open claude
expect_exit 2 run resume abc
expect_exit 2 run doctor
expect_exit 2 run land

# Resume against a fixture store: no model/effort injection, ever.
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
expect_exit 0 run_balanced --x-harness claude --x-no-yolo --x-dry-run
expect_out "cswap run 1 --share-history -- --model opus --effort medium"
expect_exit 0 run_balanced --x-harness codex --x-no-yolo --x-dry-run
expect_out "codex-swap run --account account:org-smoke --"
expect_exit 0 run_balanced --x-harness pi --x-no-yolo --x-dry-run
expect_out "codex-swap pi run --account account:org-smoke -- --model openai-codex/gpt-5.6-sol"
expect_exit 0 run_balanced x-resume "$SESSION_ID" --x-no-yolo --x-dry-run
expect_out "cswap run 1 --share-history -- --resume $SESSION_ID"
expect_exit 0 run_balanced --x-harness claude --x-no-balance --x-no-yolo --x-dry-run
expect_out "claude"
expect_exit 2 run_balanced --x-harness claude --x-account c1 --x-no-balance --x-dry-run

# Surface landings against a fake orca: the adapter drives the real CLI
# contract shapes, the fake creates nothing, and the run registry fills.
install_fake_orca() {
  mkdir -p "$WORK/orca-bin"
  cat >"$WORK/orca-bin/orca" <<FAKE
#!/usr/bin/env bash
case "\$1 \$2" in
  "status --json") printf '{"ok":true,"result":{"runtime":{"reachable":true,"state":"ready","appVersion":"smoke"}}}\n';;
  "worktree show") printf '{"ok":true,"result":{"worktree":{"id":"repo1::$WORK/ws","path":"$WORK/ws","displayName":"main"}}}\n';;
  "terminal create") printf '{"ok":true,"result":{"terminal":{"handle":"term_smoke"}}}\n';;
  *) printf '{"ok":false}\n'; exit 1;;
esac
FAKE
  chmod +x "$WORK/orca-bin/orca"
  mkdir -p "$WORK/ws"
}

run_surface() {
  env -i PATH="$WORK/orca-bin:$PATH" HOME="$WORK/home" AGENTSURFACE_NO_BALANCE=1 \
    CLAUDE_CONFIG_DIR="$WORK/claude" CODEX_HOME="$WORK/codex" PI_CODING_AGENT_DIR="$WORK/pi" \
    bun "$ROOT/src/main.ts" "$@"
}

install_fake_orca
cd "$WORK/ws"
expect_exit 0 run_surface --x-harness claude --x-surface --x-no-yolo --x-json
expect_out '"run_id"'
expect_out '"terminal":"term_smoke"'
RUN_ID="$(python3 -c "import json;print(json.load(open('$WORK/out'))['data']['run_id'])")"
expect_exit 0 run_surface --x-harness claude --x-surface --x-no-yolo --x-dry-run
expect_out "claude --model opus --effort medium"
expect_exit 0 run_surface x-runs
expect_out "$RUN_ID"
expect_exit 0 run_surface x-run "$RUN_ID"
expect_out "term_smoke"
expect_exit 0 run_surface x-doctor --x-json
expect_out '"surface"'
expect_exit 1 run_surface x-run 99999999-9999-4999-9999-999999999999
expect_exit 2 run_surface --x-harness claude --x-workspace name:main
expect_exit 2 run_surface --x-harness claude --x-surface --x-workspace a --x-new-workspace b
expect_exit 2 run_surface --x-harness codex --x-surface login
cd "$ROOT"

# The narrative is on stderr, so stdout stays exactly the command
expect_exit 0 run --x-harness claude --x-no-yolo --x-dry-run
if [[ "$(cat "$WORK/out")" != "claude --model opus --effort medium" ]]; then
  echo "FAIL: narrative leaked into stdout" >&2
  cat "$WORK/out" >&2
  exit 1
fi
grep -q "^open      claude$" "$WORK/err" || { echo "FAIL: no narrative on stderr" >&2; exit 1; }
grep -q "^model     opus · default$" "$WORK/err" || { echo "FAIL: model row missing" >&2; exit 1; }
grep -q "^effort    medium · default$" "$WORK/err" || { echo "FAIL: effort row missing" >&2; exit 1; }
expect_exit 0 run --x-harness claude --x-dry-run --x-json --x-verbose
if [[ -s "$WORK/err" ]]; then
  echo "FAIL: --x-json did not silence the narrative" >&2
  cat "$WORK/err" >&2
  exit 1
fi
expect_exit 0 run --x-harness claude --x-dry-run --x-verbose
grep -q "^config    " "$WORK/err" || { echo "FAIL: --x-verbose printed no mechanism" >&2; exit 1; }

echo "smoke: all commands behaved"
