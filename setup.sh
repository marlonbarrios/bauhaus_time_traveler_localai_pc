#!/bin/zsh
# One-time setup: installs the Python environment (StreamDiffusion + Whisper) and Electron.
# Safe to re-run. Models download on first launch into models/ in this folder.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT/server"

if [ ! -d vendor/StreamDiffusion-Mac ]; then
  mkdir -p vendor
  git clone --depth 1 https://github.com/patrickhartono/StreamDiffusion-Mac.git vendor/StreamDiffusion-Mac
fi

if [ ! -x .venv/bin/python ]; then
  CONDA="$(command -v conda >/dev/null && echo conda || echo /opt/miniconda3/bin/conda)"
  "$CONDA" create -y -q -p ./.venv python=3.10
fi
P=./.venv/bin/python
$P -m ensurepip >/dev/null 2>&1 || true
$P -m pip install -q -U pip
$P -m pip install -q torch torchvision
$P -m pip install -q -e "vendor/StreamDiffusion-Mac[macos]"
# The fork pins transformers 4.35.2, which is too old for its own diffusers 0.33.1.
$P -m pip install -q "transformers==4.49.0" fastapi "uvicorn[standard]" pillow "numpy<2" mlx-whisper websockets
$P -c "import streamdiffusion, mlx_whisper, torch; from diffusers import StableDiffusionPipeline; print('Python env OK, MPS:', torch.backends.mps.is_available())"

cd "$ROOT/desktop"
npm install --no-audit --no-fund
echo "Setup done. Start with:  cd \"$ROOT/desktop\" && npm start"
