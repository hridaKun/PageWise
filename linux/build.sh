#!/usr/bin/env bash
# Builds Pagewise for Linux (x86-64): the app in _build/linux/pagewise/ and
# the installer dist/pagewise_<version>_amd64.deb.
#
#   linux/build.sh            build the app and the .deb
#   linux/build.sh --app      only the app (run it with _build/linux/pagewise/pagewise)
#
# Needs bash, curl, unzip and dpkg-deb (all standard on Ubuntu). Electron is
# downloaded once from GitHub into _deps/ and checked against its SHA-256.
# The version comes from src/Program.cs, like the Windows build.
set -euo pipefail

ELECTRON_VERSION="44.10.2"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINUX="$ROOT/linux"
DEPS="$ROOT/_deps/electron-$ELECTRON_VERSION"
OUT="$ROOT/_build/linux"
APP="$OUT/pagewise"
DIST="$ROOT/dist"
ONLY_APP=0
[[ "${1:-}" == "--app" ]] && ONLY_APP=1

for tool in curl unzip; do
  command -v "$tool" >/dev/null || { echo "Missing $tool (sudo apt install $tool)" >&2; exit 1; }
done

VERSION="$(sed -n 's/.*Version = "\([^"]*\)".*/\1/p' "$ROOT/src/Program.cs" | head -n1)"
[[ -n "$VERSION" ]] || { echo "Couldn't read Version from src/Program.cs" >&2; exit 1; }

# --- Electron (downloaded once, checked against Electron's published SHA-256)
ZIP="electron-v$ELECTRON_VERSION-linux-x64.zip"
mkdir -p "$DEPS"
fetch() {
  curl -sSfL --retry 8 --retry-all-errors --retry-delay 5 -o "$DEPS/$1.part" \
    "https://github.com/electron/electron/releases/download/v$ELECTRON_VERSION/$1"
  mv "$DEPS/$1.part" "$DEPS/$1"
}
[[ -f "$DEPS/SHASUMS256.txt" ]] || fetch SHASUMS256.txt
if [[ ! -f "$DEPS/$ZIP" ]]; then
  echo "Downloading Electron $ELECTRON_VERSION..."
  fetch "$ZIP"
fi
( cd "$DEPS" && grep " \*\?$ZIP\$" SHASUMS256.txt | sed 's/ \*/  /' | sha256sum --check --status ) \
  || { echo "Electron download is corrupt; delete $DEPS and try again." >&2; exit 1; }

# --- The app: Electron renamed to "pagewise", with our files in resources/app
rm -rf "$OUT"
mkdir -p "$APP" "$DIST"
unzip -q "$DEPS/$ZIP" -d "$APP"
mv "$APP/electron" "$APP/pagewise"
rm -f "$APP/resources/default_app.asar"

RES="$APP/resources/app"
WEB="$RES/web"
mkdir -p "$WEB/desk" "$WEB/skin" "$RES/icons"
cp "$LINUX/main.js" "$LINUX/preload.js" "$RES/"
sed "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" "$LINUX/package.json" > "$RES/package.json"
cp "$LINUX/icons/pagewise-256.png" "$RES/icons/pagewise.png"
# Web files: the shared engine, the desktop interface, Pagewise's skin
cp -r "$ROOT/engine/." "$WEB/"
cp -r "$ROOT/desk/." "$WEB/desk/"
cp "$ROOT/desk/platform.js" "$WEB/ui/platform.js"   # the desktop hooks replace the
cp "$ROOT/desk/platform.css" "$WEB/ui/platform.css" # engine's empty ui/platform.*
cp -r "$ROOT/skin/." "$WEB/skin/"
echo "Built $APP (Pagewise $VERSION, Electron $ELECTRON_VERSION)"

[[ $ONLY_APP == 1 ]] && exit 0

# --- The .deb
command -v dpkg-deb >/dev/null || { echo "Missing dpkg-deb (sudo apt install dpkg)" >&2; exit 1; }
PKG="$OUT/deb"
mkdir -p "$PKG/DEBIAN" "$PKG/opt" "$PKG/usr/bin" "$PKG/usr/share/applications" "$PKG/etc/apparmor.d" \
  "$PKG/usr/share/doc/pagewise"
cp -r "$APP" "$PKG/opt/pagewise"
ln -s /opt/pagewise/pagewise "$PKG/usr/bin/pagewise"
install -m 644 "$LINUX/package/pagewise.desktop" "$PKG/usr/share/applications/pagewise.desktop"
install -m 644 "$LINUX/package/apparmor-pagewise" "$PKG/etc/apparmor.d/pagewise"
for size in 16 24 32 48 64 128 256; do
  install -D -m 644 "$LINUX/icons/pagewise-$size.png" "$PKG/usr/share/icons/hicolor/${size}x$size/apps/pagewise.png"
done
cp "$ROOT/engine/pdfjs/LICENSE" "$PKG/usr/share/doc/pagewise/LICENSE.pdfjs"
cp "$APP/LICENSE" "$PKG/usr/share/doc/pagewise/LICENSE.electron"
install -m 755 "$LINUX/package/postinst" "$LINUX/package/postrm" "$PKG/DEBIAN/"
# Everything else is world-readable; the sandbox helper gets setuid in postinst.
chmod 755 "$PKG"
chmod -R u+rwX,go+rX,go-w "$PKG/opt" "$PKG/usr" "$PKG/etc"

SIZE="$(du -sk --exclude=DEBIAN "$PKG" | cut -f1)"
cat > "$PKG/DEBIAN/control" <<EOF
Package: pagewise
Version: $VERSION
Section: graphics
Priority: optional
Architecture: amd64
Installed-Size: $SIZE
Maintainer: Pagewise <pagewise@users.noreply.github.com>
Depends: libgtk-3-0t64 | libgtk-3-0, libnss3, libgbm1, libasound2t64 | libasound2, libxss1, libxtst6, libnotify4, libatspi2.0-0t64 | libatspi2.0-0, libsecret-1-0, libdrm2, libxkbcommon0, xdg-utils
Recommends: speech-dispatcher, espeak-ng, apparmor
Description: PDF reader and editor
 Read, highlight, write, sign and organise your PDFs. Tabs, a Home tab with
 recent files, annotations, signatures, form filling, page organising, dark
 mode, read aloud, and saving straight into the PDF file.
EOF

DEB="$DIST/pagewise_${VERSION}_amd64.deb"
dpkg-deb --build --root-owner-group -Zxz "$PKG" "$DEB" >/dev/null
echo "Installer $DEB ($(du -h "$DEB" | cut -f1))"
