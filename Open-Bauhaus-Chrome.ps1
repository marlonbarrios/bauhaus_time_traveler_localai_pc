# Open Bauhaus Time Traveler as a Chrome app window. Starts the local server if it is not already up.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Url = "http://127.0.0.1:7860/"
$Chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"

function ServerUp {
  # curl, not Invoke-WebRequest: a proxy can hang the web cmdlet on 127.0.0.1.
  $code = & curl.exe -s -o NUL -w "%{http_code}" --max-time 1 ($Url + "health")
  return $code -eq "200"
}

if (-not (ServerUp)) {
  $pythonw = Join-Path $Root "server\.venv\Scripts\pythonw.exe"
  $python = Join-Path $Root "server\.venv\Scripts\python.exe"
  $exe = if (Test-Path $pythonw) { $pythonw } else { $python }
  Start-Process -FilePath $exe -ArgumentList "server.py" -WorkingDirectory (Join-Path $Root "server") -WindowStyle Hidden
  for ($i = 0; $i -lt 90; $i++) {
    if (ServerUp) { break }
    Start-Sleep -Seconds 1
  }
}

# A path without spaces. Chrome splits --user-data-dir on spaces and then opens the leftover word as a site.
$ProfileDir = Join-Path $env:LOCALAPPDATA "BauhausTimeTraveler\window"
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
# A normal app window: title bar, close button, and Alt+F4 leave the app.
# F in the page fills the screen. Escape leaves that. --kiosk and
# --start-fullscreen hide the window buttons, so they are not used.
Start-Process -FilePath $Chrome -ArgumentList @(
  "--user-data-dir=$ProfileDir",
  "--app=$Url",
  "--start-maximized",
  "--no-first-run",
  "--disable-infobars",
  "--disable-features=TranslateUI",
  "--autoplay-policy=no-user-gesture-required"
)
