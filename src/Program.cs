// Pagewise for Windows: entry point.
//
// Pagewise.exe is a single file. It carries the reader (PDF.js + the shared
// engine + the desktop interface) and Microsoft's WebView2 libraries as an
// embedded zip, unpacked once per build to %LOCALAPPDATA%\Pagewise\build-<id>.
// The window itself is MainForm (WinForms + Edge WebView2, which is part of
// Windows 10/11).

using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Pagewise
{
    static class Program
    {
        public const string Version = "1.2.0";

        internal static string LocalDir;   // %LOCALAPPDATA%\Pagewise
        internal static string BuildDir;   // unpacked payload for this build
        internal static string AppDir;     // web files
        internal static string BinDir;     // WebView2 libraries
        internal static string DataDir;    // %APPDATA%\Pagewise (recent files, window size)

        static readonly string PipeName = "Pagewise.PdfReader.Open." + Environment.UserName;

        // Testing: PAGEWISE_DEBUG_PORT=<port> starts a separate instance with
        // DevTools on that port and its own data, so it never touches a
        // Pagewise window you already have open.
        internal static readonly string DebugPort = Environment.GetEnvironmentVariable("PAGEWISE_DEBUG_PORT");
        internal static string WebViewDataDir;

        [STAThread]
        static void Main(string[] args)
        {
            Mutex mutex = null;
            if (DebugPort == null && Array.IndexOf(args, "--prepare") < 0)
            {
                bool firstInstance;
                mutex = new Mutex(true, "Pagewise.PdfReader.Instance." + Environment.UserName, out firstInstance);
                if (!firstInstance && SendToRunningInstance(args))
                {
                    return;
                }
            }

            string suffix = DebugPort == null ? "" : "-debug";
            LocalDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pagewise");
            DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Pagewise" + suffix);
            WebViewDataDir = Path.Combine(LocalDir, "WebView2" + suffix);
            ImportFromMargin();
            Directory.CreateDirectory(DataDir);

            // "--prepare": unpack and exit (the installer does this, so the
            // first launch is as quick as every other).
            bool prepareOnly = Array.IndexOf(args, "--prepare") >= 0;
            try
            {
                UnpackPayload();
            }
            catch (Exception e)
            {
                if (!prepareOnly)
                {
                    MessageBox.Show("Pagewise couldn't prepare its files:\n\n" + e.Message, "Pagewise",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                Environment.ExitCode = 1;
                return;
            }
            if (prepareOnly)
            {
                return;
            }

            CleanOldBuilds();
            AppDomain.CurrentDomain.AssemblyResolve += ResolveFromBin;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Run(args);
            GC.KeepAlive(mutex);
        }

        // Kept separate so the WebView2 types are only loaded after
        // AssemblyResolve is in place.
        [MethodImpl(MethodImplOptions.NoInlining)]
        static void Run(string[] args)
        {
            MainForm form = new MainForm(ToFullPaths(args));
            if (DebugPort == null)
            {
                StartPipeServer(form);
            }
            Application.Run(form);
        }

        // Pagewise was called Margin before 1.1: keep its recent files and
        // window size the first time Pagewise runs.
        static void ImportFromMargin()
        {
            string old = Path.Combine(Path.GetDirectoryName(DataDir), "Margin");
            if (DebugPort != null || Directory.Exists(DataDir) || !Directory.Exists(old)) return;
            try
            {
                Directory.CreateDirectory(DataDir);
                foreach (string file in Directory.GetFiles(old))
                {
                    File.Copy(file, Path.Combine(DataDir, Path.GetFileName(file)), false);
                }
            }
            catch { }
        }

        static List<string> ToFullPaths(string[] args)
        {
            List<string> paths = new List<string>();
            foreach (string arg in args)
            {
                if (arg.StartsWith("-")) continue;
                try { paths.Add(Path.GetFullPath(arg)); } catch { }
            }
            return paths;
        }

        // ------------------------------------------------------------ payload

        static void UnpackPayload()
        {
            Assembly self = Assembly.GetExecutingAssembly();
            string stamp;
            using (Stream s = self.GetManifestResourceStream("Pagewise.build.txt"))
            using (StreamReader reader = new StreamReader(s))
            {
                stamp = reader.ReadToEnd().Trim();
            }
            BuildDir = Path.Combine(LocalDir, "build-" + stamp);
            AppDir = Path.Combine(BuildDir, "app");
            BinDir = Path.Combine(BuildDir, "bin");
            if (File.Exists(Path.Combine(BuildDir, ".complete")))
            {
                return;
            }

            string temp = BuildDir + ".tmp-" + Guid.NewGuid().ToString("N").Substring(0, 8);
            using (Stream s = self.GetManifestResourceStream("Pagewise.payload.zip"))
            using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    if (entry.FullName.EndsWith("/")) continue;
                    string target = Path.GetFullPath(Path.Combine(temp, entry.FullName));
                    if (!target.StartsWith(temp, StringComparison.OrdinalIgnoreCase)) continue;
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    entry.ExtractToFile(target, true);
                }
            }
            File.WriteAllText(Path.Combine(temp, ".complete"), Version);
            if (Directory.Exists(BuildDir))
            {
                Directory.Delete(BuildDir, true);
            }
            Directory.Move(temp, BuildDir);
        }

        // Removes files of older builds (left behind by updates), but only
        // when no other Pagewise is running: it may be an older version using
        // them. Runs in the background so it never delays the window.
        static void CleanOldBuilds()
        {
            if (DebugPort != null) return;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    if (System.Diagnostics.Process.GetProcessesByName("Pagewise").Length > 1) return;
                    foreach (string dir in Directory.GetDirectories(LocalDir, "build-*"))
                    {
                        if (!string.Equals(dir, BuildDir, StringComparison.OrdinalIgnoreCase))
                        {
                            try { Directory.Delete(dir, true); } catch { }
                        }
                    }
                }
                catch { }
            });
        }

        static Assembly ResolveFromBin(object sender, ResolveEventArgs e)
        {
            string name = new AssemblyName(e.Name).Name + ".dll";
            string path = Path.Combine(BinDir, name);
            return File.Exists(path) ? Assembly.LoadFrom(path) : null;
        }

        // ------------------------------------------------------------ single instance

        // A second Pagewise.exe (e.g. "Open with" from Explorer) hands its files
        // to the running window, which opens them as tabs.
        static bool SendToRunningInstance(string[] args)
        {
            try
            {
                using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", PipeName, PipeDirection.Out))
                {
                    pipe.Connect(3000);
                    byte[] data = Encoding.UTF8.GetBytes(string.Join("\n", ToFullPaths(args).ToArray()));
                    pipe.Write(data, 0, data.Length);
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        static void StartPipeServer(MainForm form)
        {
            Thread thread = new Thread(delegate ()
            {
                while (true)
                {
                    try
                    {
                        using (NamedPipeServerStream pipe = new NamedPipeServerStream(PipeName, PipeDirection.In))
                        {
                            pipe.WaitForConnection();
                            using (StreamReader reader = new StreamReader(pipe, Encoding.UTF8))
                            {
                                string text = reader.ReadToEnd();
                                List<string> paths = new List<string>();
                                foreach (string line in text.Split('\n'))
                                {
                                    if (line.Trim().Length > 0) paths.Add(line.Trim());
                                }
                                form.BeginInvoke((MethodInvoker)delegate { form.OpenFromOutside(paths); });
                            }
                        }
                    }
                    catch
                    {
                        Thread.Sleep(500);
                    }
                }
            });
            thread.IsBackground = true;
            thread.Start();
        }
    }
}
