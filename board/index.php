<?php
declare(strict_types=1);
// M1 GUI: a plain, poll-driven status board. All data comes from jobs.php
// via client-side fetch; this file itself is static HTML/JS.
require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';

// PART A: magic-link login. Must run before any output so setcookie()/
// header() are still legal. Validates ?token= the same way every other gate
// does (authToken()/hash_equals) and, on a match, sets the same ccsw_token
// cookie the extension seeds via chrome.cookies.set (see background.js's
// BOARD_COOKIE_PATH/BOARD_COOKIE_MAX_AGE_SECONDS -- Secure, Lax, ~13 month
// lifetime), then redirects to the token-stripped URL so it never lingers in
// browser history. Deliberately narrow: only index.php accepts ?token= --
// requestToken() (auth.php) is untouched, so no other endpoint gains a
// query-string auth surface. A mismatch just falls through to the normal
// gate below -- no cookie set, no distinct error (would leak which case
// failed).
if (isset($_GET['token']) && hash_equals(authToken(), (string) $_GET['token'])) {
    setcookie('ccsw_token', (string) $_GET['token'], [
        'expires' => time() + 34560000,
        'path' => '/ccswitchboard/board',
        'secure' => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    header('Location: ' . strtok($_SERVER['REQUEST_URI'], '?'));
    exit;
}

// Self-gate rather than requireAuth()'s 401: index.php is loaded directly
// by a browser navigating to it, so a JSON 401 would just be a blank error
// page with nothing the human could act on. Reuses requestToken()/
// authToken()/hash_equals -- the exact same credential check requireAuth()
// does -- and only swaps what happens on failure: render a token-entry
// gate instead of an API error. Every other endpoint is untouched.
$providedToken = requestToken();
$expectedToken = authToken();
$hasValidToken = $providedToken !== null && hash_equals($expectedToken, $providedToken);

if (!$hasValidToken) {
    logAuthEvent($providedToken === null ? 'missing' : 'invalid');
    if (AUTH_ENFORCE) {
        // Same ea-nginx cache trap as terminal.php/jsonResponse() -- without
        // this Set-Cookie, nginx caches this unauthenticated gate response
        // and keeps serving that STALE copy to every later request (even one
        // carrying a valid ccsw_token cookie) since a cache hit never
        // reaches PHP to re-check it. This was the actual cause of index.php
        // looking permanently gated for browsers that already had a good
        // cookie.
        noCacheHeaders(200);
        header('Content-Type: text/html; charset=utf-8');
        ?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CCSwitchboard</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0;
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #16181d;
    color: #e4e6eb;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .gate-card {
    background: #1e2128;
    border: 1px solid #2c303a;
    border-radius: 8px;
    padding: 32px;
    width: 300px;
    text-align: center;
  }
  .gate-card h1 {
    font-size: 15px;
    margin: 0 0 20px;
    font-weight: 600;
    color: #8b909c;
  }
  .gate-card label {
    display: block;
    text-align: left;
    font-size: 13px;
    color: #8b909c;
    margin-bottom: 6px;
  }
  .gate-card input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px 10px;
    background: #16181d;
    border: 1px solid #2c303a;
    border-radius: 4px;
    color: #e4e6eb;
    font-family: inherit;
    font-size: 14px;
    margin-bottom: 16px;
  }
  .gate-card button {
    width: 100%;
    padding: 9px;
    background: #6fb0f5;
    border: none;
    border-radius: 4px;
    color: #16181d;
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
  }
  .gate-card button:hover { opacity: 0.9; }
  .gate-hint { margin-top: 16px; margin-bottom: 0; font-size: 12px; line-height: 1.5; color: #8a929e; }
  .gate-hint code { background: #16181d; padding: 1px 5px; border-radius: 3px; font-size: 11px; color: #b7c0cc; }
</style>
</head>
<body>
  <div class="gate-card">
    <h1>CCSwitchboard</h1>
    <form id="gate-form">
      <label for="gate-token">Relay token</label>
      <input type="password" id="gate-token" autocomplete="off" autofocus>
      <button type="submit">Save</button>
    </form>
    <p class="gate-hint">Enter the CCSW relay token. It&#39;s the same token the extension uses &mdash; find it via <code>chrome.storage.local.get(&#39;ccswToken&#39;)</code> in the extension&#39;s service-worker console, or it&#39;s set automatically when you open the board from the extension&#39;s &quot;Open board&quot; menu.</p>
  </div>
  <script>
    document.getElementById('gate-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const value = document.getElementById('gate-token').value.trim();
      if (!value) return;
      // SameSite=Strict is load-bearing here, not cosmetic: it's what keeps
      // the mutating endpoints (clear_locks, cancel, force-close, resume)
      // safe from CSRF now that the token rides along as a cookie the
      // browser attaches automatically -- a cross-site page cannot make the
      // browser send a Strict cookie on a request it triggers.
      document.cookie = 'ccsw_token=' + encodeURIComponent(value) + '; path=/ccswitchboard/board; Secure; SameSite=Strict; max-age=34560000';
      location.reload();
    });
  </script>
</body>
</html>
<?php
        exit;
    }
}

// Same no-cache headers as db.php's jsonResponse() -- see terminal.php for
// why plain Cache-Control alone isn't enough on this host.
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('X-Accel-Expires: 0');
header('Set-Cookie: ccsw_nocache=1; Max-Age=0; Path=/ccswitchboard/board/');
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CCSwitchboard</title>
<link rel="icon" type="image/x-icon" href="favicon.ico?v=<?php echo @filemtime(__DIR__ . '/favicon.ico') ?: '1'; ?>">
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32x32.png?v=<?php echo @filemtime(__DIR__ . '/favicon-32x32.png') ?: '1'; ?>">
<link rel="icon" type="image/png" sizes="16x16" href="favicon-16x16.png?v=<?php echo @filemtime(__DIR__ . '/favicon-16x16.png') ?: '1'; ?>">
<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png?v=<?php echo @filemtime(__DIR__ . '/apple-touch-icon.png') ?: '1'; ?>">
<style>
  :root {
    color-scheme: dark;
    --bg: #16181d;
    --panel: #1e2128;
    --border: #2c303a;
    --text: #e4e6eb;
    --muted: #8b909c;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --pending: #d8a53d;
    --running: #e0a030;
    --done: #3fb97e;
    --link: #6fb0f5;
    --needs-input: #c77dff;
    --errored: #e5484d;
    --stale: #e5484d;
    --delivery-waiting: #4d8bf0;
  }

  * { box-sizing: border-box; }

  html, body {
    height: 100%;
  }

  body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    display: flex;
    flex-direction: column;
    /* dvh so mobile browser chrome (URL bar) never clips the bottom bar;
       the vh line is the fallback for engines without dvh. */
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
  }

  /* Fixed header region: brand, title, #meta and the activity-window chips
     stay pinned at the very top and never scroll away. Below it, #sections
     fills the rest of the viewport with the 3 collapsible bars. */
  #board-header {
    flex: 0 0 auto;
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
  }

  /* The 3-bar region: fills the viewport below the fixed header. Each bar is
     a <details> (.sbar). Open bars share the remaining height and scroll
     their own body internally; closed bars collapse to just their summary.
     This works for both breakpoints -- on mobile the accordion JS keeps at
     most one bar open, so the open one simply takes all the space. */
  #sections {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .sbar {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-bottom: 1px solid var(--border);
  }

  .sbar:not([open]) { flex: 0 0 auto; }
  .sbar[open] {
    flex: 1 1 0;
    /* Don't hold blank filler: a bar whose whole content is shorter than its
       equal share caps at content height and hands the leftover back to the
       other open bars (ignored harmlessly where max-content isn't supported). */
    max-height: max-content;
    /* Fallback clip for engines that can't style ::details-content below --
       overflow stays inside the bar instead of painting across later bars. */
    overflow: hidden;
  }

  /* The load-bearing rule for internal scrolling: <details> wraps everything
     after the <summary> in a UA-internal ::details-content box, which sits
     between .sbar (flex column) and .sbar-body. Left at its default
     display:block that wrapper grows to full content height, so .sbar-body's
     flex:1 / min-height:0 / overflow-y:auto never engage and the content
     spills over the bars below. Making the wrapper itself a min-height:0
     flex-column child restores the chain and the body becomes the scroller. */
  .sbar::details-content {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
  }

  /* Reuse the #admin-panel / #batch-records-panel summary look (mono, upper,
     rotating triangle marker) so these top-level bars read as the same kind
     of control the Tools panels use. */
  .sbar > summary {
    flex: 0 0 auto;
    padding: 12px 24px;
    cursor: pointer;
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    background: var(--panel);
    list-style: none;
    user-select: none;
  }

  .sbar > summary:hover { color: var(--text); }

  .sbar > summary::-webkit-details-marker { display: none; }

  .sbar > summary::before {
    content: '\25B8';
    display: inline-block;
    width: 12px;
    transition: transform 0.15s;
  }

  .sbar[open] > summary::before {
    transform: rotate(90deg);
  }

  .sbar-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 24px 20px;
  }

  /* Belt-and-braces over the UA default -- since .sbar is display:flex, make
     sure a closed bar's body is not rendered. */
  .sbar:not([open]) > .sbar-body { display: none; }

  /* #scroll-region is now a plain passthrough inside the Jobs bar body: the
     .sbar-body is the scroller, so #scroll-region no longer scrolls or pads
     on its own. Its id (and its #board child) are preserved for the render
     JS. */
  #scroll-region {
    padding: 0;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0;
  }

  .brand img {
    width: 64px;
    height: 64px;
    display: block;
  }

  .brand-text {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
  }

  .brand h1 {
    font-size: 18px;
    font-weight: 600;
    margin: 0;
    letter-spacing: 0.02em;
  }

  #meta {
    color: var(--muted);
    font-size: 12px;
  }

  .repo {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 16px;
    overflow: hidden;
  }

  .repo-header {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 600;
  }

  .repo-count {
    color: var(--muted);
    font-weight: 400;
    font-size: 12px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  td {
    padding: 8px 14px;
    border-top: 1px solid var(--border);
    font-size: 13px;
    vertical-align: top;
  }

  tr:first-child td {
    border-top: none;
  }

  .id {
    font-family: var(--mono);
    color: var(--muted);
    white-space: nowrap;
    width: 1%;
  }

  .name {
    white-space: nowrap;
    width: 1%;
  }

  .job-row {
    cursor: pointer;
  }

  .job-row:hover {
    background: rgba(255, 255, 255, 0.03);
  }

  .thread {
    font-family: var(--mono);
    white-space: nowrap;
    width: 1%;
    color: var(--text);
    cursor: pointer;
  }

  .thread:hover {
    text-decoration: underline;
  }

  .thread.none {
    color: var(--muted);
    font-style: italic;
    cursor: default;
  }

  .thread.none:hover {
    text-decoration: none;
  }

  .status-cell {
    white-space: nowrap;
    width: 1%;
  }

  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .pill.pending { background: rgba(216, 165, 61, 0.15); color: var(--pending); }
  .pill.running { background: rgba(224, 160, 48, 0.15); color: var(--running); }
  .pill.done { background: rgba(63, 185, 126, 0.15); color: var(--done); }
  .pill.stale { background: rgba(229, 72, 77, 0.15); color: var(--stale); }

  .resume-btn {
    display: inline-block;
    margin-left: 6px;
    padding: 2px 8px;
    border: 1px solid var(--stale);
    border-radius: 999px;
    background: transparent;
    color: var(--stale);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    cursor: pointer;
  }

  .resume-btn:hover {
    background: rgba(229, 72, 77, 0.15);
  }

  /* Per-row force-close: same pill-adjacent shape as .resume-btn, next to
     the status pill on pending/running/stale rows (not done -- force-closing
     an already-done job is a no-op nobody needs a button for). */
  .force-close-btn {
    display: inline-block;
    margin-left: 6px;
    padding: 2px 8px;
    border: 1px solid var(--errored);
    border-radius: 999px;
    background: transparent;
    color: var(--errored);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    cursor: pointer;
  }

  .force-close-btn:hover {
    background: rgba(229, 72, 77, 0.15);
  }

  /* Manual Controls: collapsible admin panel for the hand-fixes that would
     otherwise mean relaying curl commands (force-close a stuck job, clear
     repo locks, restart the agent). No `open` attribute, so it's collapsed
     by default and stays out of the way of the normal board view. */
  #admin-panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 16px;
    padding: 0 14px;
  }

  #admin-panel > summary {
    padding: 10px 0;
    cursor: pointer;
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    list-style: none;
  }

  #admin-panel > summary::-webkit-details-marker { display: none; }

  #admin-panel > summary::before {
    content: '\25B8';
    display: inline-block;
    width: 10px;
    transition: transform 0.15s;
  }

  #admin-panel[open] > summary::before {
    transform: rotate(90deg);
  }

  .admin-panel-body {
    padding: 4px 0 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .admin-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .admin-row-label {
    font-size: 12.5px;
    color: var(--muted);
    min-width: 130px;
  }

  .admin-btn {
    display: inline-flex;
    align-items: center;
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
  }

  .admin-btn:hover {
    filter: brightness(1.3);
  }

  .admin-btn.danger {
    border-color: var(--errored);
    color: var(--errored);
  }

  .admin-btn.danger:hover {
    background: rgba(229, 72, 77, 0.15);
  }

  .admin-input, .admin-select {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: var(--mono);
    font-size: 12.5px;
    padding: 5px 8px;
  }

  #admin-force-close-id {
    width: 90px;
  }

  #admin-clear-lock-repo {
    min-width: 160px;
  }

  .admin-note {
    font-size: 12px;
    color: var(--muted);
  }

  #admin-status {
    font-size: 12px;
    min-height: 16px;
  }

  #admin-status.error { color: var(--errored); }
  #admin-status.ok { color: var(--done); }

  .admin-locks-live {
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }

  .admin-locks-title {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
  }

  .admin-lock-row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-family: var(--mono);
    font-size: 12px;
    padding: 3px 0;
  }

  .admin-lock-repo {
    font-weight: 600;
    color: var(--text);
  }

  .admin-lock-thread {
    color: var(--muted);
  }

  /* Batch records (#50): same collapsed-by-default <details> shape as
     #admin-panel, sitting right below it inside the Tools bar. */
  #batch-records-panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 16px;
    padding: 0 14px;
  }

  #batch-records-panel > summary {
    padding: 10px 0;
    cursor: pointer;
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    list-style: none;
  }

  #batch-records-panel > summary::-webkit-details-marker { display: none; }

  #batch-records-panel > summary::before {
    content: '\25B8';
    display: inline-block;
    width: 10px;
    transition: transform 0.15s;
  }

  #batch-records-panel[open] > summary::before {
    transform: rotate(90deg);
  }

  .batch-records-body {
    padding: 4px 0 14px;
  }

  .batch-records-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 14px;
  }

  .record-card {
    flex: 1 1 160px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
  }

  .record-card-label {
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 4px;
  }

  .record-card-value {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text);
  }

  .record-card-sub {
    font-size: 11.5px;
    color: var(--muted);
    margin-top: 2px;
  }

  .batch-table th {
    padding: 8px 14px;
    border-top: none;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
  }

  .batch-table th:hover {
    color: var(--text);
  }

  .batch-table th.sorted::after {
    content: attr(data-arrow);
    margin-left: 4px;
    color: var(--link);
  }

  .batch-row {
    cursor: pointer;
  }

  .batch-row:hover {
    background: rgba(255, 255, 255, 0.03);
  }

  .batch-jobs-split {
    font-family: var(--mono);
    color: var(--muted);
    white-space: nowrap;
  }

  .batch-outcomes {
    white-space: nowrap;
  }

  .batch-outcomes .ok { color: var(--done); }
  .batch-outcomes .err { color: var(--errored); }

  .batch-detail-row[hidden] {
    display: none;
  }

  .batch-detail-row td {
    background: rgba(255, 255, 255, 0.02);
    border-top: none;
    padding: 0 14px 10px;
  }

  .batch-sub-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 4px;
  }

  .batch-sub-table td {
    padding: 4px 10px;
    border-top: 1px solid var(--border);
    font-size: 12px;
  }

  .batch-sub-table tr:first-child td {
    border-top: none;
  }

  .batch-sub-table .id {
    width: 1%;
  }

  .batch-sub-more {
    color: var(--muted);
    font-size: 11.5px;
    padding-top: 4px;
  }

  .batch-empty {
    color: var(--muted);
    font-size: 13px;
    padding: 6px 0;
  }

  /* Full-bleed, top-of-page banner for "agent offline" -- deliberately loud
     (solid fill, large bold text, pulsing) since a stale heartbeat means
     nothing dispatched to the agent will actually run until it reconnects.
     Sits above #board-header in document flow, pushing it (and #sections)
     down rather than overlapping -- see index.php body markup. */
  .offline-banner {
    flex: 0 0 auto;
    background: var(--errored);
    color: #fff;
    padding: 12px 24px;
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-align: center;
    animation: offline-banner-pulse 1.6s ease-in-out infinite;
  }

  #agent-offline-detail {
    font-weight: 500;
    opacity: 0.85;
  }

  @keyframes offline-banner-pulse {
    0%, 100% { background: var(--errored); }
    50% { background: #8f1216; }
  }

  .offline-banner[hidden] {
    display: none;
  }

  .pill.running::before {
    content: "";
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 5px;
    border-radius: 50%;
    background: var(--running);
    animation: pulse 1.2s ease-in-out infinite;
  }

  /* Quiet type indicator for a bash/command job's pill -- a CC job's pill
     stays unmarked, so this glyph is the only visual cue distinguishing the
     two without adding a whole extra label. */
  .pill-type-glyph {
    font-family: var(--mono);
    margin-right: 3px;
    opacity: 0.75;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.25; }
  }

  /* Small distinctive dot marking a job whose finished result (or advice
     send) is queued in the browser extension's send state machine but not
     yet typed/sent into Claude's chat -- e.g. because the composer was busy
     or Claude was still generating when it became ready to deliver. Blue so
     it never overloads the meaning of any status pill's own color (amber
     pending/running, green done, red error). Clears once background.js
     reports the delivery as sent (or a resend re-clears/re-sets it). */
  .delivery-waiting-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-left: 6px;
    border-radius: 50%;
    background: var(--delivery-waiting);
    vertical-align: middle;
    animation: pulse 1.2s ease-in-out infinite;
    cursor: help;
  }

  .summary {
    font-family: var(--mono);
    color: var(--muted);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .empty {
    color: var(--muted);
    font-size: 13px;
    padding: 20px 0;
  }

  .more-info-link {
    color: var(--link);
    cursor: pointer;
    font-size: 11.5px;
    text-decoration: underline;
    white-space: nowrap;
    margin-left: 8px;
  }

  .job-detail-row td {
    background: rgba(255, 255, 255, 0.02);
    border-top: none;
    padding-top: 0;
  }

  .job-detail-row[hidden] {
    display: none;
  }

  .job-detail {
    padding: 4px 0 10px;
  }

  .detail-line {
    font-size: 12.5px;
    margin-bottom: 4px;
  }

  .detail-label {
    color: var(--muted);
    font-weight: 600;
    margin-right: 4px;
  }

  .detail-pre {
    font-family: var(--mono);
    font-size: 12.5px;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 260px;
    overflow-y: auto;
    margin: 4px 0 0;
    padding: 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  #pill-hovercard {
    position: fixed;
    z-index: 1000;
    max-width: 420px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    /* Extra top padding (rather than a gap between the pill and the card's
       top edge) is what gives this its visual breathing room -- the card is
       positioned flush against the pill's bottom edge (see showHovercardForPill),
       so the pointer never has to cross a dead pixel strip with no hoverable
       element under it while moving from the pill down onto the card. */
    padding-top: 16px;
    font-size: 12.5px;
    color: var(--text);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }

  #pill-hovercard[hidden] {
    display: none;
  }

  .hovercard-summary {
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: 2px;
  }

  .hovercard-type {
    color: var(--muted);
    font-size: 11.5px;
    margin-bottom: 4px;
  }

  .hovercard-detail {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }

  .running-pinned {
    border-color: var(--running);
  }

  .running-pinned .repo-header {
    color: var(--running);
  }

  .thread-state-panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 16px;
    padding: 12px 14px;
  }

  .thread-state-header {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 10px;
  }

  .thread-state-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .state-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    font-family: var(--mono);
    font-size: 12px;
    cursor: pointer;
    border: 1px solid transparent;
  }

  .state-chip:hover {
    filter: brightness(1.2);
  }

  .state-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: 0 0 auto;
  }

  .state-chip.active { background: rgba(224, 160, 48, 0.15); color: var(--running); }
  .state-chip.active .state-dot { background: var(--running); animation: pulse 1.2s ease-in-out infinite; }

  .state-chip.needs_input { background: rgba(199, 125, 255, 0.15); color: var(--needs-input); }
  .state-chip.needs_input .state-dot { background: var(--needs-input); }

  .state-chip.errored { background: rgba(229, 72, 77, 0.15); color: var(--errored); }
  .state-chip.errored .state-dot { background: var(--errored); }

  .state-chip.dormant { background: rgba(139, 144, 156, 0.12); color: var(--muted); }
  .state-chip.dormant .state-dot { background: var(--muted); }

  .state-chip.idle { background: rgba(63, 185, 126, 0.15); color: var(--done); }
  .state-chip.idle .state-dot { background: var(--done); }

  .activity-window-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 4px;
  }

  .activity-window-label {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .activity-window-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .window-chip {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 999px;
    font-family: var(--mono);
    font-size: 12px;
    cursor: pointer;
    border: 1px solid var(--border);
    color: var(--muted);
    background: transparent;
  }

  .window-chip:hover {
    filter: brightness(1.3);
  }

  .window-chip.active {
    background: rgba(224, 160, 48, 0.15);
    border-color: var(--running);
    color: var(--running);
  }

  #thread-hovercard {
    position: fixed;
    z-index: 1000;
    max-width: 320px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    padding-top: 16px;
    font-size: 12.5px;
    color: var(--text);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }

  #thread-hovercard[hidden] {
    display: none;
  }

  .thread-hovercard-line {
    margin-bottom: 4px;
  }

  .thread-hovercard-links {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 14px;
  }

  .thread-hovercard-link {
    color: var(--link);
    cursor: pointer;
    font-size: 11.5px;
    text-decoration: underline;
  }

  .timer-cell {
    font-family: var(--mono);
    color: var(--muted);
    white-space: nowrap;
    width: 1%;
  }

  #feed-dialog {
    padding: 0;
    width: min(900px, 92vw);
    height: min(720px, 88vh);
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
  }

  #feed-dialog::backdrop {
    background: rgba(0, 0, 0, 0.55);
  }

  .feed-dialog-inner {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
  }

  .feed-dialog-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-family: var(--mono);
    font-size: 13px;
  }

  .feed-dialog-close {
    border: none;
    background: none;
    color: var(--muted);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 6px;
  }

  .feed-dialog-close:hover {
    color: var(--text);
  }

  .feed-dialog-title-wrap {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
  }

  .feed-dialog-detail {
    flex: 0 0 auto;
    max-height: 240px;
    overflow-y: auto;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }

  .feed-dialog-detail[hidden] {
    display: none;
  }

  #feed-dialog iframe {
    flex: 1 1 auto;
    width: 100%;
    height: 100%;
    border: none;
  }

  .phone-access-btn {
    margin-left: auto;
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
  }

  .phone-access-btn:hover {
    filter: brightness(1.3);
  }

  #phone-access-dialog {
    padding: 0;
    width: min(340px, 92vw);
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
  }

  #phone-access-dialog::backdrop {
    background: rgba(0, 0, 0, 0.55);
  }

  .phone-access-inner {
    display: flex;
    flex-direction: column;
  }

  .phone-access-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-family: var(--mono);
    font-size: 13px;
  }

  .phone-access-close {
    border: none;
    background: none;
    color: var(--muted);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 6px;
  }

  .phone-access-close:hover {
    color: var(--text);
  }

  .phone-access-body {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 20px;
  }

  #phone-access-qr {
    background: #fff;
    padding: 10px;
    border-radius: 6px;
    line-height: 0;
  }

  #phone-access-qr svg {
    display: block;
    width: 220px;
    height: 220px;
  }

  .phone-access-help {
    margin: 0;
    text-align: center;
    font-size: 12.5px;
    color: var(--muted);
    line-height: 1.5;
  }

  /* ---- Narrow screens (same 768px breakpoint as the accordion JS) ---- */
  @media (max-width: 768px) {
    #board-header { padding: 12px 16px; }
    .sbar > summary { padding: 12px 16px; }
    .sbar-body { padding: 10px 16px 16px; }

    /* Reflow job/running rows as stacked cards. As six nowrap table columns
       they render far wider than the phone viewport: status/thread/summary
       end up off-screen to the right, and the squeezed summary column's text
       wrapping blows each row up to hundreds of px of blank height. */
    #board table, #running-section table,
    #board tbody, #running-section tbody { display: block; width: 100%; }
    #board tr, #running-section tr {
      display: block;
      padding: 8px 14px;
      border-top: 1px solid var(--border);
    }
    #board tr:first-child, #running-section tr:first-child { border-top: none; }
    #board td, #running-section td {
      display: inline;
      padding: 0;
      border: none;
    }
    /* Long titles wrap within the card instead of overflowing it. */
    #board td.name, #running-section td.name { white-space: normal; }
    #board td.summary, #running-section td.summary {
      display: block;
      margin-top: 4px;
    }
    #board tr.job-detail-row, #running-section tr.job-detail-row {
      padding: 0 14px 8px;
      border-top: none;
    }
    #board .job-detail-row td, #running-section .job-detail-row td { display: block; }
    /* The block display on #board tr above outranks .job-detail-row[hidden]'s
       display:none (id vs class specificity) -- restate hidden here. */
    #board tr[hidden], #running-section tr[hidden] { display: none; }

    /* Wide batch tables pan sideways inside Tools instead of blowing out. */
    #batch-records-panel { overflow-x: auto; }
  }
</style>
</head>
<body>
  <div id="agent-offline-banner" class="offline-banner" hidden>
    &#9888; AGENT OFFLINE <span id="agent-offline-detail"></span>
  </div>
  <header id="board-header">
    <div class="brand">
      <img src="logo-64.png?v=<?php echo @filemtime(__DIR__ . '/logo-64.png') ?: '1'; ?>" alt="">
      <div class="brand-text">
        <h1>CCSwitchboard</h1>
        <div id="meta">refreshing every 3s</div>
        <div id="activity-window-section"></div>
      </div>
      <button type="button" id="phone-access-btn" class="phone-access-btn" title="Phone access">&#128241; Phone access</button>
      <a href="machines.php" class="phone-access-btn" style="margin-left:8px;text-decoration:none" title="Machines">&#128421; Machines</a>
    </div>
  </header>

  <div id="sections">
    <!-- Bar 1: Summaries -- thread state + running-now, unchanged inner ids. -->
    <details id="sbar-summaries" class="sbar" open>
      <summary>Summaries</summary>
      <div class="sbar-body">
        <div id="thread-state-section"></div>
        <div id="running-section"></div>
      </div>
    </details>

    <!-- Bar 2: Jobs -- the by-repo job list. #scroll-region/#board preserved. -->
    <details id="sbar-jobs" class="sbar" open>
      <summary>Jobs</summary>
      <div class="sbar-body">
        <div id="scroll-region">
          <div id="board"><div class="empty">Loading...</div></div>
        </div>
      </div>
    </details>

    <!-- Bar 3: Tools -- the existing Manual controls + Batch records panels
         nested inside, each still its own collapsible <details>. -->
    <details id="sbar-tools" class="sbar">
      <summary>Tools</summary>
      <div class="sbar-body">
        <details id="admin-panel">
          <summary>Manual controls</summary>
          <div class="admin-panel-body">
            <div class="admin-row">
              <span class="admin-row-label">Force-close job</span>
              <input type="number" id="admin-force-close-id" class="admin-input" placeholder="job id" min="1">
              <button type="button" class="admin-btn danger" id="admin-force-close-btn">Force-close</button>
            </div>
            <div class="admin-row">
              <span class="admin-row-label">Clear one lock</span>
              <select id="admin-clear-lock-repo" class="admin-select">
                <option value="">(no locks held)</option>
              </select>
              <button type="button" class="admin-btn" id="admin-clear-lock-btn">Clear lock</button>
            </div>
            <div class="admin-row">
              <span class="admin-row-label">Clear ALL locks</span>
              <button type="button" class="admin-btn danger" id="admin-clear-all-locks-btn">Clear all locks</button>
            </div>
            <div class="admin-row">
              <span class="admin-row-label">Restart agent</span>
              <button type="button" class="admin-btn danger" id="admin-restart-agent-btn">Restart agent</button>
            </div>
            <div class="admin-row">
              <span class="admin-row-label">Clear ghost pills</span>
              <span class="admin-note">Client-side only (chrome.storage ccswThreadJobs) -- use "Clear ghost pills" in the extension's icon menu on claude.ai. Not reachable from this board.</span>
            </div>
            <div id="admin-status"></div>
            <div class="admin-locks-live">
              <div class="admin-locks-title">Current locks</div>
              <div id="admin-locks-list">(expand to load)</div>
            </div>
          </div>
        </details>
        <details id="batch-records-panel">
          <summary>Batch records</summary>
          <div class="batch-records-body" id="batch-records-body">Loading...</div>
        </details>
      </div>
    </details>
  </div>

  <dialog id="feed-dialog">
    <div class="feed-dialog-inner">
      <div class="feed-dialog-header">
        <div class="feed-dialog-title-wrap">
          <span id="feed-dialog-title"></span>
          <span class="more-info-link" id="feed-dialog-more-info" hidden>more info...</span>
        </div>
        <button type="button" class="feed-dialog-close" id="feed-dialog-close" aria-label="Close">&times;</button>
      </div>
      <div class="feed-dialog-detail" id="feed-dialog-detail" hidden></div>
      <iframe id="feed-dialog-frame" src="about:blank"></iframe>
    </div>
  </dialog>

  <dialog id="phone-access-dialog">
    <div class="phone-access-inner">
      <div class="phone-access-header">
        <span>Phone access</span>
        <button type="button" class="phone-access-close" id="phone-access-close" aria-label="Close">&times;</button>
      </div>
      <div class="phone-access-body">
        <div id="phone-access-qr"></div>
        <p class="phone-access-help">Scan with your phone to log in -- stays logged in on that device.</p>
      </div>
    </div>
  </dialog>

  <script>
    // qrcode-generator by Kazuhiko Arase (MIT license,
    // https://github.com/kazuhikoarase/qrcode-generator), inlined verbatim
    // (minified) so the Phone access QR code never depends on a CDN or
    // network fetch. Exposes a single global: qrcode(typeNumber, ecLevel).
    var qrcode=function(){var t=function(t,r){var e=t,n=g[r],o=null,i=0,a=null,u=[],f={},c=function(t,r){o=function(t){for(var r=new Array(t),e=0;e<t;e+=1){r[e]=new Array(t);for(var n=0;n<t;n+=1)r[e][n]=null}return r}(i=4*e+17),l(0,0),l(i-7,0),l(0,i-7),s(),h(),d(t,r),e>=7&&v(t),null==a&&(a=p(e,n,u)),w(a,r)},l=function(t,r){for(var e=-1;e<=7;e+=1)if(!(t+e<=-1||i<=t+e))for(var n=-1;n<=7;n+=1)r+n<=-1||i<=r+n||(o[t+e][r+n]=0<=e&&e<=6&&(0==n||6==n)||0<=n&&n<=6&&(0==e||6==e)||2<=e&&e<=4&&2<=n&&n<=4)},h=function(){for(var t=8;t<i-8;t+=1)null==o[t][6]&&(o[t][6]=t%2==0);for(var r=8;r<i-8;r+=1)null==o[6][r]&&(o[6][r]=r%2==0)},s=function(){for(var t=B.getPatternPosition(e),r=0;r<t.length;r+=1)for(var n=0;n<t.length;n+=1){var i=t[r],a=t[n];if(null==o[i][a])for(var u=-2;u<=2;u+=1)for(var f=-2;f<=2;f+=1)o[i+u][a+f]=-2==u||2==u||-2==f||2==f||0==u&&0==f}},v=function(t){for(var r=B.getBCHTypeNumber(e),n=0;n<18;n+=1){var a=!t&&1==(r>>n&1);o[Math.floor(n/3)][n%3+i-8-3]=a}for(n=0;n<18;n+=1){a=!t&&1==(r>>n&1);o[n%3+i-8-3][Math.floor(n/3)]=a}},d=function(t,r){for(var e=n<<3|r,a=B.getBCHTypeInfo(e),u=0;u<15;u+=1){var f=!t&&1==(a>>u&1);u<6?o[u][8]=f:u<8?o[u+1][8]=f:o[i-15+u][8]=f}for(u=0;u<15;u+=1){f=!t&&1==(a>>u&1);u<8?o[8][i-u-1]=f:u<9?o[8][15-u-1+1]=f:o[8][15-u-1]=f}o[i-8][8]=!t},w=function(t,r){for(var e=-1,n=i-1,a=7,u=0,f=B.getMaskFunction(r),c=i-1;c>0;c-=2)for(6==c&&(c-=1);;){for(var g=0;g<2;g+=1)if(null==o[n][c-g]){var l=!1;u<t.length&&(l=1==(t[u]>>>a&1)),f(n,c-g)&&(l=!l),o[n][c-g]=l,-1==(a-=1)&&(u+=1,a=7)}if((n+=e)<0||i<=n){n-=e,e=-e;break}}},p=function(t,r,e){for(var n=A.getRSBlocks(t,r),o=b(),i=0;i<e.length;i+=1){var a=e[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var u=0;for(i=0;i<n.length;i+=1)u+=n[i].dataCount;if(o.getLengthInBits()>8*u)throw"code length overflow. ("+o.getLengthInBits()+">"+8*u+")";for(o.getLengthInBits()+4<=8*u&&o.put(0,4);o.getLengthInBits()%8!=0;)o.putBit(!1);for(;!(o.getLengthInBits()>=8*u||(o.put(236,8),o.getLengthInBits()>=8*u));)o.put(17,8);return function(t,r){for(var e=0,n=0,o=0,i=new Array(r.length),a=new Array(r.length),u=0;u<r.length;u+=1){var f=r[u].dataCount,c=r[u].totalCount-f;n=Math.max(n,f),o=Math.max(o,c),i[u]=new Array(f);for(var g=0;g<i[u].length;g+=1)i[u][g]=255&t.getBuffer()[g+e];e+=f;var l=B.getErrorCorrectPolynomial(c),h=k(i[u],l.getLength()-1).mod(l);for(a[u]=new Array(l.getLength()-1),g=0;g<a[u].length;g+=1){var s=g+h.getLength()-a[u].length;a[u][g]=s>=0?h.getAt(s):0}}var v=0;for(g=0;g<r.length;g+=1)v+=r[g].totalCount;var d=new Array(v),w=0;for(g=0;g<n;g+=1)for(u=0;u<r.length;u+=1)g<i[u].length&&(d[w]=i[u][g],w+=1);for(g=0;g<o;g+=1)for(u=0;u<r.length;u+=1)g<a[u].length&&(d[w]=a[u][g],w+=1);return d}(o,n)};f.addData=function(t,r){var e=null;switch(r=r||"Byte"){case"Numeric":e=M(t);break;case"Alphanumeric":e=x(t);break;case"Byte":e=m(t);break;case"Kanji":e=L(t);break;default:throw"mode:"+r}u.push(e),a=null},f.isDark=function(t,r){if(t<0||i<=t||r<0||i<=r)throw t+","+r;return o[t][r]},f.getModuleCount=function(){return i},f.make=function(){if(e<1){for(var t=1;t<40;t++){for(var r=A.getRSBlocks(t,n),o=b(),i=0;i<u.length;i++){var a=u[i];o.put(a.getMode(),4),o.put(a.getLength(),B.getLengthInBits(a.getMode(),t)),a.write(o)}var g=0;for(i=0;i<r.length;i++)g+=r[i].dataCount;if(o.getLengthInBits()<=8*g)break}e=t}c(!1,function(){for(var t=0,r=0,e=0;e<8;e+=1){c(!0,e);var n=B.getLostPoint(f);(0==e||t>n)&&(t=n,r=e)}return r}())},f.createTableTag=function(t,r){t=t||2;var e="";e+='<table style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: "+(r=void 0===r?4*t:r)+"px;",e+='">',e+="<tbody>";for(var n=0;n<f.getModuleCount();n+=1){e+="<tr>";for(var o=0;o<f.getModuleCount();o+=1)e+='<td style="',e+=" border-width: 0px; border-style: none;",e+=" border-collapse: collapse;",e+=" padding: 0px; margin: 0px;",e+=" width: "+t+"px;",e+=" height: "+t+"px;",e+=" background-color: ",e+=f.isDark(n,o)?"#000000":"#ffffff",e+=";",e+='"/>';e+="</tr>"}return e+="</tbody>",e+="</table>"},f.createSvgTag=function(t,r,e,n){var o={};"object"==typeof arguments[0]&&(t=(o=arguments[0]).cellSize,r=o.margin,e=o.alt,n=o.title),t=t||2,r=void 0===r?4*t:r,(e="string"==typeof e?{text:e}:e||{}).text=e.text||null,e.id=e.text?e.id||"qrcode-description":null,(n="string"==typeof n?{text:n}:n||{}).text=n.text||null,n.id=n.text?n.id||"qrcode-title":null;var i,a,u,c,g=f.getModuleCount()*t+2*r,l="";for(c="l"+t+",0 0,"+t+" -"+t+",0 0,-"+t+"z ",l+='<svg version="1.1" xmlns="http://www.w3.org/2000/svg"',l+=o.scalable?"":' width="'+g+'px" height="'+g+'px"',l+=' viewBox="0 0 '+g+" "+g+'" ',l+=' preserveAspectRatio="xMinYMin meet"',l+=n.text||e.text?' role="img" aria-labelledby="'+y([n.id,e.id].join(" ").trim())+'"':"",l+=">",l+=n.text?'<title id="'+y(n.id)+'">'+y(n.text)+"</title>":"",l+=e.text?'<description id="'+y(e.id)+'">'+y(e.text)+"</description>":"",l+='<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>',l+='<path d="',a=0;a<f.getModuleCount();a+=1)for(u=a*t+r,i=0;i<f.getModuleCount();i+=1)f.isDark(a,i)&&(l+="M"+(i*t+r)+","+u+c);return l+='" stroke="transparent" fill="black"/>',l+="</svg>"},f.createDataURL=function(t,r){t=t||2,r=void 0===r?4*t:r;var e=f.getModuleCount()*t+2*r,n=r,o=e-r;return I(e,e,function(r,e){if(n<=r&&r<o&&n<=e&&e<o){var i=Math.floor((r-n)/t),a=Math.floor((e-n)/t);return f.isDark(a,i)?0:1}return 1})},f.createImgTag=function(t,r,e){t=t||2,r=void 0===r?4*t:r;var n=f.getModuleCount()*t+2*r,o="";return o+="<img",o+=' src="',o+=f.createDataURL(t,r),o+='"',o+=' width="',o+=n,o+='"',o+=' height="',o+=n,o+='"',e&&(o+=' alt="',o+=y(e),o+='"'),o+="/>"};var y=function(t){for(var r="",e=0;e<t.length;e+=1){var n=t.charAt(e);switch(n){case"<":r+="&lt;";break;case">":r+="&gt;";break;case"&":r+="&amp;";break;case'"':r+="&quot;";break;default:r+=n}}return r};return f.createASCII=function(t,r){if((t=t||1)<2)return function(t){t=void 0===t?2:t;var r,e,n,o,i,a=1*f.getModuleCount()+2*t,u=t,c=a-t,g={"██":"█","█ ":"▀"," █":"▄","  ":" "},l={"██":"▀","█ ":"▀"," █":" ","  ":" "},h="";for(r=0;r<a;r+=2){for(n=Math.floor((r-u)/1),o=Math.floor((r+1-u)/1),e=0;e<a;e+=1)i="█",u<=e&&e<c&&u<=r&&r<c&&f.isDark(n,Math.floor((e-u)/1))&&(i=" "),u<=e&&e<c&&u<=r+1&&r+1<c&&f.isDark(o,Math.floor((e-u)/1))?i+=" ":i+="█",h+=t<1&&r+1>=c?l[i]:g[i];h+="\n"}return a%2&&t>0?h.substring(0,h.length-a-1)+Array(a+1).join("▀"):h.substring(0,h.length-1)}(r);t-=1,r=void 0===r?2*t:r;var e,n,o,i,a=f.getModuleCount()*t+2*r,u=r,c=a-r,g=Array(t+1).join("██"),l=Array(t+1).join("  "),h="",s="";for(e=0;e<a;e+=1){for(o=Math.floor((e-u)/t),s="",n=0;n<a;n+=1)i=1,u<=n&&n<c&&u<=e&&e<c&&f.isDark(o,Math.floor((n-u)/t))&&(i=0),s+=i?g:l;for(o=0;o<t;o+=1)h+=s+"\n"}return h.substring(0,h.length-1)},f.renderTo2dContext=function(t,r){r=r||2;for(var e=f.getModuleCount(),n=0;n<e;n++)for(var o=0;o<e;o++)t.fillStyle=f.isDark(n,o)?"black":"white",t.fillRect(o*r,n*r,r,r)},f};t.stringToBytes=(t.stringToBytesFuncs={default:function(t){for(var r=[],e=0;e<t.length;e+=1){var n=t.charCodeAt(e);r.push(255&n)}return r}}).default,t.createStringToBytes=function(t,r){var e=function(){for(var e=S(t),n=function(){var t=e.read();if(-1==t)throw"eof";return t},o=0,i={};;){var a=e.read();if(-1==a)break;var u=n(),f=n()<<8|n();i[String.fromCharCode(a<<8|u)]=f,o+=1}if(o!=r)throw o+" != "+r;return i}(),n="?".charCodeAt(0);return function(t){for(var r=[],o=0;o<t.length;o+=1){var i=t.charCodeAt(o);if(i<128)r.push(i);else{var a=e[t.charAt(o)];"number"==typeof a?(255&a)==a?r.push(a):(r.push(a>>>8),r.push(255&a)):r.push(n)}}return r}};var r,e,n,o,i,a=1,u=2,f=4,c=8,g={L:1,M:0,Q:3,H:2},l=0,h=1,s=2,v=3,d=4,w=5,p=6,y=7,B=(r=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50],[6,30,54],[6,32,58],[6,34,62],[6,26,46,66],[6,26,48,70],[6,26,50,74],[6,30,54,78],[6,30,56,82],[6,30,58,86],[6,34,62,90],[6,28,50,72,94],[6,26,50,74,98],[6,30,54,78,102],[6,28,54,80,106],[6,32,58,84,110],[6,30,58,86,114],[6,34,62,90,118],[6,26,50,74,98,122],[6,30,54,78,102,126],[6,26,52,78,104,130],[6,30,56,82,108,134],[6,34,60,86,112,138],[6,30,58,86,114,142],[6,34,62,90,118,146],[6,30,54,78,102,126,150],[6,24,50,76,102,128,154],[6,28,54,80,106,132,158],[6,32,58,84,110,136,162],[6,26,54,82,110,138,166],[6,30,58,86,114,142,170]],e=1335,n=7973,i=function(t){for(var r=0;0!=t;)r+=1,t>>>=1;return r},(o={}).getBCHTypeInfo=function(t){for(var r=t<<10;i(r)-i(e)>=0;)r^=e<<i(r)-i(e);return 21522^(t<<10|r)},o.getBCHTypeNumber=function(t){for(var r=t<<12;i(r)-i(n)>=0;)r^=n<<i(r)-i(n);return t<<12|r},o.getPatternPosition=function(t){return r[t-1]},o.getMaskFunction=function(t){switch(t){case l:return function(t,r){return(t+r)%2==0};case h:return function(t,r){return t%2==0};case s:return function(t,r){return r%3==0};case v:return function(t,r){return(t+r)%3==0};case d:return function(t,r){return(Math.floor(t/2)+Math.floor(r/3))%2==0};case w:return function(t,r){return t*r%2+t*r%3==0};case p:return function(t,r){return(t*r%2+t*r%3)%2==0};case y:return function(t,r){return(t*r%3+(t+r)%2)%2==0};default:throw"bad maskPattern:"+t}},o.getErrorCorrectPolynomial=function(t){for(var r=k([1],0),e=0;e<t;e+=1)r=r.multiply(k([1,C.gexp(e)],0));return r},o.getLengthInBits=function(t,r){if(1<=r&&r<10)switch(t){case a:return 10;case u:return 9;case f:case c:return 8;default:throw"mode:"+t}else if(r<27)switch(t){case a:return 12;case u:return 11;case f:return 16;case c:return 10;default:throw"mode:"+t}else{if(!(r<41))throw"type:"+r;switch(t){case a:return 14;case u:return 13;case f:return 16;case c:return 12;default:throw"mode:"+t}}},o.getLostPoint=function(t){for(var r=t.getModuleCount(),e=0,n=0;n<r;n+=1)for(var o=0;o<r;o+=1){for(var i=0,a=t.isDark(n,o),u=-1;u<=1;u+=1)if(!(n+u<0||r<=n+u))for(var f=-1;f<=1;f+=1)o+f<0||r<=o+f||0==u&&0==f||a==t.isDark(n+u,o+f)&&(i+=1);i>5&&(e+=3+i-5)}for(n=0;n<r-1;n+=1)for(o=0;o<r-1;o+=1){var c=0;t.isDark(n,o)&&(c+=1),t.isDark(n+1,o)&&(c+=1),t.isDark(n,o+1)&&(c+=1),t.isDark(n+1,o+1)&&(c+=1),0!=c&&4!=c||(e+=3)}for(n=0;n<r;n+=1)for(o=0;o<r-6;o+=1)t.isDark(n,o)&&!t.isDark(n,o+1)&&t.isDark(n,o+2)&&t.isDark(n,o+3)&&t.isDark(n,o+4)&&!t.isDark(n,o+5)&&t.isDark(n,o+6)&&(e+=40);for(o=0;o<r;o+=1)for(n=0;n<r-6;n+=1)t.isDark(n,o)&&!t.isDark(n+1,o)&&t.isDark(n+2,o)&&t.isDark(n+3,o)&&t.isDark(n+4,o)&&!t.isDark(n+5,o)&&t.isDark(n+6,o)&&(e+=40);var g=0;for(o=0;o<r;o+=1)for(n=0;n<r;n+=1)t.isDark(n,o)&&(g+=1);return e+=Math.abs(100*g/r/r-50)/5*10},o),C=function(){for(var t=new Array(256),r=new Array(256),e=0;e<8;e+=1)t[e]=1<<e;for(e=8;e<256;e+=1)t[e]=t[e-4]^t[e-5]^t[e-6]^t[e-8];for(e=0;e<255;e+=1)r[t[e]]=e;var n={glog:function(t){if(t<1)throw"glog("+t+")";return r[t]},gexp:function(r){for(;r<0;)r+=255;for(;r>=256;)r-=255;return t[r]}};return n}();function k(t,r){if(void 0===t.length)throw t.length+"/"+r;var e=function(){for(var e=0;e<t.length&&0==t[e];)e+=1;for(var n=new Array(t.length-e+r),o=0;o<t.length-e;o+=1)n[o]=t[o+e];return n}(),n={getAt:function(t){return e[t]},getLength:function(){return e.length},multiply:function(t){for(var r=new Array(n.getLength()+t.getLength()-1),e=0;e<n.getLength();e+=1)for(var o=0;o<t.getLength();o+=1)r[e+o]^=C.gexp(C.glog(n.getAt(e))+C.glog(t.getAt(o)));return k(r,0)},mod:function(t){if(n.getLength()-t.getLength()<0)return n;for(var r=C.glog(n.getAt(0))-C.glog(t.getAt(0)),e=new Array(n.getLength()),o=0;o<n.getLength();o+=1)e[o]=n.getAt(o);for(o=0;o<t.getLength();o+=1)e[o]^=C.gexp(C.glog(t.getAt(o))+r);return k(e,0).mod(t)}};return n}var A=function(){var t=[[1,26,19],[1,26,16],[1,26,13],[1,26,9],[1,44,34],[1,44,28],[1,44,22],[1,44,16],[1,70,55],[1,70,44],[2,35,17],[2,35,13],[1,100,80],[2,50,32],[2,50,24],[4,25,9],[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12],[2,86,68],[4,43,27],[4,43,19],[4,43,15],[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14],[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15],[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13],[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16],[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13],[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15],[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12],[3,145,115,1,146,116],[4,64,40,5,65,41],[11,36,16,5,37,17],[11,36,12,5,37,13],[5,109,87,1,110,88],[5,65,41,5,66,42],[5,54,24,7,55,25],[11,36,12,7,37,13],[5,122,98,1,123,99],[7,73,45,3,74,46],[15,43,19,2,44,20],[3,45,15,13,46,16],[1,135,107,5,136,108],[10,74,46,1,75,47],[1,50,22,15,51,23],[2,42,14,17,43,15],[5,150,120,1,151,121],[9,69,43,4,70,44],[17,50,22,1,51,23],[2,42,14,19,43,15],[3,141,113,4,142,114],[3,70,44,11,71,45],[17,47,21,4,48,22],[9,39,13,16,40,14],[3,135,107,5,136,108],[3,67,41,13,68,42],[15,54,24,5,55,25],[15,43,15,10,44,16],[4,144,116,4,145,117],[17,68,42],[17,50,22,6,51,23],[19,46,16,6,47,17],[2,139,111,7,140,112],[17,74,46],[7,54,24,16,55,25],[34,37,13],[4,151,121,5,152,122],[4,75,47,14,76,48],[11,54,24,14,55,25],[16,45,15,14,46,16],[6,147,117,4,148,118],[6,73,45,14,74,46],[11,54,24,16,55,25],[30,46,16,2,47,17],[8,132,106,4,133,107],[8,75,47,13,76,48],[7,54,24,22,55,25],[22,45,15,13,46,16],[10,142,114,2,143,115],[19,74,46,4,75,47],[28,50,22,6,51,23],[33,46,16,4,47,17],[8,152,122,4,153,123],[22,73,45,3,74,46],[8,53,23,26,54,24],[12,45,15,28,46,16],[3,147,117,10,148,118],[3,73,45,23,74,46],[4,54,24,31,55,25],[11,45,15,31,46,16],[7,146,116,7,147,117],[21,73,45,7,74,46],[1,53,23,37,54,24],[19,45,15,26,46,16],[5,145,115,10,146,116],[19,75,47,10,76,48],[15,54,24,25,55,25],[23,45,15,25,46,16],[13,145,115,3,146,116],[2,74,46,29,75,47],[42,54,24,1,55,25],[23,45,15,28,46,16],[17,145,115],[10,74,46,23,75,47],[10,54,24,35,55,25],[19,45,15,35,46,16],[17,145,115,1,146,116],[14,74,46,21,75,47],[29,54,24,19,55,25],[11,45,15,46,46,16],[13,145,115,6,146,116],[14,74,46,23,75,47],[44,54,24,7,55,25],[59,46,16,1,47,17],[12,151,121,7,152,122],[12,75,47,26,76,48],[39,54,24,14,55,25],[22,45,15,41,46,16],[6,151,121,14,152,122],[6,75,47,34,76,48],[46,54,24,10,55,25],[2,45,15,64,46,16],[17,152,122,4,153,123],[29,74,46,14,75,47],[49,54,24,10,55,25],[24,45,15,46,46,16],[4,152,122,18,153,123],[13,74,46,32,75,47],[48,54,24,14,55,25],[42,45,15,32,46,16],[20,147,117,4,148,118],[40,75,47,7,76,48],[43,54,24,22,55,25],[10,45,15,67,46,16],[19,148,118,6,149,119],[18,75,47,31,76,48],[34,54,24,34,55,25],[20,45,15,61,46,16]],r=function(t,r){var e={};return e.totalCount=t,e.dataCount=r,e},e={};return e.getRSBlocks=function(e,n){var o=function(r,e){switch(e){case g.L:return t[4*(r-1)+0];case g.M:return t[4*(r-1)+1];case g.Q:return t[4*(r-1)+2];case g.H:return t[4*(r-1)+3];default:return}}(e,n);if(void 0===o)throw"bad rs block @ typeNumber:"+e+"/errorCorrectionLevel:"+n;for(var i=o.length/3,a=[],u=0;u<i;u+=1)for(var f=o[3*u+0],c=o[3*u+1],l=o[3*u+2],h=0;h<f;h+=1)a.push(r(c,l));return a},e}(),b=function(){var t=[],r=0,e={getBuffer:function(){return t},getAt:function(r){var e=Math.floor(r/8);return 1==(t[e]>>>7-r%8&1)},put:function(t,r){for(var n=0;n<r;n+=1)e.putBit(1==(t>>>r-n-1&1))},getLengthInBits:function(){return r},putBit:function(e){var n=Math.floor(r/8);t.length<=n&&t.push(0),e&&(t[n]|=128>>>r%8),r+=1}};return e},M=function(t){var r=a,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+2<r.length;)t.put(o(r.substring(n,n+3)),10),n+=3;n<r.length&&(r.length-n==1?t.put(o(r.substring(n,n+1)),4):r.length-n==2&&t.put(o(r.substring(n,n+2)),7))}},o=function(t){for(var r=0,e=0;e<t.length;e+=1)r=10*r+i(t.charAt(e));return r},i=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);throw"illegal char :"+t};return n},x=function(t){var r=u,e=t,n={getMode:function(){return r},getLength:function(t){return e.length},write:function(t){for(var r=e,n=0;n+1<r.length;)t.put(45*o(r.charAt(n))+o(r.charAt(n+1)),11),n+=2;n<r.length&&t.put(o(r.charAt(n)),6)}},o=function(t){if("0"<=t&&t<="9")return t.charCodeAt(0)-"0".charCodeAt(0);if("A"<=t&&t<="Z")return t.charCodeAt(0)-"A".charCodeAt(0)+10;switch(t){case" ":return 36;case"$":return 37;case"%":return 38;case"*":return 39;case"+":return 40;case"-":return 41;case".":return 42;case"/":return 43;case":":return 44;default:throw"illegal char :"+t}};return n},m=function(r){var e=f,n=t.stringToBytes(r),o={getMode:function(){return e},getLength:function(t){return n.length},write:function(t){for(var r=0;r<n.length;r+=1)t.put(n[r],8)}};return o},L=function(r){var e=c,n=t.stringToBytesFuncs.SJIS;if(!n)throw"sjis not supported.";!function(){var t=n("友");if(2!=t.length||38726!=(t[0]<<8|t[1]))throw"sjis not supported."}();var o=n(r),i={getMode:function(){return e},getLength:function(t){return~~(o.length/2)},write:function(t){for(var r=o,e=0;e+1<r.length;){var n=(255&r[e])<<8|255&r[e+1];if(33088<=n&&n<=40956)n-=33088;else{if(!(57408<=n&&n<=60351))throw"illegal char at "+(e+1)+"/"+n;n-=49472}n=192*(n>>>8&255)+(255&n),t.put(n,13),e+=2}if(e<r.length)throw"illegal char at "+(e+1)}};return i},D=function(){var t=[],r={writeByte:function(r){t.push(255&r)},writeShort:function(t){r.writeByte(t),r.writeByte(t>>>8)},writeBytes:function(t,e,n){e=e||0,n=n||t.length;for(var o=0;o<n;o+=1)r.writeByte(t[o+e])},writeString:function(t){for(var e=0;e<t.length;e+=1)r.writeByte(t.charCodeAt(e))},toByteArray:function(){return t},toString:function(){var r="";r+="[";for(var e=0;e<t.length;e+=1)e>0&&(r+=","),r+=t[e];return r+="]"}};return r},S=function(t){var r=t,e=0,n=0,o=0,i={read:function(){for(;o<8;){if(e>=r.length){if(0==o)return-1;throw"unexpected end of file./"+o}var t=r.charAt(e);if(e+=1,"="==t)return o=0,-1;t.match(/^\s$/)||(n=n<<6|a(t.charCodeAt(0)),o+=6)}var i=n>>>o-8&255;return o-=8,i}},a=function(t){if(65<=t&&t<=90)return t-65;if(97<=t&&t<=122)return t-97+26;if(48<=t&&t<=57)return t-48+52;if(43==t)return 62;if(47==t)return 63;throw"c:"+t};return i},I=function(t,r,e){for(var n=function(t,r){var e=t,n=r,o=new Array(t*r),i={setPixel:function(t,r,n){o[r*e+t]=n},write:function(t){t.writeString("GIF87a"),t.writeShort(e),t.writeShort(n),t.writeByte(128),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(0),t.writeByte(255),t.writeByte(255),t.writeByte(255),t.writeString(","),t.writeShort(0),t.writeShort(0),t.writeShort(e),t.writeShort(n),t.writeByte(0);var r=a(2);t.writeByte(2);for(var o=0;r.length-o>255;)t.writeByte(255),t.writeBytes(r,o,255),o+=255;t.writeByte(r.length-o),t.writeBytes(r,o,r.length-o),t.writeByte(0),t.writeString(";")}},a=function(t){for(var r=1<<t,e=1+(1<<t),n=t+1,i=u(),a=0;a<r;a+=1)i.add(String.fromCharCode(a));i.add(String.fromCharCode(r)),i.add(String.fromCharCode(e));var f,c,g,l=D(),h=(f=l,c=0,g=0,{write:function(t,r){if(t>>>r!=0)throw"length over";for(;c+r>=8;)f.writeByte(255&(t<<c|g)),r-=8-c,t>>>=8-c,g=0,c=0;g|=t<<c,c+=r},flush:function(){c>0&&f.writeByte(g)}});h.write(r,n);var s=0,v=String.fromCharCode(o[s]);for(s+=1;s<o.length;){var d=String.fromCharCode(o[s]);s+=1,i.contains(v+d)?v+=d:(h.write(i.indexOf(v),n),i.size()<4095&&(i.size()==1<<n&&(n+=1),i.add(v+d)),v=d)}return h.write(i.indexOf(v),n),h.write(e,n),h.flush(),l.toByteArray()},u=function(){var t={},r=0,e={add:function(n){if(e.contains(n))throw"dup key:"+n;t[n]=r,r+=1},size:function(){return r},indexOf:function(r){return t[r]},contains:function(r){return void 0!==t[r]}};return e};return i}(t,r),o=0;o<r;o+=1)for(var i=0;i<t;i+=1)n.setPixel(i,o,e(i,o));var a=D();n.write(a);for(var u=function(){var t=0,r=0,e=0,n="",o={},i=function(t){n+=String.fromCharCode(a(63&t))},a=function(t){if(t<0);else{if(t<26)return 65+t;if(t<52)return t-26+97;if(t<62)return t-52+48;if(62==t)return 43;if(63==t)return 47}throw"n:"+t};return o.writeByte=function(n){for(t=t<<8|255&n,r+=8,e+=1;r>=6;)i(t>>>r-6),r-=6},o.flush=function(){if(r>0&&(i(t<<6-r),t=0,r=0),e%3!=0)for(var o=3-e%3,a=0;a<o;a+=1)n+="="},o.toString=function(){return n},o}(),f=a.toByteArray(),c=0;c<f.length;c+=1)u.writeByte(f[c]);return u.flush(),"data:image/gif;base64,"+u};return t}();qrcode.stringToBytesFuncs["UTF-8"]=function(t){return function(t){for(var r=[],e=0;e<t.length;e++){var n=t.charCodeAt(e);n<128?r.push(n):n<2048?r.push(192|n>>6,128|63&n):n<55296||n>=57344?r.push(224|n>>12,128|n>>6&63,128|63&n):(e++,n=65536+((1023&n)<<10|1023&t.charCodeAt(e)),r.push(240|n>>18,128|n>>12&63,128|n>>6&63,128|63&n))}return r}(t)},function(t){"function"==typeof define&&define.amd?define([],t):"object"==typeof exports&&(module.exports=t())}(function(){return qrcode});
  </script>
  <script>
    const POLL_INTERVAL_MS = 3000;

    function escapeHtml(value) {
      const div = document.createElement('div');
      div.textContent = value ?? '';
      return div.innerHTML;
    }

    // escapeHtml() only escapes <, >, & (the characters HTML text-node
    // serialization cares about) -- safe for element content, but a bare "
    // would break out of a double-quoted attribute. Used for the thread
    // span's data-thread attribute.
    function escapeAttr(value) {
      return escapeHtml(value).replace(/"/g, '&quot;');
    }

    // Jobs currently showing their full model+prompt (board row expand, or
    // the pill hovercard) -- kept outside the render functions so a 3s poll
    // refresh doesn't collapse something the user just opened.
    const expandedJobIds = new Set();
    let latestJobs = [];

    function hasMoreInfo(job) {
      return Boolean(job.model || job.prompt);
    }

    // '>_' glyph prefix is the only visual mark a bash/command job's pill
    // gets -- a CC job's pill stays exactly as before.
    function pillHtml(status, job) {
      const glyph = job.is_command ? '<span class="pill-type-glyph">&gt;_</span>' : '';
      return `<span class="pill ${status}">${glyph}${status}</span>`;
    }

    function resumeButtonHtml(job) {
      if (job.status !== 'stale') return '';
      return `<button type="button" class="resume-btn" data-job-id="${job.id}">Resume</button>`;
    }

    // Shown on any not-yet-done job (running/pending/stale) -- the
    // wedged-job case (crashed agent, hand-killed process) isn't limited to
    // jobs already stuck "running", so this isn't restricted to that
    // section. A done job has nothing left to force-close.
    function forceCloseButtonHtml(job) {
      if (job.status === 'done') return '';
      return `<button type="button" class="force-close-btn" data-job-id="${job.id}" title="Force-close: marks this job done with result FORCE-CLOSED and releases any lock it holds. Use when it's wedged -- agent crashed/killed, will never post its own result.">Force-close</button>`;
    }

    function deliveryWaitingDotHtml(job) {
      if (!job.delivery_pending) return '';
      return `<span class="delivery-waiting-dot" title="Result waiting to be delivered to chat"></span>`;
    }

    async function resumeJob(jobId) {
      try {
        await fetch('resume.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ job_id: Number(jobId) }),
        });
      } catch (err) {
        // network hiccup -- the next 3s poll reflects the real state either way
      }
      refresh();
    }

    // Same result.php POST the Manual Controls panel's own force-close field
    // sends -- this is just a per-row shortcut so there's no job id to copy
    // in by hand for the common case (a wedged running job right in front
    // of you).
    async function forceCloseJobRow(jobId) {
      const id = Number(jobId);
      if (!confirm(`Force-close job ${id}? This marks it done with result "FORCE-CLOSED" and releases any lock it holds.`)) return;

      try {
        const res = await fetch('result.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, result: 'FORCE-CLOSED' }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setAdminStatus(`Job ${id} force-closed.`, false);
        refresh();
        refreshAdminLocks();
      } catch (err) {
        setAdminStatus(`Force-close failed: ${err.message}`, true);
      }
    }

    // Rounds a raw token count to the compact "12k"-style form used in the
    // stats line below -- one decimal under 10k so small counts stay
    // distinguishable, whole numbers above it.
    function formatTokenCount(n) {
      if (typeof n !== 'number') return '0';
      if (n >= 10000) return `${Math.round(n / 1000)}k`;
      if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
      return String(n);
    }

    // Formats a job's result_stats (see db.php's parseResultEnvelope) into the
    // compact "Cost $0.04 | in 12k / out 3k tok | 24 turns" label. Cache
    // tokens are folded into the "in" figure since that's the number CC
    // agentic loops actually spend most of their input budget on. Returns
    // null for bash jobs and non-envelope results (parseResultEnvelope
    // already returns null for those).
    function formatResultStats(stats) {
      if (!stats || typeof stats.total_cost_usd !== 'number') return null;
      const inputTok = (stats.input_tokens || 0) + (stats.cache_creation_input_tokens || 0) + (stats.cache_read_input_tokens || 0);
      const outputTok = stats.output_tokens || 0;
      const parts = [`Cost $${stats.total_cost_usd.toFixed(2)}`, `in ${formatTokenCount(inputTok)} / out ${formatTokenCount(outputTok)} tok`];
      if (typeof stats.num_turns === 'number') parts.push(`${stats.num_turns} turns`);
      return parts.join(' | ');
    }

    function detailBlockHtml(job) {
      const modelLine = job.model
        ? `<div class="detail-line"><span class="detail-label">Model:</span> ${escapeHtml(job.model)}</div>`
        : '';
      const silenceLine = job.silence_timeout
        ? `<div class="detail-line"><span class="detail-label">Silence timeout:</span> ${escapeHtml(String(job.silence_timeout))}s</div>`
        : '';
      const contextLine = `<div class="detail-line"><span class="detail-label">Context:</span> ${job.continue ? `resumed (${escapeHtml(job.session)})` : 'fresh'}</div>`;
      const statsText = formatResultStats(job.result_stats);
      const statsLine = statsText
        ? `<div class="detail-line"><span class="detail-label">Stats:</span> ${escapeHtml(statsText)}</div>`
        : '';
      return `${modelLine}${silenceLine}${contextLine}${statsLine}<div class="detail-line"><span class="detail-label">Prompt:</span></div><pre class="detail-pre">${escapeHtml(job.prompt || '(none)')}</pre>`;
    }

    function moreInfoLinkHtml(job) {
      if (!hasMoreInfo(job)) return '';
      const expanded = expandedJobIds.has(job.id);
      return `<span class="more-info-link" data-job-id="${job.id}">${expanded ? 'less info' : 'more info...'}</span>`;
    }

    function jobDetailRowHtml(job, colspan) {
      if (!hasMoreInfo(job)) return '';
      const hiddenAttr = expandedJobIds.has(job.id) ? '' : ' hidden';
      return `<tr class="job-detail-row" data-job-id="${job.id}"${hiddenAttr}><td colspan="${colspan}"><div class="job-detail">${detailBlockHtml(job)}</div></td></tr>`;
    }

    function groupByRepo(jobs) {
      const groups = new Map();
      for (const job of jobs) {
        const repo = job.repo || '(no repo)';
        if (!groups.has(repo)) groups.set(repo, []);
        groups.get(repo).push(job);
      }

      // Repos with more recent activity float to the top; newest job first
      // within each repo.
      const entries = [...groups.entries()];
      entries.forEach(([, jobsInRepo]) => jobsInRepo.sort((a, b) => b.id - a.id));
      entries.sort((a, b) => b[1][0].updated_at.localeCompare(a[1][0].updated_at));
      return entries;
    }

    function formatDuration(ms) {
      const totalSeconds = Math.max(0, Math.floor(ms / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return `${minutes}m ${seconds}s`;
    }

    // Running jobs never touch updated_at again until they finish (poll.php
    // sets it once on the pending -> running flip), so it doubles as a
    // stable "started running at" marker -- same assumption feed.php's
    // footer timer makes.
    function renderRunningRow(job) {
      const name = job.name ? escapeHtml(job.name) : `Job ${job.id}`;
      const thread = job.thread
        ? `<span class="thread" data-thread="${escapeAttr(job.thread)}">${escapeHtml(job.thread)}</span>`
        : `<span class="thread none">(none)</span>`;
      return `
        <tr class="job-row" data-job-id="${job.id}">
          <td class="id">#${job.id}</td>
          <td class="name">${name}</td>
          <td class="status-cell">${pillHtml('running', job)}${forceCloseButtonHtml(job)}${deliveryWaitingDotHtml(job)}</td>
          <td class="thread-cell">${thread}</td>
          <td class="summary">${job.summary ? escapeHtml(job.summary) : ''}${moreInfoLinkHtml(job)}</td>
          <td class="timer-cell" data-updated-at="${escapeAttr(job.updated_at)}">-</td>
        </tr>`;
    }

    function renderRunningSection(jobs) {
      const section = document.getElementById('running-section');
      const runningJobs = jobs.filter((job) => job.status === 'running').sort((a, b) => b.id - a.id);
      if (runningJobs.length === 0) {
        section.innerHTML = '';
        return;
      }

      section.innerHTML = `
        <div class="repo running-pinned">
          <div class="repo-header">
            Running now
            <span class="repo-count">${runningJobs.length} job${runningJobs.length === 1 ? '' : 's'}</span>
          </div>
          <table>
            <tbody>${runningJobs.map((job) => renderRunningRow(job) + jobDetailRowHtml(job, 6)).join('')}</tbody>
          </table>
        </div>
      `;
      tickRunningTimers();
    }

    function tickRunningTimers() {
      const now = Date.now();
      document.querySelectorAll('#running-section .timer-cell[data-updated-at]').forEach((el) => {
        const startedAt = new Date(el.dataset.updatedAt).getTime();
        el.textContent = formatDuration(now - startedAt);
      });
    }

    function renderJobRow(job) {
      const name = job.name ? escapeHtml(job.name) : `Job ${job.id}`;
      const thread = job.thread
        ? `<span class="thread" data-thread="${escapeAttr(job.thread)}">${escapeHtml(job.thread)}</span>`
        : `<span class="thread none">(none)</span>`;
      return `
        <tr class="job-row" data-job-id="${job.id}">
          <td class="id">#${job.id}</td>
          <td class="name">${name}</td>
          <td class="status-cell">${pillHtml(job.status, job)}${resumeButtonHtml(job)}${forceCloseButtonHtml(job)}${deliveryWaitingDotHtml(job)}</td>
          <td class="thread-cell">${thread}</td>
          <td class="summary">${job.summary ? escapeHtml(job.summary) : ''}${moreInfoLinkHtml(job)}</td>
        </tr>`;
    }

    function render(jobs) {
      const board = document.getElementById('board');
      if (jobs.length === 0) {
        board.innerHTML = '<div class="empty">No jobs yet.</div>';
        return;
      }

      const groups = groupByRepo(jobs);
      board.innerHTML = groups.map(([repo, jobsInRepo]) => `
        <div class="repo">
          <div class="repo-header">
            ${escapeHtml(repo)}
            <span class="repo-count">${jobsInRepo.length} job${jobsInRepo.length === 1 ? '' : 's'}</span>
          </div>
          <table>
            <tbody>${jobsInRepo.map((job) => renderJobRow(job) + jobDetailRowHtml(job, 5)).join('')}</tbody>
          </table>
        </div>
      `).join('');
    }

    let jobsById = new Map();

    const STATE_LABELS = {
      active: 'ACTIVE',
      needs_input: 'NEEDS INPUT',
      errored: 'ERRORED',
      dormant: 'DORMANT',
      idle: 'IDLE',
    };

    // Thread State panel's age window -- how far back to look for threads.
    // 'forever' is sent to the server as max_age=0, a sentinel meaning "no
    // age filter" (a real 0-second filter would exclude everything anyway).
    const WINDOW_OPTIONS = [
      { key: '4h', label: '4h', title: 'Last 4 hours', seconds: 4 * 60 * 60 },
      { key: '24h', label: '24h', title: 'Last 24 hours', seconds: 24 * 60 * 60 },
      { key: '3d', label: '3d', title: 'Last 3 days', seconds: 3 * 24 * 60 * 60 },
      { key: '14d', label: '14d', title: 'Last 14 days', seconds: 14 * 24 * 60 * 60 },
      { key: 'forever', label: 'Forever', title: 'All time', seconds: 0 },
    ];
    const WINDOW_STORAGE_KEY = 'ccsw.threadStateWindow';

    function loadThreadStateWindow() {
      const stored = localStorage.getItem(WINDOW_STORAGE_KEY);
      return WINDOW_OPTIONS.some((w) => w.key === stored) ? stored : '3d';
    }

    let threadStateWindow = loadThreadStateWindow();
    let latestThreadStates = [];

    // Activity window chips live in their own pinned row (not inside the
    // Thread State card) since the selected window now also drives which
    // jobs show in the board below, not just which thread chips appear.
    function renderWindowChips() {
      const section = document.getElementById('activity-window-section');
      const windowChips = WINDOW_OPTIONS.map((w) => {
        const activeClass = w.key === threadStateWindow ? ' active' : '';
        return `<span class="window-chip${activeClass}" data-window="${escapeAttr(w.key)}" title="${escapeAttr(w.title)}">${escapeHtml(w.label)}</span>`;
      }).join('');

      section.innerHTML = `
        <div class="activity-window-row">
          <span class="activity-window-label">Activity window</span>
          <div class="activity-window-chips">${windowChips}</div>
        </div>
      `;
    }

    function renderThreadStatePanel(threads) {
      latestThreadStates = Array.isArray(threads) ? threads : [];
      const section = document.getElementById('thread-state-section');
      const activeWindow = WINDOW_OPTIONS.find((w) => w.key === threadStateWindow) || WINDOW_OPTIONS[2];

      const chips = latestThreadStates.map((t) => {
        const label = STATE_LABELS[t.state] || t.state;
        const stateClass = escapeAttr(t.state);
        return `
          <span class="state-chip ${stateClass}" data-thread="${escapeAttr(t.thread)}" title="${escapeAttr(t.thread)}">
            <span class="state-dot"></span>${escapeHtml(t.thread)} - ${escapeHtml(label)}
          </span>`;
      }).join('');

      const body = latestThreadStates.length > 0
        ? `<div class="thread-state-chips">${chips}</div>`
        : `<div class="thread-state-chips">No threads in this window.</div>`;

      section.innerHTML = `
        <div class="thread-state-panel">
          <div class="thread-state-header">Thread State (${escapeHtml(activeWindow.title)})</div>
          ${body}
        </div>
      `;
    }

    async function refreshThreadStates() {
      const activeWindow = WINDOW_OPTIONS.find((w) => w.key === threadStateWindow) || WINDOW_OPTIONS[2];
      const statesRes = await fetch(`thread_states.php?max_age=${activeWindow.seconds}`);
      const statesBody = await statesRes.json();
      if (Array.isArray(statesBody?.threads)) {
        renderThreadStatePanel(statesBody.threads);
      }
    }

    async function refresh() {
      try {
        // Same age window that filters the Thread State chips also filters
        // this list -- "Forever" needs a much bigger row cap than the other
        // windows, since it has no age filter to narrow the result set down.
        const activeWindow = WINDOW_OPTIONS.find((w) => w.key === threadStateWindow) || WINDOW_OPTIONS[2];
        const jobsLimit = activeWindow.key === 'forever' ? 300 : 100;
        const [jobsRes, heartbeatRes] = await Promise.all([
          fetch(`jobs.php?status=all&limit=${jobsLimit}&max_age=${activeWindow.seconds}`),
          fetch('heartbeat.php'),
          refreshThreadStates(),
        ]);
        const body = await jobsRes.json();
        if (Array.isArray(body?.jobs)) {
          jobsById = new Map(body.jobs.map((job) => [job.id, job]));
          latestJobs = body.jobs;
          renderRunningSection(body.jobs);
          render(body.jobs);
          document.getElementById('meta').textContent =
            `${body.jobs.length} job(s) - last updated ${new Date().toLocaleTimeString()}`;
        }

        const heartbeatBody = await heartbeatRes.json();
        const offline = !heartbeatBody?.online;
        document.getElementById('agent-offline-banner').hidden = !offline;
        if (offline) {
          const detailEl = document.getElementById('agent-offline-detail');
          if (heartbeatBody?.latest) {
            const staleSeconds = Math.max(0, Math.round((Date.now() - new Date(heartbeatBody.latest).getTime()) / 1000));
            const staleMinutes = Math.floor(staleSeconds / 60);
            detailEl.textContent = staleMinutes > 0
              ? `- last seen ${staleMinutes}m ${staleSeconds % 60}s ago`
              : `- last seen ${staleSeconds}s ago`;
          } else {
            detailEl.textContent = '- no heartbeat ever received';
          }
        }
      } catch (err) {
        document.getElementById('meta').textContent = `refresh failed: ${err.message}`;
      }
    }

    const feedDialog = document.getElementById('feed-dialog');
    const feedDialogHeader = document.querySelector('.feed-dialog-header');
    const feedDialogTitle = document.getElementById('feed-dialog-title');
    const feedDialogFrame = document.getElementById('feed-dialog-frame');
    const feedDialogMoreInfo = document.getElementById('feed-dialog-more-info');
    const feedDialogDetail = document.getElementById('feed-dialog-detail');

    function openFeedDialog(jobId) {
      const job = jobsById.get(Number(jobId));
      feedDialogTitle.textContent = `Job #${jobId}`;
      feedDialogHeader.title = job?.summary || '';
      feedDialogFrame.src = `feed.php?job_id=${jobId}`;

      feedDialogDetail.hidden = true;
      feedDialogDetail.innerHTML = '';
      feedDialogMoreInfo.textContent = 'more info...';
      if (job && hasMoreInfo(job)) {
        feedDialogMoreInfo.hidden = false;
        feedDialogMoreInfo.onclick = () => {
          feedDialogDetail.hidden = !feedDialogDetail.hidden;
          if (!feedDialogDetail.hidden) {
            feedDialogDetail.innerHTML = detailBlockHtml(job);
          }
          feedDialogMoreInfo.textContent = feedDialogDetail.hidden ? 'more info...' : 'less info';
        };
      } else {
        feedDialogMoreInfo.hidden = true;
        feedDialogMoreInfo.onclick = null;
      }

      feedDialog.showModal();
    }

    function closeFeedDialog() {
      feedDialog.close();
      feedDialogFrame.src = 'about:blank';
    }

    document.getElementById('feed-dialog-close').addEventListener('click', closeFeedDialog);

    // Clicking the dialog's own backdrop (the <dialog> element itself, since
    // showModal() makes the element the click target outside its content
    // box) closes it -- clicks inside .feed-dialog-inner don't bubble to it.
    feedDialog.addEventListener('click', (event) => {
      if (event.target === feedDialog) closeFeedDialog();
    });

    async function requestThreadFocus(thread) {
      try {
        await fetch('focus_request.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ thread }),
        });
      } catch (err) {
        // network hiccup -- nothing actionable to show the user here
      }
    }

    // Toggles a job's expanded model+prompt block -- shared by the board
    // row's own "more info" link and the pill hovercard's copy of the same
    // link, so opening one keeps the other in sync on the next re-render.
    function toggleJobDetail(jobId) {
      const id = Number(jobId);
      if (expandedJobIds.has(id)) {
        expandedJobIds.delete(id);
      } else {
        expandedJobIds.add(id);
      }
      renderRunningSection(latestJobs);
      render(latestJobs);
    }

    function onJobsContainerClick(event) {
      const resumeBtn = event.target.closest('.resume-btn');
      if (resumeBtn) {
        resumeJob(resumeBtn.dataset.jobId);
        return;
      }

      const forceCloseBtn = event.target.closest('.force-close-btn');
      if (forceCloseBtn) {
        forceCloseJobRow(forceCloseBtn.dataset.jobId);
        return;
      }

      const moreInfoLink = event.target.closest('.more-info-link');
      if (moreInfoLink) {
        toggleJobDetail(moreInfoLink.dataset.jobId);
        return;
      }

      // The thread cell is excluded from the row-opens-feed behavior
      // entirely -- clicking the thread name focuses that Claude tab
      // instead, and clicking elsewhere in the cell (e.g. its padding, or
      // the "(none)" placeholder) does nothing.
      const threadCell = event.target.closest('.thread-cell');
      if (threadCell) {
        const threadEl = event.target.closest('.thread:not(.none)');
        if (threadEl) requestThreadFocus(threadEl.dataset.thread);
        return;
      }

      const row = event.target.closest('.job-row');
      if (row) {
        openFeedDialog(row.dataset.jobId);
      }
    }

    // Same delegated handler on both containers -- a job can appear in the
    // pinned "Running now" section and the main list at the same time.
    document.getElementById('running-section').addEventListener('click', onJobsContainerClick);
    document.getElementById('board').addEventListener('click', onJobsContainerClick);

    // Thread state chips have no per-job identity -- clicking one just
    // focuses that thread's tab, same as clicking a thread name in the board.
    document.getElementById('thread-state-section').addEventListener('click', (event) => {
      const chip = event.target.closest('.state-chip');
      if (chip) requestThreadFocus(chip.dataset.thread);
    });

    // The activity window now drives both the Thread State chips and the
    // job list below, so switching it re-runs a full refresh() rather than
    // just refreshThreadStates().
    document.getElementById('activity-window-section').addEventListener('click', (event) => {
      const windowChip = event.target.closest('.window-chip');
      if (!windowChip) return;
      const key = windowChip.dataset.window;
      if (key === threadStateWindow) return;
      threadStateWindow = key;
      localStorage.setItem(WINDOW_STORAGE_KEY, key);
      renderWindowChips();
      refresh();
    });

    // --- Manual Controls panel -------------------------------------------
    // Board-side admin actions for the hand-fixes otherwise done via curl:
    // force-closing a stuck job, clearing repo locks, and restarting the
    // agent. Kept in one collapsible <details> so it's out of the way when
    // not needed -- see index.php's #admin-panel markup.

    let adminLocksTimer = null;

    function setAdminStatus(message, isError) {
      const el = document.getElementById('admin-status');
      el.textContent = message;
      el.className = isError ? 'error' : 'ok';
    }

    function renderAdminLocks(locks) {
      const listEl = document.getElementById('admin-locks-list');
      const selectEl = document.getElementById('admin-clear-lock-repo');

      if (locks.length === 0) {
        listEl.innerHTML = '<span class="admin-note">(none held)</span>';
        selectEl.innerHTML = '<option value="">(no locks held)</option>';
        return;
      }

      listEl.innerHTML = locks.map((lock) => `
        <div class="admin-lock-row">
          <span class="admin-lock-repo">${escapeHtml(lock.repo)}</span>
          <span class="admin-lock-thread">thread: ${escapeHtml(lock.thread || '(none)')} -- job #${escapeHtml(String(lock.job_id))}</span>
        </div>
      `).join('');

      // Keep the current selection if it's still a held repo, so an
      // in-progress "pick a repo" doesn't reset itself out from under the
      // user on every 3s live-lock refresh.
      const currentValue = selectEl.value;
      selectEl.innerHTML = locks.map((lock) => `<option value="${escapeAttr(lock.repo)}">${escapeHtml(lock.repo)}</option>`).join('');
      if (locks.some((lock) => lock.repo === currentValue)) selectEl.value = currentValue;
    }

    async function refreshAdminLocks() {
      try {
        const res = await fetch('debug_locks.php');
        const data = await res.json();
        renderAdminLocks(data.locks || []);
      } catch (err) {
        document.getElementById('admin-locks-list').innerHTML = '<span class="admin-note">failed to load</span>';
      }
    }

    // Only polls debug_locks.php while the panel is actually open -- no
    // point spending a request every 3s on a section nobody's looking at.
    document.getElementById('admin-panel').addEventListener('toggle', (event) => {
      if (event.target.open) {
        refreshAdminLocks();
        adminLocksTimer = setInterval(refreshAdminLocks, 3000);
      } else if (adminLocksTimer) {
        clearInterval(adminLocksTimer);
        adminLocksTimer = null;
      }
    });

    document.getElementById('admin-force-close-btn').addEventListener('click', async () => {
      const idInput = document.getElementById('admin-force-close-id');
      const id = Number(idInput.value);
      if (!id || id <= 0) {
        setAdminStatus('Enter a valid job id.', true);
        return;
      }
      if (!confirm(`Force-close job ${id}? This marks it done with result "FORCE-CLOSED" and releases any lock it holds.`)) return;

      try {
        const res = await fetch('result.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, result: 'FORCE-CLOSED' }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setAdminStatus(`Job ${id} force-closed.`, false);
        idInput.value = '';
        refresh();
        refreshAdminLocks();
      } catch (err) {
        setAdminStatus(`Force-close failed: ${err.message}`, true);
      }
    });

    document.getElementById('admin-clear-lock-btn').addEventListener('click', async () => {
      const repo = document.getElementById('admin-clear-lock-repo').value;
      if (!repo) {
        setAdminStatus('No repo selected.', true);
        return;
      }
      if (!confirm(`Clear the lock on "${repo}"? Only do this if you're sure the job holding it is dead.`)) return;

      try {
        const res = await fetch('clear_lock.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setAdminStatus(`Lock on "${repo}" cleared.`, false);
        refreshAdminLocks();
      } catch (err) {
        setAdminStatus(`Clear lock failed: ${err.message}`, true);
      }
    });

    document.getElementById('admin-clear-all-locks-btn').addEventListener('click', async () => {
      if (!confirm('Clear ALL repo locks? Only do this if you\'re sure every job holding one is dead.')) return;

      try {
        const res = await fetch('clear_locks.php', {
          method: 'POST',
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setAdminStatus(`Cleared ${data.cleared} lock(s).`, false);
        refreshAdminLocks();
      } catch (err) {
        setAdminStatus(`Clear all locks failed: ${err.message}`, true);
      }
    });

    // The exact "spawn restart-agent.ps1 detached, then let it report this
    // job's own completion" one-liner documented in agent/restart-agent.ps1
    // -- $CCSW_JOB_ID/$CCSW_RELAY_BASE are expanded by bash (the job runs via
    // Git Bash, see AgentCore.cs's RunBash), not by PowerShell, which is why
    // they're left unescaped here even though the rest of the -Command
    // string is quoted for PowerShell's own parser.
    const RESTART_AGENT_COMMAND = 'powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList \'-NoProfile -ExecutionPolicy Bypass -File \\"V:\\ccswitchboard\\agent\\restart-agent.ps1\\" -JobId $CCSW_JOB_ID -RelayBase $CCSW_RELAY_BASE\'"';

    document.getElementById('admin-restart-agent-btn').addEventListener('click', async () => {
      if (!confirm('Restart CcswAgent now? Any job currently running on it will be killed.')) return;

      try {
        // readonly:true -- this is a bash job whose cwd happens to be the
        // ccswitchboard repo, but it doesn't touch repo content, so it
        // shouldn't take that repo's lock (see job.php's readonly flag).
        const res = await fetch('job.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            payload: { type: 'bash', cwd: 'V:/ccswitchboard', command: RESTART_AGENT_COMMAND },
            readonly: true,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        setAdminStatus(`Restart queued as job ${data.id}.`, false);
        refresh();
      } catch (err) {
        setAdminStatus(`Restart failed: ${err.message}`, true);
      }
    });

    // --- Batch records panel (#50) -----------------------------------------
    // Clusters of consecutive same-thread jobs, computed server-side by
    // stats.php. Loaded once when the panel is opened (like admin-locks
    // above) rather than on the main 3s poll -- historical/summary data,
    // not something that needs to track live job state.

    let batchRecordsLoaded = false;
    let latestBatches = [];
    let batchSortKey = 'duration_seconds';
    let batchSortDir = 'desc';
    const batchDetailCache = new Map(); // batch_key -> jobs.php?batch=... response
    const expandedBatchKeys = new Set();

    function formatBatchDuration(seconds) {
      const s = Math.max(0, Math.floor(seconds));
      const hours = Math.floor(s / 3600);
      const minutes = Math.floor((s % 3600) / 60);
      const secs = s % 60;
      if (hours > 0) return `${hours}h ${minutes}m`;
      if (minutes > 0) return `${minutes}m ${secs}s`;
      return `${secs}s`;
    }

    function formatTimestamp(iso) {
      return iso ? new Date(iso).toLocaleString() : '-';
    }

    const OUTCOME_LABELS = {
      success: 'ok',
      errored: 'error',
      needs_input: 'needs input',
      cancelled: 'cancelled',
    };

    function outcomeSpanHtml(outcome) {
      if (!outcome) return '<span class="thread none">(unfinished)</span>';
      const cls = outcome === 'success' ? 'done' : (outcome === 'errored' ? 'stale' : '');
      const label = OUTCOME_LABELS[outcome] || outcome;
      return `<span class="pill ${cls}">${escapeHtml(label)}</span>`;
    }

    const BATCH_SORT_ACCESSORS = {
      thread: (b) => b.thread || '',
      started_at: (b) => b.started_at || '',
      duration_seconds: (b) => b.duration_seconds,
      jobs_total: (b) => b.jobs_total,
      cc_cmd: (b) => b.cc_jobs,
      outcomes: (b) => b.succeeded,
      longest_job: (b) => b.longest_job ? b.longest_job.duration_seconds : 0,
    };

    function recordCardHtml(label, valueHtml, subHtml) {
      return `
        <div class="record-card">
          <div class="record-card-label">${escapeHtml(label)}</div>
          <div class="record-card-value">${valueHtml}</div>
          ${subHtml ? `<div class="record-card-sub">${subHtml}</div>` : ''}
        </div>`;
    }

    function renderRecordsStrip(records) {
      if (!records || (!records.longest_batch && !records.most_jobs_batch && records.top_threads.length === 0)) {
        return '';
      }

      const cards = [];
      if (records.longest_batch) {
        const b = records.longest_batch;
        cards.push(recordCardHtml(
          'Longest batch ever',
          formatBatchDuration(b.duration_seconds),
          `${escapeHtml(b.thread)} - ${b.jobs_total} job${b.jobs_total === 1 ? '' : 's'}`
        ));
      }
      if (records.most_jobs_batch) {
        const b = records.most_jobs_batch;
        cards.push(recordCardHtml(
          'Most jobs in one batch',
          `${b.jobs_total} job${b.jobs_total === 1 ? '' : 's'}`,
          `${escapeHtml(b.thread)} - ${formatBatchDuration(b.duration_seconds)}`
        ));
      }
      records.top_threads.forEach((entry, i) => {
        const b = entry.best_batch;
        cards.push(recordCardHtml(
          `#${i + 1} thread (best batch)`,
          escapeHtml(entry.thread),
          `${formatBatchDuration(b.duration_seconds)} - ${b.jobs_total} job${b.jobs_total === 1 ? '' : 's'}`
        ));
      });

      return `<div class="batch-records-strip">${cards.join('')}</div>`;
    }

    function batchSubRowHtml(job) {
      const typeGlyph = job.type === 'command' ? '<span class="pill-type-glyph">&gt;_</span>' : '';
      return `
        <tr>
          <td class="id">#${job.id}</td>
          <td>${job.name ? escapeHtml(job.name) : ''}${typeGlyph}</td>
          <td>${job.model ? escapeHtml(job.model) : '-'}</td>
          <td>${formatBatchDuration(job.duration_seconds)}</td>
          <td>${outcomeSpanHtml(job.outcome)}</td>
        </tr>`;
    }

    async function loadBatchDetail(batchKey) {
      if (batchDetailCache.has(batchKey)) return batchDetailCache.get(batchKey);
      const res = await fetch(`stats.php?batch=${encodeURIComponent(batchKey)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      batchDetailCache.set(batchKey, data);
      return data;
    }

    async function toggleBatchRow(batchKey) {
      const detailRow = document.querySelector(`.batch-detail-row[data-batch-key="${CSS.escape(batchKey)}"]`);
      if (!detailRow) return;

      if (expandedBatchKeys.has(batchKey)) {
        expandedBatchKeys.delete(batchKey);
        detailRow.hidden = true;
        return;
      }

      expandedBatchKeys.add(batchKey);
      detailRow.hidden = false;
      const cell = detailRow.querySelector('td');
      cell.innerHTML = '<div class="batch-empty">Loading...</div>';

      try {
        const data = await loadBatchDetail(batchKey);
        const rows = data.jobs.map(batchSubRowHtml).join('');
        const moreHtml = data.truncated
          ? `<div class="batch-sub-more">showing ${data.jobs.length} of ${data.jobs_total} jobs</div>`
          : '';
        cell.innerHTML = `
          <table class="batch-sub-table">
            <tbody>${rows}</tbody>
          </table>
          ${moreHtml}`;
      } catch (err) {
        cell.innerHTML = `<div class="batch-empty">failed to load: ${escapeHtml(err.message)}</div>`;
      }
    }

    function batchRowHtml(batch) {
      const longest = batch.longest_job
        ? `${escapeHtml(batch.longest_job.name || `Job ${batch.longest_job.id}`)} (${formatBatchDuration(batch.longest_job.duration_seconds)})`
        : '-';
      return `
        <tr class="batch-row" data-batch-key="${escapeAttr(batch.batch_key)}">
          <td class="thread">${escapeHtml(batch.thread)}</td>
          <td>${formatTimestamp(batch.started_at)}</td>
          <td>${formatBatchDuration(batch.duration_seconds)}</td>
          <td>${batch.jobs_total}</td>
          <td class="batch-jobs-split">${batch.cc_jobs} cc / ${batch.command_jobs} cmd</td>
          <td class="batch-outcomes"><span class="ok">${batch.succeeded} ok</span> / <span class="err">${batch.errored} err</span></td>
          <td>${longest}</td>
        </tr>
        <tr class="batch-detail-row" data-batch-key="${escapeAttr(batch.batch_key)}" hidden>
          <td colspan="7"></td>
        </tr>`;
    }

    function renderBatchTable() {
      const bodyEl = document.getElementById('batch-records-body');
      if (latestBatches.length === 0) {
        bodyEl.innerHTML = `${renderRecordsStrip(latestRecords)}<div class="batch-empty">No batches yet.</div>`;
        return;
      }

      const sorted = [...latestBatches].sort((a, b) => {
        const accessor = BATCH_SORT_ACCESSORS[batchSortKey];
        const av = accessor(a);
        const bv = accessor(b);
        const cmp = typeof av === 'string' ? av.localeCompare(bv) : av - bv;
        return batchSortDir === 'asc' ? cmp : -cmp;
      });

      const columns = [
        { key: 'thread', label: 'Thread' },
        { key: 'started_at', label: 'Started' },
        { key: 'duration_seconds', label: 'Duration' },
        { key: 'jobs_total', label: 'Jobs' },
        { key: 'cc_cmd', label: 'CC/cmd' },
        { key: 'outcomes', label: 'Ok/Err' },
        { key: 'longest_job', label: 'Longest job' },
      ];
      const headHtml = columns.map((col) => {
        const isSorted = col.key === batchSortKey;
        const arrow = batchSortDir === 'asc' ? '▴' : '▾';
        return `<th data-key="${col.key}" class="${isSorted ? 'sorted' : ''}" data-arrow="${arrow}">${col.label}</th>`;
      }).join('');

      bodyEl.innerHTML = `
        ${renderRecordsStrip(latestRecords)}
        <table class="batch-table">
          <thead><tr>${headHtml}</tr></thead>
          <tbody>${sorted.map(batchRowHtml).join('')}</tbody>
        </table>`;

      bodyEl.querySelectorAll('.batch-table th').forEach((th) => {
        th.addEventListener('click', () => {
          const key = th.dataset.key;
          if (batchSortKey === key) {
            batchSortDir = batchSortDir === 'asc' ? 'desc' : 'asc';
          } else {
            batchSortKey = key;
            batchSortDir = 'desc';
          }
          renderBatchTable();
        });
      });

      bodyEl.querySelectorAll('.batch-row').forEach((row) => {
        row.addEventListener('click', () => toggleBatchRow(row.dataset.batchKey));
      });

      // Re-expand any rows that were open before this re-render (e.g. after
      // a re-sort) so toggling sort doesn't silently collapse them.
      expandedBatchKeys.forEach((key) => {
        const detailRow = document.querySelector(`.batch-detail-row[data-batch-key="${CSS.escape(key)}"]`);
        if (detailRow) {
          detailRow.hidden = false;
          const cell = detailRow.querySelector('td');
          const cached = batchDetailCache.get(key);
          if (cached) {
            const rows = cached.jobs.map(batchSubRowHtml).join('');
            const moreHtml = cached.truncated
              ? `<div class="batch-sub-more">showing ${cached.jobs.length} of ${cached.jobs_total} jobs</div>`
              : '';
            cell.innerHTML = `<table class="batch-sub-table"><tbody>${rows}</tbody></table>${moreHtml}`;
          }
        }
      });
    }

    let latestRecords = null;

    async function refreshBatchRecords() {
      const bodyEl = document.getElementById('batch-records-body');
      try {
        const res = await fetch('stats.php');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        latestBatches = data.batches || [];
        latestRecords = data.records || null;
        renderBatchTable();
      } catch (err) {
        bodyEl.innerHTML = `<div class="batch-empty">failed to load: ${escapeHtml(err.message)}</div>`;
      }
    }

    document.getElementById('batch-records-panel').addEventListener('toggle', (event) => {
      if (event.target.open && !batchRecordsLoaded) {
        batchRecordsLoaded = true;
        refreshBatchRecords();
      }
    });

    // Pill hovercard: a status pill's native title tooltip can't hold a
    // clickable link, so hovering one instead shows this single reused
    // popup, positioned under the pill, with its own "more info" link that
    // expands in place to the job's model+prompt.
    let hovercardEl = null;
    let hovercardHideTimer = null;

    function ensureHovercard() {
      if (hovercardEl) return hovercardEl;
      hovercardEl = document.createElement('div');
      hovercardEl.id = 'pill-hovercard';
      hovercardEl.hidden = true;
      document.body.appendChild(hovercardEl);
      hovercardEl.addEventListener('mouseenter', cancelHideHovercard);
      hovercardEl.addEventListener('mouseleave', scheduleHideHovercard);
      hovercardEl.addEventListener('click', onHovercardClick);
      return hovercardEl;
    }

    function cancelHideHovercard() {
      clearTimeout(hovercardHideTimer);
    }

    function scheduleHideHovercard() {
      clearTimeout(hovercardHideTimer);
      hovercardHideTimer = setTimeout(() => {
        if (hovercardEl) hovercardEl.hidden = true;
      }, 250);
    }

    function renderHovercardContent(job, expanded) {
      const typeHtml = `<div class="hovercard-type">${job.is_command ? '(Command)' : '(CC job)'}</div>`;
      const summaryHtml = job.summary ? `<div class="hovercard-summary">${escapeHtml(job.summary)}</div>` : '';
      const linkHtml = hasMoreInfo(job)
        ? `<span class="more-info-link" data-job-id="${job.id}">${expanded ? 'less info' : 'more info...'}</span>`
        : '';
      const resumeHtml = resumeButtonHtml(job);
      const detailHtml = expanded ? `<div class="hovercard-detail">${detailBlockHtml(job)}</div>` : '';
      hovercardEl.dataset.jobId = String(job.id);
      hovercardEl.innerHTML = `${typeHtml}${summaryHtml}${linkHtml}${resumeHtml}${detailHtml}`;
    }

    function showHovercardForPill(pillEl) {
      const row = pillEl.closest('.job-row');
      if (!row) return;
      const job = jobsById.get(Number(row.dataset.jobId));
      if (!job || (!job.summary && !hasMoreInfo(job) && job.status !== 'stale')) return;

      const card = ensureHovercard();
      cancelHideHovercard();
      renderHovercardContent(job, false);
      card.hidden = false;

      // Flush against the pill's own bottom edge (no gap) -- see the
      // padding-top comment on #pill-hovercard for why that's what removes
      // the dead zone rather than creating one.
      const rect = pillEl.getBoundingClientRect();
      card.style.left = `${Math.round(rect.left)}px`;
      card.style.top = `${Math.round(rect.bottom)}px`;
    }

    function onHovercardClick(event) {
      const resumeBtn = event.target.closest('.resume-btn');
      if (resumeBtn) {
        resumeJob(resumeBtn.dataset.jobId);
        return;
      }

      const link = event.target.closest('.more-info-link');
      if (!link) return;
      const job = jobsById.get(Number(link.dataset.jobId));
      if (!job) return;
      const expandedNow = hovercardEl.querySelector('.hovercard-detail') !== null;
      renderHovercardContent(job, !expandedNow);
    }

    // Hover-intent delay: a bare mouseover fired the hovercard instantly,
    // popping it open on every incidental pass over a pill. Only show it
    // once the pointer has actually lingered.
    let pillHoverIntentTimer = null;
    let pillHoverIntentEl = null;

    document.addEventListener('mouseover', (event) => {
      const pill = event.target.closest('.pill');
      if (!pill || pill === pillHoverIntentEl) return;
      clearTimeout(pillHoverIntentTimer);
      pillHoverIntentEl = pill;
      pillHoverIntentTimer = setTimeout(() => showHovercardForPill(pill), 500);
    });

    document.addEventListener('mouseout', (event) => {
      const pill = event.target.closest('.pill');
      if (!pill) return;
      if (pill === pillHoverIntentEl) {
        clearTimeout(pillHoverIntentTimer);
        pillHoverIntentEl = null;
      }
      if (!(hovercardEl && hovercardEl.contains(event.relatedTarget))) {
        scheduleHideHovercard();
      }
    });

    // Thread State chip hovercard: shows when that thread last ran a job and
    // its lifetime job count, with links reusing the existing thread-focus
    // mechanism and a scroll-to-first-matching-row jump into the job board
    // below (threads aren't grouped into their own section -- jobs are
    // grouped by repo -- so "scroll to jobs" jumps to that thread's nearest
    // visible row instead).
    let threadHovercardEl = null;
    let threadHovercardHideTimer = null;

    function ensureThreadHovercard() {
      if (threadHovercardEl) return threadHovercardEl;
      threadHovercardEl = document.createElement('div');
      threadHovercardEl.id = 'thread-hovercard';
      threadHovercardEl.hidden = true;
      document.body.appendChild(threadHovercardEl);
      threadHovercardEl.addEventListener('mouseenter', cancelHideThreadHovercard);
      threadHovercardEl.addEventListener('mouseleave', scheduleHideThreadHovercard);
      threadHovercardEl.addEventListener('click', onThreadHovercardClick);
      return threadHovercardEl;
    }

    function cancelHideThreadHovercard() {
      clearTimeout(threadHovercardHideTimer);
    }

    function scheduleHideThreadHovercard() {
      clearTimeout(threadHovercardHideTimer);
      threadHovercardHideTimer = setTimeout(() => {
        if (threadHovercardEl) threadHovercardEl.hidden = true;
      }, 250);
    }

    function renderThreadHovercardContent(info) {
      const lastRan = info.last_activity ? new Date(info.last_activity).toLocaleString() : 'never';
      const jobCount = typeof info.job_count === 'number' ? info.job_count : 0;
      threadHovercardEl.innerHTML = `
        <div class="thread-hovercard-line"><span class="detail-label">Last ran:</span> ${escapeHtml(lastRan)}</div>
        <div class="thread-hovercard-line"><span class="detail-label">Total jobs:</span> ${jobCount}</div>
        <div class="thread-hovercard-links">
          <span class="thread-hovercard-link" data-action="open" data-thread="${escapeAttr(info.thread)}">open thread</span>
          <span class="thread-hovercard-link" data-action="scroll" data-thread="${escapeAttr(info.thread)}">scroll to jobs</span>
        </div>
      `;
    }

    function showHovercardForThreadChip(chipEl) {
      const thread = chipEl.dataset.thread;
      const info = latestThreadStates.find((t) => t.thread === thread);
      if (!info) return;

      const card = ensureThreadHovercard();
      cancelHideThreadHovercard();
      renderThreadHovercardContent(info);
      card.hidden = false;

      const rect = chipEl.getBoundingClientRect();
      card.style.left = `${Math.round(rect.left)}px`;
      card.style.top = `${Math.round(rect.bottom)}px`;
    }

    // Jumps to that thread's nearest job row in the board below. Jobs are
    // grouped by repo, not thread, so there's no single "thread's job
    // section" -- the first matching .thread cell (checked in running-section
    // first, since that's visually on top) is the closest equivalent.
    function scrollToThreadJobs(thread) {
      const selector = `.thread[data-thread="${CSS.escape(thread)}"]`;
      const target = document.querySelector(`#running-section ${selector}`)
        || document.querySelector(`#board ${selector}`);
      if (!target) return;
      const row = target.closest('tr') || target;
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function onThreadHovercardClick(event) {
      const link = event.target.closest('.thread-hovercard-link');
      if (!link) return;
      const thread = link.dataset.thread;
      if (link.dataset.action === 'open') {
        requestThreadFocus(thread);
      } else if (link.dataset.action === 'scroll') {
        scrollToThreadJobs(thread);
      }
      threadHovercardEl.hidden = true;
    }

    // Hover-intent delay: 0.75s of lingering before the hovercard appears, so
    // an incidental pass over a chip doesn't pop it open.
    let chipHoverIntentTimer = null;
    let chipHoverIntentEl = null;

    document.addEventListener('mouseover', (event) => {
      const chip = event.target.closest('.state-chip');
      if (!chip || chip === chipHoverIntentEl) return;
      clearTimeout(chipHoverIntentTimer);
      chipHoverIntentEl = chip;
      chipHoverIntentTimer = setTimeout(() => showHovercardForThreadChip(chip), 750);
    });

    document.addEventListener('mouseout', (event) => {
      const chip = event.target.closest('.state-chip');
      if (!chip) return;
      if (chip === chipHoverIntentEl) {
        clearTimeout(chipHoverIntentTimer);
        chipHoverIntentEl = null;
      }
      if (!(threadHovercardEl && threadHovercardEl.contains(event.relatedTarget))) {
        scheduleHideThreadHovercard();
      }
    });

    // --- Phone access: magic-link QR ---------------------------------------
    // This whole script only ever renders on the AUTHENTICATED board (the
    // unauthenticated gate branch above prints its own tiny HTML page and
    // exit()s before reaching here) -- same posture as feed.php inlining the
    // token only for an already-authed request. $hasValidToken is checked
    // again here anyway rather than assumed, so this stays true even if the
    // gate logic above it ever changes shape.
    const CCSW_PHONE_TOKEN = <?php echo json_encode($hasValidToken ? $expectedToken : ''); ?>;

    function renderPhoneAccessQr() {
      const url = 'https://dabblelabs.uk/ccswitchboard/board/index.php?token=' + encodeURIComponent(CCSW_PHONE_TOKEN);
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      document.getElementById('phone-access-qr').innerHTML = qr.createSvgTag(6, 0);
    }

    const phoneAccessDialog = document.getElementById('phone-access-dialog');

    document.getElementById('phone-access-btn').addEventListener('click', () => {
      renderPhoneAccessQr();
      phoneAccessDialog.showModal();
    });

    document.getElementById('phone-access-close').addEventListener('click', () => phoneAccessDialog.close());

    // Same backdrop-click-to-close pattern as feed-dialog above.
    phoneAccessDialog.addEventListener('click', (event) => {
      if (event.target === phoneAccessDialog) phoneAccessDialog.close();
    });

    // --- Collapsible section bars (Summaries / Jobs / Tools) ---------------
    // Three top-level <details> bars fill the viewport below the fixed header.
    // Their open/closed state is owned entirely here and by the user -- the 3s
    // refresh() only ever rewrites section *content* (#board, #running-section,
    // #thread-state-section, #meta, #activity-window-section, ...), never these
    // wrappers, so a bar left open stays open across every poll. State is also
    // mirrored to localStorage so it survives a full reload.
    //
    // Responsive behaviour (matchMedia):
    //   mobile  (<=768px): accordion -- at most ONE bar open at a time; opening
    //                      one auto-closes the others, and the open bar fills
    //                      the remaining height with its body scrolling.
    //   desktop (>=769px): independent -- any combination may be open; open
    //                      bars stack and each scrolls its own body.
    const SECTION_BAR_IDS = ['sbar-summaries', 'sbar-jobs', 'sbar-tools'];
    const SECTION_OPEN_KEY = 'ccsw.sectionOpen';
    const mqSectionMobile = window.matchMedia('(max-width: 768px)');
    // Reentrancy guard: setting .open programmatically fires a 'toggle' event;
    // this stops those synthetic toggles from re-running the accordion/save.
    let applyingSectionState = false;

    function sectionBar(id) { return document.getElementById(id); }

    function saveSectionOpenState() {
      const state = {};
      SECTION_BAR_IDS.forEach((id) => { state[id] = sectionBar(id).open; });
      try {
        localStorage.setItem(SECTION_OPEN_KEY, JSON.stringify(state));
      } catch (err) {
        // private mode / quota -- the live DOM state still holds for this session
      }
    }

    function loadSectionOpenState() {
      try {
        const raw = localStorage.getItem(SECTION_OPEN_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : null;
      } catch (err) {
        return null;
      }
    }

    function setSectionOpen(map) {
      applyingSectionState = true;
      SECTION_BAR_IDS.forEach((id) => {
        if (id in map) sectionBar(id).open = !!map[id];
      });
      applyingSectionState = false;
    }

    // Mobile accordion: collapse every bar except the one just opened. Setting
    // .open = false only fires a toggle on bars that were actually open, and
    // the reentrancy guard keeps those cascade-closes from re-triggering this.
    function enforceMobileAccordion(keepId) {
      if (!mqSectionMobile.matches) return;
      applyingSectionState = true;
      SECTION_BAR_IDS.forEach((id) => {
        if (id !== keepId) sectionBar(id).open = false;
      });
      applyingSectionState = false;
    }

    SECTION_BAR_IDS.forEach((id) => {
      sectionBar(id).addEventListener('toggle', (event) => {
        if (applyingSectionState) return;
        if (event.target.open) enforceMobileAccordion(id);
        saveSectionOpenState();
      });
    });

    // Reconcile when crossing the breakpoint: entering mobile must leave at
    // most one bar open (prefer Jobs, else the first still-open bar; if none
    // are open, open Jobs so the view is never fully collapsed on mobile).
    function reconcileSectionsForBreakpoint() {
      if (mqSectionMobile.matches) {
        const open = SECTION_BAR_IDS.filter((id) => sectionBar(id).open);
        if (open.length > 1) {
          enforceMobileAccordion(open.includes('sbar-jobs') ? 'sbar-jobs' : open[0]);
        } else if (open.length === 0) {
          setSectionOpen({ 'sbar-jobs': true });
        }
      }
      saveSectionOpenState();
    }

    if (typeof mqSectionMobile.addEventListener === 'function') {
      mqSectionMobile.addEventListener('change', reconcileSectionsForBreakpoint);
    } else if (typeof mqSectionMobile.addListener === 'function') {
      mqSectionMobile.addListener(reconcileSectionsForBreakpoint); // older Safari
    }

    // Initial state: a saved state wins; otherwise the per-breakpoint default
    // (desktop -> Summaries + Jobs open, Tools closed; mobile -> Jobs only).
    (function initSectionState() {
      const saved = loadSectionOpenState();
      if (saved) {
        setSectionOpen(saved);
      } else if (mqSectionMobile.matches) {
        setSectionOpen({ 'sbar-summaries': false, 'sbar-jobs': true, 'sbar-tools': false });
      } else {
        setSectionOpen({ 'sbar-summaries': true, 'sbar-jobs': true, 'sbar-tools': false });
      }
      reconcileSectionsForBreakpoint();
    })();

    renderWindowChips();
    refresh();
    setInterval(refresh, POLL_INTERVAL_MS);
    setInterval(tickRunningTimers, 1000);
  </script>
</body>
</html>
