namespace CcswAgent;

// One configured relay: a base URL plus the token that authenticates THIS
// agent to it. Tokens are strictly per-relay -- the primary and the reserve
// are separate deployments with separate auth.config.php files, so a token
// minted on one is meaningless (401) on the other.
//
// Mutable counters are int fields rather than properties so Interlocked can
// take them by ref: the 4 poll workers, the heartbeat loop and the probe loop
// all touch the same RelayEndpoint instances concurrently.
internal sealed class RelayEndpoint
{
    public RelayEndpoint(string baseUrl, string? token, int priority)
    {
        Base = baseUrl.TrimEnd('/');
        Token = token;
        Priority = priority;
    }

    public string Base { get; }
    public string? Token { get; }

    // Index in the configured list. 0 is the primary -- the relay the router
    // probes for and returns to whenever it is healthy again.
    public int Priority { get; }

    // No token configured means the relay simply cannot be used: every request
    // would 401 once the relay enforces auth. Such a relay is skipped in
    // rotation and never probed (logged once at startup, not once per poll).
    public bool HasToken => !string.IsNullOrWhiteSpace(Token);

    // Set on a 401: the token we hold is wrong or revoked. Deliberately
    // distinct from the failure counter -- retrying cannot fix it, so the
    // relay leaves rotation until the agent restarts with a corrected config,
    // rather than burning the 3-strike budget over and over.
    private int _tokenRejected;
    public bool IsTokenRejected => Interlocked.CompareExchange(ref _tokenRejected, 0, 0) != 0;

    // Returns true only on the transition, so the caller logs once.
    public bool MarkTokenRejected() => Interlocked.Exchange(ref _tokenRejected, 1) == 0;

    public int ConsecutiveFailures;

    public bool Usable => HasToken && !IsTokenRejected;

    public override string ToString() => Base;
}

// Every relay URL the agent builds and every X-CCSW-Token header it sends goes
// through here. Two distinct routing modes, and the difference matters:
//
//   Active   -- polling and heartbeats follow whichever relay is currently
//               healthy, failing over when it isn't.
//   Pinned   -- a job's append/result/cancel/session traffic is bound to the
//               relay the job was POLLED FROM, for the job's whole life, even
//               if the active relay switches underneath it. Job rows only
//               exist on their originating relay; posting a result to the
//               other one would 404 into the void and orphan the job.
internal sealed class RelayRouter : IDisposable
{
    // Consecutive failures against the active relay before failing over. Small
    // enough that an outage costs a couple of polls, large enough that a single
    // blip doesn't flap the fleet onto the reserve.
    private const int FailureThreshold = 3;

    // Consecutive successful probes of the primary before switching back. The
    // hysteresis is the whole point: a relay that answers once mid-restart and
    // then dies again must not drag the agent back with it.
    private const int ProbeOksToSwitchBack = 2;

    private static readonly TimeSpan ProbeInterval = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(5);

    // Read-only and cheap. NOT poll.php: polling CLAIMS a job, so probing with
    // it would pick up work the probe then throws away, stranding the job in
    // 'running' until the relay's reaper notices. jobs.php is a plain
    // authenticated GET, which is exactly what a probe wants -- it proves the
    // relay is up AND that our token is accepted, and changes nothing.
    private const string ProbePath = "jobs.php?status=all&limit=1";

    private readonly RelayEndpoint[] _relays;
    private readonly HttpClient _http;
    private readonly object _switchLock = new();
    private int _activeIndex;
    private int _probeOks;

    public RelayRouter(IReadOnlyList<RelayEndpoint> relays)
    {
        if (relays.Count == 0)
        {
            throw new ArgumentException("at least one relay must be configured", nameof(relays));
        }

        _relays = relays.ToArray();
        _http = new HttpClient();
        // The host's WAF blocks requests with no User-Agent header (HttpClient
        // sends none by default, unlike curl), so set one explicitly.
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("CcswAgent/1.0");
        // NOTE: the token is deliberately NOT a DefaultRequestHeader any more.
        // It differs per relay, so it is attached per request instead.

        foreach (var relay in _relays)
        {
            if (!relay.HasToken)
            {
                Console.WriteLine($"[RELAY] {relay.Base} has no token configured -- skipping it (fill in its token in agent.config.json to enable it).");
            }
        }

        _activeIndex = FirstUsableIndex(0);
        if (_activeIndex < 0)
        {
            // Nothing is usable. Don't throw -- the agent is still useful the
            // moment a token is filled in and it restarts, and a hard crash
            // here would just be a worse error message.
            _activeIndex = 0;
            Console.WriteLine("[RELAY] WARNING: no relay has a usable token. Requests will fail until agent.config.json provides one.");
        }

        Console.WriteLine($"[RELAY] {_relays.Length} relay(s) configured; active = {Active.Base}");
    }

    public RelayEndpoint Active => _relays[Interlocked.CompareExchange(ref _activeIndex, 0, 0)];

    // Scans forward from `start`, wrapping, for a relay that has a token and
    // hasn't had it rejected. Returns -1 when none qualifies.
    private int FirstUsableIndex(int start)
    {
        for (var i = 0; i < _relays.Length; i++)
        {
            var idx = (start + i) % _relays.Length;
            if (_relays[idx].Usable)
            {
                return idx;
            }
        }

        return -1;
    }

    // ---- routing modes -----------------------------------------------------

    // Follows the active relay. On a request failure it counts a strike against
    // that relay and, once the threshold trips, switches and retries ONCE on
    // the new relay -- so the caller sees a single failure only when both the
    // old and the new relay are down.
    //
    // Returns the relay that actually answered, so a caller that polls a job
    // can pin the rest of that job's traffic to it.
    public async Task<(RelayEndpoint Relay, string Body)> GetStringActiveAsync(string path, TimeSpan timeout, CancellationToken ct)
    {
        var relay = Active;
        try
        {
            return (relay, await SendForStringAsync(relay, HttpMethod.Get, path, null, timeout, ct));
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            if (!HandleFailure(relay, ex))
            {
                throw;
            }

            var next = Active;
            Console.WriteLine($"[RELAY] retrying {path} on {next.Base}");
            return (next, await SendForStringAsync(next, HttpMethod.Get, path, null, timeout, ct));
        }
    }

    public async Task PostActiveAsync(string path, Func<HttpContent> body, TimeSpan timeout, CancellationToken ct)
    {
        var relay = Active;
        try
        {
            (await SendAsync(relay, HttpMethod.Post, path, body, timeout, ct)).Dispose();
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            if (!HandleFailure(relay, ex))
            {
                throw;
            }

            Console.WriteLine($"[RELAY] retrying {path} on {Active.Base}");
            (await SendAsync(Active, HttpMethod.Post, path, body, timeout, ct)).Dispose();
        }
    }

    // Books a failed request against `relay` and reports whether the caller
    // should retry on a different relay. A 401 has already marked the relay
    // token-rejected and moved us off it inside SendAsync, so it must not also
    // burn a strike -- but it IS still worth retrying, hence the Active check
    // rather than RecordFailure's return value.
    private bool HandleFailure(RelayEndpoint relay, Exception ex)
    {
        if (!relay.IsTokenRejected)
        {
            RecordFailure(relay, Describe(ex));
        }

        return !ReferenceEquals(Active, relay);
    }

    // Pinned: goes to `relay` and nowhere else, ever. Failures are still
    // recorded (a dead relay is a dead relay, whoever noticed it), but the
    // request is never redirected -- see the class comment.
    public Task<HttpResponseMessage> SendPinnedAsync(RelayEndpoint relay, HttpMethod method, string path, Func<HttpContent>? body, TimeSpan timeout, CancellationToken ct)
        => SendAsync(relay, method, path, body, timeout, ct);

    public Task<string> GetStringPinnedAsync(RelayEndpoint relay, string path, TimeSpan timeout, CancellationToken ct)
        => SendForStringAsync(relay, HttpMethod.Get, path, null, timeout, ct);

    // ---- transport ---------------------------------------------------------

    private async Task<string> SendForStringAsync(RelayEndpoint relay, HttpMethod method, string path, Func<HttpContent>? body, TimeSpan timeout, CancellationToken ct)
    {
        using var response = await SendAsync(relay, method, path, body, timeout, ct);
        return await response.Content.ReadAsStringAsync(ct);
    }

    // The one place a request is actually made and the one place the token is
    // attached. Throws on transport failure or 5xx (both count as strikes);
    // 401 marks the relay token-rejected and throws; every other status is
    // returned to the caller as-is (a 404 means the relay is alive and answered
    // -- e.g. an endpoint not deployed there -- so it is NOT a failover signal).
    private async Task<HttpResponseMessage> SendAsync(RelayEndpoint relay, HttpMethod method, string path, Func<HttpContent>? body, TimeSpan timeout, CancellationToken ct)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);

        using var request = new HttpRequestMessage(method, $"{relay.Base}/{path}");
        if (relay.HasToken)
        {
            request.Headers.Add("X-CCSW-Token", relay.Token);
        }

        if (body is not null)
        {
            request.Content = body();
        }

        HttpResponseMessage response;
        try
        {
            response = await _http.SendAsync(request, HttpCompletionOption.ResponseContentRead, timeoutCts.Token);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // Our own CancelAfter fired, not the caller's token: this is a
            // timeout, which is a failure, not a cancellation.
            throw new TimeoutException($"request to {relay.Base}/{path} timed out after {timeout.TotalSeconds:0.#}s");
        }

        if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            response.Dispose();
            if (relay.MarkTokenRejected())
            {
                Console.WriteLine($"[RELAY] *** {relay.Base} REJECTED our token (401). Dropping it from rotation until the agent restarts with a corrected agent.config.json. ***");
                // A token-rejected relay must not stay active.
                SwitchAwayFrom(relay, "token rejected");
            }

            throw new HttpRequestException($"{relay.Base}/{path} returned 401 (token rejected)");
        }

        if ((int)response.StatusCode >= 500)
        {
            var status = (int)response.StatusCode;
            response.Dispose();
            throw new HttpRequestException($"{relay.Base}/{path} returned {status}");
        }

        RecordSuccess(relay);
        return response;
    }

    private static string Describe(Exception ex) => $"{ex.GetType().Name}: {ex.Message}";

    // ---- health bookkeeping ------------------------------------------------

    private static void RecordSuccess(RelayEndpoint relay) => Interlocked.Exchange(ref relay.ConsecutiveFailures, 0);

    // Returns true if this failure caused a switch, so a caller can retry on
    // the new active relay.
    private bool RecordFailure(RelayEndpoint relay, string reason)
    {
        var failures = Interlocked.Increment(ref relay.ConsecutiveFailures);
        Console.WriteLine($"[RELAY] {relay.Base} failure {failures}/{FailureThreshold}: {reason}");
        return failures >= FailureThreshold && SwitchAwayFrom(relay, $"{failures} consecutive failures");
    }

    // Returns true if the active relay actually changed.
    private bool SwitchAwayFrom(RelayEndpoint relay, string reason)
    {
        lock (_switchLock)
        {
            // Someone else already moved us off it -- nothing to do. This is
            // the common case when several workers trip the threshold at once.
            if (!ReferenceEquals(_relays[_activeIndex], relay))
            {
                return false;
            }

            var next = FirstUsableIndex((_activeIndex + 1) % _relays.Length);
            if (next < 0 || next == _activeIndex)
            {
                Console.WriteLine($"[RELAY] *** {relay.Base} is failing ({reason}) but there is NO usable relay to fail over to -- staying put and continuing to retry. ***");
                // Reset so the log doesn't scream on every single request.
                Interlocked.Exchange(ref relay.ConsecutiveFailures, 0);
                return false;
            }

            var target = _relays[next];
            Interlocked.Exchange(ref _activeIndex, next);
            Interlocked.Exchange(ref target.ConsecutiveFailures, 0);
            Interlocked.Exchange(ref relay.ConsecutiveFailures, 0);
            Interlocked.Exchange(ref _probeOks, 0);
            Console.WriteLine($"[RELAY] *** FAILOVER: {relay.Base} -> {target.Base} ({reason}) ***");
            return true;
        }
    }

    // ---- probe loop --------------------------------------------------------

    // While the agent is running on anything other than the primary, poke the
    // primary every ~60s and go back to it once it has answered cleanly twice
    // in a row. Runs for the process's lifetime alongside the heartbeat.
    public async Task ProbeLoopAsync(CancellationToken ct)
    {
        Console.WriteLine($"[RELAY] Probe loop starting: checking {_relays[0].Base} every {ProbeInterval.TotalSeconds:0}s whenever it is not the active relay.");
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(ProbeInterval, ct);
            }
            catch (OperationCanceledException)
            {
                break;
            }

            try
            {
                await ProbeOnceAsync(ct);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[RELAY] probe error: {Describe(ex)}");
            }
        }

        Console.WriteLine("[RELAY] Probe loop stopped.");
    }

    private async Task ProbeOnceAsync(CancellationToken ct)
    {
        var primary = _relays[0];
        if (ReferenceEquals(Active, primary))
        {
            Interlocked.Exchange(ref _probeOks, 0);
            return;
        }

        // No token, or a token it already rejected: probing it can only fail.
        if (!primary.Usable)
        {
            return;
        }

        try
        {
            // Pinned deliberately: a probe of the primary must never fail over
            // to something else, and its failures must not count as strikes
            // against a relay we are not even using right now.
            using var response = await SendAsync(primary, HttpMethod.Get, ProbePath, null, ProbeTimeout, ct);
            var oks = Interlocked.Increment(ref _probeOks);
            Console.WriteLine($"[RELAY] probe of {primary.Base} OK ({oks}/{ProbeOksToSwitchBack} needed to switch back)");
            if (oks < ProbeOksToSwitchBack)
            {
                return;
            }

            lock (_switchLock)
            {
                if (ReferenceEquals(_relays[_activeIndex], primary))
                {
                    return;
                }

                var from = _relays[_activeIndex];
                Interlocked.Exchange(ref _activeIndex, 0);
                Interlocked.Exchange(ref primary.ConsecutiveFailures, 0);
                Interlocked.Exchange(ref _probeOks, 0);
                Console.WriteLine($"[RELAY] *** FAILBACK: {from.Base} -> {primary.Base} (primary healthy on {ProbeOksToSwitchBack} consecutive probes) ***");
            }
        }
        catch (Exception ex)
        {
            // Reset the streak: the two OKs must be CONSECUTIVE, otherwise a
            // relay that flaps every other minute would eventually accumulate
            // its way back to active and take the fleet down with it.
            Interlocked.Exchange(ref _probeOks, 0);
            Console.WriteLine($"[RELAY] probe of {primary.Base} failed, staying on {Active.Base}: {Describe(ex)}");
        }
    }

    public void Dispose() => _http.Dispose();
}
