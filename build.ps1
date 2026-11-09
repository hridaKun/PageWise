# Builds dist\Pagewise.exe: one file with the reader, the desktop interface and
# Microsoft's WebView2 libraries inside, plus the installer
# dist\PagewiseSetup-<version>.exe. Uses the C# compiler that comes with
# Windows (.NET Framework 4.8), so nothing else needs to be installed.
#
#   powershell -ExecutionPolicy Bypass -File build.ps1
#
# The Microsoft.Web.WebView2 NuGet package is downloaded into _deps\pkg the
# first time (it isn't kept in the repository).

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$engine = "$root\engine"                      # shared reader engine (PDF.js + ui\)
$skin = "$root\skin"                          # colours and icons (shared with the Android app)
$webview2 = "$root\_deps\pkg"                 # Microsoft.Web.WebView2 package
$webview2Version = "1.0.4258.31"
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$build = "$root\_build"
$payload = "$build\payload"

if (-not (Test-Path $csc)) {
  throw "The .NET Framework 4.x C# compiler wasn't found at $csc."
}

# --- WebView2 package (download once from nuget.org)
if (-not (Test-Path "$webview2\lib\net462\Microsoft.Web.WebView2.Core.dll")) {
  Write-Host "Downloading Microsoft.Web.WebView2 $webview2Version from nuget.org..."
  New-Item -ItemType Directory -Force "$root\_deps" | Out-Null
  $nupkg = "$root\_deps\webview2.nupkg"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/$webview2Version" -OutFile $nupkg -UseBasicParsing
  Remove-Item $webview2 -Recurse -Force -ErrorAction SilentlyContinue
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($nupkg, $webview2)
}

Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$payload\app", "$payload\bin", "$root\dist" | Out-Null

# --- Web files: the shared engine, the desktop interface, Pagewise's skin assets
robocopy $engine "$payload\app" /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the engine failed ($LASTEXITCODE)" }
robocopy "$root\desk" "$payload\app\desk" /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the desktop interface failed ($LASTEXITCODE)" }
# The desktop hooks replace the engine's empty ui/platform.* files.
Copy-Item "$root\desk\platform.js" "$payload\app\ui\platform.js" -Force
Copy-Item "$root\desk\platform.css" "$payload\app\ui\platform.css" -Force
New-Item -ItemType Directory -Force "$payload\app\skin" | Out-Null
Copy-Item "$skin\tokens.css" "$payload\app\skin\"
Copy-Item "$skin\icons" "$payload\app\skin\" -Recurse

# --- WebView2 libraries
Copy-Item "$webview2\lib\net462\Microsoft.Web.WebView2.Core.dll", "$webview2\lib\net462\Microsoft.Web.WebView2.WinForms.dll" "$payload\bin\"
Copy-Item "$webview2\runtimes\win-x64\native\WebView2Loader.dll" "$payload\bin\"

# --- Pack it
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($payload, "$build\payload.zip", [System.IO.Compression.CompressionLevel]::Optimal, $false)
$hash = (Get-FileHash "$build\payload.zip" -Algorithm SHA256).Hash.Substring(0, 12).ToLower()
Set-Content "$build\build.txt" $hash -NoNewline -Encoding Ascii

# --- Icon
& "$root\tools\make-icon.ps1" -Out "$build\pagewise.ico"

# --- Compile
$refs = @(
  "$webview2\lib\net462\Microsoft.Web.WebView2.Core.dll",
  "$webview2\lib\net462\Microsoft.Web.WebView2.WinForms.dll",
  "System.dll", "System.Core.dll", "System.Drawing.dll", "System.Windows.Forms.dll",
  "System.IO.Compression.dll", "System.IO.Compression.FileSystem.dll", "System.Web.Extensions.dll"
) | ForEach-Object { "/reference:$_" }

& $csc /nologo /target:winexe /platform:x64 /optimize+ /langversion:5 `
  "/out:$build\Pagewise.exe" "/win32icon:$build\pagewise.ico" "/win32manifest:$root\app.manifest" `
  $refs "/resource:$build\payload.zip,Pagewise.payload.zip" "/resource:$build\build.txt,Pagewise.build.txt" `
  "$root\src\*.cs"
if ($LASTEXITCODE -ne 0) { throw "Compiling failed" }

$exe = Get-Item "$build\Pagewise.exe"
"Built {0} ({1:N1} MB, build {2})" -f $exe.FullName, ($exe.Length / 1MB), $hash
# dist\Pagewise.exe may be the copy you're running; then it's left as it was.
try {
  Copy-Item $exe.FullName "$root\dist\Pagewise.exe" -Force
  "Copied to dist\Pagewise.exe"
} catch {
  "dist\Pagewise.exe is in use (Pagewise is running), so it was left as it was."
}

# --- Installer: PagewiseSetup-<version>.exe with Pagewise.exe inside
$version = (Select-String -Path "$root\src\Program.cs" -Pattern 'Version = "([^"]+)"').Matches[0].Groups[1].Value
$setup = "$build\PagewiseSetup-$version.exe"
& $csc /nologo /target:winexe /platform:anycpu /optimize+ /langversion:5 `
  "/out:$setup" "/win32icon:$build\pagewise.ico" "/win32manifest:$root\app.manifest" `
  /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:Microsoft.CSharp.dll `
  "/resource:$build\Pagewise.exe,Setup.Pagewise.exe" "/resource:$build\pagewise.ico,Setup.icon.ico" `
  "$root\installer\*.cs"
if ($LASTEXITCODE -ne 0) { throw "Compiling the installer failed" }
Copy-Item $setup "$root\dist\" -Force
$setupFile = Get-Item "$root\dist\PagewiseSetup-$version.exe"
"Installer {0} ({1:N1} MB)" -f $setupFile.FullName, ($setupFile.Length / 1MB)
