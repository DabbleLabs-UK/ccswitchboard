// Wraps a cancellable background loop so a tray menu can Start/Stop/Restart
// it without tearing down the whole process (the tray icon and popup UI
// thread must keep running regardless of whether the poll loop is active).
internal sealed class PollLoopController
{
    private readonly Func<CancellationToken, Task> _loopBody;
    private CancellationTokenSource? _cts;
    private Task? _runningTask;

    public PollLoopController(Func<CancellationToken, Task> loopBody)
    {
        _loopBody = loopBody;
    }

    public bool IsRunning => _cts is not null && !_cts.IsCancellationRequested;

    public void Start()
    {
        if (IsRunning)
        {
            return;
        }

        _cts = new CancellationTokenSource();
        _runningTask = _loopBody(_cts.Token);
    }

    public void Stop()
    {
        _cts?.Cancel();
    }

    public void Restart()
    {
        Stop();
        try
        {
            // Bounded wait so a slow-to-cancel iteration can't hang the tray
            // click handler forever; Start() below is a no-op anyway until
            // the old loop's cancellation actually lands.
            _runningTask?.Wait(TimeSpan.FromSeconds(5));
        }
        catch
        {
            // Expected: the loop task completes via OperationCanceledException.
        }
        Start();
    }
}
