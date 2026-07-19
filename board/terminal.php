<?php
declare(strict_types=1);
// M1 terminal view: a read-only live tail of one job's raw CC output.
// xterm.js comes from a CDN (no build step in this project); everything
// else is plain client-side polling against output.php/jobs.php.
//
// Same no-cache headers as db.php's jsonResponse(): this account's ea-nginx
// reverse-proxy cache ignores plain Cache-Control and only ever respects
// the Set-Cookie (documented behaviour: it never caches a response that
// sets one). Without this, a stale cached copy of this page can keep being
// served across deploys even though the file on disk is current.
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('X-Accel-Expires: 0');
header('Set-Cookie: ccsw_nocache=1; Max-Age=0; Path=/ccswitchboard/board/');

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
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
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
    --running: #4d8bf0;
    --done: #3fb97e;
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

  header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--panel);
  }

  header a {
    color: var(--muted);
    text-decoration: none;
    font-size: 12px;
  }
  header a:hover { color: var(--text); }

  .job-id {
    font-family: var(--mono);
    font-weight: 600;
    font-size: 14px;
  }

  .thread {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--muted);
  }

  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    background: rgba(139, 144, 156, 0.15);
    color: var(--muted);
  }

  .pill.pending { background: rgba(216, 165, 61, 0.15); color: var(--pending); }
  .pill.running { background: rgba(77, 139, 240, 0.15); color: var(--running); }
  .pill.done { background: rgba(63, 185, 126, 0.15); color: var(--done); }

  /* Quiet type indicator for a bash/command job's pill -- a CC job's pill
     stays unmarked, so this glyph is the only visual cue distinguishing the
     two without adding a whole extra label. */
  .pill-type-glyph {
    font-family: var(--mono);
    margin-right: 3px;
    opacity: 0.75;
  }

  .more-info-link {
    color: var(--link, #6fb0f5);
    cursor: pointer;
    font-size: 12px;
    text-decoration: underline;
  }

  /* Job info hovercard: the header's job-id/pill/thread cluster used to
     surface the summary via a native title="" tooltip, which can't hold a
     clickable link -- so hovering it now shows this popup instead (mirrors
     index.php's #pill-hovercard), positioned flush under the header with
     its own "more info" link that expands in place to model+prompt. */
  #job-hovercard {
    position: fixed;
    z-index: 1000;
    min-width: 320px;
    max-width: 420px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    /* Extra top padding (rather than a gap between the header and the
       card's top edge) gives this its visual breathing room -- the card is
       positioned flush against the header's bottom edge, so the pointer
       never crosses a dead pixel strip with no hoverable element while
       moving from the header down onto the card. */
    padding-top: 16px;
    font-size: 12.5px;
    color: var(--text);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }

  #job-hovercard[hidden] {
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

  .detail-line {
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
    margin: 4px 0 0;
    padding: 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  #terminal-container {
    flex: 1 1 auto;
    min-height: 0;
    padding: 8px;
  }

  #terminal-container .terminal.xterm {
    height: 100%;
  }

  .notice {
    padding: 20px;
    color: var(--muted);
    font-size: 13px;
  }
</style>
</head>
<body>
  <header id="job-header">
    <span class="job-id">Job #<?php echo $jobId > 0 ? $jobId : '?'; ?></span>
    <span class="pill" id="status-pill">...</span>
    <span class="thread" id="thread-label"></span>
    <a href="index.php">&larr; back to board</a>
    <a href="feed.php?job_id=<?php echo $jobId; ?>">feed view</a>
  </header>
  <div id="terminal-container"></div>

  <script>
    const JOB_ID = <?php echo json_encode($jobId); ?>;
    const OUTPUT_POLL_MS = 1000;
    const HEADER_POLL_MS = 2000;

    if (!JOB_ID || JOB_ID <= 0) {
      document.getElementById('terminal-container').innerHTML =
        '<div class="notice">No job_id provided. Use terminal.php?job_id=&lt;id&gt;.</div>';
    } else {
      const term = new Terminal({
        disableStdin: true,
        convertEol: true,
        cursorBlink: false,
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        theme: {
          background: '#16181d',
          foreground: '#e4e6eb',
        },
      });
      const fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      term.open(document.getElementById('terminal-container'));
      fitAddon.fit();
      window.addEventListener('resize', () => fitAddon.fit());

      let lastSeq = 0;
      let currentJob = null;

      function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value ?? '';
        return div.innerHTML;
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

      // Formats a job's result_stats (see db.php's parseResultEnvelope) into
      // the compact "Cost $0.04 | in 12k / out 3k tok | 24 turns" label.
      // Cache tokens are folded into the "in" figure since that's the number
      // CC agentic loops actually spend most of their input budget on.
      // Returns null for bash jobs and non-envelope results.
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

      function hasMoreInfo(job) {
        return Boolean(job && (job.model || job.prompt));
      }

      // Job info hovercard: an interactive replacement for the header's old
      // native title="" tooltip (a native tooltip can't hold a clickable
      // link). Stays open while the pointer is over either the header or
      // the card itself (see the mouseenter/mouseleave pair below), with a
      // short close-delay bridging the gap between them.
      const headerEl = document.getElementById('job-header');
      let detailExpanded = false;
      let hovercardEl = null;
      let hovercardHideTimer = null;

      function ensureHovercard() {
        if (hovercardEl) return hovercardEl;
        hovercardEl = document.createElement('div');
        hovercardEl.id = 'job-hovercard';
        hovercardEl.hidden = true;
        document.body.appendChild(hovercardEl);
        hovercardEl.addEventListener('mouseenter', cancelHideHovercard);
        hovercardEl.addEventListener('mouseleave', scheduleHideHovercard);
        hovercardEl.addEventListener('click', (event) => {
          if (!event.target.closest('.more-info-link')) return;
          detailExpanded = !detailExpanded;
          renderHovercardContent();
        });
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

      function renderHovercardContent() {
        if (!hovercardEl || !currentJob) return;
        const typeHtml = `<div class="hovercard-type">${currentJob.is_command ? '(Command)' : '(CC job)'}</div>`;
        const summaryHtml = currentJob.summary
          ? `<div class="hovercard-summary">${escapeHtml(currentJob.summary)}</div>`
          : '';
        const linkHtml = hasMoreInfo(currentJob)
          ? `<span class="more-info-link">${detailExpanded ? 'less info' : 'more info...'}</span>`
          : '';
        const detailHtml = detailExpanded ? `<div class="hovercard-detail">${detailBlockHtml(currentJob)}</div>` : '';
        hovercardEl.innerHTML = `${typeHtml}${summaryHtml}${linkHtml}${detailHtml}`;
      }

      function showHovercard() {
        if (!currentJob || (!currentJob.summary && !hasMoreInfo(currentJob))) return;
        const card = ensureHovercard();
        cancelHideHovercard();
        renderHovercardContent();
        card.hidden = false;
        // Clamp horizontally so a header near the right edge of a narrow
        // window can't push the card -- and its more-info link -- off-screen.
        const rect = headerEl.getBoundingClientRect();
        const margin = 8;
        const maxLeft = window.innerWidth - card.offsetWidth - margin;
        const left = Math.max(margin, Math.min(Math.round(rect.left), maxLeft));
        card.style.left = `${left}px`;
        card.style.top = `${Math.round(rect.bottom)}px`;
      }

      // Hover-intent delay: a bare mouseenter fired the hovercard instantly,
      // popping it open on every incidental pass over the header. Only show
      // it once the pointer has actually lingered.
      let hoverIntentTimer = null;
      headerEl.addEventListener('mouseenter', () => {
        clearTimeout(hoverIntentTimer);
        hoverIntentTimer = setTimeout(showHovercard, 500);
      });
      headerEl.addEventListener('mouseleave', (event) => {
        clearTimeout(hoverIntentTimer);
        if (!(hovercardEl && hovercardEl.contains(event.relatedTarget))) {
          scheduleHideHovercard();
        }
      });

      async function pollOutput() {
        try {
          const res = await fetch(`output.php?job_id=${JOB_ID}&after=${lastSeq}`);
          const body = await res.json();
          if (Array.isArray(body?.chunks)) {
            for (const chunk of body.chunks) {
              term.write(chunk.text + '\n');
              lastSeq = Math.max(lastSeq, chunk.seq);
            }
          }
        } catch (err) {
          // network hiccup -- just retry on the next tick
        }
      }

      async function pollHeader() {
        try {
          const res = await fetch('jobs.php?status=all&limit=200');
          const body = await res.json();
          const job = Array.isArray(body?.jobs) ? body.jobs.find((j) => j.id === JOB_ID) : null;
          currentJob = job || null;

          const statusPill = document.getElementById('status-pill');
          const threadLabel = document.getElementById('thread-label');
          if (job) {
            const glyph = job.is_command ? '<span class="pill-type-glyph">&gt;_</span>' : '';
            statusPill.innerHTML = `${glyph}${escapeHtml(job.status)}`;
            statusPill.className = `pill ${job.status}`;
            threadLabel.textContent = job.thread || '(no thread)';
          } else {
            statusPill.textContent = 'unknown';
            statusPill.className = 'pill';
            threadLabel.textContent = '';
          }

          // Keep an already-open hovercard in sync with the freshly-polled
          // job (or close it if the job vanished) rather than leaving it
          // showing stale data -- doesn't touch detailExpanded, so a
          // just-opened "more info" panel survives this 2s refresh.
          if (hovercardEl && !hovercardEl.hidden) {
            if (currentJob) {
              renderHovercardContent();
            } else {
              hovercardEl.hidden = true;
            }
          }
        } catch (err) {
          // network hiccup -- just retry on the next tick
        }
      }

      pollOutput();
      pollHeader();
      setInterval(pollOutput, OUTPUT_POLL_MS);
      setInterval(pollHeader, HEADER_POLL_MS);
    }
  </script>
</body>
</html>
