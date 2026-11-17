#!/bin/zsh
# Start the StreamCam server; then open http://127.0.0.1:7860 in Chrome or Safari.
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/server"
export PYTORCH_ENABLE_MPS_FALLBACK=1
export HF_HUB_DISABLE_IMPLICIT_TOKEN=1  # models are public; avoids failures from an expired saved HF login
export HF_HOME="$ROOT/models"
exec ./.venv/bin/python server.py
