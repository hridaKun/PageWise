"use strict";

// Pagewise for Windows: the window shell. Each open PDF is a tab holding an
// <iframe> with the shared reader (pdfjs/web/viewer.html); this page manages
// the tabs, the Home tab and talks to the Windows host (MainForm.cs) through
// window.chrome.webview. Reader tabs call window.Pagewise.* (see desk/platform.js).

(() => {
  const host = window.chrome?.webview;
  // PDFs are read and saved through this address (handled by MainForm.cs).
  const FILES = "https://files.pagewise.example";
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;

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

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  const icon = (name) => el("span", `mIcon mIcon-${name}`);

  // ------------------------------------------------------------ host link

  let nextRequest = 1;
  const pending = new Map();

  function send(message) {
    host?.postMessage(message);
  }

  function request(message) {
    const reqId = nextRequest++;
    return new Promise((resolve) => {
      pending.set(reqId, resolve);
      send({ ...message, reqId });
    });
  }

  host?.addEventListener("message", ({ data }) => {
    if (data.reqId && pending.has(data.reqId)) {
      pending.get(data.reqId)(data);
      pending.delete(data.reqId);
      return;
    }
    switch (data.type) {
      case "opened":
        data.docs.forEach((doc, i) => openTab(doc, i === data.docs.length - 1));
        loadRecent();
        break;
      case "recent":
        renderRecent(data.items);
        break;
      case "close-request":
        confirmCloseAll();
        break;
      case "error":
        showDialog("Something went wrong", data.message, [{ label: "OK", primary: true }]);
        break;
      case "version":
        $("version").textContent = `Pagewise ${data.version}`;
        break;
    }
  });

  // ------------------------------------------------------------ theme

  const isDark = () => store.get("dark", true);
  function applyTheme() {
    const dark = isDark();
    root.dataset.theme = dark ? "dark" : "light";
    $("themeButton").firstElementChild.className = `mIcon ${dark ? "mIcon-sun" : "mIcon-moon"}`;
    $("themeButton").title = dark ? "Light mode" : "Dark mode";
    send({ type: "theme", dark });
  }
  $("themeButton").addEventListener("click", () => {
    store.set("dark", !isDark());
    applyTheme();
    for (const tab of tabs.values()) {
      tab.frame.contentWindow?.PagewiseDoc?.setDark(isDark());
    }
  });

  // ------------------------------------------------------------ tabs

  const tabs = new Map(); // id -> { id, path, name, frame, tabEl, dirty, ... }
  let active = "home";

  function frameUrl(doc) {
    const src = `${FILES}/doc/${doc.id}?name=${encodeURIComponent(doc.name)}`;
    return `/pdfjs/web/viewer.html?src=${encodeURIComponent(src)}&doc=${doc.id}`;
  }

  function openTab(doc, activate = true) {
    for (const tab of tabs.values()) {
      if (tab.path.toLowerCase() === doc.path.toLowerCase()) {
        if (activate) selectTab(tab.id);
        return;
      }
    }
    const frame = el("iframe", "view");
    frame.title = doc.name;
    frame.src = frameUrl(doc);
    $("views").append(frame);

    const tabEl = el("div", "tab");
    tabEl.setAttribute("role", "tab");
    tabEl.title = doc.path;
    const title = el("span", "tabTitle", doc.name.replace(/\.pdf$/i, ""));
    const state = el("span", "tabState");
    state.title = "Close (Ctrl+W)";
    state.append(icon("close"));
    tabEl.append(icon("book"), title, state);
    tabEl.addEventListener("mousedown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(doc.id);
      }
    });
    tabEl.addEventListener("click", (e) => {
      if (e.target.closest(".tabState")) {
        closeTab(doc.id);
      } else {
        selectTab(doc.id);
      }
    });
    $("docTabs").append(tabEl);

    tabs.set(doc.id, { ...doc, frame, tabEl, titleEl: title, stateEl: state, dirty: false, docTitle: "" });
    if (activate) selectTab(doc.id);
  }

  function selectTab(id) {
    active = id;
    $("homeTab").classList.toggle("active", id === "home");
    $("homeTab").setAttribute("aria-selected", String(id === "home"));
    $("home").classList.toggle("active", id === "home");
    for (const tab of tabs.values()) {
      const on = tab.id === id;
      tab.frame.classList.toggle("active", on);
      tab.tabEl.classList.toggle("active", on);
      tab.tabEl.setAttribute("aria-selected", String(on));
    }
    const tab = tabs.get(id);
    if (tab) {
      tab.tabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
      tab.frame.focus();
    } else {
      loadRecent();
    }
    updateWindowTitle();
  }

  function updateWindowTitle() {
    const tab = tabs.get(active);
    const text = tab ? `${tab.dirty ? "• " : ""}${tab.name.replace(/\.pdf$/i, "")} - Pagewise` : "Pagewise";
    document.title = text;
    send({ type: "title", text });
  }

  async function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return true;
    if (tab.dirty) {
      selectTab(id);
      const choice = await showDialog(
        "Save changes?",
        `“${tab.name}” has changes that aren't saved yet.`,
        [{ label: "Cancel", value: "cancel" }, { label: "Don't save", value: "discard" }, { label: "Save", value: "save", primary: true }]
      );
      if (choice === "cancel" || choice == null) return false;
      if (choice === "save" && !(await tab.frame.contentWindow?.PagewiseDoc?.save())) return false;
    }
    const order = [...tabs.keys()];
    const index = order.indexOf(id);
    tab.frame.remove();
    tab.tabEl.remove();
    tabs.delete(id);
    send({ type: "closed", id });
    if (active === id) {
      const next = order[index + 1] ?? order[index - 1];
      selectTab(next && tabs.has(next) ? next : "home");
    }
    return true;
  }

  async function confirmCloseAll() {
    for (const tab of [...tabs.values()]) {
      if (tab.dirty && !(await closeTab(tab.id))) {
        return; // cancelled
      }
    }
    send({ type: "close-ok" });
  }

  $("homeTab").addEventListener("click", () => selectTab("home"));
  for (const button of [$("newTab"), $("openButton")]) {
    button.addEventListener("click", () => send({ type: "open-dialog" }));
  }

  // ------------------------------------------------------------ keyboard

  function handleKey(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return false;
    const key = e.key.toLowerCase();
    const ids = ["home", ...tabs.keys()];
    if (key === "o" && !e.shiftKey) {
      send({ type: "open-dialog" });
    } else if (key === "w" || key === "f4") {
      if (active !== "home") closeTab(active);
    } else if (key === "tab") {
      const i = ids.indexOf(active);
      selectTab(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length]);
    } else if (key === "h" && !e.shiftKey) {
      selectTab("home");
    } else if (/^[1-9]$/.test(key)) {
      const id = key === "9" ? ids.at(-1) : ids[Number(key) - 1];
      if (id) selectTab(id);
    } else {
      return false;
    }
    e.preventDefault();
    e.stopPropagation();
    return true;
  }
  window.addEventListener("keydown", handleKey, true);

  // ------------------------------------------------------------ pinch zoom

  // Pinch zoom is on in WebView2 so touchpad pinches reach the reader tabs
  // (as Ctrl+wheel; PDF.js zooms the pages). The tab strip and Home tab
  // themselves should never be zoomed by it. Touchscreen pinches on them
  // are stopped by touch-action in shell.css.
  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false }
  );

  // ------------------------------------------------------------ drag & drop

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => {
    if (hasFiles(e)) {
      dragDepth++;
      $("dragOverlay").hidden = false;
    }
  });
  window.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $("dragOverlay").hidden = true;
    }
  });
  window.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    $("dragOverlay").hidden = true;
    openDropped(e.dataTransfer.files);
  });

  // The host needs the real file paths, which it gets from the File objects.
  function openDropped(files) {
    const pdfs = [...files].filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
    if (pdfs.length) {
      host?.postMessageWithAdditionalObjects("drop", pdfs);
    }
  }

  // ------------------------------------------------------------ Home: recent files

  let recentItems = [];

  function loadRecent() {
    send({ type: "get-recent" });
  }

  function relativeTime(time) {
    const minutes = Math.round((Date.now() - time) / 60000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;
    return new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function renderRecent(items) {
    recentItems = items || [];
    const query = $("recentSearch").value.trim().toLowerCase();
    const shown = query ? recentItems.filter((r) => r.name.toLowerCase().includes(query)) : recentItems;
    $("recentSection").hidden = recentItems.length === 0;
    const grid = $("recentGrid");
    grid.replaceChildren();
    for (const item of shown) {
      const card = el("button", `card${item.exists === false ? " missing" : ""}`);
      card.type = "button";
      card.title = item.exists === false ? `Not found: ${item.path}` : item.path;
      const cover = el("div", "cover");
      const initials = el("div", "initials", item.name.replace(/\.pdf$/i, "").slice(0, 2).toUpperCase());
      cover.append(initials);
      thumbFor(item.path).then((url) => {
        if (url) {
          const img = new Image();
          img.alt = "";
          img.src = url;
          cover.append(img);
          initials.remove();
        }
      });
      if (item.pages && item.page > 1) {
        const bar = el("div", "progress");
        const fill = el("span");
        fill.style.width = `${Math.min(100, (100 * item.page) / item.pages)}%`;
        bar.append(fill);
        cover.append(bar);
      }
      const meta = item.pages && item.page > 1 ? `Page ${item.page} of ${item.pages} · ${relativeTime(item.opened)}` : relativeTime(item.opened);
      card.append(cover, el("div", "name", item.name.replace(/\.pdf$/i, "")), el("div", "meta", meta));
      card.addEventListener("click", () => send({ type: "open-path", path: item.path }));
      card.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, [
          { label: "Open", icon: "book", run: () => send({ type: "open-path", path: item.path }) },
          { label: "Show in folder", icon: "list", run: () => send({ type: "reveal", path: item.path }) },
          "-",
          { label: "Remove from Recent", icon: "trash", danger: true, run: () => send({ type: "recent-remove", path: item.path }) },
        ]);
      });
      grid.append(card);
    }
  }
  $("recentSearch").addEventListener("input", () => renderRecent(recentItems));

  // Cover thumbnails, made by the reader tabs (IndexedDB, keyed by file path).
  let thumbDb = null;
  function db() {
    thumbDb ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("pagewise-thumbs", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("thumbs");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return thumbDb;
  }
  async function thumbFor(path) {
    try {
      const database = await db();
      return await new Promise((resolve) => {
        const get = database.transaction("thumbs").objectStore("thumbs").get(path.toLowerCase());
        get.onsuccess = () => resolve(get.result || null);
        get.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }
  async function saveThumb(path, dataUrl) {
    try {
      const database = await db();
      database.transaction("thumbs", "readwrite").objectStore("thumbs").put(dataUrl, path.toLowerCase());
    } catch {}
  }

  $("associateButton").addEventListener("click", () => send({ type: "associate" }));

  // ------------------------------------------------------------ menu & dialog

  function showMenu(x, y, items) {
    const menu = $("menu");
    menu.replaceChildren();
    for (const item of items) {
      if (item === "-") {
        menu.append(el("hr"));
        continue;
      }
      const button = el("button", item.danger ? "danger" : "");
      button.type = "button";
      button.append(icon(item.icon), el("span", "", item.label));
      button.addEventListener("click", () => {
        hideMenu();
        item.run();
      });
      menu.append(button);
    }
    menu.hidden = false;
    $("scrim").hidden = false;
    const { width, height } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - height - 8))}px`;
  }
  function hideMenu() {
    $("menu").hidden = true;
    $("scrim").hidden = true;
  }
  $("scrim").addEventListener("click", hideMenu);

  function showDialog(title, text, buttons) {
    return new Promise((resolve) => {
      $("dialogTitle").textContent = title;
      $("dialogText").textContent = text;
      const box = $("dialogButtons");
      box.replaceChildren();
      const done = (value) => {
        $("dialogScrim").hidden = true;
        window.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          done("cancel");
        }
      };
      window.addEventListener("keydown", onKey, true);
      for (const b of buttons) {
        const button = el("button", b.primary ? "primary" : "", b.label);
        button.type = "button";
        button.addEventListener("click", () => done(b.value ?? b.label));
        box.append(button);
        if (b.primary) setTimeout(() => button.focus());
      }
      $("dialogScrim").hidden = false;
    });
  }

  // ------------------------------------------------------------ API for reader tabs

  window.Pagewise = {
    isDark,
    key: (e) => handleKey(e),
    openDialog: () => send({ type: "open-dialog" }),
    openDropped,
    thumb(id, dataUrl) {
      const tab = tabs.get(id);
      if (tab) saveThumb(tab.path, dataUrl);
    },
    async hasThumb(id) {
      const tab = tabs.get(id);
      return !tab || Boolean(await thumbFor(tab.path));
    },

    // Title, unsaved state and reading position of a tab.
    update(id, info) {
      const tab = tabs.get(id);
      if (!tab) return;
      if ("dirty" in info && info.dirty !== tab.dirty) {
        tab.dirty = info.dirty;
        tab.stateEl.classList.toggle("dirty", tab.dirty);
        tab.stateEl.title = tab.dirty ? "Unsaved changes. Close (Ctrl+W)" : "Close (Ctrl+W)";
      }
      if (info.page && info.pages) {
        send({ type: "recent-progress", path: tab.path, page: info.page, pages: info.pages });
      }
      if (id === active) updateWindowTitle();
    },

    darkChanged(dark) {
      store.set("dark", dark);
      applyTheme();
      for (const tab of tabs.values()) {
        tab.frame.contentWindow?.PagewiseDoc?.setDark(dark);
      }
    },

    // Writes the PDF's bytes to its file (or a new file for "Save as").
    async save(id, bytes) {
      const tab = tabs.get(id);
      if (!tab) return false;
      return writeFile(tab.id, bytes);
    },

    async saveAs(id, bytes) {
      const tab = tabs.get(id);
      if (!tab) return false;
      const result = await request({ type: "save-as-dialog", id, name: tab.name });
      if (!result.ok) return false;
      if (!(await writeFile(result.id, bytes))) return false;
      // The tab now belongs to the new file.
      tabs.delete(id);
      Object.assign(tab, { id: result.id, path: result.path, name: result.name });
      tabs.set(result.id, tab);
      tab.titleEl.textContent = result.name.replace(/\.pdf$/i, "");
      tab.tabEl.title = result.path;
      tab.frame.contentWindow?.PagewiseDoc?.setDocId(result.id);
      if (active === id) active = result.id;
      updateWindowTitle();
      loadRecent();
      return true;
    },
  };

  async function writeFile(id, bytes) {
    try {
      const response = await fetch(`${FILES}/save/${id}`, { method: "PUT", body: bytes });
      if (!response.ok) {
        const message = await response.text();
        await showDialog("Couldn't save", message || "The file couldn't be written.", [{ label: "OK", primary: true }]);
        return false;
      }
      return true;
    } catch (err) {
      await showDialog("Couldn't save", String(err), [{ label: "OK", primary: true }]);
      return false;
    }
  }

  // ------------------------------------------------------------ start

  applyTheme();
  send({ type: "ready" });
  loadRecent();
  window.PagewiseShell = { openTab, selectTab, tabs, renderRecent, showDialog };
})();
