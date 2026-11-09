"use strict";

// Pagewise for Windows: hooks for the shared reader inside each tab. Served in
// place of the engine's empty ui/platform.js (build.ps1 copies it over), so it loads
// before ui/enhance.js and ui/notes.js. Talks to the window shell
// (desk/shell.js) through window.parent.Pagewise.

(() => {
  const shell = window.parent !== window ? window.parent.Pagewise : null;
  const params = new URLSearchParams(location.search);
  let docId = params.get("doc");
  let app = null;
  let api = null;
  let dirty = false;
  let saveAsNext = false;
  let saveResult = null; // resolves the Promise of the current save

  const hasPageChanges = () =>
    Boolean(app?.pdfThumbnailViewer?.hasStructuralChanges() || app?._mergedDocumentNeedsSaving);

  function setDirty(value) {
    if (dirty !== value) {
      dirty = value;
      shell?.update(docId, { dirty });
    }
  }

  window.DPR_PLATFORM = {
    // Desktop: Ctrl+S writes into the PDF itself (like Acrobat), so no
    // separate automatic notes copy.
    notesAutosave: false,
    // The host serves byte ranges, so big PDFs show their first page fast.
    streamDocuments: true,
    viewerOptions: {
      enableSignatureEditor: true,
      enableComment: true,
      enableSplitMerge: true,
      enableMerge: true,
    },
    emptyHint: "Open a PDF with Ctrl+O, or drop one into the window.",
    openHint: "with Ctrl+O",

    // notes.js tracks changes since the last save (an add undone counts as none).
    onNotesChanged: (changed) => setDirty(changed !== false || hasPageChanges()),

    onDarkChange(dark) {
      if (!applyingShellTheme) {
        shell?.darkChanged(dark);
      }
    },

    onReady(pdfApp, readerApi) {
      app = pdfApp;
      api = readerApi;
      setUp();
    },
  };

  let applyingShellTheme = false;

  // ------------------------------------------------------------ pinch zoom

  // A touchpad pinch (and Ctrl+mouse wheel) arrives as a wheel event with
  // ctrlKey set. PDF.js zooms the pages for it (viewer.mjs onWheel, around
  // the pointer); this only makes sure WebView2 never zooms the whole window
  // instead, e.g. in presentation mode or over a dialog, where PDF.js leaves
  // the event alone. Registered before viewer.mjs, so it can't block it.
  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false, capture: true }
  );

  // ------------------------------------------------------------ API for the shell

  window.PagewiseDoc = {
    setDark(dark) {
      if (api && api.isDark() !== dark) {
        applyingShellTheme = true;
        api.toggleDark();
        applyingShellTheme = false;
      }
    },
    setDocId(id) {
      docId = id;
    },
    // Used when closing a tab with unsaved changes.
    save: () => startSave(false),
  };

  // ------------------------------------------------------------ saving

  // Both Save and Save as go through PDF.js's own save (it works out the
  // bytes, including highlights, drawings, form fields and page changes) and
  // end in downloadManager.download, which we redirect to the file.
  function startSave(asCopy) {
    if (!app?.pdfDocument) {
      return Promise.resolve(false);
    }
    saveAsNext = asCopy;
    return new Promise((resolve) => {
      saveResult = resolve;
      app.downloadOrSave();
    });
  }

  async function writeBytes(data) {
    const finish = saveResult || (() => {});
    saveResult = null;
    const asCopy = saveAsNext;
    saveAsNext = false;
    const structural = app.pdfThumbnailViewer?.hasStructuralChanges() || app._mergedDocumentNeedsSaving;
    const ok = asCopy ? await shell?.saveAs(docId, data) : await shell?.save(docId, data);
    if (ok) {
      app.pdfDocument?.annotationStorage.resetModified();
      window.DPR_NOTES?.markSaved();
      setDirty(false);
      if (structural) {
        // Pages were reordered/removed/merged: reload the saved file so what
        // you see is exactly what's on disk.
        location.reload();
      }
    }
    finish(Boolean(ok));
  }

  // ------------------------------------------------------------ setup

  function setUp() {
    const downloads = app.downloadManager;
    downloads.download = (data) => {
      if (data) {
        writeBytes(data);
      } else {
        api.getBytes().then(writeBytes);
      }
    };
    // Attachments inside PDFs: save them with "Save as".
    downloads.downloadData = (data, filename) => {
      const blob = new Blob([data]);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    };

    // Ctrl+O and PDF.js's own "Open" open a new tab via the native dialog.
    if (app._openFileInput) {
      app._openFileInput.click = () => shell?.openDialog();
    }

    addSaveAsItem();
    trackChanges();
    reportPosition();

    // Keyboard: tab shortcuts go to the shell; Ctrl+Shift+S is Save as.
    window.addEventListener(
      "keydown",
      (e) => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "s") {
          e.preventDefault();
          e.stopImmediatePropagation();
          startSave(true);
        } else if (shell?.key(e)) {
          e.stopImmediatePropagation();
        }
      },
      true
    );

    // Files dropped on the page open in new tabs (not in place of this one).
    window.addEventListener(
      "dragover",
      (e) => {
        if ([...(e.dataTransfer?.types || [])].includes("Files")) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true
    );
    window.addEventListener(
      "drop",
      (e) => {
        if (e.dataTransfer?.files?.length) {
          e.preventDefault();
          e.stopImmediatePropagation();
          shell?.openDropped(e.dataTransfer.files);
        }
      },
      true
    );

    // Dark mode is shared by all tabs and the Home tab.
    if (shell && api.isDark() !== shell.isDark()) {
      window.PagewiseDoc.setDark(shell.isDark());
    }
  }

  function addSaveAsItem() {
    const menu = document.getElementById("secondaryToolbarButtonContainer");
    // Right after "Open" (PDF.js's own Save item is hidden on wide windows).
    const open = document.getElementById("secondaryOpenFile");
    const button = document.createElement("button");
    button.id = "dprSaveAs";
    button.className = "toolbarButton labeled";
    button.type = "button";
    button.title = "Save a copy as… (Ctrl+Shift+S)";
    const label = document.createElement("span");
    label.textContent = "Save as…";
    button.append(label);
    button.addEventListener("click", () => {
      app.secondaryToolbar?.close();
      startSave(true);
    });
    menu?.insertBefore(button, open ? open.nextSibling : menu.firstChild);
  }

  function trackChanges() {
    // Annotations and form fields come from notes.js (onNotesChanged);
    // page reordering/deleting/merging from PDF.js's page organiser.
    app.eventBus.on("pagesedited", () => setDirty(true));
    app.eventBus.on("documentloaded", () => {
      setDirty(Boolean(app._mergedDocumentNeedsSaving));
    });
    // The Home tab's cover is made later, when nothing else is happening,
    // and only once per file: never competing with the page you're reading.
    app.eventBus.on("pagerendered", function onFirstRender() {
      app.eventBus.off("pagerendered", onFirstRender);
      setTimeout(() => {
        const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 0));
        idle(async () => {
          if (shell && !(await shell.hasThumb(docId))) {
            makeThumbnail();
          }
        }, { timeout: 10000 });
      }, 4000);
    });
  }

  let positionTimer = 0;
  function reportPosition() {
    app.eventBus.on("pagechanging", () => {
      clearTimeout(positionTimer);
      positionTimer = setTimeout(() => {
        shell?.update(docId, { page: app.page, pages: app.pagesCount });
      }, 800);
    });
  }

  // Cover for the Home tab's recent files.
  async function makeThumbnail() {
    try {
      const page = await app.pdfDocument.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 300 / base.width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      shell?.thumb(docId, canvas.toDataURL("image/jpeg", 0.82));
    } catch {}
  }
})();
