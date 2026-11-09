"use strict";

// Pagewise for Linux: the bridge between the window shell (desk/shell.js)
// and main.js. It offers the same small interface as WebView2's
// window.chrome.webview on Windows, so the shared web UI runs unchanged:
//   postMessage(object)                        message to the host
//   postMessageWithAdditionalObjects("drop", files)  dropped files (by path)
//   addEventListener("message", ({ data }) => …)     messages from the host
// plus read aloud through speech-dispatcher. Runs in the shell's main frame
// only; the reader tabs reach the host through window.parent.Pagewise.

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const listeners = new Set();
ipcRenderer.on("host-message", (_event, data) => {
  for (const listener of listeners) {
    try {
      listener({ data });
    } catch (err) {
      console.error(err);
    }
  }
});

contextBridge.exposeInMainWorld("pagewiseHost", {
  platform: "linux",
  postMessage(message) {
    ipcRenderer.send("host-post", message);
  },
  postMessageWithAdditionalObjects(kind, files) {
    if (kind !== "drop") return;
    const paths = [];
    for (const file of Array.from(files || [])) {
      try {
        const p = webUtils.getPathForFile(file);
        if (p) paths.push(p);
      } catch {}
    }
    ipcRenderer.send("host-drop", paths);
  },
  addEventListener(type, listener) {
    if (type === "message" && typeof listener === "function") listeners.add(listener);
  },
  removeEventListener(type, listener) {
    if (type === "message") listeners.delete(listener);
  },
  // Resolves true when every part was spoken, false if stopped or unavailable.
  speak: (parts, lang) => ipcRenderer.invoke("speech-speak", Array.from(parts || [], String), String(lang || "")),
  cancelSpeech: () => ipcRenderer.send("speech-cancel"),
});
