using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace CcswAgent;

// The agent's poll-and-run logic, unchanged from the original console app --
// just moved off top-level statements and into a class so a tray menu can
// Start/Stop/Restart PollLoopAsync via a CancellationToken instead of it
// being the process's entire lifetime.
internal sealed class AgentCore
{
    // Every relay URL and token header goes through here (see RelayRouter):
    // polling follows the active relay and fails over, while each job's
    // append/result/cancel/session traffic stays pinned to the relay that
    // job was polled from.
    private readonly RelayRouter _router;
    private readonly string _bashPath;
    private readonly string _machine;
    // Optional path to a standard Claude Code --mcp-config JSON file (see
    // mcp-config.example.json). Opt-in and per-machine: unset or missing means
    // headless jobs launch with no MCP connectors, same as before this existed.
    private readonly string? _mcpConfigPath;
    // Resolved once at startup (see ResolveClaudeExePath): the real claude.exe,
    // not claude.cmd. cmd.exe re-parses a batch shim's %* and truncates any
    // argument at its first newline, silently chopping multi-paragraph prompts
    // (anything with a blank-line-separated "\n\n") before CC ever sees them.
    // Spawning the exe directly with ArgumentList sidesteps cmd entirely.
    private readonly string _claudeExePath;
    private readonly JsonSerializerOptions _jsonOptions = new() { PropertyNameCaseInsensitive = true };

    // Per-request ceilings. Deliberately short for the two calls that decide
    // whether a relay is alive (poll/heartbeat), so a black-holing relay burns
    // its 3 strikes and fails over in seconds rather than minutes. Job traffic
    // (append/result) keeps a generous window -- a slow-but-alive relay
    // shouldn't lose a job's output.
    private static readonly TimeSpan PollTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan HeartbeatTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan JobRequestTimeout = TimeSpan.FromSeconds(60);
    // Output-silence timeout, not a wall-clock cap: a job that keeps streaming
    // stream-json lines resets this every line and never trips, however long the
    // job runs overall. A job that stops producing output (hung CC process) dies
    // within this window regardless of how long it already ran.
    //
    // 300s (was 90s): CC does not emit output continuously during long internal
    // work -- Opus thinking, or a Gradle/compile sub-process whose output CC
    // buffers and doesn't forward -- so a short silence window false-killed
    // long-but-working jobs (~6 lost in one session, work already complete on
    // disk when the TIMEOUT hit). 300s gives real headroom for that. This is a
    // pragmatic mitigation, not a fix for CC's opacity: a buffered child
    // process's output still produces zero agent-visible bytes, so true
    // process-tree liveness isn't achievable here regardless of the timeout
    // value. The backstop for genuinely wedged/dead jobs is now the relay-side
    // reapWedgedJobs sweep plus the heartbeat reaper for a truly-dead agent, so
    // a longer agent-side default doesn't risk jobs hanging forever undetected.
    private const int DefaultSilenceTimeoutSeconds = 300;
    private readonly TimeSpan _silenceTimeout = TimeSpan.FromSeconds(DefaultSilenceTimeoutSeconds);
    private readonly TimeSpan _heartbeatInterval = TimeSpan.FromSeconds(30);

    // Mirrors board/db.php's AGENT_OFFLINE_AFTER_SECONDS. Only used to decide
    // when the heartbeat watchdog should start shouting -- the relay remains
    // the authority on what "offline" means; this is the agent noticing that it
    // has crossed that line and saying so in its own log.
    private static readonly TimeSpan AgentOfflineAfter = TimeSpan.FromSeconds(120);

    // Log one "heartbeat ok" line per this many successful beats (30s each, so
    // ~10 minutes) purely as proof-of-life, and one failure line per this many
    // consecutive failures once past the first few.
    private const int HeartbeatOkLogEvery = 20;
    private const int HeartbeatFailLogEvery = 10;
    private const int PollFailLogEvery = 50;

    // Poll pacing. The happy-path gap is unchanged at 750ms; the ceiling only
    // applies while a worker is failing repeatedly.
    private static readonly TimeSpan PollDelayHealthy = TimeSpan.FromMilliseconds(750);
    private static readonly TimeSpan PollDelayMax = TimeSpan.FromSeconds(30);

    // Exponential backoff for a worker whose polls keep failing.
    //
    // Previously the delay was a flat 750ms whether the poll succeeded or
    // failed, so a relay returning 5xx got hammered by all 4 workers at a
    // combined ~5 requests/second for as long as the outage lasted. Measured on
    // 19 Jul: 176 poll errors in a single minute, sustained for ~7 minutes.
    // That is a retry storm aimed squarely at a server already in trouble, and
    // it is a plausible cause of the Cloudflare 521/503s themselves (the same
    // window in which the agent's heartbeat died and jobs were reaped as "agent
    // lost"). Backing off turns a struggling relay's problem into a wait
    // instead of a flood.
    //
    // 750ms doubling to a 30s ceiling: fast enough that a one-off blip costs
    // nothing noticeable, slow enough that a sustained outage settles to 4
    // requests per 30s across the fleet rather than ~9,000.
    private static TimeSpan PollDelayFor(int consecutiveFailures)
    {
        if (consecutiveFailures <= 0) return PollDelayHealthy;

        // Cap the shift before it can overflow, then cap the result.
        var shift = Math.Min(consecutiveFailures, 16);
        var ms = PollDelayHealthy.TotalMilliseconds * Math.Pow(2, shift);
        return ms >= PollDelayMax.TotalMilliseconds ? PollDelayMax : TimeSpan.FromMilliseconds(ms);
    }

    // job.SilenceTimeout (payload field "silence_timeout", in seconds) overrides
    // the default threshold for jobs expected to think for longer without
    // producing output (e.g. a heavy read-and-think job on a large transcript).
    // Falls back to the default for anything <= 0 as well as absent.
    private TimeSpan EffectiveSilenceTimeout(JobPayload job) =>
        job.SilenceTimeout is > 0 ? TimeSpan.FromSeconds(job.SilenceTimeout.Value) : _silenceTimeout;

    // job.Mechanical (payload field "mechanical") flags small, fully-specified
    // jobs where CC has no one to ask and no decision to make -- without this,
    // CC (esp. Opus) sometimes spends the whole silence window deliberating or
    // asking a clarifying question that never gets answered, and the job dies
    // to the silence timeout instead of just doing the work. Prepended to the
    // prompt only when the flag is set; every other job is unaffected.
    private const string MechanicalPreamble =
        "MECHANICAL TASK MODE: the task below is complete and fully specified. There is no one available to answer questions or approve options, so do not ask clarifying questions, do not present alternatives, and do not pause to deliberate. Execute the described changes directly now, using your own judgement only for implementation details the task doesn't specify.\n\n";

    private static string BuildPrompt(JobPayload job) =>
        job.Mechanical ? MechanicalPreamble + job.Prompt : job.Prompt!;

    public AgentCore(RelayRouter router, string bashPath, string machine, string? mcpConfigPath = null, string? claudeExePath = null)
    {
        _router = router;
        _bashPath = bashPath;
        _machine = machine;
        _mcpConfigPath = mcpConfigPath;
        _claudeExePath = ResolveClaudeExePath(claudeExePath);
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] Resolved claude executable: {_claudeExePath}");
    }

    // Runs alongside the heartbeat for the process's lifetime: watches for the
    // primary relay coming back and switches to it. See RelayRouter.
    public Task ProbeLoopAsync(CancellationToken token) => _router.ProbeLoopAsync(token);

    private static StringContent JsonBody(object payload) =>
        new(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

    // configuredPath (agent.config.json "claudeExePath") wins when set and it
    // actually exists -- lets a box override without relying on PATH shape.
    // Otherwise locate claude.cmd on PATH and swap to its sibling claude.exe
    // under node_modules\@anthropic-ai\claude-code\bin, which is where npm
    // installs the real binary next to the shim on every box, not just Jody's.
    // Falls back to "claude.cmd" (old, truncating behaviour) only if neither
    // resolves, so a box with an unusual npm layout still launches jobs.
    private static string ResolveClaudeExePath(string? configuredPath)
    {
        if (!string.IsNullOrWhiteSpace(configuredPath) && File.Exists(configuredPath))
        {
            return configuredPath;
        }

        var cmdPath = FindOnPath("claude.cmd");
        if (cmdPath is not null)
        {
            var cmdDir = Path.GetDirectoryName(cmdPath);
            if (cmdDir is not null)
            {
                var exeCandidate = Path.Combine(cmdDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
                if (File.Exists(exeCandidate))
                {
                    return exeCandidate;
                }
            }
        }

        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] WARNING: could not resolve claude.exe next to claude.cmd on PATH; falling back to claude.cmd (multi-paragraph prompts will be truncated by cmd.exe).");
        return "claude.cmd";
    }

    private static string? FindOnPath(string fileName)
    {
        var pathEnv = Environment.GetEnvironmentVariable("PATH");
        if (string.IsNullOrEmpty(pathEnv))
        {
            return null;
        }

        foreach (var dir in pathEnv.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir))
            {
                continue;
            }

            string candidate;
            try
            {
                candidate = Path.Combine(dir.Trim(), fileName);
            }
            catch (ArgumentException)
            {
                continue;
            }

            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    // Wall-clock of the last heartbeat the relay ACCEPTED, or null if none has
    // landed since startup. Read by the watchdog below (and worth surfacing if
    // a status UI ever wants it) -- volatile-by-lock-free convention: a torn
    // read is impossible for a reference type, and staleness of one tick is
    // irrelevant to a 30s heartbeat.
    private DateTime? _lastHeartbeatOkUtc;
    public DateTime? LastHeartbeatOkUtc => _lastHeartbeatOkUtc;

    // Console.WriteLine is not guaranteed safe here. The agent's stdout is a
    // redirect owned by whatever launched it (nohup -> agent-relaunch.log in
    // the normal case), and a broken/rotated/full redirect makes Write throw
    // IOException. That matters enormously in this loop: the ONLY logging call
    // sits inside a catch block, so a throw from it escapes the try/catch
    // entirely, unwinds the whole loop, and -- because the loop is started
    // fire-and-forget (`_ =` in TrayAppContext) -- is swallowed with no trace.
    // That is a silent, permanent heartbeat death in a process that otherwise
    // looks perfectly healthy. Never let logging be the thing that kills it.
    private static void SafeLog(string line)
    {
        try
        {
            Console.WriteLine(line);
        }
        catch
        {
            // Nothing sane to do -- and crashing the caller over a log line is
            // strictly worse than losing the line.
        }
    }

    // Runs for the lifetime of the tray host, independent of the poll workers'
    // Start/Stop/Restart -- a job already picked up before Stop keeps running
    // to completion, so the reaper on the relay needs this machine's heartbeat
    // to stay alive as long as the process does, not just while polling.
    //
    // FALSE-OFFLINE FIX (19 Jul): this loop stopping is indistinguishable, from
    // the relay's side, from the whole machine being dead -- isAgentOffline()
    // keys purely on heartbeats.updated_at, so a stalled heartbeat shows the
    // in-thread "agent offline" banner and lets reapDeadJobs kill live jobs with
    // "ERROR: agent lost", all while the agent is happily running work. Observed
    // exactly that: poll workers logging continuously while heartbeats stopped
    // dead for 20+ minutes, with NOT ONE line explaining why. Three defects
    // made that possible, all fixed here:
    //
    //   1. Both `catch (OperationCanceledException)` handlers used to `break`
    //      unconditionally. Any OCE that is NOT our shutdown token -- a
    //      timeout surfacing as cancellation from a path that bypasses
    //      RelayRouter.SendAsync's TimeoutException conversion, for instance --
    //      permanently ended heartbeats for the process's lifetime. Now the
    //      loop only exits when the token is ACTUALLY cancelled; anything else
    //      is a transient failure and is retried like any other.
    //   2. Logging could throw and unwind the loop (see SafeLog above).
    //   3. Success was never logged, so a dead heartbeat looked identical to a
    //      healthy one in the log -- which is precisely why this went unnoticed
    //      for so long. There is now a periodic liveness line and an explicit
    //      watchdog warning once the relay would consider us offline.
    //
    // The outer try/catch is the belt to those braces: NOTHING escapes this
    // loop except a genuine shutdown, so the heartbeat cannot die while the
    // process lives.
    public async Task HeartbeatLoopAsync(CancellationToken token)
    {
        SafeLog($"[HB] Heartbeat loop starting, pinging heartbeat.php on the active relay every {_heartbeatInterval.TotalSeconds:0}s.");

        var consecutiveFailures = 0;
        var beatsSinceLastLog = 0;

        while (!token.IsCancellationRequested)
        {
            try
            {
                // Follows the active relay: the heartbeat says "this machine is
                // alive" to whichever relay is currently handing us work, which
                // is the one whose reaper would otherwise declare us dead.
                await _router.PostActiveAsync("heartbeat.php", () => JsonBody(new { machine = _machine }), HeartbeatTimeout, token);

                _lastHeartbeatOkUtc = DateTime.UtcNow;

                if (consecutiveFailures > 0)
                {
                    SafeLog($"[HB] [{DateTime.Now:HH:mm:ss}] Heartbeat recovered after {consecutiveFailures} consecutive failure(s).");
                    consecutiveFailures = 0;
                    beatsSinceLastLog = 0;
                }
                else if (++beatsSinceLastLog >= HeartbeatOkLogEvery)
                {
                    // One line per ~10 minutes. Enough to prove the loop is
                    // alive when reading the log after the fact, nowhere near
                    // enough to drown the poll workers' output.
                    beatsSinceLastLog = 0;
                    SafeLog($"[HB] [{DateTime.Now:HH:mm:ss}] Heartbeat ok.");
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                // The genuine shutdown signal -- the ONLY thing that ends this
                // loop. See defect 1 in the comment above.
                break;
            }
            catch (Exception ex)
            {
                consecutiveFailures++;
                // Log the first few in full, then throttle: a relay that is
                // down for an hour must not write 120 identical lines, but it
                // must never go completely silent either (that silence is the
                // bug this whole block exists to prevent).
                if (consecutiveFailures <= 3 || consecutiveFailures % HeartbeatFailLogEvery == 0)
                {
                    var stale = _lastHeartbeatOkUtc is { } ok
                        ? $"{(DateTime.UtcNow - ok).TotalSeconds:0}s since last good heartbeat"
                        : "no successful heartbeat since startup";
                    SafeLog($"[HB] [{DateTime.Now:HH:mm:ss}] Heartbeat failed (#{consecutiveFailures}, {stale}): {ex.Message}");
                }

                // WATCHDOG: past this point the relay's isAgentOffline() reports
                // this machine as offline, which shows the in-thread banner and
                // arms reapDeadJobs against jobs that are still genuinely
                // running here. Say so unmistakably -- this line is the one that
                // turns "CCSW is being weird" into a diagnosis.
                var staleFor = _lastHeartbeatOkUtc is { } last ? DateTime.UtcNow - last : TimeSpan.MaxValue;
                if (staleFor >= AgentOfflineAfter && consecutiveFailures % HeartbeatFailLogEvery == 0)
                {
                    SafeLog($"[HB] [{DateTime.Now:HH:mm:ss}] *** WARNING: no heartbeat has reached the relay for over {AgentOfflineAfter.TotalSeconds:0}s. The relay now considers this machine OFFLINE: threads show the 'agent offline' banner and running jobs are at risk of being reaped as 'agent lost'. Jobs on this machine are unaffected otherwise. ***");
                }
            }

            try
            {
                await Task.Delay(_heartbeatInterval, token);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                // Delay itself failing is essentially impossible, but a throw
                // here would once again kill the loop silently. Absorb it and
                // keep beating; worst case we spin a little hotter than 30s.
                SafeLog($"[HB] [{DateTime.Now:HH:mm:ss}] Heartbeat delay failed (ignored): {ex.Message}");
            }
        }

        SafeLog($"[HB] Heartbeat loop stopped (token cancelled = {token.IsCancellationRequested}).");
    }

    // workerId just tags console output so interleaved log lines from the
    // concurrent workers (all sharing this one process's console) can be told
    // apart -- it has no bearing on correctness. Each worker runs this same
    // loop independently against the shared _http client; poll.php's
    // BEGIN IMMEDIATE txn (verified race-safe under real concurrent load) is
    // what stops two workers from ever picking up the same job.
    public async Task PollLoopAsync(int workerId, CancellationToken token)
    {
        Console.WriteLine($"[W{workerId}] CcswAgent worker starting, polling poll.php on the active relay (currently {_router.Active.Base}) every 2s.");
        try
        {
            // Consecutive failed polls for THIS worker, driving the backoff
            // below. Reset to 0 by any successful poll.
            var consecutiveFailures = 0;

            while (!token.IsCancellationRequested)
            {
                try
                {
                    await PollOnceAsync(workerId, token);
                    if (consecutiveFailures > 0)
                    {
                        SafeLog($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Poll recovered after {consecutiveFailures} consecutive failure(s).");
                        consecutiveFailures = 0;
                    }
                }
                catch (Exception ex)
                {
                    consecutiveFailures++;
                    // Throttled, like the heartbeat's: a relay that is down for
                    // an hour must not write thousands of identical lines, but
                    // it must never go fully silent either.
                    if (consecutiveFailures <= 3 || consecutiveFailures % PollFailLogEvery == 0)
                    {
                        SafeLog($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Poll error (#{consecutiveFailures}): {ex.Message}");
                    }
                }

                await Task.Delay(PollDelayFor(consecutiveFailures), token);
            }
        }
        catch (OperationCanceledException)
        {
            Console.WriteLine($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Poll loop stopped.");
        }
    }

    private async Task PollOnceAsync(int workerId, CancellationToken ct)
    {
        // POLLING is the only thing that follows the active relay. Everything
        // this job does from here on is pinned to `relay` -- the relay that
        // actually handed us the job -- because the job row exists only there.
        // If the router fails over mid-job, this job must keep talking to its
        // originating relay or its output and result would land nowhere.
        var (relay, pollJson) = await _router.GetStringActiveAsync(
            $"poll.php?machine={Uri.EscapeDataString(_machine)}", PollTimeout, ct);
        using var doc = JsonDocument.Parse(pollJson);
        var root = doc.RootElement;

        var hasJob = !root.TryGetProperty("job", out var jobProp) || jobProp.ValueKind != JsonValueKind.Null;
        if (!hasJob || !root.TryGetProperty("id", out var idProp))
        {
            return;
        }

        var id = idProp.GetInt32();
        var job = root.GetProperty("payload").Deserialize<JobPayload>(_jsonOptions);
        var thread = root.TryGetProperty("thread", out var threadProp) && threadProp.ValueKind == JsonValueKind.String
            ? threadProp.GetString()
            : null;
        var shouldContinue = root.TryGetProperty("continue", out var continueProp) && continueProp.ValueKind == JsonValueKind.True;

        if (job is null)
        {
            Console.WriteLine($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Job {id}: payload missing prompt/model/cwd, skipping.");
            await PostResult(relay, id, "ERROR: job payload missing prompt/model/cwd");
            return;
        }

        // "type":"bash" jobs carry a shell command instead of a CC prompt --
        // everything below (repo-lock, silence timeout, cancel-polling,
        // streaming to append.php) is shared; only how the job is launched
        // and what fields it requires differs.
        var isBash = string.Equals(job.Type, "bash", StringComparison.OrdinalIgnoreCase);
        var payloadValid = !string.IsNullOrWhiteSpace(job.Cwd) && (isBash
            ? !string.IsNullOrWhiteSpace(job.Command)
            : !string.IsNullOrWhiteSpace(job.Prompt) && !string.IsNullOrWhiteSpace(job.Model));
        if (!payloadValid)
        {
            var missingFields = isBash ? "command/cwd" : "prompt/model/cwd";
            Console.WriteLine($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Job {id}: payload missing {missingFields}, skipping.");
            await PostResult(relay, id, $"ERROR: job payload missing {missingFields}");
            return;
        }

        Console.WriteLine(isBash
            ? $"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Picked up job {id}: command=\"{job.Command}\" cwd={job.Cwd}"
            : $"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Picked up job {id}: prompt=\"{job.Prompt}\" model={job.Model} cwd={job.Cwd} mechanical={job.Mechanical}");

        // A missing cwd would otherwise make Process.Start fail inside the try
        // block below in a way that looks identical to a hung process until the
        // silence timeout trips -- catch it up front so the job fails fast.
        if (!Directory.Exists(job.Cwd))
        {
            Console.WriteLine($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Job {id}: cwd does not exist: {job.Cwd}, skipping.");
            await PostResult(relay, id, $"LAUNCH-ERROR: cwd does not exist: {job.Cwd}");
            return;
        }

        // DIAGNOSTIC (resume debug): repo is computed unconditionally, purely so
        // it can be logged even when continue is false -- the lookup itself
        // still only fires under the same condition as before.
        var repo = RepoFromCwd(job.Cwd);
        var sessionLabel = string.IsNullOrWhiteSpace(job.Session) ? "default" : job.Session!;
        Console.WriteLine($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Job {id}: continue={shouldContinue} thread={thread ?? "(none)"} repo={repo} session={sessionLabel}");

        string? resumeSessionId = null;
        if (!isBash && shouldContinue && !string.IsNullOrWhiteSpace(thread))
        {
            resumeSessionId = await LookupSession(relay, thread, repo, sessionLabel);
        }
        Console.WriteLine($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Job {id}: session_id looked up = {resumeSessionId ?? "none"}");

        string result;
        string? sessionId = null;
        try
        {
            if (isBash)
            {
                var silenceTimeout = EffectiveSilenceTimeout(job);
                var (exitCode, output, timedOut, cancelled) = await RunBash(relay, id, job, silenceTimeout);
                if (cancelled)
                {
                    result = "CANCELLED";
                    Console.WriteLine($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Job {id}: cancel requested, killed process tree.");
                }
                else if (timedOut)
                {
                    result = $"TIMEOUT: no output for {silenceTimeout.TotalMinutes:0.##}min";
                    Console.WriteLine($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Job {id}: no output for {silenceTimeout.TotalMinutes:0.##}min, killed process tree.");
                }
                else
                {
                    result = $"{output}\n[exit code: {exitCode}]";
                    Console.WriteLine($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Job {id}: bash exited {exitCode}.");
                }
            }
            else
            {
                var silenceTimeout = EffectiveSilenceTimeout(job);
                var (exitCode, stdout, stderr, timedOut, cancelled) = await RunClaude(relay, id, job, resumeSessionId, silenceTimeout);
                if (cancelled)
                {
                    result = "CANCELLED";
                    Console.WriteLine($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Job {id}: cancel requested, killed process tree.");
                }
                else if (timedOut)
                {
                    result = $"TIMEOUT: no output for {silenceTimeout.TotalMinutes:0.##}min";
                    Console.WriteLine($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Job {id}: no output for {silenceTimeout.TotalMinutes:0.##}min, killed process tree.");
                }
                else
                {
                    result = exitCode == 0 ? stdout : $"ERROR: {stderr}";
                    Console.WriteLine($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Job {id}: claude exited {exitCode}.");
                    if (exitCode == 0)
                    {
                        sessionId = ExtractSessionId(stdout);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            // Process.Start itself failed (bad cwd, missing binary, etc.) --
            // this is distinct from the process running and exiting non-zero,
            // and must still post a result or the job is orphaned in 'running'
            // forever (poll.php never re-offers a running job).
            result = $"LAUNCH-ERROR: {ex.Message}";
            Console.WriteLine($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Job {id}: failed to launch {(isBash ? "bash" : "claude")}: {ex.Message}");
        }

        var ackResponse = await PostResult(relay, id, result, sessionId, sessionLabel);
        Console.WriteLine($"[W{workerId}] [{DateTime.Now:HH:mm:ss}] Job {id} result posted. Ack: {ackResponse}");
    }

    private async Task<(int ExitCode, string Stdout, string Stderr, bool TimedOut, bool Cancelled)> RunClaude(RelayEndpoint relay, int jobId, JobPayload job, string? resumeSessionId, TimeSpan silenceTimeout)
    {
        var psi = new ProcessStartInfo
        {
            FileName = _claudeExePath,
            WorkingDirectory = job.Cwd,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("-p");
        psi.ArgumentList.Add(BuildPrompt(job));
        psi.ArgumentList.Add("--model");
        psi.ArgumentList.Add(job.Model!);
        // stream-json (+ --verbose, which it requires) emits one JSON event per
        // line as CC runs -- unlike plain --output-format json, which only
        // prints its single envelope at the very end and would defeat live
        // streaming. The last line is a "type":"result" event with the exact
        // same shape that single envelope always had (including session_id), so
        // it's captured below and returned as Stdout, keeping ExtractSessionId
        // and everything downstream of RunClaude unchanged.
        psi.ArgumentList.Add("--output-format");
        psi.ArgumentList.Add("stream-json");
        psi.ArgumentList.Add("--verbose");
        psi.ArgumentList.Add("--dangerously-skip-permissions");
        psi.ArgumentList.Add("--max-turns");
        psi.ArgumentList.Add("100");
        if (!string.IsNullOrEmpty(resumeSessionId))
        {
            psi.ArgumentList.Add("--resume");
            psi.ArgumentList.Add(resumeSessionId);
        }
        // Opt-in MCP connectors for headless jobs: only wired up when the config
        // sets mcpConfigPath AND the file actually exists, so an unset/stale path
        // silently falls back to no-MCP instead of failing the launch.
        if (!string.IsNullOrEmpty(_mcpConfigPath) && File.Exists(_mcpConfigPath))
        {
            psi.ArgumentList.Add("--mcp-config");
            psi.ArgumentList.Add(_mcpConfigPath);
        }
        // Exposed so any CC-child process (including its hooks) can know it's
        // running inside a CCSW job and which one -- e.g. dispatch.ps1 uses
        // CCSW_JOB_ID's presence to suppress announce/vm-signal hooks for
        // headless jobs, since the board already reports their completion.
        psi.EnvironmentVariables["CCSW_JOB_ID"] = jobId.ToString();
        psi.EnvironmentVariables["CCSW_RELAY_BASE"] = relay.Base;

        // DIAGNOSTIC (resume debug): the exact command line, so it's visible
        // whether --resume actually made it onto the invocation.
        var commandLine = string.Join(' ', new[] { psi.FileName }.Concat(psi.ArgumentList.Select(QuoteArgForLog)));
        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] Job {jobId}: spawning: {commandLine}");

        using var process = new Process { StartInfo = psi };
        process.Start();
        // Ticks (Stopwatch.GetTimestamp() units) of the last stdout line received
        // from CC. Read/written from two different threads (the stdout pump task
        // below and the wait loop further down), so all access goes through
        // Interlocked. Seeded at process start so a job that never produces any
        // output still times out after silenceTimeout rather than hanging forever.
        var lastOutputTicks = Stopwatch.GetTimestamp();

        // Read both streams concurrently -- reading one fully before the other can
        // deadlock if the process fills the unread stream's OS pipe buffer. Stdout
        // is streamed line-by-line: each line is a stream-json event, POSTed to
        // append.php VERBATIM (raw JSON) so consumers like feed.php get the full
        // structured event to render by type -- posting only human-readable text
        // extracted here would throw that structure away. Non-JSON lines still
        // get posted as-is (the raw line IS the fallback). The "type":"result"
        // line is also captured separately as resultEventLine -- that becomes
        // this function's Stdout return, so the caller's ExtractSessionId/result
        // handling needs no changes.
        var stdoutBuilder = new StringBuilder();
        string? resultEventLine = null;
        var stdoutTask = Task.Run(async () =>
        {
            string? line;
            while ((line = await process.StandardOutput.ReadLineAsync()) is not null)
            {
                Interlocked.Exchange(ref lastOutputTicks, Stopwatch.GetTimestamp());
                stdoutBuilder.AppendLine(line);
                if (line.Length == 0)
                {
                    continue;
                }

                try
                {
                    using var eventDoc = JsonDocument.Parse(line);
                    if (eventDoc.RootElement.TryGetProperty("type", out var typeProp) && typeProp.GetString() == "result")
                    {
                        resultEventLine = line;
                    }
                }
                catch (JsonException)
                {
                    // not JSON -- nothing to capture, the raw line still gets posted below
                }

                await PostAppend(relay, jobId, line);
            }
        });
        // stderr is also read line-by-line (not ReadToEndAsync) so any output CC
        // leaks to stderr during a long op -- e.g. a sub-process's error stream --
        // resets the same silence clock as stdout. Previously stderr was only
        // drained once at the end and never counted as liveness, so a job that
        // was quietly alive on stderr alone still died to the silence timeout.
        // The full text is still captured (into stderrBuilder) exactly as before,
        // just accumulated line-by-line instead of via ReadToEndAsync; nothing
        // is posted to append.php for stderr (unlike RunBash's combined-stream
        // job type, a CC job's stderr has no stream-json structure for feed.php
        // to render and was never streamed before this change either).
        var stderrBuilder = new StringBuilder();
        var stderrTask = Task.Run(async () =>
        {
            string? line;
            while ((line = await process.StandardError.ReadLineAsync()) is not null)
            {
                Interlocked.Exchange(ref lastOutputTicks, Stopwatch.GetTimestamp());
                stderrBuilder.AppendLine(line);
            }
        });

        // Waited for in chunks (rather than one WaitForExit(silenceTimeout) call) so
        // a cancel_requested flag on the relay is noticed within ~2s, and so the
        // remaining-time budget can be recomputed against the latest output
        // timestamp each iteration instead of a fixed deadline set once up front.
        var cancelPollInterval = TimeSpan.FromSeconds(2);
        var exited = false;
        var cancelled = false;
        while (true)
        {
            var idleTicks = Stopwatch.GetTimestamp() - Interlocked.Read(ref lastOutputTicks);
            var idleElapsed = TimeSpan.FromSeconds((double)idleTicks / Stopwatch.Frequency);
            var remaining = silenceTimeout - idleElapsed;
            if (remaining <= TimeSpan.Zero)
            {
                break;
            }

            var waitMs = (int)Math.Min(cancelPollInterval.TotalMilliseconds, remaining.TotalMilliseconds);
            exited = await Task.Run(() => process.WaitForExit(waitMs));
            if (exited)
            {
                break;
            }

            if (await IsCancelRequested(relay, jobId))
            {
                cancelled = true;
                break;
            }
        }

        if (cancelled)
        {
            process.Kill(entireProcessTree: true);
            return (-1, "", "", false, true);
        }

        if (!exited)
        {
            process.Kill(entireProcessTree: true);
            return (-1, "", "", true, false);
        }

        await stdoutTask;
        await stderrTask;

        return (process.ExitCode, resultEventLine ?? stdoutBuilder.ToString(), stderrBuilder.ToString(), false, false);
    }

    // "type":"bash" jobs run a raw shell command in Git Bash instead of invoking
    // claude. Mirrors RunClaude's silence-timeout/cancel-polling/streaming shape,
    // but both stdout AND stderr are streamed to append.php (a bash job has no
    // stream-json structure to extract, so stderr is just as relevant live output
    // as stdout) and folded into one combined buffer that becomes the result.
    private async Task<(int ExitCode, string Output, bool TimedOut, bool Cancelled)> RunBash(RelayEndpoint relay, int jobId, JobPayload job, TimeSpan silenceTimeout)
    {
        var psi = new ProcessStartInfo
        {
            FileName = _bashPath,
            WorkingDirectory = job.Cwd,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("-lc");
        psi.ArgumentList.Add(job.Command!);
        // Exposed so a bash job's command can report its own completion back
        // to the relay independent of this agent process -- e.g. a job that
        // restarts CcswAgent itself can't rely on this process surviving long
        // enough to post its own result (see restart-agent.ps1).
        psi.EnvironmentVariables["CCSW_JOB_ID"] = jobId.ToString();
        psi.EnvironmentVariables["CCSW_RELAY_BASE"] = relay.Base;

        Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] Job {jobId}: spawning: {_bashPath} -lc \"{job.Command}\" (cwd={job.Cwd})");

        using var process = new Process { StartInfo = psi };
        process.Start();
        var lastOutputTicks = Stopwatch.GetTimestamp();

        var outputBuilder = new StringBuilder();
        var outputLock = new object();

        async Task PumpStream(StreamReader reader)
        {
            string? line;
            while ((line = await reader.ReadLineAsync()) is not null)
            {
                Interlocked.Exchange(ref lastOutputTicks, Stopwatch.GetTimestamp());
                lock (outputLock)
                {
                    outputBuilder.AppendLine(line);
                }
                await PostAppend(relay, jobId, line);
            }
        }

        var stdoutTask = PumpStream(process.StandardOutput);
        var stderrTask = PumpStream(process.StandardError);

        var cancelPollInterval = TimeSpan.FromSeconds(2);
        var exited = false;
        var cancelled = false;
        while (true)
        {
            var idleTicks = Stopwatch.GetTimestamp() - Interlocked.Read(ref lastOutputTicks);
            var idleElapsed = TimeSpan.FromSeconds((double)idleTicks / Stopwatch.Frequency);
            var remaining = silenceTimeout - idleElapsed;
            if (remaining <= TimeSpan.Zero)
            {
                break;
            }

            var waitMs = (int)Math.Min(cancelPollInterval.TotalMilliseconds, remaining.TotalMilliseconds);
            exited = await Task.Run(() => process.WaitForExit(waitMs));
            if (exited)
            {
                break;
            }

            if (await IsCancelRequested(relay, jobId))
            {
                cancelled = true;
                break;
            }
        }

        if (cancelled)
        {
            process.Kill(entireProcessTree: true);
            return (-1, "", false, true);
        }

        if (!exited)
        {
            process.Kill(entireProcessTree: true);
            return (-1, "", true, false);
        }

        await Task.WhenAll(stdoutTask, stderrTask);
        return (process.ExitCode, outputBuilder.ToString(), false, false);
    }

    private async Task<bool> IsCancelRequested(RelayEndpoint relay, int jobId)
    {
        try
        {
            // Pinned: the cancel flag lives on the row on the originating relay.
            var json = await _router.GetStringPinnedAsync(relay, $"cancel.php?job_id={jobId}", JobRequestTimeout, CancellationToken.None);
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.TryGetProperty("cancel_requested", out var prop) && prop.ValueKind == JsonValueKind.True;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] Job {jobId}: cancel check failed: {ex.Message}");
            return false;
        }
    }

    // Pinned to the job's originating relay: this is live output for a job row
    // that exists only there. Best-effort exactly as before -- a dropped line
    // of streamed output must never fail the job.
    private async Task PostAppend(RelayEndpoint relay, int jobId, string text)
    {
        try
        {
            (await _router.SendPinnedAsync(relay, HttpMethod.Post, "append.php",
                () => JsonBody(new { job_id = jobId, text }), JobRequestTimeout, CancellationToken.None)).Dispose();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] Job {jobId}: append.php POST to {relay.Base} failed: {ex.Message}");
        }
    }

    // Diagnostic-only quoting for the logged command line -- readable, not a
    // real shell-escaping implementation (ProcessStartInfo.ArgumentList is what
    // actually passes args to the process; this never affects that).
    private static string QuoteArgForLog(string arg) => arg.Contains(' ') ? $"\"{arg}\"" : arg;

    // The one relay call a job cannot afford to lose: it is what moves the row
    // out of 'running' and hands the answer back. Pinned to the originating
    // relay (the row exists nowhere else) and retried a few times with a
    // growing backoff, because the interesting failure here is exactly the one
    // the router can't paper over -- the job's own relay dying mid-job.
    //
    // If it stays dead, log loudly and drop: that relay's reaper marks the job
    // stale on its own, which is a better outcome than blocking the worker
    // forever on a relay that isn't coming back.
    private const int ResultPostAttempts = 4;

    private async Task<string> PostResult(RelayEndpoint relay, int id, string result, string? sessionId = null, string? sessionLabel = null)
    {
        for (var attempt = 1; attempt <= ResultPostAttempts; attempt++)
        {
            try
            {
                using var response = await _router.SendPinnedAsync(relay, HttpMethod.Post, "result.php",
                    () => JsonBody(new { id, result, session_id = sessionId, session = sessionLabel, machine = _machine }),
                    JobRequestTimeout, CancellationToken.None);
                return await response.Content.ReadAsStringAsync();
            }
            catch (Exception ex)
            {
                if (attempt == ResultPostAttempts)
                {
                    Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] *** Job {id}: result.php POST to {relay.Base} failed {ResultPostAttempts}x, DROPPING the result ({ex.Message}). The job's own relay reaper will mark it stale. ***");
                    return $"(result post to {relay.Base} failed: {ex.Message})";
                }

                var backoff = TimeSpan.FromSeconds(2 * attempt);
                Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] Job {id}: result.php POST to {relay.Base} failed (attempt {attempt}/{ResultPostAttempts}), retrying in {backoff.TotalSeconds:0}s: {ex.Message}");
                await Task.Delay(backoff);
            }
        }

        return "(unreachable)";
    }

    // stdout here is RunClaude's captured "type":"result" event line (the last
    // line of stream-json output) on success; session_id is a top-level string
    // field on it. Returns null if stdout isn't that shape (shouldn't happen
    // when exitCode == 0, but this is a side capture and must never itself
    // fail the job).
    private static string? ExtractSessionId(string stdout)
    {
        try
        {
            using var doc = JsonDocument.Parse(stdout);
            return doc.RootElement.TryGetProperty("session_id", out var prop) && prop.ValueKind == JsonValueKind.String
                ? prop.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // Mirrors db.php's repoFromCwd(): last path segment, tolerant of either
    // slash direction and a trailing one. Must match the relay's derivation
    // exactly or a session lookup here would miss what result.php stored.
    private static string RepoFromCwd(string cwd)
    {
        var normalized = cwd.Replace('\\', '/').TrimEnd('/');
        return normalized.Length == 0 ? cwd : normalized.Split('/')[^1];
    }

    private async Task<string?> LookupSession(RelayEndpoint relay, string thread, string repo, string session)
    {
        try
        {
            // Pinned: sessions are recorded by result.php on the relay that ran
            // the job, so the resume id for this thread/repo lives on the same
            // relay this job was polled from.
            var url = $"session.php?thread={Uri.EscapeDataString(thread)}&repo={Uri.EscapeDataString(repo)}&session={Uri.EscapeDataString(session)}&machine={Uri.EscapeDataString(_machine)}";
            var json = await _router.GetStringPinnedAsync(relay, url, JobRequestTimeout, CancellationToken.None);
            using var doc = JsonDocument.Parse(json);
            return doc.RootElement.TryGetProperty("session_id", out var prop) && prop.ValueKind == JsonValueKind.String
                ? prop.GetString()
                : null;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] Session lookup failed for thread \"{thread}\", repo \"{repo}\": {ex.Message}");
            return null;
        }
    }
}

// One entry of the optional "relays" array. Tokens are per-relay: the primary
// and the reserve are separate deployments with separate auth.config.php
// files, so one token is never valid on both.
internal record RelayConfigEntry(
    string Base,
    string? Token = null);

internal record AgentConfig(
    string Machine,
    // Legacy single-relay fields. Still fully supported: when "relays" is
    // absent, Program synthesizes a one-element relay list from RelayBase +
    // Token, so an existing agent.config.json keeps working untouched.
    // Ignored when "relays" is present.
    string? RelayBase = null,
    // Ordered relay list, highest priority first. Index 0 is the primary --
    // the relay the router probes for and fails back to. An entry with an
    // empty token is skipped (see RelayRouter).
    IReadOnlyList<RelayConfigEntry>? Relays = null,
    int WorkerCount = 4,
    string BashPath = @"C:\Program Files\Git\bin\bash.exe",
    string? McpConfigPath = null,
    // Optional override for the real claude.exe (not the claude.cmd shim --
    // see AgentCore.ResolveClaudeExePath). Unset means auto-resolve via PATH,
    // which is correct on every box; only set this if that resolution fails.
    string? ClaudeExePath = null,
    string? Token = null);
internal record JobPayload(
    string? Prompt,
    string? Model,
    string Cwd,
    string? Type = null,
    string? Command = null,
    [property: JsonPropertyName("silence_timeout")] double? SilenceTimeout = null,
    [property: JsonPropertyName("session")] string? Session = null,
    [property: JsonPropertyName("mechanical")] bool Mechanical = false);
