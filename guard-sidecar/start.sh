#!/usr/bin/env bash
# guard-sidecar/start.sh
# Launches the guard sidecar FastAPI server.
# Called by ClaudePaw's init sequence.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

choose_python() {
    local candidates=(
        "${GUARD_SIDECAR_PYTHON:-}"
        "/opt/anaconda3/bin/python3"
        "python3.12"
        "python3.11"
        "python3.10"
        "python3"
    )

    for candidate in "${candidates[@]}"; do
        [ -n "$candidate" ] || continue
        if command -v "$candidate" >/dev/null 2>&1; then
            local version
            version="$("$candidate" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
            local major="${version%%.*}"
            local minor="${version##*.}"
            if [ "$major" -gt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -ge 10 ]; }; then
                printf '%s\n' "$candidate"
                return 0
            fi
        fi
    done

    echo "[guard-sidecar] Could not find Python 3.10+ interpreter" >&2
    return 1
}

PYTHON_BIN="$(choose_python)"
CURRENT_PYTHON="$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
VENV_PYTHON=""

if [ -x ".venv/bin/python" ]; then
    VENV_PYTHON="$(.venv/bin/python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
fi

if [ -d ".venv" ] && [ -n "$VENV_PYTHON" ] && [ "$VENV_PYTHON" != "$CURRENT_PYTHON" ]; then
    echo "[guard-sidecar] Recreating virtual environment for Python $CURRENT_PYTHON (found stale $VENV_PYTHON)..."
    rm -rf .venv
fi

# Create venv if it doesn't exist
if [ ! -d ".venv" ]; then
    echo "[guard-sidecar] Creating Python virtual environment with $PYTHON_BIN..."
    "$PYTHON_BIN" -m venv .venv
fi

# Activate venv
source .venv/bin/activate

# Install/update dependencies
export PIP_DISABLE_PIP_VERSION_CHECK=1
pip install -q -r requirements.txt

# Install nova-hunting separately (may fail gracefully)
pip install -q nova-hunting 2>/dev/null || echo "[guard-sidecar] nova-hunting not available, L3 will be degraded"

# Start the server
echo "[guard-sidecar] Starting on localhost:${GUARD_SIDECAR_PORT:-8099}..."
python main.py
