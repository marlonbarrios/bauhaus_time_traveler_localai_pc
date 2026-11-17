// Desktop shell: starts the Python StreamDiffusion server, then opens the UI in a native window.
const { app, BrowserWindow, session, systemPreferences } = require("electron");
app.setName("Bauhaus Time Traveler");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const PORT = process.env.PORT || 7860;
const URL = `http://127.0.0.1:${PORT}`;
const SERVER_DIR = path.join(__dirname, "..", "server");
const MODELS_DIR = path.join(__dirname, "..", "models");
let server = null;
if (process.env.STREAMCAM_DEBUG) app.commandLine.appendSwitch("remote-debugging-port", "9229");
// The window otherwise keeps the previous HTML and CSS, so a new layout never appears.
app.commandLine.appendSwitch("disable-http-cache");

let logFd = null;
function logFile() {
  if (logFd === null) logFd = require("fs").openSync(path.join(SERVER_DIR, "server.log"), "w");
  return logFd;
}

function ping() {
  return new Promise((resolve) => {
    http.get(`${URL}/health`, (res) => { res.resume(); resolve(res.statusCode === 200); })
      .on("error", () => resolve(false));
  });
}

async function startServer() {
  if (await ping()) return; // already running (e.g. started from a terminal)
  const python = process.platform === "win32"
    ? path.join(SERVER_DIR, ".venv", "Scripts", "python.exe")
    : path.join(SERVER_DIR, ".venv", "bin", "python");
  const env = {
    ...process.env,
    PORT: String(PORT),
    PYTHONUNBUFFERED: "1",
    HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
    HF_HOME: MODELS_DIR,
  };
  if (process.platform === "darwin") env.PYTORCH_ENABLE_MPS_FALLBACK = "1";
  server = spawn(python, ["server.py"], {
    cwd: SERVER_DIR,
    env,
    // launched via `open`, there is no terminal: keep the server log next to the server
    stdio: ["ignore", logFile(), logFile()],
  });
  server.on("exit", (code) => { if (code) console.error(`server exited with ${code}`); });
  for (let i = 0; i < 360; i++) {
    if (await ping()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}

async function createWindow() {
  // macOS: if camera access was never asked for, the camera turns on but delivers no frames.
  // Ask explicitly so the system permission dialog appears.
  if (process.platform === "darwin") {
    for (const media of ["camera", "microphone"]) {
      const status = systemPreferences.getMediaAccessStatus(media);
      console.log(`[permissions] ${media}: ${status}`);
      if (status === "not-determined") {
        const ok = await systemPreferences.askForMediaAccess(media);
        console.log(`[permissions] ${media} granted after asking: ${ok}`);
      }
    }
  }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(["media", "fullscreen"].includes(permission));
  });
  // Recordings save straight to ~/Movies/StreamCam (no save dialog).
  session.defaultSession.on("will-download", (_e, item) => {
    const dir = path.join(app.getPath("videos"), "StreamCam");
    require("fs").mkdirSync(dir, { recursive: true });
    item.setSavePath(path.join(dir, item.getFilename()));
  });
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 820, minHeight: 560,
    backgroundColor: "#0d0e11",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    title: "Bauhaus Time Traveler",
    // keep generating/recording at full speed even when the window is behind others
    webPreferences: { backgroundThrottling: false },
  });
  win.loadURL(`data:text/html,<body style="background:%230d0e11;color:%238b909b;font-family:-apple-system;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">Starting StreamDiffusion server…</body>`);
  await startServer();
  await session.defaultSession.clearCache();
  // A new query each launch, so the window cannot reuse a saved copy of the page.
  await win.loadURL(`${URL}/?v=${Date.now()}`);
  // Windows does not leave fullscreen on Escape by itself. Do it here, and show the controls again.
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type !== "keyDown" || input.key !== "Escape" || input.isAutoRepeat) return;
    if (win.isFullScreen()) win.setFullScreen(false);
    win.webContents.executeJavaScript(
      "document.fullscreenElement && document.exitFullscreen(); document.body.classList.remove('ui-hidden');"
    ).catch(() => {});
  });
  win.show();
  win.focus();
}

app.whenReady().then(createWindow).catch((e) => { console.error(e); app.quit(); });
app.on("window-all-closed", () => app.quit());
app.on("quit", () => server && server.kill());
