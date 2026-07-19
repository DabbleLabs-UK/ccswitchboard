using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace CcswAgent;

// Hosts the tray icon + context menu. No visible window -- Application.Run
// is driven purely by this ApplicationContext, and the process lives as long
// as the tray icon does (Exit calls Application.Exit()).
internal sealed class TrayAppContext : ApplicationContext
{
    private readonly PollLoopController _controller;
    private readonly int _workerCount;
    private readonly NotifyIcon _trayIcon;
    private readonly ToolStripMenuItem _startItem;
    private readonly ToolStripMenuItem _stopItem;
    private readonly ToolStripMenuItem _restartItem;
    private readonly CancellationTokenSource _heartbeatCts = new();

    public TrayAppContext(AgentCore core, int workerCount)
    {
        _workerCount = Math.Max(1, workerCount);
        _controller = new PollLoopController(core.PollLoopAsync, _workerCount);
        // One heartbeat for the whole tray host, independent of Start/Stop --
        // see HeartbeatLoopAsync's comment for why it must outlive the poll
        // workers being stopped.
        Supervise("heartbeat", core.HeartbeatLoopAsync, _heartbeatCts.Token);
        // Same lifetime, same reasoning: a job picked up before Stop is still
        // talking to its relay, so the primary-relay probe (and any failback)
        // has to keep running while the poll workers are stopped. Shares the
        // heartbeat's CTS -- both die only when the tray host exits.
        Supervise("probe", core.ProbeLoopAsync, _heartbeatCts.Token);

        _startItem = new ToolStripMenuItem("Start", null, (_, _) => { _controller.Start(); RefreshMenuState(); });
        _stopItem = new ToolStripMenuItem("Stop", null, (_, _) => { _controller.Stop(); RefreshMenuState(); });
        _restartItem = new ToolStripMenuItem("Restart", null, (_, _) => { _controller.Restart(); RefreshMenuState(); });

        var menu = new ContextMenuStrip();
        menu.Items.Add(_startItem);
        menu.Items.Add(_stopItem);
        menu.Items.Add(_restartItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Register at startup", null, async (_, _) => await RunAutostartAction("register-agent-task.ps1", includeExePath: true));
        menu.Items.Add("Unregister from startup", null, async (_, _) => await RunAutostartAction("unregister-agent-task.ps1", includeExePath: false));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitApp());
        menu.Opening += (_, _) => RefreshMenuState();

        _trayIcon = new NotifyIcon
        {
            Icon = LoadTintedIcon(Path.Combine(AppContext.BaseDirectory, "tray-icon.png")),
            Text = "CcswAgent",
            Visible = true,
            ContextMenuStrip = menu,
        };

        RefreshMenuState();
        _controller.Start();
    }

    // These two loops used to be started as bare `_ = loop(token)`. A
    // fire-and-forget Task that faults or returns early does so in total
    // silence -- no exception surfaces, no line is logged, and the process
    // carries on looking healthy while a load-bearing loop is simply gone. For
    // the heartbeat that is exactly the false-"agent offline" bug (see
    // AgentCore.HeartbeatLoopAsync's comment): the relay concludes the machine
    // is dead and starts reaping its live jobs.
    //
    // HeartbeatLoopAsync is now internally bulletproof, so this is defence in
    // depth rather than the primary fix -- but "load-bearing loop ended and
    // nobody noticed" is a failure mode that must not be reachable at all. Any
    // exit that isn't a real shutdown is logged and the loop is restarted after
    // a short backoff, forever.
    private static void Supervise(string name, Func<CancellationToken, Task> loop, CancellationToken token)
    {
        _ = Task.Run(async () =>
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    await loop(token);
                    if (token.IsCancellationRequested) break;
                    SafeLog($"[SUPERVISOR] {name} loop returned unexpectedly while still running -- restarting it in {SuperviseRestartDelay.TotalSeconds:0}s.");
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception ex)
                {
                    SafeLog($"[SUPERVISOR] {name} loop FAULTED ({ex.GetType().Name}: {ex.Message}) -- restarting it in {SuperviseRestartDelay.TotalSeconds:0}s.");
                }

                try
                {
                    await Task.Delay(SuperviseRestartDelay, token);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }

            SafeLog($"[SUPERVISOR] {name} loop supervision ended (shutting down).");
        });
    }

    private static readonly TimeSpan SuperviseRestartDelay = TimeSpan.FromSeconds(5);

    // Same reasoning as AgentCore.SafeLog: a supervisor that crashes on a
    // failed log write would defeat its own purpose.
    private static void SafeLog(string line)
    {
        try
        {
            Console.WriteLine(line);
        }
        catch
        {
        }
    }

    private void RefreshMenuState()
    {
        var running = _controller.IsRunning;
        _startItem.Enabled = !running;
        _stopItem.Enabled = running;
        _restartItem.Enabled = running;
        _trayIcon.Text = running ? $"CcswAgent (running, {_workerCount} workers)" : "CcswAgent (stopped)";
    }

    private async Task RunAutostartAction(string scriptName, bool includeExePath)
    {
        var args = includeExePath
            ? new[] { "-ExePath", Process.GetCurrentProcess().MainModule?.FileName ?? Environment.ProcessPath ?? "" }
            : Array.Empty<string>();

        var (success, message) = await AutostartTask.RunScriptAsync(scriptName, args);

        _trayIcon.BalloonTipTitle = success ? "CcswAgent" : "CcswAgent - error";
        _trayIcon.BalloonTipText = message.Length > 200 ? message[..200] + "..." : message;
        _trayIcon.BalloonTipIcon = success ? ToolTipIcon.Info : ToolTipIcon.Error;
        _trayIcon.ShowBalloonTip(5000);
    }

    private void ExitApp()
    {
        _controller.Stop();
        _heartbeatCts.Cancel();
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        Application.Exit();
    }

    // NotifyIcon needs a GDI icon handle, not a Bitmap -- GetHicon() converts
    // the tinted PNG, but the returned handle is caller-owned (not tracked by
    // the CLR), so it's cloned into a GDI+-managed Icon and the raw handle is
    // destroyed immediately after, avoiding a GDI handle leak.
    private static Icon LoadTintedIcon(string path)
    {
        using var bmp = new Bitmap(path);
        var hIcon = bmp.GetHicon();
        try
        {
            using var handleIcon = Icon.FromHandle(hIcon);
            return (Icon)handleIcon.Clone();
        }
        finally
        {
            NativeMethods.DestroyIcon(hIcon);
        }
    }

    private static class NativeMethods
    {
        [DllImport("user32.dll")]
        public static extern bool DestroyIcon(IntPtr handle);
    }
}
