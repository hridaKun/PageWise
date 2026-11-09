"use strict";

// Pagewise for Linux: the window. The Linux counterpart of src/MainForm.cs and
// src/Program.cs. Hosts the shared reader in Electron (Chromium, the same
// engine as Edge WebView2 on Windows) and supplies what a web page can't do
// by itself: reading and writing files, Open/Save dialogs, recent files,
// "Open with", read aloud, and asking before closing with unsaved changes.
//
// Nothing is ever sent to the network. Every https:// request is answered
// here:
//   https://pagewise.example/...         the app's own files (web/)
//   https://files.pagewise.example/doc/<id>    the PDF of a tab (GET, byte ranges)
//   https://files.pagewise.example/save/<id>   write a tab's PDF to its file (PUT)
// Anything else is refused. The pages talk to this process through
// preload.js, which looks like WebView2's window.chrome.webview to them.

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
  screen,
  session,
  shell,
} = require("electron");
const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { Readable } = require("node:stream");

const VERSION = require("./package.json").version;
const APP_HOST = "pagewise.example";
const FILES_HOST = "files.pagewise.example";
const ORIGIN = `https://${APP_HOST}`;
const SHELL_URL = `${ORIGIN}/desk/shell.html`;
const WEB_DIR = path.join(__dirname, "web");
const ICON = path.join(__dirname, "icons", "pagewise.png");
const DEBUG_PORT = process.env.PAGEWISE_DEBUG_PORT || null;

const CORS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".icc": "application/vnd.iccprofile",
  ".ftl": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

// ------------------------------------------------------------ app setup

app.setName("Pagewise");
// A debug instance gets its own data, so it never touches a running Pagewise.
app.setPath("userData", path.join(app.getPath("appData"), DEBUG_PORT ? "Pagewise-debug" : "Pagewise"));
const DATA_DIR = app.getPath("userData");

if (DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", DEBUG_PORT);
}
// Native Wayland when the session has it (touchpad pinch, sharp HiDPI),
// X11 otherwise.
app.commandLine.appendSwitch("ozone-platform-hint", "auto");
app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations");

// One window: opening a PDF while Pagewise runs adds a tab to it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv, cwd) => {
    const files = filesFromArgs(argv.slice(1), cwd);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      openFiles(files);
    } else {
      waitingToOpen.push(...files);
    }
  });
  app.whenReady().then(start);
}

app.on("window-all-closed", () => app.quit());

let win = null;
let shellReady = false;
let closeConfirmed = false;
let dark = true;
const docs = new Map(); // id -> path
const waitingToOpen = filesFromArgs(process.argv.slice(app.isPackaged ? 1 : 2), process.cwd());
const recent = new RecentFiles(path.join(DATA_DIR, "recent.json"));

function filesFromArgs(args, cwd) {
  const files = [];
  for (const arg of args) {
    if (!arg || arg.startsWith("-")) continue;
    let file = arg;
    if (/^file:\/\//i.test(arg)) {
      try {
        file = require("node:url").fileURLToPath(arg);
      } catch {
        continue;
      }
    }
    file = path.resolve(cwd || process.cwd(), file);
    try {
      if (fs.statSync(file).isFile()) files.push(file);
    } catch {
      // Not a file (e.g. "." when started from source): ignore.
    }
  }
  return files;
}

function start() {
  Menu.setApplicationMenu(null); // no Ctrl+R/Ctrl+W/zoom menu shortcuts; the pages handle their keys
  nativeTheme.themeSource = "dark";

  const ses = session.defaultSession;
  ses.protocol.handle("https", serve);
  // http:, ws: and anything else never leave the machine either.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    callback({ cancel: !(url.startsWith("https://") || url.startsWith("blob:") || url.startsWith("data:") || url.startsWith("devtools:") || url.startsWith("chrome")) });
  });
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(["fullscreen", "clipboard-sanitized-write", "clipboard-read"].includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) =>
    ["fullscreen", "clipboard-sanitized-write", "clipboard-read"].includes(permission)
  );

  createWindow();
}

// ------------------------------------------------------------ window

function createWindow() {
  const bounds = restoreBounds();
  win = new BrowserWindow({
    title: "Pagewise",
    icon: ICON,
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 640,
    minHeight: 480,
    show: false,
    backgroundColor: "#000000",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: Boolean(DEBUG_PORT),
      backgroundThrottling: false,
    },
  });
  if (bounds.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());

  const wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (event, url) => {
    if (!url.startsWith(ORIGIN + "/")) {
      event.preventDefault();
      openExternally(url);
    }
  });
  wc.on("will-frame-navigate", (event) => {
    const url = event.url;
    if (!url.startsWith(ORIGIN + "/") && !url.startsWith("about:")) {
      event.preventDefault();
      openExternally(url);
    }
  });
  wc.on("page-title-updated", (event) => event.preventDefault()); // the shell sends the title
  // PDF.js blocks unloading (its "beforeunload") whenever a document has
  // annotations, even saved ones; Electron would then silently refuse to
  // close the window or reload a tab. The shell already asks about unsaved
  // changes itself (as on Windows, where WebView2 ignores beforeunload when
  // the window closes), so unloading always goes ahead.
  wc.on("will-prevent-unload", (event) => event.preventDefault());
  wc.on("context-menu", (_event, params) => showContextMenu(params));

  // Stability: if the page crashes or hangs, offer to bring it back with the
  // same files open instead of leaving a dead window.
  wc.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit" || closeConfirmed) return;
    recoverPage(`The page stopped unexpectedly (${details.reason}).`);
  });
  win.on("unresponsive", async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      title: "Pagewise",
      message: "Pagewise isn't responding.",
      detail: "You can wait for it, or reload it with the same files open (changes that aren't saved are lost).",
      buttons: ["Wait", "Reload"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 1) recoverPage(null);
  });

  win.on("close", (event) => {
    if (!closeConfirmed && shellReady && !wc.isCrashed()) {
      event.preventDefault();
      post({ type: "close-request" });
      return;
    }
    saveBounds();
  });
  win.on("closed", () => {
    win = null;
  });

  wc.loadURL(SHELL_URL);
}

function recoverPage(reason) {
  if (!win) return;
  const open = [...new Set(docs.values())];
  shellReady = false;
  docs.clear();
  waitingToOpen.push(...open);
  if (reason) {
    dialog.showMessageBox(win, {
      type: "error",
      title: "Pagewise",
      message: "Pagewise had a problem and was reloaded.",
      detail: `${reason} Your files were opened again; changes that weren't saved are lost.`,
    });
  }
  win.webContents.loadURL(SHELL_URL);
}

function showContextMenu(params) {
  const { editFlags, isEditable, selectionText, linkURL } = params;
  const items = [];
  if (linkURL && /^(https?|mailto):/i.test(linkURL)) {
    items.push({ label: "Open link", click: () => openExternally(linkURL) }, { type: "separator" });
  }
  if (isEditable) {
    items.push(
      { role: "undo", enabled: editFlags.canUndo },
      { role: "redo", enabled: editFlags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: editFlags.canCut },
      { role: "copy", enabled: editFlags.canCopy },
      { role: "paste", enabled: editFlags.canPaste },
      { type: "separator" },
      { role: "selectAll" }
    );
  } else if (selectionText && selectionText.trim()) {
    items.push({ role: "copy" });
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
}

function boundsFile() {
  return path.join(DATA_DIR, "window.json");
}

function restoreBounds() {
  const fallback = { width: 1280, height: 860, x: undefined, y: undefined, maximized: false };
  try {
    const saved = JSON.parse(fs.readFileSync(boundsFile(), "utf8"));
    const area = screen.getDisplayMatching(saved).workArea;
    const visible =
      saved.x < area.x + area.width && saved.x + saved.width > area.x && saved.y < area.y + area.height && saved.y + saved.height > area.y;
    if (saved.width >= 640 && saved.height >= 480) {
      return {
        width: Math.min(saved.width, area.width),
        height: Math.min(saved.height, area.height),
        x: visible ? saved.x : undefined,
        y: visible ? saved.y : undefined,
        maximized: Boolean(saved.maximized),
      };
    }
  } catch {}
  return fallback;
}

function saveBounds() {
  try {
    const b = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(boundsFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {}
}

function openExternally(url) {
  try {
    const { protocol: scheme } = new URL(url);
    if (["http:", "https:", "mailto:"].includes(scheme)) shell.openExternal(url);
  } catch {}
}

// ------------------------------------------------------------ serving files

async function serve(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return text(400, "Bad request");
  }
  try {
    if (url.host === APP_HOST) return await serveAppFile(url, request);
    if (url.host === FILES_HOST) return await serveFiles(url, request);
  } catch (err) {
    return text(500, String(err && err.message ? err.message : err), url.host === FILES_HOST);
  }
  return text(403, "Pagewise doesn't use the network.");
}

function text(status, body, cors = false) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...(cors ? CORS : {}) },
  });
}

async function serveAppFile(url, request) {
  if (request.method !== "GET" && request.method !== "HEAD") return text(405, "Method not allowed");
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = path.resolve(WEB_DIR, relative);
  if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) return text(403, "Forbidden");
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return text(404, "Not found");
  }
  if (!stat.isFile()) return text(404, "Not found");
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  return new Response(request.method === "HEAD" ? null : Readable.toWeb(fs.createReadStream(file)), {
    status: 200,
    headers: { "Content-Type": type, "Content-Length": String(stat.size), "Cache-Control": "no-cache" },
  });
}

async function serveFiles(url, request) {
  // Only the app's own pages may read or write files.
  const origin = request.headers.get("origin");
  if (origin && origin !== ORIGIN) return text(403, "Forbidden");
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS,
        "Access-Control-Allow-Methods": "GET, PUT",
        "Access-Control-Allow-Headers": "Content-Type, Range",
        "Access-Control-Max-Age": "600",
      },
    });
  }
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith("/doc/") && (request.method === "GET" || request.method === "HEAD")) {
    return serveDocument(pathname.slice(5), request);
  }
  if (pathname.startsWith("/save/") && request.method === "PUT") {
    return saveDocument(pathname.slice(6), request);
  }
  return text(404, "Not found", true);
}

// A PDF, whole or in byte ranges ("Range: bytes=a-b"). PDF.js asks for the
// parts it needs first, so big books open quickly.
async function serveDocument(id, request) {
  const file = docs.get(id);
  let stat;
  try {
    stat = file && (await fsp.stat(file));
  } catch {}
  if (!stat || !stat.isFile()) return text(404, "This file is no longer available.", true);
  const length = stat.size;
  const headers = {
    ...CORS,
    "Content-Type": "application/pdf",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  const range = parseRange(request.headers.get("range"), length);
  if (range) {
    const [start, end] = range;
    const body = request.method === "HEAD" ? null : Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(body, {
      status: 206,
      headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${length}` },
    });
  }
  const body = request.method === "HEAD" || length === 0 ? null : Readable.toWeb(fs.createReadStream(file));
  return new Response(body, { status: 200, headers: { ...headers, "Content-Length": String(length) } });
}

function parseRange(header, length) {
  if (!header || !header.startsWith("bytes=") || header.includes(",") || length === 0) return null;
  const [a, b] = header.slice(6).split("-");
  let start;
  let end;
  if (a === "") {
    const suffix = Number(b);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, length - suffix);
    end = length - 1;
  } else {
    start = Number(a);
    end = b === "" || b === undefined ? length - 1 : Number(b);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  }
  end = Math.min(end, length - 1);
  return start >= 0 && start <= end ? [start, end] : null;
}

// Writes to a temporary file next to the PDF, then renames it over the PDF
// (atomic on Linux), so a failed save never leaves a half-written file.
async function saveDocument(id, request) {
  const file = docs.get(id);
  if (!file) return text(404, "This file is no longer open.", true);
  const name = path.basename(file);
  let target = file;
  let mode = null;
  try {
    target = await fsp.realpath(file); // save through symlinks, not over them
    mode = (await fsp.stat(target)).mode & 0o7777;
  } catch {} // a new file (Save as)
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.pagewise-saving-${process.pid}`);
  try {
    const bytes = Buffer.from(await request.arrayBuffer());
    if (bytes.length < 5 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw Object.assign(new Error("the data to save isn't a PDF"), { code: "EBADPDF" });
    }
    const handle = await fsp.open(temp, "w", mode ?? 0o644);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode !== null) await fsp.chmod(temp, mode);
    await fsp.rename(temp, target);
    return text(200, "saved", true);
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    if (["EACCES", "EPERM", "EROFS"].includes(err.code)) {
      return text(500, `Pagewise isn't allowed to change “${name}” (it may be read-only or in a protected folder). Use Save as to save a copy.`, true);
    }
    if (err.code === "ENOSPC") {
      return text(500, `“${name}” couldn't be saved: the disk is full. Free some space and try again, or use Save as.`, true);
    }
    return text(500, `“${name}” couldn't be saved: ${err.message}. Try again, or use Save as.`, true);
  }
}

// ------------------------------------------------------------ messages from the page

function post(message) {
  if (win && !win.isDestroyed() && !win.webContents.isCrashed()) {
    win.webContents.send("host-message", message);
  }
}

const fromShell = (event) => win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;

ipcMain.on("host-drop", (event, paths) => {
  if (fromShell(event) && Array.isArray(paths)) openFiles(paths.filter((p) => typeof p === "string" && p));
});

ipcMain.on("host-post", (event, message) => {
  if (!fromShell(event) || !message || typeof message !== "object") return;
  const get = (key) => (message[key] == null ? "" : String(message[key]));
  const getInt = (key) => Number.parseInt(message[key], 10) || 0;
  switch (message.type) {
    case "ready":
      shellReady = true;
      post({ type: "version", version: VERSION });
      if (waitingToOpen.length) openFiles(waitingToOpen.splice(0));
      break;
    case "open-dialog":
      showOpenDialog();
      break;
    case "open-path":
      openFiles([get("path")]);
      break;
    case "get-recent":
      sendRecent();
      break;
    case "recent-progress":
      recent.updateProgress(get("path"), getInt("page"), getInt("pages"));
      break;
    case "recent-remove":
      recent.remove(get("path"));
      sendRecent();
      break;
    case "reveal":
      if (fs.existsSync(get("path"))) shell.showItemInFolder(get("path"));
      break;
    case "save-as-dialog":
      showSaveAsDialog(getInt("reqId"), get("id"), get("name"));
      break;
    case "closed":
      docs.delete(get("id"));
      break;
    case "title":
      win.setTitle(get("text") || "Pagewise");
      break;
    case "theme":
      dark = message.dark === true;
      nativeTheme.themeSource = dark ? "dark" : "light";
      win.setBackgroundColor(dark ? "#000000" : "#f4f4f6");
      break;
    case "associate":
      makeDefaultPdfApp();
      break;
    case "close-ok":
      closeConfirmed = true;
      win.close();
      break;
    case "debug-close":
      // Debug instances only (linux/test/e2e.js): close the window the way
      // its close button does.
      if (DEBUG_PORT) win.close();
      break;
  }
});

// ------------------------------------------------------------ opening

function looksLikePdf(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(1024);
    const n = fs.readSync(fd, head, 0, 1024, 0);
    return head.subarray(0, n).includes("%PDF-");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function register(file) {
  for (const [id, p] of docs) {
    if (p === file) return id;
  }
  const id = crypto.randomBytes(8).toString("hex");
  docs.set(id, file);
  return id;
}

function openFiles(paths) {
  if (!shellReady) {
    waitingToOpen.push(...paths);
    return;
  }
  const opened = [];
  const missing = [];
  for (const raw of paths) {
    if (!raw) continue;
    const file = path.resolve(raw);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {}
    if (!stat || !stat.isFile()) {
      missing.push(path.basename(file));
      continue;
    }
    if (!/\.pdf$/i.test(file) && !looksLikePdf(file)) {
      missing.push(`${path.basename(file)} (not a PDF)`);
      continue;
    }
    const id = register(file);
    recent.touch(file);
    opened.push({ id, path: file, name: path.basename(file) });
  }
  if (opened.length) post({ type: "opened", docs: opened });
  if (missing.length) post({ type: "error", message: `Couldn't open: ${missing.join(", ")}` });
}

async function showOpenDialog() {
  const result = await dialog.showOpenDialog(win, {
    title: "Open PDF",
    filters: [
      { name: "PDF documents", extensions: ["pdf", "PDF"] },
      { name: "All files", extensions: ["*"] },
    ],
    properties: ["openFile", "multiSelections"],
  });
  if (!result.canceled) openFiles(result.filePaths);
}

async function showSaveAsDialog(reqId, id, name) {
  const reply = { reqId, ok: false };
  const current = docs.get(id);
  const base = path.basename(name || "document.pdf").replace(/\.pdf$/i, "");
  const dir = current ? path.dirname(current) : app.getPath("documents");
  const result = await dialog.showSaveDialog(win, {
    title: "Save a copy",
    defaultPath: path.join(dir, `${base} (copy).pdf`),
    filters: [{ name: "PDF documents", extensions: ["pdf"] }],
    properties: ["showOverwriteConfirmation", "createDirectory"],
  });
  if (!result.canceled && result.filePath) {
    let file = result.filePath;
    if (!/\.pdf$/i.test(file)) file += ".pdf";
    const newId = register(file);
    recent.touch(file);
    Object.assign(reply, { ok: true, id: newId, path: file, name: path.basename(file) });
  }
  post(reply);
}

function sendRecent() {
  post({ type: "recent", items: recent.toMessage() });
}

// "Open with": the .deb's pagewise.desktop already lists Pagewise for PDFs.
// This makes it the default PDF app for this user.
async function makeDefaultPdfApp() {
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    title: "Pagewise",
    message: "Open PDF files with Pagewise when you double-click them?",
    detail: "Pagewise becomes your default app for PDF files (for your user only). You can change this later in Settings > Apps > Default apps, or with “Open with” in the Files app.",
    buttons: ["Cancel", "Make default"],
    defaultId: 1,
    cancelId: 0,
  });
  if (response !== 1) return;
  execFile("xdg-mime", ["default", "pagewise.desktop", "application/pdf"], (err) => {
    dialog.showMessageBox(win, {
      type: err ? "error" : "info",
      title: "Pagewise",
      message: err ? "Couldn't make Pagewise the default PDF app." : "Pagewise now opens your PDF files.",
      detail: err ? `${err.message}\n\nIs xdg-utils installed?` : "",
    });
  });
}

// ------------------------------------------------------------ read aloud

// Speech through speech-dispatcher (spd-say), which Ubuntu ships with. One
// part at a time, so Stop is immediate and the reader knows when a page ends.
let speech = { token: 0, child: null };
let warnedNoSpeech = false;

ipcMain.handle("speech-speak", async (event, parts, lang) => {
  if (!fromShell(event) || !Array.isArray(parts)) return false;
  stopSpeaking();
  const token = speech.token;
  const language = typeof lang === "string" && /^[a-z]{2,3}/i.test(lang) ? lang.split(/[-_]/)[0].toLowerCase() : "en";
  for (const part of parts) {
    if (token !== speech.token) return false;
    const textPart = String(part).replace(/\s+/g, " ").trim();
    if (!textPart) continue;
    const ok = await new Promise((resolve) => {
      let child;
      try {
        child = spawn("spd-say", ["--wait", "--language", language, "--", textPart], { stdio: "ignore" });
      } catch (err) {
        resolve(err);
        return;
      }
      speech.child = child;
      child.on("error", (err) => resolve(err));
      child.on("exit", (code) => resolve(code === 0 || token !== speech.token ? true : new Error(`spd-say exited with ${code}`)));
    });
    speech.child = null;
    if (ok !== true) {
      if (!warnedNoSpeech) {
        warnedNoSpeech = true;
        dialog.showMessageBox(win, {
          type: "info",
          title: "Pagewise",
          message: "Read aloud needs speech-dispatcher.",
          detail: `Install it with:\n\nsudo apt install speech-dispatcher espeak-ng\n\n(${ok.message})`,
        });
      }
      return false;
    }
  }
  return token === speech.token;
});

ipcMain.on("speech-cancel", (event) => {
  if (fromShell(event)) stopSpeaking();
});

function stopSpeaking() {
  speech.token++;
  if (speech.child) {
    speech.child.kill();
    speech.child = null;
    // Also drop what speech-dispatcher already queued.
    execFile("spd-say", ["--cancel"], () => {});
  }
}

app.on("before-quit", stopSpeaking);

// ------------------------------------------------------------ recent files

function RecentFiles(file) {
  const MAX = 60;
  let items = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) items = parsed.filter((i) => i && typeof i.path === "string");
  } catch {}

  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(items));
        fs.renameSync(temp, file);
      } catch {}
    }, 200);
  };
  const find = (p) => items.find((i) => i.path === p);

  this.touch = (p) => {
    let item = find(p);
    if (item) items.splice(items.indexOf(item), 1);
    else item = { path: p, page: 1, pages: 0 };
    item.name = path.basename(p);
    item.opened = Date.now();
    items.unshift(item);
    items.length = Math.min(items.length, MAX);
    save();
  };
  this.updateProgress = (p, page, pages) => {
    const item = find(p);
    if (!item || page <= 0) return;
    item.page = page;
    item.pages = pages;
    save();
  };
  this.remove = (p) => {
    const item = find(p);
    if (item) {
      items.splice(items.indexOf(item), 1);
      save();
    }
  };
  this.toMessage = () => items.map((i) => ({ ...i, exists: fs.existsSync(i.path) }));
}
