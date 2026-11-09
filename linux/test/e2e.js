"use strict";

// End-to-end test for Pagewise for Linux. Starts the built app as a debug
// instance (its own data folder, DevTools protocol on a local port), opens a
// PDF and drives it the way a user would.
//
//   node linux/test/e2e.js [path/to/pagewise] [--pdf some.pdf] [--screenshot out.png] [--no-speech]
//
// Needs Node 22+ (built-in fetch and WebSocket) and a display (in CI:
// xvfb-run). Exits non-zero if anything fails.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : null;
};
const SCREENSHOT = opt("--screenshot");
const PDF = opt("--pdf");
const NO_SPEECH = args.includes("--no-speech") && args.splice(args.indexOf("--no-speech"), 1);
const BIN = path.resolve(args[0] || path.join(ROOT, "_build/linux/pagewise/pagewise"));
const PORT = String(9400 + Math.floor(Math.random() * 400));
const SAMPLE = path.join(ROOT, "engine/pdfjs/web/compressed.tracemonkey-pldi-09.pdf");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "pagewise-e2e-"));
const home = path.join(work, "home"); // keeps the debug instance's data out of yours
fs.mkdirSync(home);
const docA = path.join(work, "First document.pdf");
const docB = path.join(work, "Second document.pdf");
let sample = PDF ? path.resolve(PDF) : SAMPLE;
if (!fs.existsSync(sample)) {
  // The engine doesn't always carry PDF.js's sample: write a small valid PDF.
  sample = path.join(work, "sample.pdf");
  fs.writeFileSync(sample, tinyPdf());
}
fs.copyFileSync(sample, docA);
fs.copyFileSync(sample, docB);

const env = { ...process.env, PAGEWISE_DEBUG_PORT: PORT, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
const launchArgs = ["--no-sandbox"]; // tests run the app unpacked, without the .deb's sandbox setup
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  console.log(results.at(-1));
  if (!ok) failures++;
}

// ------------------------------------------------------------ DevTools protocol

let ws;
let nextId = 1;
const pending = new Map();
const exceptions = [];

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.url.includes("/desk/shell.html"));
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.onopen = res;
          ws.onerror = rej;
        });
        ws.onmessage = ({ data }) => {
          const msg = JSON.parse(data);
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          } else if (msg.method === "Runtime.exceptionThrown") {
            const d = msg.params.exceptionDetails;
            exceptions.push(`${d.exception?.description || d.text} @ ${d.url || ""}:${d.lineNumber}`);
          }
        };
        return;
      }
    } catch {}
    await sleep(200);
  }
  throw new Error("The app's DevTools port never came up");
}

function cdp(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    });
  });
}

async function js(expression) {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function until(expression, timeout = 20000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await js(expression);
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(150);
  }
  return last === undefined ? false : last && typeof last === "string" && last.length > 0 && !/^\w*Error/.test(last) ? last : false;
}

const viewer = `document.querySelector("iframe.view.active").contentWindow`;
const scale = () => js(`${viewer}.PDFViewerApplication.pdfViewer.currentScale`);

// ------------------------------------------------------------ the test

async function main() {
  console.log(`Pagewise e2e: ${BIN}`);
  const app = spawn(BIN, [...launchArgs, docA], { env, stdio: ["ignore", "pipe", "pipe"] });
  let appLog = "";
  app.stdout.on("data", (d) => (appLog += d));
  app.stderr.on("data", (d) => (appLog += d));
  let exited = null;
  app.on("exit", (code, signal) => (exited = { code, signal }));

  try {
    await connect();
    await cdp("Runtime.enable");

    check("shell loads", await until(`document.querySelector("#version")?.textContent.startsWith("Pagewise ")`));
    check("PDF from the command line opens in a tab", await until(`PagewiseShell.tabs.size === 1`));
    const pages = await until(`${viewer}.PDFViewerApplication?.pagesCount`);
    check("PDF.js reads the document", pages > 0, `${pages} pages`);
    check(
      "first page is drawn",
      await until(`!!${viewer}.document.querySelector('.page[data-page-number="1"] canvas')`)
    );
    check("window title follows the tab", (await js(`document.title`)) === "First document - Pagewise");

    // --- file serving
    const range = await js(`(async () => {
      const id = [...PagewiseShell.tabs.keys()][0];
      const r = await fetch("https://files.pagewise.example/doc/" + id, { headers: { Range: "bytes=0-7" } });
      return { status: r.status, range: r.headers.get("content-range"), text: await r.text() };
    })()`);
    check("byte-range requests", range.status === 206 && range.text.startsWith("%PDF-") && /^bytes 0-7\/\d+$/.test(range.range), JSON.stringify(range));
    const traversal = await js(`fetch("/../../../../etc/passwd").then(r => r.status)`);
    check("no access outside the app folder", traversal === 404 || traversal === 403, String(traversal));
    const offline = await js(`fetch("https://example.com/").then(r => "status " + r.status, e => "blocked")`);
    check("no network access", offline === "blocked" || offline === "status 403", offline);
    const foreign = await js(`(async () => {
      const id = [...PagewiseShell.tabs.keys()][0];
      return (await fetch("https://files.pagewise.example/doc/nope")).status;
    })()`);
    check("unknown documents are refused", foreign === 404, String(foreign));

    // --- zoom: touchpad pinch, Ctrl+wheel, and the window itself never zooms
    await js(`${viewer}.PDFViewerApplication.pdfViewer.currentScaleValue = "1"`);
    await sleep(300);
    const box = await js(`(() => { const r = document.querySelector("iframe.view.active").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const s0 = await scale();
    await cdp("Input.synthesizePinchGesture", { x: box.x, y: box.y, scaleFactor: 2, relativeSpeed: 400, gestureSourceType: "mouse" });
    await sleep(600);
    const s1 = await scale();
    check("touchpad pinch zooms the pages in", s1 > s0 * 1.3, `${s0.toFixed(2)} -> ${s1.toFixed(2)}`);
    await cdp("Input.synthesizePinchGesture", { x: box.x, y: box.y, scaleFactor: 0.5, relativeSpeed: 400, gestureSourceType: "mouse" });
    await sleep(600);
    const s2 = await scale();
    check("touchpad pinch zooms the pages out", s2 < s1 * 0.8, `${s1.toFixed(2)} -> ${s2.toFixed(2)}`);
    for (let i = 0; i < 3; i++) {
      await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -120, modifiers: 2 });
      await sleep(120);
    }
    await sleep(400);
    const s3 = await scale();
    check("Ctrl+mouse wheel zooms", s3 > s2 * 1.1, `${s2.toFixed(2)} -> ${s3.toFixed(2)}`);
    await cdp("Input.synthesizePinchGesture", { x: box.x, y: 20, scaleFactor: 2, relativeSpeed: 400, gestureSourceType: "mouse" });
    await sleep(500);
    const shellZoom = await js(`visualViewport.scale`);
    check("pinching the tab strip doesn't zoom the window", shellZoom === 1, `visualViewport.scale = ${shellZoom}`);
    const zoomLevel = await js(`window.devicePixelRatio`);
    check("the window's own zoom is unchanged", Math.abs((await scale()) - s3) < 0.01 && zoomLevel > 0);

    // --- annotate: a text box typed on page 1 (marks the tab unsaved)
    await js(`(() => { const a = ${viewer}.PDFViewerApplication; a.pdfViewer.currentScaleValue = "page-width"; a.page = 1; })()`);
    await sleep(500);
    await js(`${viewer}.PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", { source: null, mode: 3 })`);
    await sleep(400);
    const spot = await js(`(() => {
      const f = document.querySelector("iframe.view.active").getBoundingClientRect();
      const p = ${viewer}.document.querySelector('.page[data-page-number="1"]').getBoundingClientRect();
      return { x: f.x + p.x + p.width * 0.3, y: f.y + Math.max(p.y, 0) + 120 };
    })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp("Input.dispatchMouseEvent", { type, x: spot.x, y: spot.y, button: "left", clickCount: 1 });
    }
    await sleep(400);
    await cdp("Input.insertText", { text: "Hello from Pagewise for Linux" });
    await sleep(200);
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(300);
    await js(`${viewer}.PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", { source: null, mode: 0 })`);
    check("a text annotation marks the tab unsaved", await until(`[...PagewiseShell.tabs.values()][0].dirty === true`, 5000));

    // --- saving into the file
    const before = fs.statSync(docA).mtimeMs;
    await sleep(50);
    const saved = await js(`${viewer}.PagewiseDoc.save()`);
    const bytes = fs.readFileSync(docA);
    check("Ctrl+S saves into the file", saved === true && fs.statSync(docA).mtimeMs > before && bytes.subarray(0, 5).toString() === "%PDF-", `saved=${saved}, ${bytes.length} bytes`);
    check("the annotation is written into the PDF", bytes.includes("/FreeText") && bytes.includes("Hello from Pagewise for Linux"));
    check("…and the tab is marked saved", await until(`[...PagewiseShell.tabs.values()][0].dirty === false`, 5000));
    check("no temporary files are left behind", fs.readdirSync(work).every((f) => !f.includes("pagewise-saving")));
    const reload = await until(`${viewer}.PDFViewerApplication?.pagesCount === ${pages}`);
    check("the saved file still opens", Boolean(reload));

    // --- read aloud (speech-dispatcher)
    if (!NO_SPEECH) {
      const spoke = await js(`new Promise((resolve) => {
        const t = setTimeout(() => resolve("timeout"), 20000);
        Pagewise.speech.speak(["Pagewise test."], () => { clearTimeout(t); resolve(true); });
      })`);
      check("read aloud speaks through speech-dispatcher", spoke === true, String(spoke));
      const stopped = await js(`new Promise((resolve) => {
        let done = false;
        Pagewise.speech.speak(["This sentence is long and gets interrupted right away by the stop button."], () => (done = true));
        setTimeout(() => { Pagewise.speech.cancel(); setTimeout(() => resolve(!done), 800); }, 300);
      })`);
      check("Stop interrupts read aloud", stopped === true);
    }

    // --- a second launch adds a tab to this window
    const second = spawn(BIN, [...launchArgs, docB], { env, stdio: "ignore" });
    const secondExit = await new Promise((r) => {
      second.on("exit", (code) => r(code));
      setTimeout(() => r("still running"), 15000);
    });
    check("second launch hands its file over and exits", secondExit === 0, `exit ${secondExit}`);
    check("…and the file opens as a new tab", await until(`PagewiseShell.tabs.size === 2`));
    const recentFile = path.join(home, ".config", "Pagewise-debug", "recent.json");
    await sleep(500);
    const recent = fs.existsSync(recentFile) ? JSON.parse(fs.readFileSync(recentFile, "utf8")) : [];
    check("recent files are remembered", recent.length >= 2 && recent[0].path === docB, `${recent.length} items`);

    // --- Home tab
    await js(`PagewiseShell.selectTab("home")`);
    check("Home lists the recent files", await until(`document.querySelectorAll("#recentGrid .card").length >= 2`));
    check("Home shows the Linux 'default app' button", (await js(`document.querySelector("#associateButton").textContent`)).includes("default app"));

    if (SCREENSHOT) {
      await js(`PagewiseShell.selectTab([...PagewiseShell.tabs.keys()][0])`);
      await js(`${viewer}.PDFViewerApplication.pdfViewer.currentScaleValue = "page-width"`);
      await sleep(1500);
      const shot = await cdp("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(SCREENSHOT, Buffer.from(shot.data, "base64"));
      console.log(`Screenshot: ${SCREENSHOT}`);
    }

    // --- closing with unsaved changes asks first
    await js(`(() => { const id = [...PagewiseShell.tabs.keys()][1]; Pagewise.update(id, { dirty: true }); })()`);
    await js(`pagewiseHost.postMessage({ type: "debug-close" })`); // like the window's close button
    check("closing with unsaved changes asks first", await until(`!document.querySelector("#dialogScrim").hidden`, 5000));
    check("…and the window is still open", exited === null);
    await js(`[...document.querySelectorAll("#dialogButtons button")].find(b => b.textContent === "Don't save").click()`).catch(() => {});
    const end = Date.now() + 10000;
    while (exited === null && Date.now() < end) await sleep(100);
    let after = "";
    if (exited === null) {
      after = await js(`JSON.stringify({ dialog: !document.querySelector("#dialogScrim").hidden && document.querySelector("#dialogText").textContent, tabs: [...PagewiseShell.tabs.values()].map(t => [t.name, t.dirty]) })`).catch((e) => e.message);
    }
    check("Don't save closes the app cleanly", exited !== null && exited.code === 0, JSON.stringify(exited) + " " + after);
    check("no script errors in the pages", exceptions.length === 0, exceptions.slice(0, 5).join(" | "));
  } catch (err) {
    check("test ran to the end", false, err.stack);
  } finally {
    try {
      ws?.close();
    } catch {}
    if (exited === null) app.kill("SIGKILL");
    if (failures) console.log(`\n--- app output ---\n${appLog.slice(-4000)}`);
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log(`\n${results.length - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

// A one-page PDF with a line of text (only if PDF.js's sample is missing).
function tinyPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 24 Tf 72 700 Td (Pagewise test page) Tj ET";
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

main();
