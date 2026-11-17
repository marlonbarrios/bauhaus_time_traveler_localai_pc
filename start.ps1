# Start the server. Then open http://127.0.0.1:7860
# The desktop window (cd desktop; npm start) starts this on its own.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:HF_HOME = Join-Path $Root "models"
$env:HF_HUB_DISABLE_IMPLICIT_TOKEN = "1"
$env:PYTHONUNBUFFERED = "1"
Set-Location (Join-Path $Root "server")
& .\.venv\Scripts\python.exe server.py
