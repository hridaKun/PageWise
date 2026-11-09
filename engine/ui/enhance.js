"use strict";

// Dark PDF Reader: additions on top of the stock PDF.js viewer.
// Loaded as a classic script before viewer.mjs, so it can configure the
// viewer (via the "webviewerloaded" event) before it starts.

(() => {
  const SidebarView = { NONE: 0, THUMBS: 1, OUTLINE: 2 };

  // Optional hooks from the host app (ui/platform.js). The Edge extension
  // leaves this empty; the Android app uses it for native speech, saving,
  // printing and the back gesture.
  //   speech: { speak(parts, onDone), cancel() }
  //   emptyHint: string
  //   onDarkChange(dark)
  //   onReady(app, api)
  const platform = window.DPR_PLATFORM || {};

  // ---------- Small helpers ----------

  const store = {
    get(key, fallback) {
      try {
        const value = localStorage.getItem(`dpr.${key}`);
        return value === null ? fallback : JSON.parse(value);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`dpr.${key}`, JSON.stringify(value));
      } catch {}
    },
  };

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") {
        node.className = value;
      } else if (key === "text") {
        node.textContent = value;
      } else if (key.startsWith("on")) {
        node.addEventListener(key.slice(2), value);
      } else {
        node.setAttribute(key, value);
      }
    }
    node.append(...children);
    return node;
  }

  function isTyping(target) {
    return (
      target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
    );
  }

  // ---------- Which PDF to open ----------
  // "#src=<raw url>" comes from the redirect rule, "?src=<encoded url>" from
  // local files. Rewrite the hash form so reloading works and PDF.js does not
  // mistake it for a named destination.

  let source = null;
  if (location.hash.startsWith("#src=")) {
    source = location.hash.slice("#src=".length);
    history.replaceState(null, "", `${location.pathname}?src=${encodeURIComponent(source)}`);
  } else {
    source = new URLSearchParams(location.search).get("src");
  }

  function fileNameFromUrl(url) {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;
      let name =
        parsed.searchParams.get("name") || decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)) || "document";
      if (!/\.pdf$/i.test(name)) {
        name += ".pdf";
      }
      return name;
    } catch {
      return "document.pdf";
    }
  }

  // Reads the whole file. Local files need XHR (fetch can't read file://).
  function readBytes(url, onProgress) {
    if (url.startsWith("file:")) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url);
        xhr.responseType = "arraybuffer";
        xhr.onprogress = (e) => e.lengthComputable && onProgress((100 * e.loaded) / e.total);
        xhr.onload = () =>
          xhr.response?.byteLength ? resolve(new Uint8Array(xhr.response)) : reject(new Error("empty"));
        xhr.onerror = () => reject(new Error("file-access"));
        xhr.send();
      });
    }
    return (async () => {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        throw new Error(`The server answered ${response.status} ${response.statusText}`.trim());
      }
      const total = Number(response.headers.get("content-length")) || 0;
      if (!total || !response.body) {
        return new Uint8Array(await response.arrayBuffer());
      }
      const reader = response.body.getReader();
      const parts = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parts.push(value);
        loaded += value.length;
        onProgress((100 * loaded) / total);
      }
      const bytes = new Uint8Array(loaded);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      return bytes;
    })();
  }

  // ---------- Dark mode (applied immediately to avoid a white flash) ----------

  const root = document.documentElement;
  let dark = store.get("dark", true);

  function applyDark() {
    root.classList.toggle("dpr-dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
    const button = document.getElementById("dprDarkMode");
    if (button) {
      button.classList.toggle("toggled", dark);
      button.setAttribute("aria-pressed", String(dark));
      button.title = dark ? "Light mode (D)" : "Dark mode (D)";
    }
    platform.onDarkChange?.(dark);
  }
  applyDark();

  function toggleDark() {
    dark = !dark;
    store.set("dark", dark);
    applyDark();
  }

  // ---------- Configure PDF.js before it starts ----------

  // PDF.js announces "webviewerloaded" on the parent page when it runs inside
  // a same-origin frame (the desktop app's tabs), so listen there too and
  // only react to our own frame.
  let configured = false;
  const onViewerLoaded = (e) => {
    if (configured || (e.detail?.source && e.detail.source !== window)) {
      return;
    }
    configured = true;
    document.removeEventListener("webviewerloaded", onViewerLoaded);
    try {
      parent.document.removeEventListener("webviewerloaded", onViewerLoaded);
    } catch {}
    configureViewer();
  };
  document.addEventListener("webviewerloaded", onViewerLoaded);
  if (window.parent !== window) {
    try {
      window.parent.document.addEventListener("webviewerloaded", onViewerLoaded);
    } catch {} // cross-origin parent: PDF.js then uses our own document
  }

  function configureViewer() {
    const options = window.PDFViewerApplicationOptions;
    options.set("disablePreferences", true);
    options.set("defaultUrl", "");
    options.set("viewerCssTheme", 0); // we control color-scheme ourselves
    options.set("enableHighlightFloatingButton", true); // "Highlight" pop-up on selected text
    // Strong highlighter inks that stay visible on dark pages (same as notes.js).
    options.set("highlightEditorColors", "yellow=#FFD400,green=#3DDC84,blue=#4FC3F7,pink=#FF8AC8,red=#FF5C5C");
    // Extra PDF.js options from the host app (e.g. the desktop app turns on
    // signatures and page organising).
    for (const [name, value] of Object.entries(platform.viewerOptions || {})) {
      options.set(name, value);
    }
    window.PDFViewerApplication.initializedPromise.then(setup);
  }

  // ---------- Everything that needs the running viewer ----------

  function setup() {
    const app = window.PDFViewerApplication;
    const { eventBus } = app;

    addToolbarButtons(app);
    const emptyState = addEmptyState(app);
    const help = addHelp(app);
    const reader = createReader(app);

    eventBus.on("documentinit", () => {
      emptyState.hidden = true;
      reader.stop();
    });

    addContentsPageLinks(app);

    // Open the contents sidebar the first time a document with contents is opened.
    // After that PDF.js remembers per document whether it was open.
    eventBus.on("outlineloaded", ({ outlineCount }) => {
      const fingerprint = app.pdfDocument?.fingerprints[0];
      if (!fingerprint || !outlineCount) {
        return;
      }
      const seen = store.get("seen", []);
      if (seen.includes(fingerprint)) {
        return;
      }
      store.set("seen", [fingerprint, ...seen].slice(0, 500));
      app.viewsManager.switchView(SidebarView.OUTLINE, true);
    });

    function toggleContents() {
      const views = app.viewsManager;
      const wanted = views.outlineButton.disabled ? SidebarView.THUMBS : SidebarView.OUTLINE;
      if (views.isOpen && views.active === wanted) {
        views.close();
      } else {
        views.switchView(wanted, true);
      }
    }

    // ----- Keyboard shortcuts (capture phase so they win over PDF.js defaults) -----
    let lastG = 0;
    window.addEventListener(
      "keydown",
      (e) => {
        if (help.isOpen && e.key === "Escape") {
          help.close();
        } else if (isTyping(e.target)) {
          return;
        } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === "KeyU") {
          reader.toggle();
        } else if (e.ctrlKey || e.altKey || e.metaKey) {
          return;
        } else if (e.key === "F8" || e.key === "d") {
          toggleDark();
        } else if (e.key === "?") {
          help.toggle();
        } else if (!app.pdfDocument) {
          return;
        } else if (e.key === "t" && !root.classList.contains("dpr-notes")) {
          toggleContents(); // in notes mode "t" picks the Text tool (notes.js)
        } else if (e.key === "g") {
          if (Date.now() - lastG < 600) {
            app.page = 1;
            lastG = 0;
          } else {
            lastG = Date.now();
          }
        } else if (e.key === "G") {
          app.page = app.pagesCount;
        } else if (e.key === "/") {
          app.findBar.open();
        } else if (e.key === "Backspace") {
          e.shiftKey ? app.pdfHistory?.forward() : app.pdfHistory?.back();
        } else {
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true
    );

    if (source) {
      openSource(app, source, emptyState);
    }

    // Buttons call these.
    setup.toggleDark = toggleDark;
    setup.toggleReader = () => reader.toggle();
    setup.toggleHelp = () => help.toggle();

    const api = {
      isDark: () => dark,
      toggleDark,
      help,
      reader,
      store,
      el,
      isTyping,
      source,
      // The PDF's bytes, including any highlights, drawings or form input.
      getBytes: async () =>
        app.pdfDocument.annotationStorage.size > 0 ? app.pdfDocument.saveDocument() : app.pdfDocument.getData(),
      fileName: () => app._docFilename,
    };
    platform.onReady?.(app, api);
    // Other modules (ui/notes.js) start from here.
    window.dispatchEvent(new CustomEvent("dpr:ready", { detail: { app, api } }));
  }

  async function openSource(app, url, emptyState) {
    emptyState.hidden = true;
    try {
      if (platform.streamDocuments) {
        // The host serves byte ranges: PDF.js reads only what the visible
        // pages need first and streams the rest (fast for big books).
        await app.open({ url, originalUrl: fileNameFromUrl(url) });
      } else {
        const data = await readBytes(url, (percent) => app.progress(percent));
        await app.open({ data, filename: fileNameFromUrl(url) });
      }
    } catch (err) {
      const fileAccess = url.startsWith("file:");
      emptyState.show(
        "Couldn't open this PDF",
        fileAccess
          ? 'Turn on "Allow access to file URLs" for Dark PDF Reader in edge://extensions, then reload this tab.'
          : `${err.message || err}. You can still open a copy ${platform.openHint || "with Ctrl+O"}.`
      );
    }
  }

  // ---------- Clickable printed contents pages ----------
  // Many books have a printed "Contents" page without real links. On pages
  // where most lines end in a page number, make each of those lines a link
  // to that page (like Sioyek does).

  function addContentsPageLinks(app) {
    const MIN_LINES = 4; // a page needs this many numbered lines...
    const MIN_SHARE = 0.3; // ...making up this share of its lines
    const linksByPage = new Map(); // pageNumber -> Promise<links[]>
    let labelToPage = null;

    app.eventBus.on("documentinit", () => {
      linksByPage.clear();
      labelToPage = null;
    });

    // "B-45", "B 45" and "B45" are treated as the same label.
    const normalize = (label) => label.toLowerCase().replace(/[\s-]/g, "");

    async function pageForLabel(label) {
      if (!labelToPage) {
        labelToPage = (async () => {
          const map = new Map();
          const labels = await app.pdfDocument.getPageLabels();
          for (let i = 0; i < app.pagesCount; i++) {
            const key = normalize(labels?.[i] ?? String(i + 1));
            if (!map.has(key)) {
              map.set(key, i + 1);
            }
          }
          return map;
        })();
      }
      return (await labelToPage).get(normalize(label)) ?? null;
    }

    // Groups text items into lines, top to bottom.
    function toLines(items) {
      const lines = [];
      for (const item of items) {
        if (!item.str?.trim()) {
          continue;
        }
        const [, , , , x, y] = item.transform;
        const h = item.height || Math.abs(item.transform[3]) || 10;
        let line = lines.find((l) => Math.abs(l.y - y) < Math.max(l.h, h) * 0.5);
        if (!line) {
          line = { y, h, items: [] };
          lines.push(line);
        }
        line.items.push({ x, y, w: item.width, h, str: item.str });
        line.h = Math.max(line.h, h);
      }
      for (const line of lines) {
        line.items.sort((a, b) => a.x - b.x);
        line.text = line.items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
        line.x1 = Math.min(...line.items.map((i) => i.x));
        line.x2 = Math.max(...line.items.map((i) => i.x + i.w));
        line.y1 = Math.min(...line.items.map((i) => i.y));
        line.y2 = Math.max(...line.items.map((i) => i.y + i.h));
      }
      return lines.sort((a, b) => b.y - a.y);
    }

    async function findLinks(pageView) {
      const pdfPage = pageView.pdfPage;
      const { items } = await pdfPage.getTextContent();
      const lines = toLines(items);
      // Decide from the layout whether this is a contents page...
      for (const line of lines) {
        const last = line.text.split(" ").pop().replace(/^[.·…]+/, "");
        if (/^([0-9]{1,4}|[ivxlcdm]{1,7}|[A-Z]{1,2}-?[0-9]{1,4})$/i.test(last)) {
          line.pageRef = last;
        }
      }
      const numbered = lines.filter((l) => l.pageRef).length;
      if (numbered < MIN_LINES || numbered < lines.length * MIN_SHARE) {
        return [];
      }
      // ...then link the entries whose page exists in this PDF. Contents
      // entries point forward in the book.
      for (const line of lines) {
        const target = line.pageRef && (await pageForLabel(line.pageRef));
        if (target && target > pageView.id) {
          line.target = target;
        }
      }
      // An entry wrapped over two lines: the first line links to the same page.
      for (let i = lines.length - 2; i >= 0; i--) {
        if (!lines[i].pageRef && lines[i + 1].target && lines[i].y - lines[i + 1].y < lines[i].h * 2) {
          lines[i].target = lines[i + 1].target;
        }
      }
      return lines.filter((l) => l.target);
    }

    async function decorate({ source: pageView }) {
      // "pagerendered" also fires for zoomed-in detail views, which have no page div.
      const { div, pdfPage, viewport } = pageView;
      if (!div || !pdfPage || !viewport || viewport.rotation % 360 !== 0 || div.querySelector(":scope > .dprLinkLayer")) {
        return;
      }
      // Contents pages are near the start of a book; checking every page you
      // scroll past would cost a text extraction each time.
      if (pageView.id > Math.max(40, Math.round(app.pagesCount * 0.1))) {
        return;
      }
      if (!linksByPage.has(pageView.id)) {
        linksByPage.set(pageView.id, findLinks(pageView).catch(() => []));
      }
      const links = await linksByPage.get(pageView.id);
      if (!links.length || div.querySelector(":scope > .dprLinkLayer")) {
        return;
      }
      const [vx1, vy1, vx2, vy2] = pdfPage.view;
      const w = vx2 - vx1;
      const h = vy2 - vy1;
      const layer = el("div", { class: "dprLinkLayer" });
      addTapHandling(layer, (link) => app.pdfLinkService.goToPage(Number(link.dataset.target)));
      for (const line of links) {
        const pad = line.h * 0.2;
        const link = el("a", {
          href: "#",
          class: "dprLink",
          "data-target": String(line.target),
          title: `Go to page ${app.pdfViewer.getPageView(line.target - 1)?.pageLabel ?? line.target}`,
        });
        link.style.left = `${((line.x1 - vx1 - pad) / w) * 100}%`;
        link.style.width = `${((line.x2 - line.x1 + 2 * pad) / w) * 100}%`;
        link.style.top = `${((vy2 - line.y2 - pad) / h) * 100}%`;
        link.style.height = `${((line.y2 - line.y1 + 2 * pad) / h) * 100}%`;
        layer.append(link);
      }
      div.append(layer);
    }

    // Zooming clears extra layers from a page, so re-add after each render.
    app.eventBus.on("textlayerrendered", decorate);
    app.eventBus.on("pagerendered", decorate);
  }

  // Calls go(link) when a .dprLink inside `layer` is clicked or tapped.
  // Taps are detected from touch events directly: PDF.js cancels every
  // single-finger pointerdown on the window (for its pinch-zoom handling),
  // which can stop touchscreens from turning a tap into a click.
  function addTapHandling(layer, go) {
    const MAX_MOVE = 10; // px; more than this is a scroll, not a tap
    const MAX_TIME = 600; // ms; longer is a long-press (text selection)
    let tap = null;
    let lastTouchTap = 0;

    layer.addEventListener("click", (e) => {
      const link = e.target.closest(".dprLink");
      if (!link) {
        return;
      }
      e.preventDefault();
      // A tap already handled below may still produce a click.
      if (Date.now() - lastTouchTap > 800) {
        go(link);
      }
    });

    layer.addEventListener(
      "touchstart",
      (e) => {
        const link = e.touches.length === 1 && e.target.closest(".dprLink");
        tap = link ? { link, x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() } : null;
      },
      { passive: true }
    );
    layer.addEventListener(
      "touchmove",
      (e) => {
        const touch = e.touches[0];
        if (tap && (e.touches.length > 1 || Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y) > MAX_MOVE)) {
          tap = null;
        }
      },
      { passive: true }
    );
    layer.addEventListener("touchend", (e) => {
      if (tap && e.touches.length === 0 && Date.now() - tap.time < MAX_TIME) {
        e.preventDefault(); // no extra click / text selection
        lastTouchTap = Date.now();
        go(tap.link);
      }
      tap = null;
    });
    layer.addEventListener("touchcancel", () => {
      tap = null;
    });
  }

  // ---------- Toolbar ----------

  function toolbarButton(id, label, onclick) {
    return el("button", {
      id,
      class: "toolbarButton",
      type: "button",
      title: label,
      "aria-label": label,
      tabindex: "0",
      onclick,
    });
  }

  function addToolbarButtons(app) {
    const right = document.getElementById("toolbarViewerRight");
    right.prepend(
      toolbarButton("dprReadAloud", "Read aloud (Ctrl+Shift+U)", () => setup.toggleReader()),
      toolbarButton("dprDarkMode", "Dark mode (D)", () => setup.toggleDark()),
      el("div", { class: "verticalToolbarSeparator" })
    );
    applyDark();

    const menu = document.getElementById("secondaryToolbarButtonContainer");
    menu.append(
      el("div", { class: "horizontalToolbarSeparator" }),
      el(
        "button",
        {
          id: "dprShortcuts",
          class: "toolbarButton labeled",
          type: "button",
          tabindex: "0",
          onclick: () => {
            app.secondaryToolbar?.close();
            setup.toggleHelp();
          },
        },
        [el("span", { text: "Keyboard shortcuts" })]
      )
    );
  }

  // ---------- Empty state (no PDF yet, or an error) ----------

  function addEmptyState(app) {
    const title = el("h1", { text: "Open a PDF" });
    const message = el("p", { text: platform.emptyHint || "Drop a file anywhere on this page, or press Ctrl+O." });
    const button = el("button", {
      class: "dprPrimary",
      type: "button",
      text: "Choose file",
      onclick: () => app.eventBus.dispatch("openfile", { source: window }),
    });
    const box = el("div", { id: "dprEmpty" }, [
      el("div", { class: "dprEmptyIcon" }),
      title,
      message,
      button,
    ]);
    document.getElementById("viewerContainer").append(box);
    box.show = (heading, text) => {
      title.textContent = heading;
      message.textContent = text;
      box.hidden = false;
    };
    return box;
  }

  // ---------- Keyboard shortcuts panel ----------

  // Keys are separated by two spaces; "or" and "|" (shown as "/") are separators.
  const SHORTCUTS = [
    ["Navigate", [
      ["t", "Contents sidebar"],
      ["g g  |  G", "First / last page"],
      ["j  k  or  n  p", "Next / previous page"],
      ["Space  |  Shift Space", "Down / up one screen"],
      ["Backspace  |  Shift Backspace", "Back / forward after a jump"],
      ["Ctrl F  or  /", "Find"],
      ["Enter  |  Shift Enter", "Next / previous match"],
    ]],
    ["View", [
      ["d  or  F8", "Dark mode"],
      ["Ctrl +  |  Ctrl −", "Zoom in / out"],
      ["Ctrl 0", "Reset zoom"],
      ["r  |  Shift R", "Rotate"],
      ["Ctrl Alt P", "Presentation mode"],
    ]],
    ["Notes", [
      ["n", "Notes toolbar on / off"],
      ["p  |  h  |  e", "Pen / highlighter / eraser"],
      ["t  |  s", "Text box / select (while notes are on)"],
      ["Pen side button", "Erase while held"],
      ["Ctrl Z  |  Ctrl Y", "Undo / redo"],
    ]],
    ["Tools", [
      ["Ctrl Shift U", "Read aloud"],
      ["s  |  h", "Select text / hand tool"],
      ["Ctrl O", "Open a file"],
      ["Ctrl S", "Save (with your highlights and drawings)"],
      ["Ctrl P", "Print"],
      ["?", "This panel"],
    ]],
  ];

  function addHelp() {
    const sections = SHORTCUTS.map(([heading, rows]) =>
      el("section", {}, [
        el("h2", { text: heading }),
        el(
          "dl",
          {},
          rows.flatMap(([keys, action]) => [
            el("dt", {}, keys.split(/ {2}/).map((k) =>
              k === "or" || k === "|" ? el("span", { text: k === "|" ? " / " : " or " }) : el("kbd", { text: k })
            )),
            el("dd", { text: action }),
          ])
        ),
      ])
    );
    const panel = el("div", { id: "dprHelp", hidden: "", role: "dialog", "aria-label": "Keyboard shortcuts" }, [
      el("div", { class: "dprHelpCard" }, [
        el("header", {}, [
          el("h1", { text: "Keyboard shortcuts" }),
          el("button", { class: "dprClose", type: "button", "aria-label": "Close", onclick: () => help.close() }),
        ]),
        el("div", { class: "dprHelpBody" }, sections),
      ]),
    ]);
    panel.addEventListener("click", (e) => e.target === panel && help.close());
    document.body.append(panel);

    const help = {
      get isOpen() {
        return !panel.hidden;
      },
      open() {
        panel.hidden = false;
      },
      close() {
        panel.hidden = true;
      },
      toggle() {
        panel.hidden = !panel.hidden;
      },
    };
    return help;
  }

  // ---------- Read aloud ----------

  // Browser speech (Edge's voices). Hosts without it pass platform.speech.
  function createWebSpeech() {
    if (!("speechSynthesis" in window)) {
      return null;
    }
    function pickVoice() {
      const voices = speechSynthesis.getVoices();
      const lang = navigator.language || "en";
      const base = lang.split("-")[0].toLowerCase();
      const sameLang = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
      return (
        sameLang.find((v) => /natural/i.test(v.name) && v.lang.toLowerCase() === lang.toLowerCase()) ||
        sameLang.find((v) => /natural/i.test(v.name)) ||
        sameLang.find((v) => v.default) ||
        sameLang[0] ||
        null
      );
    }
    // Voices load asynchronously the first time.
    speechSynthesis.getVoices();
    return {
      speak(parts, onDone) {
        const voice = pickVoice();
        parts.forEach((part, i) => {
          const utterance = new SpeechSynthesisUtterance(part);
          if (voice) {
            utterance.voice = voice;
            utterance.lang = voice.lang;
          }
          if (i === parts.length - 1) {
            utterance.onend = onDone;
          }
          speechSynthesis.speak(utterance);
        });
      },
      cancel() {
        speechSynthesis.cancel();
      },
    };
  }

  function createReader(app) {
    const speech = platform.speech || createWebSpeech();
    let active = false;
    let pageNumber = 0;
    let token = 0;

    if (!speech) {
      document.getElementById("dprReadAloud")?.remove();
    }

    function setButton() {
      const button = document.getElementById("dprReadAloud");
      button?.classList.toggle("toggled", active);
      button?.setAttribute("aria-pressed", String(active));
    }

    // Short chunks: long utterances can stall in Chromium.
    function chunk(text) {
      const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
      const chunks = [];
      let current = "";
      for (const sentence of sentences) {
        if ((current + sentence).length > 220 && current) {
          chunks.push(current);
          current = "";
        }
        current += sentence;
      }
      if (current.trim()) {
        chunks.push(current);
      }
      return chunks;
    }

    async function readPage(myToken) {
      if (!active || myToken !== token) {
        return;
      }
      if (pageNumber > app.pagesCount) {
        stop();
        return;
      }
      const page = await app.pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent();
      if (!active || myToken !== token) {
        return;
      }
      const text = content.items
        .map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : ""))
        .join("")
        .replace(/-\n(?=\p{Ll})/gu, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) {
        pageNumber++;
        readPage(myToken);
        return;
      }
      if (app.page !== pageNumber) {
        app.page = pageNumber;
      }
      speech.speak(chunk(text), () => {
        if (active && myToken === token) {
          pageNumber++;
          readPage(myToken);
        }
      });
    }

    function start() {
      if (!app.pdfDocument || !speech) {
        return;
      }
      active = true;
      pageNumber = app.page;
      token++;
      speech.cancel();
      setButton();
      readPage(token);
    }

    function stop() {
      active = false;
      token++;
      speech?.cancel();
      setButton();
    }

    window.addEventListener("pagehide", stop);

    return {
      start,
      stop,
      toggle: () => (active ? stop() : start()),
    };
  }
})();
