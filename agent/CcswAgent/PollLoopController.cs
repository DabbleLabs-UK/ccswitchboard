namespace CcswAgent;

// Wraps a cancellable background loop so a tray menu can Start/Stop/Restart
// it without tearing down the whole process (the tray icon and its message
// loop must keep running regardless of whether the poll loop is active).
//
// Runs workerCount independent instances of loopBody concurrently, all
// sharing the one CancellationTokenSource, so a single Start/Stop/Restart
// controls every worker at once from the one tray icon. Each worker polls
// and runs its own job in parallel -- AgentCore itself holds no per-job
// mutable state shared across workers (just a thread-safe HttpClient), so
// running loopBody concurrently on the same AgentCore instance is safe.
internal sealed class PollLoopController
{
    private readonly Func<int, CancellationToken, Task> _loopBody;
    private readonly int _workerCount;
    private CancellationTokenSource? _cts;
    private Task[]? _runningTasks;

    public PollLoopController(Func<int, CancellationToken, Task> loopBody, int workerCount)
    {
        _loopBody = loopBody;
        _workerCount = Math.Max(1, workerCount);
    }

    public bool IsRunning => _cts is not null && !_cts.IsCancellationRequested;

    public void Start()
    {
        if (IsRunning)
        {
            return;
        }

        _cts = new CancellationTokenSource();
        var token = _cts.Token;
        _runningTasks = Enumerable.Range(0, _workerCount)
            .Select(workerId => _loopBody(workerId, token))
            .ToArray();
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
            // Bounded wait so a slow-to-cancel iteration (e.g. mid job) can't
            // hang the tray click handler forever; Start() below is a no-op
            // anyway once the old loop's cancellation actually lands.
            if (_runningTasks is not null)
            {
                Task.WaitAll(_runningTasks, TimeSpan.FromSeconds(5));
            }
        }
        catch
        {
            // Expected: the loop tasks complete via OperationCanceledException.
        }
        Start();
    }
}
