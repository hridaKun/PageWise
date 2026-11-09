// Pagewise for Windows: the window. Hosts the reader in Edge WebView2 and
// supplies what a web page can't do by itself: reading and writing files,
// Open/Save dialogs, recent files, "Open with", and asking before closing
// with unsaved changes.
//
// Nothing is ever sent to the network. WebView2 serves the app's own files
// from https://pagewise.example/ (a folder mapping):
//   /desk/shell.html       the window's tab strip and Home tab
//   /pdfjs/web/viewer.html the reader (one per tab)
// and this window answers https://files.pagewise.example/ itself:
//   /doc/<id>              the PDF of a tab (GET, with byte ranges)
//   /save/<id>             write a tab's PDF to its file (PUT)

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace Pagewise
{
    public class MainForm : Form
    {
        const string Origin = "https://pagewise.example";        // the app (served by WebView2)
        const string FilesOrigin = "https://files.pagewise.example"; // PDFs and saving (served here)
        const string ShellUrl = Origin + "/desk/shell.html";
        // Only the app may read or write files through FilesOrigin.
        const string Cors = "Access-Control-Allow-Origin: " + Origin + "\r\n" +
            "Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n";

        readonly WebView2 web = new WebView2();
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        readonly Dictionary<string, string> docs = new Dictionary<string, string>(); // id -> path
        readonly List<string> waitingToOpen = new List<string>();
        readonly RecentFiles recent;
        CoreWebView2Environment env;
        bool shellReady;
        bool closeConfirmed;
        bool dark = true;
        FormWindowState stateBeforeFullScreen;

        public MainForm(List<string> startupFiles)
        {
            Text = "Pagewise";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            BackColor = Color.Black;
            MinimumSize = new Size(640, 480);
            recent = new RecentFiles(Path.Combine(Program.DataDir, "recent.json"));
            RestoreWindowBounds();

            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = Color.Black;
            Controls.Add(web);
            waitingToOpen.AddRange(startupFiles);
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            ApplyTitleBarTheme();
            try
            {
                CoreWebView2Environment.SetLoaderDllFolderPath(Program.BinDir);
                string arguments = Program.DebugPort != null
                    ? "--remote-debugging-port=" + Program.DebugPort
                    : null;
                CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions(arguments);
                env = await CoreWebView2Environment.CreateAsync(null, Program.WebViewDataDir, options);
                await web.EnsureCoreWebView2Async(env);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this,
                    "Pagewise needs Microsoft Edge WebView2, which is part of Windows 10 and 11.\n\n" + ex.Message,
                    "Pagewise", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }

            CoreWebView2 core = web.CoreWebView2;
            CoreWebView2Settings settings = core.Settings;
            settings.AreDevToolsEnabled = Program.DebugPort != null;
            settings.AreBrowserAcceleratorKeysEnabled = false; // no F5/Ctrl+R reloads; PDF.js handles its keys
            settings.IsStatusBarEnabled = false;
            settings.IsZoomControlEnabled = false;             // PDF.js does its own zoom
            // Must stay on: with it off, Windows precision-touchpad pinches
            // never reach the page at all. With it on, a touchpad pinch
            // arrives as a Ctrl+wheel event, which PDF.js turns into a smooth
            // zoom around the pointer; the pages (desk/platform.js,
            // desk/shell.js) cancel the browser's own zoom of the window.
            settings.IsPinchZoomEnabled = true;

            // The reader's own files are served by WebView2 itself (fast, cached,
            // off this window's thread). Only PDFs and saving come through here.
            core.SetVirtualHostNameToFolderMapping("pagewise.example", Program.AppDir,
                CoreWebView2HostResourceAccessKind.DenyCors);
            core.AddWebResourceRequestedFilter(FilesOrigin + "/*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnWebResourceRequested;
            core.WebMessageReceived += OnWebMessageReceived;
            core.NewWindowRequested += delegate (object s, CoreWebView2NewWindowRequestedEventArgs a)
            {
                a.Handled = true;
                OpenExternally(a.Uri);
            };
            core.NavigationStarting += delegate (object s, CoreWebView2NavigationStartingEventArgs a)
            {
                if (!a.Uri.StartsWith(Origin + "/")) { a.Cancel = true; OpenExternally(a.Uri); }
            };
            core.FrameNavigationStarting += delegate (object s, CoreWebView2NavigationStartingEventArgs a)
            {
                if (!a.Uri.StartsWith(Origin + "/") && !a.Uri.StartsWith("about:")) { a.Cancel = true; OpenExternally(a.Uri); }
            };
            core.ContainsFullScreenElementChanged += delegate { SetFullScreen(core.ContainsFullScreenElement); };
            core.Navigate(ShellUrl);
        }

        // ------------------------------------------------------------ serving files

        void OnWebResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            Uri uri = new Uri(e.Request.Uri);
            string path = Uri.UnescapeDataString(uri.AbsolutePath);
            try
            {
                // Pages may only use these files if they are the app's own.
                string origin = e.Request.Headers.Contains("Origin") ? e.Request.Headers.GetHeader("Origin") : null;
                if (origin != null && origin != Origin)
                {
                    e.Response = Respond(403, "Forbidden", "text/plain", "");
                    return;
                }
                if (e.Request.Method == "OPTIONS")
                {
                    // CORS preflight for saving (PUT).
                    e.Response = env.CreateWebResourceResponse(null, 204, "No Content",
                        Cors + "Access-Control-Allow-Methods: GET, PUT\r\nAccess-Control-Allow-Headers: Content-Type, Range\r\nAccess-Control-Max-Age: 600");
                    return;
                }
                if (path.StartsWith("/doc/"))
                {
                    e.Response = ServeDocument(path.Substring(5), e.Request);
                    return;
                }
                if (path.StartsWith("/save/") && e.Request.Method == "PUT")
                {
                    e.Response = SaveDocument(path.Substring(6), e.Request.Content);
                    return;
                }
                e.Response = Respond(404, "Not Found", "text/plain", "");
            }
            catch (Exception ex)
            {
                e.Response = Respond(500, "Error", "text/plain", ex.Message);
            }
        }

        // A PDF, whole or in byte ranges ("Range: bytes=a-b"). PDF.js asks for
        // the parts it needs first, so big books open quickly. Ranges are read
        // into memory; the whole file is streamed from disk. The file is opened
        // with sharing so Save can still replace it.
        CoreWebView2WebResourceResponse ServeDocument(string id, CoreWebView2WebResourceRequest request)
        {
            string file;
            if (!docs.TryGetValue(id, out file) || !File.Exists(file))
            {
                return Respond(404, "Not Found", "text/plain", "This file is no longer available.");
            }
            FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete, 64 * 1024);
            long length = stream.Length;
            const string common = Cors + "Content-Type: application/pdf\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\n";

            string range = request.Headers.Contains("Range") ? request.Headers.GetHeader("Range") : null;
            long start, end;
            if (range != null && TryParseRange(range, length, out start, out end))
            {
                byte[] part = new byte[end - start + 1];
                using (stream)
                {
                    stream.Seek(start, SeekOrigin.Begin);
                    int read = 0;
                    while (read < part.Length)
                    {
                        int n = stream.Read(part, read, part.Length - read);
                        if (n <= 0) break;
                        read += n;
                    }
                }
                return env.CreateWebResourceResponse(new MemoryStream(part), 206, "Partial Content",
                    common + "Content-Length: " + part.Length + "\r\nContent-Range: bytes " + start + "-" + end + "/" + length);
            }
            return env.CreateWebResourceResponse(stream, 200, "OK", common + "Content-Length: " + length);
        }

        static bool TryParseRange(string header, long length, out long start, out long end)
        {
            start = end = 0;
            if (!header.StartsWith("bytes=") || header.Contains(",")) return false;
            string[] parts = header.Substring(6).Split('-');
            if (parts.Length != 2) return false;
            if (parts[0].Length == 0)
            {
                long suffix;
                if (!long.TryParse(parts[1], out suffix) || suffix <= 0) return false;
                start = Math.Max(0, length - suffix);
                end = length - 1;
            }
            else
            {
                if (!long.TryParse(parts[0], out start)) return false;
                end = parts[1].Length == 0 ? length - 1 : long.Parse(parts[1]);
            }
            end = Math.Min(end, length - 1);
            return start >= 0 && start <= end;
        }

        CoreWebView2WebResourceResponse Respond(int status, string reason, string mime, string body)
        {
            return env.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(body)), status, reason,
                Cors + "Content-Type: " + mime + "; charset=utf-8");
        }

        // Writes to a temporary file next to the PDF, then swaps it in, so a
        // failed save never leaves a half-written PDF.
        CoreWebView2WebResourceResponse SaveDocument(string id, Stream content)
        {
            string file;
            if (!docs.TryGetValue(id, out file))
            {
                return Respond(404, "Not Found", "text/plain", "This file is no longer open.");
            }
            string temp = file + ".pagewise-saving";
            try
            {
                using (FileStream output = new FileStream(temp, FileMode.Create, FileAccess.Write))
                {
                    content.CopyTo(output);
                }
                if (File.Exists(file))
                {
                    File.Replace(temp, file, null);
                }
                else
                {
                    File.Move(temp, file);
                }
                return Respond(200, "OK", "text/plain", "saved");
            }
            catch (UnauthorizedAccessException)
            {
                TryDelete(temp);
                return Respond(500, "Error", "text/plain",
                    "Pagewise isn't allowed to change “" + Path.GetFileName(file) + "” (it may be read-only or in a protected folder). Use Save as to save a copy.");
            }
            catch (IOException ex)
            {
                TryDelete(temp);
                return Respond(500, "Error", "text/plain",
                    "“" + Path.GetFileName(file) + "” couldn't be saved: " + ex.Message + " If another program has it open, close it there and try again, or use Save as.");
            }
        }

        static void TryDelete(string file)
        {
            try { if (File.Exists(file)) File.Delete(file); } catch { }
        }

        // ------------------------------------------------------------ messages from the page

        void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            // Files dropped into the window arrive as File objects with their paths.
            string text = null;
            try { text = e.TryGetWebMessageAsString(); } catch { }
            if (text == "drop")
            {
                List<string> dropped = new List<string>();
                if (e.AdditionalObjects != null)
                {
                    foreach (object item in e.AdditionalObjects)
                    {
                        CoreWebView2File f = item as CoreWebView2File;
                        if (f != null) dropped.Add(f.Path);
                    }
                }
                OpenFiles(dropped);
                return;
            }

            Dictionary<string, object> message = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
            string type = Get(message, "type");
            switch (type)
            {
                case "ready":
                    shellReady = true;
                    Post(new Dictionary<string, object> { { "type", "version" }, { "version", Program.Version } });
                    if (waitingToOpen.Count > 0)
                    {
                        List<string> files = new List<string>(waitingToOpen);
                        waitingToOpen.Clear();
                        OpenFiles(files);
                    }
                    break;
                case "open-dialog":
                    ShowOpenDialog();
                    break;
                case "open-path":
                    OpenFiles(new List<string> { Get(message, "path") });
                    break;
                case "get-recent":
                    SendRecent();
                    break;
                case "recent-progress":
                    recent.UpdateProgress(Get(message, "path"), GetInt(message, "page"), GetInt(message, "pages"));
                    break;
                case "recent-remove":
                    recent.Remove(Get(message, "path"));
                    SendRecent();
                    break;
                case "reveal":
                    Reveal(Get(message, "path"));
                    break;
                case "save-as-dialog":
                    ShowSaveAsDialog(GetInt(message, "reqId"), Get(message, "id"), Get(message, "name"));
                    break;
                case "closed":
                    docs.Remove(Get(message, "id"));
                    break;
                case "title":
                    Text = Get(message, "text");
                    break;
                case "theme":
                    dark = message.ContainsKey("dark") && (bool)message["dark"];
                    BackColor = dark ? Color.Black : Color.FromArgb(244, 244, 246);
                    web.DefaultBackgroundColor = BackColor;
                    ApplyTitleBarTheme();
                    break;
                case "associate":
                    RegisterOpenWith();
                    break;
                case "close-ok":
                    closeConfirmed = true;
                    Close();
                    break;
            }
        }

        void Post(object message)
        {
            if (web.CoreWebView2 != null)
            {
                web.CoreWebView2.PostWebMessageAsJson(json.Serialize(message));
            }
        }

        static string Get(Dictionary<string, object> message, string key)
        {
            object value;
            return message.TryGetValue(key, out value) && value != null ? value.ToString() : "";
        }

        static int GetInt(Dictionary<string, object> message, string key)
        {
            object value;
            if (message.TryGetValue(key, out value) && value != null)
            {
                try { return Convert.ToInt32(value); } catch { }
            }
            return 0;
        }

        // ------------------------------------------------------------ opening

        public void OpenFromOutside(List<string> paths)
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            OpenFiles(paths);
        }

        void OpenFiles(List<string> paths)
        {
            if (!shellReady)
            {
                waitingToOpen.AddRange(paths);
                return;
            }
            List<object> opened = new List<object>();
            List<string> missing = new List<string>();
            foreach (string path in paths)
            {
                if (string.IsNullOrEmpty(path)) continue;
                if (!File.Exists(path))
                {
                    missing.Add(Path.GetFileName(path));
                    continue;
                }
                if (!path.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase) && !LooksLikePdf(path))
                {
                    missing.Add(Path.GetFileName(path) + " (not a PDF)");
                    continue;
                }
                string id = Register(path);
                recent.Touch(path);
                opened.Add(new Dictionary<string, object> { { "id", id }, { "path", path }, { "name", Path.GetFileName(path) } });
            }
            if (opened.Count > 0)
            {
                Post(new Dictionary<string, object> { { "type", "opened" }, { "docs", opened } });
            }
            if (missing.Count > 0)
            {
                Post(new Dictionary<string, object> { { "type", "error" }, { "message", "Couldn't open: " + string.Join(", ", missing.ToArray()) } });
            }
        }

        static bool LooksLikePdf(string path)
        {
            try
            {
                using (FileStream s = File.OpenRead(path))
                {
                    byte[] head = new byte[5];
                    return s.Read(head, 0, 5) == 5 && Encoding.ASCII.GetString(head) == "%PDF-";
                }
            }
            catch
            {
                return false;
            }
        }

        string Register(string path)
        {
            foreach (KeyValuePair<string, string> pair in docs)
            {
                if (string.Equals(pair.Value, path, StringComparison.OrdinalIgnoreCase)) return pair.Key;
            }
            string id = Guid.NewGuid().ToString("N").Substring(0, 16);
            docs[id] = path;
            return id;
        }

        void ShowOpenDialog()
        {
            using (OpenFileDialog dialog = new OpenFileDialog())
            {
                dialog.Title = "Open PDF";
                dialog.Filter = "PDF documents (*.pdf)|*.pdf|All files (*.*)|*.*";
                dialog.Multiselect = true;
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    OpenFiles(new List<string>(dialog.FileNames));
                }
            }
        }

        void ShowSaveAsDialog(int reqId, string id, string name)
        {
            Dictionary<string, object> reply = new Dictionary<string, object> { { "reqId", reqId }, { "ok", false } };
            string current;
            docs.TryGetValue(id, out current);
            using (SaveFileDialog dialog = new SaveFileDialog())
            {
                dialog.Title = "Save a copy";
                dialog.Filter = "PDF documents (*.pdf)|*.pdf";
                dialog.DefaultExt = "pdf";
                dialog.AddExtension = true;
                dialog.OverwritePrompt = true;
                dialog.FileName = Path.GetFileNameWithoutExtension(name) + " (copy).pdf";
                if (current != null) dialog.InitialDirectory = Path.GetDirectoryName(current);
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    string newId = Register(dialog.FileName);
                    recent.Touch(dialog.FileName);
                    reply["ok"] = true;
                    reply["id"] = newId;
                    reply["path"] = dialog.FileName;
                    reply["name"] = Path.GetFileName(dialog.FileName);
                }
            }
            Post(reply);
        }

        void SendRecent()
        {
            Post(new Dictionary<string, object> { { "type", "recent" }, { "items", recent.ToMessage() } });
        }

        static void Reveal(string path)
        {
            try
            {
                if (File.Exists(path)) Process.Start("explorer.exe", "/select,\"" + path + "\"");
            }
            catch { }
        }

        static void OpenExternally(string uri)
        {
            try
            {
                Uri parsed = new Uri(uri);
                if (parsed.Scheme == "http" || parsed.Scheme == "https" || parsed.Scheme == "mailto")
                {
                    Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
                }
            }
            catch { }
        }

        // ------------------------------------------------------------ "Open with"

        // Adds Pagewise to Explorer's "Open with" list for PDFs (for this
        // Windows user only; no administrator rights needed). Choosing it as
        // the default is up to the user in Windows Settings.
        void RegisterOpenWith()
        {
            try
            {
                string exe = Application.ExecutablePath;
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Pagewise.PDF"))
                {
                    key.SetValue("", "PDF Document");
                    key.SetValue("FriendlyTypeName", "PDF Document");
                }
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Pagewise.PDF\DefaultIcon"))
                {
                    key.SetValue("", "\"" + exe + "\",0");
                }
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Pagewise.PDF\shell\open\command"))
                {
                    key.SetValue("", "\"" + exe + "\" \"%1\"");
                }
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\.pdf\OpenWithProgids"))
                {
                    key.SetValue("Pagewise.PDF", new byte[0], RegistryValueKind.None);
                }
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Applications\Pagewise.exe\SupportedTypes"))
                {
                    key.SetValue(".pdf", "");
                }
                SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero); // SHCNE_ASSOCCHANGED
                DialogResult answer = MessageBox.Show(this,
                    "Pagewise now appears in “Open with” for PDF files.\n\n" +
                    "To open PDFs with Pagewise when you double-click them, choose Pagewise as the default PDF app in Windows Settings. Open Settings now?",
                    "Pagewise", MessageBoxButtons.YesNo, MessageBoxIcon.Information);
                if (answer == DialogResult.Yes)
                {
                    Process.Start(new ProcessStartInfo("ms-settings:defaultapps") { UseShellExecute = true });
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Couldn't register Pagewise: " + ex.Message, "Pagewise");
            }
        }

        [DllImport("shell32.dll")]
        static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);

        // ------------------------------------------------------------ window

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Let the page ask about unsaved changes first: the close button,
            // Alt+F4, the taskbar, or another program asking the window to
            // close (Windows reports that as TaskManagerClosing; a real
            // "End task" can still force it). Not when Windows shuts down.
            bool askFirst = e.CloseReason == CloseReason.UserClosing || e.CloseReason == CloseReason.None
                || e.CloseReason == CloseReason.TaskManagerClosing;
            if (!closeConfirmed && shellReady && askFirst)
            {
                e.Cancel = true;
                Post(new Dictionary<string, object> { { "type", "close-request" } });
                return;
            }
            SaveWindowBounds();
            base.OnFormClosing(e);
        }

        void SetFullScreen(bool on)
        {
            if (on)
            {
                stateBeforeFullScreen = WindowState;
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Normal;
                WindowState = FormWindowState.Maximized;
            }
            else
            {
                FormBorderStyle = FormBorderStyle.Sizable;
                WindowState = stateBeforeFullScreen;
            }
        }

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        // Dark title bar to match dark mode (Windows 10 20H1+ / 11).
        void ApplyTitleBarTheme()
        {
            try
            {
                int value = dark ? 1 : 0;
                DwmSetWindowAttribute(Handle, 20, ref value, sizeof(int));
            }
            catch { }
        }

        string BoundsFile { get { return Path.Combine(Program.DataDir, "window.txt"); } }

        void RestoreWindowBounds()
        {
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(1280, 860);
            try
            {
                string[] parts = File.ReadAllText(BoundsFile).Split(',');
                Rectangle bounds = new Rectangle(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3]));
                if (Screen.FromRectangle(bounds).WorkingArea.IntersectsWith(bounds) && bounds.Width >= 640 && bounds.Height >= 480)
                {
                    StartPosition = FormStartPosition.Manual;
                    Bounds = bounds;
                }
                if (parts.Length > 4 && parts[4] == "max") WindowState = FormWindowState.Maximized;
            }
            catch { }
        }

        void SaveWindowBounds()
        {
            try
            {
                Rectangle b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                File.WriteAllText(BoundsFile, b.X + "," + b.Y + "," + b.Width + "," + b.Height + "," +
                    (WindowState == FormWindowState.Maximized ? "max" : "normal"));
            }
            catch { }
        }
    }

    // ---------------------------------------------------------------- recent files

    class RecentFiles
    {
        const int Max = 60;
        readonly string file;
        readonly JavaScriptSerializer json = new JavaScriptSerializer();
        List<Dictionary<string, object>> items;

        public RecentFiles(string file)
        {
            this.file = file;
            try
            {
                items = json.Deserialize<List<Dictionary<string, object>>>(File.ReadAllText(file));
            }
            catch
            {
                items = null;
            }
            if (items == null) items = new List<Dictionary<string, object>>();
        }

        Dictionary<string, object> Find(string path)
        {
            foreach (Dictionary<string, object> item in items)
            {
                if (string.Equals(item["path"] as string, path, StringComparison.OrdinalIgnoreCase)) return item;
            }
            return null;
        }

        static long Now()
        {
            return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        }

        public void Touch(string path)
        {
            Dictionary<string, object> item = Find(path);
            if (item == null)
            {
                item = new Dictionary<string, object> { { "path", path }, { "page", 1 }, { "pages", 0 } };
            }
            else
            {
                items.Remove(item);
            }
            item["name"] = Path.GetFileName(path);
            item["opened"] = Now();
            items.Insert(0, item);
            if (items.Count > Max) items.RemoveRange(Max, items.Count - Max);
            Save();
        }

        public void UpdateProgress(string path, int page, int pages)
        {
            Dictionary<string, object> item = Find(path);
            if (item == null || page <= 0) return;
            item["page"] = page;
            item["pages"] = pages;
            Save();
        }

        public void Remove(string path)
        {
            Dictionary<string, object> item = Find(path);
            if (item != null)
            {
                items.Remove(item);
                Save();
            }
        }

        public List<object> ToMessage()
        {
            List<object> list = new List<object>();
            foreach (Dictionary<string, object> item in items)
            {
                Dictionary<string, object> copy = new Dictionary<string, object>(item);
                copy["exists"] = File.Exists(item["path"] as string);
                list.Add(copy);
            }
            return list;
        }

        void Save()
        {
            try { File.WriteAllText(file, json.Serialize(items)); } catch { }
        }
    }
}
