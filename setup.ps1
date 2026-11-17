# One-time Windows setup: CUDA PyTorch, StreamDiffusion, and the models in models\.
# Safe to re-run. Needs Python 3.11 and an NVIDIA driver new enough for CUDA 12.8.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Server = Join-Path $Root "server"
$VenvPy = Join-Path $Server ".venv\Scripts\python.exe"
$Models = Join-Path $Root "models"

if (-not (Test-Path $VenvPy)) {
  Write-Host "Creating Python 3.11 environment..."
  py -3.11 -m venv (Join-Path $Server ".venv")
}

Write-Host "Installing PyTorch for CUDA 12.8 (RTX 50-series)..."
& $VenvPy -m pip install -U pip
& $VenvPy -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128

$Vendor = Join-Path $Server "vendor\StreamDiffusion-Mac"
if (-not (Test-Path (Join-Path $Vendor "setup.py"))) {
  Write-Host "Cloning StreamDiffusion..."
  New-Item -ItemType Directory -Force -Path (Join-Path $Server "vendor") | Out-Null
  git clone --depth 1 https://github.com/patrickhartono/StreamDiffusion-Mac.git $Vendor
}

Write-Host "Installing the live-image pipeline and speech..."
# --no-deps so this checkout cannot replace the CUDA build of PyTorch.
& $VenvPy -m pip install -e $Vendor --no-deps
& $VenvPy -m pip install "diffusers==0.33.1" "transformers==4.49.0" "accelerate==1.7.0" "huggingface_hub==0.36.2" fire omegaconf fastapi "uvicorn[standard]" pillow

Write-Host "Checking the GPU..."
& $VenvPy -c "import torch; assert torch.cuda.is_available(), 'CUDA not available'; print(torch.__version__, torch.version.cuda, torch.cuda.get_device_name(0), torch.cuda.get_device_capability(0))"

New-Item -ItemType Directory -Force -Path $Models | Out-Null
$env:HF_HOME = $Models
$env:HF_HUB_DISABLE_IMPLICIT_TOKEN = "1"
Write-Host "Downloading models into $Models ..."
& $VenvPy -c @"
from huggingface_hub import snapshot_download
repos = [
    'stabilityai/sd-turbo',
    'madebyollin/taesd',
    'openai/whisper-large-v3-turbo',
    'openai/whisper-small',
]
for repo in repos:
    print('downloading', repo, flush=True)
    snapshot_download(repo)
print('models ready')
"@

Set-Location (Join-Path $Root "desktop")
npm install --no-audit --no-fund
Write-Host "Setup done. Start with:  cd `"$(Join-Path $Root 'desktop')`" ; npm start"
