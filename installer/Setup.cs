// Pagewise Setup: installs Pagewise for the current Windows user (no
// administrator rights), and uninstalls it again from Windows Settings.
//
//   PagewiseSetup.exe                  install (or update)
//   uninstall.exe /uninstall         (in the install folder) remove Pagewise
//
// Installs to %LOCALAPPDATA%\Programs\Pagewise, adds Start-menu (and optionally
// desktop) shortcuts, an "Installed apps" entry, and registers Pagewise for PDF
// files so it appears in "Open with" and Default apps.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace PagewiseSetup
{
    static class Setup
    {
        public const string Version = "1.2.0";
        public const string AppName = "Pagewise";
        public static string UiFont = "Segoe UI";

        public static string InstallDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Pagewise"); }
        }
        public static string ExePath { get { return Path.Combine(InstallDir, "Pagewise.exe"); } }
        public static string UninstallerPath { get { return Path.Combine(InstallDir, "uninstall.exe"); } }
        public static string StartMenuShortcut
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Pagewise.lnk"); }
        }
        public static string DesktopShortcut
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Pagewise.lnk"); }
        }
        const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Pagewise";

        [STAThread]
        static int Main(string[] args)
        {
            foreach (FontFamily family in FontFamily.Families)
            {
                if (family.Name == "Segoe UI Variable Text") { UiFont = family.Name; break; }
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            List<string> list = new List<string>(args);
            if (list.Contains("/uninstall"))
            {
                // Runs from the install folder, which is about to be deleted:
                // continue from a temporary copy.
                string temp = Path.Combine(Path.GetTempPath(), "Pagewise-uninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
                File.Copy(Assembly.GetExecutingAssembly().Location, temp, true);
                Process.Start(new ProcessStartInfo(temp, "/uninstall-run") { UseShellExecute = false });
                return 0;
            }
            bool uninstall = list.Contains("/uninstall-run");
            Application.Run(new SetupForm(uninstall));
            return 0;
        }

        // ------------------------------------------------------------ install

        public static void Install(bool desktopShortcut, bool openPdfs, Action<float, string> progress)
        {
            progress(0.05f, "Getting things ready…");
            Directory.CreateDirectory(InstallDir);

            progress(0.15f, "Copying Pagewise…");
            string temp = ExePath + ".new";
            using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("Setup.Pagewise.exe"))
            using (FileStream target = new FileStream(temp, FileMode.Create, FileAccess.Write))
            {
                source.CopyTo(target);
            }
            if (File.Exists(ExePath)) File.Delete(ExePath);
            File.Move(temp, ExePath);
            File.Copy(Assembly.GetExecutingAssembly().Location, UninstallerPath, true);

            // Unpack Pagewise's files now, so the first launch is instant.
            progress(0.35f, "Preparing the reader…");
            Process prepare = Process.Start(new ProcessStartInfo(ExePath, "--prepare") { UseShellExecute = false, CreateNoWindow = true });
            prepare.WaitForExit(120000);

            progress(0.8f, "Adding shortcuts…");
            CreateShortcut(StartMenuShortcut);
            if (desktopShortcut) CreateShortcut(DesktopShortcut);
            else TryDelete(DesktopShortcut);

            progress(0.9f, "Registering with Windows…");
            RegisterUninstall();
            if (openPdfs) RegisterPdf();
            SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero); // file associations changed
            progress(1f, "Done");
        }

        static void CreateShortcut(string path)
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            dynamic shell = Activator.CreateInstance(shellType);
            dynamic link = shell.CreateShortcut(path);
            link.TargetPath = ExePath;
            link.WorkingDirectory = InstallDir;
            link.IconLocation = ExePath + ",0";
            link.Description = "Read, highlight, write, sign and organise PDFs";
            link.Save();
            Marshal.FinalReleaseComObject(link);
            Marshal.FinalReleaseComObject(shell);
        }

        static void RegisterUninstall()
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                key.SetValue("DisplayName", AppName);
                key.SetValue("DisplayVersion", Version);
                key.SetValue("Publisher", "Pagewise");
                key.SetValue("DisplayIcon", "\"" + ExePath + "\",0");
                key.SetValue("InstallLocation", InstallDir);
                key.SetValue("UninstallString", "\"" + UninstallerPath + "\" /uninstall");
                key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
                key.SetValue("EstimatedSize", (int)(DirectorySize(InstallDir) / 1024), RegistryValueKind.DWord);
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        static void RegisterPdf()
        {
            string open = "\"" + ExePath + "\" \"%1\"";
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Pagewise.PDF"))
            {
                key.SetValue("", "PDF Document");
                key.SetValue("FriendlyTypeName", "PDF Document");
            }
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Pagewise.PDF\DefaultIcon"))
                key.SetValue("", "\"" + ExePath + "\",0");
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Pagewise.PDF\shell\open\command"))
                key.SetValue("", open);
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\.pdf\OpenWithProgids"))
                key.SetValue("Pagewise.PDF", new byte[0], RegistryValueKind.None);
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Applications\Pagewise.exe"))
                key.SetValue("FriendlyAppName", AppName);
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Applications\Pagewise.exe\SupportedTypes"))
                key.SetValue(".pdf", "");
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Classes\Applications\Pagewise.exe\shell\open\command"))
                key.SetValue("", open);
            // Lists Pagewise in Settings > Apps > Default apps.
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Pagewise\Capabilities"))
            {
                key.SetValue("ApplicationName", AppName);
                key.SetValue("ApplicationDescription", "Read, highlight, write, sign and organise PDFs");
            }
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Pagewise\Capabilities\FileAssociations"))
                key.SetValue(".pdf", "Pagewise.PDF");
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications"))
                key.SetValue("Pagewise", @"Software\Pagewise\Capabilities");
        }

        // ------------------------------------------------------------ uninstall

        public static void Uninstall(bool removeData, Action<float, string> progress)
        {
            progress(0.1f, "Removing shortcuts…");
            TryDelete(StartMenuShortcut);
            TryDelete(DesktopShortcut);

            progress(0.3f, "Removing Windows settings…");
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\Pagewise.PDF", false);
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\Classes\Applications\Pagewise.exe", false);
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\Pagewise", false);
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Classes\.pdf\OpenWithProgids", true))
                if (key != null) key.DeleteValue("Pagewise.PDF", false);
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications", true))
                if (key != null) key.DeleteValue("Pagewise", false);
            SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);

            progress(0.6f, "Removing files…");
            DeleteDirectory(InstallDir);
            string local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pagewise");
            // Unpacked reader files: only when no Pagewise at all is running
            // (a separately downloaded copy could be using them).
            bool anyRunning = Process.GetProcessesByName("Pagewise").Length > 0;
            if (Directory.Exists(local) && !anyRunning)
            {
                foreach (string dir in Directory.GetDirectories(local, "build-*")) DeleteDirectory(dir);
            }
            if (removeData && !anyRunning)
            {
                progress(0.8f, "Removing your settings…");
                DeleteDirectory(local);
                DeleteDirectory(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Pagewise"));
            }
            progress(1f, "Done");
        }

        // The temporary uninstaller deletes itself once it has closed.
        public static void ScheduleSelfDelete()
        {
            string self = Assembly.GetExecutingAssembly().Location;
            if (!self.StartsWith(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase)) return;
            Process.Start(new ProcessStartInfo("cmd.exe", "/c ping 127.0.0.1 -n 3 > nul & del /f /q \"" + self + "\"")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden,
            });
        }

        // ------------------------------------------------------------ helpers

        public static List<Process> RunningPagewises()
        {
            List<Process> running = new List<Process>();
            foreach (Process p in Process.GetProcessesByName("Pagewise"))
            {
                try
                {
                    if (string.Equals(p.MainModule.FileName, ExePath, StringComparison.OrdinalIgnoreCase)) running.Add(p);
                }
                catch { }
            }
            return running;
        }

        public static bool IsInstalled { get { return File.Exists(ExePath); } }

        static long DirectorySize(string dir)
        {
            long size = 0;
            foreach (string file in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
            {
                try { size += new FileInfo(file).Length; } catch { }
            }
            return size;
        }

        static void TryDelete(string file)
        {
            try { if (File.Exists(file)) File.Delete(file); } catch { }
        }

        static void DeleteDirectory(string dir)
        {
            for (int attempt = 0; attempt < 5 && Directory.Exists(dir); attempt++)
            {
                try { Directory.Delete(dir, true); }
                catch { Thread.Sleep(400); }
            }
        }

        [DllImport("shell32.dll")]
        static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        public static void DarkTitleBar(IntPtr handle, bool dark)
        {
            try
            {
                int value = dark ? 1 : 0;
                DwmSetWindowAttribute(handle, 20, ref value, sizeof(int));
            }
            catch { }
        }
    }

    // ---------------------------------------------------------------- window

    class SetupForm : Form
    {
        readonly Palette P = Palette.ForSystemTheme();
        static float ScreenScale()
        {
            using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) return g.DpiX / 96f;
        }
        readonly bool uninstallMode;
        readonly Image logo;
        readonly Panel page = new Panel();
        bool busy;
        bool openPdfs;

        public SetupForm(bool uninstall)
        {
            uninstallMode = uninstall;
            P.Scale = ScreenScale();
            Text = uninstall ? "Uninstall Pagewise" : "Pagewise Setup";
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.None; // sizes are scaled by hand (P.S)
            ClientSize = new Size(P.S(600), P.S(400));
            BackColor = P.Back;
            Font = new Font(Setup.UiFont, 10f);
            DoubleBuffered = true;

            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("Setup.icon.ico"))
            {
                Icon = new Icon(s);
            }
            logo = LargestIconFrame("Setup.icon.ico");

            page.Dock = DockStyle.Fill;
            page.BackColor = P.Back;
            Controls.Add(page);

            if (uninstall) ShowUninstallConfirm(); else ShowWelcome();
        }

        // The .ico stores PNG frames, which Icon.ToBitmap can't read; take the
        // largest frame's PNG directly from the icon's directory.
        static Image LargestIconFrame(string resource)
        {
            byte[] ico;
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(resource))
            using (MemoryStream m = new MemoryStream())
            {
                s.CopyTo(m);
                ico = m.ToArray();
            }
            int count = BitConverter.ToUInt16(ico, 4);
            int best = -1, bestSize = 0;
            for (int i = 0; i < count; i++)
            {
                int entry = 6 + 16 * i;
                int size = ico[entry] == 0 ? 256 : ico[entry];
                if (size > bestSize) { bestSize = size; best = entry; }
            }
            int length = BitConverter.ToInt32(ico, best + 8);
            int offset = BitConverter.ToInt32(ico, best + 12);
            return Image.FromStream(new MemoryStream(ico, offset, length));
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Setup.DarkTitleBar(Handle, P.Dark);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (busy) { e.Cancel = true; return; } // don't stop half-way
            base.OnFormClosing(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            if (uninstallMode) Setup.ScheduleSelfDelete();
            base.OnFormClosed(e);
        }

        // ------------------------------------------------------------ layout helpers

        void Clear()
        {
            page.Controls.Clear();
        }

        // Logo, big title and a line under it.
        void Header(string title, string subtitle)
        {
            PictureBox picture = new PictureBox
            {
                Image = logo,
                SizeMode = PictureBoxSizeMode.Zoom,
                Size = new Size(P.S(68), P.S(68)),
                Location = new Point(P.S(40), P.S(40)),
                BackColor = Color.Transparent,
            };
            page.Controls.Add(picture);
            TextBlock heading = new TextBlock(title, new Font(Setup.UiFont, 22f, FontStyle.Bold), P.Text)
            {
                Location = new Point(P.S(128), P.S(40)),
                Size = new Size(P.S(430), P.S(44)),
            };
            page.Controls.Add(heading);
            TextBlock sub = new TextBlock(subtitle, new Font(Setup.UiFont, 10.5f), P.Muted)
            {
                Location = new Point(P.S(130), P.S(86)),
                Size = new Size(P.S(430), P.S(44)),
            };
            page.Controls.Add(sub);
        }

        PillButton Button(string text, bool primary, int right, EventHandler click)
        {
            PillButton b = new PillButton(P, text, primary);
            b.Location = new Point(ClientSize.Width - right - b.Width, ClientSize.Height - P.S(40) - b.Height);
            b.Click += click;
            page.Controls.Add(b);
            return b;
        }

        TextBlock Note(string text, int y)
        {
            TextBlock note = new TextBlock(text, new Font(Setup.UiFont, 9.5f), P.Muted)
            {
                Location = new Point(P.S(40), P.S(y)),
                Size = new Size(P.S(520), P.S(40)),
            };
            page.Controls.Add(note);
            return note;
        }

        // ------------------------------------------------------------ pages

        void ShowWelcome()
        {
            Clear();
            bool update = Setup.IsInstalled;
            Header("Pagewise", "Read, highlight, write, sign and organise your PDFs.\nVersion " + Setup.Version);

            Switch desktop = new Switch(P, "Add a shortcut to the desktop", !update || File.Exists(Setup.DesktopShortcut))
            {
                Location = new Point(P.S(40), P.S(168)),
            };
            Switch pdfs = new Switch(P, "Use Pagewise to open PDF files", true)
            {
                Location = new Point(P.S(40), P.S(210)),
            };
            page.Controls.Add(desktop);
            page.Controls.Add(pdfs);
            Note("Installs for " + Environment.UserName + " only. No administrator rights needed.\n" + Setup.InstallDir, 268);

            PillButton install = Button(update ? "Update" : "Install", true, P.S(40), delegate { StartInstall(desktop.Checked, pdfs.Checked); });
            Button("Cancel", false, P.S(52) + install.Width, delegate { Close(); });
            AcceptButton = null;
            install.Select();
        }

        void StartInstall(bool desktopShortcut, bool pdfs)
        {
            if (!CloseRunningPagewise()) return;
            openPdfs = pdfs;
            RunWork("Installing Pagewise…", delegate (Action<float, string> progress)
            {
                Setup.Install(desktopShortcut, pdfs, progress);
            }, ShowDone);
        }

        void ShowDone()
        {
            Clear();
            Header("Pagewise is ready", "Find it in the Start menu" + (File.Exists(Setup.DesktopShortcut) ? " and on your desktop." : "."));
            if (openPdfs)
            {
                Note("To open PDFs with Pagewise when you double-click them, choose Pagewise as the default PDF app in Settings.", 168);
                LinkLabel link = new LinkLabel
                {
                    Text = "Open Default apps settings",
                    Location = new Point(P.S(40), P.S(212)),
                    AutoSize = true,
                    LinkColor = P.Accent,
                    ActiveLinkColor = P.Accent,
                    BackColor = Color.Transparent,
                    Font = new Font(Setup.UiFont, 10f),
                    LinkBehavior = LinkBehavior.HoverUnderline,
                };
                link.LinkClicked += delegate
                {
                    try { Process.Start(new ProcessStartInfo("ms-settings:defaultapps?registeredAppUser=Pagewise") { UseShellExecute = true }); }
                    catch { try { Process.Start(new ProcessStartInfo("ms-settings:defaultapps") { UseShellExecute = true }); } catch { } }
                };
                page.Controls.Add(link);
            }
            PillButton open = Button("Open Pagewise", true, P.S(40), delegate
            {
                try { Process.Start(new ProcessStartInfo(Setup.ExePath) { UseShellExecute = true, WorkingDirectory = Setup.InstallDir }); } catch { }
                Close();
            });
            Button("Close", false, P.S(52) + open.Width, delegate { Close(); });
            open.Select();
        }

        void ShowUninstallConfirm()
        {
            Clear();
            Header("Uninstall Pagewise?", "Pagewise will be removed from this PC. Your PDF files aren't affected.");
            Switch data = new Switch(P, "Also remove recent files and settings", false)
            {
                Location = new Point(P.S(40), P.S(168)),
            };
            page.Controls.Add(data);
            PillButton remove = Button("Uninstall", true, P.S(40), delegate
            {
                if (!CloseRunningPagewise()) return;
                RunWork("Uninstalling Pagewise…", delegate (Action<float, string> progress)
                {
                    Setup.Uninstall(data.Checked, progress);
                }, ShowUninstalled);
            });
            Button("Cancel", false, P.S(52) + remove.Width, delegate { Close(); });
            remove.Select();
        }

        void ShowUninstalled()
        {
            Clear();
            Header("Pagewise has been removed", "Thanks for using Pagewise.");
            Button("Close", true, P.S(40), delegate { Close(); }).Select();
        }

        void ShowError(string message)
        {
            Clear();
            Header("Something went wrong", message);
            Button("Close", true, P.S(40), delegate { Close(); }).Select();
        }

        // Progress page while work runs on a background thread.
        void RunWork(string title, Action<Action<float, string>> work, Action done)
        {
            Clear();
            Header(title, "This only takes a moment.");
            ThinProgress bar = new ThinProgress(P) { Location = new Point(P.S(40), P.S(178)), Size = new Size(P.S(520), P.S(8)) };
            TextBlock status = new TextBlock("", new Font(Setup.UiFont, 9.5f), P.Muted)
            {
                Location = new Point(P.S(40), P.S(196)),
                Size = new Size(P.S(520), P.S(24)),
            };
            page.Controls.Add(bar);
            page.Controls.Add(status);
            busy = true;

            Thread thread = new Thread(delegate ()
            {
                Exception failure = null;
                try
                {
                    work(delegate (float value, string text)
                    {
                        BeginInvoke((MethodInvoker)delegate { bar.Value = value; status.Text = text; });
                    });
                    Thread.Sleep(350); // let the bar reach the end
                }
                catch (Exception ex)
                {
                    failure = ex;
                }
                BeginInvoke((MethodInvoker)delegate
                {
                    busy = false;
                    if (failure != null) ShowError(failure.Message); else done();
                });
            });
            thread.IsBackground = true;
            thread.Start();
        }

        // Pagewise must be closed to replace or remove it. Closing it the normal
        // way lets it ask about unsaved changes.
        bool CloseRunningPagewise()
        {
            List<Process> running = Setup.RunningPagewises();
            if (running.Count == 0) return true;
            DialogResult answer = MessageBox.Show(this,
                "Pagewise is open. Close it now to continue?\n\nIf you have unsaved changes, Pagewise will ask you about them first.",
                Text, MessageBoxButtons.OKCancel, MessageBoxIcon.Information);
            if (answer != DialogResult.OK) return false;
            foreach (Process p in running)
            {
                try { p.CloseMainWindow(); } catch { }
            }
            DateTime until = DateTime.Now.AddSeconds(60);
            while (DateTime.Now < until && Setup.RunningPagewises().Count > 0)
            {
                Application.DoEvents();
                Thread.Sleep(200);
            }
            if (Setup.RunningPagewises().Count > 0)
            {
                MessageBox.Show(this, "Pagewise is still open. Close it, then try again.", Text,
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return false;
            }
            return true;
        }
    }
}
