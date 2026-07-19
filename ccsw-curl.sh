#!/usr/bin/env bash
# ccsw-curl.sh -- authenticated curl against the ccswitchboard relay from the VM.
#
# The relay verifies a shared secret sent as the X-CCSW-Token header (see
# board/auth.php requireAuth()). The authoritative copy of that secret on this
# box lives in the CcswAgent config:
#
#     agent/CcswAgent/agent.config.json  ->  .token
#
# That is the SAME value the running agent sends when it POSTs job results, so
# it is by definition the token the server currently accepts. Do NOT hard-code
# the token here: agent.config.json is gitignored (per-box secret) and the token
# can be rotated, so this script always reads it fresh at call time.
#
# NOTE: /tmp/ccsw_token is NOT canonical -- it is a hand-copied cache that goes
# stale when the token rotates and was the cause of the 401s this script fixes.
# Use this script (or read agent.config.json directly) instead.
#
# Usage:
#   ./ccsw-curl.sh jobs.php?limit=1
#   ./ccsw-curl.sh debuglog.php?limit=5
#   ./ccsw-curl.sh result.php -X POST -d @body.json   # extra curl args pass through
#
# The first argument is the endpoint (relative to the relay base); everything
# after it is forwarded to curl untouched. Env overrides:
#   CCSW_AGENT_CONFIG  path to agent.config.json (default: alongside this script)
#   CCSW_TOKEN         use this token instead of reading the config
#   CCSW_RELAY_BASE    override the relay base URL
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${CCSW_AGENT_CONFIG:-$SCRIPT_DIR/agent/CcswAgent/agent.config.json}"

if [[ $# -lt 1 ]]; then
  grep '^#' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi

read_field() { grep -oP "\"$1\"\\s*:\\s*\"\\K[^\"]+" "$CONFIG" 2>/dev/null || true; }

if [[ -n "${CCSW_TOKEN:-}" ]]; then
  TOKEN="$CCSW_TOKEN"
else
  if [[ ! -f "$CONFIG" ]]; then
    echo "ccsw-curl: agent config not found: $CONFIG" >&2
    echo "ccsw-curl: set CCSW_AGENT_CONFIG or CCSW_TOKEN" >&2
    exit 1
  fi
  TOKEN="$(read_field token)"
fi

if [[ -z "$TOKEN" ]]; then
  echo "ccsw-curl: no token found in $CONFIG" >&2
  exit 1
fi

BASE="${CCSW_RELAY_BASE:-$(read_field relayBase)}"
BASE="${BASE:-https://dabblelabs.uk/ccswitchboard/board}"

ENDPOINT="$1"; shift
exec curl -sS -H "X-CCSW-Token: $TOKEN" "$@" "$BASE/$ENDPOINT"
