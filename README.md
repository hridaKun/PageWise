# Pagewise

A lightweight PDF reader and editor for **Windows 10/11** and **Ubuntu/Linux**.
Same reading and notes engine as the Edge extension and the Android app, with
a desktop shell: tabs, a Home tab, and saving straight into your PDF files.

- Windows: one ~4 MB file (`Pagewise.exe`) or the ~4 MB installer
  (`PagewiseSetup-<version>.exe`), built on Edge WebView2.
- Linux: a ~90 MB `.deb` (`pagewise_<version>_amd64.deb`), built on Electron
  (Chromium, the same engine), for Ubuntu 22.04+ and Debian-based systems.

## Features

- **Tabs** for several PDFs, and a **Home** tab with recent files (covers,
  reading position, search, "Show in folder", remove).
- Open with **Ctrl+O**, the **+** button, **drag and drop**, recent files, or
  Explorer's **Open with**. Opening another PDF while Pagewise is running adds a
  tab to the open window.
- **Save into the file** with **Ctrl+S** (or the save button); **Save as**
  with **Ctrl+Shift+S** or the `»` menu. Unsaved tabs show an orange dot,
  and Pagewise asks before closing a tab or the window with unsaved changes.
  Saving writes to a temporary file first, so a failed save never damages
  the PDF.
- **Zoom**: pinch on a touchpad or touchscreen (zooms around your fingers),
  Ctrl+mouse wheel, Ctrl+`+` / Ctrl+`-` / Ctrl+`0`, or the toolbar.
- **Annotate**: highlighter (custom colours), pen, eraser, text boxes,
  comments, images, **signatures** (type, draw or image), and **form filling**.
- **Organise pages**: open the sidebar's page view to select, delete, copy,
  cut, paste, export and reorder pages, or add (merge) another PDF.
- Dark mode (window, title bar and pages), contents sidebar, clickable
  printed contents pages, search, rotate, two-page view, presentation
  mode, read aloud (Windows voices; speech-dispatcher on Linux), print, document properties, and
  keyboard shortcuts (press `?`).
- Tab shortcuts: Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+1…9, Ctrl+W, Ctrl+H (Home).

## Download

From the [Releases](../../releases) page:

- **Windows**: `PagewiseSetup-<version>.exe`. It installs per user (no
  administrator rights needed). The installer isn't code-signed, so Windows
  SmartScreen shows "Windows protected your PC" on downloaded copies (More
  info > Run anyway).
- **Ubuntu / Debian**: `pagewise_<version>_amd64.deb`. Double-click it, or:

  ```
  sudo apt install ./pagewise_<version>_amd64.deb
  ```

  Pagewise then appears in the app menu and in "Open with" for PDFs; the
  Home tab's button makes it the default PDF app. Remove it with
  `sudo apt remove pagewise`.

## Repository layout

```
├── src/              Windows: Pagewise.exe (C#, WinForms + WebView2)
│   ├── Program.cs      single instance, unpacking the embedded web files
│   ├── MainForm.cs     the window: WebView2 host, file serving/saving, dialogs
│   └── AssemblyInfo.cs
├── installer/        Windows: PagewiseSetup.exe (C#, WinForms)
├── linux/            Linux: the Electron app and the .deb
│   ├── main.js         the window: file serving/saving, dialogs, read aloud
│   ├── preload.js      bridge to the web UI (same interface as WebView2's)
│   ├── build.sh        builds the app and the .deb
│   ├── package/        .desktop entry, AppArmor profile, install scripts
│   ├── icons/          app icon (PNG sizes 16–256)
│   └── test/e2e.js     end-to-end test that drives the real app
├── desk/             the desktop web UI (both platforms)
│   ├── shell.*         tab strip, Home tab, dialogs
│   └── platform.*      hooks for the reader inside each tab
├── engine/           the shared reader engine
│   ├── ui/             reader additions: notes, toolbar, dark mode, read aloud
│   └── pdfjs/          Mozilla PDF.js (modern build), with the viewer
├── skin/             colours (tokens.css) and icons shared with the Android app
├── tools/
│   └── make-icon.ps1   draws the app icon
├── app.manifest      DPI awareness, long paths, no elevation
├── build.ps1         Windows: builds everything into dist\
└── .github/workflows/build.yml   CI: builds and tests both; tags publish a release
```

## Build

### Windows

Needs only Windows (the .NET Framework 4.8 C# compiler that ships with it).
The first build downloads the
[Microsoft.Web.WebView2](https://www.nuget.org/packages/Microsoft.Web.WebView2)
package (1.0.4258.31) from nuget.org into `_deps\pkg`.

```
powershell -ExecutionPolicy Bypass -File build.ps1
```

This makes `dist\Pagewise.exe` and the installer
`dist\PagewiseSetup-<version>.exe`. The version comes from `Version` in
`src\Program.cs`; keep `src\AssemblyInfo.cs`, `installer\AssemblyInfo.cs`
and `installer\Setup.cs` in step.

### Linux

Needs bash, curl, unzip and dpkg-deb (standard on Ubuntu). The first build
downloads Electron (44.10.2) from GitHub into `_deps/` and checks its SHA-256.

```
linux/build.sh          # the app and dist/pagewise_<version>_amd64.deb
linux/build.sh --app    # only the app, in _build/linux/pagewise/
```

Run the unpacked app with `_build/linux/pagewise/pagewise --no-sandbox`
(the sandbox needs the `.deb`'s setup on Ubuntu 23.10+).

Test it end to end (Node 22+; drives the real app: opening, range requests,
pinch and Ctrl+wheel zoom, annotating and saving, read aloud, second launch,
recent files, the close prompt):

```
node linux/test/e2e.js [--pdf some.pdf] [--screenshot shot.png] [--no-speech]
```

### Versions and releases

Both builds take the version from `Version` in `src/Program.cs`.

GitHub Actions builds and tests both on every push. Pushing a tag such as
`v1.2.0` also publishes a GitHub Release with the Windows installer and the
Linux `.deb`.

## Installer

`installer\` is a small WinForms setup with Pagewise's look (light/dark to
match Windows, scales with display DPI). It installs per user to
`%LOCALAPPDATA%\Programs\Pagewise`: Start menu and (optional) desktop
shortcuts, an entry in Settings > Apps, and (optional) registration as a PDF
app. It runs `Pagewise.exe --prepare` so the first launch is as quick as every
other. Running it again updates in place (it closes a running Pagewise first,
asking if there are unsaved changes). Uninstalling (`uninstall.exe
/uninstall`, run by Settings > Apps) removes all of that, and optionally
recent files and settings.

## How it works

- `src\Program.cs`: single instance (a second launch passes its files to the
  running window through a named pipe) and unpacking the embedded files to
  `%LOCALAPPDATA%\Pagewise\build-<id>` on first run (or with `--prepare`).
- `src\MainForm.cs`: the window. Hosts Edge WebView2, serves the reader from
  `https://pagewise.example/` (a folder mapping) and files from
  `https://files.pagewise.example/`, which is intercepted and never sent to
  the network: `/doc/<id>` streams a PDF with range requests (big files show
  their first page before they're fully read) and `/save/<id>` writes it.
  Also dialogs, recent files (`%APPDATA%\Pagewise\recent.json`), "Open with"
  registration (current user only), dark title bar, and the close prompt.
- `desk\shell.*`: the tab strip and Home tab. Each open PDF is an `<iframe>`
  with `engine/pdfjs/web/viewer.html`.
- `desk\platform.*`: hooks for the reader inside each tab (save to file,
  unsaved tracking, page organiser and signatures switched on). The build
  copies them over the engine's empty `ui\platform.*`.
- `linux/main.js`: the same job as `MainForm.cs` on Linux, in Electron. It
  answers every `https://` request itself (the app's files, `/doc/<id>`
  with byte ranges, `/save/<id>` written to a temporary file and renamed
  over the PDF), refuses everything else, keeps one window (a second launch
  hands its files over), remembers recent files and the window size in
  `~/.config/Pagewise`, reloads the page with the same files open if it
  ever crashes, and speaks with `spd-say`. `linux/preload.js` gives the web
  UI the same `postMessage` interface as WebView2, so `desk/` runs unchanged.
- Pinch zoom: WebView2's pinch handling is on so that touchpad pinches reach
  the page as Ctrl+wheel events; PDF.js zooms the pages for them, and
  `desk\platform.js` / `desk\shell.js` stop WebView2 from zooming the whole
  window instead.

## Debugging

Set `PAGEWISE_DEBUG_PORT=9335` before starting to get a separate instance
with DevTools and remote debugging on that port. It has its own data
(Windows: `%APPDATA%\Pagewise-debug`, `%LOCALAPPDATA%\Pagewise\WebView2-debug`;
Linux: `~/.config/Pagewise-debug`) and never touches a Pagewise window
that's already open.

## Third-party software

- [PDF.js](https://github.com/mozilla/pdf.js) by Mozilla, Apache License 2.0
  (`engine/pdfjs/LICENSE`).
- [Microsoft Edge WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)
  SDK, downloaded at build time under its own license.
- [Electron](https://www.electronjs.org/) (Linux), MIT License, downloaded at
  build time; its Chromium licenses ship in the `.deb`.
