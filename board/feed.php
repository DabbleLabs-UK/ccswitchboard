<?php
declare(strict_types=1);
// M1 feed view: a prettified, typed rendering of one job's raw stream-json
// output (vs. terminal.php's flat xterm tail). Same polling shape as
// terminal.php; the difference is entirely in how each chunk gets rendered.
//
// Same no-cache headers as db.php's jsonResponse() -- see terminal.php for
// why plain Cache-Control alone isn't enough on this host.
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('X-Accel-Expires: 0');
header('Set-Cookie: ccsw_nocache=1; Max-Age=0; Path=/ccswitchboard/board/');

require __DIR__ . '/auth.php';

// feed.php runs server-side (same server as auth.config.php), so once the
// caller has PROVEN it already holds the token it can read the token here and
// hand it to that caller's own JS -- the extension's chrome.storage isn't
// reachable from inside this cross-origin iframe, so an authenticated inline
// is the only way to seed it.
//
// The token is inlined ONLY for a request that already carries it, checked the
// exact same way every other gate does (requestToken()/authToken()/
// hash_equals). Two legitimate transports satisfy it:
//   - the ccsw_token cookie: the board's own same-origin feed dialog
//     (index.php) rides it automatically;
//   - the X-CCSW-Token header: the extension embeds this page as a
//     CROSS-ORIGIN iframe on claude.ai, where the SameSite=Strict gate cookie
//     is withheld and an iframe navigation can't set a header from script --
//     so the extension attaches it via a declarativeNetRequest rule instead
//     (see registerFeedTokenRule in background.js).
// An unauthenticated GET matches neither and is served the page with an EMPTY
// token, never the secret -- index.php's self-gate posture (a JSON 401 is
// wrong here: this is an iframe document, not an API call). Gated
// unconditionally, independent of AUTH_ENFORCE's grace mode: there is no
// grace-period reason to ever hand the shared relay token to an anonymous
// request.
$providedToken = requestToken();
$isAuthed = $providedToken !== null && hash_equals(authToken(), $providedToken);
if (!$isAuthed) {
    logAuthEvent($providedToken === null ? 'missing' : 'invalid');
}
$authToken = $isAuthed ? authToken() : '';

$jobId = isset($_GET['job_id']) ? (int) $_GET['job_id'] : 0;
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job <?php echo $jobId > 0 ? $jobId : '?'; ?> - CCSwitchboard</title>
<link rel="icon" type="image/x-icon" href="favicon.ico?v=<?php echo @filemtime(__DIR__ . '/favicon.ico') ?: '1'; ?>">
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32x32.png?v=<?php echo @filemtime(__DIR__ . '/favicon-32x32.png') ?: '1'; ?>">
<link rel="icon" type="image/png" sizes="16x16" href="favicon-16x16.png?v=<?php echo @filemtime(__DIR__ . '/favicon-16x16.png') ?: '1'; ?>">
<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png?v=<?php echo @filemtime(__DIR__ . '/apple-touch-icon.png') ?: '1'; ?>">
<style>
  :root {
    color-scheme: dark;
    --bg: #16181d;
    --panel: #1e2128;
    --row-tint: #1a1d23;
    --border: #2c303a;
    --text: #e4e6eb;
    --muted: #8b909c;
    --dim: #5c616c;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --pending: #d8a53d;
    --running: #4d8bf0;
    --done: #3fb97e;
    --tool: #b98cf0;
    --link: #6fb0f5;
  }

  * { box-sizing: border-box; }

  html, body {
    height: 100%;
    margin: 0;
  }

  body {
    display: flex;
    flex-direction: column;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  #feed {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 0 40px;
  }

  .item {
    padding: 10px 20px;
    font-size: 13.5px;
    line-height: 1.55;
  }

  .item:nth-child(even) {
    background: var(--row-tint);
  }

  .prose {
    white-space: pre-wrap;
    word-break: break-word;
  }

  .thinking summary {
    cursor: pointer;
    color: var(--dim);
    font-size: 12px;
    font-style: italic;
    user-select: none;
  }
  .thinking .thinking-body {
    margin-top: 6px;
    color: var(--dim);
    font-style: italic;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .tool-use {
    display: flex;
    align-items: baseline;
    gap: 8px;
    border-left: 3px solid var(--tool);
    padding-left: 10px;
  }
  .tool-name {
    font-family: var(--mono);
    font-weight: 600;
    color: var(--tool);
    white-space: nowrap;
  }
  .tool-detail {
    font-family: var(--mono);
    color: var(--muted);
    word-break: break-word;
  }

  .tool-result {
    font-family: var(--mono);
    color: var(--muted);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 0;
    max-height: 240px;
    overflow-y: auto;
  }

  .tool-result-line {
    padding: 1px 10px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .tool-result-line--alt {
    background: rgba(255, 255, 255, 0.04);
  }

  .result-block {
    border: 1px solid var(--done);
    background: rgba(63, 185, 126, 0.08);
    border-radius: 8px;
    padding: 12px 14px;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 14.5px;
  }

  .result-block-header {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 6px;
  }

  .result-block-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 6px;
  }

  .result-resend-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 4px 6px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
  }
  .result-resend-btn:hover {
    color: var(--text);
    border-color: var(--muted);
  }
  .result-resend-btn svg {
    display: block;
  }

  .filepath {
    font-family: var(--mono);
    color: var(--muted);
    background: rgba(139, 144, 156, 0.12);
    padding: 0 4px;
    border-radius: 3px;
  }

  a { color: var(--link); }

  .notice {
    padding: 20px;
    color: var(--muted);
    font-size: 13px;
  }

  .bottom-status {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-top: 1px solid var(--border);
    background: var(--panel);
    color: var(--running);
    font-size: 12.5px;
  }
  .bottom-status[hidden] { display: none; }

  .bottom-status-lines {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .icon-btn {
    margin-left: auto;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 4px 8px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
  }
  .icon-btn:hover {
    color: var(--text);
    border-color: var(--muted);
  }
  .icon-btn svg {
    display: block;
  }

  .cancel-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 6px;
    cursor: pointer;
  }
  .cancel-btn:hover {
    color: var(--text);
    border-color: var(--muted);
  }
  .cancel-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .size-confirm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .size-confirm-modal {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px 20px;
    max-width: 380px;
    color: var(--text);
    font-size: 13.5px;
    line-height: 1.5;
  }

  .size-confirm-modal p {
    margin: 0 0 10px;
  }

  .size-confirm-actions {
    display: flex;
    gap: 8px;
    margin-top: 14px;
    flex-wrap: wrap;
  }

  .size-confirm-actions button {
    flex: 1 1 auto;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12.5px;
  }

  .size-confirm-actions button:hover {
    border-color: var(--muted);
  }

  .size-confirm-actions button[data-choice="cancel"] {
    color: var(--muted);
  }

  .spinner {
    width: 13px;
    height: 13px;
    border: 2px solid rgba(77, 139, 240, 0.25);
    border-top-color: var(--running);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .feed-loading-spinner {
    position: absolute;
    top: 50%;
    left: 50%;
    margin-top: -18px;
    margin-left: -18px;
    width: 36px;
    height: 36px;
    border: 3px solid rgba(77, 139, 240, 0.25);
    border-top-color: var(--running);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
</style>
</head>
<body>
  <div id="feed"></div>
  <div class="bottom-status" id="bottom-status" hidden>
    <span class="spinner" id="bottom-status-spinner"></span>
    <div class="bottom-status-lines">
      <span id="bottom-status-text">Running...</span>
    </div>
    <button class="icon-btn" id="advice-btn" type="button" title="Send current progress to claude.ai web chat to get advice on current progress" aria-label="Send progress for advice"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4v7a4 4 0 0 1-4 4H4"></path><polyline points="9 10 4 15 9 20"></polyline></svg></button>
    <button class="cancel-btn" id="cancel-btn" type="button">Cancel</button>
  </div>

  <script>
    const JOB_ID = <?php echo json_encode($jobId); ?>;
    const CCSW_AUTH_HEADER = <?php echo json_encode(AUTH_HEADER); ?>;
    const CCSW_AUTH_TOKEN = <?php echo json_encode($authToken); ?>;
    const OUTPUT_POLL_MS = 1000;
    const HEADER_POLL_MS = 2000;
    const TICK_MS = 1000;
    // This page loads inside a cross-origin iframe embedded by the extension's
    // content script on claude.ai, so the advice button below can't reach
    // chrome.* APIs directly -- it posts to the parent frame instead (see the
    // 'ccsw-advice-request' listener in content.js), scoped to this exact
    // origin so the message can't be read by some other page embedding us.
    const CLAUDE_ORIGIN = 'https://claude.ai';

    // Messages over this size get a confirm step (see sendToChat) rather
    // than being typed into Claude's input unannounced -- a full multi-hour
    // job's feed text can run to tens of thousands of characters.
    const SEND_SIZE_THRESHOLD = 6000;

    // Four-way choice (truncated / results-only / full / cancel) doesn't fit
    // the native confirm() dialog's OK/Cancel shape, so this is a minimal
    // custom modal instead. Resolves to 'truncated', 'results', 'full', or
    // null (cancelled). The results-only button only appears when the caller
    // has a distinct result summary to offer (see sendToChat).
    function showSizeConfirm(charCount, resultText) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'size-confirm-overlay';
        const resultsButtonHtml = resultText
          ? `<button type="button" data-choice="results">Send result only</button>`
          : '';
        overlay.innerHTML = `<div class="size-confirm-modal">
          <p>This message is ${charCount.toLocaleString()} characters -- quite large to send into chat.</p>
          <p>Send only the latest ~${SEND_SIZE_THRESHOLD.toLocaleString()} characters instead of the full text?</p>
          <div class="size-confirm-actions">
            <button type="button" data-choice="truncated">Send latest ~${SEND_SIZE_THRESHOLD.toLocaleString()}</button>
            ${resultsButtonHtml}
            <button type="button" data-choice="full">Send full</button>
            <button type="button" data-choice="cancel">Cancel</button>
          </div>
        </div>`;
        overlay.addEventListener('click', (event) => {
          const choice = event.target.dataset?.choice;
          if (!choice) return;
          overlay.remove();
          resolve(choice === 'cancel' ? null : choice);
        });
        document.body.appendChild(overlay);
      });
    }

    // Shared by the advice-btn and per-result resend buttons -- both post
    // the same 'ccsw-advice-request' message to the parent frame, just with
    // different text. Anything under the threshold sends immediately with
    // no prompt, matching prior behaviour. resultText is the job's final
    // result-event text (see lastResultText) -- only the advice-btn's full
    // progress dump passes it, since a per-result resend is already just
    // that text and offering "result only" there would be a no-op choice.
    async function sendToChat(jobId, text, resultText) {
      let payload = text;
      if (text.length > SEND_SIZE_THRESHOLD) {
        const choice = await showSizeConfirm(text.length, resultText);
        if (!choice) return;
        if (choice === 'truncated') payload = text.slice(-SEND_SIZE_THRESHOLD);
        else if (choice === 'results') payload = resultText;
      }
      window.parent.postMessage({ type: 'ccsw-advice-request', jobId, text: payload }, CLAUDE_ORIGIN);
    }

    const feedEl = document.getElementById('feed');

    if (!JOB_ID || JOB_ID <= 0) {
      feedEl.innerHTML = '<div class="notice">No job_id provided. Use feed.php?job_id=&lt;id&gt;.</div>';
    } else {
      let lastSeq = 0;
      // The most recent assistant "text" block is held here instead of being
      // rendered right away, because it's usually just the result event's
      // text arriving early -- see renderEvent().
      let pendingText = null;

      // Live footer timers: runningStartedAt comes from the job's started_at
      // column, set once by poll.php at the moment it flipped pending ->
      // running and never touched again -- so it's available even if this
      // page loads after a fast job (typically a bash command) has already
      // finished, rather than only when a poll happened to catch it live
      // mid-run. lastOutputAt is the timestamp of the newest job_output row
      // seen so far, refreshed as new chunks arrive during polling. terminalAt
      // is the job's updated_at once it reaches a terminal state (done/error/
      // cancelled/timeout all collapse to DB status 'done'), which is also
      // never touched again -- so runningStartedAt/terminalAt together give
      // a stable total run duration.
      let currentStatus = null;
      let currentJobName = null;
      // NULL until the job goes terminal; one of classifyJobResult()'s
      // success/cancelled/needs_input/errored (db.php), straight off
      // status.php's own poll -- the send-to-chat header (#51) below uses
      // this authoritative value instead of re-deriving its own
      // classification from result text, which would drift from (and risk
      // disagreeing with) what jobs.php/thread_states.php already show for
      // the same job.
      let currentOutcome = null;
      let runningStartedAt = null;
      let terminalAt = null;
      let createdAt = null;
      let lastOutputAt = null;
      // Cost/token/turn stats off the job's "type":"result" stream-json event
      // (see renderEvent below) -- stays null for bash jobs and jobs that
      // never produced that event (cancelled/timed out/launch error).
      let resultStats = null;
      // The result event's own text, captured alongside resultStats -- lets
      // the size-confirm modal offer "send result only" as an alternative to
      // a full progress dump, without re-parsing anything.
      let lastResultText = null;

      // Once a job reaches DONE, its output is final -- reopening the same
      // job later (extension panel re-toggled after a claude.ai tab reload,
      // or the board's feed-dialog which reloads the iframe on every open)
      // shouldn't have to re-fetch every output row and rebuild the whole
      // DOM again. sessionStorage is per-tab and scoped to this page's own
      // origin, so it survives both of those reload paths within the same
      // browser tab. Keyed by job id; validated against the job's updated_at
      // (stable forever once terminal, per pollHeader below) so a stale or
      // mismatched entry is never trusted blindly.
      const CACHE_VERSION = 1;
      const CACHE_KEY = `ccsw-feed-cache:${JOB_ID}`;
      let cacheSaved = false;
      let outputIntervalId = null;
      let headerIntervalId = null;
      let tickIntervalId = null;

      function saveFeedCache(updatedAt) {
        if (cacheSaved) return;
        cacheSaved = true;
        try {
          sessionStorage.setItem(CACHE_KEY, JSON.stringify({
            v: CACHE_VERSION,
            updatedAt,
            feedHtml: feedEl.innerHTML,
            resultStats,
            lastResultText,
            currentJobName,
            currentOutcome,
            runningStartedAt: runningStartedAt ? runningStartedAt.toISOString() : null,
            terminalAt: terminalAt ? terminalAt.toISOString() : null,
            createdAt: createdAt ? createdAt.toISOString() : null,
            lastSeq,
          }));
        } catch (err) {
          // sessionStorage full or unavailable (private browsing, quota) --
          // caching is purely an optimization, so just skip it.
        }
      }

      // Rebinds the resend-to-chat click handler on a result block's buttons
      // -- needed both for a freshly rendered result event and for buttons
      // restored from cached innerHTML, since innerHTML never carries JS
      // listeners with it.
      function bindResendButtons(container, text) {
        container.querySelectorAll('.result-resend-btn').forEach((btn) => {
          btn.addEventListener('click', () => {
            sendToChat(JOB_ID, `${buildTerminalHeader()}\n\n${text}`);
          });
        });
      }

      // Badge shown ahead of the header (#51). currentOutcome is
      // classifyJobResult()'s (db.php) success/cancelled/needs_input/errored,
      // straight off status.php's poll -- needs_input still collapses to the
      // DONE badge here (the job isn't running or cancelled, and server-side
      // needs_input is deliberately kept out of errored -- see db.php), but
      // the raw value still shows in the parenthetical below so "stopped to
      // ask a question" doesn't read identically to a clean finish.
      const OUTCOME_BADGES = { errored: 'ERRORED', cancelled: 'CANCELLED', success: 'DONE', needs_input: 'DONE' };

      // State-first send header (#51) for a job that is NOT genuinely still
      // running -- shared by the advice-btn (once the job has gone terminal)
      // and the per-result resend button (whose "result" event, per its own
      // comment above, only ever fires once a job is finished, so it's always
      // terminal regardless of what currentStatus's last poll happened to say).
      function buildTerminalHeader() {
        const label = currentJobName ? ` '${currentJobName}'` : '';
        const badge = OUTCOME_BADGES[currentOutcome] || 'DONE';
        const facts = [`outcome ${currentOutcome || 'unknown'}`];
        if (runningStartedAt && terminalAt) facts.push(`ran ${formatDuration(terminalAt.getTime() - runningStartedAt.getTime())}`);
        return `FYI: job ${JOB_ID}${label} -- ${badge} (${facts.join(', ')}) -- final output:`;
      }

      // A job's ACTUAL state leads, not a generic "here's the progress" --
      // "current progress" wording is only accurate while the job is
      // genuinely still running.
      function buildAdviceHeader() {
        if (currentStatus === 'running' || currentStatus === 'pending') {
          const label = currentJobName ? ` '${currentJobName}'` : '';
          return `FYI: here's the current progress on job ${JOB_ID}${label} so far:`;
        }
        return buildTerminalHeader();
      }

      function formatDuration(ms) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}m ${seconds}s`;
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

      // Formats the captured result event into the compact
      // "Cost $0.04 | in 12k / out 3k tok | 24 turns" label. Cache tokens are
      // folded into the "in" figure since that's the number CC agentic loops
      // actually spend most of their input budget on.
      function formatResultStats(stats) {
        if (!stats || typeof stats.total_cost_usd !== 'number') return null;
        const inputTok = (stats.input_tokens || 0) + (stats.cache_creation_input_tokens || 0) + (stats.cache_read_input_tokens || 0);
        const outputTok = stats.output_tokens || 0;
        const parts = [`Cost $${stats.total_cost_usd.toFixed(2)}`, `in ${formatTokenCount(inputTok)} / out ${formatTokenCount(outputTok)} tok`];
        if (typeof stats.num_turns === 'number') parts.push(`${stats.num_turns} turns`);
        return parts.join(' | ');
      }

      function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value ?? '';
        return div.innerHTML;
      }

      // URLs first (captured so String.split hands them back at odd
      // indices), then file-path-looking substrings on the remaining
      // segments only -- doing both in one pass risks a path regex
      // matching text already inside an <a href="..."> from the URL pass.
      const URL_RE = /(https?:\/\/[^\s<]+)/g;
      const FILEPATH_RE = /(?:\.{1,2}\/[\w.\-/]+|\/[\w.\-/]+\.\w+|\b[\w-]+(?:\/[\w.-]+)+\.\w+|\b[\w-]+\.(?:js|jsx|ts|tsx|py|php|json|md|txt|html|css|scss|cs|java|go|rb|rs|yaml|yml|toml|sh|bash|sql|xml|ini|cfg|conf|log)\b)/g;

      function autoLink(escapedText) {
        return escapedText.split(URL_RE).map((part, i) => {
          if (i % 2 === 1) {
            return `<a href="${part}" target="_blank" rel="noopener noreferrer">${part}</a>`;
          }
          return part.replace(FILEPATH_RE, '<span class="filepath">$&</span>');
        }).join('');
      }

      function richText(text) {
        return autoLink(escapeHtml(text));
      }

      // Shows/hides the large centred spinner that covers the catch-up gap
      // between opening this view and the first real output chunk painting
      // (see appendItem below, which is the "first content painted" hook).
      function showFeedSpinner() {
        if (document.getElementById('feed-loading-spinner')) return;
        const el = document.createElement('div');
        el.id = 'feed-loading-spinner';
        el.className = 'feed-loading-spinner';
        feedEl.appendChild(el);
      }

      function hideFeedSpinner() {
        const el = document.getElementById('feed-loading-spinner');
        if (el) el.remove();
      }

      function appendItem(html) {
        // First real content painting into #feed -- the loading spinner (if
        // still showing) has served its purpose.
        hideFeedSpinner();
        const wasNearBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 80;
        const div = document.createElement('div');
        div.className = 'item';
        div.innerHTML = html;
        feedEl.appendChild(div);
        if (wasNearBottom) {
          feedEl.scrollTop = feedEl.scrollHeight;
        }
        return div;
      }

      // Render the buffered assistant text block, if any -- called whenever
      // something other than a matching result event follows it, so it
      // wasn't actually a trailing echo.
      function flushPendingText() {
        if (pendingText) {
          appendItem(pendingText.html);
          pendingText = null;
        }
      }

      function toolResultText(block) {
        if (typeof block.content === 'string') return block.content;
        if (Array.isArray(block.content)) {
          return block.content.map((c) => (typeof c === 'string' ? c : c.text ?? '')).join('\n');
        }
        return '';
      }

      function summarizeToolInput(name, input) {
        if (!input || typeof input !== 'object') return null;
        if (typeof input.file_path === 'string') return input.file_path;
        if (typeof input.command === 'string') return input.command;
        if (typeof input.pattern === 'string') return input.pattern;
        if (typeof input.url === 'string') return input.url;
        if (typeof input.query === 'string') return input.query;
        const firstString = Object.values(input).find((v) => typeof v === 'string');
        return firstString ?? null;
      }

      function renderContentBlock(block) {
        if (block.type === 'text') {
          return `<div class="prose">${richText(block.text ?? '')}</div>`;
        }
        if (block.type === 'thinking') {
          // Headless CC runs return thinking blocks with an empty "thinking"
          // string and only a signature -- an empty collapsible is just
          // clutter, so skip rendering entirely when there's no actual text.
          const body = block.thinking ?? block.text ?? '';
          if (!body.trim()) return null;
          return `<details class="thinking"><summary>Thinking</summary><div class="thinking-body">${richText(body)}</div></details>`;
        }
        if (block.type === 'tool_use') {
          const detail = summarizeToolInput(block.name, block.input);
          return `<div class="tool-use"><span class="tool-name">${escapeHtml(block.name ?? 'tool')}</span>${detail ? `<span class="tool-detail">${richText(detail)}</span>` : ''}</div>`;
        }
        if (block.type === 'tool_result') {
          return `<div class="tool-result">${toolResultLines(toolResultText(block))}</div>`;
        }
        return null;
      }

      // Zebra-stripes each line of a tool_result block (Read/Grep output is
      // typically numbered, one line per row) for readability -- each line
      // gets its own row div instead of relying on the block's own
      // white-space: pre-wrap to lay out newlines.
      function toolResultLines(text) {
        return text.split('\n').map((line, i) => {
          const cls = i % 2 === 1 ? ' tool-result-line--alt' : '';
          return `<div class="tool-result-line${cls}">${richText(line) || '&nbsp;'}</div>`;
        }).join('');
      }

      function renderEvent(event) {
        if (event.type === 'system' || event.type === 'rate_limit_event') {
          return;
        }

        if (event.type === 'result') {
          const text = typeof event.result === 'string' ? event.result : JSON.stringify(event, null, 2);
          // Whatever assistant text was buffered turned out to be the
          // trailing echo of this result -- drop it, never render it, and
          // show only the highlighted result block.
          pendingText = null;
          lastResultText = text;
          if (typeof event.total_cost_usd === 'number') {
            const usage = event.usage || {};
            resultStats = {
              total_cost_usd: event.total_cost_usd,
              num_turns: event.num_turns,
              duration_ms: event.duration_ms,
              input_tokens: usage.input_tokens,
              output_tokens: usage.output_tokens,
              cache_creation_input_tokens: usage.cache_creation_input_tokens,
              cache_read_input_tokens: usage.cache_read_input_tokens,
            };
          }
          // The resend button reuses the exact same postMessage -> content.js
          // -> background.js send bridge as the advice-btn below (see the
          // CLAUDE_ORIGIN comment) -- it just hands back this result's own
          // text instead of a full-progress summary. A 'result' event only
          // ever arrives once a job is finished, so this button is
          // inherently terminal-jobs-only with no extra status gating needed.
          const resendBtnHtml = `<button class="result-resend-btn" type="button" title="Re-send this job's result to the chat" aria-label="Re-send result to chat"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4v7a4 4 0 0 1-4 4H4"></path><polyline points="9 10 4 15 9 20"></polyline></svg></button>`;
          const div = appendItem(`<div class="result-block"><div class="result-block-header">${resendBtnHtml}</div><div class="result-text">${richText(text)}</div><div class="result-block-footer">${resendBtnHtml}</div></div>`);
          // Same handler on both the top and bottom button -- see the
          // result-block-footer comment above; a long result shouldn't force
          // a scroll back to the top just to resend it.
          bindResendButtons(div, text);
          return;
        }

        if (event.type === 'assistant' || event.type === 'user') {
          const content = event.message?.content;
          if (!Array.isArray(content)) return;
          for (const block of content) {
            // A bare "user" text block (not a tool_result) is just the
            // prompt echo -- hide it per spec; tool_result is the one
            // "user"-role block type that's actually worth showing.
            if (event.type === 'user' && block.type !== 'tool_result') continue;
            if (block.type === 'text') {
              // An earlier buffered text block wasn't immediately followed
              // by a result, so it wasn't a trailing echo -- show it now.
              flushPendingText();
              const html = renderContentBlock(block);
              if (html) pendingText = { html, text: block.text ?? '' };
              continue;
            }
            flushPendingText();
            const html = renderContentBlock(block);
            if (html) appendItem(html);
          }
        }
      }

      async function pollOutput() {
        try {
          const res = await fetch(`output.php?job_id=${JOB_ID}&after=${lastSeq}`, {
            headers: { [CCSW_AUTH_HEADER]: CCSW_AUTH_TOKEN },
          });
          const body = await res.json();
          if (Array.isArray(body?.chunks)) {
            for (const chunk of body.chunks) {
              lastSeq = Math.max(lastSeq, chunk.seq);
              lastOutputAt = new Date(chunk.at);
              try {
                renderEvent(JSON.parse(chunk.text));
              } catch (err) {
                // not a JSON event (or an older chunk from before the agent
                // switched to posting raw lines) -- show it plainly rather
                // than silently dropping it.
                appendItem(`<div class="prose">${richText(chunk.text)}</div>`);
              }
            }
          }
        } catch (err) {
          // network hiccup -- just retry on the next tick
        }
      }

      const bottomStatus = document.getElementById('bottom-status');
      const bottomStatusText = document.getElementById('bottom-status-text');
      const bottomStatusSpinner = document.getElementById('bottom-status-spinner');
      const cancelBtn = document.getElementById('cancel-btn');
      const adviceBtn = document.getElementById('advice-btn');

      // #64 floor rule: this box's send icon is ALWAYS present -- while
      // running/pending it sends current progress ('Send status'), once
      // terminal it sends the final outcome ('Send result', matching
      // buildTerminalHeader's own "final output" wording below). Never
      // hidden, unlike cancelBtn/bottomStatusSpinner which only make sense
      // while the job can still be acted on.
      function setAdviceBtnMode(mode) {
        adviceBtn.hidden = false;
        if (mode === 'result') {
          adviceBtn.title = "Send this job's result to claude.ai web chat";
          adviceBtn.setAttribute('aria-label', 'Send result');
        } else {
          adviceBtn.title = 'Send current progress to claude.ai web chat to get advice on current progress';
          adviceBtn.setAttribute('aria-label', 'Send status');
        }
      }

      // Repaints the status line from currentStatus/runningStartedAt/
      // terminalAt/lastOutputAt -- called every TICK_MS so it keeps counting
      // up between polls, and once right after pollHeader picks up a status
      // change so the text doesn't wait for the next tick to catch up.
      function tick() {
        if (currentStatus === 'pending') {
          bottomStatusText.textContent = createdAt
            ? `Pending... (for ${formatDuration(Date.now() - createdAt.getTime())})`
            : 'Pending...';
          return;
        }
        if (currentStatus === 'running') {
          const now = Date.now();
          let html = `Running for ${formatDuration(now - runningStartedAt.getTime())}`;
          if (lastOutputAt) {
            html += ` <span style="color: #aaa;">(last output ${formatDuration(now - lastOutputAt.getTime())} ago)</span>`;
          }
          bottomStatusText.innerHTML = html;
          return;
        }
        // Terminal (done/error/cancelled/timeout -- all DB status 'done').
        // Duration is only shown when we actually observed the running-start
        // timestamp; if the page loaded after the job had already finished
        // (or it never reached running at all, e.g. a launch error), fall
        // back to just the outcome badge -- the #64 floor rule still needs
        // this line (and the send icon below it) present either way.
        if (runningStartedAt && terminalAt) {
          let text = `Ran for ${formatDuration(terminalAt.getTime() - runningStartedAt.getTime())}`;
          const statsText = formatResultStats(resultStats);
          if (statsText) text += ` -- ${statsText}`;
          bottomStatusText.textContent = text;
        } else if (terminalAt) {
          bottomStatusText.textContent = OUTCOME_BADGES[currentOutcome] || 'Finished';
        }
      }

      async function pollHeader() {
        try {
          const res = await fetch(`status.php?id=${JOB_ID}`, {
            headers: { [CCSW_AUTH_HEADER]: CCSW_AUTH_TOKEN },
          });
          const body = await res.json();
          const job = body && !body.error ? body : null;

          if (job) {
            currentStatus = job.status;
            currentJobName = job.name || null;
            currentOutcome = job.outcome || null;
            runningStartedAt = job.started_at ? new Date(job.started_at) : null;
            createdAt = job.created_at ? new Date(job.created_at) : null;
            if (job.status === 'running' || job.status === 'pending') {
              bottomStatusSpinner.hidden = false;
              cancelBtn.hidden = false;
              setAdviceBtnMode('progress');
              bottomStatus.hidden = false;
              tick();
            } else {
              // #64 floor rule: every terminal box (done/error/cancelled --
              // this branch also covers a job that never reached running at
              // all, e.g. a launch error) keeps the send icon, left of
              // Cancel -- only Cancel (nothing left to cancel) and the
              // spinner go away. runningStartedAt being unset just means
              // tick() falls back to the outcome badge instead of a duration.
              terminalAt = new Date(job.updated_at);
              bottomStatusSpinner.hidden = true;
              cancelBtn.hidden = true;
              setAdviceBtnMode('result');
              bottomStatus.hidden = false;
              tick();
            }
            // A finished job with no result event never got the chance to
            // drop the buffered text -- show it rather than losing it.
            if (job.status === 'done') {
              // pollOutput runs on its own interval and may not have caught
              // up to this exact status flip yet -- drain whatever's left
              // before flushing/caching so the cached render is complete.
              await pollOutput();
              flushPendingText();
              // A job that finished having never emitted any output (e.g.
              // it errored before its first chunk) would otherwise leave the
              // loading spinner running forever -- swap it for a subtle
              // notice instead.
              if (lastSeq === 0) {
                hideFeedSpinner();
                feedEl.innerHTML = '<div class="notice">No output.</div>';
              }
              saveFeedCache(job.updated_at);
              // Output is final for a done job -- nothing left to poll.
              if (outputIntervalId) { clearInterval(outputIntervalId); outputIntervalId = null; }
              if (headerIntervalId) { clearInterval(headerIntervalId); headerIntervalId = null; }
              if (tickIntervalId) { clearInterval(tickIntervalId); tickIntervalId = null; }
            }
          } else {
            currentStatus = null;
            bottomStatus.hidden = true;
          }
        } catch (err) {
          // network hiccup -- just retry on the next tick
        }
      }

      // Bundles the rendered feed text plus the live "Running for..." line
      // into one message and hands it to the parent frame (content.js) to
      // type into Claude's own input -- see the CLAUDE_ORIGIN comment above
      // for why this goes through postMessage instead of a direct API call.
      document.getElementById('advice-btn').addEventListener('click', () => {
        const feedText = feedEl.innerText.trim();
        const statusLine = bottomStatusText.textContent.trim();
        const message = [
          buildAdviceHeader(),
          '',
          feedText,
          '',
          statusLine,
        ].join('\n');
        sendToChat(JOB_ID, message, lastResultText);
      });

      document.getElementById('cancel-btn').addEventListener('click', async (event) => {
        if (!confirm('Cancel this job?')) return;

        const btn = event.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Cancelling...';
        try {
          await fetch('cancel.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [CCSW_AUTH_HEADER]: CCSW_AUTH_TOKEN },
            body: JSON.stringify({ job_id: JOB_ID }),
          });
        } catch (err) {
          // network hiccup -- let the user retry
          btn.disabled = false;
          btn.textContent = 'Cancel';
        }
      });

      // Tries a same-tab sessionStorage cache before falling back to the
      // normal poll-and-render path. Only trusted when status.php still
      // reports 'done' with the exact same updated_at the cache was saved
      // under -- a done job's updated_at never changes again (see
      // pollHeader), so a match means the cached render is still accurate.
      async function loadFromCache() {
        let cached;
        try {
          const raw = sessionStorage.getItem(CACHE_KEY);
          // No cache to even try -- this is a definite miss with no need to
          // wait on a network round-trip, so the loading spinner can go up
          // immediately, well before pollOutput's first fetch resolves.
          if (!raw) { showFeedSpinner(); return false; }
          cached = JSON.parse(raw);
        } catch (err) {
          showFeedSpinner();
          return false;
        }
        if (!cached || cached.v !== CACHE_VERSION) { showFeedSpinner(); return false; }

        // A plausible cache entry exists -- hold off on the spinner while it
        // gets verified below, so a genuine cache hit never flashes one.
        let job;
        try {
          const res = await fetch(`status.php?id=${JOB_ID}`, {
            headers: { [CCSW_AUTH_HEADER]: CCSW_AUTH_TOKEN },
          });
          const body = await res.json();
          job = body && !body.error ? body : null;
        } catch (err) {
          showFeedSpinner();
          return false;
        }
        if (!job || job.status !== 'done' || job.updated_at !== cached.updatedAt) { showFeedSpinner(); return false; }

        feedEl.innerHTML = cached.feedHtml;
        bindResendButtons(feedEl, cached.lastResultText);
        feedEl.scrollTop = feedEl.scrollHeight;

        lastSeq = cached.lastSeq;
        resultStats = cached.resultStats;
        lastResultText = cached.lastResultText;
        currentJobName = cached.currentJobName || null;
        currentOutcome = cached.currentOutcome || null;
        runningStartedAt = cached.runningStartedAt ? new Date(cached.runningStartedAt) : null;
        terminalAt = cached.terminalAt ? new Date(cached.terminalAt) : null;
        createdAt = cached.createdAt ? new Date(cached.createdAt) : null;
        currentStatus = 'done';
        cacheSaved = true;

        bottomStatusSpinner.hidden = true;
        cancelBtn.hidden = true;
        setAdviceBtnMode('result');
        bottomStatus.hidden = false;
        tick();
        return true;
      }

      (async () => {
        const cacheHit = await loadFromCache();
        if (cacheHit) return;

        pollOutput();
        pollHeader();
        outputIntervalId = setInterval(pollOutput, OUTPUT_POLL_MS);
        headerIntervalId = setInterval(pollHeader, HEADER_POLL_MS);
        tickIntervalId = setInterval(tick, TICK_MS);
      })();
    }
  </script>
</body>
</html>
