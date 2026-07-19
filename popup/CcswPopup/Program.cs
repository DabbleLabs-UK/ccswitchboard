using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using WinForms = System.Windows.Forms;

var configPath = Path.Combine(AppContext.BaseDirectory, "popup.config.json");
if (!File.Exists(configPath))
{
    MessageBox.Show($"{configPath} not found. Copy popup.config.example.json and fill in values.",
        "CcswPopup", MessageBoxButton.OK, MessageBoxImage.Error);
    return 1;
}

var config = PopupConfigStore.Load(configPath);
if (config is null || string.IsNullOrWhiteSpace(config.RelayBase))
{
    MessageBox.Show($"{configPath} missing 'relayBase'.",
        "CcswPopup", MessageBoxButton.OK, MessageBoxImage.Error);
    return 1;
}

var relayBase = config.RelayBase.TrimEnd('/');
var currentLogFolder = FileLogger.Initialize(config.LogPath);
using var http = new HttpClient();
// The host's WAF blocks requests with no User-Agent header (HttpClient sends
// none by default, unlike curl), so set one explicitly.
http.DefaultRequestHeaders.UserAgent.ParseAdd("CcswPopup/1.0");
if (!string.IsNullOrWhiteSpace(config.Token))
{
    http.DefaultRequestHeaders.Add("X-CCSW-Token", config.Token);
}

var jsonOptions = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
var seenIds = new HashSet<int>();
var firstPoll = true;

// WPF windows are thread-affine, so all popup work happens on a dedicated STA
// thread with its own Dispatcher; the poll loop below only ever reaches it via
// BeginInvoke. PopupStack itself assumes every call lands on that thread. The
// tray NotifyIcon lives on this same thread too -- WPF's Dispatcher pumps the
// Win32 message loop a NotifyIcon's hidden window needs, so no separate
// WinForms message loop is required.
Dispatcher? uiDispatcher = null;
PopupStack? popupStack = null;
Application? wpfApp = null;
WinForms.NotifyIcon? trayIcon = null;
using var uiReady = new ManualResetEventSlim();

var pollController = new PollLoopController(PollLoopAsync);

var uiThread = new Thread(() =>
{
    var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
    wpfApp = app;
    uiDispatcher = app.Dispatcher;
    popupStack = new PopupStack();
    trayIcon = BuildTrayIcon();
    uiReady.Set();
    app.Run();
});
uiThread.SetApartmentState(ApartmentState.STA);
// Foreground (not background): this thread alone must keep the process alive
// now that the poll loop can be stopped independently of the tray/UI.
uiThread.IsBackground = false;
uiThread.Start();
uiReady.Wait();

pollController.Start();

// Main thread's only remaining job is to wait for the tray's Exit action to
// shut down the WPF Application (which ends app.Run() on the UI thread and
// lets it return), then let the process exit.
uiThread.Join();
return 0;

async Task PollLoopAsync(CancellationToken token)
{
    FileLogger.Log($"Startup: relayBase={relayBase}. Polling {relayBase}/jobs.php every 3s.");
    try
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                var jobsJson = await http.GetStringAsync($"{relayBase}/jobs.php?status=done&limit=50");
                var response = JsonSerializer.Deserialize<JobsResponse>(jobsJson, jsonOptions);

                var doneCount = response?.Jobs?.Count ?? 0;
                var newCount = 0;

                if (response?.Jobs is not null)
                {
                    foreach (var job in response.Jobs)
                    {
                        if (!seenIds.Add(job.Id))
                        {
                            FileLogger.Log($"Job {job.Id} final={job.Final}: skipped (already seen).");
                            continue;
                        }

                        newCount++;

                        // On the very first poll, seed seenIds with whatever is already
                        // done so startup doesn't dump the whole backlog -- only jobs
                        // that finish AFTER the popup starts get printed.
                        if (firstPoll)
                        {
                            FileLogger.Log($"Job {job.Id} final={job.Final}: skipped (seeded on first poll).");
                            continue;
                        }

                        if (!job.Final)
                        {
                            FileLogger.Log($"Job {job.Id} final={job.Final}: skipped (non-final, no popup).");
                            continue;
                        }

                        FileLogger.Log($"Job {job.Id} final={job.Final}: popped.");
                        var header = BuildPopupText(job.Id, job.Result, job.Name, job.Thread);
                        _ = uiDispatcher!.BeginInvoke(() => popupStack!.Add(header, job.Thread, RequestFocus));
                    }
                }

                FileLogger.Log($"Poll: {doneCount} done job(s) returned, {newCount} new/unseen.");

                firstPoll = false;
            }
            catch (Exception ex)
            {
                FileLogger.Log($"Poll error: {ex.Message}");
            }

            await Task.Delay(TimeSpan.FromSeconds(3), token);
        }
    }
    catch (OperationCanceledException)
    {
        FileLogger.Log("Poll loop stopped.");
    }
}

WinForms.NotifyIcon BuildTrayIcon()
{
    var startItem = new WinForms.ToolStripMenuItem("Start");
    var stopItem = new WinForms.ToolStripMenuItem("Stop");
    var restartItem = new WinForms.ToolStripMenuItem("Restart");
    WinForms.NotifyIcon? icon = null;

    void RefreshMenuState()
    {
        var running = pollController.IsRunning;
        startItem.Enabled = !running;
        stopItem.Enabled = running;
        restartItem.Enabled = running;
        if (icon is not null)
        {
            icon.Text = running ? "CcswPopup (running)" : "CcswPopup (stopped)";
        }
    }

    startItem.Click += (_, _) => { pollController.Start(); RefreshMenuState(); };
    stopItem.Click += (_, _) => { pollController.Stop(); RefreshMenuState(); };
    restartItem.Click += (_, _) => { pollController.Restart(); RefreshMenuState(); };

    var menu = new WinForms.ContextMenuStrip();
    menu.Items.Add(startItem);
    menu.Items.Add(stopItem);
    menu.Items.Add(restartItem);
    menu.Items.Add(new WinForms.ToolStripSeparator());
    menu.Items.Add("Settings...", null, (_, _) => OpenSettings());
    menu.Items.Add(new WinForms.ToolStripSeparator());
    menu.Items.Add("Register at startup", null, async (_, _) => await RunAutostartAction("register-popup-task.ps1", includeExePath: true));
    menu.Items.Add("Unregister from startup", null, async (_, _) => await RunAutostartAction("unregister-popup-task.ps1", includeExePath: false));
    menu.Items.Add(new WinForms.ToolStripSeparator());
    menu.Items.Add("Exit", null, (_, _) => ExitApp());
    menu.Opening += (_, _) => RefreshMenuState();

    icon = new WinForms.NotifyIcon
    {
        Icon = LoadTintedIcon(Path.Combine(AppContext.BaseDirectory, "tray-icon.png")),
        Text = "CcswPopup",
        Visible = true,
        ContextMenuStrip = menu,
    };
    RefreshMenuState();
    return icon;
}

async Task RunAutostartAction(string scriptName, bool includeExePath)
{
    var args = includeExePath
        ? new[] { "-ExePath", Process.GetCurrentProcess().MainModule?.FileName ?? Environment.ProcessPath ?? "" }
        : Array.Empty<string>();

    var (success, message) = await AutostartTask.RunScriptAsync(scriptName, args);

    trayIcon!.BalloonTipTitle = success ? "CcswPopup" : "CcswPopup - error";
    trayIcon.BalloonTipText = message.Length > 200 ? message[..200] + "..." : message;
    trayIcon.BalloonTipIcon = success ? WinForms.ToolTipIcon.Info : WinForms.ToolTipIcon.Error;
    trayIcon.ShowBalloonTip(5000);
}

void OpenSettings()
{
    // Re-resolve fresh (same LogPathResolver used at startup) rather than
    // trusting the cached currentLogFolder, so the dialog always shows
    // where logs are actually landing right now.
    var activeLogFolder = LogPathResolver.Resolve(config.LogPath, out _);
    var window = new SettingsWindow(activeLogFolder, TrySaveLogPath);
    window.ShowDialog();
}

string? TrySaveLogPath(string text)
{
    var candidate = string.IsNullOrWhiteSpace(text) ? LogPathResolver.DefaultFolder : text;
    var error = LogPathResolver.TryValidate(candidate);
    if (error is not null)
    {
        return $"Can't write to \"{candidate}\":\n{error}\n\nChoose a different folder.";
    }

    config = config with { LogPath = candidate };
    PopupConfigStore.Save(configPath, config);
    currentLogFolder = FileLogger.Initialize(candidate);
    FileLogger.Log($"Settings saved: logPath={currentLogFolder}.");
    return null;
}

void ExitApp()
{
    pollController.Stop();
    trayIcon!.Visible = false;
    trayIcon.Dispose();
    wpfApp!.Shutdown();
}

// NotifyIcon needs a GDI icon handle, not a Bitmap -- GetHicon() converts the
// tinted PNG, but the returned handle is caller-owned (not tracked by the
// CLR), so it's cloned into a GDI+-managed Icon and the raw handle destroyed
// immediately after, avoiding a GDI handle leak.
System.Drawing.Icon LoadTintedIcon(string path)
{
    using var bmp = new System.Drawing.Bitmap(path);
    var hIcon = bmp.GetHicon();
    try
    {
        using var handleIcon = System.Drawing.Icon.FromHandle(hIcon);
        return (System.Drawing.Icon)handleIcon.Clone();
    }
    finally
    {
        NativeMethods.DestroyIcon(hIcon);
    }
}

string BuildPopupText(int id, string result, string? name, string? thread)
{
    var isErrorResult = result.StartsWith("ERROR:", StringComparison.Ordinal)
        || result.StartsWith("TIMEOUT:", StringComparison.Ordinal)
        || result.StartsWith("LAUNCH-ERROR:", StringComparison.Ordinal);

    var jobLabel = string.IsNullOrWhiteSpace(name) ? $"Job {id}" : name;
    var statusText = isErrorResult ? "Needs input" : "Completed";
    return string.IsNullOrWhiteSpace(thread) ? $"{statusText} {jobLabel}" : $"{statusText} ({thread}) {jobLabel}";
}

// The extension's chrome.windows.update({focused:true}) can select the right
// tab within Brave but can't steal foreground from another app -- Windows'
// foreground-lock blocks extensions from doing that. This popup app just
// received the user's actual click, so it holds the legitimate "last input"
// state Windows requires before it'll hand off foreground, and
// SetForegroundWindow works from here where it wouldn't from the extension.
// Still POSTs the focus request too, so the extension picks the right tab
// once Brave itself is in front.
void RequestFocus(string thread)
{
    RaiseBrave();
    _ = PostFocusRequest(thread);
}

void RaiseBrave()
{
    try
    {
        var hWnd = FindBraveWindow();
        if (hWnd == IntPtr.Zero)
        {
            FileLogger.Log("No Brave window found to raise.");
            return;
        }

        var className = new StringBuilder(256);
        NativeMethods.GetClassName(hWnd, className, className.Capacity);
        NativeMethods.GetWindowThreadProcessId(hWnd, out var pid);
        var processName = "<unknown>";
        try
        {
            using var proc = Process.GetProcessById((int) pid);
            processName = proc.ProcessName;
        }
        catch
        {
            // process may have exited between FindBraveWindow and here
        }
        FileLogger.Log($"Raising hWnd={hWnd} class=\"{className}\" process={processName} pid={pid}.");

        var ok = NativeMethods.SetForegroundWindow(hWnd);
        FileLogger.Log($"SetForegroundWindow on Brave {(ok ? "succeeded" : "failed")}.");
    }
    catch (Exception ex)
    {
        FileLogger.Log($"Failed to raise Brave: {ex.Message}");
    }
}

// Walks top-level windows in Z-order (EnumWindows enumerates topmost first)
// and returns the first visible one that's both a Chromium top-level frame
// (class name "Chrome_WidgetWin*") and owned by a "brave" process -- i.e.
// whichever Brave window was most recently in front, since Brave may have
// more than one window open.
IntPtr FindBraveWindow()
{
    var found = IntPtr.Zero;

    NativeMethods.EnumWindows((hWnd, _) =>
    {
        if (!NativeMethods.IsWindowVisible(hWnd))
        {
            return true;
        }

        var className = new StringBuilder(256);
        NativeMethods.GetClassName(hWnd, className, className.Capacity);
        if (!className.ToString().StartsWith("Chrome_WidgetWin", StringComparison.Ordinal))
        {
            return true;
        }

        NativeMethods.GetWindowThreadProcessId(hWnd, out var pid);
        try
        {
            using var proc = Process.GetProcessById((int) pid);
            if (!string.Equals(proc.ProcessName, "brave", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        catch
        {
            return true;
        }

        found = hWnd;
        return false;
    }, IntPtr.Zero);

    return found;
}

async Task PostFocusRequest(string thread)
{
    try
    {
        var body = JsonSerializer.Serialize(new { thread });
        using var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
        await http.PostAsync($"{relayBase}/focus_request.php", content);
        FileLogger.Log($"Requested focus for thread \"{thread}\".");
    }
    catch (Exception ex)
    {
        FileLogger.Log($"Focus request failed for thread \"{thread}\": {ex.Message}");
    }
}

record PopupConfig(string RelayBase, string? LogPath = null, string? Token = null);
record JobsResponse(List<JobSummary> Jobs);
record JobSummary(int Id, string Status, string Result, string? Thread, string? Name, bool Final, string UpdatedAt);

// Console.WriteLine goes nowhere in a WPF app with no attached console, so
// every log line is mirrored to a plain-text file next to the exe. Appends
// are serialized with a lock since the poll loop and UI thread both log.
static class FileLogger
{
    private static string _logFilePath = Path.Combine(AppContext.BaseDirectory, "popup.log");
    private static readonly object WriteLock = new();

    // Resolves the configured folder (falling back to the per-user default,
    // then next to the exe -- see LogPathResolver) and points future Log()
    // calls at popup.log inside it. Returns the folder actually chosen.
    public static string Initialize(string? configuredFolder)
    {
        var folder = LogPathResolver.Resolve(configuredFolder, out var warning);
        lock (WriteLock)
        {
            _logFilePath = Path.Combine(folder, "popup.log");
        }
        if (warning is not null)
        {
            Log(warning);
        }
        return folder;
    }

    public static void Log(string message)
    {
        var line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {message}";
        Console.WriteLine(line);
        try
        {
            lock (WriteLock)
            {
                File.AppendAllText(_logFilePath, line + Environment.NewLine);
            }
        }
        catch
        {
            // best-effort; a locked/unwritable log file shouldn't crash the poll loop
        }
    }
}

static class NativeMethods
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr handle);
}

// Manages a vertical stack of popup windows down from the top-right corner of
// the primary screen. Every member here must only be touched from the UI
// thread that owns the Dispatcher the windows were created on.
class PopupStack
{
    private const double Width = 340;
    private const double Margin = 16;
    private const double Gap = 10;
    private static readonly TimeSpan SlideDuration = TimeSpan.FromMilliseconds(200);

    private readonly List<Window> _active = new();

    public void Add(string header, string? thread, Action<string> requestFocus)
    {
        var window = BuildWindow(header);

        // Hidden until positioned in Loaded, so it never flashes at the
        // default (0,0)-ish location before its slot is computed.
        window.Opacity = 0;
        window.Left = SystemParameters.WorkArea.Right - Width - Margin;
        window.Top = SystemParameters.WorkArea.Top + Margin;

        window.MouseLeftButtonUp += (_, _) =>
        {
            FileLogger.Log($"Popup clicked: thread=\"{thread}\" header=\"{header}\".");
            if (!string.IsNullOrEmpty(thread))
            {
                requestFocus(thread);
            }
            window.Close();
        };
        window.Loaded += (_, _) =>
        {
            var top = SystemParameters.WorkArea.Top + Margin;
            foreach (var w in _active)
            {
                top += w.ActualHeight + Gap;
            }
            window.Top = top;
            window.Opacity = 1;
            _active.Add(window);
        };
        window.Closed += (_, _) =>
        {
            _active.Remove(window);
            Relayout();
        };

        window.Show();
    }

    private void Relayout()
    {
        var top = SystemParameters.WorkArea.Top + Margin;
        foreach (var w in _active)
        {
            AnimateTop(w, top);
            top += w.ActualHeight + Gap;
        }
    }

    private static void AnimateTop(Window window, double target)
    {
        if (Math.Abs(window.Top - target) < 0.5)
        {
            return;
        }
        var animation = new DoubleAnimation(window.Top, target, SlideDuration)
        {
            EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut },
        };
        window.BeginAnimation(Window.TopProperty, animation);
    }

    private static Window BuildWindow(string header)
    {
        return new Window
        {
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            ShowInTaskbar = false,
            Topmost = true,
            Width = Width,
            SizeToContent = SizeToContent.Height,
            Background = new SolidColorBrush(Color.FromRgb(0x22, 0x22, 0x22)),
            Cursor = System.Windows.Input.Cursors.Hand,
            Content = new StackPanel
            {
                Margin = new Thickness(16),
                Children =
                {
                    new TextBlock
                    {
                        Text = header,
                        Foreground = Brushes.White,
                        FontWeight = FontWeights.Bold,
                        FontSize = 14,
                        TextWrapping = TextWrapping.Wrap,
                    },
                },
            },
        };
    }
}
