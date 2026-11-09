"use strict";

// Dark PDF Reader: note-taking for pens (S Pen, Surface Pen…), touch and mouse.
//
// Built on PDF.js's own editors, so everything is saved inside the PDF as
// standard annotations:
//   Pen         -> ink drawing (one drawing per stroke, so strokes can be erased)
//   Highlighter -> text highlight (snaps to the text under the pen), or a
//                  free highlight on empty areas
//   Eraser      -> removes the strokes/highlights it touches
//   Text        -> text box
//   Select      -> tap a stroke/text box to move, resize, recolour or delete it
//
// "Pen only" (palm rejection): the pen writes; one finger scrolls, two fingers
// pinch-zoom. Holding the pen's side button erases.
//
// Notes are saved automatically (IndexedDB, keyed by the PDF's fingerprint)
// and come back the next time the same PDF is opened.

(() => {
  // PDF.js constants (pdf.mjs: AnnotationEditorType / AnnotationEditorParamsType).
  const Mode = { NONE: 0, FREETEXT: 3, HIGHLIGHT: 9, INK: 15 };
  const Param = {
    FREETEXT_SIZE: 11,
    FREETEXT_COLOR: 12,
    INK_COLOR: 21,
    INK_THICKNESS: 22,
    INK_OPACITY: 23,
    HIGHLIGHT_COLOR: 31,
    HIGHLIGHT_THICKNESS: 32,
  };

  const PALETTES = {
    pen: ["#000000", "#1E5BD8", "#D93025", "#188038", "#8430CE", "#E37400"],
    // Strong highlighter inks: they stay visible when dark mode inverts the page.
    highlighter: ["#FFD400", "#3DDC84", "#4FC3F7", "#FF8AC8", "#FF9F43", "#FF5C5C"],
    text: ["#000000", "#1E5BD8", "#D93025", "#188038", "#8430CE", "#E37400"],
  };
  const SIZES = {
    pen: [1, 2.5, 5],
    highlighter: [8, 14, 22],
    eraser: [10, 20, 36],
    text: [12, 16, 24],
  };
  const TOOLS = [
    ["pen", "Pen (P)"],
    ["highlighter", "Highlighter (H)"],
    ["eraser", "Eraser (E)"],
    ["text", "Text (T)"],
    ["select", "Select (S)"],
  ];
  const AUTOSAVE_DELAY = 2000; // ms after the last change
  const PALM_GRACE = 600; // ms after the pen lifts during which touches are ignored
  const PALM_SIZE = 40; // px; touches larger than this are treated as a palm

  window.addEventListener("dpr:ready", ({ detail: { app, api } }) => {
    const { el, store } = api;
    const platform = window.DPR_PLATFORM || {};
    // Hosts that save into the file themselves (the desktop app) turn the
    // automatic notes copy off and get told about changes instead.
    const autosaveEnabled = platform.notesAutosave !== false;
    const root = document.documentElement;
    const viewer = document.getElementById("viewerContainer");
    const ui = () => app.pdfViewer._layerProperties?.annotationEditorUIManager;

    const state = {
      open: false,
      tool: store.get("notes.tool", "pen"),
      penOnly: store.get("notes.penOnly", false),
      sawPen: store.get("notes.sawPen", false),
      colors: store.get("notes.colors", {
        pen: PALETTES.pen[0],
        highlighter: PALETTES.highlighter[0],
        text: PALETTES.text[0],
      }),
      sizes: store.get("notes.sizes", { pen: 1, highlighter: 1, eraser: 1, text: 1 }), // index into SIZES
      customColors: store.get("notes.customColors", []),
    };
    const save = () => {
      store.set("notes.tool", state.tool);
      store.set("notes.penOnly", state.penOnly);
      store.set("notes.sawPen", state.sawPen);
      store.set("notes.colors", state.colors);
      store.set("notes.sizes", state.sizes);
      store.set("notes.customColors", state.customColors);
    };

    // ------------------------------------------------------------ PDF.js glue

    function setMode(mode) {
      if (app.pdfViewer.annotationEditorMode !== mode) {
        app.eventBus.dispatch("switchannotationeditormode", { source: window, mode });
      }
    }

    function setParam(type, value) {
      app.eventBus.dispatch("switchannotationeditorparams", { source: window, type, value });
    }

    // Pushes the current tool's colour/size to PDF.js (as defaults for new
    // marks, or to the selected mark if one is selected).
    function applyToolParams() {
      const { tool } = state;
      const size = SIZES[tool]?.[state.sizes[tool]];
      if (tool === "pen") {
        setParam(Param.INK_COLOR, state.colors.pen);
        setParam(Param.INK_OPACITY, 1);
        setParam(Param.INK_THICKNESS, size);
      } else if (tool === "highlighter") {
        setParam(Param.HIGHLIGHT_COLOR, state.colors.highlighter);
        setParam(Param.HIGHLIGHT_THICKNESS, size);
      } else if (tool === "text") {
        setParam(Param.FREETEXT_COLOR, state.colors.text);
        setParam(Param.FREETEXT_SIZE, size);
      }
    }

    function modeForTool(tool) {
      return { pen: Mode.INK, highlighter: Mode.HIGHLIGHT, eraser: Mode.INK, text: Mode.FREETEXT, select: Mode.INK }[
        tool
      ];
    }

    function pageOf(target) {
      const page = target?.closest?.(".page");
      return page ? Number(page.dataset.pageNumber) : null;
    }

    // ------------------------------------------------------------ toolbar UI

    const icon = (name) => el("span", { class: `dprIcon dprIcon-${name}`, "aria-hidden": "true" });

    const toolButtons = TOOLS.map(([tool, label]) =>
      el("button", { class: "dprNoteBtn", type: "button", title: label, "aria-label": label, "data-tool": tool, onclick: () => setTool(tool) }, [
        icon(tool),
      ])
    );
    const swatchBox = el("div", { class: "dprSwatches" });
    const sizeBox = el("div", { class: "dprSizes" });
    const colorInput = el("input", { type: "color", class: "dprColorInput", tabindex: "-1", "aria-hidden": "true" });
    const undoBtn = el("button", { class: "dprNoteBtn", type: "button", title: "Undo (Ctrl+Z)", "aria-label": "Undo", onclick: () => ui()?.undo() }, [icon("undo")]);
    const redoBtn = el("button", { class: "dprNoteBtn", type: "button", title: "Redo (Ctrl+Y)", "aria-label": "Redo", onclick: () => ui()?.redo() }, [icon("redo")]);
    const penOnlyBtn = el("button", { class: "dprNoteBtn", type: "button", onclick: () => setPenOnly(!state.penOnly) }, [icon("hand")]);
    const status = el("span", { class: "dprNoteStatus", "aria-live": "polite" });
    const closeBtn = el("button", { class: "dprNoteBtn", type: "button", title: "Close notes (N)", "aria-label": "Close notes", onclick: () => toggle(false) }, [icon("close")]);

    const bar = el("div", { id: "dprNotesBar", role: "toolbar", "aria-label": "Notes", hidden: "" }, [
      el("div", { class: "dprGroup" }, toolButtons),
      el("div", { class: "dprSep" }),
      swatchBox,
      colorInput,
      el("div", { class: "dprSep" }),
      sizeBox,
      el("div", { class: "dprSep" }),
      el("div", { class: "dprGroup" }, [undoBtn, redoBtn, penOnlyBtn]),
      status,
      closeBtn,
    ]);
    document.getElementById("outerContainer").append(bar);

    function renderBar() {
      for (const button of toolButtons) {
        button.classList.toggle("active", button.dataset.tool === state.tool);
      }
      const palette = PALETTES[state.tool];
      swatchBox.replaceChildren();
      swatchBox.hidden = !palette;
      if (palette) {
        const current = state.colors[state.tool];
        const colors = [...palette, ...state.customColors.filter((c) => !palette.includes(c)).slice(0, 2)];
        for (const color of colors) {
          const swatch = el("button", {
            class: `dprSwatch${color.toLowerCase() === current.toLowerCase() ? " active" : ""}`,
            type: "button",
            title: color,
            "aria-label": `Colour ${color}`,
            onclick: () => setColor(color),
          });
          swatch.style.setProperty("--swatch", color);
          swatchBox.append(swatch);
        }
        swatchBox.append(
          el("button", { class: "dprSwatch dprSwatchCustom", type: "button", title: "Custom colour", "aria-label": "Custom colour", onclick: () => pickCustomColor() }, [icon("plus")])
        );
      }
      const sizes = SIZES[state.tool];
      sizeBox.replaceChildren();
      sizeBox.hidden = !sizes;
      sizes?.forEach((size, i) => {
        const dot = el("button", {
          class: `dprSize${i === state.sizes[state.tool] ? " active" : ""}`,
          type: "button",
          title: ["Thin", "Medium", "Thick"][i],
          "aria-label": ["Thin", "Medium", "Thick"][i],
          onclick: () => setSize(i),
        });
        dot.style.setProperty("--dot", `${6 + i * 5}px`);
        sizeBox.append(dot);
      });
      penOnlyBtn.classList.toggle("active", state.penOnly);
      penOnlyBtn.title = state.penOnly
        ? "Pen only: fingers scroll, the pen writes. Tap to let fingers write too."
        : "Fingers write too. Tap for pen only (fingers scroll).";
      penOnlyBtn.setAttribute("aria-label", penOnlyBtn.title);
      root.dataset.dprTool = state.tool;
    }

    function setTool(tool) {
      state.tool = tool;
      save();
      if (state.open) {
        ui()?.unselectAll();
        setMode(modeForTool(tool));
        applyToolParams();
      }
      renderBar();
    }

    function setColor(color) {
      state.colors[state.tool] = color;
      save();
      applyToolParams();
      renderBar();
    }

    function setSize(index) {
      state.sizes[state.tool] = index;
      save();
      applyToolParams();
      renderBar();
    }

    function pickCustomColor() {
      colorInput.value = state.colors[state.tool] || "#000000";
      colorInput.click();
    }
    colorInput.addEventListener("change", () => {
      const color = colorInput.value.toUpperCase();
      state.customColors = [color, ...state.customColors.filter((c) => c !== color)].slice(0, 6);
      setColor(color);
    });

    function setPenOnly(on) {
      state.penOnly = on;
      save();
      root.classList.toggle("dpr-pen-only", on);
      renderBar();
      flash(on ? "Pen only" : "Fingers write");
    }

    let flashTimer = 0;
    function flash(text) {
      status.textContent = text;
      status.classList.add("visible");
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => status.classList.remove("visible"), 1600);
    }

    function toggle(open = !state.open) {
      if (open && !app.pdfDocument) {
        return;
      }
      state.open = open;
      bar.hidden = !open;
      root.classList.toggle("dpr-notes", open);
      root.classList.toggle("dpr-pen-only", state.penOnly);
      notesButton.classList.toggle("toggled", open);
      notesButton.setAttribute("aria-pressed", String(open));
      if (open) {
        setMode(modeForTool(state.tool));
        applyToolParams();
      } else {
        ui()?.endCurrentEditing();
        setMode(Mode.NONE);
        autosaveSoon(0);
      }
      renderBar();
    }

    // Toolbar entry point, replacing PDF.js's separate highlight and draw buttons.
    const notesButton = el("button", {
      id: "dprNotes",
      class: "toolbarButton",
      type: "button",
      title: "Notes: pen, highlighter, eraser (N)",
      "aria-label": "Notes",
      "aria-pressed": "false",
      onclick: () => toggle(),
    });
    document.getElementById("editorModeButtons")?.prepend(notesButton);

    // Leave notes mode if PDF.js switches mode by itself (e.g. its own buttons).
    app.eventBus.on("annotationeditormodechanged", ({ mode }) => {
      if (state.open && mode === Mode.NONE) {
        state.open = false;
        bar.hidden = true;
        root.classList.remove("dpr-notes");
        notesButton.classList.remove("toggled");
        notesButton.setAttribute("aria-pressed", "false");
      }
    });

    // --------------------------------------------- pointer input (pen/touch)

    let penDown = false;
    let lastPenTime = 0;
    let gesture = null; // { kind: "pan" | "erase" | "select-text" | "select-tap", ... }

    const isPen = (e) => e.pointerType === "pen";
    const isEraserButton = (e) => isPen(e) && ((e.buttons & 2) === 2 || (e.buttons & 32) === 32 || e.button === 2 || e.button === 5);
    const isPalm = (e) =>
      e.pointerType === "touch" && (penDown || Date.now() - lastPenTime < PALM_GRACE || e.width > PALM_SIZE || e.height > PALM_SIZE);

    viewer.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);

    function swallow(e) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    function onPointerDown(e) {
      if (!state.open || e.target.closest("#dprNotesBar")) {
        return;
      }
      if (isPen(e)) {
        penDown = true;
        lastPenTime = Date.now();
        if (!state.sawPen) {
          // First time a pen is used: switch to palm rejection automatically.
          state.sawPen = true;
          setPenOnly(true);
        }
      }

      // Touch with "pen only": never draws (scrolling is done from touch
      // events below).
      if (e.pointerType === "touch" && state.penOnly) {
        swallow(e);
        return;
      }
      if (e.pointerType === "touch" && isPalm(e)) {
        swallow(e);
        return;
      }

      if (state.tool === "eraser" || isEraserButton(e)) {
        swallow(e);
        startErase(e);
        return;
      }

      if (state.tool === "highlighter" && e.pointerType !== "mouse") {
        // Pens and fingers can't drag-select text natively; do it for them.
        const span = e.target.closest(".textLayer span");
        if (span) {
          swallow(e);
          startTextSelection(e);
        }
        return;
      }

      if (state.tool === "select") {
        // Taps on empty page space shouldn't start a drawing.
        if (e.target.classList.contains("annotationEditorLayer")) {
          swallow(e);
          ui()?.unselectAll();
        }
      }
    }

    function onPointerMove(e) {
      if (!gesture || e.pointerId !== gesture.pointerId) {
        return;
      }
      if (gesture.kind === "erase") {
        moveErase(e);
      } else if (gesture.kind === "select-text") {
        moveTextSelection(e);
      }
      swallow(e);
    }

    function onPointerUp(e) {
      if (isPen(e)) {
        penDown = false;
        lastPenTime = Date.now();
      }
      if (!gesture || e.pointerId !== gesture.pointerId) {
        if (state.open && state.tool === "pen" && !gesture && e.target.closest?.(".page")) {
          finishStroke(e);
        }
        return;
      }
      const ended = gesture;
      gesture = null;
      if (ended.kind === "erase") {
        endErase(ended);
      } else if (ended.kind === "select-text") {
        endTextSelection();
      }
    }

    // ----- One-finger scrolling with momentum (pen-only mode)
    // Driven by touch events, not pointer events: PDF.js's pinch-zoom handler
    // can swallow a finger's pointerdown (right after a pen stroke, since the
    // pen also produces touch events), but it never blocks touch events.

    let pan = null; // { id, x, y, samples }

    const isStylusTouch = (touch) => touch.touchType === "stylus";
    const isPalmTouch = (touch) =>
      penDown || Date.now() - lastPenTime < PALM_GRACE || touch.radiusX * 2 > PALM_SIZE || touch.radiusY * 2 > PALM_SIZE;

    viewer.addEventListener(
      "touchstart",
      (e) => {
        if (!state.open || !state.penOnly || e.target.closest("#dprNotesBar")) {
          return;
        }
        const fingers = [...e.touches].filter((t) => !isStylusTouch(t));
        if (fingers.length !== 1) {
          pan = null; // two fingers: PDF.js pinch-zooms
          return;
        }
        const touch = fingers[0];
        if (isStylusTouch(e.changedTouches[0]) || isPalmTouch(touch)) {
          return;
        }
        cancelMomentum();
        pan = { id: touch.identifier, x: touch.clientX, y: touch.clientY, samples: [[e.timeStamp, touch.clientX, touch.clientY]] };
      },
      { capture: true, passive: true }
    );

    window.addEventListener(
      "touchmove",
      (e) => {
        if (!pan) {
          return;
        }
        if (e.touches.length > 1) {
          pan = null;
          return;
        }
        const touch = [...e.touches].find((t) => t.identifier === pan.id);
        if (!touch) {
          return;
        }
        viewer.scrollLeft -= touch.clientX - pan.x;
        viewer.scrollTop -= touch.clientY - pan.y;
        pan.x = touch.clientX;
        pan.y = touch.clientY;
        pan.samples.push([e.timeStamp, touch.clientX, touch.clientY]);
        if (pan.samples.length > 8) {
          pan.samples.shift();
        }
      },
      { capture: true, passive: true }
    );

    const endTouchPan = (e) => {
      if (pan && [...e.changedTouches].some((t) => t.identifier === pan.id)) {
        const ended = pan;
        pan = null;
        endPan(ended);
      }
    };
    window.addEventListener("touchend", endTouchPan, { capture: true, passive: true });
    window.addEventListener("touchcancel", () => (pan = null), { capture: true, passive: true });

    let momentumFrame = 0;
    function endPan({ samples }) {
      const [t0, x0, y0] = samples[0];
      const [t1, x1, y1] = samples.at(-1);
      const dt = t1 - t0;
      if (dt <= 0 || dt > 150) {
        return;
      }
      let vx = (x1 - x0) / dt; // px per ms
      let vy = (y1 - y0) / dt;
      let last = performance.now();
      const step = (now) => {
        const elapsed = now - last;
        last = now;
        viewer.scrollLeft -= vx * elapsed;
        viewer.scrollTop -= vy * elapsed;
        const decay = Math.pow(0.995, elapsed);
        vx *= decay;
        vy *= decay;
        if (Math.hypot(vx, vy) > 0.02) {
          momentumFrame = requestAnimationFrame(step);
        }
      };
      momentumFrame = requestAnimationFrame(step);
    }

    function cancelMomentum() {
      cancelAnimationFrame(momentumFrame);
    }
    viewer.addEventListener("wheel", cancelMomentum, { passive: true });

    // ----- Pen strokes: one drawing per stroke, so each can be erased alone

    function finishStroke(e) {
      const page = pageOf(e.target);
      setTimeout(() => {
        const manager = ui();
        if (!manager) {
          return;
        }
        const layer = page ? manager.getLayer(page - 1) : manager.currentLayer;
        layer?.endDrawingSession(false);
        manager.unselectAll();
      }, 0);
    }

    // ----- Eraser

    const pathCache = new WeakMap(); // <path> -> { d, points: [[x, y]...] in SVG units }

    function strokePoints(path) {
      const d = path.getAttribute("d");
      let cached = pathCache.get(path);
      if (!cached || cached.d !== d) {
        const length = path.getTotalLength();
        const count = Math.min(400, Math.max(8, Math.ceil(length * 200)));
        const points = [];
        for (let i = 0; i <= count; i++) {
          const p = path.getPointAtLength((length * i) / count);
          points.push([p.x, p.y]);
        }
        cached = { d, points };
        pathCache.set(path, cached);
      }
      return cached.points;
    }

    function editorsAt(x, y, radius) {
      const manager = ui();
      if (!manager) {
        return [];
      }
      const hits = [];
      for (const div of document.querySelectorAll(".annotationEditorLayer :is(.inkEditor, .highlightEditor)")) {
        const box = div.getBoundingClientRect();
        if (x < box.left - radius || x > box.right + radius || y < box.top - radius || y > box.bottom + radius) {
          continue;
        }
        const editor = manager.getEditor(div.id);
        if (!editor || editor.isEmpty?.()) {
          continue;
        }
        if (div.classList.contains("highlightEditor")) {
          hits.push(editor);
          continue;
        }
        // Ink: test against the actual stroke, not its bounding box.
        const path = editor._drawId != null && document.getElementById(`path_${editor._drawId}`);
        const svg = path?.ownerSVGElement;
        if (!svg) {
          hits.push(editor);
          continue;
        }
        const area = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const sx = area.width / (vb?.width || 1);
        const sy = area.height / (vb?.height || 1);
        const width = parseFloat(getComputedStyle(svg).strokeWidth) || 2;
        const reach = radius + width / 2;
        for (const [px, py] of strokePoints(path)) {
          const cx = area.left + (px - (vb?.x || 0)) * sx;
          const cy = area.top + (py - (vb?.y || 0)) * sy;
          if (Math.hypot(cx - x, cy - y) <= reach) {
            hits.push(editor);
            break;
          }
        }
      }
      return hits;
    }

    function startErase(e) {
      ui()?.unselectAll();
      gesture = { kind: "erase", pointerId: e.pointerId, removed: [] };
      showEraserCursor(e);
      eraseAt(e);
    }

    function moveErase(e) {
      showEraserCursor(e);
      eraseAt(e);
    }

    function eraseAt(e) {
      const radius = SIZES.eraser[state.sizes.eraser] / 2;
      for (const editor of editorsAt(e.clientX, e.clientY, radius)) {
        if (!gesture.removed.includes(editor)) {
          gesture.removed.push(editor);
          editor.remove();
        }
      }
    }

    function endErase({ removed }) {
      hideEraserCursor();
      if (!removed.length) {
        return;
      }
      const manager = ui();
      const restore = () => {
        for (const editor of removed) {
          const layer = manager.getLayer(editor.pageIndex);
          if (layer) {
            layer.addOrRebuild(editor);
          } else {
            manager.addEditor(editor);
            manager.addToAnnotationStorage(editor);
          }
        }
      };
      // Already removed while erasing; register it so Undo brings them back.
      manager.addCommands({
        cmd: () => removed.forEach((editor) => editor.remove()),
        undo: restore,
        mustExec: false,
      });
      changed(); // the removals themselves were tracked by the storage
    }

    const eraserCursor = el("div", { class: "dprEraserCursor", hidden: "" });
    document.body.append(eraserCursor);
    function showEraserCursor(e) {
      const size = SIZES.eraser[state.sizes.eraser];
      eraserCursor.hidden = false;
      eraserCursor.style.width = eraserCursor.style.height = `${size}px`;
      eraserCursor.style.transform = `translate(${e.clientX - size / 2}px, ${e.clientY - size / 2}px)`;
    }
    function hideEraserCursor() {
      eraserCursor.hidden = true;
    }

    // ----- Highlighter on text with a pen or finger

    function caretAt(x, y) {
      if (document.caretPositionFromPoint) {
        const pos = document.caretPositionFromPoint(x, y);
        return pos && { node: pos.offsetNode, offset: pos.offset };
      }
      const range = document.caretRangeFromPoint?.(x, y);
      return range && { node: range.startContainer, offset: range.startOffset };
    }

    function startTextSelection(e) {
      const start = caretAt(e.clientX, e.clientY);
      const textLayer = e.target.closest(".textLayer");
      if (!start || !textLayer) {
        return;
      }
      gesture = { kind: "select-text", pointerId: e.pointerId, start, textLayer };
      document.getSelection().collapse(start.node, start.offset);
    }

    function moveTextSelection(e) {
      const end = caretAt(e.clientX, e.clientY);
      if (!end || !gesture.textLayer.contains(end.node)) {
        return; // stay within one page
      }
      document.getSelection().setBaseAndExtent(gesture.start.node, gesture.start.offset, end.node, end.offset);
    }

    function endTextSelection() {
      // PDF.js turns the selection into a highlight on pointerup; make sure.
      setTimeout(() => {
        const selection = document.getSelection();
        if (selection && !selection.isCollapsed) {
          ui()?.highlightSelection("main_toolbar");
        }
      }, 50);
    }

    // ------------------------------------------------------------- keyboard

    window.addEventListener(
      "keydown",
      (e) => {
        if (api.isTyping(e.target) || e.ctrlKey || e.altKey || e.metaKey || !app.pdfDocument) {
          return;
        }
        const keys = { p: "pen", h: "highlighter", e: "eraser", t: "text", s: "select" };
        if (e.key === "n") {
          toggle();
        } else if (state.open && keys[e.key]) {
          setTool(keys[e.key]);
        } else if (state.open && e.key === "Escape" && !ui()?.hasSelection) {
          toggle(false);
        } else {
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true
    );

    // ------------------------------------------------- autosave and restore

    const DB_NAME = "dpr-notes";
    let dbPromise = null;
    function db() {
      dbPromise ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore("docs");
        request.onsuccess = () => {
          const database = request.result;
          // Let other tabs upgrade/delete the database instead of blocking them.
          database.onversionchange = () => {
            database.close();
            dbPromise = null;
          };
          resolve(database);
        };
        request.onerror = () => reject(request.error);
      });
      return dbPromise;
    }
    async function dbRun(mode, fn) {
      const database = await db();
      return new Promise((resolve, reject) => {
        const tx = database.transaction("docs", mode);
        const request = fn(tx.objectStore("docs"));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
      });
    }
    const loadNotes = (key) => dbRun("readonly", (s) => s.get(key));
    const storeNotes = (key, value) => dbRun("readwrite", (s) => s.put(value, key));
    const deleteNotes = (key) => dbRun("readwrite", (s) => s.delete(key));

    const fingerprint = () => app.pdfDocument?.fingerprints[0];
    let restoredFor = null; // fingerprint whose saved notes are currently loaded
    let saving = false;
    let dirty = false; // notes changed since the last save
    let autosaveTimer = 0;

    // Changes since the last save: marks added, marks removed that were there
    // before, and edits to existing marks or form fields. Adding something
    // and removing it again (e.g. a cancelled signature, or undo) cancels out.
    const changes = { added: new Set(), removed: new Set(), edited: false };

    function resetChanges() {
      changes.added.clear();
      changes.removed.clear();
      changes.edited = false;
      dirty = false;
    }

    function changed() {
      dirty = changes.added.size > 0 || changes.removed.size > 0 || changes.edited;
      platform.onNotesChanged?.(dirty);
      if (dirty) {
        autosaveSoon();
      }
    }

    // An edit that isn't an add/remove (moving a mark, typing in a field).
    function markDirty() {
      changes.edited = true;
      changed();
    }

    function autosaveSoon(delay = AUTOSAVE_DELAY) {
      if (!autosaveEnabled) {
        return;
      }
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(autosave, delay);
    }

    async function autosave() {
      const doc = app.pdfDocument;
      const key = fingerprint();
      if (!autosaveEnabled || !doc || !key || !dirty) {
        return;
      }
      if (saving) {
        autosaveSoon();
        return;
      }
      saving = true;
      try {
        ui()?.commitOrRemove();
        const bytes = await doc.saveDocument();
        if (app.pdfDocument !== doc) {
          return; // another PDF was opened meanwhile
        }
        await storeNotes(key, { bytes, name: api.fileName(), savedAt: Date.now() });
        resetChanges();
        restoredFor = key;
        doc.annotationStorage.resetModified(); // clears the "*" in the title
        flash("Notes saved");
      } catch (err) {
        console.error("Dark PDF Reader: autosave failed", err);
        flash("Couldn't save notes");
      } finally {
        saving = false;
      }
    }

    // What counts as a change: marks added to or removed from the PDF's
    // annotation storage, finished strokes/erases/highlights, typing in a text
    // box, and undo/redo. (PDF.js's own "modified" callback gets replaced by
    // the viewer, so the storage methods themselves are wrapped.)
    function watchStorage() {
      const storage = app.pdfDocument?.annotationStorage;
      if (!storage || storage.dprWatched) {
        return;
      }
      storage.dprWatched = true;
      const setValue = storage.setValue.bind(storage);
      storage.setValue = (key, value) => {
        const existed = storage.has(key);
        const result = setValue(key, value);
        if (existed) {
          changes.edited = true; // e.g. a form field's value
        } else if (changes.removed.has(key)) {
          changes.removed.delete(key); // put back (undo of an erase)
        } else {
          changes.added.add(key);
        }
        changed();
        return result;
      };
      // PDF.js also "removes" things that were never stored (e.g. an empty
      // placeholder when a tool opens); only real removals are changes.
      const remove = storage.remove.bind(storage);
      storage.remove = (key) => {
        const existed = storage.has(key);
        const result = remove(key);
        if (existed) {
          if (changes.added.has(key)) {
            changes.added.delete(key); // added since the last save, so no net change
          } else {
            changes.removed.add(key);
          }
          changed();
        }
        return result;
      };
    }
    // PDF.js puts "* " in the title while a PDF has marks; with autosave
    // there's nothing unsaved, so leave it out.
    const setTitle = app.setTitle.bind(app);
    app.setTitle = (...args) => {
      setTitle(...args);
      document.title = document.title.replace(/^\* /, "");
    };

    app.eventBus.on("documentloaded", () => {
      resetChanges();
      watchStorage();
    });
    app.eventBus.on("pagesinit", watchStorage);
    // Moving or resizing a mark (Select tool) changes it without touching storage.
    viewer.addEventListener("pointerup", () => state.open && state.tool === "select" && ui()?.hasSelection && markDirty(), true);
    viewer.addEventListener("input", (e) => e.target.closest?.(".annotationEditorLayer") && markDirty(), true);
    // (Undo/redo of adding or erasing marks goes through the storage too.)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        autosave();
      }
    });

    // When a PDF opens, reopen the copy with your notes if there is one.
    app.eventBus.on("documentloaded", async () => {
      const key = fingerprint();
      if (!autosaveEnabled || !key || restoredFor === key) {
        return;
      }
      try {
        const saved = await loadNotes(key);
        if (saved?.bytes && fingerprint() === key) {
          restoredFor = key;
          await app.open({ data: saved.bytes, filename: api.fileName() || saved.name });
          flash("Your notes are back");
        }
      } catch (err) {
        console.error("Dark PDF Reader: couldn't restore notes", err);
      }
    });
    app.eventBus.on("documentinit", () => {
      if (fingerprint() !== restoredFor) {
        restoredFor = null;
      }
      if (state.open) {
        toggle(false);
      }
    });

    // "Discard my notes" in the » menu (only when notes are kept automatically).
    (autosaveEnabled ? document.getElementById("secondaryToolbarButtonContainer") : null)?.append(
      el(
        "button",
        {
          id: "dprDiscardNotes",
          class: "toolbarButton labeled",
          type: "button",
          tabindex: "0",
          onclick: async () => {
            app.secondaryToolbar?.close();
            const key = fingerprint();
            if (!key || !confirm("Remove all your notes and highlights from this PDF? This can't be undone.")) {
              return;
            }
            await deleteNotes(key);
            restoredFor = null;
            if (api.source) {
              location.reload();
            } else {
              alert("Notes removed. Open the file again to see it without them.");
            }
          },
        },
        [el("span", { text: "Discard my notes" })]
      )
    );

    renderBar();
    window.DPR_NOTES = {
      toggle,
      setTool,
      state,
      autosave,
      // For hosts that save into the file themselves (desktop app).
      markSaved() {
        resetChanges();
        platform.onNotesChanged?.(false);
      },
      hasChanges: () => dirty,
      debug: () => ({
        penDown,
        sincePen: Date.now() - lastPenTime,
        gesture: gesture?.kind ?? null,
        changes: { added: [...changes.added], removed: [...changes.removed], edited: changes.edited },
      }),
    };
  });
})();
