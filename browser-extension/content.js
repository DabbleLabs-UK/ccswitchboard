// CCswitchboard content script for claude.ai.
//
// Detects Claude's assistant messages as they stream in, and once a
// message is complete, looks for a fenced ```ccsw code block containing a
// JSON job payload and POSTs it to the ccswitchboard relay's job.php.
// Everything else in a message is ignored.

// Guards against running twice on the same page. background.js's
// reinjectClaudeTabs() (see its comment) programmatically re-injects this
// file into every open claude.ai tab right after install/update/reload, in
// addition to the manifest's own content_scripts declaration -- a tab that's
// already running a live instance of this script must not get a second,
// independent copy wired up (duplicate mutation observers, duplicate SW menu
// buttons, duplicate wake listeners, etc.).
if (window.__ccswContentScriptLoaded) {
  console.log('[CCswitchboard] content script already loaded on this page, skipping duplicate injection.');
} else {
  window.__ccswContentScriptLoaded = true;
  ccswInitContentScript();
}

function ccswInitContentScript() {

const SELECTORS = {
  // CONFIRMED live in Brave DevTools:
  // document.querySelectorAll('[aria-label="Give positive feedback"]').length
  // returned 5, matching the number of Claude replies on the page. This is
  // the primary anchor for "this is a Claude message" -- only Claude's
  // messages offer positive feedback, the human's own messages don't. No
  // tag qualifier (an earlier version required `button`, which didn't
  // match the real element -- kept bare on purpose).
  feedbackButton: '[aria-label="Give positive feedback"]',
  // Best-effort only: used to strip action-bar button labels (Copy, Retry,
  // etc.) back out of extracted message text. NOT a hard dependency like
  // feedbackButton -- if this doesn't match anything on the current DOM,
  // extraction still proceeds, just without that cleanup.
  messageActionsGroup: '[role="group"][aria-label="Message actions"]',
};

const CONFIG = {
  // How long a message's text must stay unchanged before we treat it as
  // "done streaming" and act on it. Raise this if fast-but-still-streaming
  // messages get logged/dispatched more than once with growing text.
  STABLE_MS: 600,
  // Debounce window after a burst of DOM mutations before we re-scan.
  DEBOUNCE_MS: 300,
  // Belt-and-braces periodic re-scan in case a mutation is missed (e.g.
  // inside a virtualized list or shadow root the observer doesn't cover).
  FALLBACK_SCAN_MS: 2000,
  // Minimum length for two sibling text blocks to be considered a real
  // duplicate (rather than two coincidentally-identical short strings,
  // e.g. two list items that both just say "Yes").
  MIN_DEDUPE_LEN: 15,
};

// Build stamp -- must match background.js's CCSW_BUILD. Every logged event
// carries it, so a tab still running a pre-update copy of this script (one
// that was never reloaded) shows up in the central debug log stamped with the
// OLD build while background.js's own events carry the new one. That mismatch
// is the tell for a stale tab, which otherwise looks identical to a live one.
const CCSW_BUILD = '20260719-usability-rescue-1';

// Exposes this content script's build to the service worker's stale-tab
// sweep (see background.js's sweepStaleTabs), which probes for this global
// via chrome.scripting.executeScript. A tab still running a pre-reload copy
// of this file either lacks it entirely or carries an older value -- that
// mismatch is what flags the tab as stale.
window.__ccswBuild = CCSW_BUILD;

console.log(`[CCswitchboard] content script loaded on ${location.href} (build ${CCSW_BUILD})`);

// Per-content-script-boot identity: distinguishes two tabs (or two reloads of
// the same tab) that both dispatch pills around the same time, since jobId
// alone doesn't say which content script instance created a given pill.
// Stamped onto every pill_create event (see addJobBar).
const CCSW_PAGE_LOAD_ID = Array.from({ length: 6 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

// Master switch for affordances that only Jody should see. The extension is
// unpacked-loaded per-machine and has no notion of an account, so there is
// nothing to key a real per-user check off -- flipping this to false is the
// way to strip the personal pills out of a copy handed to anyone else.
const CCSW_PERSONAL_FEATURES = true;

// Pasted verbatim into the composer by the "Instruct" personal pill, to prime
// a fresh Claude thread on how to drive CCSW. Kept as a plain const so the
// wording can be edited without touching any of the pill machinery below.
const CCSW_INSTRUCT_TEXT = `You have CCSW (CCSwitchboard) available in this chat. Here is how to use it:

1. RUNNING JOBS ON THE VM: You can emit a fenced code block with language 'ccsw' containing a JSON object, and the CCSW browser extension will pick it up and run it as a job on the VM, returning the result as pasted text in the next message. Two job types:
   - Bash command: {"name":"Short Name","thread":"<thread>","type":"bash","readonly":true,"cwd":"V:/path","command":"...","summary":"one-line preview"}. Use readonly:true for read-only commands (they skip the repo lock). cwd is the working directory on the VM.
   - Claude Code (CC) job: {"name":"Short Name","thread":"<thread>","model":"opus|sonnet","cwd":"V:/path","prompt":"detailed instructions for CC","summary":"one-line preview"}. This dispatches a Claude Code agent to do coding work in that repo.
   Always include a 'summary' field (the pill hovercard previews it) -- keep it to 25 words or less, a terse one-liner, no padding, on every dispatched CC and bash job. Keep prompt blocks reasonably sized; add action-list items as SEPARATE blocks, don't cram an 'actions' array into a big prompt block.

2. THE TODO / ACTION SYSTEM: You can add items to Jody's action list (todos) by emitting {"actions":[{"text":"...","tier":"blocking|recommended|nice_to_have"}]} -- or POST to board/actions.php. Use this for actions JODY needs to take (e.g. 'Reload the extension + F5 all tabs'). Put user-action instructions in the ACTION LIST as specific present-tense items, NOT buried in prose (Jody misses prose instructions). Todos are now per-thread (tabbed [thread]/Global in the todo window). ONLY add a todo when it is actionable RIGHT NOW - e.g. a test Jody should perform, or a reload that is due. Never queue future or speculative steps as todos; future work belongs in the plan block (stage pills), todos are for things awaiting Jody today.

3. ANNOUNCING BATCHES: When you're about to dispatch multiple jobs, briefly tell Jody what the batch is and what each job does, before/as you emit them.

4. UPDATING PROGRESS: As jobs come back (results pasted into the chat), give SHORT progress updates -- what landed, what it means for Jody (plain 'here's what this does for you', not a mechanism dump), and what's next. Don't itemise verbosely.

5. ANNOUNCING THE FINAL STEP: When the work is done, clearly announce the final step / what Jody needs to do to finish (e.g. reload + F5, or verify something), as a distinct call-out (and in the action list if it's a user action).

Work one job at a time for risky changes, verify each before the next, and instrument-before-changing anything that could disrupt running jobs.

6. ONE JOB AT A TIME PER REPO: A repo (e.g. the CCSwitchboard repo) runs ONE job at a time -- dispatching a second job that touches the same repo while one is still running will DROP it as 'repo busy'. So after you emit a job for a repo, treat that repo as occupied until its result comes back (completed/errored/dropped); do NOT fire another repo-touching job for it until then. Track your outstanding jobs and pace them one-at-a-time on the same repo. Only readonly bash jobs skip the lock and can run in parallel.

7. DO NOT NARRATE YOUR TOOL STATE. Never write meta-commentary about your own tool availability or your reasoning about whether you can dispatch -- e.g. do NOT say things like 'my tools this turn are BrainMop-only but I can still emit a ccsw block' or 'the tools are X but that is irrelevant to CCSW'. Emitting a ccsw block is always available regardless of what else is loaded. Just emit the block and give the substantive response; never mention your tool set or the dispatch plumbing. That internal reasoning is noise to the user.

8. USE COMMAND JOBS FOR SIMPLE CHANGES. For a simple mechanical change (a one-line value edit, a string or copy change, a find-replace, a build-stamp bump) use a BASH COMMAND JOB (type:bash with sed or perl + git commit inline), NOT a CC agent job -- a CC job spins up a whole Claude Code instance and burns far more tokens than a one-line edit. Reserve CC for changes needing JUDGEMENT: multi-file logic, understanding context, finding where or how to change something.

9. HOST COMMAND BROKER (VM -> host, allowlisted): The VM can run a FIXED allowlist of host commands via ~/bin/hostcmd (built 10 Jul). Discover: dispatch \`hostcmd list\` on VM CC -> returns action names + param regexes. Always list first. Run: \`hostcmd <action> key=val ...\` (e.g. hostcmd adb-install apk=app-debug.apk). Add a new action = one edit to registry.json, HOST-ONLY (name -> argv template + validate regex). This is a HOST CC job (VM can't build its own cage). Never route around the broker - if an action isn't listed, add it host-side. Broker must be running on the host (autostarts at logon via Task "HostBashBroker"; else double-click broker-hidden.vbs). 30s timeout = not listening. Full detail: BM note 151 (infra), host-broker section.

10. PLAN BLOCKS FOR BATCHES: Before dispatching a multi-stage batch, emit {"thread":"<thread>","plan":[{"name":"Two Words","desc":"what this stage does"},...]} -- this renders the stage pills, one per array entry. RE-EMIT the updated plan EVERY time the queue changes (a stage completes -> drop it from the array or leave it there marked done, new work gets accepted -> append it) so the pill never fossilises into a stale batch. Name each stage EXACTLY like its job's own "name" field (case doesn't matter) so the running stage auto-strikes with a [RUNNING] tag the moment it dispatches, then flips to plain completed once that job finishes. Mark the batch's LAST job with "final":true -- that's the one that gets the popup and the 'all phases complete' voice line; every intermediate job in the batch should only be announced voice-only, no popup.

11. BATCH, DO NOT DRIP-FEED: each one-step job burns a full round-trip (you compose the block, the agent picks it up, runs it, the result lands) before you can fire the next. Judge how to split the work so the WHOLE batch finishes fastest: bundle sequential same-repo steps that need no mid-inspection into ONE larger, well-specified job (a clear big job beats many tiny ones); fire independent readonly checks in PARALLEL (they skip the repo lock); run work on DIFFERENT repos concurrently (separate locks). Reserve the sequential wait-then-decide pattern for a GENUINE dependency where one job result actually shapes the next. The one-non-readonly-job-per-repo rule still holds (a second is dropped), so batching means fewer and bigger jobs plus parallel-where-independent, never two concurrent same-repo jobs.`;

// --- ARRIVAL-NOVELTY instrumentation (observe-only) -------------------------
// Feasibility probe for the send-guard rework. The guard has since been rebuilt
// on durable relay records (see scan()'s eligibility rule) rather than on
// arrival novelty, so nothing here is load-bearing -- but block_arrival is
// retained this stage to cross-check the new rule's dispatch_decision_v2 events
// on live traffic. isInitialScan and seenBlockIdentitiesThisSession exist
// solely to feed this classification and go when it does.
//
// The model this probed assumes claude.ai's virtualized DOM lets us tell three
// cases apart. Nothing acts on that assumption; it only LOGS which case each
// block falls into (block_arrival, emitted from scan()):
//   present_at_load -- found during the initial window => scrollback/history
//   re_seen         -- identity already seen this content-script lifetime
//                      (anchor remount, rescan, scroll re-render)
//   new_arrival     -- first seen AFTER the initial window => genuinely
//                      appeared while live. The only case the fix would act on.
//
// The refutation this is fishing for: if claude.ai lazy-renders OLD scrollback
// as it scrolls into view, those old blocks surface after the initial window
// and land in new_arrival -- which would make the naive model unsafe.
const pageLoadTime = Date.now();

// How long after load a block is still assumed to be pre-existing history
// rather than a live arrival. Closes early on the first real user send, since
// a send proves the tab is live and anything after it is genuinely new.
const CCSW_INITIAL_SCAN_MS = 3000;
let isInitialScan = true;
setTimeout(() => {
  isInitialScan = false;
}, CCSW_INITIAL_SCAN_MS);

// Every block identity (stable fingerprint, or a raw-text hash when the block
// doesn't parse) that scan() has classified so far this content-script
// lifetime. Distinguishes a first sighting from a re-render of something
// already seen. Deliberately NOT persisted: a reload is a new lifetime, and
// "was this here when the page loaded" is exactly what we're measuring.
const seenBlockIdentitiesThisSession = new Set();

// FRESH-NONLAST-SUPPRESSED probe (observe-only). Identities already logged
// as fresh_nonlast_suppressed this page load, so virtualization re-rendering
// the same block doesn't spam the debug ring -- one log per identity per
// lifetime, same pattern as heldBlockKeys.
const freshNonlastSuppressedLogged = new Set();

// --- diagnostic channel --------------------------------------------------
// Fire-and-forget log of extension-side events to debug_log.php's
// debug.log. This content script can't fetch dabblelabs.uk directly (same
// CORS wall the send state machine's own comment in background.js
// describes for every RELAY_* call), so this relays through background.js's
// own ccswDebug() via a plain message; background.js's DEBUG const is the
// single on/off switch, not duplicated here.
function ccswDebug(tag, data) {
  chrome.runtime.sendMessage({ type: 'ccsw-debug-log', tag, data }).catch(() => {});
}

// --- central debug log ------------------------------------------------------
// The structured sibling of ccswDebug above: one typed event per significant
// thing this tab does, funnelled to background.js (the only context that sees
// ALL tabs) and on to debuglog.php. Claude reads it back instead of Jody
// narrating screenshots.
//
// Rules this must never break, since it rides alongside real behaviour:
//   - never throw (the whole body is guarded)
//   - never await / never block a caller
//   - never fire per scan tick -- only on discrete, meaningful events
//
// `threadOverride` is for callers that know the thread before hydration has
// set hydratedThread (i.e. page_load, below); everything else omits it.
function logEvent(type, detail, threadOverride, urgent = false) {
  try {
    // hydratedThread is declared further down with `let`, so a very early
    // caller would hit its temporal dead zone. Read it defensively rather
    // than reordering a load-bearing declaration.
    let thread = threadOverride ?? null;
    if (thread === null) {
      try {
        thread = hydratedThread || null;
      } catch (tdz) {
        thread = null;
      }
    }

    const message = {
      type: 'ccsw-debug-event',
      event: { ts: new Date().toISOString(), build: CCSW_BUILD, thread, type, detail: detail ?? null },
    };
    if (urgent === true) message.urgent = true;

    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (err) {
    // Swallow: a dead extension context (see handlePossibleContextInvalidation)
    // must not take a real code path down with it just because it was logging.
  }
}

// The page_load event itself is emitted further down, right after
// loadUrlThread() is defined -- it needs that function to resolve this tab's
// thread, and calling it from up here would hit URL_THREAD_STORAGE_KEY's
// temporal dead zone, which loadUrlThread's own catch would quietly swallow
// into a thread=null event plus a misleading console warning.

// jobId -> last logged lifecycle state, for the transition log below.
// Covers the slice of the JOB PILL lifecycle
// (dispatched -> running -> output -> result-landed -> marked-done ->
// spinner-clear) this content script can observe directly; background.js
// tracks its own slice (dispatched/running/marked-done) with an identical
// helper, since the two contexts see different events for the same job.
const pillLifecycleState = new Map();

function logPillTransition(jobId, thread, newState) {
  const oldState = pillLifecycleState.get(jobId) ?? null;
  if (oldState === newState) return;
  pillLifecycleState.set(jobId, newState);
  ccswDebug('pill-lifecycle', { jobId, thread, oldState, newState });
}

// Per-message state, keyed by the anchor (feedback button) element itself --
// it persists in the DOM for the lifetime of that message turn, so this is
// stable across scans without ever caching a reference to a container we
// computed once. Garbage-collected automatically once React unmounts it.
const seen = new WeakMap();

function preview(text, len = 60) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > len ? oneLine.slice(0, len) + '...' : oneLine;
}

// Given a feedback-button anchor, find the smallest ancestor that contains
// exactly that one message turn and nothing from neighboring turns. Walks
// up until climbing one more level would start including a second message
// turn boundary, meaning we've overshot into the shared list wrapper.
//
// Prefer messageActionsGroup as the boundary marker over feedbackButton:
// it exists once per turn REGARDLESS of sender (human or assistant), so it
// still catches the boundary for the newest message in a conversation,
// which has no later assistant turn yet to serve as a second feedbackButton
// to detect against (feedbackButton-only counting was confirmed via a
// jsdom test to over-climb past the assistant turn and merge in the
// preceding human turn's text in exactly that situation). Falls back to
// feedbackButton counting if messageActionsGroup doesn't match this DOM at
// all (it's a best-effort selector, not guaranteed).
function findMessageTurnContainer(anchor) {
  const hasGroups = document.querySelectorAll(SELECTORS.messageActionsGroup).length > 0;
  const boundarySelector = hasGroups ? SELECTORS.messageActionsGroup : SELECTORS.feedbackButton;

  let tight = anchor;
  let candidate = anchor.parentElement;
  while (candidate && candidate !== document.body) {
    if (candidate.querySelectorAll(boundarySelector).length > 1) break;
    tight = candidate;
    candidate = candidate.parentElement;
  }
  return tight;
}

// Claude's DOM sometimes contains more than one element with the exact
// same rendered text for a single message turn (observed: messages were
// captured doubled, e.g. "X X"). Recursively drop any element whose full
// text exactly duplicates an earlier sibling's, at every level of the
// tree, so each real piece of content is only counted once. Comparisons
// use whitespace-normalized text (collapsing runs of whitespace and
// trimming) rather than raw text, since the two copies aren't guaranteed
// to be byte-identical -- observed in practice to differ in incidental
// whitespace even when the visible content is the same. Guarded by
// MIN_DEDUPE_LEN so short coincidental matches (two list items that both
// just say "Yes") aren't treated as duplicates.
function normalizeForCompare(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function dedupeSiblingText(node) {
  const seenNormalized = new Set();
  Array.from(node.children).forEach((child) => {
    const normalized = normalizeForCompare(child.textContent ?? '');
    if (normalized.length >= CONFIG.MIN_DEDUPE_LEN) {
      if (seenNormalized.has(normalized)) {
        child.remove();
        return; // removed -- nothing left to recurse into
      }
      seenNormalized.add(normalized);
    }
    dedupeSiblingText(child);
  });
}

// Defensive backstop for whole-message duplication that dedupeSiblingText's
// sibling-only tree walk doesn't structurally catch (e.g. the duplicate
// isn't a sibling of the original at all, just somewhere else under the
// same container). Rather than requiring the string to split into two
// byte-identical halves (too strict -- broke on real messages that were
// still logged doubled), this searches for where the message's own
// opening text re-occurs later in the string, accepts it only if that
// split point falls near the middle (a short coincidental repeat deep
// inside an otherwise-unique long message shouldn't collapse it), and
// compares the two resulting halves with the same whitespace-normalized
// equality dedupeSiblingText uses.
function collapseExactDuplicate(text) {
  const len = text.length;
  if (len < CONFIG.MIN_DEDUPE_LEN * 2) return text;

  const probeLen = Math.min(40, Math.floor(len / 2));
  const probe = text.slice(0, probeLen);
  const splitAt = text.indexOf(probe, probeLen);
  if (splitAt === -1) return text;
  if (Math.abs(splitAt - len / 2) > Math.max(10, len * 0.1)) return text;

  const first = text.slice(0, splitAt).trim();
  const second = text.slice(splitAt).trim();
  if (first.length >= CONFIG.MIN_DEDUPE_LEN && normalizeForCompare(first) === normalizeForCompare(second)) {
    console.log(`[CCswitchboard] collapsed duplicated text (${len} chars -> ${first.length} chars).`);
    return first;
  }
  return text;
}

// claude.ai appends a relative "sent" timestamp to a message turn ("just now",
// "4 minutes ago", "yesterday", ...). It is NOT inside messageActionsGroup, so
// the strip above leaves it in the captured text, where it causes two problems:
// (1) it TICKS -- "4 minutes ago" -> "5 minutes ago" -- so the captured text
// changes every minute, resetting the stability gate and re-firing "Completed
// assistant message" for a settled message forever; and (2) a single trailing
// timestamp pushes the midpoint of a genuinely-doubled message off-centre, so
// collapseExactDuplicate's near-the-middle split check rejects the collapse and
// the message is captured doubled. Stripping a trailing relative-time phrase
// before the collapse fixes both. Conservative: anchored to the very end, only
// the recognised relative-time shapes, so real prose is left untouched.
const TRAILING_RELATIVE_TIME_RE =
  /\s*(?:just now|(?:a|an|\d+)\s+(?:second|minute|hour|day|week|month|year)s?\s+ago|yesterday)\s*$/i;

function stripTrailingRelativeTimestamp(text) {
  return text.replace(TRAILING_RELATIVE_TIME_RE, '').trimEnd();
}

// Text of a message turn, with its own action bar (Copy/Retry/feedback
// button labels etc.) stripped out, duplicate sub-trees collapsed, so only
// one copy of the rendered prose remains.
function extractMessageText(container) {
  const clone = container.cloneNode(true);
  clone.querySelectorAll(SELECTORS.messageActionsGroup).forEach((el) => el.remove());
  // Strip in-message cards (job/action/plan -- see decorateCcswJobCards) so
  // their name/summary/chip/list text can never perturb the captured message
  // text or the stability gate. The raw <pre> each card fronts is NOT removed --
  // it stays in the clone, display:none but textContent-visible, exactly as the
  // un-carded pre did, so the captured text is identical whether cards are on or
  // off.
  clone.querySelectorAll('.ccsw-job-card, .ccsw-action-card, .ccsw-plan-card').forEach((el) => el.remove());
  // Strip claude.ai's own code-block language label ('ccsw', or whatever
  // decorateCcswJobCards rewrote it to). Removing this CONSTANT chrome makes the
  // captured text independent of the label's live value, so the Part-1 label
  // rewrite ('ccsw' -> 'CCSW job dispatch'/etc.) can never move the stability
  // gate. It's a fixed token either way, so its removal never destabilizes.
  // (Runs AFTER the card strip above so a card title that shares a rewritten
  // label's text is already gone and is never mistaken for a header label.)
  stripCcswLangLabels(clone);
  dedupeSiblingText(clone);
  const text = stripTrailingRelativeTimestamp((clone.textContent ?? '').trim());
  return collapseExactDuplicate(text);
}

// Looks for a fenced code block tagged `ccsw` within a message turn's
// container. Markdown renderers commonly class the <code> element (or a
// wrapping <pre>) by the fence's info-string (e.g. "language-ccsw"), which
// is tried first; a raw-text regex over the container's textContent is the
// fallback in case that doesn't match this DOM's actual class convention,
// or the block otherwise appears unrendered.
function findCcswBlocks(container) {
  const blocks = [];

  container.querySelectorAll('code').forEach((codeEl) => {
    const cls = codeEl.className || '';
    const pre = codeEl.closest('pre');
    const dataLang = codeEl.getAttribute('data-language') || pre?.getAttribute('data-language') || '';
    if (/(^|[\s-])ccsw(?=$|[\s-])/i.test(cls) || /ccsw/i.test(dataLang)) {
      const text = codeEl.textContent ?? '';
      if (text.trim()) blocks.push(text);
    }
  });

  if (blocks.length === 0) {
    const raw = container.textContent ?? '';
    const re = /```ccsw\s*\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m[1].trim()) blocks.push(m[1]);
    }
  }

  // The same doubled-DOM issue extractMessageText guards against can also
  // duplicate a code block itself -- collapse identical block text so the
  // caller's dispatch dedup isn't doing that work redundantly per call.
  return [...new Set(blocks)];
}

// True the moment a ```ccsw fence has started rendering -- either the
// markdown renderer has already tagged a <code> element with the ccsw
// language (common even before the block is complete, e.g. live-highlighted
// code blocks), or the fence is still raw, unrendered text (the state a
// fence is in for the first instant it streams in, before the renderer has
// recognised it as a code block at all). Deliberately looser than
// findCcswBlocks -- that one needs a usable block (a closing fence, or a
// non-empty tagged element); this just needs to know a ```ccsw fence has
// started at all, complete or not, so the ghost pill (see createGhostBar)
// can appear the instant it does.
function hasCcswOpeningFence(container) {
  for (const codeEl of container.querySelectorAll('code')) {
    const cls = codeEl.className || '';
    const pre = codeEl.closest('pre');
    const dataLang = codeEl.getAttribute('data-language') || pre?.getAttribute('data-language') || '';
    if (/(^|[\s-])ccsw(?=$|[\s-])/i.test(cls) || /ccsw/i.test(dataLang)) return true;
  }
  return /```ccsw(?:[ \t]|\r?\n|$)/i.test(container.textContent ?? '');
}

// GHOST OWNERSHIP (bug #29 -- orphaned "detecting..." pill).
//
// createGhostBar appends the pill into getToolbarContainer(), a PAGE-LEVEL
// container that outlives any single message. The only handle to it, though,
// used to be `state.ghostEl` inside `seen` -- a WeakMap keyed by the ANCHOR
// element. claude.ai virtualizes the transcript and unmounts/recreates anchors
// (the same fact scan()'s held-pill pileup fix turns on). When an anchor
// holding a live ghost was recycled, its WeakMap entry -- and with it the ONLY
// reference to that ghost -- was garbage collected, stranding a "detecting..."
// pill in the toolbar that NO code path could ever reach again. It has no
// click handler and no job id, so it just sits there doing nothing, and the
// same transient re-creates it on the next page load, which is why it appears
// to survive F5.
//
// This registry is a second, strong, scan-reachable handle on every live
// ghost, so sweepGhosts() below can always find one whose owner has gone away.
// It is the reason it is now impossible to leave a ghost undisposed: no matter
// which branch of the dispatch decision returns, an unclaimed ghost is still
// reachable from here and gets reaped.
const liveGhosts = new Map(); // ghostEl -> { anchor, createdAt, context }

// A ghost is a TRANSIENT indicator: it lives from the instant a ```ccsw fence
// starts streaming until the block it belongs to dispatches, is held, is
// dropped (all three morph it in place) or turns out to be nothing (disposed).
// No legitimate ghost lives anywhere near this long -- a block that streams for
// two minutes has bigger problems -- so anything still registered past this is
// a leak by definition, and reaping it beats leaving it on screen forever.
const GHOST_MAX_MS = 120000;

// Placeholder pill shown the instant hasCcswOpeningFence fires, before the
// block is complete enough to dispatch -- same markup/classes as a real
// collapsed job bar (see addJobBar) so it picks up identical styling from
// content.css, just with a "detecting..." label instead of a job name and
// no click/close behavior yet (there's no job id to attach it to). Morphed
// into the real pill in place by addJobBar's ghostEl param once the block
// dispatches, or torn down by removeGhostBar if it never resolves into one.
//
// PROTOTYPE (look test): the extension-bundled logo, rotated via CSS as the
// running-job indicator inside every .ccsw-spinner span (pill when collapsed,
// terminal-box title when expanded -- same headerEl either way). Built once
// since chrome.runtime.getURL's result never changes across pills. Hidden
// again by content.css for every non-running state (terminal/waiting/dropped/
// held-for-send/pending-*), which keep the old solid-dot/ring look.
const CCSW_SPINNER_LOGO_URL = chrome.runtime.getURL('logo-32.png');

function ensureSpinnerLogo(spinnerEl) {
  if (spinnerEl.querySelector('.ccsw-spinner-logo')) return;
  const logoEl = document.createElement('img');
  logoEl.className = 'ccsw-spinner-logo';
  logoEl.src = CCSW_SPINNER_LOGO_URL;
  logoEl.alt = '';
  spinnerEl.appendChild(logoEl);
}

// --- IN-MESSAGE JOB CARDS ----------------------------------------------------
//
// When an assistant message contains a fenced ccsw code block that parses as a
// dispatchable JOB (a bash job -- type:"bash" + command; or a CC job -- prompt,
// no type), the raw <pre> is hidden (a display:none CSS class, .ccsw-carded --
// the code element's textContent stays LIVE for the scanner/dispatcher, the DOM
// is never removed or mutated) and a compact status card is rendered in its
// place: a live-status icon on the LEFT, the job name + summary + model/readonly
// chips on the RIGHT. The card's text is stripped from extractMessageText's
// clone (see there) so it can never perturb the captured message text or the
// stability gate; the raw pre, display:none but textContent-visible, stays in
// that clone exactly as the un-carded pre did, so captured text is unchanged.
//
// Everything here is presentational. It NEVER touches dispatch/dedup logic and
// NEVER mutates findCcswBlocks' input in a way that changes what it extracts
// (it only adds a display:none class to the pre and inserts a sibling card;
// findCcswBlocks short-circuits on the tagged <code> element and never reaches
// its container.textContent fallback, and the card carries no ```ccsw fence).
// decorateCcswJobCards wraps every block in its own try/catch and the scan-site
// call is wrapped again, so a throw here can never break the dispatch scan.

// Recorded at dispatch (dispatchCcswBlock's ok-path): the block's stableKey ->
// its live job. This is how a card correlates to the pill machinery so its icon
// tracks the real job state (running -> done/error/...). lastState caches the
// last-derived state so a card still reads correctly after its toolbar pill has
// auto-expired out of activeToolbarJobs (terminal jobs age out after ~3 min).
const ccswCardJobIndex = new Map(); // stableKey -> { jobId, lastState }

// Strong pre-element -> card-element link. A WeakMap keyed by the live <pre>
// node survives claude.ai's virtual-DOM churn cleanly: the same pre always maps
// to the same card, and when React recreates the pre (a new node, hence a new
// key) the old pre + its card fall out of the tree and are GC'd together.
const ccswCardForPre = new WeakMap();

// A streaming block isn't valid JSON yet, so it can't be classified -- only card
// one that already looks job-shaped, so a plan/actions/debuglog block never gets
// a card even mid-stream. Matched against the raw (pre-parse) block text.
const CCSW_CARD_JOB_SIGNAL_RE = /"(?:prompt|command)"\s*:/;

// Classify a PARSED ccsw block as a card-worthy job, mirroring the shapes the
// dispatcher recognises: a bash job is type:"bash" with a string command; a CC
// job has a string prompt and no type. Anything else (plan-only, actions,
// debuglog, malformed) returns null and is NOT carded. Returns the display
// pieces the card needs: name (RAW name, 'Job' fallback), summary, and chips.
function classifyCcswJobForCard(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const type = typeof parsed.type === 'string' ? parsed.type.toLowerCase() : '';
  const name = (typeof parsed.name === 'string' && parsed.name.trim()) || 'Job';
  const summary = (typeof parsed.summary === 'string' && parsed.summary) || '';

  if (type === 'bash') {
    if (typeof parsed.command !== 'string') return null;
    const chips = parsed.readonly === true ? [{ text: 'readonly', kind: 'readonly' }] : [];
    return { kind: 'bash', name, summary, chips };
  }
  if (!type && typeof parsed.prompt === 'string') {
    const chips = [];
    if (typeof parsed.model === 'string' && parsed.model) chips.push({ text: parsed.model, kind: 'model' });
    return { kind: 'cc', name, summary, chips };
  }
  return null;
}

// Live-status of a job's toolbar pill, collapsed to the card's state vocabulary.
// ccswPillStateFromBarEl reads the pill's own state classes; the amber 'waiting'
// overlay (output-pending) lives only as a separate class, so it's read here too.
function ccswCardStateFromEntry(entry) {
  const barEl = entry && entry.barEl;
  if (!barEl) return 'running';
  const st = ccswPillStateFromBarEl(barEl);
  if (st === 'done') return 'done';
  if (st === 'error') return 'error';
  if (st === 'cancelled') return 'cancelled';
  if (st === 'stale') return 'stale';
  if (st === 'dropped') return 'dropped';
  if (st === 'held' || st === 'parked') return 'held';
  if (st === 'pending-delivery') return 'waiting';
  if (barEl.classList.contains('ccsw-job-bar--waiting')) return 'waiting';
  return 'running';
}

// Find the toolbar entry a block's stableKey belongs to. Dispatched jobs are
// found through ccswCardJobIndex (recorded at dispatch); dropped pills carry
// their own entry.stableKey; held pills carry entry.blockText, from which their
// key is recomputed the same way the dispatcher does.
function ccswCardResolveEntry(stableKey) {
  if (!stableKey) return null;
  const rec = ccswCardJobIndex.get(stableKey);
  if (rec) {
    const e = activeToolbarJobs.get(rec.jobId);
    if (e) return e;
  }
  for (const [, e] of activeToolbarJobs) {
    if (e.stableKey && e.stableKey === stableKey) return e; // dropped
    if (e.held && e.blockText) {
      let hk = null;
      try {
        const hp = JSON.parse(e.blockText);
        if (hp && typeof hp === 'object') hk = fingerprintBlockStable(hp.thread, hp);
      } catch { /* held block that never parsed -- no key to match */ }
      if (hk && hk === stableKey) return e;
    }
  }
  return null;
}

// The card's live icon state for a valid job block. A tracked pill drives it;
// a job with no tracked pill yet reads 'untracked' (neutral spinning logo); a
// job whose pill has since expired falls back to its last-derived state, so a
// finished job's card stays green/red rather than reverting to a spinner.
function ccswCardDeriveState(stableKey) {
  const entry = ccswCardResolveEntry(stableKey);
  if (entry && entry.barEl && entry.barEl.isConnected) {
    const st = ccswCardStateFromEntry(entry);
    const rec = stableKey ? ccswCardJobIndex.get(stableKey) : null;
    if (rec) rec.lastState = st;
    return st;
  }
  const rec = stableKey ? ccswCardJobIndex.get(stableKey) : null;
  if (rec && rec.lastState) return rec.lastState;
  return 'untracked';
}

// Rebuild the chip row only when its contents actually change (data-sig guard),
// so a per-scan re-decorate doesn't churn the DOM every tick.
function renderCcswCardChips(chipsEl, chips) {
  const sig = chips.map((c) => `${c.kind}:${c.text}`).join('|');
  if (chipsEl.dataset.ccswChipSig === sig) return;
  chipsEl.dataset.ccswChipSig = sig;
  chipsEl.replaceChildren(
    ...chips.map((c) => {
      const s = document.createElement('span');
      s.className = `ccsw-job-card-chip ccsw-job-card-chip--${c.kind}`;
      s.textContent = c.text;
      return s;
    })
  );
  chipsEl.style.display = chips.length ? '' : 'none';
}

// Create the card for `pre` if absent (linked via ccswCardForPre), else update
// it in place. Idempotent: safe to call on every scan. `state` drives the LEFT
// icon; the spinning logo is only present for the two spinning states, replaced
// by a coloured dot/ring for every other state (mirrors the toolbar pill's own
// spinner-logo-hide-on-terminal behaviour).
function buildCcswJobCard(pre, { state, name, summary, chips }) {
  pre.classList.add('ccsw-carded');

  let card = ccswCardForPre.get(pre);
  if (!card || !card.isConnected || card.dataset.ccswCardKind !== 'job') {
    // A pre that previously carried an action/plan card (block was edited/
    // re-typed) drops that card first so the correct kind is rebuilt cleanly.
    if (card && card.isConnected) card.remove();
    card = document.createElement('div');
    card.className = 'ccsw-job-card';
    card.dataset.ccswCardKind = 'job';

    const icon = document.createElement('span');
    icon.className = 'ccsw-job-card-icon';

    const body = document.createElement('div');
    body.className = 'ccsw-job-card-body';

    const nameEl = document.createElement('div');
    nameEl.className = 'ccsw-job-card-name';

    const summaryEl = document.createElement('div');
    summaryEl.className = 'ccsw-job-card-summary';

    const chipsEl = document.createElement('div');
    chipsEl.className = 'ccsw-job-card-chips';

    body.append(nameEl, summaryEl, chipsEl);
    card.append(icon, body);
    pre.insertAdjacentElement('afterend', card);
    ccswCardForPre.set(pre, card);
  }

  const icon = card.querySelector('.ccsw-job-card-icon');
  const nameEl = card.querySelector('.ccsw-job-card-name');
  const summaryEl = card.querySelector('.ccsw-job-card-summary');
  const chipsEl = card.querySelector('.ccsw-job-card-chips');

  card.className = `ccsw-job-card ccsw-job-card--${state}`;
  icon.className = `ccsw-job-card-icon ccsw-job-card-icon--${state}`;
  if (state === 'running' || state === 'untracked') {
    ensureSpinnerLogo(icon);
  } else {
    const logo = icon.querySelector('.ccsw-spinner-logo');
    if (logo) logo.remove();
  }

  if (nameEl.textContent !== name) nameEl.textContent = name;
  if (summaryEl.textContent !== (summary || '')) summaryEl.textContent = summary || '';
  summaryEl.style.display = summary ? '' : 'none';
  renderCcswCardChips(chipsEl, chips || []);
}

// Undo carding for a `pre` that is no longer (or never was) a job block --
// unhide it and drop any card. Idempotent.
function clearCcswJobCard(pre) {
  pre.classList.remove('ccsw-carded');
  const card = ccswCardForPre.get(pre);
  if (card) {
    if (card.isConnected) card.remove();
    ccswCardForPre.delete(pre);
  }
}

// --- IN-MESSAGE ACTION + PLAN CARDS ------------------------------------------
//
// The friendly-card treatment (job cards above) extended to two more ccsw block
// types. An ACTION block ({"actions":[{text,tier},...]}) renders a title row
// plus one badge+text row per item; a PLAN block ({"plan":[...]}) renders a
// title row plus a numbered list of stage names. Both hide the raw <pre> via
// the same .ccsw-carded mechanism (the pre's DOM/textContent stays LIVE for the
// scanner) and are stripped from extractMessageText's clone (see there), so the
// captured message text is unchanged whether cards are on or off. Everything
// here is presentational -- no dispatch/dedup/scan logic is touched. Each card
// element is tagged data-ccsw-card-kind so buildCcswJobCard/Action/Plan can
// swap a pre's card cleanly if the block is edited into a different type.

// The header-label texts findCcswLangLabel recognises: claude.ai's raw fence
// language ('ccsw') plus every value Part 1's rewrite can leave behind. Matching
// the rewritten values too lets a re-typed block's label be corrected in place,
// and lets extractMessageText strip the label regardless of its live state.
const CCSW_LANG_LABELS = new Set([
  'ccsw',
  'ccsw job dispatch',
  'ccsw todo update',
  'ccsw plan update',
]);

// Human tier labels for an action card's badge (self-contained copy of the
// toolbar's ACTION_TIER_LABELS so this presentational block has no ordering dep
// on that later const).
const CCSW_ACTION_TIER_LABEL = { blocking: 'Blocking', recommended: 'Recommended', nice_to_have: 'Nice to have' };

// Locate claude.ai's small code-block header label for a given block's <pre> --
// the leaf element whose trimmed, case-insensitive textContent is exactly 'ccsw'
// (or an already-rewritten CCSW label). Walks UP from the pre a few levels and
// returns the FIRST match found at the lowest ancestor that has one -- i.e. the
// block's own code-block wrapper, which contains only this block, so a label is
// never picked up from an adjacent ccsw block. Skips anything inside the pre
// (its highlighted JSON) and anything inside one of our own cards (whose title
// text can coincide with a rewritten label). Returns null if no label is
// present. Never throws.
function findCcswLangLabel(pre) {
  let node = pre;
  for (let up = 0; up < 4 && node.parentElement; up++) {
    node = node.parentElement;
    const els = node.querySelectorAll('*');
    for (const el of els) {
      if (el.children.length !== 0) continue; // leaf elements only
      if (pre.contains(el)) continue; // never the code content itself
      if (el.closest('.ccsw-job-card, .ccsw-action-card, .ccsw-plan-card')) continue;
      const t = (el.textContent || '').trim().toLowerCase();
      if (CCSW_LANG_LABELS.has(t)) return el;
    }
  }
  return null;
}

// PART 1: rewrite a ccsw block's header language label to a friendly, type-aware
// text. Idempotent and self-guarding -- findCcswLangLabel only returns a known
// label element, and the equality check skips a no-op write, so repeat scans
// never re-write endlessly. Cosmetic: wrapped so a failure can never break the
// decorate pass. Leaves the label untouched for any block type not passed here.
function rewriteCcswLangLabel(pre, label) {
  try {
    const el = findCcswLangLabel(pre);
    if (!el) return;
    if (el.textContent === label) return;
    el.textContent = label;
  } catch { /* label rewrite is cosmetic -- never propagate */ }
}

// Remove the code-block language label from a DETACHED clone (extractMessageText)
// for every ccsw block, so the label's value can't perturb captured text. Only
// touches the clone; the live page's label is unaffected.
function stripCcswLangLabels(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    const codeEl = pre.querySelector('code');
    if (!codeEl) return;
    const cls = codeEl.className || '';
    const dataLang = codeEl.getAttribute('data-language') || pre.getAttribute('data-language') || '';
    if (!(/(^|[\s-])ccsw(?=$|[\s-])/i.test(cls) || /ccsw/i.test(dataLang))) return;
    const labelEl = findCcswLangLabel(pre);
    if (labelEl) labelEl.remove();
  });
}

// Create/refresh the ACTION card for `pre`. `actions` is the same {text,tier}
// list the dispatcher validates. Idempotent: safe every scan (the item rows are
// rebuilt only when their signature changes).
function buildCcswActionCard(pre, actions) {
  pre.classList.add('ccsw-carded');

  let card = ccswCardForPre.get(pre);
  if (!card || !card.isConnected || card.dataset.ccswCardKind !== 'action') {
    if (card && card.isConnected) card.remove();
    card = document.createElement('div');
    card.className = 'ccsw-action-card';
    card.dataset.ccswCardKind = 'action';

    const titleEl = document.createElement('div');
    titleEl.className = 'ccsw-card-title';
    titleEl.textContent = 'CCSW todo update';

    const listEl = document.createElement('div');
    listEl.className = 'ccsw-action-card-list';

    card.append(titleEl, listEl);
    pre.insertAdjacentElement('afterend', card);
    ccswCardForPre.set(pre, card);
  }

  const listEl = card.querySelector('.ccsw-action-card-list');
  const sig = actions.map((a) => `${a.tier}${a.text}`).join('');
  if (listEl.dataset.ccswSig === sig) return;
  listEl.dataset.ccswSig = sig;
  listEl.replaceChildren(
    ...actions.map((a) => {
      const row = document.createElement('div');
      row.className = 'ccsw-action-card-row';

      const badge = document.createElement('span');
      badge.className = `ccsw-action-card-badge ccsw-action-card-badge--${a.tier}`;
      badge.textContent = CCSW_ACTION_TIER_LABEL[a.tier] || a.tier;

      const textEl = document.createElement('span');
      textEl.className = 'ccsw-action-card-text';
      textEl.textContent = a.text;

      row.append(badge, textEl);
      return row;
    })
  );
}

// Create/refresh the PLAN card for `pre`. `stages` is a normalizePlanStageEntry
// list ({name, desc}). Idempotent: rows are rebuilt only when the plan changes.
function buildCcswPlanCard(pre, stages) {
  pre.classList.add('ccsw-carded');

  let card = ccswCardForPre.get(pre);
  if (!card || !card.isConnected || card.dataset.ccswCardKind !== 'plan') {
    if (card && card.isConnected) card.remove();
    card = document.createElement('div');
    card.className = 'ccsw-plan-card';
    card.dataset.ccswCardKind = 'plan';

    const titleEl = document.createElement('div');
    titleEl.className = 'ccsw-card-title';
    titleEl.textContent = 'CCSW plan update';

    const listEl = document.createElement('ol');
    listEl.className = 'ccsw-plan-card-list';

    card.append(titleEl, listEl);
    pre.insertAdjacentElement('afterend', card);
    ccswCardForPre.set(pre, card);
  }

  const listEl = card.querySelector('.ccsw-plan-card-list');
  const sig = stages.map((s) => `${s.name}${s.desc || ''}`).join('');
  if (listEl.dataset.ccswSig === sig) return;
  listEl.dataset.ccswSig = sig;
  listEl.replaceChildren(
    ...stages.map((s) => {
      const li = document.createElement('li');
      li.className = 'ccsw-plan-card-stage';
      li.textContent = s.name;
      if (s.desc) li.title = s.desc;
      return li;
    })
  );
}

// Walk a message container's ccsw code blocks and card each dispatchable job.
// Exception-safe per block (a throw on one block never stops the others, and
// never propagates to the scan). Mirrors findCcswBlocks' element selector so it
// only ever acts on genuine ccsw blocks.
function decorateCcswJobCards(container) {
  container.querySelectorAll('code').forEach((codeEl) => {
    try {
      const cls = codeEl.className || '';
      const pre = codeEl.closest('pre');
      if (!pre) return;
      const dataLang = codeEl.getAttribute('data-language') || pre.getAttribute('data-language') || '';
      const isCcsw = /(^|[\s-])ccsw(?=$|[\s-])/i.test(cls) || /ccsw/i.test(dataLang);
      if (!isCcsw) return;

      const raw = codeEl.textContent ?? '';
      let parsed = null;
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        // Still streaming, or never valid JSON.
      }

      if (parsed === null) {
        // Not parseable yet: show the streaming (blue) shell ONLY if the partial
        // text already looks job-shaped, so plan/actions blocks stay un-carded.
        if (CCSW_CARD_JOB_SIGNAL_RE.test(raw)) {
          rewriteCcswLangLabel(pre, 'CCSW job dispatch');
          buildCcswJobCard(pre, { state: 'streaming', name: recoverCcswBlockName(raw) || 'Job', summary: '', chips: [] });
        } else {
          clearCcswJobCard(pre);
        }
        return;
      }

      // JOB block (bash/CC): friendly label + live-status job card.
      const job = classifyCcswJobForCard(parsed);
      if (job) {
        rewriteCcswLangLabel(pre, 'CCSW job dispatch');
        const stableKey = fingerprintBlockStable(parsed.thread, parsed);
        const state = ccswCardDeriveState(stableKey);
        buildCcswJobCard(pre, { state, name: job.name, summary: job.summary, chips: job.chips });
        return;
      }

      // ACTION block: {"actions":[{text,tier},...]}. Same valid-item filter the
      // dispatcher applies (see the actions handler in the dispatch scan); only
      // card when at least one valid {text,tier} item is present.
      const validActions = Array.isArray(parsed.actions)
        ? parsed.actions.filter(
            (a) => a && typeof a.text === 'string' && a.text.trim() !== '' && ['blocking', 'recommended', 'nice_to_have'].includes(a.tier)
          )
        : [];
      if (validActions.length > 0) {
        rewriteCcswLangLabel(pre, 'CCSW todo update');
        buildCcswActionCard(pre, validActions);
        return;
      }

      // PLAN block: {"plan":[...]} -- each stage a string or {name,desc} (see
      // normalizePlanStageEntry); only card when at least one stage normalizes.
      const stages = Array.isArray(parsed.plan)
        ? parsed.plan.map(normalizePlanStageEntry).filter(Boolean)
        : [];
      if (stages.length > 0) {
        rewriteCcswLangLabel(pre, 'CCSW plan update');
        buildCcswPlanCard(pre, stages);
        return;
      }

      // Anything else (debuglog-only, unrecognized): no card, label untouched.
      clearCcswJobCard(pre);
    } catch {
      // Per-block fail-safe -- a broken block must never abort the decorate pass
      // or, via the scan-site guard, the dispatch scan.
    }
  });
}

// `anchor` is the message anchor this ghost belongs to -- recorded so
// sweepGhosts can tell a ghost whose message got virtualized away from one
// that's still legitimately waiting on a streaming block. `context` is a
// human label for the ghost_create/ghost_dispose log pair.
function createGhostBar(anchor, context) {
  const barEl = document.createElement('div');
  barEl.className = 'ccsw-job-bar ccsw-job-bar--ghost';

  const headerEl = document.createElement('div');
  headerEl.className = 'ccsw-job-bar-header';

  const spinnerEl = document.createElement('span');
  spinnerEl.className = 'ccsw-spinner';
  ensureSpinnerLogo(spinnerEl);

  const idEl = document.createElement('span');
  idEl.className = 'ccsw-job-bar-id';
  idEl.textContent = 'detecting...';

  headerEl.append(spinnerEl, idEl);
  barEl.appendChild(headerEl);
  getToolbarContainer().appendChild(barEl);

  liveGhosts.set(barEl, { anchor: anchor ?? null, createdAt: Date.now(), context: context ?? null });
  // tabId is stamped on by background.js's debug-event listener. A ghost_create
  // with no matching ghost_dispose IS the bug, and now says so in the log.
  logEvent('ghost_create', { context: context ?? null, liveGhosts: liveGhosts.size });
  return barEl;
}

// Deregisters a ghost WITHOUT touching the DOM -- for the three sites that
// MORPH the node in place into a real/held/dropped pill (addJobBar,
// showHeldForSendBar, showDroppedJobBar). The element lives on; it just stops
// being a ghost, so sweepGhosts must no longer reap it. A no-op for a node
// that was never registered or has already been disposed, so it is safe to
// call from a morph site that may or may not have been handed a live ghost.
function releaseGhostBar(ghostEl, reason) {
  if (!ghostEl || !liveGhosts.has(ghostEl)) return;
  liveGhosts.delete(ghostEl);
  logEvent('ghost_dispose', { reason, liveGhosts: liveGhosts.size });
}

// Tears down a ghost pill that never turned into a real job -- the block it
// was waiting on turned out malformed/unparseable, was already dispatched, is
// ancient scrollback, got held, dispatch failed, or listening was switched off
// before it resolved. Safe to call more than once (e.g. via a stale reference)
// since isConnected is false after the first removal and the registry entry is
// gone. `reason` is what the ghost_dispose log line reports.
function removeGhostBar(ghostEl, reason = 'unspecified') {
  if (!ghostEl) return;
  releaseGhostBar(ghostEl, reason);
  if (ghostEl.isConnected) ghostEl.remove();
}

// Best-effort recovery of a ccsw block's name from text that FAILED to parse as
// JSON -- so a broken block's error bar can still say WHICH block it was. Pure
// regex, no parsing: pull the first "name": "..." pair (the block's own name
// field), tolerating single OR double quotes and the sanitized/raw form alike.
// Returns a trimmed, length-capped string or null when nothing name-like is
// present. Never throws -- a null just means the error bar shows no block name.
function recoverCcswBlockName(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/["'“‘]name["'”’]\s*:\s*["'“‘]([^"'”’\n]{1,80})/);
  if (!m) return null;
  const name = m[1].trim();
  return name === '' ? null : name;
}

// Turns the ghost pill for an UNPARSEABLE ccsw block into a persistent, red
// error state instead of silently tearing it down (the old behaviour: a
// console.warn + removeGhostBar, so a malformed block vanished with no on-screen
// trace -- exactly the thing the user needs to notice). Reuses the same red
// --error styling a job-reported failure gets (red spinner dot + '!' badge) plus
// a --terminal cap so nothing keeps spinning. The bar PERSISTS until the user
// clicks its corner × -- there is no auto-clear timer, because the whole point
// is that a broken block must not disappear unnoticed. Not registered in
// liveGhosts (it is a finished, non-claimable node) nor activeToolbarJobs
// (there is no job id) -- dismissal just removes the DOM node.
//
// `info` = { anchorIndex, error, foundClasses, name, selfHealAttempts }:
// `error` is the parser's actual message (from parseCcswBlockText),
// `foundClasses` the safe auto-fixes that were attempted, `name` the block name
// recovered from the raw text if any, and `selfHealAttempts` the number of
// self-heal feedback rounds already spent on this block (0 when the self-heal
// flag is off or nothing was tried). A non-zero value means we only fell back
// to this red ghost AFTER self-heal was exhausted, so the bar says so.
function showInvalidBlockBar(ghostEl, info = {}) {
  const reuseGhost = !!ghostEl?.isConnected;
  if (reuseGhost) releaseGhostBar(ghostEl, 'morphed_invalid');
  const barEl = reuseGhost ? ghostEl : document.createElement('div');
  barEl.className = 'ccsw-job-bar ccsw-job-bar--error ccsw-job-bar--terminal ccsw-job-bar--parse-error';

  const headerEl = reuseGhost ? barEl.querySelector('.ccsw-job-bar-header') : document.createElement('div');
  headerEl.className = 'ccsw-job-bar-header';

  const spinnerEl = reuseGhost ? headerEl.querySelector('.ccsw-spinner') : document.createElement('span');
  spinnerEl.className = 'ccsw-spinner';
  ensureSpinnerLogo(spinnerEl);

  const badgeEl = document.createElement('span');
  badgeEl.className = 'ccsw-job-bar-error-badge';
  badgeEl.textContent = '!';

  const idEl = reuseGhost ? headerEl.querySelector('.ccsw-job-bar-id') : document.createElement('span');
  idEl.className = 'ccsw-job-bar-id';
  idEl.textContent = 'CCSW block ignored: invalid JSON';

  const closeEl = document.createElement('button');
  closeEl.type = 'button';
  closeEl.className = 'ccsw-job-bar-close';
  closeEl.title = 'Dismiss';
  closeEl.textContent = '×';
  closeEl.addEventListener('click', (evt) => {
    evt.stopPropagation();
    barEl.remove();
  });

  // Rebuild the header from scratch even when morphing a ghost: the ghost only
  // had spinner + id, and the order/children differ (badge, close). Clearing
  // first keeps a reused node from stacking the old + new pieces.
  headerEl.replaceChildren(spinnerEl, badgeEl, idEl, closeEl);

  // Always-visible detail (NOT gated behind an expand click) -- the reason the
  // block was rejected has to be readable at a glance, since the user can't act
  // on "invalid JSON" without knowing where. Shows the recovered block name (if
  // any), the parser's real error text, and which safe auto-fixes were tried.
  const detailEl = document.createElement('div');
  detailEl.className = 'ccsw-job-bar-parse-error-detail';

  if (info.name) {
    const nameEl = document.createElement('div');
    nameEl.className = 'ccsw-parse-error-name';
    nameEl.textContent = `Block: ${info.name}`;
    detailEl.appendChild(nameEl);
  }

  const errEl = document.createElement('div');
  errEl.className = 'ccsw-parse-error-msg';
  errEl.textContent = info.error ? `Parser: ${info.error}` : 'Parser: could not parse block as JSON.';
  detailEl.appendChild(errEl);

  // Self-heal exhausted: only bother the human once feedback couldn't fix it,
  // and show the retry history so it's clear this is a last resort, not a
  // first-failure ghost. Reuses the existing detail styling (no new CSS).
  if (info.selfHealAttempts > 0) {
    const healEl = document.createElement('div');
    healEl.className = 'ccsw-parse-error-msg';
    healEl.textContent = `Self-heal: still invalid after ${info.selfHealAttempts} automatic re-send request(s); the error above is from the final attempt.`;
    detailEl.appendChild(healEl);
  }

  if (Array.isArray(info.foundClasses) && info.foundClasses.length > 0) {
    const fixesEl = document.createElement('div');
    fixesEl.className = 'ccsw-parse-error-fixes';
    fixesEl.textContent = `Auto-fixes tried: ${info.foundClasses.join(', ')}`;
    detailEl.appendChild(fixesEl);
  }

  barEl.replaceChildren(headerEl, detailEl);
  if (!barEl.isConnected) getToolbarContainer().appendChild(barEl);

  logEvent('invalid_block_shown', {
    anchor: info.anchorIndex ?? null,
    name: info.name ?? null,
    foundClasses: info.foundClasses ?? [],
    error: info.error ?? null,
    selfHealAttempts: info.selfHealAttempts ?? 0,
  });
  return barEl;
}

// Turns a FAILED dispatch into a persistent, dismissable red error pill rather
// than tearing the pill down and leaving nothing in its place. Same family as
// showInvalidBlockBar above (red + terminal, no auto-clear, builds its own node
// when handed no ghost, dismissed only by its corner ×) -- the difference is
// that the BLOCK was fine and the dispatch was not, so this one also carries a
// Retry button that re-runs the exact same dispatch.
//
// THE SILENT-LOSS FIX. dispatchCcswBlock's two failure exits used to call
// removeGhostBar, which is a NO-OP when ghostEl is null -- and every MANUAL
// dispatch path ("Dispatch anyway" on a held pill, "Re-fire" on a dropped pill,
// the SW menu's rescue) passes null by construction, having already disposed
// its own pill before dispatching. So a dispatch that failed for any reason
// other than a 409 repo lock removed the pill and rendered NOTHING in its
// place: no running pill, no error, no job -- the block vanished with no trace
// outside the console, and scan()'s heldBlockKeys (module-level, added when the
// block was first held) then classified it 'held_duplicate' forever, so no
// replacement pill could ever be built either. A 409 repo lock is handled by
// showDroppedJobBar and never reaches here; this is every OTHER failure.
//
// `info` = { anchorIndex, name, blockText, status, error }: `status` is the
// relay's HTTP status when it answered at all, `error` the thrown/reported
// message when it did not (relay unreachable, worker gone, context invalidated).
function showDispatchFailedBar(ghostEl, info = {}) {
  const reuseGhost = !!ghostEl?.isConnected;
  if (reuseGhost) releaseGhostBar(ghostEl, 'morphed_dispatch_failed');
  const barEl = reuseGhost ? ghostEl : document.createElement('div');
  // --dispatch-error rather than showInvalidBlockBar's --parse-error: both are
  // unstyled semantic markers (the red comes from --error), but the block here
  // parsed perfectly well and the relay is what failed, so the two want telling
  // apart in the DOM. The detail/msg/fixes classes below are shared with the
  // parse-error bar deliberately -- that IS the error-text styling, name
  // notwithstanding, and this needs no new CSS.
  barEl.className = 'ccsw-job-bar ccsw-job-bar--error ccsw-job-bar--terminal ccsw-job-bar--dispatch-error';

  const headerEl = reuseGhost ? barEl.querySelector('.ccsw-job-bar-header') : document.createElement('div');
  headerEl.className = 'ccsw-job-bar-header';

  const spinnerEl = reuseGhost ? headerEl.querySelector('.ccsw-spinner') : document.createElement('span');
  spinnerEl.className = 'ccsw-spinner';
  ensureSpinnerLogo(spinnerEl);

  const badgeEl = document.createElement('span');
  badgeEl.className = 'ccsw-job-bar-error-badge';
  badgeEl.textContent = '!';

  const idEl = reuseGhost ? headerEl.querySelector('.ccsw-job-bar-id') : document.createElement('span');
  idEl.className = 'ccsw-job-bar-id';
  idEl.textContent = `${info.name || 'Job'} - dispatch failed`;

  // Only offered when a block survived to re-fire from -- mirrors
  // showDroppedJobBar's Re-fire button, and re-dispatches through a FRESH ghost
  // so the retry's own outcome (running pill / dropped pill / this bar again)
  // has a node to morph, rather than repeating the null-ghost bug this bar
  // exists to fix.
  let retryEl = null;
  if (info.blockText) {
    retryEl = document.createElement('button');
    retryEl.type = 'button';
    retryEl.className = 'ccsw-job-bar-dispatch-anyway';
    retryEl.title = 'Retry this dispatch now';
    retryEl.textContent = 'Retry';
    retryEl.addEventListener('click', (evt) => {
      evt.stopPropagation();
      const retryGhost = createGhostBar(null, 'dispatch-failed-retry');
      barEl.remove();
      logEvent('dispatch_failed_retry', { anchor: info.anchorIndex ?? null, name: info.name ?? null }, null, true);
      dispatchCcswBlock(info.anchorIndex, info.blockText, retryGhost);
    });
  }

  const closeEl = document.createElement('button');
  closeEl.type = 'button';
  closeEl.className = 'ccsw-job-bar-close';
  closeEl.title = 'Dismiss';
  closeEl.textContent = '×';
  closeEl.addEventListener('click', (evt) => {
    evt.stopPropagation();
    barEl.remove();
  });

  // Rebuilt from scratch even when morphing a ghost -- see the matching note in
  // showInvalidBlockBar: the ghost carried only spinner + id.
  headerEl.replaceChildren(spinnerEl, badgeEl, idEl, ...(retryEl ? [retryEl] : []), closeEl);

  // Always-visible, not behind an expand click: a dispatch that failed is only
  // actionable if the reason is readable at a glance.
  const detailEl = document.createElement('div');
  detailEl.className = 'ccsw-job-bar-parse-error-detail';

  const errEl = document.createElement('div');
  errEl.className = 'ccsw-parse-error-msg';
  if (info.error) {
    errEl.textContent = `Relay: ${info.error}`;
  } else if (info.status) {
    errEl.textContent = `Relay: job.php answered HTTP ${info.status}.`;
  } else {
    errEl.textContent = 'Relay: dispatch failed for an unreported reason.';
  }
  detailEl.appendChild(errEl);

  const hintEl = document.createElement('div');
  hintEl.className = 'ccsw-parse-error-fixes';
  hintEl.textContent = info.blockText
    ? 'The job was NOT dispatched. Use Retry once the relay is reachable, or × to discard it.'
    : 'The job was NOT dispatched.';
  detailEl.appendChild(hintEl);

  barEl.replaceChildren(headerEl, detailEl);
  if (!barEl.isConnected) getToolbarContainer().appendChild(barEl);

  // urgent: a job the user asked for that never ran is worth surfacing in the
  // central log immediately, not on the next batched flush.
  logEvent('dispatch_failed_shown', {
    anchor: info.anchorIndex ?? null,
    name: info.name ?? null,
    status: info.status ?? null,
    error: info.error ?? null,
  }, null, true);
  return barEl;
}

// The fail-safe, run at the top of every scan. Whatever the dispatch decision
// does -- however many early-return branches Stage 3 (or a later stage) grows
// -- a ghost that can no longer be claimed is still reachable from liveGhosts
// and dies here. Cheap: almost always iterates an empty map.
function sweepGhosts() {
  if (liveGhosts.size === 0) return;
  const now = Date.now();
  for (const [ghostEl, rec] of [...liveGhosts]) {
    // Node already gone from the DOM (toolbar container rebuilt, or removed by
    // something that bypassed removeGhostBar) -- drop the registry entry only.
    // The owning state's handle is cleared too: left pointing at a detached
    // node it would keep the `!state.ghostEl` gate in scan() false for the rest
    // of that message's stream, silently suppressing the replacement ghost a
    // still-streaming block should get.
    if (!ghostEl.isConnected) {
      const state = rec.anchor ? seen.get(rec.anchor) : null;
      if (state && state.ghostEl === ghostEl) state.ghostEl = null;
      releaseGhostBar(ghostEl, 'detached');
      continue;
    }
    // THE bug #29 orphan: the message this ghost belonged to was virtualized
    // away, so scan() will never iterate that anchor again and nothing will
    // ever claim or dispose the ghost.
    if (rec.anchor && !rec.anchor.isConnected) {
      const state = seen.get(rec.anchor);
      if (state && state.ghostEl === ghostEl) state.ghostEl = null;
      removeGhostBar(ghostEl, 'anchor_gone');
      continue;
    }
    // Backstop for any path neither the branch reasons nor anchor_gone cover.
    if (now - rec.createdAt > GHOST_MAX_MS) {
      const state = rec.anchor ? seen.get(rec.anchor) : null;
      if (state && state.ghostEl === ghostEl) state.ghostEl = null;
      removeGhostBar(ghostEl, 'stale_timeout');
    }
  }
}

// Formats the repo(s)/holding-thread(s) a dropped dispatch collided with,
// shared between the console.warn below and the hovercard's held line (see
// renderJobHovercardContent's dropped branch) so both describe the lock the
// same way.
function formatHeldText(held, heldBy) {
  if (Array.isArray(held) && held.length > 0) {
    return held.map((h) => (h.thread ? `${h.repo} (held by ${h.thread})` : h.repo)).join(', ');
  }
  return heldBy ? `held by ${heldBy}` : '';
}

// BUG FIX: job.php returns 409 when the target repo is already locked by
// another job/thread, and dispatchCcswBlock previously just console.warn'd
// and called removeGhostBar -- the job vanished with no on-screen trace at
// all (the repo-free wake nudge is easy to miss, and there was nothing in
// the thread itself). This morphs the ghost pill (if still connected) into a
// persistent, dismissable "dropped" pill instead of tearing it down, so a
// dropped dispatch is exactly as visible as a live job would have been.
// Never added to activeToolbarJobs (there's no job id) -- dismissal just
// removes the DOM node directly via its own close button.
//
// `info` carries what job.php's 409 body + the original ccsw payload knew:
// { name, summary, thread, held, heldBy }. held is job.php's array of
// { repo, thread } locks (thread = the chat thread currently holding that
// repo); heldBy is the single-lock fallback field. The collapsed pill label
// only ever shows "<name> - repo busy" -- which repo/thread it collided with
// lives in the hovercard instead (see showDroppedHovercard below), mirroring
// how a live job's hovercard carries detail the collapsed pill doesn't.
// `info.id` distinguishes the two callers: dispatchCcswBlock's 409 branch
// omits it (a fresh drop, never recorded yet), while buildSwMenuJobRow's tap
// handler passes the dropped record's existing id to reopen its pill without
// re-recording/re-persisting a duplicate session-job entry.
function showDroppedJobBar(ghostEl, info) {
  const isReopen = !!info?.id;
  const recordId = info?.id || `dropped-${++dropHovercardKeyCounter}`;

  // A dropped record's SW menu row can be tapped more than once -- without
  // this guard, each tap would build a brand new pill sharing the same
  // recordId key, and once both are wired into activeToolbarJobs below the
  // older pill's header would end up toggling the newer pill's panel (see
  // toggleJobBar's key lookup). Mirrors addJobBar's own re-tap guard.
  if (isReopen && activeToolbarJobs.has(recordId)) return;

  const reuseGhost = !!ghostEl?.isConnected;
  if (reuseGhost) releaseGhostBar(ghostEl, 'morphed_dropped');
  const barEl = reuseGhost ? ghostEl : document.createElement('div');
  barEl.className = 'ccsw-job-bar ccsw-job-bar--dropped';

  const headerEl = reuseGhost ? barEl.querySelector('.ccsw-job-bar-header') : document.createElement('div');
  headerEl.className = 'ccsw-job-bar-header';
  headerEl.addEventListener('click', () => toggleJobBar(recordId));

  const spinnerEl = reuseGhost ? headerEl.querySelector('.ccsw-spinner') : document.createElement('span');
  spinnerEl.className = 'ccsw-spinner';
  ensureSpinnerLogo(spinnerEl);

  const idEl = reuseGhost ? headerEl.querySelector('.ccsw-job-bar-id') : document.createElement('span');
  idEl.className = 'ccsw-job-bar-id';
  idEl.textContent = `${info?.name || 'Job'} - repo busy`;

  // Only present when a stashed block survived to re-fire from (see
  // dispatchCcswBlock's blockText plumbing and recordDroppedSessionJob) --
  // pre-this-change records have none, so old dropped rows reopen info-only,
  // no button, no error. Mirrors showHeldForSendBar's "Dispatch anyway".
  let refireEl = null;
  if (info?.blockText) {
    refireEl = document.createElement('button');
    refireEl.type = 'button';
    refireEl.className = 'ccsw-job-bar-dispatch-anyway';
    refireEl.title = 'Re-fire this job now';
    refireEl.textContent = 'Re-fire';
    refireEl.addEventListener('click', (evt) => {
      evt.stopPropagation();
      // #12b S2: single disposer (was hideHovercardIfOwnedBy + barEl.remove()
      // + activeToolbarJobs.delete) -- dispose clears entry.hoverIntentTimer
      // too, so a re-fire click within the 750ms hover window can't strand a
      // showDroppedHovercard timer against the detached header. Order kept:
      // dispose (synchronous, terminal) then removeSessionJob then dispatch;
      // the re-fire payload lives on the `info` closure, not the entry, so
      // disposing first can't lose it.
      pillRegistry.dispose(recordId);
      // Clear the stale dropped row first (synchronously, before the await
      // inside dispatchCcswBlock) so the menu never briefly shows both the
      // old dropped entry and the new one side by side.
      removeSessionJob(info.thread, recordId);
      console.log(`[CCswitchboard] dropped job "${info?.name || 'Job'}" manually re-fired via pill click.`);
      // This call site omits the stableKey arg, so scan()'s synchronous
      // inFlightDispatch marker is skipped for it -- harmless, since a manual
      // re-fire is a deliberate click, not a scan-storm re-render.
      // (The durable identity is unaffected: dispatchCcswBlock derives its
      // own stable_key from the parsed block, so this job row is not
      // anonymous. Deliberately still not fed to the in-memory set, which
      // gates the hold decision -- see dispatchCcswBlock's relayStableKey.)
      logEvent('dispatch_nokey', { site: 'refire', name: info?.name || 'Job', jobId: recordId });
      dispatchCcswBlock('dropped-refire', info.blockText, null);
    });
  }

  const closeEl = document.createElement('button');
  closeEl.type = 'button';
  closeEl.className = 'ccsw-job-bar-close';
  closeEl.title = 'Dismiss';
  closeEl.textContent = '×';
  closeEl.addEventListener('click', (evt) => {
    evt.stopPropagation();
    // #12b S2: single disposer (was hideHovercardIfOwnedBy + barEl.remove() +
    // activeToolbarJobs.delete). dispose also clears entry.hoverIntentTimer.
    pillRegistry.dispose(recordId);
  });

  const heldText = formatHeldText(info?.held, info?.heldBy);
  // #54: which single repo a wake-pending nudge would fire for, from job.php's
  // 409 lock array -- the first entry when there's more than one, same as
  // wherever "the" colliding repo is treated as singular elsewhere. Falls
  // back to heldBy (the older single-lock field) when held isn't an array.
  const wakeRepo = (Array.isArray(info?.held) && info.held.length > 0 ? info.held[0].repo : null) || info?.heldBy || null;
  // Stamped once here rather than read fresh at hovercard-open time -- a
  // dropped dispatch never becomes a real job, so there's no "started"
  // moment other than the drop itself, and it's the same instant the SW
  // menu row below uses for its own elapsed time. A reopened pill passes the
  // original drop's timestamp through info.droppedAt so elapsed stays
  // anchored to the actual drop, not the moment it was tapped open again.
  const droppedAt = info?.droppedAt || Date.now();

  // Expandable drop-context box (same interface as a real job's terminal
  // panel -- see addJobBar's panelEl -- for consistency): a dropped
  // dispatch never ran, so there's no feed.php job stream to embed in an
  // iframe. Instead this renders the drop facts as plain text
  // (renderDroppedPanelContent, called from toggleJobBar on expand), reusing
  // the same .ccsw-job-bar-panel open/close sizing machinery. The toolbar's
  // send button below delivers a compact summary via the same
  // ccsw-deliver-advice path feed.php's advice-btn uses (see the
  // window 'message' listener above) -- just called directly since there's
  // no iframe here to postMessage from.
  const panelEl = document.createElement('div');
  panelEl.className = 'ccsw-job-bar-panel ccsw-job-bar-panel--dropped';

  const contentEl = document.createElement('div');
  contentEl.className = 'ccsw-job-bar-dropped-content';

  // Deliberately NOT info.blockText in the send summary below -- Claude
  // already authored that block, so re-sending the full stashed prompt back
  // to it would just be noise. Only the actionable drop facts (see
  // buildDropSummaryText). No onCancel here -- a dropped pill's box only
  // ever gets a send button; the corner × already covers dismissal (see
  // showHeldForSendBar for the held box, which does pass onCancel).
  const toolbarEl = buildJobBarToolbar({
    sendTitle: 'Send drop summary to claude.ai chat',
    onSend: () => {
      const text = buildDropSummaryText(entry);
      console.log(`[CCswitchboard] dropped pill ${recordId}: sending compact drop summary to chat.`);
      chrome.runtime.sendMessage({ type: 'ccsw-deliver-advice', jobId: recordId, text, thread: entry.thread }).catch((err) => {
        console.warn(`[CCswitchboard] dropped pill ${recordId}: failed to forward drop summary to background:`, err.message);
        handlePossibleContextInvalidation(err);
      });
    },
  });
  panelEl.append(contentEl, toolbarEl);
  attachResizeHandles(panelEl);

  const entry = {
    dropped: true,
    name: info?.name || '',
    summary: info?.summary || '',
    heldText,
    held: info?.held || null,
    wakeRepo,
    droppedAt,
    thread: info?.thread || null,
    // Stashed here (rather than only living on the sessionJobs record -- see
    // recordDroppedSessionJob) so renderJobHovercardContent's shared
    // more-info expander can parse it straight off the hovercard entry, same
    // as the held-for-send branch below.
    blockText: info?.blockText || null,
    // D2 #12b: the block's durable identity (see dispatchCcswBlock's
    // relayStableKey) -- lets resolveSupersededDroppedTwin find this pill
    // again if the same block later dispatches successfully. Only ever set
    // on a fresh drop (dispatchCcswBlock's 409 branch); a reopened historical
    // row from the SW menu has none, so it's simply never matched -- fine,
    // it wasn't live on screen at dispatch time anyway.
    stableKey: info?.stableKey || null,
    refireEl: refireEl || null,
    superseded: false,
    supersededByJobId: null,
    collapseTimer: null,
    // #12b S2: hover-intent timer lives ON the entry (was a closure local),
    // so pillRegistry.dispose clears it via its *Timer sweep. Fixes the
    // "hovercard for a corpse" latent bug -- removing the pill inside the
    // 750ms window no longer lets showDroppedHovercard fire at a detached
    // header (barEl.remove() killed the listeners but not this pending timer).
    hoverIntentTimer: null,
    barEl, headerEl, panelEl, contentEl, iframeEl: null,
    expanded: false,
  };
  // #12b S3: single make-path. The isReopen has-guard above stays as an
  // explicit early-return fast path (it skips the entire bar build for an
  // already-open reopen); create is the must-not-exist backstop -- a fresh
  // drop's recordId is a unique dropped-N counter so it always inserts here.
  pillRegistry.create(recordId, entry);

  // Same hover-intent pattern as addJobBar's headerEl listeners (a bare
  // mouseenter would pop the card on every incidental pass over the
  // toolbar) -- the entry above only changes via the expand/collapse fields
  // above, so unlike showJobHovercard this doesn't need to re-look-up
  // anything by id each time.
  headerEl.addEventListener('mouseenter', () => {
    clearTimeout(entry.hoverIntentTimer);
    cancelHideJobHovercard();
    entry.hoverIntentTimer = setTimeout(() => showDroppedHovercard(recordId, entry, headerEl), 750);
  });
  headerEl.addEventListener('mouseleave', () => {
    clearTimeout(entry.hoverIntentTimer);
    scheduleHideJobHovercard();
  });

  if (reuseGhost) {
    headerEl.append(...(refireEl ? [refireEl] : []), closeEl);
    barEl.appendChild(panelEl);
  } else {
    headerEl.append(spinnerEl, idEl, ...(refireEl ? [refireEl] : []), closeEl);
    barEl.append(headerEl, panelEl);
    getToolbarContainer().appendChild(barEl);
  }

  if (!isReopen) {
    // A dropped dispatch has no job id and never reaches recordSessionJob, so
    // without this it simply never appeared in the SW menu's job list at all --
    // dismissing the pill (or losing it on refresh) left zero trace it ever
    // happened. recordId doubles as its id here: it's already a unique,
    // never-reused string minted for exactly this dropped dispatch.
    recordDroppedSessionJob(recordId, info?.thread, `${info?.name || 'Job'} - repo busy`, info?.summary || '', droppedAt, info?.blockText || null);

    console.warn(`[CCswitchboard] dispatch dropped (repo locked): ${heldText || '(repo unknown)'}`);
  }
}

// Renders the drop-context box's text content (see showDroppedJobBar's
// panelEl) -- called on every expand rather than once at pill-creation time
// so the elapsed-time line stays current, matching the same "fresh at
// open, not ticked live" convention renderJobHovercardContent's dropped
// branch already uses for the hovercard.
function renderDroppedPanelContent(entry) {
  const el = entry.contentEl;
  el.textContent = '';

  const nameEl = document.createElement('div');
  nameEl.className = 'ccsw-job-bar-dropped-name';
  nameEl.textContent = entry.name || 'Job';
  el.appendChild(nameEl);

  const statusEl = document.createElement('div');
  statusEl.className = 'ccsw-job-bar-dropped-status-line';
  statusEl.textContent = 'Dropped - repo busy';
  el.appendChild(statusEl);

  if (entry.heldText) {
    const heldEl = document.createElement('div');
    heldEl.className = 'ccsw-job-bar-dropped-held-line';
    heldEl.textContent = `Collided with: ${entry.heldText}`;
    el.appendChild(heldEl);
  }

  // #54: repo-free wake is already tracked server-side (see background.js's
  // pollWake) -- this just surfaces that this thread is already registered
  // for the nudge, so a dropped pill doesn't read as a dead end.
  if (entry.wakeRepo) {
    const wakeEl = document.createElement('div');
    wakeEl.className = 'ccsw-job-bar-dropped-wake-line';
    wakeEl.textContent = `⏳ wake pending: this thread will be nudged when ${entry.wakeRepo} frees`;
    el.appendChild(wakeEl);
  }

  const elapsedEl = document.createElement('div');
  elapsedEl.className = 'ccsw-job-bar-dropped-elapsed-line';
  elapsedEl.textContent = `Dropped ${formatElapsedSince(entry.droppedAt)}`;
  el.appendChild(elapsedEl);

  if (entry.summary) {
    const summaryEl = document.createElement('div');
    summaryEl.className = 'ccsw-job-bar-dropped-summary-line';
    summaryEl.textContent = entry.summary;
    el.appendChild(summaryEl);
  }
}

// Held box's terminal-panel content (see toggleJobBar's entry.held branch) --
// same "no feed to stream, render facts as text" treatment as the dropped
// box's renderDroppedPanelContent above, just held-specific facts: the block
// name, that it's HELD and why (send window lapsed -- the durable beacon is
// read live here, same as renderJobHovercardContent's held branch, so it stays
// accurate for a pill that's sat on screen a while), then the block's own
// details reusing renderStashedBlockDetail -- the same blockText parser the
// hovercard's "more info" expander already uses for both dropped and held.
function renderHeldPanelContent(entry) {
  const el = entry.contentEl;
  el.textContent = '';

  const nameEl = document.createElement('div');
  nameEl.className = 'ccsw-job-bar-dropped-name';
  nameEl.textContent = entry.name || 'Job';
  el.appendChild(nameEl);

  const statusEl = document.createElement('div');
  statusEl.className = 'ccsw-job-bar-dropped-status-line';
  statusEl.textContent = 'Held - no recent user send in this thread. This is the stale-replay guard: it stops old ccsw blocks re-dispatching on reload or scroll -- without it, every old block would re-fire on every reload.';
  el.appendChild(statusEl);

  const whyEl = document.createElement('div');
  whyEl.className = 'ccsw-job-bar-dropped-held-line';
  const lastSendAt = lastUserSendAtForDisplay();
  whyEl.textContent = lastSendAt
    ? `Last send ${formatElapsedSince(lastSendAt)}. Send any message in this thread, or click Dispatch anyway, to run it.`
    : 'No user send recorded in this thread. Send any message in this thread, or click Dispatch anyway, to run it.';
  el.appendChild(whyEl);

  // BUG FIX (#47): entry.thread is the block's own declared thread
  // (blockThread); hydratedThread is this tab's identity (tabThread) -- the
  // key rule B's beacon lookup now reads (see scan()'s dispatch_decision_v2
  // comment). A block held under a DIFFERENT declared thread than this tab's
  // identity can never be un-held by sending in this tab, since no beacon
  // this tab posts lands under the block's name -- surface that mismatch so
  // it's not a silent dead end.
  if (entry.thread && hydratedThread && entry.thread !== hydratedThread) {
    const mismatchEl = document.createElement('div');
    mismatchEl.className = 'ccsw-job-bar-dropped-held-line';
    mismatchEl.textContent = `note: this tab is "${hydratedThread}" but the block declares "${entry.thread}"`;
    el.appendChild(mismatchEl);
  }

  if (entry.summary) {
    const summaryEl = document.createElement('div');
    summaryEl.className = 'ccsw-job-bar-dropped-summary-line';
    summaryEl.textContent = entry.summary;
    el.appendChild(summaryEl);
  }

  const detailEl = document.createElement('div');
  detailEl.className = 'ccsw-job-bar-dropped-detail';
  if (entry.blockText) {
    renderStashedBlockDetail(detailEl, entry.blockText);
  } else {
    const pre = document.createElement('pre');
    pre.className = 'detail-pre';
    pre.textContent = '(no block data)';
    detailEl.appendChild(pre);
  }
  el.appendChild(detailEl);
}

// Compact, actionable-facts-only summary for the drop box's send button --
// deliberately excludes the full stashed blockText/prompt (that lives on
// info.blockText, only ever read by the Re-fire button): Claude already
// authored that block, so re-sending it back would just be noise. repo is
// only derivable when entry.held survived from the original 409 response
// (see showDroppedJobBar) -- a reopened pill from the SW menu never has it
// (recordDroppedSessionJob doesn't persist held), so it's omitted there.
function buildDropSummaryText(entry) {
  const minutes = Math.max(0, Math.round((Date.now() - entry.droppedAt) / 60000));
  const repo = Array.isArray(entry.held) && entry.held[0]?.repo ? entry.held[0].repo : null;
  const name = entry.name || 'Job';
  return repo
    ? `FYI: job "${name}" was dropped - repo ${repo} was busy, ${minutes} min ago.`
    : `FYI: job "${name}" was dropped - repo busy, ${minutes} min ago.`;
}

// #64: compact status summary for the held box's send button -- same
// actionable-facts-only spirit as buildDropSummaryText above, and likewise
// never carries the stashed blockText (that's still only ever read by the
// header's "Dispatch anyway" button). Reuses the same beacon lookup
// renderHeldPanelContent already reads live, so "last send Xm ago" stays
// accurate no matter how long the pill has sat on screen before this is sent.
function buildHeldSummaryText(entry) {
  const name = entry.name || 'Job';
  const lastSendAt = lastUserSendAtForDisplay();
  const sendInfo = lastSendAt ? `last send ${formatElapsedSince(lastSendAt)}` : 'no user send recorded in this thread';
  return `FYI: job "${name}" is HELD - no recent user send in this thread (${sendInfo}). Send any message here, or click Dispatch anyway, to run it.`;
}

// Icon-button "Cancel" control (#44) -- ONE builder for every pill state
// that gets one, parameterised by `state` rather than forked per-state:
// currently only the held box (see showHeldForSendBar) passes onCancel, but
// a future running-job cancel would call this too, and "dismiss a held pill
// that never dispatched" vs "cancel a job actually running server-side" are
// different actions under the same look -- state is threaded through now
// (as a modifier class, and available to onCancel's caller-side closure) so
// that difference has somewhere to live without a second copy of this
// function appearing later.
function buildCancelButton({ state, title, onCancel }) {
  const cancelEl = document.createElement('button');
  cancelEl.type = 'button';
  cancelEl.className = `ccsw-job-bar-cancel-btn ccsw-job-bar-cancel-btn--${state}`;
  cancelEl.title = title || 'Cancel';
  cancelEl.setAttribute('aria-label', title || 'Cancel');
  cancelEl.appendChild(buildCancelIcon());
  cancelEl.addEventListener('click', (evt) => {
    evt.stopPropagation();
    onCancel();
  });
  return cancelEl;
}

// Shared box-toolbar builder for the "never ran" pill kinds -- both the
// dropped box (showDroppedJobBar) and the held box (showHeldForSendBar) are a
// scrollable text area plus a pinned toolbar with one action icon plus an
// optional cancel. Both boxes' action icon does the SAME kind of thing (#64,
// floor rule): forward a compact status summary via the same
// ccsw-deliver-advice path feed.php's own advice-btn uses -- dropped's via
// buildDropSummaryText, held's via buildHeldSummaryText. Neither one takes a
// side-effecting action; the held box's actual redispatch (dispatchHeldBlock)
// lives only on the header's "Dispatch anyway" button, never in here.
// sendTitle/sendAriaLabel are caller-supplied so the icon-button's accessible
// name matches whichever state it is. onCancel is only passed by the held
// box: a dropped pill's box only ever needs the action icon, since its
// corner × already covers dismissal
// and its "Re-fire" lives on the pill header, not in here. Cancel (when
// present) is appended AFTER the action icon so it lands on the right --
// the rightmost slot in the toolbar's flex-end packing (#44) -- since it's
// the more consequential of the two (it's the one action button that gives
// up on the block rather than acting on it).
function buildJobBarToolbar({ sendTitle, sendAriaLabel, onSend, cancelState, cancelTitle, onCancel }) {
  const toolbarEl = document.createElement('div');
  toolbarEl.className = 'ccsw-job-bar-dropped-toolbar';

  const sendEl = document.createElement('button');
  sendEl.type = 'button';
  sendEl.className = 'ccsw-job-bar-send-btn';
  sendEl.title = sendTitle || 'Send summary to claude.ai chat';
  sendEl.setAttribute('aria-label', sendAriaLabel || 'Send summary');
  sendEl.appendChild(buildSendIcon());
  sendEl.addEventListener('click', (evt) => {
    evt.stopPropagation();
    onSend();
  });
  toolbarEl.appendChild(sendEl);

  if (onCancel) {
    toolbarEl.appendChild(buildCancelButton({ state: cancelState || 'held', title: cancelTitle, onCancel }));
  }

  return toolbarEl;
}

// Stale-replay send-guard papercut fix: scan()'s user-send provenance guard
// (rule (b), see CCSW_SEND_WINDOW_MS) used to just console.log and
// mark the block dispatched-and-skip when there was no recent real user send
// -- a silent drop. Jody's actual workflow is fire-a-job-then-walk-away, so
// he routinely comes back outside the 5-minute window and the block simply
// never fired, with no on-screen trace at all; recovering required sending
// any message (to reopen the window) and getting Claude to re-emit the
// block. This morphs the ghost pill (if still connected) into a persistent,
// dismissable "held" pill instead -- same reuse-ghost pattern as
// showDroppedJobBar above -- with a manual "Dispatch anyway" button.
//
// IMPORTANT: this does NOT weaken the guard. The block is never dispatched
// here -- rendering the pill has no dispatch side effect. Dispatch only
// happens if Jody clicks the button, which is itself a real user action and
// therefore legitimate provenance to bypass the send-window for that one
// block, same principle the guard already runs on. Held pills are rendered
// only for blocks that failed rule (b) and have never dispatched; an
// already-dispatched block is ignored silently (rule (a)) and an ancient
// never-dispatched one is too (the newest-message tiebreaker), so NONE of
// them auto-fire -- a held pill just sits there until clicked or dismissed.
function showHeldForSendBar(anchorIndex, blockText, ghostEl) {
  let parsedBlock = null;
  try {
    parsedBlock = JSON.parse(blockText);
  } catch {
    // Not valid JSON (yet, or ever) -- still surfaced as held so Jody can see
    // something arrived; clicking "Dispatch anyway" runs it through
    // dispatchCcswBlock's own parse, which reports the real error.
  }
  // RAW name (empty when the block carried none) -- like the dropped entry
  // above, the 'Job' fallback is applied at each RENDER site (the collapsed
  // label below, renderHeldPanelContent, buildHeldSummaryText) rather than baked
  // in here, so a nameless held block falls through to its summary instead.
  const name = (parsedBlock && typeof parsedBlock.name === 'string' && parsedBlock.name.trim()) || '';
  const summary = (parsedBlock && typeof parsedBlock.summary === 'string' && parsedBlock.summary) || '';
  const displayName = name || 'Job';
  const model = (parsedBlock && typeof parsedBlock.model === 'string' && parsedBlock.model) || '';
  const thread = (parsedBlock && typeof parsedBlock.thread === 'string' && parsedBlock.thread) || null;

  // Doubles as the pill's activeToolbarJobs key (so toggleJobBar/hovercard
  // lookups work the same way a dropped pill's recordId does) and as its
  // hovercard key -- there's no job.php id for a block that never dispatched.
  const recordId = `held-${++dropHovercardKeyCounter}`;

  const reuseGhost = !!ghostEl?.isConnected;
  if (reuseGhost) releaseGhostBar(ghostEl, 'morphed_held');
  const barEl = reuseGhost ? ghostEl : document.createElement('div');
  barEl.className = 'ccsw-job-bar ccsw-job-bar--held-for-send';

  const headerEl = reuseGhost ? barEl.querySelector('.ccsw-job-bar-header') : document.createElement('div');
  headerEl.className = 'ccsw-job-bar-header';
  headerEl.addEventListener('click', () => toggleJobBar(recordId));

  const spinnerEl = reuseGhost ? headerEl.querySelector('.ccsw-spinner') : document.createElement('span');
  spinnerEl.className = 'ccsw-spinner';
  ensureSpinnerLogo(spinnerEl);

  const idEl = reuseGhost ? headerEl.querySelector('.ccsw-job-bar-id') : document.createElement('span');
  idEl.className = 'ccsw-job-bar-id';
  idEl.textContent = `${displayName} - needs a recent send`;

  // #64: dispatch (fire this held block now, bypassing the send-window guard)
  // lives solely on the header's "Dispatch anyway" button -- the box toolbar's
  // send icon no longer wires here; it reports held status to chat instead (see
  // the #64 note on the toolbar below). The one other caller is the programmatic
  // autopilot-window auto-release (entry.autopilotRelease, below), which is the
  // same action reached without a click, so one function instead of duplicated
  // dispatch/cleanup sequences.
  const dispatchHeldBlock = (site) => {
    // #12b S2: single disposer (was hideHovercardIfOwnedBy + barEl.remove() +
    // activeToolbarJobs.delete), also clearing entry.hoverIntentTimer. The
    // dispatch-anyway payload (blockText, anchorIndex) lives on THIS closure,
    // not on the entry, so disposing the entry here cannot lose it -- the
    // dispatchCcswBlock below still fires with the full block. Order preserved:
    // dispose (synchronous, terminal) precedes dispatch exactly as before.
    // HAND-OVER GHOST (silent-loss fix). The held pill is disposed below, and
    // dispatchCcswBlock renders EVERY outcome by morphing the node it was
    // handed -- into a running pill (addJobBar), a repo-busy pill
    // (showDroppedJobBar), or a red failure pill (showDispatchFailedBar). This
    // site used to hand it null, so the held pill was destroyed and the
    // outcome had nothing to render into: on any failure the job vanished with
    // no pill at all, and even on success the toolbar sat empty for the whole
    // relay round-trip. Minted BEFORE the dispose so the pill is replaced, not
    // removed-then-maybe-replaced -- held pill -> spinner -> running pill, with
    // no gap a job can disappear into.
    const handoverGhost = createGhostBar(null, `held-${site}`);
    pillRegistry.dispose(recordId);
    console.log(`[CCswitchboard] anchor #${anchorIndex}: held block manually dispatched via "${site}" click.`);
    // DEBUG (held-pill resurrection investigation): this call site also
    // omits the stableKey arg -- see the matching note at the 'refire' site,
    // including why the relay-side stable_key is still recorded regardless.
    logEvent('dispatch_nokey', { site, name: displayName, jobId: recordId });
    dispatchCcswBlock(anchorIndex, blockText, handoverGhost);
  };

  const dispatchEl = document.createElement('button');
  dispatchEl.type = 'button';
  dispatchEl.className = 'ccsw-job-bar-dispatch-anyway';
  dispatchEl.title = 'Dispatch this block now (bypasses the send-window guard)';
  dispatchEl.textContent = 'Dispatch anyway';
  dispatchEl.addEventListener('click', (evt) => {
    evt.stopPropagation();
    dispatchHeldBlock('header-dispatch-anyway');
  });

  const closeEl = document.createElement('button');
  closeEl.type = 'button';
  closeEl.className = 'ccsw-job-bar-close';
  closeEl.title = 'Dismiss';
  closeEl.textContent = '×';
  closeEl.addEventListener('click', (evt) => {
    evt.stopPropagation();
    // #12b S2: single disposer (was hideHovercardIfOwnedBy + barEl.remove() +
    // activeToolbarJobs.delete). dispose also clears entry.hoverIntentTimer.
    pillRegistry.dispose(recordId);
  });

  // Expandable held-context box, same interface as the dropped pill's box
  // above (see showDroppedJobBar/buildJobBarToolbar) -- a held block never
  // ran either, so this renders held-context text (renderHeldPanelContent,
  // called from toggleJobBar's entry.held branch on expand) instead of a
  // feed.php iframe, and its toolbar gets both a send icon and a cancel
  // button (dismiss the held job -- there's no server-side job to cancel,
  // just this pill/entry).
  //
  // #64: the box's icon sends a STATUS summary to chat (buildHeldSummaryText),
  // same family as the dropped box's send icon -- it does NOT dispatch the
  // block. The resend/dispatch action (dispatchHeldBlock) stays solely on the
  // header's "Dispatch anyway" button, so every terminal-box's bottom-toolbar
  // send icon means the same thing across states: report status to chat,
  // never take a side-effecting action.
  const panelEl = document.createElement('div');
  panelEl.className = 'ccsw-job-bar-panel ccsw-job-bar-panel--dropped';

  const contentEl = document.createElement('div');
  contentEl.className = 'ccsw-job-bar-dropped-content';

  const toolbarEl = buildJobBarToolbar({
    sendTitle: 'Send held status to claude.ai chat',
    sendAriaLabel: 'Send status',
    onSend: () => {
      const text = buildHeldSummaryText(entry);
      console.log(`[CCswitchboard] held pill ${recordId}: sending held status to chat.`);
      chrome.runtime.sendMessage({ type: 'ccsw-deliver-advice', jobId: recordId, text, thread: entry.thread }).catch((err) => {
        console.warn(`[CCswitchboard] held pill ${recordId}: failed to forward held status to background:`, err.message);
        handlePossibleContextInvalidation(err);
      });
    },
    cancelState: 'held',
    cancelTitle: 'Cancel this held job (dismiss without dispatching)',
    onCancel: () => {
      console.log(`[CCswitchboard] held pill ${recordId}: dismissed via box cancel button.`);
      // #12b S2: single disposer (was hideHovercardIfOwnedBy + barEl.remove() +
      // activeToolbarJobs.delete). dispose also clears entry.hoverIntentTimer.
      pillRegistry.dispose(recordId);
    },
  });
  panelEl.append(contentEl, toolbarEl);
  attachResizeHandles(panelEl);

  // entry.lastSendAt is NOT read here -- renderJobHovercardContent's held
  // branch reads the durable beacon live at hovercard-open time instead, so
  // the "last send Xm ago" line stays accurate even if the pill has been
  // sitting on screen a while before it's hovered.
  // blockText rides along (mirrors the dropped entry above) so the shared
  // more-info expander (and the box's own renderHeldPanelContent) have
  // something to parse -- a held pill never reaches recordSessionJob/
  // recordDroppedSessionJob, so this is the only place it's captured at all.
  const entry = {
    held: true, name, summary, blockText, model, thread,
    barEl, headerEl, panelEl, contentEl, iframeEl: null,
    expanded: false,
    // #12b S2: hover-intent timer on the entry (was a closure local), cleared
    // by pillRegistry.dispose's *Timer sweep -- same corpse-hovercard fix as
    // the dropped pill above.
    hoverIntentTimer: null,
  };
  // #12b S3: single make-path. recordId is a unique held-N counter, so
  // create's must-not-exist always inserts here (no re-tap path builds a held
  // pill for an existing key).
  pillRegistry.create(recordId, entry);

  // Lets armAutopilotWindow() fire this exact "Dispatch anyway" path
  // programmatically when a window is armed (see releaseAutopilotHeldPills) --
  // same function, same cleanup, so an auto-release is indistinguishable from a
  // manual click except for the log site tag.
  entry.autopilotRelease = () => dispatchHeldBlock('autopilot-window');

  headerEl.addEventListener('mouseenter', () => {
    clearTimeout(entry.hoverIntentTimer);
    cancelHideJobHovercard();
    entry.hoverIntentTimer = setTimeout(() => showDroppedHovercard(recordId, entry, headerEl), 750);
  });
  headerEl.addEventListener('mouseleave', () => {
    clearTimeout(entry.hoverIntentTimer);
    scheduleHideJobHovercard();
  });

  if (reuseGhost) {
    headerEl.append(dispatchEl, closeEl);
    barEl.appendChild(panelEl);
  } else {
    headerEl.append(spinnerEl, idEl, dispatchEl, closeEl);
    barEl.append(headerEl, panelEl);
    getToolbarContainer().appendChild(barEl);
  }

  console.log(`[CCswitchboard] anchor #${anchorIndex}: showing "held for send" pill for block "${displayName}" (no recent user send).`);
}

// #71: shared exit animation for every auto-disappearing pill/box (sent pd
// pills, superseded twins, rescue toasts) -- a top-anchored collapse (height
// folds to 0, slight opacity fade) so a timer-driven removal reads as a
// deliberate exit instead of an instant cut. Manual X-dismiss clicks
// deliberately bypass this (see those close handlers) -- a user-initiated
// close should feel instant, not delayed by an animation they didn't ask for.
const PILL_EXIT_ANIM_MS = 500;

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Locks the element's current pixel height (height:auto can't be
// transitioned directly) then transitions it to 0 next frame; cb fires on
// transitionend or a fallback timeout, whichever comes first, so a dropped
// transitionend (e.g. element detached mid-flight some other way) can't
// strand the caller's cleanup forever.
function animatePillExit(el, cb) {
  if (!el || !el.isConnected) { cb(); return; }
  if (prefersReducedMotion()) {
    setTimeout(cb, PILL_EXIT_ANIM_MS);
    return;
  }
  const startHeight = el.getBoundingClientRect().height;
  el.style.height = `${startHeight}px`;
  el.style.overflow = 'hidden';
  void el.offsetHeight; // force reflow so the explicit height above registers before it's transitioned away
  el.classList.add('ccsw-pill-exiting');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.removeEventListener('transitionend', finish);
    cb();
  };
  el.addEventListener('transitionend', finish);
  setTimeout(finish, PILL_EXIT_ANIM_MS + 100);
  requestAnimationFrame(() => {
    el.style.height = '0px';
  });
}

// Auto-expire for terminal job pills. Once a pill lands a terminal outcome
// (done/error/cancelled/stale -- all carry ccsw-job-bar--terminal, which
// dropped/waiting/held/pending pills never receive, so it's the clean
// discriminator: those stay until resolved), it sits for 3 minutes then slides
// itself out and disposes. Deliberately a SEPARATE class + function from
// animatePillExit/.ccsw-pill-exiting above (0.5s, top-collapse) -- other
// removals depend on those exact timings; this exit slides DOWNWARD by the
// pill's own height over 0.4s while the stack closes up above it.
const TERMINAL_PILL_EXPIRE_MS = 180000; // 3 min after a pill goes terminal
const PILL_EXPIRE_ANIM_MS = 400;        // 0.4s slide-out (matches .ccsw-pill-expiring)
// Courtesy re-check cadence: if the 3-min timer fires while the pill is
// expanded, we don't yank it out from under the user -- we re-poll this often
// until it's collapsed, then slide it out.
const TERMINAL_PILL_EXPIRE_RECHECK_MS = 15000;

// Sibling of animatePillExit for the 0.4s downward slide-out (see
// .ccsw-pill-expiring in content.css). Locks the current pixel height (so the
// height:auto -> 0 collapse can transition), then a frame later drops height to
// 0 AND translates the pill down by its own captured height so it slides out
// beneath the stack; cb fires on transitionend or a fallback timeout, whichever
// first, matching animatePillExit's dropped-transitionend guard.
function animatePillExpire(el, cb) {
  if (!el || !el.isConnected) { cb(); return; }
  if (prefersReducedMotion()) {
    setTimeout(cb, PILL_EXPIRE_ANIM_MS);
    return;
  }
  const startHeight = el.getBoundingClientRect().height;
  el.style.height = `${startHeight}px`;
  el.style.overflow = 'hidden';
  void el.offsetHeight; // force reflow so the explicit height registers before it's transitioned away
  el.classList.add('ccsw-pill-expiring');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.removeEventListener('transitionend', finish);
    cb();
  };
  el.addEventListener('transitionend', finish);
  setTimeout(finish, PILL_EXPIRE_ANIM_MS + 100);
  requestAnimationFrame(() => {
    el.style.height = '0px';
    el.style.transform = `translateY(${startHeight}px)`; // slide DOWN by own height
  });
}

// Arms the one-shot 3-min expiry timer the moment a pill goes terminal (called
// from setJobBarStatus's terminal morph, NOT at dispatch). The timer id lives
// on the entry as entry.expireTimer so pillRegistry.dispose's *Timer sweep
// clears it if the pill is disposed early (manual dismiss, supersede, cap/reap)
// -- no dangling timers. The expireTimer/expiring guards make re-applying the
// terminal class idempotent: no double-scheduling, no double animation.
function scheduleTerminalPillExpiry(key, entry) {
  if (!entry || entry.expiring || entry.expireTimer) return;
  entry.expireTimer = setTimeout(() => {
    entry.expireTimer = null;
    tryExpireTerminalPill(key, entry);
  }, TERMINAL_PILL_EXPIRE_MS);
}

// Timer-fire body: slide the pill out, unless it's no longer eligible (already
// gone/detached, no longer terminal) or currently expanded -- in which case we
// leave it alone and re-check every ~15s until it's collapsed, so we never yank
// a pill the user has open.
function tryExpireTerminalPill(key, entry) {
  if (entry.expiring) return;
  if (!pillRegistry.has(key) || !entry.barEl || !entry.barEl.isConnected) return;
  if (!entry.barEl.classList.contains('ccsw-job-bar--terminal')) return;
  if (entry.barEl.classList.contains('ccsw-job-bar--expanded')) {
    entry.expireTimer = setTimeout(() => {
      entry.expireTimer = null;
      tryExpireTerminalPill(key, entry);
    }, TERMINAL_PILL_EXPIRE_RECHECK_MS);
    return;
  }
  entry.expiring = true;
  animatePillExpire(entry.barEl, () => pillRegistry.dispose(key));
}

// --- D2: pending-delivery pills -----------------------------------------
// One pill per background.js pendingSends entry (see broadcastQueueStateForTab
// there), keyed into activeToolbarJobs alongside job/dropped/held pills --
// same reuse-the-existing-plumbing approach as showDroppedJobBar/
// showHeldForSendBar, not a parallel pill system. Before this, only 'wake'
// (job-completion) deliveries had any visible indicator at all (the job
// pill's own --waiting flag) -- every other kind (status reports, debug
// logs, plan check-ins, repo-free wakes) queued and could sit held with zero
// on-screen trace. Lifecycle: 'pending' while queued/held, 'sent' once
// delivered (dims, auto-collapses into SW-menu history after
// PENDING_DELIVERY_SENT_COLLAPSE_MS), 'parked' if background.js gave up
// delivering automatically (stays loud/pulsing indefinitely, send icon
// becomes the manual retry action -- see requestPendingRedeliver).
// #71: 5s, not the ~60s this used to be -- a sent pill only needs to read as
// "confirmed delivered" for a beat before it collapses into SW-menu history;
// parked pills don't use this timer at all (they stay loud until manually
// redelivered or dismissed -- see showPendingDeliveryPill's state branches).
const PENDING_DELIVERY_SENT_COLLAPSE_MS = 5000;

function pendingDeliveryPillKey(sendKey) {
  return `pd:${sendKey}`;
}

// Collapsed-pill label. " - " (not an em dash) matches this file's existing
// punctuation convention (see e.g. showDroppedJobBar's "<name> - repo busy").
function buildPendingDeliveryLabel(entry) {
  const kindLabel = entry.kindLabel || entry.kind || 'Message';
  const origin = entry.thread || 'unknown';
  if (entry.state === 'sent') return `${kindLabel} from ${origin} - ✓ sent to chat`;
  if (entry.state === 'parked') return `⚠ manual send needed - ${kindLabel} from ${origin}`;
  const waitPart = entry.waitReasonHuman ? ` - waiting: ${entry.waitReasonHuman}` : '';
  return `${kindLabel} from ${origin}${waitPart}`;
}

// Parked pill's send icon: background.js cached this delivery's original
// payload in recentTerminalSends (see finishSend) precisely so this can
// re-queue it without content.js having to remember/reconstruct the text
// itself. entry.jobId rides along so background can still refetch the
// result from the relay (result.php) if that cache already expired --
// see the ccsw-pending-redeliver listener there. Response-aware (unlike
// most other ccsw-* runtime messages here) so a cache-miss-with-no-jobId
// outcome can surface as a toast instead of failing silently.
function requestPendingRedeliver(entry) {
  console.log(`[CCswitchboard] pending-delivery pill ${entry.sendKey}: requesting manual redeliver.`);
  chrome.runtime.sendMessage({ type: 'ccsw-pending-redeliver', key: entry.sendKey, tabId: entry.tabId ?? null, jobId: entry.jobId ?? null })
    .then((response) => {
      if (!response?.ok) showRescueToast("Can't redeliver -- payload expired");
    })
    .catch((err) => {
      console.warn(`[CCswitchboard] pending-delivery pill ${entry.sendKey}: redeliver request failed:`, err.message);
      handlePossibleContextInvalidation(err);
    });
}

// Waiting pill's send icon (#65): unlike the parked icon above, there's
// nothing parked to re-queue -- the delivery is still sitting in
// background.js's pendingSends, most likely held on the atomic send gate
// (composer busy, Claude generating, etc). This asks background to force an
// immediate re-check of that gate for THIS key specifically, same mechanism
// D4's triggerFlushForTab uses for a just-landed user send, just prioritised
// to this one key rather than whatever already happens to be its tab's
// queue head. If the gate is still held afterwards, the response carries the
// current hold reason so it can be surfaced rather than the click just
// silently doing nothing.
function requestForceFlush(entry) {
  console.log(`[CCswitchboard] pending-delivery pill ${entry.sendKey}: requesting forced flush.`);
  chrome.runtime.sendMessage({ type: 'ccsw-pending-force-flush', key: entry.sendKey, tabId: entry.tabId ?? null })
    .then((response) => {
      if (!response?.ok) showRescueToast(`Can't send yet -- ${response?.reasonHuman || 'composer busy'}`);
    })
    .catch((err) => {
      console.warn(`[CCswitchboard] pending-delivery pill ${entry.sendKey}: forced-flush request failed:`, err.message);
      handlePossibleContextInvalidation(err);
    });
}

function schedulePendingDeliveryCollapse(pillKey, entry) {
  clearTimeout(entry.collapseTimer);
  entry.collapseTimer = setTimeout(() => collapsePendingDeliveryPill(pillKey), PENDING_DELIVERY_SENT_COLLAPSE_MS);
}

function collapsePendingDeliveryPill(pillKey) {
  const entry = activeToolbarJobs.get(pillKey);
  if (!entry || !entry.pendingDelivery) return;
  hideHovercardIfOwnedBy(pillKey, entry.headerEl);
  // #12b S2: exit-animation chain fires dispose as its final callback (was
  // barEl.remove() + activeToolbarJobs.delete). The hovercard is hidden up
  // front (above) so the card doesn't linger through the 500ms fold; dispose
  // (idempotent) removes the node once at the end. dispose also clears
  // entry.collapseTimer via its *Timer sweep.
  animatePillExit(entry.barEl, () => pillRegistry.dispose(pillKey));
}

// Delivered/parked history row -- same shape/plumbing as recordDroppedSessionJob,
// just for a pendingSends terminal outcome instead of a 409 drop. Guarded by
// id so re-showing an already-collapsed pill (e.g. a stray duplicate
// broadcast) never double-records the same delivery into history.
function recordPendingDeliverySessionJob(entry) {
  const id = `pd-${entry.sendKey}`;
  const status = entry.state === 'sent' ? 'delivered' : 'parked';

  // A parked pill's "send now" retry (see requestPendingRedeliver) can
  // succeed on a later attempt -- this same sendKey then comes back through
  // here again with state 'sent'. Update the existing row in place rather
  // than skip, or a retry that actually landed would stay stuck showing
  // 'parked' in the SW-menu history forever.
  const existing = sessionJobs.find((j) => j.id === id);
  if (existing) {
    if (existing.status === status) return; // already recorded at this outcome
    existing.status = status;
    existing.time = Date.now();
    if (existing.thread) updateStoredThreadJobStatus(existing.thread, id, status);
    if (isSwMenuOpen()) renderSwMenuPanel();
    return;
  }

  const name = entry.label ? `${entry.kindLabel || entry.kind || 'Message'} - ${entry.label}` : (entry.kindLabel || entry.kind || 'Message');
  const job = { id, thread: entry.thread || null, name, summary: entry.preview || '', time: Date.now(), status, pendingDelivery: true, waiting: false };
  sessionJobs.push(job);
  if (entry.thread) {
    hydrateSessionJobsForThread(entry.thread);
    appendStoredThreadJob(entry.thread, job);
    capSessionJobsForThread(entry.thread);
  }
  updateFaviconForJobState();
}

// Fresh-at-open rendering (same convention as renderDroppedPanelContent/
// renderHeldPanelContent) for the pending-delivery pill's expanded box.
function renderPendingDeliveryPanelContent(entry) {
  const el = entry.contentEl;
  el.textContent = '';

  const nameEl = document.createElement('div');
  nameEl.className = 'ccsw-job-bar-dropped-name';
  nameEl.textContent = entry.label || entry.kindLabel || entry.kind || 'Message';
  el.appendChild(nameEl);

  const statusEl = document.createElement('div');
  statusEl.className = 'ccsw-job-bar-dropped-status-line';
  statusEl.textContent = entry.state === 'sent'
    ? 'Sent to chat'
    : entry.state === 'parked'
      ? `Parked - manual send needed${entry.parkReasonHuman ? ` (${entry.parkReasonHuman})` : ''}`
      : `Queued${entry.waitReasonHuman ? ` - waiting: ${entry.waitReasonHuman}` : ''}`;
  el.appendChild(statusEl);

  if (entry.preview) {
    const previewEl = document.createElement('div');
    previewEl.className = 'ccsw-job-bar-dropped-summary-line';
    previewEl.textContent = entry.preview;
    el.appendChild(previewEl);
  }
}

// Creates (on first sight of `sendKey`) or updates (every later broadcast for
// the same key) this tab's pending-delivery pill. Never added to pillOrder/
// bumpPillRecency -- like the dropped/held pills, it's exempt from
// TOOLBAR_VISIBLE_CAP so a payload queued behind a busy pill stack still
// stays visible; its own lifecycle (schedulePendingDeliveryCollapse, or the
// close button) is what removes it, not the recency cap.
function showPendingDeliveryPill(sendKey, data) {
  const pillKey = pendingDeliveryPillKey(sendKey);
  // #12b S3: get-or-create routed through the registry's ensure (upsert). The
  // factory runs ONLY when the pd:<sendKey> entry is absent; when it already
  // exists the live entry is returned untouched and the in-place field
  // mutation below (~11 fields) updates it exactly as before. This path needs
  // ensure, not create -- a repeat broadcast for the same key must update, not
  // be refused.
  const entry = pillRegistry.ensure(pillKey, () => {
    const barEl = document.createElement('div');
    barEl.className = 'ccsw-job-bar ccsw-job-bar--pending-delivery';

    const headerEl = document.createElement('div');
    headerEl.className = 'ccsw-job-bar-header';
    headerEl.addEventListener('click', () => toggleJobBar(pillKey));

    const spinnerEl = document.createElement('span');
    spinnerEl.className = 'ccsw-spinner';
    ensureSpinnerLogo(spinnerEl);

    const idEl = document.createElement('span');
    idEl.className = 'ccsw-job-bar-id';

    // #65: never hidden -- present in all three states (see the state sync
    // below), same "always there" floor rule as the terminal job box's send
    // icon (#64). 'pending' forces an immediate flush attempt for this key;
    // 'parked' re-queues (or, on an expired cache, refetches) the original
    // payload; 'sent' is disabled, just a confirmation it already went out.
    const sendEl = document.createElement('button');
    sendEl.type = 'button';
    sendEl.className = 'ccsw-job-bar-send-btn';
    sendEl.setAttribute('aria-label', 'Send now');
    sendEl.appendChild(buildSendIcon());
    sendEl.addEventListener('click', (evt) => {
      evt.stopPropagation();
      const current = activeToolbarJobs.get(pillKey);
      if (!current) return;
      if (current.state === 'parked') requestPendingRedeliver(current);
      else if (current.state === 'pending') requestForceFlush(current);
    });

    const closeEl = document.createElement('button');
    closeEl.type = 'button';
    closeEl.className = 'ccsw-job-bar-close';
    closeEl.title = 'Dismiss';
    closeEl.textContent = '×';
    closeEl.addEventListener('click', (evt) => {
      evt.stopPropagation();
      dismissPendingDeliveryPill(pillKey);
    });

    headerEl.append(spinnerEl, idEl, sendEl, closeEl);

    const panelEl = document.createElement('div');
    panelEl.className = 'ccsw-job-bar-panel ccsw-job-bar-panel--dropped';
    const contentEl = document.createElement('div');
    contentEl.className = 'ccsw-job-bar-dropped-content';
    panelEl.appendChild(contentEl);

    barEl.append(headerEl, panelEl);
    getToolbarContainer().appendChild(barEl);

    return {
      pendingDelivery: true,
      sendKey,
      barEl, headerEl, idEl, sendEl, closeEl, panelEl, contentEl,
      expanded: false,
      collapseTimer: null,
      state: 'pending',
    };
  });

  entry.kind = data.kind ?? null;
  entry.kindLabel = data.kindLabel ?? null;
  entry.jobId = data.jobId ?? null;
  entry.thread = data.thread ?? null;
  entry.label = data.label ?? null;
  entry.preview = data.preview ?? '';
  entry.waitReasonHuman = data.waitReasonHuman ?? null;
  entry.parkReasonHuman = data.parkReasonHuman ?? null;
  entry.tabId = data.tabId ?? entry.tabId ?? null;
  entry.queuedAt = data.queuedAt ?? entry.queuedAt ?? null;
  entry.state = data.state ?? 'pending';

  entry.idEl.textContent = buildPendingDeliveryLabel(entry);
  if (!entry.expanded) entry.headerEl.title = entry.preview || '';

  entry.barEl.classList.toggle('ccsw-job-bar--pending-sent', entry.state === 'sent');
  entry.barEl.classList.toggle('ccsw-job-bar--pending-parked', entry.state === 'parked');

  entry.sendEl.disabled = entry.state === 'sent';
  entry.sendEl.title = entry.state === 'sent'
    ? 'Already sent'
    : entry.state === 'parked'
      ? 'Send now'
      : 'Send now (force past the wait)';

  if (entry.expanded) renderPendingDeliveryPanelContent(entry);

  if (entry.state === 'sent') {
    recordPendingDeliverySessionJob(entry);
    schedulePendingDeliveryCollapse(pillKey, entry);
  } else if (entry.state === 'parked') {
    recordPendingDeliverySessionJob(entry);
    clearTimeout(entry.collapseTimer);
    entry.collapseTimer = null;
  }

  return entry;
}

// Reconciles this tab's pending-delivery pills against background.js's
// broadcast (see broadcastQueueStateForTab): every entry in the message gets
// created/updated, and any pill this tab still has for a key that's no
// longer mentioned -- which only happens if a terminal broadcast for it was
// somehow missed (finishSend always rides one along, so this is a defensive
// backstop, not the normal removal path) -- is dropped immediately rather
// than left showing stale state forever.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-pending-delivery-state') return false;
  const entries = Array.isArray(message.entries) ? message.entries : [];
  const seenKeys = new Set();
  for (const item of entries) {
    if (!item?.key) continue;
    seenKeys.add(item.key);
    showPendingDeliveryPill(item.key, { ...item, tabId: message.tabId });
  }
  for (const [pillKey, entry] of activeToolbarJobs) {
    if (!entry.pendingDelivery || entry.state !== 'pending') continue;
    if (seenKeys.has(entry.sendKey)) continue;
    collapsePendingDeliveryPill(pillKey);
  }
  // D2b: after every create/update/remove above, refold this tab's pending
  // outputs into (or out of) the merged "N outputs pending" pill so the count
  // and the single-vs-merged display track the current queue live.
  reconcilePendingDeliveryMerge();
  return false;
});

// --- D2b: merged pending-delivery pill -----------------------------------
// When two or more outputs are queued for delivery to THIS tab at once, the
// per-key pending pills (showPendingDeliveryPill above) stack the toolbar with
// near-identical "waiting" rows. This folds every such pill in a group into a
// SINGLE "N outputs pending" pill whose expanded panel lists the individual
// outputs -- each keeping the same id/preview it shows standalone and the same
// per-item "send now"/dismiss actions. It is purely a DISPLAY fold over the
// existing per-key pills: showPendingDeliveryPill still owns each entry, its
// state, and its timers; members are only HIDDEN while merged, never
// destroyed, so dispatch/delivery/dedup/exactly-once are all untouched.
//
// Only calm 'pending' (blue "waiting") outputs merge. A 'sent' pill is a
// transient delivered-confirmation on its way out, and a 'parked' pill is a
// loud manual-action demand; neither should be silently folded into a count
// (same spirit as never merging dropped/held/stale pills). Grouped by thread
// so outputs bound for different threads in the same tab don't share a total;
// threadless (bash) outputs share one tab-level bucket.
const MERGE_PENDING_THRESHOLD = 2;

function pendingDeliveryGroupKey(entry) {
  return entry.thread ? `thread:${entry.thread}` : 'tab';
}

function mergedPendingPillKey(groupKey) {
  return `pdm:${groupKey}`;
}

function buildMergedPendingLabel(count) {
  return `${count} output${count === 1 ? '' : 's'} pending`;
}

// Removes a single pending-delivery pill -- its own header close button, or a
// dismiss button on a row of the merged list -- then reconciles so the running
// total / revert-to-single display stays correct after the removal.
function dismissPendingDeliveryPill(pillKey) {
  // #12b S2: single disposer (was clearTimeout(collapseTimer) +
  // hideHovercardIfOwnedBy + barEl.remove() + activeToolbarJobs.delete). The
  // has-guard is kept so an absent key still skips reconcile exactly as
  // before (dispose is a no-op on a missing entry, but we must not reconcile
  // for a dismiss that removed nothing). A manual X-dismiss stays instant --
  // dispose never animates.
  if (!activeToolbarJobs.has(pillKey)) return;
  pillRegistry.dispose(pillKey);
  reconcilePendingDeliveryMerge();
}

// The live set of mergeable outputs for a group -- recomputed on demand (never
// cached) so both the count and the expanded list always reflect
// activeToolbarJobs as it stands right now, however many broadcasts have added
// or delivered outputs since the merged pill was created. Oldest-first (by
// enqueue time), matching the order the standalone pills would have stacked.
function mergedPendingMembers(groupKey) {
  const members = [];
  for (const [pillKey, entry] of activeToolbarJobs) {
    if (!entry.pendingDelivery || entry.state !== 'pending') continue;
    if (pendingDeliveryGroupKey(entry) !== groupKey) continue;
    members.push({ pillKey, entry });
  }
  members.sort((a, b) => (a.entry.queuedAt ?? 0) - (b.entry.queuedAt ?? 0));
  return members;
}

function setMergedMemberHidden(entry, hidden) {
  if (entry.mergedHidden === hidden) return;
  entry.mergedHidden = hidden;
  entry.barEl.classList.toggle('ccsw-job-bar--merged-hidden', hidden);
}

// Expanded-panel content for the merged pill -- rebuilt fresh on every open
// AND on every reconcile-while-open (see showOrUpdateMergedPendingPill), so an
// output added or delivered while the panel is showing updates the list in
// place. Each row carries the same identifying info the standalone pill shows
// (kind/thread label, job id, preview) and the same two actions: "send now"
// (force past the wait -- the same requestForceFlush the standalone pill's
// send icon calls) and dismiss.
function renderMergedPendingPanelContent(mergedEntry) {
  const el = mergedEntry.contentEl;
  el.textContent = '';
  const members = mergedPendingMembers(mergedEntry.groupKey);

  const listEl = document.createElement('div');
  listEl.className = 'ccsw-pd-merged-list';

  for (const { pillKey, entry } of members) {
    const rowEl = document.createElement('div');
    rowEl.className = 'ccsw-pd-merged-row';

    const mainEl = document.createElement('div');
    mainEl.className = 'ccsw-pd-merged-row-main';

    const nameEl = document.createElement('div');
    nameEl.className = 'ccsw-pd-merged-row-name';
    nameEl.textContent = entry.label || entry.kindLabel || entry.kind || 'Message';
    mainEl.appendChild(nameEl);

    const metaBits = [];
    if (entry.jobId) metaBits.push(`job ${entry.jobId}`);
    if (entry.waitReasonHuman) metaBits.push(`waiting: ${entry.waitReasonHuman}`);
    if (metaBits.length) {
      const metaEl = document.createElement('div');
      metaEl.className = 'ccsw-pd-merged-row-meta';
      metaEl.textContent = metaBits.join(' - ');
      mainEl.appendChild(metaEl);
    }

    if (entry.preview) {
      const previewEl = document.createElement('div');
      previewEl.className = 'ccsw-pd-merged-row-preview';
      previewEl.textContent = entry.preview;
      mainEl.appendChild(previewEl);
    }

    const actionsEl = document.createElement('div');
    actionsEl.className = 'ccsw-pd-merged-row-actions';

    const sendEl = document.createElement('button');
    sendEl.type = 'button';
    sendEl.className = 'ccsw-job-bar-send-btn';
    sendEl.setAttribute('aria-label', 'Send now');
    sendEl.title = 'Send now (force past the wait)';
    sendEl.appendChild(buildSendIcon());
    sendEl.addEventListener('click', (evt) => {
      evt.stopPropagation();
      const current = activeToolbarJobs.get(pillKey);
      if (current && current.state === 'pending') requestForceFlush(current);
    });

    const dismissEl = document.createElement('button');
    dismissEl.type = 'button';
    dismissEl.className = 'ccsw-job-bar-close';
    dismissEl.title = 'Dismiss';
    dismissEl.textContent = '×';
    dismissEl.addEventListener('click', (evt) => {
      evt.stopPropagation();
      dismissPendingDeliveryPill(pillKey);
    });

    actionsEl.append(sendEl, dismissEl);
    rowEl.append(mainEl, actionsEl);
    listEl.appendChild(rowEl);
  }

  el.appendChild(listEl);
}

// Creates (first time a group crosses the threshold) or updates the merged
// pill for a group. Structurally the same header/panel shape as a standalone
// pending pill, minus the send/close header controls -- those live per-row in
// the expanded list, since the merged pill acts on the whole group by
// expanding, not by a single action. Reuses the shared toggleJobBar/
// ccsw-job-bar-panel--dropped expand interaction the dropped/held/pending
// pills already use.
function showOrUpdateMergedPendingPill(groupKey, count) {
  const pillKey = mergedPendingPillKey(groupKey);
  // #12b S3: get-or-create routed through the registry's ensure (upsert). The
  // factory builds the merged pill only on first sight of this group; on every
  // later call the existing entry is returned and the label/title update below
  // refreshes the count in place. ensure, not create -- a growing group must
  // update the same merged pill, not be refused.
  const entry = pillRegistry.ensure(pillKey, () => {
    const barEl = document.createElement('div');
    barEl.className = 'ccsw-job-bar ccsw-job-bar--pending-delivery ccsw-job-bar--pending-merged';

    const headerEl = document.createElement('div');
    headerEl.className = 'ccsw-job-bar-header';
    headerEl.addEventListener('click', () => toggleJobBar(pillKey));

    const spinnerEl = document.createElement('span');
    spinnerEl.className = 'ccsw-spinner';
    ensureSpinnerLogo(spinnerEl);

    const idEl = document.createElement('span');
    idEl.className = 'ccsw-job-bar-id';

    headerEl.append(spinnerEl, idEl);

    const panelEl = document.createElement('div');
    panelEl.className = 'ccsw-job-bar-panel ccsw-job-bar-panel--dropped ccsw-job-bar-panel--pending-merged';
    const contentEl = document.createElement('div');
    contentEl.className = 'ccsw-job-bar-dropped-content';
    panelEl.appendChild(contentEl);

    barEl.append(headerEl, panelEl);
    getToolbarContainer().appendChild(barEl);

    return {
      pendingMerged: true,
      groupKey,
      barEl, headerEl, idEl, panelEl, contentEl,
      expanded: false,
    };
  });

  entry.idEl.textContent = buildMergedPendingLabel(count);
  entry.headerEl.title = entry.expanded ? '' : buildMergedPendingLabel(count);
  if (entry.expanded) renderMergedPendingPanelContent(entry);
}

// Single source of truth for the fold. Called after every broadcast reconcile
// and after every manual dismiss. Tallies the calm 'pending' outputs per
// group; for each group at or above the threshold it hides the members and
// shows the merged pill, and for every group below it shows the members and
// tears the merged pill down -- so the display reverts to single pills the
// instant the count drops to one, and the merged pill vanishes at zero.
function reconcilePendingDeliveryMerge() {
  const groups = new Map();
  for (const [, entry] of activeToolbarJobs) {
    if (!entry.pendingDelivery || entry.state !== 'pending') continue;
    const g = pendingDeliveryGroupKey(entry);
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }

  const mergedGroups = new Set();
  for (const [g, count] of groups) {
    if (count >= MERGE_PENDING_THRESHOLD) mergedGroups.add(g);
  }

  // Hide the members of every merged group; keep every other pending output
  // (and any member that has since gone 'sent'/'parked') visible as its own
  // pill.
  for (const [, entry] of activeToolbarJobs) {
    if (!entry.pendingDelivery) continue;
    const shouldHide = entry.state === 'pending' && mergedGroups.has(pendingDeliveryGroupKey(entry));
    setMergedMemberHidden(entry, shouldHide);
  }

  // Create/update a merged pill for each qualifying group...
  for (const g of mergedGroups) {
    showOrUpdateMergedPendingPill(g, groups.get(g));
  }
  // ...and tear down any merged pill whose group dropped below the threshold
  // (down to one output, or to zero). Deleting the current key mid-iteration
  // over a Map is safe.
  for (const [mergedKey, mergedEntry] of activeToolbarJobs) {
    if (!mergedEntry.pendingMerged) continue;
    if (mergedGroups.has(mergedEntry.groupKey)) continue;
    // #12b S2: single disposer (was hideHovercardIfOwnedBy + barEl.remove() +
    // activeToolbarJobs.delete). Deleting the current key mid-iteration over a
    // Map is still safe. The merged pill owns no timers, so this is a pure
    // teardown; the members it was folding stay untouched (they're separate
    // entries, un-hidden by setMergedMemberHidden above this loop).
    pillRegistry.dispose(mergedKey);
  }
}

// --- #12b: dropped-pill twin cleanup -------------------------------------
// A block that was dropped (repo locked, see showDroppedJobBar) can later
// dispatch successfully under the SAME stableKey -- e.g. a manual "Re-fire"
// from a different pill, or the repo freeing up and Claude re-emitting the
// block. Without this, the original dropped pill just sits there forever,
// looking like the job never ran even though an identical one now has.
const DROPPED_TWIN_COLLAPSE_MS = 30000;

function renderSupersededPanelContent(entry) {
  const el = entry.contentEl;
  el.textContent = '';
  const msgEl = document.createElement('div');
  msgEl.className = 'ccsw-job-bar-dropped-status-line';
  msgEl.textContent = `superseded - already ran as job ${entry.supersededByJobId}`;
  el.appendChild(msgEl);
}

function supersedeDroppedPill(recordId, entry, jobId) {
  entry.superseded = true;
  entry.supersededByJobId = jobId;
  hideHovercardIfOwnedBy(recordId, entry.headerEl);
  entry.barEl.classList.add('ccsw-job-bar--superseded');
  // The block already ran under the new job id -- re-firing this pill's
  // stashed copy would just dispatch a duplicate, so the affordance to do
  // that has to go, not just get relabeled.
  if (entry.refireEl) {
    entry.refireEl.remove();
    entry.refireEl = null;
  }
  if (entry.expanded) renderSupersededPanelContent(entry);
  clearTimeout(entry.collapseTimer);
  entry.collapseTimer = setTimeout(() => {
    hideHovercardIfOwnedBy(recordId, entry.headerEl);
    // #12b S2: the exit-animation chain fires dispose as its FINAL callback
    // (was barEl.remove() + activeToolbarJobs.delete) -- animatePillExit runs
    // first, dispose only removes the node once, and its idempotence means a
    // manual close mid-animation can't double-remove.
    animatePillExit(entry.barEl, () => pillRegistry.dispose(recordId));
  }, DROPPED_TWIN_COLLAPSE_MS);
}

// Called from dispatchCcswBlock's ok-path (see below) with the stableKey the
// dispatch just succeeded under -- resolves every lingering dropped pill in
// THIS tab sharing that key. Normally at most one, but a loop costs nothing
// and covers the (unlikely) case of more than one stashed retry landing.
function resolveSupersededDroppedTwin(stableKey, jobId) {
  if (!stableKey) return;
  for (const [recordId, entry] of activeToolbarJobs) {
    if (!entry.dropped || entry.superseded || entry.stableKey !== stableKey) continue;
    console.log(`[CCswitchboard] dropped pill ${recordId}: superseded by job ${jobId} (same stableKey), resolving.`);
    supersedeDroppedPill(recordId, entry, jobId);
  }
}

// A content script's fetch() is bound by the PAGE's (claude.ai's) CORS
// policy in MV3 -- this extension's host_permissions cross-origin bypass
// only applies to its own privileged contexts (the background service
// worker, popup, etc.), not to code injected into a page. So the actual
// POST to job.php happens in background.js; this just hands it the parsed
// payload and reports whatever comes back.
// better-voices guarded helper -- must never throw. betterVoices is only
// defined here if manifest.json's better-voices.web.js content script
// loaded ahead of this file.
function normalizeForSpeech(text) {
  if (typeof betterVoices === 'undefined') return text;
  try {
    return betterVoices.normalize(text, 'webspeech');
  } catch {
    return text;
  }
}

// Derives a job's display name ONCE, at dispatch time -- the start
// announcement, the toolbar pill, and the SW menu row all consume this same
// value instead of each applying their own ad-hoc fallback, so an unnamed
// block reads as "Job"/"Bash job" everywhere rather than a numeric id in one
// place and the literal word "undefined" in another.
function deriveJobDisplayName(name, isBash) {
  if (typeof name === 'string' && name.trim()) return name.trim();
  return isBash ? 'Bash job' : 'Job';
}

// Announces a successful dispatch by voice only -- this is the ghost-pill
// morph point (see addJobBar's reuseGhost path), so it's the earliest moment
// a job name/id actually exists. No popup; failed/invalid dispatches never
// reach this function.
function speakJobStart(jobId, thread, name) {
  if (!('speechSynthesis' in window)) {
    console.warn(`[CCswitchboard] job ${jobId}: speechSynthesis not available, skipping start announcement.`);
    return;
  }
  const label = name || `job ${jobId}`;
  // Bash-type blocks carry no thread field -- fall back to this tab's own
  // hydrated identity before dropping the segment entirely, so the spoken
  // phrase never reads "Starting undefined - ...".
  const resolvedThread = (typeof thread === 'string' && thread.trim())
    ? thread.trim()
    : (typeof hydratedThread === 'string' && hydratedThread.trim() ? hydratedThread.trim() : null);
  const phrase = resolvedThread ? `Starting ${resolvedThread} - ${label}` : `Starting ${label}`;
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(normalizeForSpeech(phrase)));
}

// --- zombie content-script banner -------------------------------------------
// background.js's reinjectClaudeTabs() (see top-of-file comment) only fixes
// up tabs at the moment the extension reloads -- a tab that was already open
// and already ran this content script keeps that same instance alive against
// the now-torn-down background context. Every chrome.runtime/chrome.storage
// call it makes after that throws "Extension context invalidated.", and
// there's no way to recover short of the user refreshing the tab so a fresh
// instance loads. Surfaced once per zombie state (not once per failed call)
// since a zombie tab can rack up many failures in a row once it starts.
const CONTEXT_INVALIDATED_MESSAGE = 'Extension context invalidated';
let disconnectedBannerShown = false;

function isContextInvalidatedError(err) {
  return typeof err?.message === 'string' && err.message.includes(CONTEXT_INVALIDATED_MESSAGE);
}

// chrome.runtime.id reads as undefined once this content script's extension
// context is actually torn down, and any live call the zombie code path still
// makes (e.g. getURL) throws too. A backgrounded/unfocused tab can throw the
// same "Extension context invalidated" message transiently without the
// context truly being gone, so this is the real liveness check the banner
// gates on rather than trusting the error message alone.
function isExtensionContextAlive() {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id && typeof chrome.runtime.getURL('') === 'string';
  } catch (err) {
    return false;
  }
}

function showDisconnectedBanner() {
  if (disconnectedBannerShown) return;
  disconnectedBannerShown = true;

  // Best-effort: the extension context is (probably) already dead, so this
  // message likely never lands. Logged anyway -- if the context turns out to
  // still be alive, the disconnect is exactly the event worth having.
  logEvent('disconnect', { url: location.href });

  const banner = document.createElement('div');
  banner.id = 'ccsw-disconnected-banner';
  banner.textContent = 'CCswitchboard disconnected -- refresh this tab';
  document.body.appendChild(banner);

  if ('speechSynthesis' in window) {
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(normalizeForSpeech('Refresh this tab')));
  }
}

// Board-cookie diagnostic toast: fired on every "Open board" click so a
// failed background.js ccsw-set-board-cookie result (e.g. the 'cookies'
// permission not actually active, or the set silently rejected) is visible
// instead of falling through to the token gate with no explanation --
// exactly the failure 131100a shipped undiagnosable. Auto-dismisses; the
// error case stays up longer since there's more to read.
const BOARD_COOKIE_TOAST_OK_MS = 2500;
const BOARD_COOKIE_TOAST_ERROR_MS = 12000;

function showBoardCookieToast(result) {
  const existing = document.getElementById('ccsw-board-cookie-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'ccsw-board-cookie-toast';
  if (result?.ok) {
    toast.classList.add('ccsw-board-cookie-toast--ok');
    toast.textContent = 'board cookie set OK';
  } else {
    toast.classList.add('ccsw-board-cookie-toast--error');
    const stage = result?.stage ?? 'unknown';
    const error = result?.error ?? 'no response from background';
    toast.textContent = `board cookie NOT set [${stage}]: ${error}`;
  }
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), result?.ok ? BOARD_COOKIE_TOAST_OK_MS : BOARD_COOKIE_TOAST_ERROR_MS);
}

const CONTEXT_RECHECK_DELAY_MS = 250;

// Call from any dispatch/messaging catch block once an error is in hand --
// a no-op unless that error is actually the zombie-context signature. Even
// then, don't take the error message's word for it: a transient blip (e.g. a
// backgrounded/unfocused tab) can throw the same message without the context
// truly being gone, so confirm with a real liveness check -- and give it one
// short retry -- before surfacing the banner.
async function handlePossibleContextInvalidation(err) {
  if (!isContextInvalidatedError(err)) return;
  if (isExtensionContextAlive()) return;

  await new Promise((resolve) => setTimeout(resolve, CONTEXT_RECHECK_DELAY_MS));
  if (isExtensionContextAlive()) return;

  showDisconnectedBanner();
}

// claude.ai's renderer occasionally injects non-JSON artifacts into long
// code blocks -- zero-width/BOM characters, NBSP, or curly quotes swapped in
// for straight ones -- any one of which makes JSON.parse throw on an
// otherwise-valid block. Strips known artifact classes and reports which
// ones were found, so a sanitized retry can confirm the cause instead of
// the block silently vanishing.
function sanitizeCcswBlockText(text) {
  const foundClasses = [];
  let sanitized = text;

  // zero-width space, BOM, zero-width non-joiner, zero-width joiner
  if (/[\u200B\uFEFF\u200C\u200D]/.test(sanitized)) {
    foundClasses.push('zero-width/BOM characters');
    sanitized = sanitized.replace(/[\u200B\uFEFF\u200C\u200D]/g, '');
  }
  // non-breaking space
  if (/\u00A0/.test(sanitized)) {
    foundClasses.push('non-breaking spaces');
    sanitized = sanitized.replace(/\u00A0/g, ' ');
  }
  // curly/smart double quotes -- the plain left/right pair (U+201C/U+201D) plus
  // the low-9 (U+201E) and reversed high-9 (U+201F) variants an LLM occasionally
  // emits. All are unambiguous stand-ins for a straight " so the swap is safe.
  if (/[\u201C\u201D\u201E\u201F]/.test(sanitized)) {
    foundClasses.push('curly double quotes');
    sanitized = sanitized.replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  }
  // curly/smart single quotes -- left/right (U+2018/U+2019) plus the low-9
  // (U+201A) and reversed high-9 (U+201B) variants. Same safe 1:1 swap to '.
  if (/[\u2018\u2019\u201A\u201B]/.test(sanitized)) {
    foundClasses.push('curly single quotes');
    sanitized = sanitized.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
  }

  // Structural cleanup that must respect string boundaries -- a single
  // string-aware pass so neither fix can touch string CONTENT (e.g. a literal
  // "1,}" or a sentence with a real comma) and mis-parse a truncated block. It
  // walks the (already quote-normalized) text tracking whether the cursor is
  // inside a JSON string, and applies two deterministic repairs:
  //   (a) trailing commas: a comma whose next non-whitespace char is } or ] and
  //       that sits OUTSIDE a string is structural junk JSON.parse rejects; drop
  //       it. A comma inside a string is left untouched.
  //   (b) raw newline/tab (and CR) INSIDE a string value: JSON forbids literal
  //       control chars in strings, so escape them to \n / \t / \r. Raw newlines
  //       and tabs OUTSIDE strings are valid JSON whitespace and left as-is.
  // Nothing here guesses at missing braces/quotes or otherwise repairs a
  // genuinely truncated block -- both fixes are exact and reversible in intent.
  {
    let out = '';
    let inString = false;
    let escaped = false;
    let droppedTrailingComma = false;
    let escapedControlChar = false;
    for (let i = 0; i < sanitized.length; i++) {
      const ch = sanitized[i];
      if (inString) {
        if (escaped) {
          out += ch;
          escaped = false;
        } else if (ch === '\\') {
          out += ch;
          escaped = true;
        } else if (ch === '"') {
          out += ch;
          inString = false;
        } else if (ch === '\n') {
          out += '\\n';
          escapedControlChar = true;
        } else if (ch === '\t') {
          out += '\\t';
          escapedControlChar = true;
        } else if (ch === '\r') {
          out += '\\r';
          escapedControlChar = true;
        } else {
          out += ch;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        out += ch;
      } else if (ch === ',') {
        // Look ahead past insignificant whitespace: a comma immediately before a
        // closing brace/bracket is trailing and gets dropped.
        let j = i + 1;
        while (j < sanitized.length && /\s/.test(sanitized[j])) j++;
        if (j < sanitized.length && (sanitized[j] === '}' || sanitized[j] === ']')) {
          droppedTrailingComma = true;
          // skip emitting the comma
        } else {
          out += ch;
        }
      } else {
        out += ch;
      }
    }
    if (droppedTrailingComma) foundClasses.push('trailing commas');
    if (escapedControlChar) foundClasses.push('raw newlines/tabs in strings');
    sanitized = out;
  }

  return { sanitized, foundClasses };
}

// The ONE way to turn a raw block's text into its parsed payload.
//
// Returns { parsed, usedSanitize, foundClasses, error }. `parsed` is null if the
// text isn't recoverable as JSON; the other fields carry everything a caller
// needs to log WHY, so neither caller has to re-run sanitizeCcswBlockText to
// find out.
//
// BUG FIX (identity blindness on sanitized blocks): scan() used to parse with a
// bare JSON.parse while dispatchCcswBlock retried through sanitizeCcswBlockText.
// A block carrying a curly quote or a stray zero-width space -- routine in
// LLM-authored JSON -- therefore parsed for DISPATCH but not for IDENTITY: scan
// saw stableKey=null, so rule (a) could never recognise it as already-dispatched
// and the inFlightDispatch guard never engaged for it. It re-fired a fresh
// duplicate job on every anchor recreation. Both callers now parse identically,
// so a block that can dispatch always has the identity that suppresses it.
function parseCcswBlockText(text) {
  try {
    return { parsed: JSON.parse(text), usedSanitize: false, foundClasses: [], error: null };
  } catch (err) {
    const { sanitized, foundClasses } = sanitizeCcswBlockText(text);
    if (foundClasses.length === 0) {
      return { parsed: null, usedSanitize: false, foundClasses, error: err.message };
    }
    try {
      return { parsed: JSON.parse(sanitized), usedSanitize: true, foundClasses, error: err.message };
    } catch (retryErr) {
      return { parsed: null, usedSanitize: true, foundClasses, error: retryErr.message };
    }
  }
}

// --- Self-heal JSON feedback loop -----------------------------------------
// At most this many feedback messages per broken block before we give up and
// show the red ghost. The cap is what makes the loop provably terminating:
// each broken re-emission of the same block increments its counter, and once
// the counter reaches the cap we stop feeding back entirely (see
// dispatchCcswBlock's parse-null branch).
const SELF_HEAL_MAX_ATTEMPTS = 3;

// block-key -> feedback attempts so far. Keyed per thread by the block's
// recovered name (recoverCcswBlockName) so a re-emitted-but-still-broken block
// with the same name accumulates against the same counter; when no name can be
// recovered we fall back to a per-raw-text key, which -- because a corrected
// re-emission hashes differently -- is effectively a single attempt. Cleared
// for a key the moment a block under it finally parses (see below).
const selfHealAttempts = new Map();

// Same thread source on the failure and success sides so the counter a broken
// block accumulates is the exact one its later corrected re-emission clears:
// the parse-null branch can't read parsed.thread (there's no parse), so both
// sides key on the tab's own hydratedThread, which is stable across the broken
// and corrected emissions (they arrive in the same tab).
function selfHealBlockKey(name, rawText) {
  if (name) return `name:${hydratedThread || ''}:${name}`;
  return `raw:${hashRawBlockText(rawText)}`;
}

// Feeds the parse failure back into THIS thread's composer via the existing
// send pipeline (ccsw-deliver-to-thread -> background's queueSend), so the same
// user-text-sacred / composer-busy handling every other delivery gets applies
// here too -- we never build a parallel sender and never clobber the user's
// composer text. The message is deliberately plain prose: it names the block,
// quotes the parser's error (which already carries the position), lists any
// safe auto-fixes tried, and asks Claude to re-send just that one block. It
// must NOT itself look like a ccsw block, so it carries no code fence, no JSON
// braces, and no "name": field the scanner could mistake for a real block.
function sendSelfHealFeedback({ name, error, foundClasses, attempt }) {
  const which = name ? `the ccsw block named ${name}` : 'your last ccsw block';
  const fixes = Array.isArray(foundClasses) && foundClasses.length > 0
    ? ` I already tried the safe auto-fixes (${foundClasses.join(', ')}) and it still would not parse.`
    : '';
  const text =
    `Heads up: I ignored ${which} because it was not valid JSON, so nothing was dispatched. ` +
    `The JSON parser reported: ${error || 'could not parse the block as JSON'}.${fixes} ` +
    `Please re-send just that one block as valid JSON (only the block, nothing else). ` +
    `[CCSW self-heal attempt ${attempt} of ${SELF_HEAL_MAX_ATTEMPTS}]`;

  chrome.runtime.sendMessage({ type: 'ccsw-deliver-to-thread', thread: hydratedThread || null, text }).catch((err) => {
    handlePossibleContextInvalidation(err);
  });
}

async function dispatchCcswBlock(anchorIndex, blockText, ghostEl, stableKey) {
  // BUG FIX (in-flight dispatch guard): the ENTIRE body runs inside this
  // try/finally so the synchronous inFlightDispatch marker (added in scan()'s
  // dispatch branch BEFORE this async call) is cleared on EVERY exit path --
  // successful dispatch, 409-dropped, dispatch-failure, thrown exception, AND
  // the early invalid-JSON / plan-only bailouts below. A path that failed to
  // clear would leave the block permanently in-flight and suppress every
  // legitimate future re-dispatch of it (a dropped/failed job never ran, so
  // it MUST stay free to re-fire). finally covers all of them uniformly.
  try {
    // parseCcswBlockText is shared with scan()'s identity derivation -- see its
    // comment. The logging around it stays here, where an anchor index exists.
    //
    // DESTRUCTURE the wrapper. parseCcswBlockText returns
    // { parsed, usedSanitize, foundClasses, error } and NEVER a bare null, so
    // binding its whole return value to `parsed` (as this did) left every
    // payload field one level too deep: `parsed.prompt` and `parsed.command`
    // read undefined for every block, the plan-only bailout below fired
    // unconditionally, and NOTHING ever reached job.php -- not the automatic
    // path, not "Dispatch anyway", not "Re-fire". foundClasses comes off the
    // wrapper too, so the invalid-JSON branch no longer re-runs
    // sanitizeCcswBlockText to recover what the parse already knew.
    const { parsed, foundClasses, error } = parseCcswBlockText(blockText);
    if (parsed === null) {
      const recoveredName = recoverCcswBlockName(blockText);

      // SELF-HEAL (gated behind ccswSelfHealJson, default ON): rather than
      // going straight to the red ghost, feed the parse error back to claude.ai
      // so it re-emits a corrected block -- up to SELF_HEAL_MAX_ATTEMPTS times
      // per broken block. Keyed per thread by the recovered name (or a
      // per-raw-text fallback when no name is recoverable, which is effectively
      // a single attempt). The counter is what makes this loop-proof.
      if (selfHealJsonEnabled) {
        const key = selfHealBlockKey(recoveredName, blockText);
        const attempts = selfHealAttempts.get(key) || 0;
        if (attempts < SELF_HEAL_MAX_ATTEMPTS) {
          const attempt = attempts + 1;
          selfHealAttempts.set(key, attempt);
          console.warn(`[CCswitchboard] anchor #${anchorIndex}: ccsw block invalid JSON${foundClasses.length ? ` even after sanitizing [${foundClasses.join(', ')}]` : ''}; self-heal feedback attempt ${attempt}/${SELF_HEAL_MAX_ATTEMPTS} (${recoveredName ? `block "${recoveredName}"` : 'no recoverable name'}).`);
          logEvent('self_heal_feedback', {
            anchor: anchorIndex,
            name: recoveredName ?? null,
            attempt,
            max: SELF_HEAL_MAX_ATTEMPTS,
            error: error ?? null,
            foundClasses: foundClasses ?? [],
          });
          // Send the feedback through the existing delivery pipeline and do NOT
          // show the ghost yet. The streaming ghost is released (not morphed
          // into the red error state) since we're handling this silently for
          // now -- a corrected block will get its own fresh ghost.
          sendSelfHealFeedback({ name: recoveredName, error, foundClasses, attempt });
          removeGhostBar(ghostEl, 'self_heal_retry');
          return;
        }
        // Cap reached: fall through to the red ghost, now carrying a summary of
        // the exhausted retry history so the human sees WHY it's here.
      }

      console.warn(`[CCswitchboard] anchor #${anchorIndex}: ccsw block is not valid JSON${foundClasses.length ? ` even after sanitizing [${foundClasses.join(', ')}]` : ''}, showing error pill.`);
      // Do NOT silently removeGhostBar here -- a malformed block must stay
      // visible. Morph the ghost into a persistent, dismissable red error pill
      // (see showInvalidBlockBar) carrying the parser's real error, any safe
      // auto-fixes tried, and the block name recovered from the raw text. When
      // self-heal is enabled and exhausted, `selfHealAttempts` carries the
      // attempt count so the bar can say it failed after N self-heal tries.
      showInvalidBlockBar(ghostEl, {
        anchorIndex,
        error,
        foundClasses,
        name: recoveredName,
        selfHealAttempts: selfHealJsonEnabled ? (selfHealAttempts.get(selfHealBlockKey(recoveredName, blockText)) || 0) : 0,
      });
      return;
    }

    // SELF-HEAL: this block parsed (any valid JSON -- job, plan-only, actions,
    // etc.), so whatever broken predecessor accumulated a retry counter under
    // this same key is resolved. Clear it so a LATER, unrelated breakage of the
    // same-named block starts its self-heal budget fresh rather than inheriting
    // spent attempts. Keyed the same way the failure side is (recovered name ==
    // parsed.name for a corrected re-emission; same hydratedThread).
    if (selfHealJsonEnabled && parsed.name) {
      selfHealAttempts.delete(selfHealBlockKey(parsed.name, blockText));
    }

    if (Array.isArray(parsed.plan)) {
      renderPlanPills(parsed.plan);

      // Plan-only blocks (no prompt/command) never reach job.php below, so this
      // is the only place a plan update reaches the relay at all -- send it
      // regardless of whether this block also dispatches a job, so db.php's
      // checkPlanQuietWakes() (background.js's pollPlanWake) can track it.
      if (parsed.thread) {
        chrome.runtime.sendMessage({ type: 'ccsw-plan-update', thread: parsed.thread, plan: parsed.plan }).catch((err) => {
          handlePossibleContextInvalidation(err);
        });
      }
    }

    // Action List: Claude-authored manual-actions items, e.g.
    // {"actions": [{"text": "reload extension", "tier": "blocking"}]} -- may
    // ride alongside a real job dispatch or arrive on a standalone block with
    // no prompt/command (same plan-only-style precedent as `plan` above).
    // sendActionsAdd tags each item with the thread this block was authored
    // from, then syncs it via background.js's ccsw-actions-add handler to
    // actions.php, whence it is rendered as the persistent Action List pill
    // (see renderActionListPill). The pill still shows every thread's items.
    if (Array.isArray(parsed.actions)) {
      const validActions = parsed.actions.filter(
        (a) => a && typeof a.text === 'string' && a.text.trim() !== '' && ['blocking', 'recommended', 'nice_to_have'].includes(a.tier)
      );
      if (validActions.length > 0) {
        // #61: joins the same dispatched-ledger rule (a) job blocks use, via
        // a content-aware key (see fingerprintActionsBlock) -- a re-scan of
        // this exact block (e.g. an F5 while the recent-beacon window is
        // still open) recognises it already landed and skips re-adding it,
        // rather than re-POSTing the same items to actions.php every reload.
        const actionsThread = parsed.thread || hydratedThread;
        const actionsStableKey = fingerprintActionsBlock(actionsThread, validActions);
        if (isStableKeyDispatched(actionsThread, actionsStableKey)) {
          console.log(`[CCswitchboard] anchor #${anchorIndex}: actions block already added (stableKey ${actionsStableKey}), skipping re-add.`);
        } else {
          sendActionsAdd(validActions, parsed.thread || undefined);
          recordLocalDispatchedKey(actionsThread, actionsStableKey);
        }
      } else {
        console.warn(`[CCswitchboard] anchor #${anchorIndex}: ccsw block had an "actions" field but no valid {text, tier} items, ignoring.`);
      }
    }

    // Central debug log retrieval: {"debuglog": true}, or
    // {"debuglog": {"limit": 300, "type": "held_decision"}}. This is a FETCH,
    // not a job -- Claude is asking to read the log back, so a block carrying
    // only `debuglog` must never reach job.php (same plan-only precedent as
    // `plan`/`actions` above). background.js does the fetch (CORS) and types
    // the formatted log into this thread via the send state machine.
    if (parsed.debuglog) {
      const opts = typeof parsed.debuglog === 'object' ? parsed.debuglog : {};
      chrome.runtime
        .sendMessage({
          type: 'ccsw-debuglog-deliver',
          thread: parsed.thread ?? null,
          limit: typeof opts.limit === 'number' ? opts.limit : undefined,
          logType: typeof opts.type === 'string' ? opts.type : undefined,
        })
        .catch((err) => {
          console.warn(`[CCswitchboard] anchor #${anchorIndex}: debuglog fetch failed:`, err.message);
          handlePossibleContextInvalidation(err);
        });
    }

    // A `plan` array can ride alongside a real job dispatch or entirely in
    // place of one -- prompt/command are the only fields CcswAgent actually
    // runs (see AgentCore.cs), so their absence means this block has nothing
    // dispatchable and is plan-only. Skip job.php entirely rather than sending
    // a payload the agent would just reject as "missing prompt/model/cwd".
    if (typeof parsed.prompt !== 'string' && typeof parsed.command !== 'string') {
      console.log(`[CCswitchboard] anchor #${anchorIndex}: ccsw block has no prompt/command, treating as plan-only (no job dispatch).`);
      removeGhostBar(ghostEl, 'plan_only');
      return;
    }

    // DURABLE IDENTITY (relay-side): every dispatch that reaches job.php
    // records which block produced it, as jobs.stable_key -- read back by
    // dispatched.php and consulted as rule (a) of scan()'s eligibility rule.
    // Derived HERE, from this function's own `parsed`, rather than from the
    // `stableKey` parameter, for coverage: two call sites (the dropped-job
    // 'Re-fire' button and the held pill's 'Dispatch anyway') pass no stableKey
    // at all, so a parameter-threaded key would leave their job rows anonymous
    // -- the exact rows a later re-fire most needs to recognise.
    //
    // The `stableKey` PARAMETER remains scan()'s own handle for the synchronous
    // inFlightDispatch marker it set before calling us, and nothing else.
    //
    // Same function, same fixed-order fields, same thread argument the scan
    // path uses, so the value is identical to `stableKey` whenever both exist
    // (and it also covers the sanitized-JSON retry above, which `parsed`
    // reflects but the caller's pre-parse did not).
    const relayStableKey = fingerprintBlockStable(parsed.thread, parsed);

    // #84 (threadless-block triple-dispatch): resolved the SAME way as
    // scan()'s dedupBucket above (same explicit-thread source, same
    // conversation-URL fallback), so a block scan() decided to dispatch under
    // one bucket is recorded -- locally and on the relay -- under that exact
    // same bucket. See resolveDedupBucket's comment for why this can't just be
    // parsed.thread || hydratedThread any more.
    const relayDedupBucket = resolveDedupBucket(parsed.thread);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ccsw-dispatch',
        payload: parsed,
        thread: parsed.thread,
        continue: parsed.continue === true,
        readonly: parsed.readonly === true,
        stableKey: relayStableKey,
        dispatchBucket: relayDedupBucket,
      });
      if (response?.ok) {
        console.log(`[CCswitchboard] dispatched job ${response.id}`);
        logEvent('dispatch', { ok: true, jobId: response.id, name: parsed.name ?? null, blockThread: parsed.thread ?? null });
        // Presentational only: record this block's stableKey -> its live job so
        // the in-message job card (decorateCcswJobCards) can track its status.
        // Does not affect any dispatch/dedup decision.
        if (relayStableKey) ccswCardJobIndex.set(relayStableKey, { jobId: response.id, lastState: 'running' });
        const isBash = String(parsed.type).toLowerCase() === 'bash';
        const displayName = deriveJobDisplayName(parsed.name, isBash);
        speakJobStart(response.id, parsed.thread, displayName);
        // The pill/menu label is derived at RENDER time (renderJobBarId, the SW
        // menu row, and the poll self-heal below), NOT baked here: pass the RAW
        // name (which may be empty) plus the summary, so an unnamed job falls
        // through to its summary instead of freezing the literal 'Job' into
        // chrome.storage.local forever. deriveJobDisplayName stays for the voice
        // announcement above and the genuine no-name-no-summary case.
        addJobBar(response.id, parsed.thread, parsed.name, parsed.summary, ghostEl, isBash, 'dispatch');
        recordSessionJob(response.id, parsed.thread, parsed.name, parsed.summary, isBash);
        reconcilePlanWithDispatchedJob(response.id, parsed.name);
        // D2 #12b: this exact block may already have a lingering DROPPED
        // pill from an earlier 409 (repo was locked) -- now that it's
        // actually run, resolve that twin instead of leaving it looking
        // like the job never happened.
        resolveSupersededDroppedTwin(relayStableKey, response.id);
        // Rule (a)'s local write-through, recorded only here, on a CONFIRMED
        // successful dispatch: the relay now HAS a jobs row carrying this
        // stable_key, so the block is spent. Recording it locally means the
        // next scan sees `ignored_already` without waiting for the background
        // worker's next dispatched.php poll to bring the key back around.
        //
        // A 409/dropped or failed dispatch deliberately falls to the else
        // branch and records nothing -- that block never ran, so it must stay
        // eligible.
        //
        // Keyed on relayStableKey + relayDedupBucket (not the `stableKey`
        // parameter) so the two call sites that pass no stableKey -- the
        // dropped-job 'Re-fire' button and the held pill's 'Dispatch anyway'
        // -- also mark their block spent. Under the old in-memory guard they
        // did not, which is why a hand-dispatched held block kept its pill and
        // could be dispatched again. #84: relayDedupBucket (not
        // parsed.thread || hydratedThread) so a threadless block records under
        // the same bucket every tab on this conversation checks.
        recordLocalDispatchedKey(relayDedupBucket, relayStableKey);
        // URL-MAP CONVERGENCE (#47, item 4): a CONFIRMED dispatch is proof this
        // tab's conversation is actually being used as parsed.thread right now
        // -- if that differs from the tab's current hydrated identity (e.g.
        // this tab hydrated an old thread name from the URL map before the
        // conversation was repurposed under a new one), converge to the
        // block's declared thread so future scans' rule B beacon lookup (keyed
        // on hydratedThread, see the dispatch_decision_v2 comment in scan())
        // and the URL->thread map both track what this conversation is
        // actually dispatching under. Latest successful dispatch wins.
        // Deliberately gated on `response?.ok` (this branch only) rather than
        // held/ignored outcomes, so a stray scrollback block with a different
        // declared thread can never thrash the identity back and forth.
        if (parsed.thread && parsed.thread !== hydratedThread) {
          hydratedThread = parsed.thread;
          rememberUrlThread(parsed.thread);
        }
      } else {
        console.warn(`[CCswitchboard] anchor #${anchorIndex}: dispatch failed:`, response);
        logEvent('dispatch', {
          ok: false,
          name: parsed.name ?? null,
          blockThread: parsed.thread ?? null,
          status: response?.status ?? null,
          locked: response?.body?.locked ?? null,
          held: response?.body?.held ?? null,
        });
        if (response?.status === 409 && response.body?.locked) {
          showDroppedJobBar(ghostEl, {
            name: parsed.name,
            summary: parsed.summary,
            thread: parsed.thread,
            held: response.body.held,
            heldBy: response.body.held_by,
            blockText,
            // D2 #12b: lets a later successful dispatch of this same block
            // find and resolve this pill (see resolveSupersededDroppedTwin).
            stableKey: relayStableKey,
          });
        } else {
          // NOT a repo lock -- job.php refused or errored for some other
          // reason, so this block never ran. Surface it as a persistent red
          // pill carrying the status + a Retry, instead of the removeGhostBar
          // that used to be here: that silently dropped the job whenever the
          // caller passed no ghost (every manual dispatch path does). See
          // showDispatchFailedBar.
          showDispatchFailedBar(ghostEl, {
            anchorIndex,
            name: parsed.name,
            blockText,
            status: response?.status ?? null,
            error: response?.error ?? null,
          });
        }
      }
    } catch (err) {
      console.warn(`[CCswitchboard] anchor #${anchorIndex}: failed to message background for dispatch:`, err.message);
      handlePossibleContextInvalidation(err);
      // Same silent-loss fix as the failure branch above: the worker was
      // unreachable / the context was invalidated mid-dispatch, so the job did
      // not run. Say so on screen rather than removing the ghost (a no-op for
      // the manual paths, which pass none) and leaving nothing behind.
      showDispatchFailedBar(ghostEl, {
        anchorIndex,
        name: parsed.name,
        blockText,
        status: null,
        error: err.message,
      });
    }
  } finally {
    // Clear the synchronous in-flight marker regardless of how we exited --
    // ok, 409-dropped, dispatch-failed, thrown, or an early plan-only /
    // invalid-JSON return above. See this Set's declaration comment.
    if (stableKey) inFlightDispatch.delete(stableKey);
  }
}

// --- #14 Gate B: auto-re-fire a dropped job on its repo-free wake ---------
// A job dropped because its repo was locked (dispatchCcswBlock's 409 branch)
// becomes a dropped pill whose manual "Re-fire" button re-runs the stashed
// block once the repo frees. The relay already tracks the drop (job.php's
// pending_refires) and fires a repo-free wake when the lock releases
// (db.php's wakePendingRefires -> background.js's pollWake). This wires that
// wake to auto-perform the SAME re-fire the button does, exactly once per
// drop, so the human click is only needed on a double-failure.
//
// ONCE-PER-DROP GUARD. Keyed dedup-bucket -> Set<stableKey>, exactly like
// locallyDispatchedKeys, and marked BEFORE the (async) re-fire dispatch. This
// is what stops a loop: an auto-re-fire that 409s AGAIN re-creates a fresh
// dropped pill under the SAME stableKey and inserts a NEW pending_refires row,
// so a SECOND repo-free wake would otherwise auto-fire the same drop forever.
// Because the block re-dropped (it never dispatched), it never enters the
// dispatched ledger (isStableKeyDispatched stays false), so ONLY this set
// breaks that cycle -- the second wake finds the key already auto-attempted,
// declines, and background falls back to surfacing the pill + the plain nudge.
const autoRefiredDropKeys = new Map();

function hasAutoRefiredDrop(bucket, stableKey) {
  if (!stableKey) return false;
  return !!autoRefiredDropKeys.get(bucket)?.has(stableKey);
}

function markAutoRefiredDrop(bucket, stableKey) {
  if (!bucket || !stableKey) return;
  if (!autoRefiredDropKeys.has(bucket)) autoRefiredDropKeys.set(bucket, new Set());
  autoRefiredDropKeys.get(bucket).add(stableKey);
}

// Does this dropped pill's collision involve the repo that just freed? A drop
// records every repo it collided with (info.held's array) plus wakeRepo (the
// single repo the pill's wake-pending line names); match either, so a
// multi-repo drop is recognised whichever of its repos frees first.
function droppedPillWaitsOnRepo(entry, repo) {
  if (!repo) return false;
  if (entry.wakeRepo === repo) return true;
  if (Array.isArray(entry.held)) return entry.held.some((h) => h && h.repo === repo);
  return false;
}

// Called from the ccsw-repo-free-wake handler below. Finds a live dropped pill
// waiting on `repo` and, subject to the toggle + the two dedup guards,
// re-fires it exactly the way the pill's manual "Re-fire" button does (the
// same dispose -> removeSessionJob -> dispatchCcswBlock('dropped-refire', ...)
// path -- no parallel dispatcher). Returns true iff it actually initiated a
// re-fire, so background.js knows to ack the wake and suppress the nudge.
function tryAutoRefireDroppedForRepo(repo) {
  // Toggle OFF fully disables the automation -- the manual button stays.
  if (!autoRefireEnabled) return false;
  if (!repo) return false;

  for (const [recordId, entry] of activeToolbarJobs) {
    if (!entry.dropped || entry.superseded) continue;
    // No stashed block (a pre-#12b drop, or a historical row reopened from the
    // SW menu) -> nothing to re-fire, and no durable identity to guard on.
    if (!entry.blockText || !entry.stableKey) continue;
    if (!droppedPillWaitsOnRepo(entry, repo)) continue;

    const bucket = resolveDedupBucket(entry.thread);

    // ONCE-PER-DROP: a second repo-free wake for a drop we already auto-tried
    // must never re-fire it again (see autoRefiredDropKeys' comment).
    if (hasAutoRefiredDrop(bucket, entry.stableKey)) continue;

    // EXACTLY-ONCE LEDGER: if this exact block already dispatched (this tab or
    // another, via the durable jobs.stable_key set), the job is already
    // running/delivered -- never auto-re-fire a duplicate. The manual button
    // deliberately skips this pre-check (a human click is an intentional
    // override); the automatic path must not.
    if (isStableKeyDispatched(bucket, entry.stableKey)) continue;

    // Mark BEFORE the async dispatch so a racing re-drop + second wake can't
    // slip a second auto-fire past the guard.
    markAutoRefiredDrop(bucket, entry.stableKey);

    console.log(`[CCswitchboard] dropped job "${entry.name || 'Job'}" auto-re-fired on repo-free wake (repo "${repo}").`);
    logEvent('auto_refire', { site: 'repo-free-wake', name: entry.name || 'Job', repo, jobId: recordId });

    // Same terminal-then-dispatch order as the manual Re-fire button (see
    // showDroppedJobBar's refireEl click): dispose the stale pill, clear its
    // session-job row, then re-run the stashed block through the shared
    // dropped-refire dispatch path. The block text lives on the entry, so
    // disposing first can't lose it. No stableKey arg, same as the button --
    // dispatchCcswBlock derives its own relayStableKey from the parsed block.
    pillRegistry.dispose(recordId);
    removeSessionJob(entry.thread, recordId);
    dispatchCcswBlock('dropped-refire', entry.blockText, null);
    return true;
  }
  return false;
}

// background.js's pollWake (repo-free wake) asks this tab first, before typing
// the "repo free, reassess and re-fire" nudge: if we auto-re-fire the drop it
// acks the wake and delivers no nudge (the re-fire dispatches quietly like a
// normal job). handled:false -> background falls back to the existing nudge,
// so an older build, toggle-off, no-matching-pill, or double-failure all keep
// today's manual behaviour.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-repo-free-wake') return false;
  let handled = false;
  try {
    handled = tryAutoRefireDroppedForRepo(message.repo);
  } catch (err) {
    console.warn('[CCswitchboard] auto-re-fire on repo-free wake failed:', err.message);
    handlePossibleContextInvalidation(err);
  }
  sendResponse({ handled });
  return false;
});

// Rescue toast: transient, pill-styled notice for rescueLastBlock's outcome.
// Lives inside #ccsw-toolbar so it shows up in the same pill area as the job
// bars, but isn't tracked in activeToolbarJobs -- it's fire-and-forget, with
// no close button or click handler, just a self-removal timer.
const RESCUE_TOAST_MS = 4000;

function showRescueToast(text) {
  const existing = document.getElementById('ccsw-rescue-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'ccsw-rescue-toast';
  toast.className = 'ccsw-rescue-toast';
  toast.textContent = text;
  getToolbarContainer().appendChild(toast);

  setTimeout(() => animatePillExit(toast, () => toast.remove()), RESCUE_TOAST_MS);
}

// #53/#59 RESCUE BUTTON: manual last-resort re-scan, reachable from the SW
// menu regardless of scan()'s own state (e.g. a scan that silently missed a
// real block -- see the scan_gap diagnostic in scan() for the instrumentation
// this is a recovery valve for). Walks message anchors NEWEST -> OLDEST (capped
// at RESCUE_WALK_CAP so a long old thread can't turn one click into a
// pathological scan) until findCcswBlocks yields a hit, takes that message's
// LAST block, and dispatches it directly -- deliberately BYPASSING rules A/B
// the same way "Dispatch anyway" (dispatchHeldBlock above) and "Re-fire"
// (showDroppedJobBar above) already do: a manual click is real user
// provenance. No stableKey arg is passed, same as those two call sites --
// dispatchCcswBlock derives + records its own relayStableKey on a successful
// dispatch regardless, so this still can't double-fire on a later automatic
// scan. #59: the newest message is usually plain chat with no block at all,
// so a rescue that only ever looked there silently did nothing -- this walks
// back until it actually finds one, and surfaces the outcome either way
// (toast + urgent rescue_used event) instead of a console-only miss.
const RESCUE_WALK_CAP = 40;

async function rescueLastBlock() {
  const anchors = document.querySelectorAll(SELECTORS.feedbackButton);
  const walkCap = Math.min(anchors.length, RESCUE_WALK_CAP);
  const capHit = anchors.length > RESCUE_WALK_CAP;

  let anchorIndex = -1;
  let blocks = [];
  let anchorsWalked = 0;
  for (let i = anchors.length - 1; i >= anchors.length - walkCap; i--) {
    anchorsWalked++;
    const container = findMessageTurnContainer(anchors[i]);
    const found = findCcswBlocks(container);
    if (found.length > 0) {
      anchorIndex = i;
      blocks = found;
      break;
    }
  }

  if (anchorIndex === -1) {
    console.warn(`[CCswitchboard] rescue: no ccsw block found after walking back through ${anchorsWalked} message(s)${capHit ? ' (walk cap hit)' : ''}.`);
    showRescueToast(capHit
      ? `No ccsw block found in this conversation (checked last ${RESCUE_WALK_CAP} messages)`
      : 'No ccsw block found in this conversation');
    logEvent('rescue_used', { thread: hydratedThread || null, found: false, anchorsWalked }, null, true);
    return;
  }

  const blockText = blocks[blocks.length - 1].trim();
  let parsedBlock = null;
  try {
    parsedBlock = JSON.parse(blockText);
  } catch {
    // Not valid JSON -- still worth attempting; dispatchCcswBlock's own parse
    // reports the real error if it still doesn't parse.
  }
  const blockName = (parsedBlock && typeof parsedBlock.name === 'string' && parsedBlock.name.trim()) || 'Job';
  const blockThread = (parsedBlock && typeof parsedBlock.thread === 'string' && parsedBlock.thread) || hydratedThread || null;

  console.log(`[CCswitchboard] rescue: manually re-dispatching ccsw block ("${blockName}") found ${anchorsWalked} message(s) back via SW menu click.`);
  dispatchCcswBlock(anchorIndex, blockText, null);
  showRescueToast(`Rescued: ${blockName} -- dispatching`);
  logEvent('rescue_used', { thread: blockThread, found: true, blockName, anchorsWalked }, null, true);

  // FYI to the CCSW control thread, via the same cross-thread deliver path
  // dumpPillStatus uses (ccsw-pillstatus-deliver -- background.js resolves
  // whichever tab last spoke for a CCSW thread and types this in there).
  const fyiText = `FYI: manual rescue used on ${blockThread || '(unknown thread)'} for ${blockName} - a scan/dispatch failure occurred.`;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'ccsw-pillstatus-deliver', text: fyiText });
    if (!response?.ok) console.warn(`[CCswitchboard] rescue: FYI delivery failed: ${response?.error || 'unknown error'}`);
  } catch (err) {
    handlePossibleContextInvalidation(err);
    console.warn('[CCswitchboard] rescue: FYI delivery failed:', err.message);
  }
}

// --- SW menu state: persistent icon button + reopen-jobs menu --------------
// A small button that sits below the job pills in the same bottom-right
// corner and never disappears, even when there are no active jobs. Every job
// dispatched from this thread this page-load is remembered here (id, name,
// thread, dispatch time) regardless of whether its pill was later closed via
// removeJobBar's [x] button, so the menu can always relist and reopen it --
// activeToolbarJobs alone can't do that since removeJobBar deletes from it.
//
// Declared here (above scan(), before scan('startup') runs below) rather
// than down by the rest of the SW menu code, since scan() reads
// hydratedThread on every call -- were these declared in their usual spot
// further down the file, scan('startup') would hit them before that later
// `let`/`const` had executed and throw a temporal-dead-zone ReferenceError.

const sessionJobs = [];

// jobId -> { thread, barEl, statusEl, spinnerEl, panelEl, iframeEl, expanded,
// status, ... }. Also doubles as the scoping check: a status message for a job
// id not in here (i.e. not dispatched by this tab/thread) is simply ignored.
// Declared up here (rather than by the rest of the toolbar code far below) for
// the same TDZ reason as sessionJobs above: the pill code reached from
// scan('startup') reads it before the toolbar section's own `let`/`const`s
// would have executed.
const activeToolbarJobs = new Map();

// Issue #12b stage 1 (ADDITIVE ONLY -- zero behaviour change): a thin registry
// wrapping the existing activeToolbarJobs Map, so a later stage can make
// create+DOM and dispose+DOM atomic through one owner. NOTHING is routed
// through this yet -- every current create/delete/barEl.remove call site is
// left exactly as it was; this object merely exists alongside the Map, ready
// for S2. See fable-plans-20260712/{pill-registry-plan,registry-entry-shapes}.
//
// Surface (per the plan's S1 contract): create/ensure = the two intended
// legal make paths (must-not-exist vs get-or-create for pd's upsert);
// get/has/forEach/size = read-through pass-throughs that keep the ~25 existing
// read sites working unchanged; dispose = THE single canonical remover;
// disposeIf/reap/cap = sweep + count helpers the later sweep/cap stage adopts.
const pillRegistry = {
  get(key) {
    return activeToolbarJobs.get(key);
  },
  has(key) {
    return activeToolbarJobs.has(key);
  },
  forEach(fn) {
    activeToolbarJobs.forEach(fn);
  },
  size() {
    return activeToolbarJobs.size;
  },
  // create = must-not-exist (folds addJobBar's Issue #11 has-guard): a live
  // entry under this key wins and is returned untouched, never clobbered.
  create(key, entry) {
    const existing = activeToolbarJobs.get(key);
    if (existing) return existing;
    activeToolbarJobs.set(key, entry);
    return entry;
  },
  // ensure = get-or-create (the pd:<sendKey> upsert path, which mutates ~11
  // fields in place on an existing entry): build via factory only if absent,
  // then the caller mutates whatever it returns.
  ensure(key, factory) {
    const existing = activeToolbarJobs.get(key);
    if (existing) return existing;
    const entry = factory();
    activeToolbarJobs.set(key, entry);
    return entry;
  },
  // dispose = the ONLY legal remover (S2 folds every inline barEl.remove() +
  // .delete() pair onto this). Implements the entry-shapes "dispose contract
  // v2" in order: (1) clear every own timer/interval and disconnect every own
  // observer -- name-suffix matched so new *Timer/*Interval/*Observer fields
  // are future-proofed (numeric config like silenceTimeout is deliberately
  // NOT matched); (2) release any hovercard this entry's header owns;
  // (3) remove the barEl; (4) drop the Map entry; (5) job-pill extra -- purge
  // pillOrder WITHOUT applyToolbarCap (an explicit close only shrinks the
  // visible count; backfill is reserved for bumpPillRecency -- see
  // removeJobBar; a no-op for dropped/held/pd/merged keys, never in pillOrder);
  // (6) idempotent -- a missing entry is a silent no-op, so sweeps and an
  // explicit close can race harmlessly. Never animates or awaits: exit-anim
  // wrappers (animatePillExit) run first and call dispose as their final step.
  dispose(key) {
    const entry = activeToolbarJobs.get(key);
    if (!entry) return;
    for (const propName of Object.keys(entry)) {
      const val = entry[propName];
      if (propName.endsWith('Timer')) clearTimeout(val);
      else if (propName.endsWith('Interval')) clearInterval(val);
      else if (propName.endsWith('Observer') && val && typeof val.disconnect === 'function') val.disconnect();
    }
    if (typeof hideHovercardIfOwnedBy === 'function') {
      hideHovercardIfOwnedBy(key, entry.headerEl);
    }
    entry.barEl?.remove();
    activeToolbarJobs.delete(key);
    // Step 5: job-pill pillOrder purge, sans applyToolbarCap (preserves
    // removeJobBar's load-bearing shrink-don't-backfill semantic). Harmless
    // no-op for keys never in pillOrder (dropped/held/pd/merged).
    pillOrder = pillOrder.filter((id) => id !== key);
  },
  disposeIf(pred) {
    for (const [key, entry] of activeToolbarJobs) {
      if (pred(entry, key)) this.dispose(key);
    }
  },
  // reap = orphan sweep: dispose entries whose pill DOM has been detached out
  // from under the Map (the "Map entry with no removable DOM" ghost class the
  // plan calls out). S4 routes reapSilentPills' sweep through here; uncalled
  // in S1. (Ghosts are never in activeToolbarJobs -- they own themselves --
  // so this never touches them.)
  reap() {
    this.disposeIf((entry) => !entry.barEl || !entry.barEl.isConnected);
  },
  // cap = hard count backstop: dispose the oldest tracked entries (Map
  // insertion = creation order) once the live count exceeds `max`. Distinct
  // from applyToolbarCap, which only HIDES pills beyond TOOLBAR_VISIBLE_CAP
  // and never destroys them (intentional UX, left untouched). S4 wires this in
  // via reapSilentPills' sweep as a memory-leak backstop (see MAX_LIVE_PILLS);
  // routes every drop through dispose, inheriting the pillOrder-purge-without-
  // applyToolbarCap semantic. NEVER silently truncates -- it logs exactly what
  // it destroys (key + thread + status) before disposing, since a hard destroy
  // beyond the visible cap should always leave a trace.
  cap(max) {
    if (activeToolbarJobs.size <= max) return;
    const overflow = [...activeToolbarJobs.keys()].slice(0, activeToolbarJobs.size - max);
    const dropped = overflow.map((key) => {
      const entry = activeToolbarJobs.get(key);
      return { key, thread: entry?.thread ?? null, status: entry?.status ?? null };
    });
    console.warn(`[CCswitchboard] pillRegistry.cap: live pill count ${activeToolbarJobs.size} exceeds hard max ${max}; destroying ${overflow.length} oldest-by-creation:`, dropped);
    for (const key of overflow) this.dispose(key);
  },
};

// Persists each thread's job history in chrome.storage.local ({ [thread]:
// JobEntry[] }), so the menu still shows a thread's whole history after a
// page refresh -- sessionJobs itself resets to [] on every reload, since a
// refresh is a fresh document and thus a fresh content-script instance.
const SW_MENU_STORAGE_KEY = 'ccswThreadJobs';

// How many past jobs to keep per thread, in both the persisted store and the
// in-memory sessionJobs list -- oldest beyond this are dropped rather than
// paginated (no "show more" link).
const MAX_JOBS_PER_THREAD = 30;

// Caps how many rows renderSwMenuPanel actually builds, distinct from
// MAX_JOBS_PER_THREAD above -- sessionJobs can hold history for several
// hydrated threads at once (each capped at 30), so the menu itself still
// needs its own ceiling to avoid rendering hundreds of rows in one panel.
const SW_MENU_RENDER_CAP = 20;

// Which thread sessionJobs has already been hydrated from storage for this
// page-load. There's no way to know "the current thread" up front -- it's
// only known once a ccsw block naming one is found: scan() below checks
// every ccsw block it sees (dispatched or not) for a thread tag so a plain
// refresh repopulates the menu purely from storage, and a fresh dispatch's
// recordSessionJob() also feeds it as a fallback.
let hydratedThread = null;

// Maps this conversation's URL to the last thread name seen on it
// ({ [conversationKey]: thread }), so a refresh can hydrate immediately
// without waiting to find a ccsw-tagged block currently in the DOM. Relying
// on the DOM alone silently fails whenever claude.ai's initially-rendered
// slice of the conversation doesn't happen to include one -- e.g. several
// plain back-and-forth turns happened after the last job dispatch, or
// claude.ai only mounts the most recent portion of a long conversation and
// loads older history lazily on scroll-up. In either case hydratedThread
// would simply never get set and the whole job history (menu list + pills)
// stays empty even though storage has it. This map is the fallback: written
// every time a thread IS learned (see hydrateSessionJobsForThread), read
// once at startup below.
const URL_THREAD_STORAGE_KEY = 'ccswUrlThreads';

// Identifies "this conversation" for URL_THREAD_STORAGE_KEY -- pathname
// alone (no query/hash) since claude.ai conversation URLs are stable at
// that granularity across refreshes.
function getConversationKey() {
  return location.pathname || location.href;
}

async function rememberUrlThread(thread) {
  try {
    const all = await chrome.storage.local.get(URL_THREAD_STORAGE_KEY);
    const map = all[URL_THREAD_STORAGE_KEY] || {};
    map[getConversationKey()] = thread;
    await chrome.storage.local.set({ [URL_THREAD_STORAGE_KEY]: map });
  } catch (err) {
    console.warn(`[CCswitchboard] SW menu: failed to remember thread "${thread}" for this URL:`, err.message);
    handlePossibleContextInvalidation(err);
  }
}

async function loadUrlThread() {
  try {
    const all = await chrome.storage.local.get(URL_THREAD_STORAGE_KEY);
    const map = all[URL_THREAD_STORAGE_KEY] || {};
    return map[getConversationKey()] || null;
  } catch (err) {
    console.warn('[CCswitchboard] SW menu: failed to load remembered thread for this URL:', err.message);
    handlePossibleContextInvalidation(err);
    return null;
  }
}

// Central debug log's page_load event (see logEvent above). Captures every
// refresh/load with build + thread + url, so a stale tab -- one still running
// an older content.js -- shows up the moment it reloads, or conspicuously
// never does. hydratedThread isn't set this early, so the thread comes from
// the same remembered-URL fallback the SW menu uses at startup; a brand-new
// conversation legitimately logs thread=null. Deliberately sited AFTER
// loadUrlThread/URL_THREAD_STORAGE_KEY rather than beside logEvent, to stay
// clear of that const's temporal dead zone.
loadUrlThread()
  .then((thread) => logEvent('page_load', { url: location.href }, thread))
  .catch(() => logEvent('page_load', { url: location.href }));

// Runs once at startup, in parallel with scan()'s DOM-based discovery --
// whichever finds the thread first wins, since hydrateSessionJobsForThread
// is idempotent per thread (see its own `thread === hydratedThread` guard).
async function hydrateFromRememberedUrlThread() {
  const thread = await loadUrlThread();
  console.log(`[CCswitchboard] SW menu: remembered thread for ${getConversationKey()} is`, thread);
  if (thread && !hydratedThread) hydrateSessionJobsForThread(thread);
}

// Per-thread on/off toggle for job dispatch, exposed as the SW menu's second
// item (below the global toggle further down). While off, scan() below still
// walks the DOM and tracks message stability (so nothing else in this file
// has to know about the toggle), it just skips the ccsw block parsing/
// dispatch step -- in-flight jobs already dispatched before the toggle went
// off are untouched, since those are driven by background.js's own polling,
// not by anything here. Defaults to true (On) until the async storage read
// below resolves, per CONFIG default-on requirement; if that read loses a
// race with the very first scan(), that scan simply runs with listening on,
// which is the correct default anyway. Storage-backed but NOT synced live
// across tabs (unlike GLOBAL_LISTENING_STORAGE_KEY below) -- each tab reads
// its own copy once at content-script load, which is fine since this toggle
// is meant to apply only to this thread/tab in the first place.
const SW_LISTENING_STORAGE_KEY = 'ccswListeningEnabled';
let listeningEnabled = true;

// User-send provenance window. A block may dispatch only if its thread's
// DURABLE beacon (beacon.php, mirrored into durableBeacons above) records a
// real user send within this long -- rule (b) of scan()'s eligibility rule.
//
// This used to be measured against a per-tab `ccswLastUserSendAt` timestamp,
// which a reload reset to 0 and a service-worker restart forgot entirely. The
// window is unchanged; only the clock it reads is now durable and per-thread
// rather than in-memory and per-tab.
const CCSW_SEND_WINDOW_MS = 300000;

// LAST-RESORT fail-open window for the durable dispatched-key state. See
// durableStateReadyFor: normally a single completed relay fetch (fetchedAt>0)
// makes every thread answerable, so this only bites when NO fetch has EVER
// succeeded -- relay fully down, no usable token, or a wrong relay base. Rather
// than defer every block eternally in that state (the all-threads dispatch
// death), we log loudly and fall open to the local (this-tab) dedup sets after
// this long. 45s = long enough for a transient outage / a slow first poll to
// resolve on its own, short enough that a genuinely dead relay doesn't strand
// the tab for minutes.
const CCSW_DURABLE_FETCH_FALLBACK_MS = 45000;

// How many assistant messages (feedbackButton anchors) existed at the instant
// this tab last observed a real user send. null = no send seen this page load.
//
// DIAGNOSTIC ONLY. Logged into dispatch_decision_v2, never decided on.
//
// It used to sharpen the newest-message tiebreaker: "the reply to the send is
// the anchor at index anchorCountAtLastSend, so a block may only dispatch from
// an anchor at or after that index" (postDatesLastSend). That premise assumes
// the anchor count only ever grows. It does not -- claude.ai's DOM is
// VIRTUALIZED and mounts a variable number of anchors depending on scroll and
// viewport, so the count NOW is routinely LOWER than the count captured at
// send-time, even for a genuinely new message. The comparison then read "this
// block does not post-date the send" for the very block Claude had just
// emitted, and every fresh block was held. Nothing dispatched at all, and the
// tabs had to be rolled back by hand.
//
// The lesson is in scan()'s decision comment: an anchor COUNT is not a recency
// signal under virtualization. `isLastAnchor` -- "is this the last anchor that
// exists right now" -- is, because it asks only about the DOM as it stands and
// makes no claim about the past. Kept here (and in the log) purely so the next
// reader can confirm from real events that the count really does go backwards.
let anchorCountAtLastSend = null;

// ============================ AUTOPILOT WINDOW ============================
// Normally a finished ccsw block only dispatches if a genuine HUMAN send landed
// in the thread within CCSW_SEND_WINDOW_MS (scan()'s rule B); otherwise it's
// HELD with a "no recent user send" pill, and Jody clicks "Dispatch anyway".
// The autopilot window is a transient, user-armed override: while armed for a
// thread, rule B is treated as satisfied so held-for-no-recent-send blocks
// dispatch on their own, and it auto-expires after a set duration.
//
// It bypasses ONLY that one hold. Rule A (the block's stableKey is already in
// the durable dispatched ledger), the newest-message scrollback guard (rule
// (b) -- an ancient scrollback block is never dispatched), and every
// composer-ready / user-text-sacred delivery gate downstream all stay fully in
// force. Autopilot supplies the "a human authorises dispatch in this thread"
// signal that rule B otherwise demands, nothing more.
//
// Scope: PER THREAD, keyed by the tab's hydrated thread -- the one whose SW
// menu armed it -- so arming one conversation never authorises dispatch in
// another. Synced across tabs via storage.onChanged like the listening flags.
//
// Persistence: the ABSOLUTE expiry timestamp is stored in chrome.storage.local
// (never a duration), so a content-script reload or service-worker respawn
// recomputes the remaining time from the same deadline -- it can neither lose
// the armed state nor wrongly extend it. On load, an expiry already in the past
// reads as disarmed and is dropped, never re-armed.
const AUTOPILOT_STORAGE_KEY = 'ccswAutopilotWindows';
const AUTOPILOT_DURATION_STORAGE_KEY = 'ccswAutopilotWindowMinutes';
const AUTOPILOT_DEFAULT_MINUTES = 30;
// Ascending preset ladder (minutes) the SW-menu duration lever steps through:
// 30m, 2h, 8h, 24h, 3d, 1wk, 30d. A click advances to the next rung up and
// wraps from the top (43200) back to the bottom (30). See
// nextAutopilotWindowMinutes and updateSwMenuAutopilotDurationItem.
const AUTOPILOT_WINDOW_LADDER = [30, 120, 480, 1440, 4320, 10080, 43200];

// thread -> untilEpochMs. Only entries with untilEpochMs > now count as armed;
// expired entries are dropped on load and by the per-thread expiry timer.
let autopilotWindows = new Map();
// thread -> setTimeout handle that fires disarm at the deadline. Re-arming or
// disarming clears the old one so a stale timer can't disarm a re-armed window.
let autopilotExpiryTimers = new Map();
// 1s interval that keeps THIS tab's armed indicator/menu countdown live while
// its own thread is armed. Managed entirely inside updateAutopilotUi().
let autopilotTickTimer = null;
// Tunable duration (minutes), read from Settings storage if present (see
// loadAutopilotWindows); falls back to AUTOPILOT_DEFAULT_MINUTES.
let autopilotWindowMinutes = AUTOPILOT_DEFAULT_MINUTES;

function autopilotDurationMs() {
  const mins = Number(autopilotWindowMinutes);
  if (Number.isFinite(mins) && mins > 0) return Math.round(mins * 60000);
  return AUTOPILOT_DEFAULT_MINUTES * 60000;
}

// Pure read: the effective (unexpired) deadline for a thread, or 0. Never
// mutates the map -- the expiry timer is the single authority that disarms and
// logs, so a read racing ahead of the timer can't swallow the expire event.
function autopilotUntilFor(thread) {
  if (!thread) return 0;
  const until = autopilotWindows.get(thread);
  if (!until || until <= Date.now()) return 0;
  return until;
}

// The signal scan()'s hold gate consults: is dispatch autopilot-authorised for
// this thread right now?
function autopilotArmedFor(thread) {
  return autopilotUntilFor(thread) > 0;
}

// Human "24m left" / "45s left" for the menu row and the badge tooltip.
function autopilotTimeLeftLabel(thread) {
  const until = autopilotUntilFor(thread);
  if (!until) return '0s left';
  const ms = until - Date.now();
  if (ms >= 60000) return `${Math.ceil(ms / 60000)}m left`;
  return `${Math.max(1, Math.ceil(ms / 1000))}s left`;
}

// Compact human form of a window duration for the SW-menu duration lever:
// 30m, 2h, 8h, 24h, 3d, 1wk, 30d. Prefers the largest tidy unit that divides
// evenly -- weeks only for a small whole number of weeks (so 7 days reads
// "1wk" but 30 days falls back to "30d"), and 24h stays "24h" not "1d".
function formatAutopilotMinutes(mins) {
  const m = Math.round(Number(mins));
  if (!Number.isFinite(m) || m <= 0) return `${AUTOPILOT_DEFAULT_MINUTES}m`;
  if (m < 60) return `${m}m`;
  const WEEK = 10080, DAY = 1440, HOUR = 60;
  if (m % WEEK === 0 && m / WEEK <= 4) return `${m / WEEK}wk`;
  if (m % DAY === 0 && m > DAY) return `${m / DAY}d`;
  if (m % HOUR === 0) return `${m / HOUR}h`;
  return `${m}m`;
}

// The next rung up the ladder from `current`, wrapping from the top back to the
// bottom. Any value at or above the top (or off the ladder) wraps to 30m.
function nextAutopilotWindowMinutes(current) {
  const cur = Number(current);
  for (const rung of AUTOPILOT_WINDOW_LADDER) {
    if (rung > cur) return rung;
  }
  return AUTOPILOT_WINDOW_LADDER[0];
}

async function persistAutopilotWindows() {
  const obj = {};
  for (const [thread, until] of autopilotWindows) obj[thread] = until;
  try {
    await chrome.storage.local.set({ [AUTOPILOT_STORAGE_KEY]: obj });
  } catch (err) {
    console.warn('[CCswitchboard] autopilot: failed to persist windows:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

// Rebuilds autopilotWindows from a stored object, dropping anything already
// expired and (re)scheduling an expiry timer for each survivor. Shared by the
// initial load and the cross-tab storage.onChanged sync.
function rebuildAutopilotWindowsFrom(obj) {
  const now = Date.now();
  for (const timer of autopilotExpiryTimers.values()) clearTimeout(timer);
  autopilotExpiryTimers = new Map();
  autopilotWindows = new Map();
  if (obj && typeof obj === 'object') {
    for (const [thread, until] of Object.entries(obj)) {
      if (typeof until === 'number' && until > now) {
        autopilotWindows.set(thread, until);
        scheduleAutopilotExpiry(thread);
      }
    }
  }
}

async function loadAutopilotWindows() {
  try {
    const stored = await chrome.storage.local.get([AUTOPILOT_STORAGE_KEY, AUTOPILOT_DURATION_STORAGE_KEY]);
    const mins = Number(stored[AUTOPILOT_DURATION_STORAGE_KEY]);
    autopilotWindowMinutes = (Number.isFinite(mins) && mins > 0) ? mins : AUTOPILOT_DEFAULT_MINUTES;
    const obj = stored[AUTOPILOT_STORAGE_KEY];
    rebuildAutopilotWindowsFrom(obj);
    // If we dropped any expired entries, rewrite the cleaned set so stale
    // deadlines don't accumulate in storage across reloads.
    const storedCount = obj && typeof obj === 'object' ? Object.keys(obj).length : 0;
    if (storedCount !== autopilotWindows.size) persistAutopilotWindows().catch(() => {});
  } catch (err) {
    console.warn('[CCswitchboard] autopilot: failed to load windows, treating as disarmed:', err.message);
    handlePossibleContextInvalidation(err);
  }
  updateAutopilotUi();
}

// One-shot timer that disarms `thread` at its deadline. Re-checks on fire in
// case a re-arm pushed the deadline further out after this was scheduled.
function scheduleAutopilotExpiry(thread) {
  const existing = autopilotExpiryTimers.get(thread);
  if (existing) clearTimeout(existing);
  const until = autopilotWindows.get(thread);
  if (!until) return;
  const delay = Math.max(0, until - Date.now());
  const timer = setTimeout(() => {
    autopilotExpiryTimers.delete(thread);
    const stillUntil = autopilotWindows.get(thread);
    if (stillUntil && stillUntil > Date.now()) { scheduleAutopilotExpiry(thread); return; }
    disarmAutopilotWindow(thread, 'expired').catch((err) => handlePossibleContextInvalidation(err));
  }, delay);
  autopilotExpiryTimers.set(thread, timer);
}

// Arm (or extend) the window for a thread. Persists the absolute deadline,
// schedules expiry, logs, refreshes the UI, and -- the whole point -- releases
// every block currently held in this tab for no-recent-send, exactly as if
// Jody had clicked "Dispatch anyway" on each.
async function armAutopilotWindow(thread) {
  if (!thread) {
    console.warn('[CCswitchboard] autopilot: this tab has no hydrated thread yet; cannot arm.');
    return;
  }
  const until = Date.now() + autopilotDurationMs();
  autopilotWindows.set(thread, until);
  await persistAutopilotWindows();
  scheduleAutopilotExpiry(thread);
  const durationMs = until - Date.now();
  console.log(`[CCswitchboard] autopilot: ARMED for thread "${thread}" until ${new Date(until).toISOString()} (~${Math.round(durationMs / 60000)}m).`);
  logEvent('autopilot_armed', { thread, until, durationMs }, thread);
  updateAutopilotUi();
  const released = releaseAutopilotHeldPills(thread);
  if (released > 0) console.log(`[CCswitchboard] autopilot: auto-released ${released} held block(s) on arm.`);
}

// Disarm the window for a thread (manual cancel or expiry). Logs the expire
// event with the reason, clears the timer, persists, and refreshes the UI.
async function disarmAutopilotWindow(thread, reason) {
  if (!thread) return;
  const had = autopilotWindows.delete(thread);
  const timer = autopilotExpiryTimers.get(thread);
  if (timer) { clearTimeout(timer); autopilotExpiryTimers.delete(thread); }
  if (had) {
    await persistAutopilotWindows();
    console.log(`[CCswitchboard] autopilot: DISARMED for thread "${thread}" (${reason}).`);
    logEvent('autopilot_expired', { thread, reason: reason || 'disarmed' }, thread);
  }
  updateAutopilotUi();
}

// On arming, dispatch every block currently HELD in this tab for no-recent-send
// -- the same effect as clicking "Dispatch anyway" on each (it reuses that
// exact path via the closure stashed on the held entry in showHeldForSendBar).
//
// No per-thread filter: a held pill only ever exists in the tab whose scan()
// produced it, and that scan evaluated the hold under this tab's own thread
// identity (tabThread = hydratedThread) -- the same key the window is armed
// under. The block's self-declared entry.thread is a routing detail that can
// diverge from that hold key (#47), so filtering on it would wrongly skip a
// pill the armed window authorises. Snapshots the entries first because
// dispatching mutates activeToolbarJobs mid-iteration.
function releaseAutopilotHeldPills(thread) {
  let released = 0;
  const entries = [...activeToolbarJobs.entries()];
  for (const [, entry] of entries) {
    if (!entry || !entry.held || typeof entry.autopilotRelease !== 'function') continue;
    try { entry.autopilotRelease(); released++; }
    catch (err) { console.warn('[CCswitchboard] autopilot: held-pill release failed:', err.message); }
  }
  return released;
}

// Repaints this tab's autopilot UI (menu row + always-visible badge) from its
// own hydrated thread's state, and manages the 1s live-countdown tick: the tick
// runs exactly while this thread is armed, so an expiry stops it on its own.
function updateAutopilotUi() {
  let armed = false;
  try { armed = autopilotArmedFor(hydratedThread); } catch (tdz) { armed = false; }
  if (armed && autopilotTickTimer === null) {
    autopilotTickTimer = setInterval(updateAutopilotUi, 1000);
  } else if (!armed && autopilotTickTimer !== null) {
    clearInterval(autopilotTickTimer);
    autopilotTickTimer = null;
  }
  updateSwMenuAutopilotItem(armed);
  updateSwMenuAutopilotDurationItem();
  updateAutopilotIndicator(armed);
}

// Liveness tell: the SW menu button (see addSwMenuButton) is the one piece of
// UI that's always on screen, so its tooltip doubles as a way to confirm --
// without opening DevTools -- that a fresh version of this content script is
// actually the one running on the page (after an update/reload) and what its
// listening toggle currently is. swMenuButtonEl is set once addSwMenuButton()
// runs; updateSwMenuButtonTooltip() is a no-op before that (e.g. if
// loadListeningEnabled's async read resolves before the button exists yet).
const EXTENSION_VERSION = chrome.runtime.getManifest().version;
let swMenuButtonEl = null;

function updateSwMenuButtonTooltip() {
  if (!swMenuButtonEl) return;
  swMenuButtonEl.title = `CCswitchboard v${EXTENSION_VERSION} - listening: ${listeningEnabled ? 'on' : 'off'}, global: ${globalListeningEnabled ? 'on' : 'off'}`;
}

async function loadListeningEnabled() {
  try {
    const stored = await chrome.storage.local.get(SW_LISTENING_STORAGE_KEY);
    listeningEnabled = stored[SW_LISTENING_STORAGE_KEY] !== false;
  } catch (err) {
    console.warn('[CCswitchboard] SW menu: failed to load listening state, defaulting to on:', err.message);
    handlePossibleContextInvalidation(err);
  }
  updateSwMenuButtonTooltip();
}

async function setListeningEnabled(value) {
  listeningEnabled = value;
  console.log(`[CCswitchboard] listening: ${value ? 'ON' : 'OFF'}.`);
  updateSwMenuButtonTooltip();
  try {
    await chrome.storage.local.set({ [SW_LISTENING_STORAGE_KEY]: value });
  } catch (err) {
    console.warn('[CCswitchboard] SW menu: failed to persist listening state:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

// Extension-wide master toggle for job dispatch, exposed as a second SW menu
// row above the per-thread one (see addSwMenuButton). While off, it
// overrides every thread's own listeningEnabled regardless of that thread's
// state -- see the dispatch gate in scan() below. Unlike
// SW_LISTENING_STORAGE_KEY (which each tab loads into its own in-memory copy
// at content-script load and never re-syncs), this flag is kept in sync live
// across all open tabs via a storage.onChanged listener, since "hard-stop
// every thread" only means something if toggling it from one tab takes
// effect in the others immediately. Defaults to true (On) for the same
// startup-race reason as listeningEnabled above.
const GLOBAL_LISTENING_STORAGE_KEY = 'ccswGlobalListening';
let globalListeningEnabled = true;

async function loadGlobalListeningEnabled() {
  try {
    const stored = await chrome.storage.local.get(GLOBAL_LISTENING_STORAGE_KEY);
    globalListeningEnabled = stored[GLOBAL_LISTENING_STORAGE_KEY] !== false;
  } catch (err) {
    console.warn('[CCswitchboard] SW menu: failed to load global listening state, defaulting to on:', err.message);
    handlePossibleContextInvalidation(err);
  }
  updateSwMenuButtonTooltip();
}

async function setGlobalListeningEnabled(value) {
  globalListeningEnabled = value;
  console.log(`[CCswitchboard] global listening: ${value ? 'ON' : 'OFF'}.`);
  updateSwMenuButtonTooltip();
  try {
    await chrome.storage.local.set({ [GLOBAL_LISTENING_STORAGE_KEY]: value });
  } catch (err) {
    console.warn('[CCswitchboard] SW menu: failed to persist global listening state:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

// Toggle for the tab-favicon job-state indicator (see updateFaviconForJobState
// far below, in the favicon section) -- global across threads/tabs like
// GLOBAL_LISTENING_STORAGE_KEY, since it's a "do I want this browser chrome
// affected at all" preference rather than a per-thread one. Defaults to true
// (On) via the not-equal-to-false idiom below: this is now the single OFF
// switch for the fv2 favicon status spinner (see fv2Allowed), which runs by
// default for everyone unless this toggle is explicitly turned off.
const FAVICON_ENABLED_STORAGE_KEY = 'ccswFaviconEnabled';
let faviconIndicatorEnabled = true;

async function loadFaviconIndicatorEnabled() {
  try {
    const stored = await chrome.storage.local.get(FAVICON_ENABLED_STORAGE_KEY);
    faviconIndicatorEnabled = stored[FAVICON_ENABLED_STORAGE_KEY] !== false;
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to load favicon indicator state, defaulting to on:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

async function setFaviconIndicatorEnabled(value) {
  faviconIndicatorEnabled = value;
  try {
    await chrome.storage.local.set({ [FAVICON_ENABLED_STORAGE_KEY]: value });
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to persist favicon indicator state:', err.message);
    handlePossibleContextInvalidation(err);
  }
  // updateFaviconForJobState is a hoisted function declaration (defined
  // further down, in the favicon section) -- safe to call from here since
  // this only ever runs from a later user/storage event, not at load time.
  updateFaviconForJobState();
}

// Gates the favicon-debug heartbeat (see syncFaviconHeartbeat, in the favicon
// section below) -- OFF by default, purely a diagnostic aid so this never
// fires for a plain user. Loaded/synced the same way as
// FAVICON_ENABLED_STORAGE_KEY above.
const FAVICON_DEBUG_STORAGE_KEY = 'ccswFaviconDebug';
let ccswFaviconDebug = false;

async function loadFaviconDebugEnabled() {
  try {
    const stored = await chrome.storage.local.get(FAVICON_DEBUG_STORAGE_KEY);
    ccswFaviconDebug = stored[FAVICON_DEBUG_STORAGE_KEY] === true;
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to load favicon debug heartbeat state, defaulting to off:', err.message);
    handlePossibleContextInvalidation(err);
  }
  // syncFaviconHeartbeat is a hoisted function declaration (defined further
  // down, in the favicon section) -- safe to call from here for the same
  // reason updateFaviconForJobState is above.
  syncFaviconHeartbeat();
}

// Gates the fv2 competitor-displacement machinery (fv2CaptureCompetitors /
// fv2RemoveCompetitors + the reassert sweep's non-ours re-query) -- OFF by
// default so rung 2b (type/sizes declaration alone) can be tested without the
// displacement behaviour in play. fv2RestoreCompetitors is NOT gated by this
// flag (see its call sites) -- a snapshot taken while the flag was on must
// still be restored even if the flag flips off mid-activation. Loaded/synced
// the same way as FAVICON_DEBUG_STORAGE_KEY above.
const FAVICON_DISPLACE_STORAGE_KEY = 'ccswFaviconDisplace';
let fv2DisplaceEnabled = false;

async function loadFaviconDisplaceEnabled() {
  try {
    const stored = await chrome.storage.local.get(FAVICON_DISPLACE_STORAGE_KEY);
    fv2DisplaceEnabled = stored[FAVICON_DISPLACE_STORAGE_KEY] === true;
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to load favicon displace state, defaulting to off:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

async function setFaviconDisplaceEnabled(value) {
  fv2DisplaceEnabled = value;
  try {
    await chrome.storage.local.set({ [FAVICON_DISPLACE_STORAGE_KEY]: value });
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to persist favicon displace state:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

// Fix 5a: gates the piggyback suppression probe (see runPiggybackProbe and
// PIGGYBACK_PROBE_CONFIRM_MS, far below near the send listeners) -- OFF by
// default. While off, the Enter-keydown and send-button click listeners are
// byte-identical to their pre-probe form: markUserSend fires exactly as it
// always has, nothing is prevented/suppressed, nothing ever resends.
// Loaded/synced the same way as FAVICON_DISPLACE_STORAGE_KEY above.
const PIGGYBACK_PROBE_STORAGE_KEY = 'ccswPiggybackProbe';
let piggybackProbeEnabled = false;

async function loadPiggybackProbeEnabled() {
  try {
    const stored = await chrome.storage.local.get(PIGGYBACK_PROBE_STORAGE_KEY);
    // Default ON: enabled unless the stored value is explicitly false. A profile
    // that never set the key gets the feature; only ccswPiggybackProbe === false
    // disables it.
    piggybackProbeEnabled = stored[PIGGYBACK_PROBE_STORAGE_KEY] !== false;
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to load piggyback probe state, defaulting to off:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

async function setPiggybackProbeEnabled(value) {
  piggybackProbeEnabled = value;
  try {
    await chrome.storage.local.set({ [PIGGYBACK_PROBE_STORAGE_KEY]: value });
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to persist piggyback probe state:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

// CONCURRENT-SEND PROBE: verifies Jody's report that newer claude.ai tabs
// accept a send while Claude is still generating (THINKING: tacks onto the
// current turn; OUTPUTTING: queues it) instead of rejecting it -- if true,
// background.js's hold-phase gate (advanceHoldPhase) could inject a pending
// result as soon as it's ready instead of holding for completion_running.
// OFF by default: while off, syncConcurrentSendObserve() never starts the
// observe-mode heartbeat below and background.js's own cached copy of this
// flag (mirrored separately there, see its own comment) never attempts a
// concurrent send -- deliveries hold exactly as they do today. Loaded/synced
// the same way as PIGGYBACK_PROBE_STORAGE_KEY above.
const CONCURRENT_SEND_PROBE_STORAGE_KEY = 'ccswConcurrentSendProbe';
let concurrentSendProbeEnabled = false;

async function loadConcurrentSendProbeEnabled() {
  try {
    const stored = await chrome.storage.local.get(CONCURRENT_SEND_PROBE_STORAGE_KEY);
    concurrentSendProbeEnabled = stored[CONCURRENT_SEND_PROBE_STORAGE_KEY] === true;
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to load concurrent-send probe state, defaulting to off:', err.message);
    handlePossibleContextInvalidation(err);
  }
  syncConcurrentSendObserve();
}

async function setConcurrentSendProbeEnabled(value) {
  concurrentSendProbeEnabled = value;
  try {
    await chrome.storage.local.set({ [CONCURRENT_SEND_PROBE_STORAGE_KEY]: value });
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to persist concurrent-send probe state:', err.message);
    handlePossibleContextInvalidation(err);
  }
  syncConcurrentSendObserve();
}

// #18 S3: auto-heal stale tabs. When ON, background.js's stale-tab sweep
// auto-reloads stale-but-composer-empty hidden tabs after an extension reload,
// so the fleet self-heals without the manual "Reload empty tabs" tap. DEFAULT
// ON (!== false, matching ccswPiggybackProbe) -- enabled unless the stored
// value is explicitly false. The value is only ever READ on the background
// side (see getStaleAutoHealEnabled); this pair just persists the toggle for
// the Settings dialog. No content-side side effect, so no sync function.
const STALE_AUTOHEAL_STORAGE_KEY = 'ccswStaleAutoHeal';
let staleAutoHealEnabled = false;

async function loadStaleAutoHealEnabled() {
  try {
    const stored = await chrome.storage.local.get(STALE_AUTOHEAL_STORAGE_KEY);
    // Default ON: enabled unless the stored value is explicitly false, matching
    // loadPiggybackProbeEnabled.
    staleAutoHealEnabled = stored[STALE_AUTOHEAL_STORAGE_KEY] !== false;
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to load stale auto-heal state, defaulting to off:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

async function setStaleAutoHealEnabled(value) {
  staleAutoHealEnabled = value;
  try {
    await chrome.storage.local.set({ [STALE_AUTOHEAL_STORAGE_KEY]: value });
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to persist stale auto-heal state:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

// #14 Gate B (auto-re-fire on repo-free wake): when a job is dropped because
// its repo was locked, it becomes a dropped pill whose manual "Re-fire" button
// re-runs the stashed block once the repo frees. With this ON, the repo-free
// wake (background.js's pollWake) instead auto-performs that SAME re-fire
// exactly once per drop, so a routine lock-collision that will succeed on
// retry dispatches quietly -- no pill, no nudge. DEFAULT ON (!== false,
// matching loadStaleAutoHealEnabled) -- set false to fully disable the
// automatic re-fire and fall back to today's manual-only behaviour; the manual
// Re-fire button stays regardless. Unlike staleAutoHeal this flag is READ on
// THIS (content) side -- in tryAutoRefireDroppedForRepo below -- so its
// in-memory default is ON too, covering a wake that arrives before load lands.
const AUTO_REFIRE_STORAGE_KEY = 'ccswAutoRefire';
let autoRefireEnabled = true;

async function loadAutoRefireEnabled() {
  try {
    const stored = await chrome.storage.local.get(AUTO_REFIRE_STORAGE_KEY);
    // Default ON: enabled unless the stored value is explicitly false, matching
    // loadStaleAutoHealEnabled.
    autoRefireEnabled = stored[AUTO_REFIRE_STORAGE_KEY] !== false;
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to load auto-re-fire state, defaulting to on:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

async function setAutoRefireEnabled(value) {
  autoRefireEnabled = value;
  try {
    await chrome.storage.local.set({ [AUTO_REFIRE_STORAGE_KEY]: value });
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to persist auto-re-fire state:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

// Self-heal JSON feedback loop: when claude.ai emits a ccsw block whose JSON
// won't parse (even after sanitizing), instead of going straight to the red
// error ghost, feed the parse error back into this thread's composer so Claude
// re-emits a corrected block -- capped at SELF_HEAL_MAX_ATTEMPTS so it can't
// loop, and only surfacing the ghost (now with a retry-history summary) once
// that cap is spent. DEFAULT ON (!== false, matching loadAutoRefireEnabled) --
// set false to fall back to today's straight-to-ghost behaviour with no
// feedback. Read on THIS (content) side (in dispatchCcswBlock's parse-null
// branch), so its in-memory default is ON too, covering a broken block that
// arrives before load lands.
const SELF_HEAL_STORAGE_KEY = 'ccswSelfHealJson';
let selfHealJsonEnabled = true;

async function loadSelfHealJsonEnabled() {
  try {
    const stored = await chrome.storage.local.get(SELF_HEAL_STORAGE_KEY);
    // Default ON: enabled unless the stored value is explicitly false.
    selfHealJsonEnabled = stored[SELF_HEAL_STORAGE_KEY] !== false;
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to load self-heal-JSON state, defaulting to on:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

async function setSelfHealJsonEnabled(value) {
  selfHealJsonEnabled = value;
  try {
    await chrome.storage.local.set({ [SELF_HEAL_STORAGE_KEY]: value });
  } catch (err) {
    console.warn('[CCswitchboard] settings: failed to persist self-heal-JSON state:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

// Persisted SW menu panel height, set by dragging the top-edge resize handle
// (see startSwMenuResize/addSwMenuButton far below). Synced live across tabs
// like GLOBAL_LISTENING_STORAGE_KEY -- resizing the menu is a "how big do I
// want this widget" preference, not a per-tab thing. null means no override
// yet (the panel just uses its CSS default sizing). swMenuPanelEl is set once
// addSwMenuButton() builds the panel; applySwMenuHeight() is a no-op before
// that, same pattern as swMenuButtonEl/updateSwMenuButtonTooltip above.
const MENU_HEIGHT_STORAGE_KEY = 'ccswMenuHeight';
let swMenuHeight = null;
let swMenuPanelEl = null;

// Caps how tall a drag (or a restored height from a since-shrunk viewport)
// can render -- min(600px, 80vh) so the menu can't grow past a reasonable
// size or off the bottom of a short window. The resize floor comes from the
// shared RESIZE_MIN_HEIGHT (see startPanelResize) -- no menu-specific
// minimum needed.
function swMenuMaxHeight() {
  return Math.min(600, window.innerHeight * 0.8);
}

async function loadSwMenuHeight() {
  try {
    const stored = await chrome.storage.local.get(MENU_HEIGHT_STORAGE_KEY);
    swMenuHeight = typeof stored[MENU_HEIGHT_STORAGE_KEY] === 'number' ? stored[MENU_HEIGHT_STORAGE_KEY] : null;
  } catch (err) {
    console.warn('[CCswitchboard] SW menu: failed to load persisted height:', err.message);
    handlePossibleContextInvalidation(err);
  }
  applySwMenuHeight();
}

async function setSwMenuHeight(value) {
  swMenuHeight = value;
  try {
    await chrome.storage.local.set({ [MENU_HEIGHT_STORAGE_KEY]: value });
  } catch (err) {
    console.warn('[CCswitchboard] SW menu: failed to persist height:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

// Applies the in-memory swMenuHeight to this tab's panel (if it's been built
// yet). Called on load, whenever the menu opens, and from the
// storage.onChanged listener below when another tab resizes it.
function applySwMenuHeight() {
  if (!swMenuPanelEl || swMenuHeight == null) return;
  swMenuPanelEl.style.maxHeight = `${swMenuMaxHeight()}px`;
  swMenuPanelEl.style.height = `${swMenuHeight}px`;
}

// Cross-tab live sync: without this, toggling the global switch in one tab
// would only reach other open threads the next time each of them reloads,
// which defeats the point of a switch meant to hard-stop every thread now.
// Also covers the favicon indicator toggle (same "affects this browser
// chrome globally" reasoning) and, when the Settings dialog is open in this
// tab, keeps its checkboxes in sync with a toggle made from another tab.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (GLOBAL_LISTENING_STORAGE_KEY in changes) {
    globalListeningEnabled = changes[GLOBAL_LISTENING_STORAGE_KEY].newValue !== false;
    updateSwMenuButtonTooltip();
    updateSwMenuGlobalListeningItem();
  }
  if (SW_LISTENING_STORAGE_KEY in changes) {
    listeningEnabled = changes[SW_LISTENING_STORAGE_KEY].newValue !== false;
    updateSwMenuButtonTooltip();
    updateSwMenuListeningItem();
  }
  if (FAVICON_ENABLED_STORAGE_KEY in changes) {
    faviconIndicatorEnabled = changes[FAVICON_ENABLED_STORAGE_KEY].newValue !== false;
    updateFaviconForJobState();
    syncFaviconHeartbeat();
  }
  if (FAVICON_DEBUG_STORAGE_KEY in changes) {
    ccswFaviconDebug = changes[FAVICON_DEBUG_STORAGE_KEY].newValue === true;
    syncFaviconHeartbeat();
  }
  if (FAVICON_DISPLACE_STORAGE_KEY in changes) {
    fv2DisplaceEnabled = changes[FAVICON_DISPLACE_STORAGE_KEY].newValue === true;
  }
  if (PIGGYBACK_PROBE_STORAGE_KEY in changes) {
    // Default ON: enabled unless the new value is explicitly false (see
    // loadPiggybackProbeEnabled).
    piggybackProbeEnabled = changes[PIGGYBACK_PROBE_STORAGE_KEY].newValue !== false;
  }
  if (CONCURRENT_SEND_PROBE_STORAGE_KEY in changes) {
    concurrentSendProbeEnabled = changes[CONCURRENT_SEND_PROBE_STORAGE_KEY].newValue === true;
    syncConcurrentSendObserve();
  }
  if (STALE_AUTOHEAL_STORAGE_KEY in changes) {
    // Default ON: enabled unless the new value is explicitly false (see
    // loadStaleAutoHealEnabled).
    staleAutoHealEnabled = changes[STALE_AUTOHEAL_STORAGE_KEY].newValue !== false;
  }
  if (AUTO_REFIRE_STORAGE_KEY in changes) {
    // Default ON: enabled unless the new value is explicitly false (see
    // loadAutoRefireEnabled).
    autoRefireEnabled = changes[AUTO_REFIRE_STORAGE_KEY].newValue !== false;
  }
  if (SELF_HEAL_STORAGE_KEY in changes) {
    // Default ON: enabled unless the new value is explicitly false (see
    // loadSelfHealJsonEnabled).
    selfHealJsonEnabled = changes[SELF_HEAL_STORAGE_KEY].newValue !== false;
  }
  if (AUTOPILOT_STORAGE_KEY in changes) {
    // Another tab armed/disarmed a window (or this tab's own persist echoed
    // back) -- rebuild from the stored deadlines, dropping any already expired,
    // and repaint. Absolute timestamps mean this never extends a window.
    rebuildAutopilotWindowsFrom(changes[AUTOPILOT_STORAGE_KEY].newValue);
    updateAutopilotUi();
  }
  if (AUTOPILOT_DURATION_STORAGE_KEY in changes) {
    const mins = Number(changes[AUTOPILOT_DURATION_STORAGE_KEY].newValue);
    autopilotWindowMinutes = (Number.isFinite(mins) && mins > 0) ? mins : AUTOPILOT_DEFAULT_MINUTES;
    updateAutopilotUi();
  }
  if (MENU_HEIGHT_STORAGE_KEY in changes) {
    const newHeight = changes[MENU_HEIGHT_STORAGE_KEY].newValue;
    swMenuHeight = typeof newHeight === 'number' ? newHeight : null;
    applySwMenuHeight();
  }
  if (settingsDisclosure?.isOpen) renderSettingsDialog();
});

loadListeningEnabled();
loadGlobalListeningEnabled();
loadFaviconIndicatorEnabled();
loadFaviconDebugEnabled();
loadFaviconDisplaceEnabled();
loadPiggybackProbeEnabled();
loadConcurrentSendProbeEnabled();
loadStaleAutoHealEnabled();
loadAutoRefireEnabled();
loadSelfHealJsonEnabled();
loadAutopilotWindows();
loadSwMenuHeight();
hydrateFromRememberedUrlThread();

// --- persistent dispatch dedup: survive page reload ------------------------
// state.dispatchedBlocks (below, in the per-anchor WeakMap) only prevents
// re-dispatching a block within the SAME page load -- a reload creates fresh
// DOM anchors and thus a fresh WeakMap, so a full-thread re-scan after
// refresh would otherwise re-dispatch every historical ccsw block on the
// page. This Set is the reload-surviving counterpart: keyed by a fingerprint
// of (thread + the containing message's full text + normalized block JSON)
// -- NOT the anchor/message DOM index.
// An index-based fingerprint was tried and removed: Claude.ai's message DOM
// doesn't guarantee the same anchor lands at the same ordinal position on
// every load (partial/virtualized rendering reorders or drops what's
// currently mounted), so the same historical block could get a different
// index on reload and look brand new, causing the duplicate-dispatch bug
// this Set exists to prevent. DOM position is still deliberately excluded
// for that reason.
// BUG FIX: the fingerprint used to be JUST (thread + block JSON), with no
// message identity at all. That meant a genuine retry -- Claude re-emitting
// the byte-identical ccsw block in a brand-new assistant message, e.g. after
// job.php dropped the first dispatch with a 409 (repo locked) -- deduped
// against the earlier attempt and silently did nothing, because the two
// messages produced the exact same fingerprint. The containing message's
// own full text (already extracted as `text` for the stability check above)
// is a message-identity signal that's reload-stable (a historical message's
// rendered text is deterministic across loads, same as its block JSON
// already was) while still varying between two DIFFERENT messages -- so the
// SAME message reloaded still dedupes, but Claude re-emitting the block in a
// fresh message (which will have at least some different surrounding prose)
// now produces a new fingerprint and re-dispatches as a real retry. This
// relies on the retry message not being byte-identical in its entirety to
// the original one -- true in practice since Claude's own commentary varies
// per turn, but if CcswAgent's prompting ever produces a bare block with
// zero wrapping prose, two such retries would still collide.
// Persisted to chrome.storage.local so it's still populated after a fresh
// content-script instance loads. Capped to the newest
// MAX_DISPATCHED_FINGERPRINTS entries -- a long-lived thread's history
// doesn't need unbounded storage growth, and only recent blocks are ever at
// risk of a redundant re-scan anyway.
//
// NOT A DISPATCH GATE ANYMORE: this Set's original reload-protection job
// (stopping a page-reload re-scan from re-firing old blocks) now belongs
// entirely to scan()'s durable eligibility rule -- an already-dispatched block
// is recognised by its stableKey on the relay (rule (a)), and nothing
// dispatches at all without a recent durable beacon (rule (b)), regardless of
// fingerprints. That left this Set's fingerprint
// match doing only one thing in practice: silently dropping a deliberate
// re-emit of an identical block AFTER a real user send (which the send-guard
// correctly allows) -- forcing a pointless manual reword just to change the
// fingerprint. So fingerprints are still recorded below (harmless
// bookkeeping, kept in case something else needs the history) but a match is
// no longer used to block dispatch -- see the dispatch loop in scan(). Do
// NOT re-add a block-and-return on a fingerprint match; that resurrects the
// silent-drop bug.
const DISPATCHED_FP_STORAGE_KEY = 'ccswDispatchedFingerprints';
const MAX_DISPATCHED_FINGERPRINTS = 100;

let dispatchedFingerprints = new Set();

async function loadDispatchedFingerprints() {
  try {
    const stored = await chrome.storage.local.get(DISPATCHED_FP_STORAGE_KEY);
    const list = stored[DISPATCHED_FP_STORAGE_KEY];
    if (Array.isArray(list)) dispatchedFingerprints = new Set(list);
  } catch (err) {
    console.warn('[CCswitchboard] failed to load dispatched-block fingerprints, starting empty:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

async function recordDispatchedFingerprint(fingerprint) {
  dispatchedFingerprints.add(fingerprint);
  const capped = [...dispatchedFingerprints].slice(-MAX_DISPATCHED_FINGERPRINTS);
  dispatchedFingerprints = new Set(capped);
  try {
    await chrome.storage.local.set({ [DISPATCHED_FP_STORAGE_KEY]: capped });
  } catch (err) {
    console.warn('[CCswitchboard] failed to persist dispatched-block fingerprint:', err.message);
    handlePossibleContextInvalidation(err);
  }
}

loadDispatchedFingerprints();

// --- DURABLE DISPATCH STATE (the dispatch decision's only inputs) ----------
// A mirror of background.js's cache of the two relay-side records -- the
// per-thread user-send beacon (beacon.php) and the per-thread set of stableKeys
// that have already dispatched a job within the last 7 days (dispatched.php).
// Pushed here by the background worker's ccsw-durable-state broadcast, and
// requested once on injection (ccsw-durable-get) so a fresh tab isn't blind
// until the first poll tick.
//
// These replace the whole per-tab guard stack this file used to run on: the
// in-memory-plus-chrome.storage dispatchedBlockIdentities Set, the
// identityLastDispatchedAt ordering map, and the ccswLastUserSendAt timestamp.
// Every one of those was PER-TAB and PER-PAGE-LOAD, so none survived a reload,
// a tab close, or a service-worker restart -- and a block whose dispatch record
// died with the tab that made it would happily re-fire. The relay remembers.
//
//   beacons:        thread -> sentAt (client epoch ms of that thread's last user send)
//   dispatchedKeys: thread -> Set of stableKeys already dispatched (7d window)
let durableBeacons = new Map();
let durableDispatchedKeys = new Map();
let durableStateFetchedAt = 0;

// Blocks dispatched by THIS tab since the last broadcast landed. The relay has
// the row (job.php wrote it) but our cached Set may not have been refreshed
// yet, and one dispatched.php poll interval is an eternity next to the
// re-render storm claude.ai puts a streaming message through. Merged into the
// already-dispatched check below so a block cannot fire twice in that gap.
//
// Deliberately NOT a readiness signal (see durableStateReadyFor): a key here
// says "this one block ran", never "I know what this thread has run".
const locallyDispatchedKeys = new Map(); // thread -> Set<stableKey>

// Beacons for sends this tab just made, same rationale: the user's Enter
// keypress must authorize the very next block Claude emits, which can arrive
// long before the next poll reflects the beacon we posted.
const locallyPostedBeacons = new Map(); // thread -> sentAt

// The background worker instance whose state we last saw. See applyDurableState.
let lastWorkerInstanceId = null;

// BUG #17 (silent-miss on first send): set by scan() whenever it defers a block
// ONLY because that bucket's durable dispatched-key state had not arrived yet
// (the deferred_not_ready branch). Read and cleared by applyDurableState so the
// broadcast that finally carries those keys kicks an immediate re-decide instead
// of the block waiting for the next 2s fallback scan or a DOM mutation. Purely a
// hint: if it is ever stale the worst case is one extra idempotent scan pass.
let pendingDeferredRescan = false;

// Debounced re-scan used by (b) above. scan() is idempotent and fully re-guarded
// (see its finally + the dispatch-eligibility rules), so collapsing a burst of
// broadcasts into a single extra pass can never double-dispatch -- it only gives
// a block that deferred solely on missing durable state a prompt chance to be
// re-decided the instant the keys land.
let durableRescanTimer = null;
function scheduleDurableRescan() {
  clearTimeout(durableRescanTimer);
  durableRescanTimer = setTimeout(() => scan('durable-state-landed'), CONFIG.DEBOUNCE_MS);
}

function applyDurableState(state) {
  if (!state) return;
  if (Array.isArray(state.beacons)) durableBeacons = new Map(state.beacons);

  // MERGED per-thread, never wholesale-replaced.
  //
  // The worker's cache is in-memory, so an MV3 service-worker restart empties
  // it -- and the restart's first refresh broadcasts that empty map before it
  // has re-fetched anything. Replacing our map with it would discard the keys
  // this tab already knows are dispatched, and every thread would read as "not
  // ready" (or worse, later, as "nothing ever dispatched"). Merging keeps a
  // thread's last known-good Set until a real answer for THAT thread arrives.
  //
  // Losing an already-dispatched key is the dangerous direction (it re-fires a
  // spent block); keeping one a little past its 7-day expiry merely delays a
  // re-run that only a page reload was ever going to enable anyway.
  if (Array.isArray(state.dispatchedKeys)) {
    for (const [thread, keys] of state.dispatchedKeys) {
      durableDispatchedKeys.set(thread, new Set(keys));
    }
  }
  // MONOTONIC. durableStateReadyFor now keys readiness on "a fetch has ever
  // completed" (fetchedAt > 0), so this value must never walk BACKWARDS. A fresh
  // MV3 worker (idle teardown, restart) starts at fetchedAt 0 and answers the
  // first ccsw-durable-get with that 0 before it has re-fetched anything --
  // taking it verbatim would drop a tab that already had good state back to
  // "not ready" and re-defer every block until the new worker's first poll
  // lands. Only ever advance it; the new worker's real timestamp overtakes this
  // the moment it fetches.
  if (typeof state.fetchedAt === 'number' && state.fetchedAt > durableStateFetchedAt) durableStateFetchedAt = state.fetchedAt;

  // BUG #17 (b): the dispatched-key state a deferred block was waiting on may
  // have just landed above. scan()'s finally reopens the stability gate of any
  // block it defers (see there), but the re-decide only happens on an actual
  // scan -- and nothing else here schedules one, so without this the block
  // waits up to a full FALLBACK_SCAN_MS (or a chance DOM mutation) to fire.
  // Kick a debounced scan now, but ONLY when a block is actually waiting, so a
  // routine keep-alive broadcast with no deferred block pending doesn't churn
  // the DOM. The flag is cleared here; if that scan re-defers it is set again.
  if (Array.isArray(state.dispatchedKeys) && pendingDeferredRescan) {
    pendingDeferredRescan = false;
    scheduleDurableRescan();
  }

  // A new service-worker instance has none of the thread enrollments this tab
  // made with the old one, and enrollment is what makes a thread's keys get
  // polled at all. Re-announce every thread we've asked about. Without this, an
  // MV3 idle teardown (routine, minutes) permanently strands an open tab: its
  // blocks defer, no pill, no dispatch, until the page is reloaded.
  if (state.workerInstanceId && state.workerInstanceId !== lastWorkerInstanceId) {
    const previous = lastWorkerInstanceId;
    lastWorkerInstanceId = state.workerInstanceId; // set FIRST -- requestDurableState's reply re-enters here
    if (previous !== null) {
      console.log(`[CCswitchboard] background worker restarted (${previous} -> ${state.workerInstanceId}) -- re-enrolling ${durableStateRequestedThreads.size} thread(s) for durable polling.`);
      for (const thread of durableStateRequestedThreads) requestDurableState(thread);
    }
    if (hydratedThread) requestDurableState(hydratedThread);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-durable-state') return false; // not for us
  applyDurableState(message);
  return false; // no response needed
});

// Ask for whatever the worker last fetched rather than waiting a poll interval.
// Until this lands (or the first broadcast does), scan() defers every block.
//
// Passing `thread` also ENROLLS it for polling, which is what lets a thread that
// has never dispatched anything ever dispatch at all -- the worker otherwise
// only tracks threads that have already dispatched. Called once at injection
// (usually before the thread is known) and again the moment it hydrates.
function requestDurableState(thread) {
  try {
    chrome.runtime.sendMessage({ type: 'ccsw-durable-get', thread: thread || undefined })
      .then(applyDurableState)
      .catch((err) => handlePossibleContextInvalidation(err));
  } catch (err) {
    // Dead extension context -- the broadcast path will catch up.
  }
}

requestDurableState(null);

// Threads we've already asked the worker to enroll, so a scan storm over a
// not-yet-known thread doesn't fire a request per block per pass.
const durableStateRequestedThreads = new Set();

// A block's own `thread` field need not be the thread this tab hydrated -- and
// an unenrolled thread is one scan() will defer forever, since its keys are
// never fetched. Ask once, then let the deferral stand until they arrive.
function ensureDurableStateRequested(thread) {
  if (!thread || durableStateRequestedThreads.has(thread)) return;
  durableStateRequestedThreads.add(thread);
  requestDurableState(thread);
}

// Blocks whose 'deferred_not_ready' decision has already been logged once.
const deferredDecisionsLogged = new Set();

// First time we found a thread's durable state not-yet-fetched (fetchedAt still
// 0). Used only for the bounded fail-open below; keyed per thread so one thread
// waiting doesn't start another's clock.
const durableFirstUnfetchedWaitAt = new Map();
// Threads whose fail-open we've already screamed about, so the console warning
// is emitted once per thread, not once per scan pass.
const durableFailOpenLogged = new Set();

// Can rule (a) be answered for this thread yet?
//
// THE ARRIVED-TEST (deferred dispatch-death fix). This used to require a
// per-thread bucket to be PRESENT: `fetchedAt > 0 && dispatchedKeys.has(thread)`.
// That conflated two very different states of a *completed* fetch:
//   - "fetch done, thread HAS a bucket"  -> answerable (as before)
//   - "fetch done, thread has NO bucket" -> was treated as "still unknown"
// but a completed fetch that returns no bucket for a thread does not mean
// "unknown" -- it means the relay has ZERO dispatch history for it (empty set).
// A brand-new thread, and every thread on a fresh/empty relay after a FAILOVER,
// is exactly this shape: the relay's dispatched.php answers 200 with
// stableKeys:[] and no bucket is created, so the old test deferred every block
// on that relay FOREVER (the reported all-threads dispatch death).
//
// Fail-safe principle: on ambiguity favour DISPATCH, not an eternal hold. Once
// ANY relay fetch has completed (fetchedAt > 0) the state has arrived for every
// thread; a missing bucket then reads as the empty set, and isStableKeyDispatched
// already returns false for it -- rule (a) answers "not dispatched" normally.
// This does NOT resurrect history: a historical block is not the last anchor
// (ignored_ancient), and the newest block still needs rule (b)'s recent beacon
// (or autopilot) to actually fire.
//
// GENUINELY unfetched (fetchedAt still 0: relay down / no token / wrong base)
// still defers -- but not forever. After CCSW_DURABLE_FETCH_FALLBACK_MS of
// retries with no successful fetch at all, we log loudly and fail open to the
// local (this-tab) dedup sets rather than deferring eternally.
//
// A block with NO thread at all is "ready" -- vacuously, since neither
// dispatched.php nor beacon.php keys anything without one. It falls through to
// rule (b), finds no beacon, and gets a held pill. Deferring it instead would
// strand it silently with no pill and no way to dispatch it by hand.
function durableStateReadyFor(thread) {
  if (!thread) return true;

  // A completed fetch answers for EVERY thread (present bucket OR empty set).
  if (durableStateFetchedAt > 0) {
    durableFirstUnfetchedWaitAt.delete(thread); // reset the fail-open clock
    return true;
  }

  // No relay fetch has EVER succeeded. Defer -- but bound it so a permanently
  // unreachable relay can't hold every block down forever.
  const now = Date.now();
  const since = durableFirstUnfetchedWaitAt.get(thread);
  if (since === undefined) {
    durableFirstUnfetchedWaitAt.set(thread, now);
    return false;
  }
  if (now - since >= CCSW_DURABLE_FETCH_FALLBACK_MS) {
    if (!durableFailOpenLogged.has(thread)) {
      durableFailOpenLogged.add(thread);
      console.error(`[CCswitchboard] DURABLE STATE NEVER ARRIVED for thread "${thread}" after ${Math.round((now - since) / 1000)}s of retries (relay down / no usable token / wrong relay base?). FAILING OPEN to local dedup sets so blocks stop deferring forever -- check the active relay/token in background.js.`);
    }
    return true;
  }
  return false;
}

// RULE (a): has this exact block already dispatched a job in this thread?
// The scan() job-dispatch call site below always passes a resolveDedupBucket()
// result now (see its comment), which is never vacuously empty -- but the
// actions-block call site further up still passes its own plain
// `parsed.thread || hydratedThread`, which can be null. Map#get(null) simply
// finds nothing, same net effect as the old `!thread` early return, so
// dropping that guard changes nothing observable either way -- it's just dead
// weight once the common case can't hit it.
function isStableKeyDispatched(thread, stableKey) {
  if (!stableKey) return false;
  if (durableDispatchedKeys.get(thread)?.has(stableKey)) return true;
  return !!locallyDispatchedKeys.get(thread)?.has(stableKey);
}

// #84 (threadless-block triple-dispatch): rule (a)'s dedup bucket used to be
// `parsedBlock.thread || hydratedThread` wherever it was computed, which
// buckets a THREADLESS block (no `thread` field) under whatever THIS TAB
// happens to have hydrated -- three tabs open on the same claude.ai
// conversation can each hydrate a different (or no) thread name, so each one
// buckets the same block separately and all three dispatch it.
//
// getConversationKey() (location.pathname) is the same stable per-conversation
// identity URL_THREAD_STORAGE_KEY already keys on -- every tab open on the
// same conversation resolves the SAME value from it regardless of what each
// tab hydrated, so this closes the gap. hydratedThread remains the last-resort
// fallback only for the practically-unreachable case where the URL itself is
// unavailable. A block that DOES declare an explicit thread is unaffected:
// that value wins here exactly as it always has, so a threaded block's bucket
// -- and therefore its dispatch behaviour -- is unchanged.
function resolveDedupBucket(explicitThread) {
  return explicitThread || getConversationKey() || hydratedThread || null;
}

// RULE (b) input: when did a real user send last land in this thread? The
// later of the relay's record and this tab's own un-polled send.
function beaconSentAtFor(thread) {
  if (!thread) return 0;
  return Math.max(durableBeacons.get(thread) || 0, locallyPostedBeacons.get(thread) || 0);
}

function recordLocalDispatchedKey(thread, stableKey) {
  if (!thread || !stableKey) return;
  if (!locallyDispatchedKeys.has(thread)) locallyDispatchedKeys.set(thread, new Set());
  locallyDispatchedKeys.get(thread).add(stableKey);
}

function recordLocalBeacon(thread, sentAt) {
  if (!thread) return;
  locallyPostedBeacons.set(thread, Math.max(locallyPostedBeacons.get(thread) || 0, sentAt));
}

// BUG FIX (in-flight dispatch race). KEPT under the durable rule -- it is the
// only SYNCHRONOUS layer, and the durable rule cannot replace it.
//
// Rule (a) reads a record that exists only once job.php has answered:
// recordLocalDispatchedKey runs in dispatchCcswBlock's response.ok branch,
// after an await. If claude.ai virtualizes this block's anchor DURING that
// round-trip (routine mid-thread), the recreated anchor gets a fresh empty
// state.dispatchedBlocks, and a re-scan finds rule (a) still false (no record
// yet), rule (b) still true (same recent beacon), and the block still in the
// newest message -- so it dispatches a SECOND time. This Set is added to
// BEFORE the await and so covers exactly that window. Cleared on every exit
// path of dispatchCcswBlock (try/finally), so a dropped/failed dispatch never
// permanently blocks a re-fire.
const inFlightDispatch = new Set();

// Cheap non-cryptographic (FNV-1a) hash -- this only needs to be a stable,
// collision-unlikely fingerprint for dedup purposes, not a security hash.
// Keyed by thread + the containing message's full extracted text (the
// message-identity signal -- see the comment above dispatchedFingerprints)
// + the parsed-and-restringified block payload (not the raw block text, so
// incidental whitespace differences in how the fence content re-renders
// don't produce a different fingerprint for the same JSON). Deliberately
// NOT keyed by any DOM position -- an index-based key isn't reload-stable,
// per the same comment.
function fingerprintBlock(thread, messageText, parsedBlock) {
  const input = `${thread || ''}\x1f${messageText || ''}\x1f${JSON.stringify(parsedBlock)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

// FNV-1a, 64-bit, as a 16-char zero-padded hex string. Deterministic and
// dependency-free, same as the 32-bit loop above -- just wider.
//
// WHY 64-BIT: the identity hash below keys a durable set -- jobs.stable_key on
// the relay, served back by dispatched.php. At 32 bits, birthday collisions become
// non-trivial over a long-lived thread's block history, and a collision there
// is not a cosmetic glitch: a fresh block that happens to collide with an
// already-dispatched key would be treated as already-dispatched and held
// FOREVER, silently. 64 bits pushes that back out of reach for any realistic
// number of blocks. fingerprintBlock above keeps its 32-bit hash on purpose --
// it's a per-page-load dedup key, not an all-time identity.
//
// The 64-bit state is carried as two 32-bit halves because JS numbers can't
// hold an exact 64-bit integer. Every intermediate product below is chosen to
// stay under 2^53 so it's exact in a double:
//   prime 0x100000001b3 = (hi 0x00000100, lo 0x000001b3 = 435)
//   lo * 435   < 2^41    hi * 435  < 2^41    lo * 256 < 2^40
// `>>> 0` then reduces each exact result mod 2^32 (ToUint32), which is
// precisely the 64-bit-multiply carry arithmetic we want.
function fnv1a64Hex(input) {
  let hi = 0xcbf29ce4; // offset basis 0xcbf29ce484222325, split hi/lo
  let lo = 0x84222325;
  for (let i = 0; i < input.length; i++) {
    // XOR the whole 16-bit code unit, matching the 32-bit loop's convention
    // (JS strings are UTF-16; this never truncates a surrogate half away).
    lo = (lo ^ input.charCodeAt(i)) >>> 0;
    const loTimesPrimeLo = lo * 435; // exact: < 2^41
    const carry = Math.floor(loTimesPrimeLo / 4294967296);
    // hi must be computed from the PRE-update lo, hence the ordering here.
    hi = (hi * 435 + lo * 256 + carry) >>> 0;
    lo = loTimesPrimeLo >>> 0;
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

// Same FNV-1a hash as fingerprintBlock, but keyed ONLY by the block's own
// stable identity -- no surrounding message text. This is THE dispatch
// identity: the key rule (a) looks up, and the value written to
// jobs.stable_key. It must not move when the containing message re-renders,
// which is exactly what fingerprintBlock's message-text-scoped key does.
//
// BUG FIX (held-pill resurrection): this used to hash
// `JSON.stringify(parsedBlock)`, which folds the WHOLE object -- every key,
// in whatever order the block's JSON happened to spell them, including
// presentational fields (summary, continue, readonly, ...) that don't change
// which job the block describes. Any variation in those produced a different
// key for a logically identical block, so it never matched the recorded
// dispatched-key set and got re-held on every scan.
//
// Instead, hash an explicit, FIXED-ORDER list of only the fields that
// identify the block's WORK. Field order is fixed by this array literal, not
// by the JSON's key order, and unlisted fields can't perturb the result --
// so the same block always yields the same key, across scans and reloads.
// NUL-delimited so a value ending where the next begins can't alias (same
// convention as fingerprintBlock above).
function fingerprintBlockStable(thread, parsedBlock) {
  const parts = [
    parsedBlock.thread || thread || '',
    parsedBlock.type || '',
    parsedBlock.cwd || '',
    parsedBlock.prompt || '',
    parsedBlock.command || '',
    parsedBlock.name || '',
  ];
  const input = parts.join('\x1f');
  // 64-bit (see fnv1a64Hex): this key is now ALSO written to the relay as
  // jobs.stable_key, so it must stay collision-free over a thread's whole
  // history, not just one page load. Same canonical, fixed-order,
  // NUL-delimited input as before -- only the hash WIDTH changed, so keys
  // minted before that change do not match ones minted after. Any 32-bit keys
  // still on the relay simply never match a block again, and age out of the
  // 7-day window; the worst case is one block re-dispatching once.
  return fnv1a64Hex(input);
}

// DEBUG (held-pill resurrection investigation): same FNV-1a as above, but
// over the RAW block text (pre-parse) instead of the parsed/field-selected
// payload -- used by held_decision's rawHash so two held events can be
// compared for exact-text identity independent of fingerprintBlockStable's
// field selection. See the held_decision logEvent call for how this
// discriminates a fingerprint bug from genuinely-different blocks. Widened to
// 64-bit alongside fingerprintBlockStable so the two stay comparable in the
// log; nothing keys a decision off this value.
function hashRawBlockText(text) {
  return fnv1a64Hex(text);
}

// #61: identity key for an actions-only ccsw block, so it can join the SAME
// dispatched-ledger rule (a) job blocks use (isStableKeyDispatched /
// recordLocalDispatchedKey) instead of re-POSTing the same items to
// actions.php on every re-scan (an F5 while the recent-beacon window is
// still open re-fires the last anchor's block -- see dispatchCcswBlock).
//
// Deliberately NOT fingerprintBlockStable: that hashes only
// [thread, type, cwd, prompt, command, name], none of which an actions-only
// block (no job to run) ever sets -- every such block in a thread would
// collide on the same near-constant key, and the first one dispatched would
// silently suppress every DIFFERENT actions block that came after it in that
// thread. Folding in the actions content itself keeps distinct blocks
// distinct. `validActions` is already {text, tier}-filtered and in the
// block's own order, so this is deterministic per block content.
function fingerprintActionsBlock(thread, validActions) {
  const normalized = validActions.map((a) => `${a.text.trim()}${a.tier}`).join('');
  return fnv1a64Hex(`${thread || ''} actions ${normalized}`);
}

// BUG FIX (held-pill pileup): claude.ai's virtualized DOM recreates an
// anchor's DOM node on scroll/re-render, handing scan() a fresh `seen`
// WeakMap entry (and thus a fresh, empty state.dispatchedBlocks) for what is
// logically the SAME historical block. The per-anchor state alone can't
// dedup across that recreation, so this Set tracks which blocks already have
// a held pill on screen at the module level, keyed by fingerprint (or raw
// block text when the block doesn't parse) -- it survives anchor recreation
// for the lifetime of this content-script instance. Deliberately NOT
// persisted to chrome.storage: a fresh reload is supposed to re-show one held
// pill per still-undispatched historical block (see showHeldForSendBar's
// comment), just never more than one per scan-storm within the same load.
let heldBlockKeys = new Set();

// The last user send in THIS TAB's thread, for display on held pills only --
// never a dispatch input (scan() reads the beacon per-BLOCK-thread, which is
// not always this tab's thread). Reads through the same durable beacon the
// decision uses, so what a held pill claims and what held it agree.
//
// This replaces the ccswLastUserSendAt global these two call sites used to
// read. Note the wording change it forces: the beacon is per-thread and
// durable, so "no user send yet this page load" was never the right sentence
// -- a reload no longer erases the send.
function lastUserSendAtForDisplay() {
  return beaconSentAtFor(hydratedThread);
}

function scan(trigger) {
  // Reap ghosts whose owning message got virtualized away before anything
  // could claim them (bug #29). Runs first, on every scan, so an orphan never
  // outlives the scan that follows its anchor's unmount.
  sweepGhosts();

  const anchors = document.querySelectorAll(SELECTORS.feedbackButton);
  // Quieted per feedback: the 2s fallback-interval timer used to print this
  // line forever as a heartbeat even with nothing to report. Startup and
  // mutation-driven scans still announce their count (key stage logs).
  if (trigger !== 'fallback-interval') {
    console.log(`[CCswitchboard] scan() via ${trigger}: found ${anchors.length} feedback button(s) (= assistant messages).`);
  }

  const now = Date.now();

  anchors.forEach((anchor, i) => {
    const existing = seen.get(anchor);
    const isNewAnchor = !existing;

    const container = findMessageTurnContainer(anchor);
    if (isNewAnchor) {
      const cls = String(container.className || '').slice(0, 80);
      console.log(`[CCswitchboard] anchor #${i}: walked up to <${container.tagName.toLowerCase()} class="${cls}">`);
    }

    const text = extractMessageText(container);
    if (!text) {
      if (isNewAnchor) console.log(`[CCswitchboard] anchor #${i}: container produced no text, skipping.`);
      return;
    }

    // In-message job cards: hide each raw ccsw <pre> and render a compact,
    // live-status card in its place. Runs AFTER extractMessageText above (which
    // strips .ccsw-job-card from its clone, so cards can't perturb the captured
    // text or the stability gate) and BEFORE the dispatch decision below, and is
    // fully exception-safe -- a throw here must never break the dispatch scan.
    try {
      decorateCcswJobCards(container);
    } catch (err) {
      console.warn(`[CCswitchboard] anchor #${i}: job-card decorate failed (non-fatal):`, err?.message);
    }

    // Hydrate the SW menu from storage as soon as any thread tag is visible
    // on the page, independent of the stability-gated dispatch flow below.
    // recordSessionJob() (the dispatch flow's only hydrate trigger) fires on
    // a NEW dispatch, which requires the stability timer below to elapse --
    // on a plain refresh that can be seconds away or may never happen at all
    // (e.g. the page's only ccsw blocks are historical and don't change).
    // This is a pure storage read with no dispatch side effect, so it's
    // safe to attempt on every scan; skipped once a thread's been found to
    // avoid needless reparsing.
    if (!hydratedThread) {
      findCcswBlocks(container).forEach((blockText) => {
        try {
          const parsed = JSON.parse(blockText.trim());
          if (parsed?.thread) hydrateSessionJobsForThread(parsed.thread);
        } catch {
          // Still streaming / not valid JSON yet -- a later scan will retry.
        }
      });
    }

    const state = existing ?? { lastText: '', stableSince: now, loggedText: null, dispatchedBlocks: new Set(), ghostEl: null };

    // Ghost pill: fires the instant a ```ccsw fence starts appearing, well
    // before the stability timer below would otherwise notice anything.
    // Gated on findCcswBlocks still being empty so it only shows for a
    // genuinely incomplete/still-streaming block -- a block that's already
    // complete (including on a fresh page load re-scanning old history)
    // skips straight past this and is handled by the stability branch as
    // before, with no ghost ever created for it.
    //
    // ALSO gated on `state.loggedText !== text` (bug #29). The ONLY place a
    // ghost is claimed or disposed is the stability branch below, and that
    // branch is one-shot per distinct text: once it has run, `loggedText ===
    // text` keeps it from ever running again. So a ghost created for a text
    // that has ALREADY been through block-processing is, by construction,
    // unclaimable -- nothing will morph it and nothing will remove it. That
    // happens when a settled anchor's code block re-renders (highlight swap,
    // lazy re-mount): for one scan findCcswBlocks momentarily reads 0 while
    // the <code class="...ccsw"> element is still there for
    // hasCcswOpeningFence to match, and the old condition minted a permanent
    // "detecting..." ghost. Refusing to create it is cheaper and more honest
    // than reaping it a scan later.
    if (!state.ghostEl && state.loggedText !== text && hasCcswOpeningFence(container) && findCcswBlocks(container).length === 0) {
      state.ghostEl = createGhostBar(anchor, `anchor#${i}`);
      console.log(`[CCswitchboard] anchor #${i}: ccsw opening fence detected mid-stream, showing ghost pill.`);
    }

    if (text !== state.lastText) {
      // Quieted per feedback: this used to log every growth tick while a
      // message streams in (many times per response) -- only the initial
      // capture is a real stage transition; the "Completed" log below still
      // reports the final text once the stability timer fires.
      if (isNewAnchor) {
        console.log(`[CCswitchboard] anchor #${i}: text captured (len=${text.length}): "${preview(text)}" -- stability timer started.`);
      }
      state.lastText = text;
      state.stableSince = now;
    } else if (now - state.stableSince >= CONFIG.STABLE_MS && state.loggedText !== text) {
      console.log(`[CCswitchboard] anchor #${i}: stability timer fired -- Completed assistant message:\n` + text);
      state.loggedText = text;

      if (!globalListeningEnabled || !listeningEnabled) {
        console.log(`[CCswitchboard] anchor #${i}: ${!globalListeningEnabled ? 'global listening' : 'listening'} is off, skipping ccsw block parsing/dispatch.`);
        if (state.ghostEl) {
          removeGhostBar(state.ghostEl, 'listening_off');
          state.ghostEl = null;
        }
      } else {
        // There's only ever one ghost per anchor -- hand it to whichever
        // block below is the first to actually reach dispatchCcswBlock, so
        // it morphs into that block's real pill. Any further blocks in the
        // same message just get their own fresh pill, same as if there'd
        // been no ghost at all.
        let ghostToConsume = state.ghostEl;
        state.ghostEl = null;

        // Why the ghost went unclaimed, for the ghost_dispose log below. Set
        // by whichever decision branch returned without taking the ghost; the
        // last such block wins, which is the one whose outcome the operator
        // actually wants to see. 'no_block' is the no-usable-blocks default.
        let unclaimedReason = 'no_block';

        // BUG #17 (a): true if ANY block in this message took the
        // deferred_not_ready branch -- deliberately not derived from
        // unclaimedReason (which only records the LAST block's outcome, so a
        // deferred block followed by a dispatched one would be lost). Read in
        // the finally to reopen this message's one-shot stability gate so the
        // deferred block is re-decided on the next scan.
        let anyBlockDeferred = false;

        // SCAN-DBG (scan_gap): instrumenting the long-block silent-miss
        // family -- a settled message can carry a ```ccsw opening fence yet
        // findCcswBlocks still return nothing for it (e.g. an unterminated/
        // truncated fence, or a shape neither extraction path recognizes).
        // This branch already runs exactly once per distinct settled text
        // (gated on state.loggedText above), so no extra dedup guard is
        // needed to log this once per message. fenceCount has no existing
        // helper -- counted fresh here with the same opening-fence pattern
        // hasCcswOpeningFence uses, just globally and counted rather than
        // tested.
        const ccswBlocksFound = findCcswBlocks(container);
        if (ccswBlocksFound.length === 0 && hasCcswOpeningFence(container)) {
          const fenceCount = (container.textContent ?? '').match(/```ccsw(?:[ \t]|\r?\n|$)/gi)?.length ?? 0;
          // Not just a relay event: this is a SILENT EXIT (the forEach below has
          // nothing to iterate, so nothing else in this branch logs). A settled
          // message shows a ```ccsw fence yet findCcswBlocks extracts no usable
          // block -- if dispatch ever dies here, this is the only trace.
          console.warn(`[CCswitchboard] anchor #${i}: ${fenceCount} ccsw fence(s) present but findCcswBlocks extracted 0 usable blocks -- nothing to dispatch (block still streaming, or an unrecognised/truncated fence).`);
          logEvent('scan_gap', { anchorPosition: i, fenceCount, blocksFound: 0 }, null, true);
        }

        // EVERY exit from block-processing -- including a throw out of the
        // forEach -- disposes a ghost nothing claimed. This is what makes it
        // impossible to add a new early-return branch to the dispatch decision
        // (Stage 3 added six) and strand a "detecting..." pill by forgetting
        // to clean up in it. See bug #29.
        try {
          ccswBlocksFound.forEach((blockText) => {
            const trimmed = blockText.trim();
            if (!trimmed || state.dispatchedBlocks.has(trimmed)) {
              // Reason-only: this block can't claim the ghost either, so stop
              // the finally reporting a stale reason from a prior iteration.
              unclaimedReason = trimmed ? 'already_handled_this_anchor' : 'empty_block';
              return;
            }

            // Parsed here (in addition to dispatchCcswBlock's own parse) purely
            // to build the fingerprint from `thread` + `text` (this message's
            // full extracted text) + the parsed payload -- moved ahead of the
            // send-guard below so BOTH the held branch and the dispatch branch
            // can consult dispatchedFingerprints. Invalid JSON just falls
            // through with fingerprint == null; the held branch then falls back
            // to `trimmed` for its own dedup key (see heldBlockKeys), and the
            // dispatch path below still lets dispatchCcswBlock's own parse
            // report the real warning.
            // Same sanitizing parse dispatchCcswBlock uses -- see parseCcswBlockText
            // for why the two must not diverge.
            //
            // DESTRUCTURE the wrapper (`{ parsed, usedSanitize, foundClasses,
            // error }`), which is never a bare null. Assigning the wrapper itself
            // to parsedBlock made parsedOk permanently true and left every payload
            // field undefined -- so fingerprintBlockStable hashed six empty
            // strings and handed EVERY block in a thread the same stableKey. The
            // first dispatch in a thread then made rule (a) swallow all the rest
            // as `ignored_already`: no job, and no pill to notice it by.
            const { parsed: parsedBlock } = parseCcswBlockText(trimmed);
            const parsedOk = parsedBlock !== null;
            const fingerprint = parsedOk ? fingerprintBlock(parsedBlock.thread, text, parsedBlock) : null;
            // Message-text-INDEPENDENT identity (see fingerprintBlockStable) --
            // the key the durable dispatch rule below is decided on, so an
            // already-dispatched block can't come back to life just because its
            // containing message mutated since it dispatched.
            const stableKey = parsedOk ? fingerprintBlockStable(parsedBlock.thread, parsedBlock) : null;

            // ARRIVAL-NOVELTY probe (observe-only -- see pageLoadTime's comment).
            // Emitted for EVERY block that reaches the dispatch/hold decision,
            // parsed or not, BEFORE any of the guards below run, so the log
            // records what the guards saw rather than what survived them. An
            // unparseable block still has an identity: the hash of its raw text.
            // Nothing downstream reads seenBlockIdentitiesThisSession -- it only
            // feeds this classification.
            //
            // arrivalClassification is hoisted out of the try so the FRESH-NONLAST
            // probe below (also observe-only) can read what this probe already
            // computed instead of recomputing it. The probe itself keeps its
            // never-throw guarantee: the hoisted var stays null if anything here
            // throws, and nothing downstream treats null as a real classification.
            let arrivalClassification = null;
            try {
              const arrivalRawHash = hashRawBlockText(trimmed);
              const arrivalKey = stableKey ?? `raw:${arrivalRawHash}`;
              const sawBefore = seenBlockIdentitiesThisSession.has(arrivalKey);
              const classification = isInitialScan ? 'present_at_load' : sawBefore ? 're_seen' : 'new_arrival';
              arrivalClassification = classification;
              seenBlockIdentitiesThisSession.add(arrivalKey);
              logEvent('block_arrival', {
                name: (parsedOk && typeof parsedBlock.name === 'string' && parsedBlock.name.trim()) || 'Job',
                stableKey,
                rawHash: arrivalRawHash,
                classification,
                msSincePageLoad: Date.now() - pageLoadTime,
                isInitialScan,
                sawBefore,
                anchorConnected: anchor.isConnected,
              });
            } catch (err) {
              // Instrumentation must never take a real code path down with it.
            }

            // ================= DISPATCH ELIGIBILITY (durable rule) ============
            // Exactly four cases, evaluated top to bottom:
            //
            //   (a) ALREADY DISPATCHED -- the block's stableKey is in the thread's
            //       durable dispatched-key set (jobs.stable_key, within the
            //       relay's 7-day window). => ignored_already, silent, no pill.
            //   (b) NOT THE LAST ANCHOR -- some later assistant message exists, so
            //       this block cannot be the reply to the newest send. It is
            //       scrollback. => ignored_ancient, silent, no pill. This holds
            //       EVEN IF the thread has a recent beacon: that beacon belongs to
            //       whatever Claude replied with in the LAST anchor, not to this.
            //   (c) LAST ANCHOR + RECENT BEACON -- a real user send inside
            //       CCSW_SEND_WINDOW_MS, and this is the newest assistant message.
            //       That is a fresh reply. => DISPATCH.
            //   (d) LAST ANCHOR + NO RECENT BEACON -- newest message, but no send
            //       authorises it. => HELD pill. The one and only hold -- UNLESS
            //       an autopilot window is armed for this thread (see
            //       autopilotArmedFor), which stands in for the missing human
            //       send and dispatches instead. Autopilot bypasses ONLY this
            //       rule-B hold; rules (a) and (b) above are untouched.
            //
            // WHY (b) EXISTS. (a) and the beacon alone leave a hole: an ANCIENT
            // block that never dispatched (Jody held it, or it errored before
            // job.php ever saw it) sits in scrollback passing (a) forever. The
            // moment any user send lands in that thread the beacon opens -- and
            // the old block fires, authorised by a message that had nothing to do
            // with it. A beacon says "the user sent SOMETHING recently", never
            // "the user asked for THIS block". Position supplies the missing link:
            // a block Claude just emitted in reply to that send is, by
            // construction, the last anchor. Scrollback never is.
            //
            // WHEN IN DOUBT, DISPATCH. This is the hard-won half. The previous
            // revision reasoned the other way -- "a wrong dispatch runs a stale
            // job, a wrong hold costs one click, so require PROOF to dispatch" --
            // and demanded that proof from `postDatesLastSend`, an anchor-count
            // comparison. Under claude.ai's virtualized DOM the count is not
            // monotonic (see anchorCountAtLastSend), so the proof was unobtainable
            // for perfectly fresh blocks: they held. All of them, in every tab,
            // until the extension was rolled back by hand. A hold is not a cheap
            // failure when it is the DEFAULT failure -- it is a dead extension.
            //
            // So no predicate here may hold on uncertainty. The two we keep are
            // the two that are answerable from the DOM as it stands right now,
            // with no claim about the past: "is this key in the ledger" and "is
            // this the last anchor". Neither can come back unknown. Nothing else
            // gets a vote, and any future signal that CAN come back unknown must
            // resolve toward dispatch, never toward hold.
            const blockThread = (parsedOk && parsedBlock.thread) || hydratedThread || null;

            // #84 (threadless-block triple-dispatch): rule (a)'s ledger is keyed
            // on dedupBucket, NOT blockThread. blockThread falls back to THIS
            // TAB's hydratedThread, which several tabs on the same conversation
            // do not agree on (or may not have at all) -- resolveDedupBucket()
            // falls back to the conversation's URL identity instead, which every
            // tab on that conversation resolves identically. blockThread remains
            // the right key for everything else (job payload routing, the pill's
            // thread) -- only rule (a)'s readiness/lookup below moves.
            const dedupBucket = resolveDedupBucket(parsedOk && parsedBlock.thread);

            // BUG FIX (#47, one-identity invariant): rule B's beacon lookup MUST
            // use the same key sendUserSendBeacon() writes it under -- this TAB's
            // hydrated identity, not the block's self-declared parsed.thread.
            // Those two diverge whenever a conversation was hydrated under one
            // thread name (e.g. from the URL->thread map, hydrateSessionJobsForThread)
            // and a later block declares a different one: the beacon is written
            // under the hydrated name (sendUserSendBeacon reads hydratedThread,
            // falling back to loadUrlThread()), so reading it back under
            // blockThread finds nothing and the block holds forever, un-resolvably
            // -- no user send will ever land under a thread name nothing writes
            // beacons for. blockThread is still the right key for everything else
            // (job payload routing, the pill's thread) -- only this read moves.
            const tabThread = hydratedThread || null;

            // DEFER: we don't yet know what this bucket has dispatched, so rule
            // (a) is unanswerable. An unfetched bucket is indistinguishable from
            // one that has never dispatched anything, and guessing "never" would
            // resurrect its entire history. Skip the block WITHOUT marking it
            // handled (no state.dispatchedBlocks, no heldBlockKeys, no pill) so
            // the next scan -- the MutationObserver fires continuously, and the
            // broadcast lands in milliseconds -- decides it properly.
            if (!durableStateReadyFor(dedupBucket)) {
              ensureDurableStateRequested(dedupBucket);
              // Logged once per block, not once per scan pass: the fallback-interval
              // scan re-reaches this line every 2s for every block in a thread whose
              // keys are slow to arrive, and the debug log is not a heartbeat.
              const deferKey = `${dedupBucket}:${stableKey || trimmed}`;
              if (!deferredDecisionsLogged.has(deferKey)) {
                deferredDecisionsLogged.add(deferKey);
                // SILENT-EXIT TRACE. This is the one dispatch outcome that
                // produces no pill and (until now) no console line, yet it
                // REOPENS the stability gate (anyBlockDeferred below), so a
                // block stuck here re-fires "Completed assistant message" every
                // scan and looks like a dead extension. It stays deferred until
                // the thread's durable dispatched-key set arrives from the relay
                // -- if that never lands (relay down / no usable relay token /
                // wrong relay base), the block defers FOREVER, silently. Logged
                // once per block (deferredDecisionsLogged), not per scan.
                console.warn(`[CCswitchboard] anchor #${i}: DEFERRED -- durable dispatched-key state for bucket "${dedupBucket}" has not arrived yet, so rule (a) is unanswerable. Block will re-decide once the relay responds; if it never does, check the active relay/token in background.js. name=${(parsedOk && typeof parsedBlock.name === 'string' && parsedBlock.name.trim()) || 'Job'} stableKey=${stableKey ? stableKey.slice(0, 12) : null} durableStateFetchedAt=${durableStateFetchedAt || 'never'}`);
                logEvent('dispatch_decision_v2', {
                  name: (parsedOk && typeof parsedBlock.name === 'string' && parsedBlock.name.trim()) || 'Job',
                  stableKey,
                  thread: blockThread,
                  tabThread,
                  blockThread,
                  dedupBucket,
                  outcome: 'deferred_not_ready',
                  durableStateFetchedAt: durableStateFetchedAt || null,
                });
              }
              unclaimedReason = 'deferred';
              // BUG #17: this block was skipped WITHOUT being marked handled
              // (no state.dispatchedBlocks, no heldBlockKeys, no pill) on the
              // promise the next scan re-decides it. Flag it here so the finally
              // reopens the stability gate (a), and tell applyDurableState a
              // block is waiting so the keys-landed broadcast re-scans (b).
              anyBlockDeferred = true;
              pendingDeferredRescan = true;
              return;
            }

            // Rule B reads the beacon under tabThread (the write-key) -- see the
            // BUG FIX comment above. blockThread is passed nowhere in this line.
            const beaconSentAt = beaconSentAtFor(tabThread);
            const beaconAgeMs = beaconSentAt ? Date.now() - beaconSentAt : null;
            const anchorPosition = i;
            const newestAnchorPosition = anchors.length - 1;

            const ruleA_alreadyDispatched = isStableKeyDispatched(dedupBucket, stableKey);
            const ruleB_recentBeacon = beaconSentAt > 0 && beaconAgeMs <= CCSW_SEND_WINDOW_MS;
            // AUTOPILOT WINDOW: while armed for this tab's thread, dispatch is
            // authorised without a fresh human send. Read under tabThread -- the
            // same key rule B's beacon read and the SW menu's arm both use.
            const autopilotAuthorized = autopilotArmedFor(tabThread);
            // querySelectorAll returns anchors in document order, so the newest
            // assistant message is the last one. This is the WHOLE newest-message
            // signal now: a question about the DOM as it stands, which always has
            // an answer. A freshly-emitted reply IS the last anchor.
            const isLastAnchor = anchorPosition === newestAnchorPosition;
            const isNewestMessage = isLastAnchor;
            // DIAGNOSTIC ONLY -- the anchor-count comparison that used to gate
            // dispatch and held everything instead. Computed so the log can keep
            // showing how often it disagrees with isLastAnchor (i.e. how often
            // virtualization shrinks the count). It decides nothing.
            const postDatesLastSend = anchorCountAtLastSend !== null && anchorPosition >= anchorCountAtLastSend;

            let heldReason = null;
            let dispatchAuthority = null;
            let outcome;
            if (ruleA_alreadyDispatched) {
              outcome = 'ignored_already';
            } else if (!isLastAnchor) {
              // Scrollback. A fresh block would be the last anchor, so this one is
              // not fresh -- regardless of how recent the thread's beacon is.
              outcome = 'ignored_ancient';
            } else if (ruleB_recentBeacon) {
              outcome = 'dispatch';
              dispatchAuthority = 'recent_beacon';
            } else if (autopilotAuthorized) {
              // Newest message, no recent human send -- but an armed autopilot
              // window authorises dispatch in its place. This is the branch that
              // would otherwise hold at 'no_recent_beacon'.
              outcome = 'dispatch';
              dispatchAuthority = 'autopilot';
            } else {
              // Newest message, but no user send in the window authorises it.
              outcome = 'held';
              heldReason = 'no_recent_beacon';
            }

            {
              const dbgName = (parsedOk && typeof parsedBlock.name === 'string' && parsedBlock.name.trim()) || 'Job';
              console.log(`[DISPATCH-V2] anchor #${i}: outcome=${outcome}${heldReason ? ` (${heldReason})` : ''}${dispatchAuthority ? ` [${dispatchAuthority}]` : ''} name=${dbgName} stableKey=${stableKey ? stableKey.slice(0, 12) : null} | ruleA_alreadyDispatched=${ruleA_alreadyDispatched} ruleB_recentBeacon=${ruleB_recentBeacon} autopilotAuthorized=${autopilotAuthorized} beaconAgeMs=${beaconAgeMs} isNewestMessage=${isNewestMessage} (anchor ${anchorPosition}/${newestAnchorPosition}, atLastSend=${anchorCountAtLastSend})`);
              logEvent('dispatch_decision_v2', {
                name: dbgName,
                stableKey,
                thread: blockThread,
                // BUG FIX (#47): tabThread/blockThread logged as separate fields
                // (rather than only the single collapsed `thread` above) so a
                // future write-key/read-key mismatch between the two identities
                // is visible in the log at a glance, instead of requiring a
                // second trace through hydratedThread/parsed.thread by hand.
                tabThread,
                blockThread,
                dedupBucket,
                ruleA_alreadyDispatched,
                ruleB_recentBeacon,
                autopilotAuthorized,
                dispatchAuthority,
                beaconSentAt: beaconSentAt || null,
                beaconAgeMs,
                isNewestMessage,
                anchorPosition,
                newestAnchorPosition,
                // isLastAnchor is the live signal (isNewestMessage === it).
                // postDatesLastSend and anchorCountAtLastSend are the retired
                // anchor-count proof, logged but not consulted: an event with
                // isLastAnchor:true, ruleB_recentBeacon:true, postDatesLastSend:
                // false and outcome:'dispatch' is exactly the case that used to
                // hang, and is now the fix working. If those never appear,
                // virtualization is not shrinking the count on this machine.
                isLastAnchor,
                postDatesLastSend,
                anchorCountAtLastSend,
                heldReason,
                outcome,
              });
            }

            // (a) -- this block already ran. Mark it handled on this anchor-state
            // so it isn't reprocessed, and say nothing: a spent block is not news.
            if (outcome === 'ignored_already') {
              state.dispatchedBlocks.add(trimmed);
              unclaimedReason = 'ignored_already';
              return;
            }

            // (b) -- ancient scrollback, possibly riding someone else's beacon.
            // Silent, and deliberately NOT held: a held pill is an invitation to
            // dispatch, and nothing about an old block scrolling into view is an
            // invitation to anything.
            if (outcome === 'ignored_ancient') {
              state.dispatchedBlocks.add(trimmed);

              // FRESH-NONLAST-SUPPRESSED probe (observe-only). Counts how often a
              // block this rule silently drops for not being the last anchor
              // still LOOKS genuinely fresh -- first seen after the initial-scan
              // window, with a real recent user send authorising it -- rather
              // than like virtualized-in scrollback. Answers nothing about
              // whether the block SHOULD have dispatched; only how often that
              // shape occurs. Never throws, never alters outcome/unclaimedReason.
              try {
                if (arrivalClassification === 'new_arrival' && !isInitialScan && ruleB_recentBeacon) {
                  const freshKey = stableKey || `raw:${hashRawBlockText(trimmed)}`;
                  if (!freshNonlastSuppressedLogged.has(freshKey)) {
                    freshNonlastSuppressedLogged.add(freshKey);
                    logEvent('fresh_nonlast_suppressed', {
                      name: (parsedOk && typeof parsedBlock.name === 'string' && parsedBlock.name.trim()) || 'Job',
                      stableKey,
                      anchorPosition,
                      newestAnchorPosition,
                      beaconAgeMs,
                      msSincePageLoad: Date.now() - pageLoadTime,
                    });
                  }
                }
              } catch (err) {
                // Instrumentation must never take a real code path down with it.
              }

              // The !isLastAnchor branch: 'not_last_anchor' is the same event.
              unclaimedReason = 'ignored_ancient';
              return;
            }

            // (d) -- newest message, but no recent user send authorises it. Hold
            // it, and let Jody dispatch it by hand if that's what he meant. This
            // is the only branch that can produce a pill.
            if (outcome === 'held') {
              // BUG FIX (held-pill pileup): claude.ai's virtualized DOM recreates
              // anchors, handing scan() a fresh (empty) state.dispatchedBlocks
              // for the same logical block -- which used to spawn a second held
              // pill, and a third. heldBlockKeys is module-level and survives
              // that, so one held block yields exactly one pill per page load.
              const heldKey = stableKey || trimmed;
              if (heldBlockKeys.has(heldKey)) {
                state.dispatchedBlocks.add(trimmed);
                unclaimedReason = 'held_duplicate';
                return;
              }
              heldBlockKeys.add(heldKey);

              if (!state.loggedSendGuardSkip) {
                const why = `no user send in this thread within ${CCSW_SEND_WINDOW_MS / 1000}s (beacon age ${beaconAgeMs === null ? 'never' : Math.round(beaconAgeMs / 1000) + 's'})`;
                console.log(`[CCswitchboard] anchor #${i}: ${why}, holding dispatch for manual override (stale-replay guard).`);
                state.loggedSendGuardSkip = true;
              }
              {
                const dbgName = (parsedBlock && typeof parsedBlock.name === 'string' && parsedBlock.name.trim()) || 'Job';
                const dbgKey = stableKey ? stableKey.slice(0, 12) : null;
                // DISCRIMINATOR fields (held-pill resurrection investigation):
                // promptLen/commandLen come from the parsed payload; rawLen/
                // rawHash are over the RAW pre-parse block text (`trimmed`),
                // independent of fingerprintBlockStable's field selection.
                // Compare across held_decision events: same rawHash + different
                // stableKey => fingerprint bug; different rawHash => genuinely
                // different block text, not a resurrection of the same block.
                // Retained this stage to cross-check dispatch_decision_v2 above.
                const dbgPromptLen = (parsedBlock && typeof parsedBlock.prompt === 'string') ? parsedBlock.prompt.length : 0;
                const dbgCommandLen = (parsedBlock && typeof parsedBlock.command === 'string') ? parsedBlock.command.length : 0;
                const dbgRawLen = trimmed.length;
                const dbgRawHash = hashRawBlockText(trimmed);
                logEvent('held_decision', {
                  name: dbgName,
                  stableKey: dbgKey,
                  thread: blockThread,
                  // BUG FIX (#47): see the matching comment on dispatch_decision_v2
                  // above -- same two identities, logged separately here too.
                  tabThread,
                  blockThread,
                  heldReason,
                  identityHas: ruleA_alreadyDispatched,
                  identitySize: durableDispatchedKeys.get(blockThread)?.size ?? 0,
                  heldBlockKeysHas: heldBlockKeys.has(heldKey),
                  beaconSentAt: beaconSentAt || null,
                  beaconAgeMs,
                  isNewestMessage,
                  promptLen: dbgPromptLen,
                  commandLen: dbgCommandLen,
                  rawLen: dbgRawLen,
                  rawHash: dbgRawHash,
                });
              }
              state.dispatchedBlocks.add(trimmed);
              showHeldForSendBar(i, trimmed, ghostToConsume);
              ghostToConsume = null;
              return;
            }

            // outcome === 'dispatch' from here down.

            // The one gate the durable rule cannot cover: a re-render landing
            // BETWEEN this dispatch's start and job.php's answer, when no record
            // of it exists anywhere yet. See inFlightDispatch's declaration.
            if (stableKey && inFlightDispatch.has(stableKey)) {
              console.log(`[CCswitchboard] anchor #${i}: identity dispatch already in flight -- suppressing re-dispatch (anchor re-render mid-dispatch).`);
              state.dispatchedBlocks.add(trimmed);
              unclaimedReason = 'in_flight';
              return;
            }

            if (parsedOk) {
              // Deliberately NOT a dispatch gate -- see the "NOT A DISPATCH
              // GATE ANYMORE" comment above dispatchedFingerprints. Rule (a)
              // above is now the only already-ran check, and it is keyed by
              // stableKey, so this message-text-scoped fingerprint is recorded
              // for history only and gates nothing.
              if (dispatchedFingerprints.has(fingerprint)) {
                console.log(`[CCswitchboard] anchor #${i}: ccsw block fingerprint matches a prior dispatch, but the durable rule authorized this dispatch -- allowing (the old fingerprint gate would have silently blocked this).`);
              }
              recordDispatchedFingerprint(fingerprint);
            }

            // The durable dispatched-key record is written in dispatchCcswBlock's
            // response.ok branch, NOT here -- a block that never actually
            // dispatches (409/dropped, or a message-send failure) must stay free
            // to re-fire, so recording ahead of the response would wrongly
            // suppress a job that never ran.
            //
            // inFlightDispatch, by contrast, IS recorded synchronously here --
            // BEFORE the await inside dispatchCcswBlock -- because its whole job
            // is to close the during-dispatch re-render window that the
            // response-time record above cannot. dispatchCcswBlock clears it on
            // every exit path (try/finally), so a dropped/failed dispatch still
            // re-fires freely; only a re-render that races the in-flight
            // dispatch is suppressed (caught by the inFlightDispatch gate above).
            state.dispatchedBlocks.add(trimmed);
            if (stableKey) inFlightDispatch.add(stableKey);
            dispatchCcswBlock(i, trimmed, ghostToConsume, stableKey);
            ghostToConsume = null;
          });
        } finally {
          // Nothing this pass claimed the ghost -- no usable block was found,
          // or every block found took one of the decision's non-dispatch
          // branches (ignored_already, ignored_ancient/not-last-anchor, held,
          // deferred, in-flight) -- so there is nothing left for it to morph
          // into. Drop it rather than leaving a "detecting..." pill stuck on
          // screen forever. In a finally, so a throw anywhere in the decision
          // cannot strand it either.
          if (ghostToConsume) removeGhostBar(ghostToConsume, unclaimedReason);

          // BUG #17 (a) -- reopen this message's one-shot stability gate. The
          // stability branch commits state.loggedText = text at its top, and
          // `loggedText === text` keeps it from ever re-running for the same
          // text. A block that deferred purely because its bucket's durable
          // dispatched-key state had not arrived was left undecided on the
          // promise of a re-scan -- but with the gate shut that re-scan re-enters
          // and does nothing, so the block strands until a re-render (fresh
          // state) or re-emission (new text). Clearing loggedText lets the next
          // scan re-run this whole decision.
          //
          // NO DOUBLE-DISPATCH: state.dispatchedBlocks is NOT cleared, so every
          // block that actually dispatched, held, or was ignored this pass is
          // still in it and short-circuits at the top of the forEach
          // (`state.dispatchedBlocks.has(trimmed)`). Only the deferred block --
          // which was never added there -- is reconsidered, and the durable
          // ledger (rule a / isStableKeyDispatched) plus inFlightDispatch guard
          // still let it dispatch at most once. Re-running also cannot re-mint a
          // ghost: the ghost gate additionally requires findCcswBlocks length 0,
          // and this branch only runs with blocks present.
          if (anyBlockDeferred) state.loggedText = null;
        }
      }
    }

    seen.set(anchor, state);
  });
}

let debounceTimer = null;
// Quieted per feedback: this used to log every raw mutation batch (dozens of
// times per second while a message streams in). scan()'s own "found N
// feedback button(s)" log below already reports each debounced run, so the
// raw per-mutation count added no signal beyond noise.
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => scan('mutation-observer'), CONFIG.DEBOUNCE_MS);
});

// Observing document.body (not a specific "chat container" div) is
// deliberate: claude.ai is a React SPA and any container element we could
// name might get unmounted/replaced on navigation, but document.body itself
// never does.
observer.observe(document.body, { childList: true, subtree: true, characterData: true });

setInterval(() => scan('fallback-interval'), CONFIG.FALLBACK_SCAN_MS);
scan('startup');

// --- E3: wake loop ---------------------------------------------------------
// When background.js sees a dispatched job reach status "done", it sends
// this tab a wake-prompt to type into Claude's input and send, so the
// conversation continues once the job finishes.
//
// The actual typing/click/verify/retry no longer happens here. It used to --
// paced first by this tab's own setTimeout chains, then (see git history) by
// a 'ccsw-tick' message background.js pushed on its own interval -- but a
// backgrounded/hidden tab's whole task queue (not just its timers) can be
// deprioritized, so a wake/result prompt's text would land in the input
// (execCommand runs synchronously, off the message-listener call stack) and
// then sit there unsent until Jody refocused the tab, because everything
// after that ran through code living inside this same throttled tab.
//
// background.js now drives the whole send state machine itself via
// chrome.scripting.executeScript, which runs on demand in the target tab
// regardless of its focus/visibility state. This file only reacts to the
// UI-facing messages that come back from it (below): update the toolbar
// pill's status/waiting indicator, nothing more.

// jobs.php only ever reports pending/running/done -- the error/cancelled
// distinction for the SW menu LED and toolbar pill comes from the result
// text itself (see below).
const ERROR_RESULT_PREFIXES = ['ERROR:', 'TIMEOUT:', 'LAUNCH-ERROR:'];

function isErrorResultText(resultText) {
  return typeof resultText === 'string' && ERROR_RESULT_PREFIXES.some((prefix) => resultText.startsWith(prefix));
}

// CcswAgent posts the plain string "CANCELLED" (no trailing detail) when a
// job is killed via cancel.php -- distinct from the ERROR:/TIMEOUT:/
// LAUNCH-ERROR: prefixes above, since a cancelled job isn't a failure.
function isCancelledResultText(resultText) {
  return typeof resultText === 'string' && resultText.startsWith('CANCELLED');
}

// Strips the ERROR:/TIMEOUT:/LAUNCH-ERROR: prefix (see ERROR_RESULT_PREFIXES
// above) for the hovercard's errored-detail line (see
// renderJobHovercardContent) -- the "Errored" label above it already carries
// the classification, so the raw prefix would just be noise there.
function formatErrorDetail(resultText) {
  if (typeof resultText !== 'string') return '';
  const prefix = ERROR_RESULT_PREFIXES.find((p) => resultText.startsWith(p));
  return (prefix ? resultText.slice(prefix.length) : resultText).trim();
}

// Cascade of candidates for Claude's message input, most-specific first --
// only used here to scope the keydown listener below (so background.js's
// hold-check knows a keystroke landed in Claude's own input, not elsewhere
// on the page). background.js's ccswInjCheckHold has its own copy of this
// list for the actual send-path DOM queries; keep the two in sync if
// claude.ai's selectors ever change.
const INPUT_SELECTORS = [
  'div[contenteditable="true"][data-testid="chat-input"]',
  'div[role="textbox"][contenteditable="true"]',
  'div[contenteditable="true"][data-testid]',
  'div[contenteditable="true"].ProseMirror',
  'div[contenteditable="true"][class*="composer"]',
  'div[contenteditable="true"][placeholder]',
  'div[contenteditable="true"]',
];

function isClaudeInputTarget(target) {
  const el = target instanceof Element ? target : target?.parentElement;
  return !!el?.closest(INPUT_SELECTORS.join(','));
}

// Recorded on window (not a module-scoped variable) so a chrome.scripting.
// executeScript call from background.js -- which runs as a fresh top-level
// script in this same per-tab isolated world -- can read it directly rather
// than depending on a message round-trip into this file's own closures.
document.addEventListener(
  'keydown',
  (evt) => {
    // #72B FIX B: background.js's own synthetic Enter (ccswInjTryEnterSend,
    // dispatched via a real KeyboardEvent so ProseMirror's keydown-submit
    // handler fires) is not a user keystroke -- without this filter it sets
    // this same timestamp and self-trips the #68 typed_since_insert guard on
    // the very next tick. evt.isTrusted is false for any dispatchEvent-created
    // event, synthetic or not, so this is a clean discriminator. Deliberately
    // does NOT touch the markUserSend beacon listeners below -- see their own
    // comment for why those must stay unfiltered.
    if (!evt.isTrusted) return;
    if (!isClaudeInputTarget(evt.target)) return;
    window.__ccswLastKeystrokeAt = Date.now();
  },
  true
);

// User-send provenance guard: the only signals proven (via prior probing,
// plus the click path added below) to reliably distinguish a real user SEND
// from ordinary typing or a virtualized/re-mounted old block coming back
// into view -- an Enter keydown (no modifier/IME composition) or a click on
// claude.ai's own send button, in both cases while the input actually has
// text. Consumed by the dispatch guard in scan() below (see
// CCSW_SEND_WINDOW_MS, and beacon.php). Deliberately separate listeners from
// the __ccswLastKeystrokeAt one above -- that one exists for background.js's
// own hold-check and isn't send-specific.
//
// DO NOT filter these listeners on event.isTrusted. background.js's wake
// delivery submits by clicking the real send button / dispatching a real Enter
// KeyboardEvent, and those SYNTHETIC events reaching markUserSend is the only
// thing that beacons an autopilot chain's follow-up send. Filter them out and
// every chained job ends in a held pill. See background.js's ccsw-beacon handler.
function markUserSend(source) {
  // Freeze the message count as of this send. Claude's reply mounts the next
  // anchor after these, and only from that anchor onward may a block dispatch
  // -- see anchorCountAtLastSend. Read BEFORE the beacon is posted, since the
  // reply cannot have rendered yet at the instant Enter is pressed.
  anchorCountAtLastSend = document.querySelectorAll(SELECTORS.feedbackButton).length;

  // ARRIVAL-NOVELTY (observe-only): a real send proves the tab is live, so the
  // initial-scan window closes here even if the 3s timer hasn't fired yet --
  // anything appearing from now on is a genuine arrival, not scrollback.
  isInitialScan = false;
  console.log(`[CCswitchboard] user send detected (${source}) in this thread -- dispatch window open ${CCSW_SEND_WINDOW_MS / 1000}s`);
  // [HOLD-DBG] user send detected.
  logEvent('user_send', { source, windowMs: CCSW_SEND_WINDOW_MS });
  // Post the durable beacon. This IS the send signal now: rule (b) of scan()'s
  // eligibility rule reads it back (via the background worker's cache) to
  // decide whether anything on screen is authorised to dispatch. The per-tab
  // timestamp this function used to set is gone -- it died with every reload,
  // tab close and service-worker restart, which is how a spent block came to
  // re-fire.
  sendUserSendBeacon();

  // D4: flush this tab's queued deliveries right after the user's OWN message
  // lands, instead of leaving them to wait out the next 200ms send tick.
  // Skip when THIS call was itself triggered by our own wake-delivery click/
  // Enter dispatch (background.js's ccswInjTryClickSend/ccswInjTryEnterSend
  // flag __ccswDeliverySending on window for the duration of that synchronous
  // dispatch) -- unlike the beacon above, which autopilot chaining genuinely
  // needs to see, flushing off our own delivery landing would be a no-op at
  // best and a feedback loop at worst (delivery lands -> flush -> next
  // delivery lands -> flush -> ...).
  //
  // PIGGYBACK BUNDLING: while the piggyback flag is on, this tab's ready wake
  // outputs ride along INSIDE the one piggyback resend (background's
  // ccsw-piggyback-probe-resend handler) on a confirmed-suppressed send, so
  // this separate flush must NOT also send them or they'd be delivered twice.
  // runPiggybackProbe's leaked branch re-fires this message as the sole
  // fallback when suppression was not confirmed. sendUserSendBeacon above still
  // runs regardless -- only the ccsw-user-send-landed flush is suppressed here.
  if (!window.__ccswDeliverySending && !piggybackProbeEnabled) {
    chrome.runtime.sendMessage({ type: 'ccsw-user-send-landed' }).catch((err) => {
      handlePossibleContextInvalidation(err);
    });
  }
}

// Fire-and-forget sibling of logEvent: same content -> background -> relay hop
// (background.js's ccsw-beacon handler POSTs beacon.php), same hard rules --
// never throw, never await, never block the send path it rides on.
//
// It also records the beacon LOCALLY (recordLocalBeacon) on the way out. The
// relay is the durable record, but a POST plus a poll-interval round-trip is
// far slower than Claude is at starting to emit a block, and rule (b) would
// hold that block for want of a beacon this tab knows perfectly well about.
// A beacon that fails to land upstream therefore still authorises this tab's
// next block; it just won't authorise a different tab's until the POST retries
// on the next send.
//
// Thread resolution mirrors logEvent's, then falls back to the SW menu's
// remembered-URL thread the way page_load does -- a send can easily happen
// before scan() has hydrated a thread from the DOM, and beacon.php rejects an
// empty thread, so the async fallback is worth the extra tick. A brand-new
// conversation with no thread yet simply posts nothing.
function sendUserSendBeacon() {
  try {
    // Captured NOW, not inside the async fallback below: the beacon must carry
    // the instant of the send, not the instant storage happened to resolve.
    const sentAt = Date.now();

    const post = (thread) => {
      if (!thread) return;
      recordLocalBeacon(thread, sentAt);
      chrome.runtime.sendMessage({ type: 'ccsw-beacon', thread, sentAt }).catch((err) => {
        handlePossibleContextInvalidation(err);
      });
    };

    // hydratedThread is declared further down with `let`; read it defensively
    // rather than reordering a load-bearing declaration (same as logEvent).
    let thread = null;
    try {
      thread = hydratedThread || null;
    } catch (tdz) {
      thread = null;
    }

    if (thread) post(thread);
    else loadUrlThread().then(post).catch(() => {});
  } catch (err) {
    // Swallow: a dead extension context must not take the send path down with
    // it just because we were recording a beacon.
  }
}

// The single funnel for adding Action List item(s) to the relay, from either
// the ccsw-block `actions` array or the dialog's undo. Each add is tagged with
// the CCSW thread it was authored from, resolved exactly as sendUserSendBeacon
// above resolves it -- hydratedThread first, loadUrlThread() when this tab
// hasn't hydrated yet -- so an action, a beacon and a dispatch from the same
// conversation all agree on the thread's identity.
//
// Unlike the beacon, an unresolvable thread does NOT drop the add: the item
// still goes up untagged and lands in the Global bucket. An action Claude
// asked for must never be silently lost, and Global is a strictly better
// failure than a wrong thread. Pass threadOverride to tag with a thread other
// than this tab's current one (undo re-adds under the item's original thread).
function sendActionsAdd(items, threadOverride) {
  const post = (thread) => {
    const message = { type: 'ccsw-actions-add', actions: items };
    if (thread) message.thread = thread;
    chrome.runtime.sendMessage(message).catch((err) => {
      handlePossibleContextInvalidation(err);
    });
  };

  if (threadOverride !== undefined) {
    post(threadOverride || null);
    return;
  }

  // hydratedThread is declared further down with `let`; read it defensively
  // rather than reordering a load-bearing declaration (same as logEvent).
  let thread = null;
  try {
    thread = hydratedThread || null;
  } catch (tdz) {
    thread = null;
  }

  if (thread) post(thread);
  else loadUrlThread().then((t) => post(t || null)).catch(() => post(null));
}

// --- Fix 5a: PIGGYBACK SUPPRESSION PROBE (flag-gated, see
// piggybackProbeEnabled above) ------------------------------------------
//
// Recon (job 1984) confirmed every read/set/submit primitive this needs
// already exists (ccswInjInsertText/ccswInjTryClickSend/ccswInjTryEnterSend
// in background.js) -- the one thing never proven live is whether
// preventDefault()+stopImmediatePropagation() on the capture-phase Enter/
// click listeners below actually stops claude.ai's own ProseMirror/React
// send from firing. This probe answers that, without ever risking a double
// send: see the SAFETY INVARIANT on runPiggybackProbe below.
//
// Three checks (150/400/800ms out) rather than one, so a slightly slow
// render can't be mistaken for a suppressed send -- ANY of the three seeing
// a leak signal classifies LEAKED immediately; SUPPRESSED is only declared
// once every check has come back clean.
const PIGGYBACK_PROBE_CONFIRM_MS = [150, 400, 800];
const PIGGYBACK_PROBE_TOAST_MS = 4000;

// Boundary-count signal for "did a new message turn land": same fallback
// findMessageTurnContainer uses (messageActionsGroup exists once per turn
// regardless of sender, so a fresh HUMAN turn moves this count immediately,
// unlike feedbackButton which only appears on assistant turns). If
// messageActionsGroup doesn't match this DOM at all, this falls back to
// feedbackButton -- meaning a leaked human send won't show up here until
// Claude's reply grows its own feedback button, same known limitation as
// findMessageTurnContainer's fallback.
function countMessageTurns() {
  const hasGroups = document.querySelectorAll(SELECTORS.messageActionsGroup).length > 0;
  return document.querySelectorAll(hasGroups ? SELECTORS.messageActionsGroup : SELECTORS.feedbackButton).length;
}

// User-facing confirmation that this tab's ready wake outputs were bundled into
// the resend (fired from resendPiggybackProbeText only when outputCount > 0).
// The per-send suppressed/leaked debug toast was removed -- end users only ever
// see this bundled-count confirmation now.
//
// z-index forced inline (content.css's own #ccsw-piggyback-probe-toast rule
// only sets 2147483645) -- this toast was found sitting BEHIND claude.ai's
// own composer chrome on some layouts. An inline style wins over the
// stylesheet rule without needing a content.css edit, matching the max
// int32 value #ccsw-toolbar/#ccsw-sw-menu already use.
function showPiggybackBundleToast(outputCount) {
  const existing = document.getElementById('ccsw-piggyback-probe-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'ccsw-piggyback-probe-toast';
  toast.style.zIndex = '2147483647';
  toast.classList.add('ccsw-piggyback-probe-toast--ok');
  toast.textContent = `piggyback bundled ${outputCount} outputs`;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), PIGGYBACK_PROBE_TOAST_MS);
}

// Asks background.js to resend `text` using the exact same primitives
// production wake-delivery uses (ccswInjInsertText then
// ccswInjTryClickSend/ccswInjTryEnterSend, see its 'ccsw-piggyback-probe-resend'
// handler) -- this exercises the real resend path rather than a probe-only
// stand-in. Those primitives already carry their own hash/marker +
// typed-since-insert guard (see #68 USER TEXT IS SACRED in background.js),
// so re-typing during the resend can't corrupt anything.
function resendPiggybackProbeText(text, method) {
  chrome.runtime.sendMessage({ type: 'ccsw-piggyback-probe-resend', text, method }).then((result) => {
    console.log(`[CCswitchboard] piggyback probe (${method}): resend ${result?.ok ? 'sent' : 'FAILED'}`, result);
    // Background bundled this tab's ready wake outputs into the one resend and
    // reports back how many (and which) it delivered -- record it and, when it
    // actually carried outputs, show the bundled-count confirmation toast.
    const outputCount = result?.outputCount || 0;
    const jobIds = Array.isArray(result?.jobIds) ? result.jobIds : [];
    logEvent('piggyback_bundle', { outputCount, jobIds, method });
    if (outputCount > 0) {
      showPiggybackBundleToast(outputCount);
    }
  }).catch((err) => {
    handlePossibleContextInvalidation(err);
  });
}

// SAFETY INVARIANT (non-negotiable): the user's text is only ever resent
// once the native send has been positively CONFIRMED suppressed. Every path
// through the checks below that isn't a clean "still there, no new turn,
// every single check" ends in 'leaked' and returns WITHOUT resending -- an
// ambiguous result is treated exactly like a leak. That means the worst
// outcome this probe can ever produce is identical to today's (pre-probe)
// behaviour: exactly one message sent, never two.
//
// piggybackProbeInFlight closes a second-send race: if the user hits Enter
// (or clicks send) again while a probe from their FIRST keystroke is still
// pending, that second event is deliberately NOT intercepted (see the
// listeners below) -- it's allowed straight through as an ordinary send.
// This probe then sees its own composer/turn-count checks flip (the second
// keystroke's real send cleared the composer or added a turn) and correctly
// classifies 'leaked', which never resends. Without this guard, two
// independent probe instances could each separately confirm 'suppressed'
// against the same still-unsent text and each fire its own resend -- a real
// double send. One in-flight probe at a time closes that hole.
let piggybackProbeInFlight = false;

function runPiggybackProbe(method, inputEl) {
  const expectedText = (inputEl.innerText || inputEl.textContent || '').trim();
  const textLen = expectedText.length;
  const turnCountAtIntercept = countMessageTurns();
  let decided = false;
  piggybackProbeInFlight = true;

  function finish(outcome) {
    if (decided) return;
    decided = true;
    piggybackProbeInFlight = false;
    console.log(`[CCswitchboard] piggyback probe (${method}): ${outcome}${outcome === 'leaked' ? ' -- NOT resending' : ''}`);
    logEvent('piggyback_probe', { method, outcome, textLen });
    if (outcome === 'suppressed') {
      // Suppressed: background re-sends the user's text AND bundles this tab's
      // ready wake outputs into it (see resendPiggybackProbeText). markUserSend
      // skipped its ccsw-user-send-landed flush because the flag is on, so this
      // bundle is the single delivery path for those outputs.
      resendPiggybackProbeText(expectedText, method);
    } else {
      // Leaked (or ambiguous, treated as leaked): the native send went through,
      // so nothing was bundled. markUserSend suppressed its D4 flush while the
      // flag is on, so fire it here as the fallback -- this is the ONLY path
      // that still delivers this tab's ready outputs the old way when
      // suppression was not confirmed.
      chrome.runtime.sendMessage({ type: 'ccsw-user-send-landed' }).catch((err) => {
        handlePossibleContextInvalidation(err);
      });
    }
  }

  PIGGYBACK_PROBE_CONFIRM_MS.forEach((delay, idx) => {
    setTimeout(() => {
      if (decided) return;
      // isConnected guards against React replacing the composer node itself
      // (rather than just its content) on send -- a stale reference to a
      // detached node would otherwise still read back its old (still
      // matching) text and misreport suppression.
      const stillThere = inputEl.isConnected && (inputEl.innerText || inputEl.textContent || '').trim() === expectedText;
      const turnsNow = countMessageTurns();
      if (!stillThere || turnsNow > turnCountAtIntercept) {
        finish('leaked');
        return;
      }
      if (idx === PIGGYBACK_PROBE_CONFIRM_MS.length - 1) finish('suppressed');
    }, delay);
  });
}

// --- CONCURRENT-SEND PROBE: OBSERVE MODE (flag-gated, see
// concurrentSendProbeEnabled above) --------------------------------------
//
// Jody reports newer claude.ai tabs accept a send while Claude is still
// replying (THINKING: tacks onto the current turn; OUTPUTTING: queues it)
// instead of rejecting it. Before trusting that anywhere near a real
// delivery (see ATTEMPT MODE in background.js's advanceHoldPhase), this
// maps which DOM signals actually distinguish THINKING / OUTPUTTING / IDLE,
// and whether THIS tab shows any queue affordance at all (a proxy for "new
// enough to support it"). Observe-only: never sends anything, never
// suppresses anything, purely reads the DOM every
// CONCURRENT_SEND_OBSERVE_TICK_MS while Claude looks like it's generating.
const CONCURRENT_SEND_OBSERVE_TICK_MS = 500;

// Stop-button selector is the one CONFIRMED signal here (mirrors
// background.js's ccswInjProbeDelivery stopSelectors -- keep the two in
// sync if claude.ai's DOM ever changes). The rest are best-effort
// candidates, never audited the way the send path's own selectors have --
// logged individually below (which one matched, if any) rather than
// collapsed into one boolean, so a live run tells us which candidates are
// real signals and which are noise.
const CONCURRENT_SEND_STOP_BUTTON_SELECTORS = ['button[aria-label="Stop response"]', 'button[aria-label*="Stop"]'];
const CONCURRENT_SEND_STREAMING_CURSOR_SELECTORS = [
  '[data-is-streaming="true"]',
  '.result-streaming',
  '[class*="cursor" i]',
  '[class*="blink" i]',
];
const CONCURRENT_SEND_QUEUED_INDICATOR_SELECTORS = [
  '[class*="queue" i]',
  '[aria-label*="queue" i]',
  '[data-testid*="queue" i]',
];

function ccswConcurrentSendGenerating() {
  return CONCURRENT_SEND_STOP_BUTTON_SELECTORS.some((sel) => !!document.querySelector(sel));
}

// Walks up from the composer input a few ancestor levels (mirrors
// findComposerInputNear's downward walk from a button, above) looking for
// any element matching CONCURRENT_SEND_QUEUED_INDICATOR_SELECTORS --
// scoped near the composer rather than the whole page so an unrelated
// "queue" mention elsewhere on claude.ai can't false-positive this.
function findQueuedIndicatorNearComposer(inputEl) {
  let el = inputEl;
  for (let i = 0; i < 6 && el; i++) {
    for (const sel of CONCURRENT_SEND_QUEUED_INDICATOR_SELECTORS) {
      const match = el.querySelector?.(sel);
      if (match) return { selector: sel, text: (match.textContent || '').trim().slice(0, 60) };
    }
    el = el.parentElement;
  }
  return null;
}

// Reuses findMessageTurnContainer (same widen-from-anchor logic
// ccswInjProbeDelivery duplicates in background.js, since that one runs via
// executeScript and can't call back into this file) for lastAssistantTextLen
// -- a growing length is the corroborating "still actually streaming" signal
// noted on ccswInjProbeDelivery, distinct from a lingering-but-stale Stop
// button.
function collectConcurrentSendSignals() {
  const stopButtonSelector = CONCURRENT_SEND_STOP_BUTTON_SELECTORS.find((sel) => !!document.querySelector(sel)) ?? null;
  const streamingCursorSelector = CONCURRENT_SEND_STREAMING_CURSOR_SELECTORS.find((sel) => !!document.querySelector(sel)) ?? null;
  const ariaBusyPresent = !!document.querySelector('[aria-busy="true"]');

  const feedbackButtons = document.querySelectorAll(SELECTORS.feedbackButton);
  let lastAssistantTextLen = null;
  if (feedbackButtons.length > 0) {
    const container = findMessageTurnContainer(feedbackButtons[feedbackButtons.length - 1]);
    lastAssistantTextLen = (container.textContent || '').length;
  }

  const inputEl = INPUT_SELECTORS.map((sel) => document.querySelector(sel)).find(Boolean) ?? null;
  const queuedIndicator = inputEl ? findQueuedIndicatorNearComposer(inputEl) : null;

  return {
    stopButtonPresent: !!stopButtonSelector,
    stopButtonSelector,
    streamingCursorPresent: !!streamingCursorSelector,
    streamingCursorSelector,
    ariaBusyPresent,
    lastAssistantTextLen,
    queuedIndicatorPresent: !!queuedIndicator,
    queuedIndicator,
  };
}

let concurrentSendObserveTimer = null;
let concurrentSendObserveSeq = 0;
// Last tick's lastAssistantTextLen, so each event can carry textGrew (this
// tick's length > last tick's) -- the corroborating "genuinely still
// streaming" signal. Reset to null whenever generation isn't detected, so
// the first tick of a FRESH generation never reports a stale delta from the
// previous reply.
let concurrentSendLastTextLen = null;

function concurrentSendObserveTick() {
  if (!ccswConcurrentSendGenerating()) {
    concurrentSendLastTextLen = null;
    return;
  }
  const signals = collectConcurrentSendSignals();
  const textGrew = concurrentSendLastTextLen !== null && signals.lastAssistantTextLen !== null
    ? signals.lastAssistantTextLen > concurrentSendLastTextLen
    : null;
  concurrentSendLastTextLen = signals.lastAssistantTextLen;
  concurrentSendObserveSeq += 1;
  logEvent('concurrent_send_observe', { seq: concurrentSendObserveSeq, textGrew, ...signals });
}

// Started/stopped exactly like syncFaviconHeartbeat's interval below --
// called from loadConcurrentSendProbeEnabled/setConcurrentSendProbeEnabled
// and the storage.onChanged branch above, so a toggle from another tab (or
// the Settings dialog) starts/stops this tab's heartbeat immediately rather
// than waiting for a reload.
function syncConcurrentSendObserve() {
  const shouldRun = concurrentSendProbeEnabled === true;
  if (!shouldRun) {
    if (concurrentSendObserveTimer !== null) {
      clearInterval(concurrentSendObserveTimer);
      concurrentSendObserveTimer = null;
    }
    return;
  }
  if (concurrentSendObserveTimer !== null) return;
  concurrentSendObserveTimer = setInterval(concurrentSendObserveTick, CONCURRENT_SEND_OBSERVE_TICK_MS);
}

// --- GENERATION WATCHER (always on) --------------------------------------
// One durable record per claude.ai generation -- when it started/finished,
// how long it took, and which model/effort were selected -- POSTed to the
// relay's output_log.php (via background.js, same CORS wall as every other
// RELAY_* call). This is the answer to "what is claude.ai actually spending
// its time on", which nothing else in this extension records: sessionJobs
// only ever sees OUR jobs, never claude.ai's own output.
//
// Deliberately NOT gated by concurrentSendProbeEnabled: that flag scopes an
// experiment whose observe-tick logs per-tick DOM signals, and which is off
// for normal use. This runs everywhere, all the time, and (unlike the probe)
// only ever logs/POSTs on a TRANSITION -- never per tick. That distinction is
// load-bearing: e2e675b's favicon_op/favicon_heartbeat lesson is that a
// per-tick urgent write rolls the shared 2000-row debug_log ring in minutes
// and destroys real forensic events. One event per generation is affordable;
// one per second is not.
//
// Generation detection REUSES ccswConcurrentSendGenerating() (and thus
// CONCURRENT_SEND_STOP_BUTTON_SELECTORS) rather than duplicating the selector
// list -- the Stop button is the one CONFIRMED signal, and keeping a single
// definition means a claude.ai DOM change is one edit, not two.
const OUTPUT_WATCH_TICK_MS = 1000;
// Ticks of "not generating" required to END a record. The Stop button can
// blink out for a tick mid-generation (re-render, virtualization), and a
// naive 1-tick end would split one generation into two bogus records with a
// ~1s gap. Two consecutive idle ticks costs at most ~1s of extra latency on
// the record landing, and ts_end is taken from the FIRST idle tick (see
// outputPendingEndTs) so the debounce never inflates duration_ms.
const OUTPUT_WATCH_IDLE_TICKS_TO_END = 2;

// FIRST-GUESS selectors, in preference order -- claude.ai's composer controls
// have never been audited the way the send path's have, so treat every one of
// these as unproven. When nothing matches we record null and a scrape_note
// rather than guessing a default: a wrong model on a durable record is worse
// than a missing one, and the note is what tells us WHICH selector family to
// refine once real data lands.
const OUTPUT_MODEL_SELECTORS = [
  '[data-testid="model-selector-dropdown"]',
  'button[data-testid*="model" i]',
  '[data-testid*="model" i]',
  'button[aria-label*="model" i]',
];
const OUTPUT_EFFORT_SELECTORS = [
  'button[data-testid*="effort" i]',
  '[data-testid*="effort" i]',
  'button[aria-label*="effort" i]',
  'button[aria-label*="thinking" i]',
  '[data-testid*="thinking" i]',
];

// Returns {value, selector} for the first selector that matches an element
// with non-empty text, else null. Text is capped -- a mis-aimed selector that
// happens to match a container would otherwise post a wall of chat text into
// a durable log column.
const OUTPUT_SCRAPE_MAX_LEN = 60;

function scrapeComposerControl(selectors) {
  for (const sel of selectors) {
    let el;
    try {
      el = document.querySelector(sel);
    } catch (err) {
      continue; // malformed selector (e.g. an unsupported `i` flag) -- try the next
    }
    if (!el) continue;
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    return { value: text.slice(0, OUTPUT_SCRAPE_MAX_LEN), selector: sel };
  }
  return null;
}

let outputWatchTimer = null;
// The in-flight record, or null when claude.ai isn't generating. Doubles as
// the idle->generating edge detector: non-null IS "a generation is open".
let outputRecord = null;
let outputIdleTicks = 0;
// ts_end as observed on the FIRST idle tick, held until the debounce
// confirms the generation really ended (see OUTPUT_WATCH_IDLE_TICKS_TO_END).
let outputPendingEndTs = null;
let outputPendingEndMs = 0;
// Read by updateFaviconForJobState for the orange 'outputting' state. Kept
// separate from outputRecord so the favicon question ("is claude.ai talking
// right now?") doesn't reach into the record's shape.
let outputGenerationActive = false;

function startOutputRecord() {
  const model = scrapeComposerControl(OUTPUT_MODEL_SELECTORS);
  const effort = scrapeComposerControl(OUTPUT_EFFORT_SELECTORS);
  const notes = [];
  if (!model) notes.push('model-selector-not-found');
  if (!effort) notes.push('effort-selector-not-found');

  outputRecord = {
    tsStart: new Date().toISOString(),
    startedAtMs: Date.now(),
    model: model ? model.value : null,
    effort: effort ? effort.value : null,
    // Which selector actually matched, so a value that turns out to be junk
    // is traceable to the guess that produced it -- and which family missed,
    // so the misses are refinable from real data rather than re-guessed.
    scrapeNote: notes.length ? notes.join('+') : `model:${model.selector}+effort:${effort.selector}`,
    thread: (typeof hydratedThread === 'string' && hydratedThread) || null,
    url: location.href,
  };
  outputGenerationActive = true;
  updateFaviconForJobState();
}

function finishOutputRecord() {
  const rec = outputRecord;
  outputRecord = null;
  outputIdleTicks = 0;
  outputGenerationActive = false;
  const tsEnd = outputPendingEndTs ?? new Date().toISOString();
  const endedAtMs = outputPendingEndMs || Date.now();
  outputPendingEndTs = null;
  outputPendingEndMs = 0;
  updateFaviconForJobState();
  if (!rec) return;

  const durationMs = Math.max(0, endedAtMs - rec.startedAtMs);
  // ONE event per generation (see this section's header) -- never per tick.
  logEvent('output_record', {
    duration_ms: durationMs,
    model: rec.model,
    effort: rec.effort,
    thread: rec.thread,
    // output_log.php has no scrape_note column, so the debug ring is the only
    // place this survives -- and it's what makes a null model diagnosable.
    scrape_note: rec.scrapeNote,
  });
  chrome.runtime.sendMessage({
    type: 'ccsw-output-record',
    record: {
      ts_start: rec.tsStart,
      ts_end: tsEnd,
      duration_ms: durationMs,
      model: rec.model,
      effort: rec.effort,
      thread: rec.thread,
      url: rec.url,
    },
  }).catch(() => {
    // Fire-and-forget: a dead/reloading extension context must not take the
    // watcher down. background.js warns on a failed POST; nothing retries.
  });
}

// Pure edge detection: the ONLY writes (logEvent/sendMessage/favicon) happen
// on an idle->generating or generating->idle transition. A steady-state tick
// -- generating or idle -- does nothing but bookkeeping.
function outputWatchTick() {
  let generating;
  try {
    generating = ccswConcurrentSendGenerating();
  } catch (err) {
    return; // DOM unavailable this tick -- try again next second
  }

  if (generating) {
    outputIdleTicks = 0;
    outputPendingEndTs = null;
    outputPendingEndMs = 0;
    if (!outputRecord) startOutputRecord();
    return;
  }

  if (!outputRecord) return; // idle, and nothing open -- the common case
  outputIdleTicks += 1;
  if (outputIdleTicks === 1) {
    outputPendingEndTs = new Date().toISOString();
    outputPendingEndMs = Date.now();
  }
  if (outputIdleTicks >= OUTPUT_WATCH_IDLE_TICKS_TO_END) finishOutputRecord();
}

// Always-on, started at load -- no sync* function and no storage gate, unlike
// syncConcurrentSendObserve/syncFaviconHeartbeat above. The favicon TOGGLE is
// honoured downstream (fv2Allowed, in updateFaviconForJobState); recording
// itself is unconditional, so turning the spinner off never costs us the log.
if (outputWatchTimer === null) {
  outputWatchTimer = setInterval(outputWatchTick, OUTPUT_WATCH_TICK_MS);
}

// --- CONCURRENT-SEND PROBE: ATTEMPT MODE toast ---------------------------
// background.js's attemptConcurrentSend runs entirely in the background
// worker (execInTab round trips) -- it messages this tab to show the
// outcome rather than manipulating the DOM directly from an injected
// function, the same way finishSend's 'ccsw-send-outcome' message (below)
// keeps toast/pill rendering in content.js instead of duplicating it into a
// ccswInj* primitive.
//
// Styled entirely inline (not a content.css class like
// #ccsw-piggyback-probe-toast) so this new toast doesn't require a
// content.css edit -- this feature is scoped to content.js/background.js
// only. Same fixed bottom-right shell as the piggyback probe toast, offset
// further up so the two can never overlap, at the max int32 z-index so it
// renders ABOVE claude.ai's own composer chrome (see the inline zIndex fix
// on showPiggybackBundleToast above for why that matters here too).
const CONCURRENT_SEND_ATTEMPT_TOAST_MS = 6000;

function showConcurrentSendToast(outcome) {
  const existing = document.getElementById('ccsw-concurrent-send-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'ccsw-concurrent-send-toast';
  const landed = outcome === 'landed';
  toast.textContent = landed
    ? 'concurrent-send probe: result landed while Claude was generating'
    : 'concurrent-send probe: not confirmed -- fell back to normal hold';
  toast.style.cssText = [
    'position: fixed',
    'bottom: 120px',
    'right: 16px',
    'z-index: 2147483647',
    'max-width: 360px',
    'padding: 10px 14px',
    'border-radius: 6px',
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'font-size: 13px',
    'font-weight: 600',
    'color: #fff',
    'box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35)',
    `background: ${landed ? '#1a7a3c' : '#b00020'}`,
  ].join(';');
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), CONCURRENT_SEND_ATTEMPT_TOAST_MS);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-concurrent-send-toast') return;
  showConcurrentSendToast(message.outcome);
});

document.addEventListener(
  'keydown',
  (evt) => {
    if (!isClaudeInputTarget(evt.target)) return;
    if (evt.key !== 'Enter' || evt.shiftKey || evt.ctrlKey || evt.metaKey || evt.isComposing) return;
    const inputEl = evt.target.closest(INPUT_SELECTORS.join(','));
    const textLen = inputEl?.textContent?.trim()?.length || 0;
    if (textLen === 0) return;
    // Fix 5a: our own resend below re-dispatches a synthetic Enter into this
    // same input (ccswInjTryEnterSend), flagged via __ccswDeliverySending for
    // the duration of that dispatch -- skip the probe for that event so it
    // falls through to markUserSend as an ordinary send, instead of
    // suppressing our own resend forever. Also skip (let it through as an
    // ordinary send) while piggybackProbeInFlight -- see its own comment on
    // why a second Enter must never start a second overlapping probe.
    if (piggybackProbeEnabled && !window.__ccswDeliverySending && !piggybackProbeInFlight) {
      evt.preventDefault();
      evt.stopImmediatePropagation();
      runPiggybackProbe('enter', inputEl);
      return;
    }
    markUserSend('Enter keydown');
  },
  true
);

// Fixes the spurious-hold root cause: sending by clicking claude.ai's send
// button (instead of pressing Enter) never used to mark a user send at all,
// so no beacon was posted and a legit just-sent block got HELD anyway.
// claude.ai's send button has no stable single selector we can rely on
// across versions, so this matches defensively: any clicked <button> whose
// aria-label or data-testid contains "send". To avoid false-firing on an
// unrelated button that happens to mention "send" (there is none currently,
// but be defensive), also require the button live inside the same composer
// container as a recognized chat input (walking up from the button looking
// for an ancestor that contains one, per INPUT_SELECTORS). If no composer
// input can be located near the button at all, stamp anyway -- per the fix
// spec, a false-positive send-detection just keeps the dispatch window open
// slightly longer (harmless), while a false-negative reproduces the bug.
//
// BUG FOUND during #25/#45 audit: the "unrelated button" case wasn't
// hypothetical -- this extension's own dropped/held pill boxes have a "Send
// [...] to chat" button (.ccsw-job-bar-send-btn, aria-label "Send summary"),
// which matched and fired a bogus markUserSend/beacon on every click. Harmless
// on its own (see above), but wrong: clicking OUR button isn't a claude.ai
// send. Excluded below by container rather than by re-wording the label,
// since any future button of ours could just as easily contain "send".
function findComposerInputNear(btn) {
  let el = btn;
  for (let i = 0; i < 8 && el; i++) {
    const input = el.querySelector?.(INPUT_SELECTORS.join(','));
    if (input) return input;
    el = el.parentElement;
  }
  return null;
}

document.addEventListener(
  'click',
  (evt) => {
    const target = evt.target instanceof Element ? evt.target : evt.target?.parentElement;
    const btn = target?.closest('button');
    if (!btn) return;
    if (btn.closest('#ccsw-toolbar, #ccsw-job-hovercard, #ccsw-sw-menu, #ccsw-plan-pills, #ccsw-action-list-pill')) return;
    const ariaLabel = btn.getAttribute('aria-label') || '';
    const testId = btn.getAttribute('data-testid') || '';
    if (!/send/i.test(ariaLabel) && !/send/i.test(testId)) return;
    const inputEl = findComposerInputNear(btn);
    if (!inputEl) {
      markUserSend('send-button click, composer input not located');
      return;
    }
    const textLen = inputEl.textContent?.trim()?.length || 0;
    if (textLen === 0) return;
    // Fix 5a: see the matching comment on the Enter-keydown listener above --
    // same __ccswDeliverySending + piggybackProbeInFlight skip so our own
    // resend's synthetic click (ccswInjTryClickSend) isn't suppressed by
    // this same listener, and a second click can't start an overlapping probe.
    if (piggybackProbeEnabled && !window.__ccswDeliverySending && !piggybackProbeInFlight) {
      evt.preventDefault();
      evt.stopImmediatePropagation();
      runPiggybackProbe('click', inputEl);
      return;
    }
    markUserSend('send-button click');
  },
  true
);

// Permanent instrumentation (#25/#44/#45 audit): every pill/box button click
// logs here, one delegated capture-phase listener rather than a call added
// to each handler individually. Capture phase for the same reason as the
// send-button detector above -- nearly every one of these handlers
// evt.stopPropagation()s (to keep the click from also toggling the pill's
// own header), so a bubble-phase delegate on an ancestor would never see
// the click at all.
//
// handlerRan is a proxy, not a certainty: true means the click resolved to
// a still-tracked activeToolbarJobs entry -- the stale/detached-node
// failure class this audit went looking for. It CANNOT catch a click that
// never reached the button to begin with -- which is exactly what #25/#45
// turned out to be (openJobHovercard's now-fixed hovercard-over-the-box
// overlap): delegation only sees clicks that actually landed on one of
// these buttons. That failure mode has no DOM-event signature to log; it
// was found by reading the z-index/positioning code, not by instrumenting.
function ccswPillStateFromBarEl(barEl) {
  if (barEl.classList.contains('ccsw-job-bar--dropped')) return 'dropped';
  if (barEl.classList.contains('ccsw-job-bar--held-for-send')) return 'held';
  if (barEl.classList.contains('ccsw-job-bar--pending-parked')) return 'parked';
  if (barEl.classList.contains('ccsw-job-bar--pending-delivery')) return 'pending-delivery';
  if (barEl.classList.contains('ccsw-job-bar--error')) return 'error';
  if (barEl.classList.contains('ccsw-job-bar--done')) return 'done';
  if (barEl.classList.contains('ccsw-job-bar--cancelled')) return 'cancelled';
  if (barEl.classList.contains('ccsw-job-bar--stale')) return 'stale';
  return 'running';
}

// 'dispatch-anyway' is one shared CSS class for two different buttons --
// the dropped pill's header "Re-fire" and the held pill's header "Dispatch
// anyway" (see showDroppedJobBar/showHeldForSendBar) -- so split the log
// label back out by state for a readable event, same idea as
// ccswPillStateFromBarEl above. 'ccsw-job-bar-send-btn' no longer needs that
// split (#64): every box's send icon -- dropped, held, and (via the header,
// not a box toolbar) pending-delivery/parked -- now only ever forwards a
// status summary to chat, never a side-effecting action, so 'send' is
// accurate everywhere; `state` alongside it already says which box it was.
function ccswButtonKindForClick(btn, state) {
  if (btn.classList.contains('ccsw-job-bar-send-btn')) return 'send';
  if (btn.classList.contains('ccsw-job-bar-cancel-btn')) return 'cancel';
  if (btn.classList.contains('ccsw-job-bar-dispatch-anyway')) return state === 'dropped' ? 'refire' : 'dispatch-anyway';
  if (btn.classList.contains('ccsw-job-bar-close')) return 'close';
  return null;
}

function ccswJobIdForBarEl(barEl) {
  for (const [id, entry] of activeToolbarJobs) {
    if (entry.barEl === barEl) return id;
  }
  return null;
}

document.addEventListener(
  'click',
  (evt) => {
    const target = evt.target instanceof Element ? evt.target : evt.target?.parentElement;
    const btn = target?.closest('button');
    if (!btn || !btn.closest('#ccsw-toolbar')) return;
    const barEl = btn.closest('.ccsw-job-bar');
    const state = barEl ? ccswPillStateFromBarEl(barEl) : null;
    const kind = ccswButtonKindForClick(btn, state);
    if (!kind) return;
    const jobId = barEl ? ccswJobIdForBarEl(barEl) : null;
    const entry = jobId ? activeToolbarJobs.get(jobId) : null;
    logEvent('button_click', { button: kind, state, jobId: jobId ?? null, handlerRan: !!entry });
  },
  true
);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-wake') return;
  console.log(`[CCswitchboard] wake (job ${message.jobId}): received, background will deliver it:`, message.prompt);
  logPillTransition(message.jobId, message.thread, 'result-landed');
  const wakeStatus = isCancelledResultText(message.resultText) ? 'cancelled' : isErrorResultText(message.resultText) ? 'error' : 'done';
  updateSessionJobStatus(message.jobId, wakeStatus, message.thread);
  setJobBarWaiting(message.jobId, true);
});

// D2: brief "delivered" dim on the JOB pill itself (as opposed to the
// pending-delivery pill's own full lifecycle -- see showPendingDeliveryPill)
// when its wake/result outcome is 'sent'. Deliberately just a timed flash,
// not a permanent state: unlike the pending-delivery pill, a job pill stays
// open showing the job's own feed/status long after delivery, so a lasting
// dim would fight with setJobBarStatus's own done/error/cancelled coloring.
const JOB_DELIVERED_FLASH_MS = 5000;
function flashJobBarDelivered(jobId) {
  const entry = activeToolbarJobs.get(jobId);
  if (!entry) return;
  entry.barEl.classList.add('ccsw-job-bar--delivered-flash');
  clearTimeout(entry.deliveredFlashTimer);
  entry.deliveredFlashTimer = setTimeout(() => {
    entry.barEl.classList.remove('ccsw-job-bar--delivered-flash');
  }, JOB_DELIVERED_FLASH_MS);
}

// Sent once background.js's send state machine (see its own comment) reaches
// a terminal outcome for a delivery -- purely cosmetic (clears the toolbar
// pill's waiting indicator); the actual send already happened or definitively
// failed in the background worker regardless of whether this arrives.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-send-outcome') return;
  console.log(`[CCswitchboard] send outcome for job ${message.jobId}: ${message.outcome}`);
  if (message.jobId !== undefined && message.jobId !== null) {
    setJobBarWaiting(message.jobId, false);
    if (message.outcome === 'sent') flashJobBarDelivered(message.jobId);
  }
});

// --- E4: auto-approve MCP permission dialogs --------------------------------
// Claude surfaces a permission dialog for MCP tool calls that require
// approval. Left unattended, E3's wake loop would stall forever waiting for
// a human to click through it. CONFIRMED live: the approve button's
// textContent is "Always allow" followed by an "Enter" keyboard hint (not a
// separate element in every render), hence startsWith rather than an exact
// match. The DOM route (find-and-click the button) is the actual mechanism;
// the console hook below is just a secondary, earlier trigger for the same
// click since Claude also logs `[MCP] tool_approval_gate {...}` at the
// moment approval is needed.

const APPROVE_BUTTON_PREFIX = 'Always allow';

// Buttons already clicked -- guards against clicking twice if the mutation
// observer and the console-hook poll both notice the same button before the
// DOM removes it.
const approvedButtons = new WeakSet();

function findApproveButton() {
  const buttons = document.querySelectorAll('button');
  for (const btn of buttons) {
    const text = (btn.textContent || '').trim();
    if (text.startsWith(APPROVE_BUTTON_PREFIX) && !approvedButtons.has(btn)) {
      return btn;
    }
  }
  return null;
}

function tryAutoApprove(trigger) {
  const btn = findApproveButton();
  if (!btn) return false;
  console.log(`[CCswitchboard] auto-approve (${trigger}): found "Always allow" button, clicking.`);
  approvedButtons.add(btn);
  btn.click();
  console.log(`[CCswitchboard] auto-approve (${trigger}): clicked.`);
  return true;
}

// The button can render a tick after the console log fires, so this polls
// briefly rather than checking once.
function pollForApproveButton(trigger, timeoutMs = 3000, intervalMs = 100) {
  const start = Date.now();
  (function poll() {
    if (tryAutoApprove(trigger)) return;
    if (Date.now() - start >= timeoutMs) return;
    setTimeout(poll, intervalMs);
  })();
}

// Secondary trigger: console hook. Wrapped defensively so a hook bug can
// never take down the page's own logging.
const originalConsoleLog = console.log;
console.log = function (...args) {
  originalConsoleLog.apply(console, args);
  try {
    const gateArg = args.find((a) => typeof a === 'string' && a.includes('[MCP] tool_approval_gate'));
    if (!gateArg) return;
    const detail = args.find((a) => a && typeof a === 'object' && 'approvalRequired' in a);
    if (detail && !detail.approvalRequired) return;
    originalConsoleLog.call(console, '[CCswitchboard] auto-approve: tool_approval_gate detected, watching for button.');
    pollForApproveButton('console-hook');
  } catch (err) {
    // Never let the hook itself break logging.
  }
};

// Primary trigger: mutation observer. Reuses the same document.body-level
// observation rationale as the main scan() observer above -- claude.ai is a
// React SPA, document.body is the one container guaranteed not to get
// unmounted out from under us.
const approvalObserver = new MutationObserver(() => {
  tryAutoApprove('mutation-observer');
});
approvalObserver.observe(document.body, { childList: true, subtree: true });

// Covers a dialog that's already open at content-script load time (e.g.
// injected after a navigation that happened mid-approval).
tryAutoApprove('startup');

// --- E6: in-thread live job toolbar ------------------------------------------
// A compact collapsed pill (spinner + job id) hugging the right edge of the
// viewport per dispatched ccsw job, stacked vertically partway up from the
// bottom so it doesn't cover the Claude UI or collide with another
// extension's bottom-right widget. Clicking a pill expands it into the full
// panel embedding feed.php?job_id=<id> so the CC stream is visible without
// leaving claude.ai. Multiple concurrent jobs stack as multiple pills.
//
// background.js does the actual jobs.php polling and pushes status
// transitions here via 'ccsw-toolbar-status' -- a content script's fetch() to
// dabblelabs.uk would hit the same claude.ai CORS wall job.php's POST does
// (see README's "Why the actual POST happens in background.js" section), so
// this never fetches jobs.php itself.

// The relay's URLs are NOT hardcoded here: background.js owns the ordered
// relay list and can fail over to the reserve at any moment, so this frame
// asks it for the active relay on load and gets pushed a fresh copy on every
// switch ('ccsw-relay-info'). A content script can't fetch the relay itself
// anyway (CORS, see the note above), so background is already the only thing
// that talks to it -- this just stops the iframe src and the board link from
// pointing at a relay that's no longer in use.
//
// Null until the first answer arrives. Every read below tolerates that: the
// feed iframe simply doesn't load yet, and the board link says so rather than
// opening a wrong URL.
let relayInfo = null;

// Every configured relay's origin, not just the active one -- see
// relayInfoPayload in background.js for why the postMessage check needs all of
// them. Starts empty, so an unsolicited message is ignored until we know.
let relayOrigins = new Set();

function applyRelayInfo(info) {
  if (!info || typeof info.base !== 'string') return;
  const previous = relayInfo && relayInfo.base;
  relayInfo = info;
  relayOrigins = new Set(Array.isArray(info.origins) ? info.origins : []);
  if (previous && previous !== info.base) {
    console.log(`[CCswitchboard] relay switched: ${previous} -> ${info.base}`);
    // Any already-loaded feed iframe still points at the old relay. Drop the
    // src so the next expand re-loads it from the new one rather than showing
    // a dead frame from a relay that just went down.
    resetFeedIframes();
  } else if (!previous) {
    // FIRST arrival (null -> set). This is the fresh-tab terminal-spinner bug:
    // relay info is fetched ASYNCHRONOUSLY from background.js, but pills are
    // restored SYNCHRONOUSLY by scan('startup') -> restoreRunningJobBars. In a
    // tab that has just been opened on an existing conversation, a pill can
    // therefore exist -- and be clicked open -- before relayInfo lands. The
    // lazy-load in updateJobPanel is gated on `relayInfo` being non-null, so it
    // silently does nothing, and NOTHING re-ran it once the info arrived: the
    // panel sat there with a srcless iframe, spinning forever. The relay-switch
    // branch above already had the "re-point open panels" logic; the very first
    // arrival needs it just as much.
    fillMissingFeedIframes();
  }
}

chrome.runtime.sendMessage({ type: 'ccsw-get-relay-info' })
  .then(applyRelayInfo)
  .catch(() => {});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'ccsw-relay-info') applyRelayInfo(message.info);
});

// activeToolbarJobs is declared far above (just under sessionJobs) so scan()'s
// active-job keep-alive can read it without a temporal-dead-zone error on
// scan('startup') -- see its declaration comment.

function getToolbarContainer() {
  let el = document.getElementById('ccsw-toolbar');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ccsw-toolbar';
    document.body.appendChild(el);
  }
  return el;
}

// --- planned-job pills ---------------------------------------------------
// A ccsw block can carry a `plan` array of stages for jobs that aren't
// dispatched yet -- alongside or instead of an actual job dispatch (see
// dispatchCcswBlock). Each entry is either a bare string (legacy, name only)
// or {name, desc} (see normalizePlanStageEntry). Used to render one dashed
// placeholder pill per stage, which overflowed off the top of the window
// once a plan grew past a handful of stages -- collapsed to a single summary
// pill instead, always above every live job pill (see #ccsw-plan-pills's
// `order` in content.css). Clicking the summary pill expands an anchored
// list of the full stage names (desc as each item's hover title).
// Each renderPlanPills call REPLACES the whole set, matching a new plan
// superseding the last one it named -- but carries forward running/
// completed/jobId for any stage name that also existed in the outgoing set
// (CCSW_INSTRUCT_TEXT point 10 has Claude re-emit the plan every time the
// queue changes, so a replace mid-batch must not reset an in-flight stage);
// an empty/missing array clears it entirely (and closes the list if open).
let planPillsContainerEl = null;
let planSummaryPillEl = null;
let planListPanelEl = null;
let planListOpen = false;
// Array of { name, desc, completed, running, jobId } -- one entry per stage,
// in original batch order. Stages are never removed within a single plan
// (see reconcilePlanWithDispatchedJob/reconcilePlanStageCompletion below): a
// matched stage flips `running` (job dispatched, not yet terminal) then
// `completed` (job reached a terminal state), so its original numbering
// survives even as later stages complete, instead of the list renumbering
// from 1 as entries used to be spliced out.
let planStages = [];

function ensurePlanPillsContainer() {
  // Enforce the one-pill-per-tab invariant BY the live DOM, never by trusting
  // the module variable alone (see fable-plans-20260712/check-done/
  // dup-plan-pill-plan.md). Two failure modes this self-heals on every call:
  //   1. An extension reload orphans the previous script instance's pill node
  //      in the page while THIS instance renders its own -- two
  //      #ccsw-plan-pills nodes, both showing the same re-emitted plan.
  //   2. A claude.ai re-render detaches the node we track, leaving
  //      planPillsContainerEl pointing at a disconnected (invisible) node --
  //      the mirror bug. Rebuilding by-DOM fixes both directions.

  // (2) Our tracked node was detached from the page: drop the stale reference
  // so we rebuild below instead of reusing an invisible, disconnected node.
  if (planPillsContainerEl && !planPillsContainerEl.isConnected) {
    planPillsContainerEl = null;
  }

  // (1) Remove every #ccsw-plan-pills node this script does not own (a
  // reload's leftover, or a node we ourselves rendered before but no longer
  // track). getElementById returns only the FIRST match, so loop until the
  // only survivor is the node we own (or none remain). Each node is stamped
  // with the build that created it (data-ccsw-build), so we log the build
  // pair -- if dups keep appearing, the ring buffer now says which build
  // coexisted with which, pinning the trigger.
  const removedBuilds = [];
  let foreign;
  while ((foreign = document.getElementById('ccsw-plan-pills')) && foreign !== planPillsContainerEl) {
    removedBuilds.push(foreign.dataset.ccswBuild || 'unknown');
    foreign.remove();
  }
  if (removedBuilds.length > 0) {
    // Observe-only forensics: the current (owner) build is already on every
    // logged event's envelope; removedBuilds is the orphan side of the pair.
    logEvent('plan_pill_dup', { removed: removedBuilds.length, removedBuilds });
  }

  // If we still own a live node (e.g. it was merely preceded in document order
  // by a now-removed orphan), reuse it -- never build a second one.
  if (planPillsContainerEl && planPillsContainerEl.isConnected) {
    return planPillsContainerEl;
  }

  const containerEl = document.createElement('div');
  containerEl.id = 'ccsw-plan-pills';
  // Forensic stamp: lets a future ensure() that finds this node orphaned log
  // the build that created it (see the plan_pill_dup path above).
  containerEl.dataset.ccswBuild = CCSW_BUILD;

  const pillEl = document.createElement('button');
  pillEl.type = 'button';
  pillEl.id = 'ccsw-plan-summary-pill';
  pillEl.className = 'ccsw-plan-summary-pill';

  const tagEl = document.createElement('span');
  tagEl.className = 'ccsw-plan-pill-tag';
  tagEl.textContent = 'planned';

  const countEl = document.createElement('span');
  countEl.className = 'ccsw-plan-summary-pill-count';

  pillEl.append(tagEl, countEl);
  pillEl.addEventListener('click', (evt) => {
    evt.stopPropagation();
    togglePlanList();
  });

  const panelEl = document.createElement('div');
  panelEl.id = 'ccsw-plan-list-panel';
  panelEl.className = 'ccsw-plan-list-panel';

  containerEl.append(pillEl, panelEl);
  getToolbarContainer().appendChild(containerEl);

  planPillsContainerEl = containerEl;
  planSummaryPillEl = pillEl;
  planListPanelEl = panelEl;
  return containerEl;
}

function renderPlanListPanel() {
  if (!planListPanelEl) return;
  planListPanelEl.textContent = '';

  planStages.forEach((stage, index) => {
    const itemEl = document.createElement('div');
    itemEl.className = 'ccsw-plan-list-item';
    itemEl.classList.toggle('ccsw-plan-list-item--completed', stage.completed);
    // A stage's matched job is live (pending/running -- see
    // reconcilePlanWithDispatchedJob) but hasn't reached a terminal state
    // yet: struck through same as --completed, plus an explicit [RUNNING]
    // tag so "struck through" doesn't read as "done" while the job is still
    // going.
    const isRunning = stage.running && !stage.completed;
    itemEl.classList.toggle('ccsw-plan-list-item--running', isRunning);
    if (stage.desc) itemEl.title = stage.desc;
    itemEl.appendChild(document.createTextNode(`${index + 1}. ${stage.name}`));
    if (isRunning) {
      const tagEl = document.createElement('span');
      tagEl.className = 'ccsw-plan-list-item-running-tag';
      tagEl.textContent = '[RUNNING]';
      itemEl.appendChild(tagEl);
    }
    planListPanelEl.appendChild(itemEl);
  });
}

function openPlanList() {
  if (!planListPanelEl || planListOpen) return;
  planListOpen = true;
  planListPanelEl.classList.add('ccsw-plan-list-panel--open');
  document.addEventListener('click', onPlanListOutsideClick, true);
}

function closePlanList() {
  if (!planListOpen) return;
  planListOpen = false;
  if (planListPanelEl) planListPanelEl.classList.remove('ccsw-plan-list-panel--open');
  document.removeEventListener('click', onPlanListOutsideClick, true);
}

function togglePlanList() {
  if (planListOpen) closePlanList();
  else openPlanList();
}

// #ccsw-plan-pills wraps both the summary pill and its list panel, so this
// one check excludes clicks on either -- capture phase so it still fires
// even if some other handler stops bubble-phase propagation (the same
// capture-phase outside-click pattern the createDisclosure surfaces use).
function onPlanListOutsideClick(evt) {
  if (!evt.target.closest('#ccsw-plan-pills')) closePlanList();
}

// Belt-and-braces for the same stuck-open-menu class of bug fixed for the SW
// menu (see its own visibilitychange listener below): don't leave this list
// open across a tab-away-and-back cycle.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') closePlanList();
});

// Accepts either a bare string per stage (legacy) or a {name, desc} object --
// desc is shown as the stage's hover title, name is what's displayed and
// matched against dispatched job names (see reconcilePlanWithDispatchedJob).
function normalizePlanStageEntry(entry) {
  if (typeof entry === 'string') {
    const name = entry.trim();
    return name ? { name, desc: null } : null;
  }
  if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
    const name = entry.name.trim();
    if (!name) return null;
    const desc = typeof entry.desc === 'string' && entry.desc.trim() ? entry.desc.trim() : null;
    return { name, desc };
  }
  return null;
}

function renderPlanPills(plan) {
  // CCSW_INSTRUCT_TEXT point 10 has Claude RE-EMIT the plan every time the
  // queue changes (stage completes, new work appended), so a fresh call here
  // is often replacing a plan that's already mid-flight -- carry forward
  // running/completed/jobId for any stage whose name (case-insensitive)
  // matches one in the outgoing array, or a re-emit would wipe an
  // in-progress [RUNNING] tag back to its pristine, unmatched state.
  const previousStages = planStages;
  planStages = Array.isArray(plan)
    ? plan
        .map(normalizePlanStageEntry)
        .filter(Boolean)
        .map((stage) => {
          const prior = previousStages.find((p) => p.name.toLowerCase() === stage.name.toLowerCase());
          return prior
            ? { ...stage, completed: prior.completed, running: prior.running, jobId: prior.jobId ?? null }
            : { ...stage, completed: false, running: false, jobId: null };
        })
    : [];
  refreshPlanPillsDisplay();
}

// Re-renders the summary pill (or tears it down) from the current
// `planStages` array, without replacing that array -- shared by
// renderPlanPills (full replace) and reconcilePlanWithDispatchedJob
// (in-place completion of one stage) below.
function refreshPlanPillsDisplay() {
  const allCompleted = planStages.length > 0 && planStages.every((stage) => stage.completed);
  if (planStages.length === 0 || allCompleted) {
    closePlanList();
    if (planPillsContainerEl) {
      planPillsContainerEl.remove();
      planPillsContainerEl = null;
      planSummaryPillEl = null;
      planListPanelEl = null;
    }
    return;
  }

  ensurePlanPillsContainer();
  const total = planStages.length;
  const remaining = planStages.filter((stage) => !stage.completed).length;
  // Once stages start completing, show progress (e.g. "7 of 9") instead of
  // the plain total, so the pill reflects the auto-decrement without
  // renumbering the underlying list (see renderPlanListPanel).
  const countLabel = remaining === total
    ? (total === 1 ? '1 job' : `${total} jobs`)
    : `${remaining} of ${total}`;
  planSummaryPillEl.querySelector('.ccsw-plan-summary-pill-count').textContent = countLabel;
  planSummaryPillEl.setAttribute('aria-label', `Planned jobs: ${countLabel}`);
  renderPlanListPanel();
}

// Called every time a job actually dispatches (see dispatchCcswBlock) so the
// plan pill reflects the batch's progress, instead of only ever changing
// when a fresh `plan` array is sent. Matches the dispatched job's `name`
// against a planned stage's name case-insensitively, since Claude may vary
// capitalization between the plan block and the dispatch block. Marks the
// first matching, not-yet-running/completed stage as `running` (jobId
// recorded so setJobBarStatus's terminal hook below can find it again) --
// NOT completed: the stage stays struck-through-plus-[RUNNING] (see
// renderPlanListPanel) until that job actually reaches a terminal state.
// Only matches the first such stage -- a plan is not expected to contain
// duplicate stage names.
function reconcilePlanWithDispatchedJob(jobId, jobName) {
  if (planStages.length === 0 || typeof jobName !== 'string') return;
  const normalized = jobName.trim().toLowerCase();
  if (!normalized) return;

  const stage = planStages.find((s) => !s.completed && !s.running && s.name.toLowerCase() === normalized);
  if (!stage) return;

  stage.running = true;
  stage.jobId = jobId;
  refreshPlanPillsDisplay();
}

// Flips a plan stage from running -> completed once ITS matched job (see
// reconcilePlanWithDispatchedJob above) reaches a terminal state. Called from
// setJobBarStatus, the single choke point every job status transition
// already passes through, rather than a new poll/timer of its own.
function reconcilePlanStageCompletion(jobId) {
  if (planStages.length === 0) return;
  const stage = planStages.find((s) => s.jobId === jobId && s.running && !s.completed);
  if (!stage) return;

  stage.running = false;
  stage.completed = true;
  refreshPlanPillsDisplay();
}

function setJobBarStatus(jobId, entry, status) {
  entry.status = status;
  entry.statusEl.textContent = status;
  // 'stale' is the Ghost Reaper's own force-resolved terminal state (see
  // reapSilentPills) -- a pill this tab gave up waiting on and independently
  // confirmed (or failed to disconfirm) with the relay, distinct from a
  // user-initiated 'cancelled'.
  const isTerminal = status === 'done' || status === 'error' || status === 'cancelled' || status === 'stale';
  // Drives both the expanded status text color and the collapsed spinner ->
  // solid dot swap (see content.css) -- the collapsed pill only ever shows
  // the spinner, so that swap IS "stop the spinner when done" while collapsed.
  // --terminal covers done/error/cancelled/stale (stop the spinner either
  // way); --done/--error/--cancelled/--stale further pick the color.
  entry.barEl.classList.toggle('ccsw-job-bar--terminal', isTerminal);
  entry.barEl.classList.toggle('ccsw-job-bar--done', status === 'done');
  entry.barEl.classList.toggle('ccsw-job-bar--error', status === 'error');
  entry.barEl.classList.toggle('ccsw-job-bar--cancelled', status === 'cancelled');
  entry.barEl.classList.toggle('ccsw-job-bar--stale', status === 'stale');
  if (isTerminal) {
    logPillTransition(jobId, entry.thread, 'spinner-clear');
    reconcilePlanStageCompletion(jobId);
    // Arm the 3-min auto-expire slide-out now that the pill is terminal (guarded
    // against double-scheduling if the terminal class is re-applied) -- see
    // scheduleTerminalPillExpiry. Dropped/waiting/held/pending pills never reach
    // here, so they're never auto-expired.
    scheduleTerminalPillExpiry(jobId, entry);
  }
}

// Toggles the waiting-indicator class (pulsating dot/label on the pill,
// banner on the expanded panel -- see content.css) for a job whose wake/
// result is currently queued in background.js's send state machine (see the
// E3 wake loop comment above). No-op if jobId is unset (e.g. a repo-free
// wake, which has no toolbar pill at all) or unknown to this tab.
function setJobBarWaiting(jobId, waiting) {
  setSessionJobWaiting(jobId, waiting);
  const entry = activeToolbarJobs.get(jobId);
  if (!entry) return;
  entry.barEl.classList.toggle('ccsw-job-bar--waiting', waiting);
}

// Note 448 Layer 3 (visible fallback): background.js's send state machine
// tells us here once an auto-delivery (job-completion wake-prompt) has
// exhausted its quiet retries -- surfaces loudly (red pulsing pill, on top of
// whatever done/error/cancelled/stale color the job's own status already
// has) rather than leaving the pill's spinner just quietly stopped, which is
// exactly how note 448's original bug went unnoticed. Cleared the moment a
// delivery for this job is actually confirmed sent (background.js's
// confirmDelivered), whether that's a later auto-retry succeeding or Jody
// using the manual resend button.
function setJobBarDeliveryFailed(jobId, failed) {
  const entry = activeToolbarJobs.get(jobId);
  if (!entry) return;
  entry.barEl.classList.toggle('ccsw-job-bar--delivery-failed', failed);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-delivery-failed') return;
  if (message.jobId === undefined || message.jobId === null) return;
  setJobBarDeliveryFailed(message.jobId, !!message.failed);
});

function toggleJobBar(jobId) {
  const entry = activeToolbarJobs.get(jobId);
  if (!entry) return;
  entry.expanded = !entry.expanded;
  entry.barEl.classList.toggle('ccsw-job-bar--expanded', entry.expanded);
  entry.panelEl.classList.toggle('ccsw-job-bar-panel--open', entry.expanded);
  // #56: this used to set an instant native tooltip here to cover the gap
  // before the JS hovercard's own 750ms hover-intent delay (see addJobBar's
  // mouseenter listener) could show it. Removed -- openJobHovercard now shows
  // the real card while expanded too (see its expandedBox handling), so the
  // native tooltip was just a second, crude OS-default popup on top of it.
  entry.headerEl.title = '';
  // A card that was already open from a slow hover before this click landed
  // would otherwise keep sitting in its old (collapsed-style, interactive)
  // form on top of the box that just opened underneath it. Force-close it
  // here rather than leave it stale -- a subsequent hover re-opens it fresh
  // via openJobHovercard, which re-renders it in the click-through,
  // full-detail shape for the now-expanded box.
  if (entry.expanded) hideHovercardIfOwnedBy(jobId, entry.headerEl);
  // Nothing persists across a collapse: drop any manual resize so the next
  // expand starts back at the default 480x420.
  if (!entry.expanded) {
    entry.panelEl.style.width = '';
    entry.panelEl.style.height = '';
  }
  // D2: pending-delivery pills (showPendingDeliveryPill) have no feed.php
  // stream either -- same text-box treatment, fresh on every expand. The
  // generic title fallback above reads entry.summary (unset on these), so
  // this restores the preview text as the collapsed-state tooltip instead
  // (these pills never wire up the JS hovercard at all, unlike a real job
  // pill -- see showPendingDeliveryPill's own comment).
  if (entry.pendingDelivery) {
    entry.headerEl.title = entry.expanded ? '' : (entry.preview || '');
    if (entry.expanded) renderPendingDeliveryPanelContent(entry);
    return;
  }

  // D2b: the merged "N outputs pending" pill (showOrUpdateMergedPendingPill) --
  // no feed stream either; its expanded panel is the live list of the
  // individual pending outputs, rebuilt fresh on each expand.
  if (entry.pendingMerged) {
    entry.headerEl.title = '';
    if (entry.expanded) renderMergedPendingPanelContent(entry);
    return;
  }

  // D2 #12b: a dropped pill superseded by a later successful dispatch under
  // the same stableKey (see resolveSupersededDroppedTwin) -- checked before
  // the plain entry.dropped branch below since a superseded pill is still
  // `dropped: true` underneath, but must render the supersede message
  // instead of the normal drop-context box.
  if (entry.superseded) {
    if (entry.expanded) renderSupersededPanelContent(entry);
    return;
  }

  // Dropped pills have no feed.php job stream to lazy-load an iframe for
  // (see showDroppedJobBar) -- render the drop-context text instead, fresh
  // on every expand so its elapsed-time line stays current.
  if (entry.dropped) {
    if (entry.expanded) renderDroppedPanelContent(entry);
    return;
  }

  // Held pills never ran either (see showHeldForSendBar) -- same "no feed to
  // stream, render context text instead" treatment as dropped above, just
  // with held-specific facts (renderHeldPanelContent).
  if (entry.held) {
    if (entry.expanded) renderHeldPanelContent(entry);
    return;
  }

  // Lazy-load the iframe on first expand rather than the moment the bar is
  // created, so a job that's never opened never costs a feed.php page load.
  // Skipped entirely until background.js has told us which relay is active --
  // a src built from a guessed base would just 404.
  if (entry.expanded && !entry.iframeEl.src && relayInfo) {
    loadFeedIframe(entry, jobId);
    logPillTransition(jobId, entry.thread, 'output');
  } else if (entry.expanded && !entry.iframeEl.src && !relayInfo) {
    // Relay info hasn't landed yet (see applyRelayInfo's first-arrival branch,
    // which retries this the moment it does). Say so, rather than presenting an
    // empty panel that is indistinguishable from a hung load.
    showPanelNotice(entry, 'Connecting to relay...');
  }
}

// How long a feed panel may sit on a blank iframe before we call it and show
// something the user can act on. feed.php is a small page on the same relay the
// extension is already polling; if it hasn't painted in this long it isn't
// going to (relay 5xx, DNS, offline, Cloudflare 521 -- all observed).
const FEED_IFRAME_LOAD_TIMEOUT_MS = 12000;

// Single place that points a panel's iframe at feed.php, used by first expand,
// by the relay-switch reset, and by the first-relay-info fill. Every one of
// those paths previously just assigned .src and hoped: an iframe whose load
// fails (or never resolves) left the panel blank with the pill still spinning,
// with no error and no way to retry short of reloading the page. Bug 3 was the
// permanent version of that; this is the general guard.
//
// Note the deliberate lack of any dependency on tab-local dispatch state: the
// feed is addressed purely by job id against the relay, so a conversation
// reopened in a brand-new tab loads its job output exactly as well as the tab
// that dispatched it.
function loadFeedIframe(entry, jobId) {
  if (!entry?.iframeEl || !relayInfo) return;

  clearFeedIframeWatchdog(entry);
  clearPanelNotice(entry);

  const iframe = entry.iframeEl;
  const onLoad = () => {
    clearFeedIframeWatchdog(entry);
    clearPanelNotice(entry);
  };
  const onError = () => {
    clearFeedIframeWatchdog(entry);
    showPanelNotice(entry, `Couldn't load output for job ${jobId}. The relay may be down. Click here to retry.`);
  };
  iframe.addEventListener('load', onLoad, { once: true });
  iframe.addEventListener('error', onError, { once: true });

  // A cross-origin iframe that 5xxs still fires `load`, not `error`, so the
  // listeners above are necessary but NOT sufficient -- the timeout is what
  // actually guarantees the spinner terminates.
  entry.feedIframeWatchdog = setTimeout(() => {
    entry.feedIframeWatchdog = null;
    showPanelNotice(entry, `Output for job ${jobId} is taking longer than expected. The relay may be unreachable. Click here to retry.`);
  }, FEED_IFRAME_LOAD_TIMEOUT_MS);

  iframe.src = `${relayInfo.feedUrl}?job_id=${jobId}`;
}

function clearFeedIframeWatchdog(entry) {
  if (entry?.feedIframeWatchdog) {
    clearTimeout(entry.feedIframeWatchdog);
    entry.feedIframeWatchdog = null;
  }
}

// Shows the feed-load notice on a panel. Writes to the panel's OWN notice
// element (never the shared delivery-hold overlay -- see the comment where
// feedNoticeEl is created), so this can never clobber, or be clobbered by,
// setJobBarWaiting's "output waiting" text.
function showPanelNotice(entry, text) {
  const noticeEl = entry?.panelEl?.querySelector('.ccsw-job-bar-panel-notice');
  if (!noticeEl) return;
  noticeEl.textContent = text;
  entry.panelEl.classList.add('ccsw-job-bar-panel--notice');
}

function clearPanelNotice(entry) {
  if (!entry?.panelEl) return;
  const noticeEl = entry.panelEl.querySelector('.ccsw-job-bar-panel-notice');
  if (noticeEl) noticeEl.textContent = '';
  entry.panelEl.classList.remove('ccsw-job-bar-panel--notice');
}

// Actually re-attempts a failed feed load, wired to a click on the notice.
//
// The notice used to tell the user to "click the pill twice to retry", which
// did nothing whatsoever: the lazy-load in updateJobPanel is gated on
// `!entry.iframeEl.src`, and a browser does NOT clear .src when a load fails,
// so once loadFeedIframe has assigned it the gate is false forever. Collapsing
// and re-expanding never cleared it either, leaving the panel stuck on the
// notice until a full page reload. Clearing the src here is what makes a retry
// a real retry.
function retryFeedIframe(jobId) {
  const entry = activeToolbarJobs.get(jobId);
  if (!entry?.iframeEl) return;
  if (!relayInfo) {
    showPanelNotice(entry, 'Still connecting to the relay -- try again in a moment.');
    return;
  }
  console.log(`[CCswitchboard] toolbar: retrying feed load for job ${jobId}.`);
  clearFeedIframeWatchdog(entry);
  entry.iframeEl.removeAttribute('src');
  // After loadFeedIframe, not before: its first act is clearPanelNotice, which
  // would otherwise wipe this message the instant it was set.
  loadFeedIframe(entry, jobId);
  showPanelNotice(entry, `Retrying job ${jobId}...`);
}

// Called on a relay switch: blank every loaded feed iframe so the next expand
// re-loads it from the relay that is now active. The src is only re-set on
// expand (see above), so a currently-expanded panel is re-pointed immediately
// rather than left showing a frame from the relay we just failed away from.
function resetFeedIframes() {
  for (const [jobId, entry] of activeToolbarJobs) {
    if (!entry.iframeEl || !entry.iframeEl.src) continue;
    clearFeedIframeWatchdog(entry);
    entry.iframeEl.removeAttribute('src');
    if (entry.expanded && relayInfo) {
      loadFeedIframe(entry, jobId);
    }
  }
}

// Called once, when relay info arrives for the FIRST time (see applyRelayInfo).
// Any panel the user opened while relayInfo was still null has a srcless iframe
// that nothing else will ever fill -- this is the fix for the fresh-tab
// spinner-forever bug. Unlike resetFeedIframes above, it deliberately skips
// panels that already have a src: this is a fill, not a reload.
function fillMissingFeedIframes() {
  for (const [jobId, entry] of activeToolbarJobs) {
    if (!entry.iframeEl || entry.iframeEl.src || !entry.expanded) continue;
    console.log(`[CCswitchboard] toolbar: relay info arrived late -- loading feed for already-open job ${jobId}.`);
    loadFeedIframe(entry, jobId);
  }
}

// feed.php's "send progress for advice" button lives inside the cross-origin
// iframe above (dabblelabs.uk, embedded in this claude.ai tab) and has no
// chrome.* API access of its own, so it can't reach background.js directly.
// It posts a plain window.postMessage instead; this frame (the claude.ai top
// window the iframe is embedded in) receives it and forwards it to
// background.js, which drives the exact same send state machine a
// job-completion wake-prompt uses (see the E3 wake loop comment above).
window.addEventListener('message', (event) => {
  // Checked against every CONFIGURED relay origin rather than one hardcoded
  // one: after a failover the iframe legitimately speaks from a different
  // relay, and an iframe loaded just before the switch still speaks from the
  // old one. Empty until background.js answers, which correctly rejects
  // everything until we know what a relay even is.
  if (!relayOrigins.has(event.origin)) return;
  if (event.data?.type !== 'ccsw-advice-request') return;
  const { jobId, text } = event.data;
  const entry = activeToolbarJobs.get(jobId);
  // Scoping check, same idea as the ccsw-wake handling above: ignore a
  // message for a job this tab didn't dispatch, and confirm it actually came
  // from that job's own iframe rather than some other frame on the page.
  if (!entry || event.source !== entry.iframeEl.contentWindow) return;
  console.log(`[CCswitchboard] advice request (job ${jobId}): received, forwarding to background for delivery.`);
  setJobBarWaiting(jobId, true);
  chrome.runtime.sendMessage({ type: 'ccsw-deliver-advice', jobId, text, thread: entry.thread }).catch((err) => {
    console.warn(`[CCswitchboard] advice request (job ${jobId}): failed to forward to background:`, err.message);
    handlePossibleContextInvalidation(err);
  });
});

// --- resizable feed panel ----------------------------------------------------
// The panel defaults to 480x420 but can be dragged bigger/smaller from any
// edge or corner while open. Nothing is persisted -- toggleJobBar() above
// clears the inline width/height back to the CSS default on every collapse.

const RESIZE_MIN_WIDTH = 300;
const RESIZE_MIN_HEIGHT = 250;
const RESIZE_HANDLE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

function startPanelResize(evt, panelEl, dir) {
  evt.preventDefault();
  evt.stopPropagation(); // don't let the drag bubble up into the header's toggle click

  // Pin the panel to explicit pixel left/top/width/height up front, clearing
  // any right/bottom/transform anchoring first. The consumers are anchored
  // differently -- the feed panel via right/bottom, the action dialog centered
  // via translate(-50%, -50%) -- so a w/n drag can't anchor the opposite edge
  // just by changing width/height: the fixed anchor (or the centering
  // transform) makes the element grow from the wrong origin. Once pinned to a
  // top-left origin we adjust position + size together below. Same pinning
  // startActionDialogDrag does before a move.
  const rect = panelEl.getBoundingClientRect();
  // The top/left pinning below is only meaningful for panels that are
  // out of normal flow (position: fixed/absolute -- the dialogs, feed panel
  // and hovercard), where a w/n drag has to re-anchor the opposite edge by
  // moving left/top. For an IN-FLOW panel (position: relative or static --
  // the job-bar terminal box under its pill header) inline left/top are
  // relative OFFSETS: writing them shifts the panel out of its flow slot so
  // its body appears to vanish (the header is a separate element above and
  // stays put). So gate every left/top write on the element actually being
  // positioned; width/height always apply. (For a static element left/top
  // were already no-ops, so the SW menu is unaffected either way.)
  const panelPositioned = (() => {
    const pos = getComputedStyle(panelEl).position;
    return pos === 'fixed' || pos === 'absolute';
  })();
  panelEl.style.transform = 'none';
  panelEl.style.right = 'auto';
  panelEl.style.bottom = 'auto';
  if (panelPositioned) {
    panelEl.style.left = `${rect.left}px`;
    panelEl.style.top = `${rect.top}px`;
  }
  panelEl.style.width = `${rect.width}px`;
  panelEl.style.height = `${rect.height}px`;

  const startX = evt.clientX;
  const startY = evt.clientY;
  const startWidth = rect.width;
  const startHeight = rect.height;
  const startLeft = rect.left;
  const startTop = rect.top;

  // The iframe is a separate document -- while the mouse is over it, mousemove
  // stops reaching this document's listeners at all. Suspend its hit-testing
  // for the duration of the drag so the parent page keeps receiving events.
  const iframeEl = panelEl.querySelector('.ccsw-job-bar-iframe');
  if (iframeEl) iframeEl.style.pointerEvents = 'none';

  panelEl.classList.add('ccsw-resizing');

  function onMouseMove(moveEvt) {
    const deltaX = moveEvt.clientX - startX;
    const deltaY = moveEvt.clientY - startY;

    if (dir.includes('e')) {
      // Right edge tracks the mouse; left edge (startLeft) stays anchored.
      panelEl.style.width = `${Math.max(RESIZE_MIN_WIDTH, startWidth + deltaX)}px`;
    } else if (dir.includes('w')) {
      // Left edge tracks the mouse; right edge stays anchored. Move left and
      // width in lockstep so their sum (the right edge) is constant, and let
      // the min-width clamp pin left rather than let it cross the right edge.
      const newWidth = Math.max(RESIZE_MIN_WIDTH, startWidth - deltaX);
      panelEl.style.width = `${newWidth}px`;
      // In-flow panel: can't move left (see panelPositioned above), so the box
      // just grows/shrinks its width from the fixed top-left origin instead.
      if (panelPositioned) panelEl.style.left = `${startLeft + (startWidth - newWidth)}px`;
    }

    if (dir.includes('s')) {
      // Bottom edge tracks the mouse; top edge (startTop) stays anchored.
      panelEl.style.height = `${Math.max(RESIZE_MIN_HEIGHT, startHeight + deltaY)}px`;
    } else if (dir.includes('n')) {
      // Top edge tracks the mouse; bottom edge stays anchored.
      const newHeight = Math.max(RESIZE_MIN_HEIGHT, startHeight - deltaY);
      panelEl.style.height = `${newHeight}px`;
      // In-flow panel: can't move top (see panelPositioned above), so the box
      // just grows/shrinks its height from the fixed top-left origin instead.
      if (panelPositioned) panelEl.style.top = `${startTop + (startHeight - newHeight)}px`;
    }
  }

  function onMouseUp() {
    panelEl.classList.remove('ccsw-resizing');
    if (iframeEl) iframeEl.style.pointerEvents = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // Handed back so a caller that needs to abort the drag early (e.g. the SW
  // menu's blur/pointercancel/failsafe guards -- see endSwMenuResize) can tear
  // this closure's own listeners/state down without waiting for a mouseup
  // that may never come. Calling it twice (e.g. once from an abort path and
  // again if mouseup still lands) is safe -- removeEventListener on an
  // already-removed listener is a no-op.
  return onMouseUp;
}

function attachResizeHandles(panelEl) {
  RESIZE_HANDLE_DIRS.forEach((dir) => {
    const handle = document.createElement('div');
    handle.className = `ccsw-resize-handle ccsw-resize-${dir}`;
    handle.addEventListener('mousedown', (evt) => startPanelResize(evt, panelEl, dir));
    panelEl.appendChild(handle);
  });
}

// --- Action List pill + dialog -------------------------------------------
// A persistent pill sitting to the left of the SW icon (#ccsw-sw-menu),
// vertically centered on it -- see content.css's #ccsw-action-list position
// for the exact offsets. actionListState is the GLOBAL list: one set of items
// shared by every open claude.ai tab, kept in sync via background.js's
// periodic actions.php poll + broadcast (see ccsw-actions-state handler
// below) and the ccsw-actions-add/-clear round trips this file triggers.
//
// Each item carries the `thread` it was authored from (or null = the
// untagged "Global" bucket), and the dialog splits that one list into two
// tabs: this conversation's thread, and Global. Both slices are derived
// CLIENT-SIDE from actionListState -- the background poll already fetches the
// unfiltered list with every item's thread on it, so per-tab fetches
// (actions.php?thread= / ?global=1, which the relay does support) would be
// two extra round-trips for data this tab already holds. Deriving locally is
// also what makes the cross-thread indicator free: see otherThreadActionCount.

const ACTION_TIERS = ['blocking', 'recommended', 'nice_to_have'];
const ACTION_TIER_LABELS = { blocking: 'Blocking', recommended: 'Recommended', nice_to_have: 'Nice to have' };

let actionListState = { actions: [], counts: { blocking: 0, recommended: 0, nice_to_have: 0 } };

// #18 S1: the stale-tab set pushed from background.js's sweep (via
// ccsw-stale-tabs-state). Client-local, NOT part of actionListState -- a stale
// tab is a transient per-browser condition, not a relay-backed task. The set is
// surfaced to the user by background.js's OS notification (notifyStaleTabs) and
// its passive F5 banner; it is deliberately NOT shown in the Action List. Kept
// in sync here so the state stays available to any future in-page consumer.
// Each entry: { tabId, title, composerFound, composerEmpty }.
let staleTabsState = [];
let actionListPillEl = null;
let actionListDialogEl = null;
let actionListDialogBodyEl = null;
// #11 S4: the dialog's open/close/toggle now route through a createDisclosure
// instance (getActionListDisclosure below), so there's no standalone
// open-boolean any more -- isOpen lives inside the disclosure, and every former
// `actionListDialogOpen` read now consults `actionListDisclosure?.isOpen`.
// Instantiated lazily on first open rather than at module-eval time, because
// createDisclosure's ignoreWithin default reads SHARED_DISCLOSURE_SCOPE, a const
// declared much further down the file (would be in the TDZ if we built the
// instance up here). Mirrors advancedDisclosure (S2) / settingsDisclosure (S3).
let actionListDisclosure = null;
let actionListTooltipEl = null;
let actionListTooltipHoverTimer = null;
let actionListTabsEl = null;
let actionListHintEl = null;
let actionListOtherThreadsEl = null;

// Which slice the dialog is showing: 'thread' (this conversation's) or
// 'global' (the untagged bucket). Reset on every open (see
// openActionListDialog) so the dialog always lands on what's relevant to
// where Jody currently is.
let actionListTab = 'thread';

// Whether the cross-thread hint's "show..." expander is open. Reset on every
// dialog open (openActionListDialog), same as actionListTab, so a stale
// expansion from a previous session never reappears unasked.
let actionListOtherThreadsExpanded = false;

// This conversation's thread, resolved the same way sendActionsAdd resolves
// it for tagging: hydratedThread when scan() has found one, else the
// remembered-URL fallback loaded once at startup (below). Null on a brand-new
// conversation that has never carried a ccsw block -- the thread tab is then
// legitimately empty and the dialog opens on Global instead.
let actionListUrlThread = null;

function currentActionListThread() {
  // hydratedThread is declared further up with `let` but assigned lazily;
  // read it defensively for the same reason sendActionsAdd does.
  let thread = null;
  try {
    thread = hydratedThread || null;
  } catch (tdz) {
    thread = null;
  }
  return thread || actionListUrlThread || null;
}

// The two tab predicates, over any list of items carrying a `thread` (both
// actionListState.actions and the completedActionItems buffer qualify).
// #63: Global used to narrow to the untagged bucket only; it's now every
// item regardless of thread (untagged included), so it's the one place that
// shows the whole outstanding picture in one list.
function actionsForTab(items, tab, thread) {
  if (tab === 'global') return items;
  if (!thread) return [];
  return items.filter((a) => a.thread === thread);
}

// The cross-thread indicator's number: items parked in some OTHER named
// thread, which neither tab shows. Global items are excluded -- they have
// their own tab and are one click away, so counting them here would just
// double-report what the Global tab's own badge already says.
function otherThreadActionCount(items, thread) {
  return items.filter((a) => a.thread && a.thread !== thread).length;
}

// The expander's per-thread rows: same OTHER-thread filter as
// otherThreadActionCount above, just grouped by thread name instead of
// collapsed into one number. Sorted busiest-first (then name asc for ties) so
// the row order doesn't jitter as items get ticked off elsewhere.
function otherThreadActionBreakdown(items, thread) {
  const counts = new Map();
  items.forEach((a) => {
    if (!a.thread || a.thread === thread) return;
    counts.set(a.thread, (counts.get(a.thread) || 0) + 1);
  });
  return [...counts.entries()]
    .map(([otherThread, count]) => ({ thread: otherThread, count }))
    .sort((a, b) => b.count - a.count || a.thread.localeCompare(b.thread));
}

// Client-side-only undo cushion for ticked-off items -- NOT synced via
// ccsw-actions-state (the relay already deletes on tick, see
// finishCompleteActionItem below), so this buffer is purely local and does
// not survive a reload.
// Newest first; capped so a long session doesn't grow this unbounded.
let completedActionItems = [];
const COMPLETED_ACTION_ITEMS_CAP = 5;

// Timings for the tick-off animation (fade+grey, then strikethrough) before
// the item actually moves out of the active list -- see beginCompleteActionItem.
// Kept in sync with the transition durations in content.css.
const ACTION_COMPLETE_FADE_MS = 220;
const ACTION_COMPLETE_STRIKE_MS = 260;

function recomputeActionCounts() {
  const counts = { blocking: 0, recommended: 0, nice_to_have: 0 };
  actionListState.actions.forEach((a) => {
    if (counts[a.tier] !== undefined) counts[a.tier]++;
  });
  actionListState = { ...actionListState, counts };
}

// Plain-text hint for the pill (see #ccsw-action-list-tooltip in content.css)
// -- unlike #ccsw-job-hovercard this has no interactive content, so it just
// follows the pill's own hover state rather than needing its own hover-intent
// or click-outside-to-dismiss handling.
function ensureActionListTooltip() {
  if (actionListTooltipEl) return actionListTooltipEl;
  actionListTooltipEl = document.createElement('div');
  actionListTooltipEl.id = 'ccsw-action-list-tooltip';
  actionListTooltipEl.textContent = 'Things you need to do';
  actionListTooltipEl.hidden = true;
  document.body.appendChild(actionListTooltipEl);
  return actionListTooltipEl;
}

function showActionListTooltip(pillEl) {
  const tooltipEl = ensureActionListTooltip();
  const rect = pillEl.getBoundingClientRect();
  tooltipEl.hidden = false;
  tooltipEl.style.right = `${Math.round(window.innerWidth - rect.right)}px`;
  tooltipEl.style.bottom = `${Math.round(window.innerHeight - rect.top) + 6}px`;
}

function hideActionListTooltip() {
  clearTimeout(actionListTooltipHoverTimer);
  actionListTooltipHoverTimer = null;
  if (actionListTooltipEl) actionListTooltipEl.hidden = true;
}

function ensureActionListPill() {
  if (actionListPillEl) return actionListPillEl;

  const containerEl = document.createElement('div');
  containerEl.id = 'ccsw-action-list';

  const pillEl = document.createElement('button');
  pillEl.type = 'button';
  pillEl.id = 'ccsw-action-list-pill';
  pillEl.className = 'ccsw-action-list-pill';
  pillEl.setAttribute('aria-label', 'Tasks for you');

  ACTION_TIERS.forEach((tier) => {
    const tierEl = document.createElement('span');
    tierEl.className = `ccsw-action-tier ccsw-action-tier--${tier}`;
    tierEl.dataset.tier = tier;
    pillEl.appendChild(tierEl);
  });

  pillEl.addEventListener('click', (evt) => {
    evt.stopPropagation();
    toggleActionListDialog();
  });

  // Hover-intent delay (same reasoning as addJobBar's headerEl listeners) so
  // an incidental pass over the toolbar doesn't pop the tooltip instantly.
  pillEl.addEventListener('mouseenter', () => {
    clearTimeout(actionListTooltipHoverTimer);
    actionListTooltipHoverTimer = setTimeout(() => showActionListTooltip(pillEl), 400);
  });
  pillEl.addEventListener('mouseleave', () => {
    hideActionListTooltip();
  });

  containerEl.appendChild(pillEl);
  document.body.appendChild(containerEl);

  actionListPillEl = pillEl;
  return actionListPillEl;
}

// The pill's badges stay GLOBAL -- every outstanding item across every
// thread, as before the dialog gained tabs. Narrowing them to the current
// thread would make the pill go empty while Global items were still
// outstanding, i.e. the one place that's meant to nag would stop nagging
// about the very bucket that has no thread to bring it back into view.
// The per-thread split is the dialog's job, and it opens one click away.
function renderActionListPill() {
  const pillEl = ensureActionListPill();
  const counts = actionListState.counts;
  const allZero = ACTION_TIERS.every((tier) => (counts[tier] || 0) === 0);
  pillEl.classList.toggle('ccsw-action-list-pill--empty', allZero);

  ACTION_TIERS.forEach((tier) => {
    const tierEl = pillEl.querySelector(`.ccsw-action-tier--${tier}`);
    const count = counts[tier] || 0;
    tierEl.textContent = count > 0 ? String(count) : '';
    tierEl.classList.toggle('ccsw-action-tier--filled', count > 0);
    tierEl.classList.toggle('ccsw-action-tier--pulsing', tier === 'blocking' && count > 0);
  });

  // Pill border colour = the most severe tier that currently has items
  // (blocking > recommended > nice_to_have), so the border always echoes
  // the same colour as the worst badge inside it. No border class applied
  // when every tier is empty -- the pill keeps its plain default outline.
  const borderTier = ACTION_TIERS.find((tier) => (counts[tier] || 0) > 0) || null;
  ACTION_TIERS.forEach((tier) => {
    pillEl.classList.toggle(`ccsw-action-list-pill--border-${tier}`, tier === borderTier);
  });

  // Badge counts change this pill's width, and the personal-pill row is
  // anchored to its left edge -- re-measure so the gap doesn't drift.
  repositionPersonalPills();

  if (actionListDisclosure?.isOpen) renderActionListDialog();
}

// Moves the whole dialog by its header -- there's no free-drag precedent
// elsewhere in this file (only the resize handles above), so this is a
// from-scratch mousedown/mousemove/mouseup drag, same shape as
// startPanelResize but adjusting left/top instead of width/height. Switches
// the dialog from its initial centered position (left/top: 50% + transform)
// to plain pixel left/top on the first drag.
function startActionDialogDrag(evt, dialogEl) {
  if (evt.target.closest('.ccsw-action-dialog-close')) return;
  evt.preventDefault();

  const rect = dialogEl.getBoundingClientRect();
  dialogEl.style.transform = 'none';
  dialogEl.style.right = 'auto';
  dialogEl.style.bottom = 'auto';
  dialogEl.style.left = `${rect.left}px`;
  dialogEl.style.top = `${rect.top}px`;

  const startX = evt.clientX;
  const startY = evt.clientY;
  const startLeft = rect.left;
  const startTop = rect.top;

  function onMouseMove(moveEvt) {
    dialogEl.style.left = `${startLeft + (moveEvt.clientX - startX)}px`;
    dialogEl.style.top = `${startTop + (moveEvt.clientY - startY)}px`;
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function ensureActionListDialog() {
  if (actionListDialogEl) return actionListDialogEl;

  const dialogEl = document.createElement('div');
  dialogEl.id = 'ccsw-action-dialog';
  dialogEl.className = 'ccsw-action-dialog';
  dialogEl.hidden = true;

  const headerEl = document.createElement('div');
  headerEl.className = 'ccsw-action-dialog-header';
  headerEl.addEventListener('mousedown', (evt) => startActionDialogDrag(evt, dialogEl));

  const titleEl = document.createElement('span');
  titleEl.className = 'ccsw-action-dialog-title';
  titleEl.textContent = 'Tasks for you';

  const closeEl = document.createElement('button');
  closeEl.type = 'button';
  closeEl.className = 'ccsw-action-dialog-close';
  closeEl.setAttribute('aria-label', 'Close');
  closeEl.textContent = '×';
  closeEl.addEventListener('click', (evt) => {
    evt.stopPropagation();
    closeActionListDialog();
  });

  headerEl.append(titleEl, closeEl);

  // Tab strip + cross-thread hint live in the dialog SHELL, not the body,
  // so they survive renderActionListDialog wiping the body on every render
  // (and stay put while the body scrolls).
  const tabsEl = document.createElement('div');
  tabsEl.className = 'ccsw-action-dialog-tabs';
  ['thread', 'global'].forEach((tab) => {
    const tabEl = document.createElement('button');
    tabEl.type = 'button';
    tabEl.className = 'ccsw-action-dialog-tab';
    tabEl.dataset.tab = tab;
    tabEl.addEventListener('click', (evt) => {
      evt.stopPropagation();
      setActionListTab(tab);
    });
    tabsEl.appendChild(tabEl);
  });

  const hintEl = document.createElement('div');
  hintEl.className = 'ccsw-action-dialog-hint';
  hintEl.hidden = true;

  // The hint's "show..." expander: one row per other thread with actions,
  // populated by renderOtherThreadsExpander. Lives in the shell next to
  // hintEl (not the body) for the same reason tabsEl/hintEl do -- it must
  // survive renderActionListDialog wiping the body on every render.
  const otherThreadsEl = document.createElement('div');
  otherThreadsEl.className = 'ccsw-action-dialog-other-threads';
  otherThreadsEl.hidden = true;

  const bodyEl = document.createElement('div');
  bodyEl.className = 'ccsw-action-dialog-body';

  const footerEl = document.createElement('div');
  footerEl.className = 'ccsw-action-dialog-footer';

  const sendEl = document.createElement('button');
  sendEl.type = 'button';
  sendEl.className = 'ccsw-action-dialog-send';
  sendEl.textContent = 'Send revised list to chat';
  sendEl.addEventListener('click', (evt) => {
    evt.stopPropagation();
    sendActionListToChat();
  });

  footerEl.appendChild(sendEl);

  dialogEl.append(headerEl, tabsEl, hintEl, otherThreadsEl, bodyEl, footerEl);
  // Reuses the exact same resize-handle machinery the feed panel uses above
  // -- attachResizeHandles/startPanelResize operate on any panelEl passed in
  // and only special-case a `.ccsw-job-bar-iframe` child (absent here, so
  // that branch is just a no-op).
  attachResizeHandles(dialogEl);
  document.body.appendChild(dialogEl);

  actionListDialogEl = dialogEl;
  actionListDialogBodyEl = bodyEl;
  actionListTabsEl = tabsEl;
  actionListHintEl = hintEl;
  actionListOtherThreadsEl = otherThreadsEl;
  return actionListDialogEl;
}

function setActionListTab(tab) {
  if (actionListTab === tab) return;
  actionListTab = tab;
  renderActionListDialog();
}

// Labels + per-tab counts on the tab strip, and the cross-thread hint under
// it. The thread tab is named after the thread itself, which is the same
// human-readable string the SW menu shows -- so the tab reads "CCswitchboard"
// rather than a generic "This thread".
function renderActionListTabs() {
  if (!actionListTabsEl || !actionListHintEl) return;

  const thread = currentActionListThread();
  const { actions } = actionListState;
  const labels = {
    thread: thread || 'This thread',
    global: 'Global',
  };

  actionListTabsEl.querySelectorAll('.ccsw-action-dialog-tab').forEach((tabEl) => {
    const tab = tabEl.dataset.tab;
    const count = actionsForTab(actions, tab, thread).length;

    tabEl.textContent = '';
    const labelEl = document.createElement('span');
    labelEl.className = 'ccsw-action-dialog-tab-label';
    labelEl.textContent = labels[tab];
    tabEl.appendChild(labelEl);

    if (count > 0) {
      const countEl = document.createElement('span');
      countEl.className = 'ccsw-action-dialog-tab-count';
      countEl.textContent = String(count);
      tabEl.appendChild(countEl);
    }

    tabEl.classList.toggle('ccsw-action-dialog-tab--active', tab === actionListTab);
    tabEl.title = tab === 'global'
      ? 'Every outstanding task, across every thread'
      : (thread ? `Tasks from the "${thread}" thread` : 'This conversation has no thread yet');
  });

  const others = otherThreadActionCount(actions, thread);
  actionListHintEl.hidden = others === 0;
  actionListHintEl.textContent = '';
  if (others === 0) {
    actionListOtherThreadsExpanded = false;
  } else {
    const textEl = document.createElement('span');
    textEl.textContent = `${others} task${others === 1 ? '' : 's'} in other threads `;

    const toggleEl = document.createElement('button');
    toggleEl.type = 'button';
    toggleEl.className = 'ccsw-action-dialog-hint-toggle';
    toggleEl.textContent = actionListOtherThreadsExpanded ? 'hide' : 'show threads...';
    toggleEl.addEventListener('click', (evt) => {
      evt.stopPropagation();
      actionListOtherThreadsExpanded = !actionListOtherThreadsExpanded;
      renderActionListDialog();
    });

    actionListHintEl.append(textEl, toggleEl);
  }

  renderOtherThreadsExpander(actions, thread, others > 0 && actionListOtherThreadsExpanded);
}

// The expander's body: one row per OTHER thread with actions (never the
// current tab's thread, never Global -- Global already has its own tab).
// Rebuilt on every render rather than diffed, same as the rest of this
// dialog -- the list is always small.
function renderOtherThreadsExpander(actions, thread, expanded) {
  if (!actionListOtherThreadsEl) return;
  actionListOtherThreadsEl.textContent = '';
  actionListOtherThreadsEl.hidden = !expanded;
  if (!expanded) return;

  otherThreadActionBreakdown(actions, thread).forEach(({ thread: otherThread, count }) => {
    const rowEl = document.createElement('button');
    rowEl.type = 'button';
    rowEl.className = 'ccsw-action-dialog-other-thread';

    const nameEl = document.createElement('span');
    nameEl.className = 'ccsw-action-dialog-other-thread-name';
    nameEl.textContent = otherThread;

    const countEl = document.createElement('span');
    countEl.className = 'ccsw-action-dialog-other-thread-count';
    countEl.textContent = String(count);

    rowEl.append(nameEl, countEl);
    rowEl.addEventListener('click', (evt) => {
      evt.stopPropagation();
      openOtherThread(otherThread, rowEl);
    });
    actionListOtherThreadsEl.appendChild(rowEl);
  });
}

// Click-to-open for an expander row. background.js resolves the thread to a
// tab (registeredThreads, the same in-memory map focus_request.php polling
// already uses to jump to a thread) or a remembered conversation URL (this
// file's own URL_THREAD_STORAGE_KEY map, read back on the background side) --
// see ccsw-open-thread's handler for the two-step lookup. Neither resolving
// is shown as a brief inline message next to the clicked row rather than a
// toast/alert, since this is a minor secondary action inside an already-open
// dialog.
async function openOtherThread(thread, rowEl) {
  logEvent('open_thread_click', { thread }, null, true);
  rowEl.classList.add('ccsw-action-dialog-other-thread--pending');

  let response = null;
  try {
    response = await chrome.runtime.sendMessage({ type: 'ccsw-open-thread', thread });
  } catch (err) {
    handlePossibleContextInvalidation(err);
  }

  rowEl.classList.remove('ccsw-action-dialog-other-thread--pending');
  if (response?.ok) return;

  const errEl = document.createElement('div');
  errEl.className = 'ccsw-action-dialog-other-thread-error';
  errEl.textContent = `no known tab for ${thread}`;
  rowEl.insertAdjacentElement('afterend', errEl);
  setTimeout(() => errEl.remove(), 4000);
}

function renderActionListDialog() {
  if (!actionListDialogBodyEl) return;
  renderActionListTabs();
  actionListDialogBodyEl.textContent = '';

  const thread = currentActionListThread();
  const actions = actionsForTab(actionListState.actions, actionListTab, thread);
  const completed = actionsForTab(completedActionItems, actionListTab, thread);

  ACTION_TIERS.forEach((tier) => {
    // #63: within a tier, oldest first -- created_at is an isoNow() UTC
    // string (sortable lexicographically), id is the tiebreak/fallback for
    // the rare item still missing one (see restoreActionItem's optimistic
    // re-add, which briefly carries the completed item's stale created_at).
    const items = actions
      .filter((a) => a.tier === tier)
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || '') || (a.id - b.id));
    if (items.length === 0) return;

    const groupEl = document.createElement('div');
    groupEl.className = `ccsw-action-dialog-group ccsw-action-dialog-group--${tier}`;

    const labelEl = document.createElement('div');
    labelEl.className = 'ccsw-action-dialog-group-label';
    labelEl.textContent = ACTION_TIER_LABELS[tier];
    groupEl.appendChild(labelEl);

    items.forEach((item) => {
      const rowEl = document.createElement('label');
      rowEl.className = 'ccsw-action-dialog-item';
      // #63: Global mixes every thread's items, so an unchecked row is
      // titled with its origin thread (untagged -> 'Global') to say where
      // it came from. Not needed on the thread tab -- every row there is
      // already known to be from the one thread the tab is showing.
      if (actionListTab === 'global') rowEl.title = item.thread || 'Global';

      const checkEl = document.createElement('input');
      checkEl.type = 'checkbox';
      checkEl.addEventListener('change', () => beginCompleteActionItem(item.id, rowEl));

      const textEl = document.createElement('span');
      textEl.className = 'ccsw-action-dialog-item-text';
      textEl.textContent = item.text;

      const qpillEl = document.createElement('span');
      qpillEl.className = 'ccsw-action-dialog-item-qpill';
      qpillEl.textContent = 'Q';
      qpillEl.title = 'Query about this todo';
      // preventDefault + stopPropagation: rowEl is a <label> wrapping
      // checkEl, so an unguarded click here would also toggle/complete the
      // item via the label's native click-forwards-to-control behavior.
      qpillEl.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        askQueryAboutActionItem(item);
      });

      rowEl.append(checkEl, textEl, qpillEl);
      groupEl.appendChild(rowEl);
    });

    actionListDialogBodyEl.appendChild(groupEl);
  });

  if (actions.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'ccsw-action-dialog-empty';
    if (actionListTab === 'global') emptyEl.textContent = 'Nothing outstanding anywhere.';
    else if (!thread) emptyEl.textContent = 'This conversation has no thread yet.';
    else emptyEl.textContent = 'Nothing to do in this thread.';
    actionListDialogBodyEl.appendChild(emptyEl);
  }

  renderCompletedActionItems(completed);
}

// The "completed" section below the active tiers -- an undo cushion, not a
// history log. Rows are struck-through/greyed and clickable to restore (see
// restoreActionItem). Purely a render of the caller's already-tab-filtered
// slice of completedActionItems (a ticked item keeps its thread, so it
// reappears under the tab it was ticked from); the tick animation that feeds
// it lives in beginCompleteActionItem/finishCompleteActionItem.
function renderCompletedActionItems(completedItems) {
  if (completedItems.length === 0) return;

  const sectionEl = document.createElement('div');
  sectionEl.className = 'ccsw-action-dialog-completed';

  const labelEl = document.createElement('div');
  labelEl.className = 'ccsw-action-dialog-group-label ccsw-action-dialog-group-label--completed';
  labelEl.textContent = 'Completed';
  sectionEl.appendChild(labelEl);

  completedItems.forEach((item) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'ccsw-action-dialog-item ccsw-action-dialog-item--completed';
    rowEl.title = 'Click to restore';
    rowEl.addEventListener('click', () => restoreActionItem(item.id));

    const textEl = document.createElement('span');
    textEl.className = 'ccsw-action-dialog-item-text';
    textEl.textContent = item.text;

    rowEl.appendChild(textEl);
    sectionEl.appendChild(rowEl);
  });

  actionListDialogBodyEl.appendChild(sectionEl);
}

// #11 S4 migration onto the popover contract, mirroring the Advanced (S2) and
// Settings (S3) dialogs. The show/hide itself is unchanged -- toggling `hidden`
// on the draggable/resizable shell built by ensureActionListDialog -- but
// open/close now route through a createDisclosure instance so the dialog gains
// the contract's shared behaviours:
//   - closeOnOutside: a genuine outside click now closes the dialog, decided by
//     pointerdown provenance (contract rule 2). This surface had NO outside-click
//     close before (the plan names onPlanListOutsideClick, but that guards the
//     separate plan-pills list, not this dialog), so the migration ADDS
//     outside-close here, unifying it with Advanced/Settings. Provenance is what
//     makes that safe for a draggable/resizable dialog: a header drag or a
//     corner-resize that releases outside the dialog, or a text selection dragged
//     out of the body, all began with a pointerdown INSIDE, so the click the
//     browser synthesizes on their common ancestor never reads as an outside
//     click -- no false-close (the "drag interplay" the plan flags for this
//     stage). No per-interaction flag or holdOpen() latch is needed: each drag
//     lives entirely between one pointerdown and its mouseup, which provenance
//     covers on its own (holdOpen is only for interactions that outlive their
//     pointerdown, e.g. the SW-menu resize's blur/pointercancel failsafes in S5).
//   - closeOnEscape: Escape closes it, but only when it's the topmost entry in
//     the module open-stack, so it peels one level at a time off any stack.
// The `el` factory is lazy (ensureActionListDialog builds on first open and
// caches thereafter), matching the contract's el() option. onOpen re-derives the
// active tab (thread if this conversation has one, else Global) and collapses any
// stale cross-thread expansion, exactly as the old openActionListDialog did.
// closeOnHide/closeWhenDetached stay at their defaults (off), same call as
// getSettingsDisclosure/getAdvancedDisclosure: the plan tags this stage with
// "visibilitychange", but it does not REQUIRE closeOnHide here, and this dialog
// is a user-managed, draggable/resizable workspace (the user positions it,
// switches tabs, ticks items) -- unlike the lightweight pill popovers it should
// not vanish on a tab-away that discards its position and tab selection, and it
// had no prior visibilitychange auto-close to preserve. It's also a body child
// claude.ai never detaches, so closeWhenDetached is moot too.
function getActionListDisclosure() {
  if (actionListDisclosure) return actionListDisclosure;
  actionListDisclosure = createDisclosure({
    el: () => ensureActionListDialog(),
    closeOnOutside: true,
    closeOnEscape: true,
    onOpen: (dialogEl) => {
      dialogEl.hidden = false;
      // Always land on what's relevant to where Jody is right now: the thread
      // tab if this conversation has one, else Global (the thread tab could
      // only ever be empty otherwise). Collapse any stale cross-thread
      // expansion carried over from a previous open.
      actionListTab = currentActionListThread() ? 'thread' : 'global';
      actionListOtherThreadsExpanded = false;
      renderActionListDialog();
    },
    onClose: (dialogEl) => {
      if (dialogEl) dialogEl.hidden = true;
    },
  });
  return actionListDisclosure;
}

function openActionListDialog() {
  getActionListDisclosure().open();
}

function closeActionListDialog() {
  getActionListDisclosure().close();
}

function toggleActionListDialog() {
  getActionListDisclosure().toggle();
}

// Ticking an item off in the dialog -- rather than yanking the row out
// immediately, play the fade-then-strikethrough animation in place on the
// existing row (so it stays a stable target if the user's cursor is still
// over it) and only touch the data model once that's done, in
// finishCompleteActionItem. The checkbox is disabled immediately so a
// double-toggle mid-animation can't fire this twice.
function beginCompleteActionItem(id, rowEl) {
  const checkEl = rowEl.querySelector('input[type="checkbox"]');
  if (checkEl) checkEl.disabled = true;

  rowEl.classList.add('ccsw-action-dialog-item--completing');
  setTimeout(() => {
    rowEl.classList.add('ccsw-action-dialog-item--struck');
  }, ACTION_COMPLETE_FADE_MS);
  setTimeout(() => {
    finishCompleteActionItem(id);
  }, ACTION_COMPLETE_FADE_MS + ACTION_COMPLETE_STRIKE_MS);
}

// Moves the item from the active list into the completed buffer (capped,
// oldest dropped first) and re-renders -- the row reappears already settled
// in the completed section, which reads as the "slide down" the animation
// promised without needing a cross-container FLIP animation. Then persists
// the tick via background.js same as before. If the request fails, the next
// ccsw-actions-state broadcast (background.js's poll loop) resyncs this
// tab's active list regardless -- no special error handling needed here;
// worst case the completed buffer shows an item that failed to delete
// server-side, which restoreActionItem's re-add would simply recreate.
function finishCompleteActionItem(id) {
  const item = actionListState.actions.find((a) => a.id === id);

  actionListState = { ...actionListState, actions: actionListState.actions.filter((a) => a.id !== id) };
  recomputeActionCounts();

  if (item) {
    completedActionItems = [{ ...item }, ...completedActionItems].slice(0, COMPLETED_ACTION_ITEMS_CAP);
  }

  renderActionListPill();

  chrome.runtime.sendMessage({ type: 'ccsw-actions-clear', ids: [id] }).catch((err) => {
    handlePossibleContextInvalidation(err);
  });
}

// Undo: clicking a completed row pulls it back into the active list. The
// relay already deleted the original item (finishCompleteActionItem's
// ccsw-actions-clear above), so this can't just un-delete it -- instead it
// re-adds {text, tier} as a brand-new item via the same ccsw-actions-add path
// Claude-authored actions use, which re-broadcasts the authoritative state
// (with a fresh id) to every open tab. The local splice below is only an
// optimistic preview so the row jumps back instantly instead of waiting on
// that round trip; the incoming broadcast fully replaces actionListState.actions
// (see the ccsw-actions-state listener), so this optimistic entry -- old id
// and all -- gets superseded rather than duplicated.
function restoreActionItem(id) {
  const idx = completedActionItems.findIndex((a) => a.id === id);
  if (idx === -1) return;

  const item = completedActionItems[idx];
  completedActionItems = completedActionItems.filter((a) => a.id !== id);

  actionListState = { ...actionListState, actions: [...actionListState.actions, { ...item }] };
  recomputeActionCounts();
  renderActionListPill();

  // Re-add under the item's ORIGINAL thread, not whichever thread this tab
  // happens to be showing: undo restores an action, it doesn't re-author it.
  // A pre-thread item (thread null) correctly goes back to Global.
  sendActionsAdd([{ text: item.text, tier: item.tier }], item.thread || null);
}

// Q pill (#60): asks a quick question about one todo item and delivers it
// into THAT item's own thread (item.thread -- which can differ from
// whatever conversation this dialog happens to be open in), so the Claude
// instance that owns that context answers it. window.prompt is the only
// existing free-text-input precedent in this file (see the pill-snapshot
// "leave a note" comment feature further down) -- there's no richer
// styled-modal-with-input pattern here to reuse instead.
function askQueryAboutActionItem(item) {
  const query = window.prompt('Query about this todo?');
  if (query === null) return; // cancelled
  const trimmed = query.trim();
  if (trimmed === '') return;

  const text = `Q re todo "${item.text}": ${trimmed}`;
  chrome.runtime.sendMessage({ type: 'ccsw-deliver-to-thread', thread: item.thread || null, text }).catch((err) => {
    handlePossibleContextInvalidation(err);
  });
}

// The dialog's send button -- composes the current (post-tick) state as
// plain text and hands it to background.js's send state machine, the same
// wake/send path feed.php's advice button uses (see ccsw-deliver-actions
// handler in background.js). No auto-send-on-tick (see note 448's spec) --
// this is the only way the revised list reaches the chat.
//
// Sends the VISIBLE tab's slice, not the whole list: the button sits directly
// under a filtered list, so sending items the dialog isn't showing (other
// threads' work, dumped into this chat) would contradict what's on screen.
// The bucket is named in the text so the receiving Claude knows which slice
// it just got.
function sendActionListToChat() {
  const thread = currentActionListThread();
  const actions = actionsForTab(actionListState.actions, actionListTab, thread);
  const bucket = actionListTab === 'global' ? 'Global' : (thread || 'this thread');

  let text;
  if (actions.length === 0) {
    text = `Tasks for me (${bucket}): all cleared.`;
  } else {
    const lines = [`Tasks for you (${bucket}, revised):`];
    ACTION_TIERS.forEach((tier) => {
      const items = actions.filter((a) => a.tier === tier);
      lines.push(`${ACTION_TIER_LABELS[tier]}: ${items.length === 0 ? 'none' : items.map((a) => a.text).join('; ')}`);
    });
    text = lines.join('\n');
  }

  chrome.runtime.sendMessage({ type: 'ccsw-deliver-actions', text }).catch((err) => {
    handlePossibleContextInvalidation(err);
  });
}

// background.js's periodic actions.php poll (or an immediate reply to
// ccsw-actions-add/-clear) broadcasts the current global state to every open
// claude.ai tab -- this is the only place actionListState is set from the
// relay's own data (finishCompleteActionItem/restoreActionItem above only
// ever predict it locally in the meantime).
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-actions-state') return false; // not for us

  actionListState = {
    actions: Array.isArray(message.actions) ? message.actions : [],
    counts: message.counts || actionListState.counts,
  };
  renderActionListPill();

  return false; // no response needed
});

// #18 S1: background's stale-tab sweep pushes the current stale set here (every
// open tab gets it). Kept in sync so the state stays available to any consumer;
// the stale set itself is surfaced to the user by background.js's OS
// notification (see its notifyStaleTabs), not by the Action List.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-stale-tabs-state') return false; // not for us

  staleTabsState = Array.isArray(message.staleTabs) ? message.staleTabs : [];

  return false; // no response needed
});

// --- Settings dialog -------------------------------------------------------
// Consolidates user-facing on/off preferences that aren't already reachable
// as their own SW menu row into one dialog. Global/per-thread listening are
// deliberately NOT here -- they're each already a directly clickable SW menu
// row (swMenuGlobalListeningItemEl/swMenuListeningItemEl below), so a
// duplicate toggle here would just be a second, easier-to-miss control for
// the exact same flag. Each row here is just a UI over an existing
// chrome.storage.local-backed flag and its existing setter -- this dialog is
// not a new source of truth. Same draggable/resizable dialog shell as the
// Action List dialog above (ensureActionListDialog); duplicated rather than
// shared since the two dialogs have unrelated bodies (a static settings list
// vs. a live-updating action list) and there's no shared state to justify
// factoring out a common base.
//
// To add a new setting later: add one entry to SETTINGS_ITEMS with a title,
// description, getValue(), and setValue(value) -- renderSettingsDialog picks
// it up automatically, no other wiring needed.
const SETTINGS_ITEMS = [
  {
    id: 'favicon-indicator',
    title: 'Favicon status spinner',
    desc: 'Show job state in the tab favicon: an animated amber spinner while a job runs, then green (done) or red (error). On by default -- turn this off to leave the tab icon alone.',
    getValue: () => faviconIndicatorEnabled,
    setValue: async (value) => {
      await setFaviconIndicatorEnabled(value);
    },
  },
  {
    id: 'favicon-displace',
    title: 'Favicon: displace competing icons (2c test)',
    desc: 'Actively remove other extensions/pages\' favicon links so ours wins. Diagnostic toggle for testing rung 2c.',
    getValue: () => fv2DisplaceEnabled,
    setValue: async (value) => {
      await setFaviconDisplaceEnabled(value);
    },
  },
  {
    id: 'piggyback-send-probe',
    title: 'Piggyback send probe (experimental)',
    desc: 'Fix 5a: on each Enter/send-button send, try to suppress claude.ai\'s native send and confirm it before resending your message. Diagnostic only -- never resends unless suppression is confirmed; a leaked native send is left exactly as-is.',
    getValue: () => piggybackProbeEnabled,
    setValue: async (value) => {
      await setPiggybackProbeEnabled(value);
    },
  },
  {
    id: 'concurrent-send-probe',
    title: 'Concurrent-send probe (experimental)',
    desc: 'Verifies whether this tab accepts a send while Claude is thinking/outputting. Observe mode logs the DOM signals (stop button, streaming cursor, aria-busy, reply length, queue indicator) every ~500ms while Claude replies. Attempt mode tries a real pending delivery early, tagged with a marker and confirmed within 6s -- falls back to the normal hold/timer path if unconfirmed, never drops the result.',
    getValue: () => concurrentSendProbeEnabled,
    setValue: async (value) => {
      await setConcurrentSendProbeEnabled(value);
    },
  },
  {
    id: 'stale-auto-heal',
    title: 'Auto-heal stale tabs after an update',
    desc: 'When CCSW is reloaded, automatically F5 any claude.ai tab still running the old build -- but ONLY tabs whose composer is empty and that are hidden, so typed text and the tab you are looking at are never disturbed. On by default: stale tabs are always surfaced (notification + task) with a one-tap "Reload empty tabs" button regardless of this setting; this just skips the tap. Turn off to require the manual tap.',
    getValue: () => staleAutoHealEnabled,
    setValue: async (value) => {
      await setStaleAutoHealEnabled(value);
    },
  },
  {
    id: 'auto-refire',
    title: 'Auto-re-fire dropped jobs when the repo frees',
    desc: 'When a job is dropped because its repo was busy, automatically re-fire it the moment that repo frees, instead of waiting for you to click "Re-fire" on the dropped pill. On by default. The automatic re-fire happens at most once per drop; if it ALSO fails (repo still busy), the dropped pill and its manual "Re-fire" button reappear exactly as before. Turn off to require the manual click for every dropped job -- the button stays either way.',
    getValue: () => autoRefireEnabled,
    setValue: async (value) => {
      await setAutoRefireEnabled(value);
    },
  },
  {
    id: 'self-heal-json',
    title: 'Self-heal malformed ccsw blocks',
    desc: 'When claude.ai emits a ccsw block whose JSON will not parse, quietly ask Claude to re-send it as valid JSON (quoting the parser error) instead of immediately showing the red error pill. On by default. Capped at 3 automatic re-send requests per broken block; only after that does the red pill appear, now summarising that it failed after those attempts. Turn off to go straight to the red pill with no feedback, exactly as before. The feedback message is plain text and never touches text you have typed in the composer.',
    getValue: () => selfHealJsonEnabled,
    setValue: async (value) => {
      await setSelfHealJsonEnabled(value);
    },
  },
];

let settingsDialogEl = null;
let settingsDialogBodyEl = null;
// The Settings dialog's open/close is now driven by a createDisclosure
// instance (see getSettingsDisclosure below), so there's no standalone
// open-boolean any more -- isOpen lives inside the disclosure. Instantiated
// lazily on first open rather than at module-eval time, because
// createDisclosure's ignoreWithin default reads SHARED_DISCLOSURE_SCOPE, a
// const declared much further down the file (would be in the TDZ if we built
// the instance up here). Mirrors advancedDisclosure (S2).
let settingsDisclosure = null;

// Same from-scratch mousedown/mousemove/mouseup drag as startActionDialogDrag
// above, just checking this dialog's own close-button class so a click on it
// doesn't also start a drag.
function startSettingsDialogDrag(evt, dialogEl) {
  if (evt.target.closest('.ccsw-settings-dialog-close')) return;
  evt.preventDefault();

  const rect = dialogEl.getBoundingClientRect();
  dialogEl.style.transform = 'none';
  dialogEl.style.right = 'auto';
  dialogEl.style.bottom = 'auto';
  dialogEl.style.left = `${rect.left}px`;
  dialogEl.style.top = `${rect.top}px`;

  const startX = evt.clientX;
  const startY = evt.clientY;
  const startLeft = rect.left;
  const startTop = rect.top;

  function onMouseMove(moveEvt) {
    dialogEl.style.left = `${startLeft + (moveEvt.clientX - startX)}px`;
    dialogEl.style.top = `${startTop + (moveEvt.clientY - startY)}px`;
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function ensureSettingsDialog() {
  if (settingsDialogEl) return settingsDialogEl;

  const dialogEl = document.createElement('div');
  dialogEl.id = 'ccsw-settings-dialog';
  dialogEl.className = 'ccsw-settings-dialog';
  dialogEl.hidden = true;

  const headerEl = document.createElement('div');
  headerEl.className = 'ccsw-settings-dialog-header';
  headerEl.addEventListener('mousedown', (evt) => startSettingsDialogDrag(evt, dialogEl));

  const titleEl = document.createElement('span');
  titleEl.className = 'ccsw-settings-dialog-title';
  titleEl.textContent = 'Settings';

  const closeEl = document.createElement('button');
  closeEl.type = 'button';
  closeEl.className = 'ccsw-settings-dialog-close';
  closeEl.setAttribute('aria-label', 'Close');
  closeEl.textContent = '×';
  closeEl.addEventListener('click', (evt) => {
    evt.stopPropagation();
    closeSettingsDialog();
  });

  headerEl.append(titleEl, closeEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'ccsw-settings-dialog-body';

  dialogEl.append(headerEl, bodyEl);
  // Reuses the exact same resize-handle machinery the feed panel and Action
  // List dialog use -- attachResizeHandles/startPanelResize operate on any
  // panelEl passed in and only special-case a `.ccsw-job-bar-iframe` child
  // (absent here, so that branch is just a no-op).
  attachResizeHandles(dialogEl);
  document.body.appendChild(dialogEl);

  settingsDialogEl = dialogEl;
  settingsDialogBodyEl = bodyEl;
  return settingsDialogEl;
}

function renderSettingsDialog() {
  if (!settingsDialogBodyEl) return;
  settingsDialogBodyEl.textContent = '';

  SETTINGS_ITEMS.forEach((item) => {
    const rowEl = document.createElement('label');
    rowEl.className = 'ccsw-settings-item';

    const textEl = document.createElement('span');
    textEl.className = 'ccsw-settings-item-text';

    const titleEl = document.createElement('span');
    titleEl.className = 'ccsw-settings-item-title';
    titleEl.textContent = item.title;

    const descEl = document.createElement('span');
    descEl.className = 'ccsw-settings-item-desc';
    descEl.textContent = item.desc;

    textEl.append(titleEl, descEl);

    const checkEl = document.createElement('input');
    checkEl.type = 'checkbox';
    checkEl.checked = !!item.getValue();
    checkEl.addEventListener('change', async () => {
      checkEl.disabled = true;
      try {
        await item.setValue(checkEl.checked);
      } finally {
        checkEl.disabled = false;
      }
    });

    rowEl.append(textEl, checkEl);
    settingsDialogBodyEl.appendChild(rowEl);
  });

  renderTokenSection(settingsDialogBodyEl);
}

// --- Relay token section (#76) ----------------------------------------
// A distinct block appended after the SETTINGS_ITEMS checkboxes above --
// lets the relay auth token (chrome.storage.local's 'ccswToken', the same
// key background.js's getCcswToken reads) be pasted/rotated and verified
// from this panel instead of the service-worker console. Saving just writes
// to storage: background.js's own onChanged listener re-registers the
// feed-token declarativeNetRequest rule and ccswFetch re-reads the cache on
// its next call, so no reload is needed.
const TOKEN_TOAST_OK_MS = 2500;
const TOKEN_TOAST_ERROR_MS = 6000;

function maskToken(token) {
  if (!token) return 'not set';
  return `••••••${token.slice(-4)}`;
}

function showTokenToast(text, ok) {
  const existing = document.getElementById('ccsw-token-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'ccsw-token-toast';
  toast.classList.add(ok ? 'ccsw-token-toast--ok' : 'ccsw-token-toast--error');
  toast.textContent = text;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), ok ? TOKEN_TOAST_OK_MS : TOKEN_TOAST_ERROR_MS);
}

function renderTokenSection(containerEl) {
  const sectionEl = document.createElement('div');
  sectionEl.className = 'ccsw-settings-token-section';

  const labelEl = document.createElement('div');
  labelEl.className = 'ccsw-settings-token-label';
  labelEl.textContent = 'Relay token';
  sectionEl.appendChild(labelEl);

  const currentEl = document.createElement('div');
  currentEl.className = 'ccsw-settings-token-current';
  currentEl.textContent = 'Current: ...';
  sectionEl.appendChild(currentEl);

  chrome.storage.local.get('ccswToken')
    .then(({ ccswToken }) => {
      currentEl.textContent = `Current: ${maskToken(ccswToken)}`;
    })
    .catch(() => {
      currentEl.textContent = 'Current: unknown (storage read failed)';
    });

  const inputRowEl = document.createElement('div');
  inputRowEl.className = 'ccsw-settings-token-row';

  const inputEl = document.createElement('input');
  inputEl.type = 'password';
  inputEl.className = 'ccsw-settings-token-input';
  inputEl.placeholder = 'Paste new token';
  inputEl.autocomplete = 'off';

  const saveEl = document.createElement('button');
  saveEl.type = 'button';
  saveEl.textContent = 'Save';
  saveEl.addEventListener('click', async () => {
    const value = inputEl.value.trim();
    saveEl.disabled = true;
    try {
      await chrome.storage.local.set({ ccswToken: value });
      inputEl.value = '';
      currentEl.textContent = `Current: ${maskToken(value)}`;
      showTokenToast('token saved', true);
      logEvent('button_click', { button: 'token-save', outcome: 'success' });
    } catch (err) {
      showTokenToast(`token save failed: ${err.message}`, false);
      logEvent('button_click', { button: 'token-save', outcome: 'error' });
    } finally {
      saveEl.disabled = false;
    }
  });

  inputRowEl.append(inputEl, saveEl);
  sectionEl.appendChild(inputRowEl);

  const testRowEl = document.createElement('div');
  testRowEl.className = 'ccsw-settings-token-row';

  const testEl = document.createElement('button');
  testEl.type = 'button';
  testEl.textContent = 'Test';

  const statusEl = document.createElement('span');
  statusEl.className = 'ccsw-settings-token-status';

  testEl.addEventListener('click', async () => {
    testEl.disabled = true;
    statusEl.textContent = 'testing...';
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ccsw-token-test' });
      let outcome;
      let text;
      if (!response?.ok) {
        outcome = 'unreachable';
        text = 'relay unreachable';
      } else if (response.status === 401) {
        outcome = 'rejected';
        text = 'token REJECTED - wrong/rotated';
      } else if (response.status === 200 || response.status === 400) {
        outcome = 'ok';
        text = 'token OK';
      } else {
        outcome = 'unexpected';
        text = `unexpected response (status ${response.status})`;
      }
      statusEl.textContent = text;
      showTokenToast(text, outcome === 'ok');
      logEvent('button_click', { button: 'token-test', outcome });
    } catch (err) {
      statusEl.textContent = 'relay unreachable';
      showTokenToast('relay unreachable', false);
      logEvent('button_click', { button: 'token-test', outcome: 'unreachable' });
    } finally {
      testEl.disabled = false;
    }
  });

  testRowEl.append(testEl, statusEl);
  sectionEl.appendChild(testRowEl);

  containerEl.appendChild(sectionEl);
}

// S3 migration onto the popover contract (issue #11), mirroring the Advanced
// dialog's getAdvancedDisclosure (S2). The show/hide itself is unchanged --
// toggling `hidden` on the draggable shell built by ensureSettingsDialog -- but
// open/close now route through a createDisclosure instance so the dialog gains
// the two behaviours the plan calls for:
//   - closeOnOutside: a genuine outside click closes it, decided by pointerdown
//     provenance (rule 2), so a header drag that releases outside the dialog no
//     longer false-closes via the browser's synthesized click.
//   - closeOnEscape: Escape closes it, but only when it's the topmost entry in
//     the module open-stack. With Advanced (S2) and Settings both on the stack
//     now, Advanced opened over Settings peels one level per keypress -- the
//     first Escape closes Advanced alone, a second closes Settings.
// The `el` factory is lazy (ensureSettingsDialog builds on first open and
// caches thereafter), matching the contract's el() option. renderSettingsDialog
// runs in onOpen (it also still runs on storage change while open, via the
// settingsDisclosure?.isOpen guard on the chrome.storage.onChanged listener).
// closeOnHide/closeWhenDetached stay at their defaults (off), same as Advanced:
// a user-dismissed panel, not one tied to tab visibility or detachment.
function getSettingsDisclosure() {
  if (settingsDisclosure) return settingsDisclosure;
  settingsDisclosure = createDisclosure({
    el: () => ensureSettingsDialog(),
    closeOnOutside: true,
    closeOnEscape: true,
    onOpen: (dialogEl) => {
      dialogEl.hidden = false;
      renderSettingsDialog();
    },
    onClose: (dialogEl) => {
      if (dialogEl) dialogEl.hidden = true;
    },
  });
  return settingsDisclosure;
}

function closeSettingsDialog() {
  getSettingsDisclosure().close();
}

function toggleSettingsDialog() {
  getSettingsDisclosure().toggle();
}

// --- Advanced dialog --------------------------------------------------
// Manual-recovery actions for the hand-fixes this project has repeatedly
// needed to do via curl/CC commands: releasing a stuck repo lock,
// force-closing a job that will never post its own result, restarting the
// agent, and wiping ghost-pill history. Mirrors board/index.php's Manual
// Controls admin panel, but reachable from the extension itself (SW menu's
// "Advanced..." row) instead of needing the board tab open. Same
// draggable/resizable dialog shell as the Settings dialog above; duplicated
// rather than shared for the same reason (unrelated bodies, no shared
// state).
//
// content.js can't fetch dabblelabs.uk directly (CORS wall, see
// registerHeaderRule's comment in background.js), so every action here
// round-trips through a chrome.runtime.sendMessage to background.js, which
// does the actual relay fetch.

let advancedDialogEl = null;
// The Advanced dialog's open/close is now driven by a createDisclosure
// instance (see getAdvancedDisclosure below), so there's no standalone
// open-boolean any more -- isOpen lives inside the disclosure. Instantiated
// lazily on first open rather than at module-eval time, because
// createDisclosure's ignoreWithin default reads SHARED_DISCLOSURE_SCOPE, a
// const declared much further down the file (would be in the TDZ if we built
// the instance up here).
let advancedDisclosure = null;
let advancedLocksListEl = null;
let advancedWaitersListEl = null;
let advancedWakesListEl = null;
let advancedStatusEl = null;
let advancedJobsListEl = null;
let advancedLocksTimer = null;

const ADVANCED_LOCKS_POLL_INTERVAL_MS = 3000;

function setAdvancedStatus(message, isError) {
  if (!advancedStatusEl) return;
  advancedStatusEl.textContent = message;
  advancedStatusEl.classList.toggle('ccsw-advanced-status--error', !!isError);
  advancedStatusEl.classList.toggle('ccsw-advanced-status--ok', !isError);
}

// Same clear the SW menu's former "Clear ghost pills" row used to trigger --
// wipes the persisted job history outright (same effect as
// chrome.storage.local.remove done by hand from devtools), for whatever
// reapSilentPills' automatic Ghost Reaper sweep doesn't catch.
async function clearGhostPills() {
  try {
    await chrome.storage.local.remove(SW_MENU_STORAGE_KEY);
  } catch (err) {
    console.warn('[CCswitchboard] Advanced dialog: failed to clear ccswThreadJobs:', err.message);
    handlePossibleContextInvalidation(err);
    setAdvancedStatus(`Clear ghost pills failed: ${err.message}`, true);
    return;
  }
  sessionJobs.length = 0;
  hydratedThread = null;
  renderSwMenuPanel();
  setAdvancedStatus('Ghost pills cleared.', false);
}

function renderAdvancedLocks(locks, waiters, wakes) {
  if (advancedLocksListEl) {
    advancedLocksListEl.textContent = '';
    if (locks.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'ccsw-advanced-empty';
      emptyEl.textContent = '(none held)';
      advancedLocksListEl.appendChild(emptyEl);
    } else {
      locks.forEach((lock) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'ccsw-advanced-lock-row';

        const infoEl = document.createElement('span');
        infoEl.className = 'ccsw-advanced-lock-info';
        const repoEl = document.createElement('span');
        repoEl.className = 'ccsw-advanced-lock-repo';
        repoEl.textContent = lock.repo;
        const threadEl = document.createElement('span');
        threadEl.className = 'ccsw-advanced-lock-thread';
        threadEl.textContent = `thread: ${lock.thread || '(none)'} -- job #${lock.job_id}`;
        infoEl.append(repoEl, threadEl);

        const releaseEl = document.createElement('button');
        releaseEl.type = 'button';
        releaseEl.className = 'ccsw-advanced-btn ccsw-advanced-btn--danger ccsw-advanced-btn--small';
        releaseEl.textContent = 'Release';
        releaseEl.addEventListener('click', () => releaseAdvancedLock(lock.repo));

        rowEl.append(infoEl, releaseEl);
        advancedLocksListEl.appendChild(rowEl);
      });
    }
  }

  if (advancedWaitersListEl) {
    advancedWaitersListEl.textContent = waiters.length === 0 ? '(none)' : JSON.stringify(waiters, null, 1);
  }
  if (advancedWakesListEl) {
    advancedWakesListEl.textContent = wakes.length === 0 ? '(none)' : JSON.stringify(wakes, null, 1);
  }
}

async function refreshAdvancedLocks() {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'ccsw-advanced-locks-get' });
  } catch (err) {
    handlePossibleContextInvalidation(err);
    return;
  }
  if (!response?.ok) {
    if (advancedLocksListEl) advancedLocksListEl.textContent = 'Failed to load.';
    return;
  }
  renderAdvancedLocks(response.locks || [], response.waiters || [], response.wakes || []);
}

async function releaseAdvancedLock(repo) {
  if (!confirm(`Clear the lock on "${repo}"? Only do this if you're sure the job holding it is dead.`)) return;

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'ccsw-advanced-clear-lock', repo });
  } catch (err) {
    handlePossibleContextInvalidation(err);
    setAdvancedStatus(`Clear lock failed: ${err.message}`, true);
    return;
  }
  if (!response?.ok) {
    setAdvancedStatus(`Clear lock failed: ${response?.error || response?.status || 'unknown error'}`, true);
    return;
  }
  setAdvancedStatus(`Lock on "${repo}" cleared.`, false);
  refreshAdvancedLocks();
}

async function clearAllAdvancedLocks() {
  if (!confirm('Clear ALL repo locks? Only do this if you\'re sure every job holding one is dead.')) return;

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'ccsw-advanced-clear-locks' });
  } catch (err) {
    handlePossibleContextInvalidation(err);
    setAdvancedStatus(`Clear all locks failed: ${err.message}`, true);
    return;
  }
  if (!response?.ok) {
    setAdvancedStatus(`Clear all locks failed: ${response?.error || response?.status || 'unknown error'}`, true);
    return;
  }
  setAdvancedStatus(`Cleared ${response.cleared} lock(s).`, false);
  refreshAdvancedLocks();
}

// Renders the live "running/recent" job list the Force-close section shows
// instead of a bare job-id input -- each row gets its own Force-close button
// (done jobs don't, force-closing an already-done job is a no-op that would
// just be confusing to offer) so there's nothing to look up and copy in by
// hand anymore.
function renderAdvancedJobs(jobs) {
  if (!advancedJobsListEl) return;
  advancedJobsListEl.textContent = '';

  if (jobs.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'ccsw-advanced-empty';
    emptyEl.textContent = '(no jobs)';
    advancedJobsListEl.appendChild(emptyEl);
    return;
  }

  // jobs.php's status=all listing comes back oldest-first (see its final
  // ORDER BY id ASC) -- reverse so the newest (most likely to need
  // force-closing) job is on top, same convention board/index.php uses.
  [...jobs].reverse().forEach((job) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'ccsw-advanced-job-row';

    const infoEl = document.createElement('span');
    infoEl.className = 'ccsw-advanced-job-info';
    const idEl = document.createElement('span');
    idEl.className = 'ccsw-advanced-job-id';
    idEl.textContent = `#${job.id}`;
    const statusEl = document.createElement('span');
    statusEl.className = `ccsw-advanced-job-status ccsw-advanced-job-status--${job.status}`;
    statusEl.textContent = job.status;
    const summaryEl = document.createElement('span');
    summaryEl.className = 'ccsw-advanced-job-summary';
    summaryEl.textContent = job.name || job.summary || job.thread || '';
    infoEl.append(idEl, statusEl, summaryEl);
    rowEl.appendChild(infoEl);

    if (job.status !== 'done') {
      const btnEl = document.createElement('button');
      btnEl.type = 'button';
      btnEl.className = 'ccsw-advanced-btn ccsw-advanced-btn--danger ccsw-advanced-btn--small';
      btnEl.textContent = 'Force close';
      btnEl.addEventListener('click', () => forceCloseAdvancedJob(job.id));
      rowEl.appendChild(btnEl);
    }

    advancedJobsListEl.appendChild(rowEl);
  });
}

async function refreshAdvancedJobs() {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'ccsw-advanced-jobs-get' });
  } catch (err) {
    handlePossibleContextInvalidation(err);
    return;
  }
  if (!response?.ok) {
    if (advancedJobsListEl) advancedJobsListEl.textContent = 'Failed to load.';
    return;
  }
  renderAdvancedJobs(response.jobs || []);
}

async function forceCloseAdvancedJob(id) {
  if (!id || id <= 0) return;
  if (!confirm(`Force-close job ${id}? This marks it done with result "FORCE-CLOSED" and releases any lock it holds.`)) return;

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'ccsw-advanced-force-close', id });
  } catch (err) {
    handlePossibleContextInvalidation(err);
    setAdvancedStatus(`Force-close failed: ${err.message}`, true);
    return;
  }
  if (!response?.ok) {
    setAdvancedStatus(`Force-close failed: ${response?.error || response?.status || 'unknown error'}`, true);
    return;
  }
  setAdvancedStatus(`Job ${id} force-closed.`, false);
  refreshAdvancedLocks();
  refreshAdvancedJobs();
}

async function restartAdvancedAgent() {
  if (!confirm('Restart CcswAgent now? Any job currently running on it will be killed.')) return;

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'ccsw-advanced-restart-agent' });
  } catch (err) {
    handlePossibleContextInvalidation(err);
    setAdvancedStatus(`Restart failed: ${err.message}`, true);
    return;
  }
  if (!response?.ok) {
    setAdvancedStatus(`Restart failed: ${response?.error || response?.status || 'unknown error'}`, true);
    return;
  }
  setAdvancedStatus(`Restart queued as job ${response.id}.`, false);
}

// How many events the Advanced panel's button pulls back. Deliberately the
// same default the {"debuglog": true} block uses -- one number to reason about.
const DEBUGLOG_PANEL_LIMIT = 150;

// background.js does the fetching and the typing (see its
// ccsw-debuglog-deliver handler): this content script can neither reach the
// relay (CORS) nor drive the send state machine itself.
async function sendDebugLogToChat() {
  setAdvancedStatus('Fetching debug log...', false);

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: 'ccsw-debuglog-deliver',
      thread: hydratedThread || null,
      limit: DEBUGLOG_PANEL_LIMIT,
    });
  } catch (err) {
    handlePossibleContextInvalidation(err);
    setAdvancedStatus(`Debug log failed: ${err.message}`, true);
    return;
  }
  if (!response?.ok) {
    setAdvancedStatus(`Debug log failed: ${response?.error || 'unknown error'}`, true);
    return;
  }
  setAdvancedStatus(`Queued ${response.count} debug event(s) for this chat.`, false);
}

// Same from-scratch mousedown/mousemove/mouseup drag as startSettingsDialogDrag
// above, just checking this dialog's own close-button class so a click on it
// doesn't also start a drag.
function startAdvancedDialogDrag(evt, dialogEl) {
  if (evt.target.closest('.ccsw-advanced-dialog-close')) return;
  evt.preventDefault();

  const rect = dialogEl.getBoundingClientRect();
  dialogEl.style.transform = 'none';
  dialogEl.style.right = 'auto';
  dialogEl.style.bottom = 'auto';
  dialogEl.style.left = `${rect.left}px`;
  dialogEl.style.top = `${rect.top}px`;

  const startX = evt.clientX;
  const startY = evt.clientY;
  const startLeft = rect.left;
  const startTop = rect.top;

  function onMouseMove(moveEvt) {
    dialogEl.style.left = `${startLeft + (moveEvt.clientX - startX)}px`;
    dialogEl.style.top = `${startTop + (moveEvt.clientY - startY)}px`;
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

function buildAdvancedSection(titleText) {
  const sectionEl = document.createElement('div');
  sectionEl.className = 'ccsw-advanced-section';

  const titleEl = document.createElement('div');
  titleEl.className = 'ccsw-advanced-section-title';
  titleEl.textContent = titleText;
  sectionEl.appendChild(titleEl);

  return sectionEl;
}

function ensureAdvancedDialog() {
  if (advancedDialogEl) return advancedDialogEl;

  const dialogEl = document.createElement('div');
  dialogEl.id = 'ccsw-advanced-dialog';
  dialogEl.className = 'ccsw-advanced-dialog';
  dialogEl.hidden = true;

  const headerEl = document.createElement('div');
  headerEl.className = 'ccsw-advanced-dialog-header';
  headerEl.addEventListener('mousedown', (evt) => startAdvancedDialogDrag(evt, dialogEl));

  const titleEl = document.createElement('span');
  titleEl.className = 'ccsw-advanced-dialog-title';
  titleEl.textContent = 'Advanced';

  const closeEl = document.createElement('button');
  closeEl.type = 'button';
  closeEl.className = 'ccsw-advanced-dialog-close';
  closeEl.setAttribute('aria-label', 'Close');
  closeEl.textContent = '×';
  closeEl.addEventListener('click', (evt) => {
    evt.stopPropagation();
    closeAdvancedDialog();
  });

  headerEl.append(titleEl, closeEl);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'ccsw-advanced-dialog-body';

  const statusEl = document.createElement('div');
  statusEl.className = 'ccsw-advanced-status';
  advancedStatusEl = statusEl;
  bodyEl.appendChild(statusEl);

  // Locks section: live list fetched from debug_locks.php (refreshed below
  // while the dialog is open), each row with its own Release button, plus a
  // wholesale "Clear all locks" escape hatch.
  const locksSection = buildAdvancedSection('Locks');
  const locksListEl = document.createElement('div');
  locksListEl.className = 'ccsw-advanced-lock-list';
  advancedLocksListEl = locksListEl;
  locksSection.appendChild(locksListEl);

  const locksRowEl = document.createElement('div');
  locksRowEl.className = 'ccsw-advanced-row';
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'ccsw-advanced-btn';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.addEventListener('click', () => refreshAdvancedLocks());
  const clearAllBtn = document.createElement('button');
  clearAllBtn.type = 'button';
  clearAllBtn.className = 'ccsw-advanced-btn ccsw-advanced-btn--danger';
  clearAllBtn.textContent = 'Clear all locks';
  clearAllBtn.addEventListener('click', () => clearAllAdvancedLocks());
  locksRowEl.append(refreshBtn, clearAllBtn);
  locksSection.appendChild(locksRowEl);
  bodyEl.appendChild(locksSection);

  // Live state: raw waiters/wakes rows from the same debug_locks.php poll --
  // read-only, for spotting a wake that went missing without relaying SQLite
  // rows by hand.
  const stateSection = buildAdvancedSection('Live state (waiters / wakes)');
  const waitersLabelEl = document.createElement('div');
  waitersLabelEl.className = 'ccsw-advanced-section-note';
  waitersLabelEl.textContent = 'Waiters:';
  const waitersListEl = document.createElement('div');
  waitersListEl.className = 'ccsw-advanced-mono';
  advancedWaitersListEl = waitersListEl;
  const wakesLabelEl = document.createElement('div');
  wakesLabelEl.className = 'ccsw-advanced-section-note';
  wakesLabelEl.textContent = 'Wakes:';
  const wakesListEl = document.createElement('div');
  wakesListEl.className = 'ccsw-advanced-mono';
  advancedWakesListEl = wakesListEl;
  stateSection.append(waitersLabelEl, waitersListEl, wakesLabelEl, wakesListEl);
  bodyEl.appendChild(stateSection);

  // Ghost pills: same wipe the SW menu's row used to trigger.
  const ghostSection = buildAdvancedSection('Ghost pills');
  const ghostExplainerEl = document.createElement('div');
  ghostExplainerEl.className = 'ccsw-advanced-explainer';
  ghostExplainerEl.textContent = "For dummies: a \"ghost pill\" is a job pill that spins forever and never settles into done/error, even though the job actually finished (or was force-closed) on the server long ago. It happens when this tab's local job-pill history (chrome.storage.local) falls out of sync with the real job state -- usually after a reload restores an old job the server has already moved on from. You'll recognise one because it just keeps spinning no matter how long you wait, and reloading the page doesn't clear it. Press \"Clear ghost pills\" below when you spot one -- it wipes this tab's local job history so the next poll rebuilds it fresh from the server.";
  const ghostNoteEl = document.createElement('div');
  ghostNoteEl.className = 'ccsw-advanced-section-note';
  ghostNoteEl.textContent = "Wipes this tab's local job-pill history (chrome.storage.local). Client-side only.";
  const ghostBtn = document.createElement('button');
  ghostBtn.type = 'button';
  ghostBtn.className = 'ccsw-advanced-btn';
  ghostBtn.textContent = 'Clear ghost pills';
  ghostBtn.addEventListener('click', () => clearGhostPills());
  ghostSection.append(ghostExplainerEl, ghostNoteEl, ghostBtn);
  bodyEl.appendChild(ghostSection);

  // Force-close: for a job that will never post its own result.php call
  // (crashed agent, hand-killed process) -- live list fetched from jobs.php
  // (mirrors the Locks section above), each row with its own Force-close
  // button, so there's no job id to look up and copy in by hand anymore.
  const forceCloseSection = buildAdvancedSection('Force-close job');
  const forceCloseExplainerEl = document.createElement('div');
  forceCloseExplainerEl.className = 'ccsw-advanced-explainer';
  forceCloseExplainerEl.textContent = "For dummies: force-close a job when it's wedged -- stuck running/pending forever because the agent crashed, was killed, or the machine restarted mid-job, and the board shows nothing is actually running anymore. It marks the job \"done\" with result FORCE-CLOSED and releases any repo lock it was holding, so new jobs on that repo/thread can proceed. Don't use it on a job that might still be legitimately working.";
  const forceCloseListEl = document.createElement('div');
  forceCloseListEl.className = 'ccsw-advanced-job-list';
  advancedJobsListEl = forceCloseListEl;
  const forceCloseRowEl = document.createElement('div');
  forceCloseRowEl.className = 'ccsw-advanced-row';
  const jobsRefreshBtn = document.createElement('button');
  jobsRefreshBtn.type = 'button';
  jobsRefreshBtn.className = 'ccsw-advanced-btn';
  jobsRefreshBtn.textContent = 'Refresh';
  jobsRefreshBtn.addEventListener('click', () => refreshAdvancedJobs());
  forceCloseRowEl.appendChild(jobsRefreshBtn);
  forceCloseSection.append(forceCloseExplainerEl, forceCloseListEl, forceCloseRowEl);
  bodyEl.appendChild(forceCloseSection);

  // Restart agent: dispatches the same detached restart-agent.ps1 spawn
  // board/index.php's admin panel does, as a readonly bash job (so it
  // doesn't take the ccswitchboard repo's own lock).
  const restartSection = buildAdvancedSection('Agent');
  const restartBtn = document.createElement('button');
  restartBtn.type = 'button';
  restartBtn.className = 'ccsw-advanced-btn ccsw-advanced-btn--danger';
  restartBtn.textContent = 'Restart agent';
  restartBtn.addEventListener('click', () => restartAdvancedAgent());
  restartSection.appendChild(restartBtn);
  bodyEl.appendChild(restartSection);

  // Debug log: types the last DEBUGLOG_PANEL_LIMIT events from every tab into
  // THIS thread, so Claude can read what the extension did rather than being
  // told about it. Same delivery path Claude's own {"debuglog": true} block
  // uses -- this button is just the human-driven trigger for it.
  const debugLogSection = buildAdvancedSection('Debug log');
  const debugLogExplainerEl = document.createElement('div');
  debugLogExplainerEl.className = 'ccsw-advanced-explainer';
  debugLogExplainerEl.textContent = "For dummies: this pastes the extension's recent internal events (from ALL your Claude tabs, not just this one) into the chat, so Claude can read what actually happened instead of you describing it. Useful when a pill misbehaves. Safe to press any time -- it only reads.";
  const debugLogBtn = document.createElement('button');
  debugLogBtn.type = 'button';
  debugLogBtn.className = 'ccsw-advanced-btn';
  debugLogBtn.textContent = 'Send debug log to chat';
  debugLogBtn.addEventListener('click', () => sendDebugLogToChat());
  debugLogSection.append(debugLogExplainerEl, debugLogBtn);
  bodyEl.appendChild(debugLogSection);

  dialogEl.append(headerEl, bodyEl);
  // Reuses the exact same resize-handle machinery the other dialogs use --
  // attachResizeHandles/startPanelResize operate on any panelEl passed in.
  attachResizeHandles(dialogEl);
  document.body.appendChild(dialogEl);

  advancedDialogEl = dialogEl;
  return advancedDialogEl;
}

// First migration onto the popover contract (S2, issue #11). The show/hide
// itself is unchanged -- toggling `hidden` on the draggable shell built by
// ensureAdvancedDialog -- but open/close now route through a createDisclosure
// instance so the dialog gains the two behaviours the plan calls for:
//   - closeOnOutside: a genuine outside click closes it, decided by
//     pointerdown provenance (rule 2), so a header drag that releases outside
//     the dialog no longer false-closes via the browser's synthesized click.
//   - closeOnEscape: Escape closes it, but only when it's the topmost entry in
//     the module open-stack. When Advanced is stacked over Settings, one
//     Escape peels off Advanced alone; Settings (not yet migrated) is
//     untouched. Once Settings joins the stack in a later stage this becomes a
//     proper one-level-per-keypress peel with no code change here.
// The `el` factory is lazy (ensureAdvancedDialog builds on first open and
// caches thereafter), matching the contract's el() option for dialogs built
// on demand. closeOnHide/closeWhenDetached stay at their defaults (off): the
// dialog's poll timer is torn down in onClose, and it's a user-dismissed
// panel, not one tied to tab visibility or detachment.
function getAdvancedDisclosure() {
  if (advancedDisclosure) return advancedDisclosure;
  advancedDisclosure = createDisclosure({
    el: () => ensureAdvancedDialog(),
    closeOnOutside: true,
    closeOnEscape: true,
    onOpen: (dialogEl) => {
      dialogEl.hidden = false;
      setAdvancedStatus('', false);
      refreshAdvancedLocks();
      refreshAdvancedJobs();
      // Only poll debug_locks.php/jobs.php while the dialog is actually open
      // -- same reasoning as board/index.php's admin panel toggle listener.
      advancedLocksTimer = setInterval(() => {
        refreshAdvancedLocks();
        refreshAdvancedJobs();
      }, ADVANCED_LOCKS_POLL_INTERVAL_MS);
    },
    onClose: (dialogEl) => {
      if (dialogEl) dialogEl.hidden = true;
      clearInterval(advancedLocksTimer);
      advancedLocksTimer = null;
    },
  });
  return advancedDisclosure;
}

function closeAdvancedDialog() {
  getAdvancedDisclosure().close();
}

function toggleAdvancedDialog() {
  getAdvancedDisclosure().toggle();
}

// --- agent-offline banner ----------------------------------------------
// background.js's refreshAgentOfflineState() polls jobs.php's `agentOffline`
// field (mirrors the board's own offline banner and the Pushover alert --
// see isAgentOffline()/checkAgentOfflineAlert() in board/db.php) and
// broadcasts it here to every open claude.ai tab. Unlike the zombie
// disconnected-banner above, this condition is expected to resolve on its
// own (the agent reconnecting), so it's dismissable -- dismissing just hides
// it until the NEXT offline transition, it doesn't suppress the underlying
// polling or the board/Pushover alerts.
let agentOfflineBannerDismissed = false;
let agentOfflineBannerEl = null;

function showAgentOfflineBanner() {
  if (agentOfflineBannerEl) return; // already shown

  agentOfflineBannerEl = document.createElement('div');
  agentOfflineBannerEl.id = 'ccsw-agent-offline-banner';

  const text = document.createElement('span');
  text.textContent = 'CCswitchboard agent offline -- jobs will queue until it reconnects';
  agentOfflineBannerEl.appendChild(text);

  const dismiss = document.createElement('button');
  dismiss.id = 'ccsw-agent-offline-dismiss';
  dismiss.type = 'button';
  dismiss.textContent = '×';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.addEventListener('click', () => {
    agentOfflineBannerDismissed = true;
    hideAgentOfflineBanner();
  });
  agentOfflineBannerEl.appendChild(dismiss);

  document.body.appendChild(agentOfflineBannerEl);
}

function hideAgentOfflineBanner() {
  if (!agentOfflineBannerEl) return;
  agentOfflineBannerEl.remove();
  agentOfflineBannerEl = null;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-agent-offline') return false; // not for us

  if (message.offline) {
    if (!agentOfflineBannerDismissed) showAgentOfflineBanner();
  } else {
    // Back online -- clear the dismissal too, so the next real outage shows
    // the banner again instead of staying silently suppressed forever.
    agentOfflineBannerDismissed = false;
    hideAgentOfflineBanner();
  }

  return false; // no response needed
});

// How many in-thread pills stay visible at once. Older ones beyond this are
// hidden (never destroyed -- see applyToolbarCap below), which is what keeps
// a long-running thread's pill stack from overflowing up past the top of the
// window. Distinct from MAX_JOBS_PER_THREAD (30), which caps the SW menu's
// full history, not what's visibly stacked as pills.
const TOOLBAR_VISIBLE_CAP = 4;

// Recency order of job ids currently tracked in activeToolbarJobs, oldest
// first. Drives which pills applyToolbarCap() hides -- separate from
// activeToolbarJobs's Map insertion order since reopening a job (see
// reopenSessionJob) needs to bump it back to "most recent" without removing
// and re-adding its Map entry.
let pillOrder = [];

// Hides every pill beyond the newest TOOLBAR_VISIBLE_CAP in pillOrder via a
// CSS class (display: none), rather than removing them from the DOM/Map --
// so a hidden pill's state (status, expanded panel) survives and reopening
// it from the SW menu just un-hides it. Called after any change to pillOrder
// or activeToolbarJobs so visibility always reflects current recency.
function applyToolbarCap() {
  const hiddenIds = new Set(pillOrder.slice(0, Math.max(0, pillOrder.length - TOOLBAR_VISIBLE_CAP)));
  activeToolbarJobs.forEach((entry, jobId) => {
    const isHidden = hiddenIds.has(jobId);
    entry.barEl.classList.toggle('ccsw-job-bar--capped', isHidden);
    // A pill going display:none out from under a resting pointer fires no
    // mouseleave -- see hideHovercardIfOwnedBy's comment -- so if this pill
    // owns the open card, force it closed here instead of leaving it stuck.
    if (isHidden) hideHovercardIfOwnedBy(jobId, entry.headerEl);
  });
}

// Marks a job as most-recently-active for capping purposes (new dispatch or
// reopen-from-menu both count) and re-applies the cap. No permanent immunity
// -- a reopened job can re-retire behind the cap once enough newer jobs push
// it back out of the newest TOOLBAR_VISIBLE_CAP.
function bumpPillRecency(jobId) {
  pillOrder = pillOrder.filter((id) => id !== jobId);
  pillOrder.push(jobId);
  applyToolbarCap();
}

function removeJobBar(jobId) {
  const entry = activeToolbarJobs.get(jobId);
  if (!entry) return;
  // logEvent reads entry fields, so it must run BEFORE dispose drops the entry.
  logEvent('pill_remove', { jobId, pillThread: entry.thread ?? null, status: entry.status ?? null });
  // #12b S2: single disposer (was hideHovercardIfOwnedBy + barEl.remove() +
  // activeToolbarJobs.delete + the pillOrder purge). dispose's step-5 does the
  // SAME pillOrder purge WITHOUT applyToolbarCap, preserving the load-bearing
  // shrink-don't-backfill semantic documented below verbatim -- recomputing
  // the cap off the now-shorter pillOrder would un-hide the newest
  // previously-capped pill to backfill the slot this close freed, pinning the
  // visible count at TOOLBAR_VISIBLE_CAP instead of shrinking by one. An
  // explicit user close only ever removes a pill; visible count grows again
  // only via bumpPillRecency (new dispatch or SW-menu reopen). dispose also
  // clears the job entry's own *Timer fields (e.g. deliveredFlashTimer), which
  // the old inline teardown left to fire harmlessly against the detached node.
  pillRegistry.dispose(jobId);
}

// --- job info hovercard ------------------------------------------------
// The job bar header used to surface the summary via a native title=""
// tooltip, which can't hold a clickable link -- so hovering it now shows
// this popup instead (mirrors index.php's #pill-hovercard), with its own
// "more info" link that expands in place to the job's model + full prompt.
// One shared element reused across every bar; jobHovercardJobId tracks
// which job it's currently showing.
//
// Show/hide is deliberately symmetric and relatedTarget-independent: a
// mouseenter on EITHER the header or the card cancels any pending hide
// (see cancelHideJobHovercard), and a mouseleave from EITHER schedules one
// after a grace delay (see scheduleHideJobHovercard). Nothing inspects
// evt.relatedTarget to guess where the pointer went -- an earlier version
// did, and that guess could come back wrong (or null) when the pointer
// crossed a gap between the two elements, which either closed the card
// while the pointer was still resting on the header (vanishes too fast)
// or left it with no cancel path at all (stuck open). Since entering
// *either* tracked element always cancels the *same* shared timer, the
// pointer only has to land on one of them before the grace delay elapses;
// which one it lands on doesn't matter.
//
// As a last-resort backstop -- covering the pointer leaving the window
// entirely, or any other case where a mouseleave just never fires -- an
// explicit outside click (see the capture-phase mousedown listener in
// ensureJobHovercard) always force-closes the card immediately. That way
// "stuck open" can never survive more than one click anywhere on the page.
let jobHovercardEl = null;
let jobHovercardJobId = null;
let jobHovercardHideTimer = null;
let jobHovercardExpanded = false;
let jobHovercardHeaderEl = null;
// Absolute cap on how long the card can stay open from the moment it's
// shown (see openJobHovercard), independent of mouseenter/mouseleave state
// entirely. Normal hide paths (mouseleave, outside mousedown) always fire
// well before this -- it only exists as a failsafe for the case those paths
// rely on being unable to fire at all, e.g. the owning pill's header being
// removed/hidden out from under a resting pointer with no mouseleave (see
// hideHovercardIfOwnedBy below, which covers the known trigger of that but
// can't cover every future one). 20s is far longer than anyone reads a
// hovercard, so this never fires during legitimate use.
const HOVERCARD_MAX_LIFETIME_MS = 20000;
let jobHovercardMaxLifetimeTimer = null;
// Set once the user drags one of the card's own resize handles (see
// ensureJobHovercard) -- while true, positionJobHovercard leaves the card's
// manually-chosen size alone instead of re-clamping it back down. Reset on
// every hide, mirroring the terminal/feed panel's own "nothing persisted
// across a collapse" convention (see attachResizeHandles' block comment).
let jobHovercardManuallySized = false;
// The actual summary/detail markup lives inside this wrapper rather than
// directly in jobHovercardEl -- renderJobHovercardContent clears it via
// textContent on every render, which would otherwise also wipe out the
// resize handles attachResizeHandles appends straight to jobHovercardEl.
let jobHovercardContentEl = null;
// Dropped pills have no job id to key a hovercard-open/closed check off of
// (see showJobHovercard's jobId param) -- each one mints its own throwaway
// key from this counter instead, just so jobHovercardJobId's != check can
// tell "still the same card" from "switched to a different pill".
let dropHovercardKeyCounter = 0;

function ensureJobHovercard() {
  if (jobHovercardEl) return jobHovercardEl;
  jobHovercardEl = document.createElement('div');
  jobHovercardEl.id = 'ccsw-job-hovercard';
  jobHovercardEl.hidden = true;
  jobHovercardContentEl = document.createElement('div');
  jobHovercardContentEl.className = 'ccsw-job-hovercard-content';
  jobHovercardEl.appendChild(jobHovercardContentEl);
  document.body.appendChild(jobHovercardEl);
  jobHovercardEl.addEventListener('mouseenter', cancelHideJobHovercard);
  jobHovercardEl.addEventListener('mouseleave', scheduleHideJobHovercard);
  // Resizable like the terminal/feed panels -- lets the card grow past its
  // auto-computed max-height/width when there's more on-screen room than
  // the automatic clamp assumed.
  attachResizeHandles(jobHovercardEl);
  jobHovercardEl.querySelectorAll('.ccsw-resize-handle').forEach((handle) => {
    handle.addEventListener('mousedown', () => { jobHovercardManuallySized = true; });
  });
  // Guaranteed dismiss path, independent of hover state entirely: a click
  // anywhere that isn't the card itself or the header it's anchored to
  // force-closes it right away. Capture phase so it runs ahead of (and
  // regardless of) whatever the click landed on, including targets that
  // stop propagation on the bubble phase (e.g. the close button).
  document.addEventListener('mousedown', (evt) => {
    if (jobHovercardEl.hidden) return;
    if (jobHovercardEl.contains(evt.target)) return;
    if (jobHovercardHeaderEl && jobHovercardHeaderEl.contains(evt.target)) return;
    hideJobHovercardNow();
  }, true);
  return jobHovercardEl;
}

function cancelHideJobHovercard() {
  clearTimeout(jobHovercardHideTimer);
  jobHovercardHideTimer = null;
}

function hideJobHovercardNow() {
  clearTimeout(jobHovercardHideTimer);
  jobHovercardHideTimer = null;
  clearTimeout(jobHovercardMaxLifetimeTimer);
  jobHovercardMaxLifetimeTimer = null;
  if (jobHovercardEl) {
    jobHovercardEl.hidden = true;
    jobHovercardEl.style.width = '';
    jobHovercardEl.style.height = '';
  }
  jobHovercardJobId = null;
  jobHovercardManuallySized = false;
}

// Force-closes the hovercard if (and only if) it's currently showing the
// given pill -- called from every path that hides or removes a pill out
// from under a possibly-resting pointer (applyToolbarCap, removeJobBar, and
// the dropped/held pills' own close/dispatch handlers), none of which fire
// a mouseleave on the pill's header since the header itself is what's
// disappearing. Without this, scheduleHideJobHovercard/cancelHideJobHovercard
// never run at all and the card is stuck open until the outside-mousedown
// backstop clears it. Matches on either the tracked job id or the tracked
// header element -- most callers have the id handy, but this also covers a
// header getting swapped/replaced out from under an open card even when the
// id itself hasn't changed.
function hideHovercardIfOwnedBy(jobId, headerEl) {
  if (!jobHovercardEl || jobHovercardEl.hidden) return;
  if (jobHovercardJobId === jobId || (headerEl && jobHovercardHeaderEl === headerEl)) {
    hideJobHovercardNow();
  }
}

// Grace period before an actual hide happens -- long enough to bridge a
// pointer crossing from the header to the card (or back), short enough
// that leaving both for good still closes the card promptly. See the
// block comment above jobHovercardEl for why this doesn't need to know
// *where* the pointer went to be correct.
function scheduleHideJobHovercard() {
  clearTimeout(jobHovercardHideTimer);
  jobHovercardHideTimer = setTimeout(hideJobHovercardNow, 400);
}

// Small helper shared by the normal-job and stashed-block detail renderers
// below (renderJobHovercardMoreInfo/renderStashedBlockDetail) -- both build
// the same "<label>: <value>" .detail-line/.detail-label shape repeatedly.
function appendDetailLine(container, label, value) {
  const line = document.createElement('div');
  line.className = 'detail-line';
  const labelEl = document.createElement('span');
  labelEl.className = 'detail-label';
  labelEl.textContent = label + ':';
  line.append(labelEl, document.createTextNode(' ' + value));
  container.appendChild(line);
}

// Built via createElement/textContent rather than innerHTML -- summary/
// model/prompt are arbitrary job payload text, so this avoids ever having
// to hand-escape them for HTML.
function renderJobHovercardContent(entry) {
  const card = jobHovercardContentEl;
  card.textContent = '';

  // Dropped pills (see showDroppedJobBar) never became a real job -- no
  // live model/prompt to poll for, just what got dropped and why. Still
  // falls through to the shared more-info expander below (via entry.dropped
  // there), which parses the stashed entry.blockText instead.
  if (entry.dropped) {
    const statusEl = document.createElement('div');
    statusEl.className = 'ccsw-job-hovercard-dropped-status';
    statusEl.textContent = 'Dropped - repo busy';
    card.appendChild(statusEl);

    // A dropped dispatch never became a real job, so there's no pill panel
    // to expand for timing (see recordDroppedSessionJob's comment) -- this
    // is the only place that elapsed time is visible at all. Computed fresh
    // each time the card opens (see showDroppedHovercard), not ticked live
    // while it stays open.
    if (entry.droppedAt) {
      const elapsedEl = document.createElement('div');
      elapsedEl.className = 'ccsw-job-hovercard-dropped-elapsed';
      elapsedEl.textContent = formatElapsedSince(entry.droppedAt);
      card.appendChild(elapsedEl);
    }

    if (entry.heldText) {
      const heldEl = document.createElement('div');
      heldEl.className = 'ccsw-job-hovercard-dropped-held';
      heldEl.textContent = entry.heldText;
      card.appendChild(heldEl);
    }

    // #54: same wake-pending line as the box (renderDroppedPanelContent).
    if (entry.wakeRepo) {
      const wakeEl = document.createElement('div');
      wakeEl.className = 'ccsw-job-hovercard-dropped-wake';
      wakeEl.textContent = `⏳ wake pending: this thread will be nudged when ${entry.wakeRepo} frees`;
      card.appendChild(wakeEl);
    }

    if (entry.name) {
      const nameEl = document.createElement('div');
      nameEl.className = 'ccsw-job-hovercard-summary';
      nameEl.textContent = entry.name;
      card.appendChild(nameEl);
    }

    if (entry.summary) {
      const summaryEl = document.createElement('div');
      summaryEl.className = 'ccsw-job-hovercard-summary';
      summaryEl.textContent = entry.summary;
      card.appendChild(summaryEl);
    }
  } else if (entry.held) {
    // Held-for-send pills (see showHeldForSendBar) never became a real job
    // either -- same shape as the dropped branch above, and likewise falls
    // through to the shared more-info expander (parsing entry.blockText).
    // The "last send" line is deliberately computed from the live durable
    // beacon right here (render time), not a value frozen when the pill was
    // created, so it stays accurate for a pill that's sat on screen a while
    // before being hovered.
    const statusEl = document.createElement('div');
    statusEl.className = 'ccsw-job-hovercard-held-status';
    statusEl.textContent = 'Held - no recent user send in this thread. This is the stale-replay guard: it stops old ccsw blocks re-dispatching on reload or scroll -- without it, every old block would re-fire on every reload.';
    card.appendChild(statusEl);

    const sendEl = document.createElement('div');
    sendEl.className = 'ccsw-job-hovercard-held-lastsend';
    const lastSendAt = lastUserSendAtForDisplay();
    sendEl.textContent = lastSendAt
      ? `Last send ${formatElapsedSince(lastSendAt)}. Send any message in this thread, or click Dispatch anyway, to run it.`
      : 'No user send recorded in this thread. Send any message in this thread, or click Dispatch anyway, to run it.';
    card.appendChild(sendEl);

    // BUG FIX (#47): see the matching comment in renderHeldPanelContent --
    // same mismatch, surfaced here too since this hovercard is the more
    // commonly seen of the two held-status surfaces.
    if (entry.thread && hydratedThread && entry.thread !== hydratedThread) {
      const mismatchEl = document.createElement('div');
      mismatchEl.className = 'ccsw-job-hovercard-held-lastsend';
      mismatchEl.textContent = `note: this tab is "${hydratedThread}" but the block declares "${entry.thread}"`;
      card.appendChild(mismatchEl);
    }

    if (entry.name) {
      const nameEl = document.createElement('div');
      nameEl.className = 'ccsw-job-hovercard-summary';
      nameEl.textContent = entry.name;
      card.appendChild(nameEl);
    }

    if (entry.summary) {
      const summaryEl = document.createElement('div');
      summaryEl.className = 'ccsw-job-hovercard-summary';
      summaryEl.textContent = entry.summary;
      card.appendChild(summaryEl);
    }
  } else {
    // Errored jobs are real jobs (unlike the dropped/held branches above) --
    // they still have model/prompt/more-info, so this adds a line rather
    // than skipping the rest. entry.resultText only arrives once
    // background.js's poll classifies the job as 'error' (see
    // pollToolbarJobs), so it can lag a tick behind entry.status flipping;
    // the "Errored" label alone still shows in that gap.
    if (entry.status === 'error') {
      const statusEl = document.createElement('div');
      statusEl.className = 'ccsw-job-hovercard-errored-status';
      statusEl.textContent = 'Errored';
      card.appendChild(statusEl);

      const detailText = formatErrorDetail(entry.resultText);
      if (detailText) {
        const detailEl = document.createElement('div');
        detailEl.className = 'ccsw-job-hovercard-errored-detail';
        detailEl.textContent = detailText;
        card.appendChild(detailEl);
      }
    }

    {
      const typeEl = document.createElement('div');
      typeEl.className = 'ccsw-job-hovercard-type';
      typeEl.textContent = entry.isCommand ? '(Command)' : '(CC job)';
      card.appendChild(typeEl);
    }

    if (entry.summary) {
      const summaryEl = document.createElement('div');
      summaryEl.className = 'ccsw-job-hovercard-summary';
      summaryEl.textContent = entry.summary;
      card.appendChild(summaryEl);
    }
  }

  renderJobHovercardMoreInfo(card, entry);
}

// Whether the shared "more info..." expander (see jobHovercardExpanded) has
// anything to show for this entry. A normal job's model/prompt arrive live
// off job.php's poll (see applyJobHovercardDetails); a dropped/held pill
// never reaches that poll, so it instead depends on whether a block got
// successfully stashed on entry.blockText (see showDroppedJobBar/
// showHeldForSendBar) -- older records from before that existed have none.
function jobHovercardMoreInfoAvailable(entry) {
  if (entry.dropped || entry.held) return !!entry.blockText;
  return !!(entry.model || entry.prompt);
}

// Renders the "more info..." link common to all three hovercard shapes
// (normal/errored job, dropped pill, held pill) plus its expanded detail
// block, appending both to `card`. Kept as one shared function -- rather
// than a separate link/expander per branch above -- so the toggle state
// (jobHovercardExpanded) and the position re-clamp on expand/collapse behave
// identically no matter which kind of pill is being hovered.
function renderJobHovercardMoreInfo(card, entry) {
  if (!jobHovercardMoreInfoAvailable(entry)) return;

  const link = document.createElement('span');
  link.className = 'more-info-link';
  link.textContent = jobHovercardExpanded ? 'less info' : 'more info...';
  link.addEventListener('click', () => {
    jobHovercardExpanded = !jobHovercardExpanded;
    renderJobHovercardContent(entry);
    // Expanding/collapsing changes the card's height, and it grows upward
    // from the header (see positionJobHovercard) -- re-clamp so newly added
    // detail content can't push the top edge off-screen.
    if (jobHovercardHeaderEl) positionJobHovercard(jobHovercardHeaderEl);
  });
  card.appendChild(link);

  if (!jobHovercardExpanded) return;

  const detail = document.createElement('div');
  detail.className = 'ccsw-job-hovercard-detail';

  if (entry.dropped || entry.held) {
    renderStashedBlockDetail(detail, entry.blockText);
  } else {
    appendDetailLine(detail, 'Type', entry.isCommand ? 'Command' : 'Claude Code');

    if (entry.model) appendDetailLine(detail, 'Model', entry.model);

    if (entry.silenceTimeout) {
      // jobs.php collapses an unset silence_timeout to AgentCore.cs's own
      // 90s default (see its comment), so there's no separate flag telling
      // us whether this job actually asked for 90s -- treat that value as
      // "the default" the same way jobs.php/index.php/terminal.php do.
      const suffix = entry.silenceTimeout === 90 ? 's (default)' : 's';
      appendDetailLine(detail, 'Silence timeout', entry.silenceTimeout + suffix);
    }

    const promptLine = document.createElement('div');
    promptLine.className = 'detail-line';
    const promptLabel = document.createElement('span');
    promptLabel.className = 'detail-label';
    promptLabel.textContent = 'Prompt:';
    promptLine.appendChild(promptLabel);
    detail.appendChild(promptLine);

    const pre = document.createElement('pre');
    pre.className = 'detail-pre';
    pre.textContent = entry.prompt || '(none)';
    detail.appendChild(pre);
  }

  card.appendChild(detail);
}

// Dropped/held pills have no live job to pull model/prompt from -- this
// parses the raw stashed entry.blockText (the ccsw block Claude authored,
// before it was ever dispatched -- see recordDroppedSessionJob/
// showHeldForSendBar) and shows the same shape of detail a real job's
// expander does. isCommand detection mirrors dispatchCcswBlock's own
// addJobBar call (String(parsed.type).toLowerCase() === 'bash').
function renderStashedBlockDetail(detail, blockText) {
  let parsed = null;
  try {
    parsed = JSON.parse(blockText);
  } catch {
    // Not valid JSON -- fall through to the raw-text fallback below rather
    // than erroring, mirroring showHeldForSendBar's own tolerant parse.
  }

  if (!parsed || typeof parsed !== 'object') {
    const pre = document.createElement('pre');
    pre.className = 'detail-pre';
    pre.textContent = blockText;
    detail.appendChild(pre);
    return;
  }

  const isCommand = String(parsed.type).toLowerCase() === 'bash';

  if (typeof parsed.name === 'string' && parsed.name) appendDetailLine(detail, 'Name', parsed.name);
  appendDetailLine(detail, 'Type', isCommand ? 'Command' : 'Claude Code');
  if (!isCommand && typeof parsed.model === 'string' && parsed.model) appendDetailLine(detail, 'Model', parsed.model);
  if (typeof parsed.thread === 'string' && parsed.thread) appendDetailLine(detail, 'Thread', parsed.thread);
  if (typeof parsed.cwd === 'string' && parsed.cwd) appendDetailLine(detail, 'Cwd', parsed.cwd);

  const bodyText = isCommand ? parsed.command : parsed.prompt;
  const bodyLine = document.createElement('div');
  bodyLine.className = 'detail-line';
  const bodyLabel = document.createElement('span');
  bodyLabel.className = 'detail-label';
  bodyLabel.textContent = (isCommand ? 'Command' : 'Prompt') + ':';
  bodyLine.appendChild(bodyLabel);
  detail.appendChild(bodyLine);

  const pre = document.createElement('pre');
  pre.className = 'detail-pre';
  pre.textContent = (typeof bodyText === 'string' && bodyText) || '(none)';
  detail.appendChild(pre);
}

// The toolbar hugs the bottom-right of the viewport and stacks upward (see
// #ccsw-toolbar's column-reverse), so the card opens above the bar, flush
// against its top edge, rather than below where it would run off-screen. The
// header itself hugs the right edge too, so anchoring the card's left edge
// to the header's left edge (its normal home) can push the card's right edge
// -- including the more-info link -- past the viewport, off-screen and
// unreachable; clamp so the whole card stays horizontally visible instead.
//
// Vertically, this used to anchor purely off the *header's* top edge growing
// upward, which is right while the bar is collapsed (the pill sits low in
// the viewport, so growing up avoids running off the bottom). Once the
// terminal/feed panel is open, though, the header itself can end up right
// against the window top (a tall/resized panel pushes it up), and the card
// is meant to hang off the *header*, not the panel below it -- so for an
// expanded bar it instead anchors off the header's own bottom edge and grows
// downward, its top edge flush against the header regardless of what the
// panel underneath is doing. Collapsed bars (no open panel) keep the old
// bottom-anchored, grows-upward behavior, since there's nothing below the
// header to hang off of.
//
// Either way, the card's height grows away from that anchor as content is
// added (e.g. expanding "more info"), which can push it past the opposite
// edge of the viewport if the anchor itself sits near that edge. Rather than
// letting that happen, clamp the card's max-height to the space actually
// available in the direction it's growing, with internal scroll for the
// rest. That auto-clamp is skipped once the user has manually resized the
// card (see jobHovercardManuallySized) so a deliberate resize isn't
// immediately fought back down.
function positionJobHovercard(headerEl) {
  const card = jobHovercardEl;
  const rect = headerEl.getBoundingClientRect();
  const margin = 8;

  const panelEl = headerEl.nextElementSibling;
  const panelOpen = panelEl && panelEl.classList.contains('ccsw-job-bar-panel--open');

  const maxLeft = window.innerWidth - card.offsetWidth - margin;
  const left = Math.max(margin, Math.min(Math.round(rect.left), maxLeft));
  card.style.left = `${left}px`;

  if (panelOpen) {
    card.style.bottom = '';
    card.style.top = `${Math.round(rect.bottom)}px`;
    if (!jobHovercardManuallySized) {
      card.style.maxHeight = `${Math.max(80, Math.round(window.innerHeight - rect.bottom - margin))}px`;
    }
  } else {
    card.style.top = '';
    card.style.bottom = `${Math.round(window.innerHeight - rect.top)}px`;
    if (!jobHovercardManuallySized) {
      card.style.maxHeight = `${Math.max(80, Math.round(rect.top - margin))}px`;
    }
  }
}

// Shared by showJobHovercard (real jobs, keyed by jobId, looked up fresh out
// of activeToolbarJobs every time so a live status/summary update shows up
// next open) and showDroppedHovercard (dropped pills, keyed by a throwaway
// per-pill string since there's no job id -- see dropHovercardKeyCounter --
// with a static entry that's already got everything it'll ever have).
function openJobHovercard(key, entry, headerEl) {
  // The hover-intent delay (see addJobBar/showDroppedJobBar/showHeldForSendBar's
  // headerEl mouseenter listeners) means the header can vanish -- capped,
  // removed, dismissed -- in the gap between the pointer landing and this
  // actually firing. Showing a card anchored to a detached header would
  // never get a mouseleave to close it (same failure mode as
  // hideHovercardIfOwnedBy covers for an already-open card), so just don't
  // show it.
  if (!headerEl.isConnected) return;
  // BUG FIX (#25/#45), superseded: positionJobHovercard anchors the card at
  // the header's BOTTOM edge whenever the pill's own terminal box is
  // expanded -- i.e. directly on top of that box -- and the card (z-index
  // 2147483647) paints above #ccsw-toolbar's whole subtree (2147483646, see
  // content.css), so an opened box's send/cancel/dispatch buttons end up
  // hidden under the card while it's shown. #25/#45 originally fixed this by
  // refusing to show the card at all while expanded, at the cost of hovering
  // an expanded title bar showing nothing. This instead shows the same
  // interactive card as a collapsed pill -- summary plus a clickable "more
  // info..." toggle -- accepting that it sits over the box's buttons while
  // shown; it hides again as soon as the pointer leaves the header
  // (scheduleHideJobHovercard).
  const card = ensureJobHovercard();
  cancelHideJobHovercard();
  if (jobHovercardJobId !== key) jobHovercardExpanded = false;
  jobHovercardJobId = key;
  jobHovercardHeaderEl = headerEl;
  renderJobHovercardContent(entry);
  card.hidden = false;
  positionJobHovercard(headerEl);
  // Absolute failsafe cap, reset on every (re-)show -- see
  // HOVERCARD_MAX_LIFETIME_MS above.
  clearTimeout(jobHovercardMaxLifetimeTimer);
  jobHovercardMaxLifetimeTimer = setTimeout(hideJobHovercardNow, HOVERCARD_MAX_LIFETIME_MS);
}

function showJobHovercard(jobId, headerEl) {
  const entry = activeToolbarJobs.get(jobId);
  if (!entry || (!entry.summary && !(entry.model || entry.prompt))) return;
  openJobHovercard(jobId, entry, headerEl);
}

function showDroppedHovercard(key, entry, headerEl) {
  openJobHovercard(key, entry, headerEl);
}

// Claude spark glyph: an 8-point radial asterisk/starburst built as an inline
// SVG (createElementNS, no innerHTML) so it sits inline like the '>_' chevron
// with no risk of a replaced-element/display quirk forcing a line break.
const SVG_NS = 'http://www.w3.org/2000/svg';
const CLAUDE_SPARK_PATH_D = 'M12,1 L13.15,9.23 L19.78,4.22 L14.77,10.85 L23,12 '
  + 'L14.77,13.15 L19.78,19.78 L13.15,14.77 L12,23 L10.85,14.77 L4.22,19.78 '
  + 'L9.23,13.15 L1,12 L9.23,10.85 L4.22,4.22 L10.85,9.23 Z';

function buildClaudeSparkIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ccsw-job-bar-type-icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', CLAUDE_SPARK_PATH_D);
  path.setAttribute('fill', '#D97757');
  svg.appendChild(path);
  return svg;
}

// Send-arrow glyph for the dropped pill's toolbar (see showDroppedJobBar) --
// same shape/stroke as feed.php's advice-btn icon, rebuilt natively here
// (createElementNS, no innerHTML) since this box is plain content.js DOM
// with no iframe to source it from.
function buildSendIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M20 4v7a4 4 0 0 1-4 4H4');
  const polyline = document.createElementNS(SVG_NS, 'polyline');
  polyline.setAttribute('points', '9 10 4 15 9 20');
  svg.append(path, polyline);
  return svg;
}

// Cancel/dismiss glyph for the held pill's toolbar (see showHeldForSendBar) --
// a plain X, deliberately distinct in shape from buildSendIcon's arrow above
// so the two toolbar actions never get confused at a glance.
function buildCancelIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const line1 = document.createElementNS(SVG_NS, 'line');
  line1.setAttribute('x1', '18');
  line1.setAttribute('y1', '6');
  line1.setAttribute('x2', '6');
  line1.setAttribute('y2', '18');
  const line2 = document.createElementNS(SVG_NS, 'line');
  line2.setAttribute('x1', '6');
  line2.setAttribute('y1', '6');
  line2.setAttribute('x2', '18');
  line2.setAttribute('y2', '18');
  svg.append(line1, line2);
  return svg;
}

// Type icon prefix on a job's collapsed pill: a '>_' glyph for a bash/command
// job (readonly and locking bash both get the same chevron -- no third
// variant), the Claude spark glyph for everything else (a CC job).
function renderJobBarId(idEl, jobId, name, summary, isCommand) {
  idEl.textContent = '';
  if (isCommand) {
    const glyphEl = document.createElement('span');
    glyphEl.className = 'ccsw-job-bar-type-glyph';
    glyphEl.textContent = '>_';
    idEl.appendChild(glyphEl);
  } else {
    idEl.appendChild(buildClaudeSparkIcon());
  }
  // Render-time fallback (see dispatchCcswBlock): a job dispatched with an empty
  // name shows its summary rather than the numeric id -- and, since the name is
  // no longer baked at dispatch, an unnamed job never freezes the literal 'Job'.
  idEl.appendChild(document.createTextNode(name || `#${jobId}`));
}

// Corrects a job bar's type indicator once isCommand becomes known after the
// bar was already created without it (see restoreRunningJobBars/
// reopenSessionJob, which don't have the dispatched ```ccsw payload on hand
// the way dispatchCcswBlock does) -- a no-op once entry.isCommand already
// matches, so repeated pushes from the background poll don't keep re-rendering.
//
// entry.isCommand is STICKY once true: dispatchCcswBlock's addJobBar call
// sets it authoritatively from the dispatched payload's parsed.type, which
// is known-correct at dispatch time. A later poll/details message can only
// learn false->true (a restored bar that started with the default false);
// it must never flip an established true back to false, or the pill icon
// clobbers back to the Claude spark glyph while the hovercard (which also
// must not downgrade) keeps saying "Command".
function setJobBarType(jobId, entry, isCommand) {
  if (isCommand === undefined || isCommand === null) return;
  if (entry.isCommand === true) return;
  if (entry.isCommand === isCommand) return;
  entry.isCommand = isCommand;
  const idEl = entry.headerEl.querySelector('.ccsw-job-bar-id');
  if (idEl) renderJobBarId(idEl, jobId, entry.name, entry.summary, isCommand);
}

function addJobBar(jobId, thread, name, summary, ghostEl, isCommand = false, source = 'unknown') {
  if (activeToolbarJobs.has(jobId)) {
    // #12b S3: retained as an explicit re-tap fast path, NOT folded into
    // create's must-not-exist. It returns BEFORE the bar is built, so it does
    // work create cannot: bumpPillRecency (a reopen must move the pill to the
    // most-recent slot -- ordering the task requires preserved) and disposing
    // any handed-in ghost with the 'job_already_tracked' reason. create (at
    // the set below) is the backstop that refuses a duplicate ENTRY; this is
    // the fast path that also skips the redundant build and keeps the reopen
    // semantics. Mirrors showDroppedJobBar's kept isReopen guard.
    // Already tracked (still visible, or hidden behind the cap) -- reopening
    // it (see reopenSessionJob) should count as recent activity even though
    // there's no new bar to create.
    bumpPillRecency(jobId);
    // An idempotent re-dispatch can hand in a ghost pill for a block whose
    // job id is already tracked -- dispose it here so it doesn't linger as
    // an orphaned "detecting..." pill with no owning variable.
    removeGhostBar(ghostEl, 'job_already_tracked');
    return;
  }

  // Issue #11 backstop: activeToolbarJobs.has() above is the primary guard,
  // but it's keyed on jobId by strict Map equality -- a caller that hands in
  // jobId as a different type (string vs number) for the same underlying job
  // would slip past it and this function would go on to build a second
  // .ccsw-job-bar-panel for a job that already has one on screen. Checking
  // the DOM directly (keyed on the panel's data-ccsw-job-id, stamped as
  // String(jobId) below) catches that regardless of the caller's jobId type.
  const existingPanel = getToolbarContainer().querySelector(`.ccsw-job-bar-panel[data-ccsw-job-id="${CSS.escape(String(jobId))}"]`);
  if (existingPanel) {
    logEvent('panel_dupe_blocked', { jobId, name: name ?? null }, null, true);
    const existingBar = existingPanel.closest('.ccsw-job-bar');
    if (existingBar) {
      existingBar.classList.add('ccsw-job-bar--expanded');
      existingPanel.classList.add('ccsw-job-bar-panel--open');
      existingBar.scrollIntoView({ block: 'nearest' });
    }
    removeGhostBar(ghostEl, 'panel_dupe_blocked');
    return;
  }

  logEvent('pill_create', { jobId, pillThread: thread ?? null, name: name ?? null, isCommand, source, pageLoadId: CCSW_PAGE_LOAD_ID });

  // If a ghost pill (see createGhostBar) is handed in and still on screen,
  // morph it in place into the real bar rather than building a fresh one --
  // reuses its header (spinner already spinning, "detecting..." label) and
  // just fills in the pieces that weren't known until the block dispatched
  // (job id/name, thread, status, close button).
  const reuseGhost = !!ghostEl?.isConnected;
  if (reuseGhost) releaseGhostBar(ghostEl, 'morphed');

  const barEl = reuseGhost ? ghostEl : document.createElement('div');
  barEl.className = 'ccsw-job-bar';

  const headerEl = reuseGhost ? barEl.querySelector('.ccsw-job-bar-header') : document.createElement('div');
  headerEl.className = 'ccsw-job-bar-header';
  headerEl.addEventListener('click', () => toggleJobBar(jobId));
  // Hover-intent delay: a bare mouseenter fired the hovercard instantly,
  // popping it open on every incidental pass over the toolbar (e.g. while
  // dragging/resizing a neighbouring pill). Only show it once the pointer
  // has actually lingered.
  let jobHoverIntentTimer = null;
  headerEl.addEventListener('mouseenter', () => {
    clearTimeout(jobHoverIntentTimer);
    // Cancel any pending hide immediately on arrival, not just once the
    // hover-intent delay below elapses and actually (re-)shows the card --
    // otherwise a pointer that left the card and landed back on this same
    // header could still get hidden out from under it a moment later.
    cancelHideJobHovercard();
    jobHoverIntentTimer = setTimeout(() => showJobHovercard(jobId, headerEl), 750);
  });
  headerEl.addEventListener('mouseleave', () => {
    clearTimeout(jobHoverIntentTimer);
    scheduleHideJobHovercard();
  });

  const spinnerEl = reuseGhost ? headerEl.querySelector('.ccsw-spinner') : document.createElement('span');
  spinnerEl.className = 'ccsw-spinner';
  ensureSpinnerLogo(spinnerEl);

  // Collapsed state only ever shows spinnerEl + idEl (see content.css) --
  // threadEl/statusEl/closeEl are revealed once the pill is expanded.
  const idEl = reuseGhost ? headerEl.querySelector('.ccsw-job-bar-id') : document.createElement('span');
  idEl.className = 'ccsw-job-bar-id';
  renderJobBarId(idEl, jobId, name, summary, isCommand);

  const threadEl = document.createElement('span');
  threadEl.className = 'ccsw-job-bar-thread';
  threadEl.textContent = thread || '';

  const statusEl = document.createElement('span');
  statusEl.className = 'ccsw-job-bar-status';
  statusEl.textContent = 'pending';

  const closeEl = document.createElement('button');
  closeEl.type = 'button';
  closeEl.className = 'ccsw-job-bar-close';
  closeEl.title = 'Remove';
  closeEl.textContent = '×';
  closeEl.addEventListener('click', (evt) => {
    evt.stopPropagation(); // don't also toggle the panel open/closed
    removeJobBar(jobId);
  });

  // Error badge (see content.css's --error rule): unlike threadEl/statusEl
  // above, NOT gated to expanded-only -- an errored job needs to read as
  // unmistakable on the collapsed pill too, not just via the (subtler)
  // spinner-dot recolor, mirroring the red the header already uses for
  // --error once expanded.
  const errorBadgeEl = document.createElement('span');
  errorBadgeEl.className = 'ccsw-job-bar-error-badge';
  errorBadgeEl.textContent = '!';
  errorBadgeEl.title = 'Errored';

  // Waiting indicator (see setJobBarWaiting): unlike threadEl/statusEl/
  // closeEl above, this is NOT gated to expanded-only in content.css -- a
  // held delivery is important enough to surface even on the collapsed pill.
  const waitingLabelEl = document.createElement('span');
  waitingLabelEl.className = 'ccsw-job-bar-waiting-label';
  waitingLabelEl.textContent = 'output waiting - finish typing';

  // Note 448 Layer 3 visible fallback (see setJobBarDeliveryFailed) -- same
  // always-visible-even-collapsed treatment as waitingLabelEl above, since a
  // dropped delivery is exactly the kind of thing that must never go
  // unnoticed just because the pill happens to be collapsed.
  const deliveryFailedLabelEl = document.createElement('span');
  deliveryFailedLabelEl.className = 'ccsw-job-bar-delivery-failed-label';
  deliveryFailedLabelEl.textContent = 'delivery failed - manual send needed';

  const panelEl = document.createElement('div');
  panelEl.className = 'ccsw-job-bar-panel';
  panelEl.dataset.ccswJobId = String(jobId);
  const iframeEl = document.createElement('iframe');
  iframeEl.className = 'ccsw-job-bar-iframe';
  const waitingOverlayEl = document.createElement('div');
  waitingOverlayEl.className = 'ccsw-job-bar-panel-waiting';
  waitingOverlayEl.textContent = 'Output waiting - finish typing';

  // Feed-load notice (see showPanelNotice). A DEDICATED element rather than a
  // reuse of waitingOverlayEl above, because the two describe unrelated things
  // -- "this panel's iframe won't load" vs "this job's delivery is held on the
  // composer" -- and are driven by independent triggers that know nothing about
  // each other. Sharing one node meant whichever spoke last won: a load failure
  // could overwrite the genuine hold text, and a stale load-failure message
  // could outlive the delivery it appeared next to, because setJobBarWaiting
  // only toggles a class and never restores the text. Separate nodes make that
  // whole class of clobbering impossible.
  const feedNoticeEl = document.createElement('div');
  feedNoticeEl.className = 'ccsw-job-bar-panel-notice';
  feedNoticeEl.setAttribute('role', 'button');
  feedNoticeEl.tabIndex = 0;
  feedNoticeEl.title = 'Retry loading this output';
  feedNoticeEl.addEventListener('click', (evt) => {
    evt.stopPropagation(); // don't toggle the panel shut underneath the retry
    retryFeedIframe(jobId);
  });
  panelEl.append(iframeEl, waitingOverlayEl, feedNoticeEl);
  attachResizeHandles(panelEl);

  if (reuseGhost) {
    // Ghost markup is already [spinnerEl, idEl] -- just append the pieces
    // it never had.
    headerEl.append(errorBadgeEl, threadEl, statusEl, waitingLabelEl, deliveryFailedLabelEl, closeEl);
    barEl.appendChild(panelEl);
  } else {
    headerEl.append(spinnerEl, idEl, errorBadgeEl, threadEl, statusEl, waitingLabelEl, deliveryFailedLabelEl, closeEl);
    barEl.append(headerEl, panelEl);
    getToolbarContainer().appendChild(barEl);
  }

  // #12b S3: single make-path (was activeToolbarJobs.set). create is
  // must-not-exist -- it returns any live entry for this jobId untouched
  // rather than clobbering it, folding in the dedup role the has() guard at
  // the top of this function used to hold on the SET. That guard stays as an
  // explicit re-tap fast path (see note there): it returns BEFORE this bar is
  // built, so it also carries bumpPillRecency (pill ordering) and the ghost
  // disposal that create -- running only here, after the full build -- cannot.
  pillRegistry.create(jobId, {
    thread, name, summary, barEl, headerEl, statusEl, panelEl, iframeEl, expanded: false, model: null, prompt: null, silenceTimeout: null, isCommand,
    status: 'pending',
    resultText: null,
    // Last time this pill heard ANYTHING from background.js's poll (see the
    // ccsw-toolbar-status listener below) -- reapSilentPills' silence clock.
    lastSeenAt: Date.now(),
  });
  console.log(
    `[CCswitchboard] toolbar: added bar for job ${jobId}${thread ? ` (thread "${thread}")` : ''}${reuseGhost ? ' (morphed from ghost pill)' : ''}.`
  );
  logEvent('panel_create', { jobId, name: name ?? null, panelsForJobAfter: 1 }, null, false);
  bumpPillRecency(jobId);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-toolbar-status') return;

  // Updates the SW menu row's LED regardless of whether this job's toolbar
  // pill is still open -- removeJobBar() only deletes from activeToolbarJobs,
  // but the menu should keep reflecting status for jobs whose pill was closed.
  updateSessionJobStatus(message.jobId, message.status, message.thread);

  const entry = activeToolbarJobs.get(message.jobId);
  if (!entry) return; // not a job this tab/thread dispatched -- ignore

  // Belt-and-braces: background.js only ever targets the tab that dispatched
  // the job, but also check the thread tag itself matches before touching
  // the bar, in case a stale/mismatched status message ever arrives.
  if (entry.thread && message.thread && entry.thread !== message.thread) {
    console.warn(`[CCswitchboard] toolbar: job ${message.jobId} thread mismatch (bar="${entry.thread}", message="${message.thread}"), ignoring.`);
    return;
  }

  // Any status ping at all -- regardless of what it says -- proves
  // background.js's poll is still alive for this job, which is exactly what
  // reapSilentPills' silence clock needs to know.
  entry.lastSeenAt = Date.now();

  console.log(`[CCswitchboard] toolbar: job ${message.jobId} status -> ${message.status}`);
  // resultText only rides along on an 'error' status (see pollToolbarJobs in
  // background.js) -- stashed on the entry so the hovercard's errored branch
  // (renderJobHovercardContent) can show it without a separate fetch.
  if (typeof message.resultText === 'string') entry.resultText = message.resultText;
  setJobBarStatus(message.jobId, entry, message.status);

  if (typeof message.summary === 'string') entry.summary = message.summary;

  // Self-heal the pill label from the relay's authoritative name. jobs.php
  // returns the job's stored name (NULL -> '' here for a nameless job) alongside
  // its summary, so adopting it lets a pill that dispatched nameless -- and,
  // under an older build, baked the literal 'Job' into entry.name/storage --
  // fall back through to its summary on the next poll tick instead of staying
  // 'Job'. A named job's relay name always equals what dispatch stored, so this
  // never clobbers a good name. Applied BEFORE setJobBarType so that if it also
  // re-renders (on a false->true isCommand flip) it uses the fresh name; a
  // separate re-render below covers the name/summary-only case.
  const relayName = typeof message.name === 'string' ? message.name : '';
  const nameChanged = relayName !== (entry.name || '');
  if (nameChanged) entry.name = relayName;

  // setJobBarType must run first: it's the sole writer of entry.isCommand
  // (sticky -- see its comment), so applyJobHovercardDetails below reads the
  // already-settled value when it renders an open hovercard.
  setJobBarType(message.jobId, entry, message.isCommand);

  if (nameChanged) {
    const idEl = entry.headerEl?.querySelector('.ccsw-job-bar-id');
    if (idEl) renderJobBarId(idEl, message.jobId, entry.name, entry.summary, entry.isCommand);
  }
  applyJobHovercardDetails(message.jobId, message.model, message.prompt, message.isCommand, message.silenceTimeout, message.summary);
});

// Shared by the toolbar-status listener above (live model/prompt riding
// along a poll) and reopenSessionJob's one-shot fetch below (a reopened,
// already-terminal job that poll no longer touches) -- updates the entry
// and, if its hovercard happens to be open right now, re-renders it in
// place rather than leaving it stuck on stale/summary-only content.
function applyJobHovercardDetails(jobId, model, prompt, isCommand, silenceTimeout, summary) {
  const entry = activeToolbarJobs.get(jobId);
  if (!entry) return;
  entry.model = model ?? entry.model;
  entry.prompt = prompt ?? entry.prompt;
  entry.silenceTimeout = silenceTimeout ?? entry.silenceTimeout;
  // Only apply a non-empty summary -- never overwrite an already-good
  // summary with an empty/missing one from a caller that doesn't have it.
  if (typeof summary === 'string' && summary) entry.summary = summary;
  // entry.isCommand is NOT written here -- setJobBarType (called by every
  // caller before this) is the sole writer, since it applies the sticky
  // true-never-reverts-to-false rule. Writing it here too would let a
  // details/poll message with isCommand=false silently downgrade a job that
  // dispatch already established as a command, even though setJobBarType
  // correctly refused the same downgrade for the pill icon.
  if (jobHovercardJobId === jobId && jobHovercardEl && !jobHovercardEl.hidden) {
    renderJobHovercardContent(entry);
  }
}

async function loadStoredThreadJobs(thread) {
  try {
    const all = await chrome.storage.local.get(SW_MENU_STORAGE_KEY);
    const map = all[SW_MENU_STORAGE_KEY] || {};
    return Array.isArray(map[thread]) ? map[thread] : [];
  } catch (err) {
    console.warn(`[CCswitchboard] SW menu: failed to load stored jobs for thread "${thread}":`, err.message);
    handlePossibleContextInvalidation(err);
    return [];
  }
}

async function appendStoredThreadJob(thread, job) {
  try {
    const all = await chrome.storage.local.get(SW_MENU_STORAGE_KEY);
    const map = all[SW_MENU_STORAGE_KEY] || {};
    const list = Array.isArray(map[thread]) ? map[thread] : [];
    list.push(job);
    map[thread] = list.length > MAX_JOBS_PER_THREAD ? list.slice(-MAX_JOBS_PER_THREAD) : list;
    await chrome.storage.local.set({ [SW_MENU_STORAGE_KEY]: map });
    console.log(`[CCswitchboard] SW menu: saved job ${job.id} for thread "${thread}" (${map[thread].length} job(s) now stored).`);
  } catch (err) {
    console.warn(`[CCswitchboard] SW menu: failed to persist job for thread "${thread}":`, err.message);
    handlePossibleContextInvalidation(err);
  }
}

async function updateStoredThreadJobStatus(thread, jobId, status) {
  if (!thread) return;
  try {
    const all = await chrome.storage.local.get(SW_MENU_STORAGE_KEY);
    const map = all[SW_MENU_STORAGE_KEY] || {};
    const list = Array.isArray(map[thread]) ? map[thread] : [];
    const stored = list.find((job) => job.id === jobId);
    if (!stored) return;
    stored.status = status;
    map[thread] = list;
    await chrome.storage.local.set({ [SW_MENU_STORAGE_KEY]: map });
  } catch (err) {
    console.warn(`[CCswitchboard] SW menu: failed to persist status for job ${jobId}:`, err.message);
    handlePossibleContextInvalidation(err);
  }
}

// Updates a sessionJobs entry's status (drives the SW menu row's LED) and
// re-renders the menu if it's currently open. Skipped if the job isn't
// tracked at all (e.g. a status message for a job this tab never recorded).
// Toggles a sessionJobs entry's waiting flag (drives the SW menu row's
// waiting dot, alongside the toolbar pill's own copy of the same signal --
// see setJobBarWaiting) and re-renders the menu if it's open. Independent of
// activeToolbarJobs: a job whose pill was closed still keeps its SW menu row.
function setSessionJobWaiting(jobId, waiting) {
  const job = sessionJobs.find((j) => j.id === jobId);
  if (!job) return;
  if (job.waiting === waiting) return;
  job.waiting = waiting;
  if (isSwMenuOpen()) renderSwMenuPanel();
}

function updateSessionJobStatus(jobId, status, thread) {
  const job = sessionJobs.find((j) => j.id === jobId);
  if (!job) return;
  // jobs.php's plain "done" can arrive after the wake loop already
  // classified this job as "error"/"cancelled" from its result text -- that
  // classification is more authoritative than the bare status, so don't let
  // a late "done" downgrade it back to green.
  if ((job.status === 'error' || job.status === 'cancelled') && status === 'done') return;
  if (job.status === status) return;
  job.status = status;
  updateStoredThreadJobStatus(thread || job.thread, jobId, status);
  updateFaviconForJobState();
  if (isSwMenuOpen()) renderSwMenuPanel();
}

// Trims sessionJobs down to the newest MAX_JOBS_PER_THREAD entries for one
// thread, leaving other threads' entries untouched. Entries aren't pushed in
// strict chronological order (hydration can splice older stored jobs in
// after a newer live one), so this sorts by time rather than array position.
function capSessionJobsForThread(thread) {
  const forThread = sessionJobs.filter((job) => job.thread === thread);
  if (forThread.length <= MAX_JOBS_PER_THREAD) return;

  forThread.sort((a, b) => a.time - b.time);
  const dropIds = new Set(forThread.slice(0, forThread.length - MAX_JOBS_PER_THREAD).map((job) => job.id));
  for (let i = sessionJobs.length - 1; i >= 0; i--) {
    if (dropIds.has(sessionJobs[i].id)) sessionJobs.splice(i, 1);
  }
}

// Tells background.js which of this thread's jobs are still non-terminal, so
// it can (re)start polling jobs.php/result.php for them and deliver status to
// THIS tab -- covers a tab that was closed and reopened (or never had this
// job registered at all, e.g. the thread was handed off from another tab).
// Without this, a job's pill/LED would only ever get corrected by the same
// tab instance that dispatched it, which defeats the relay being the single
// source of truth for status.
function trackOpenJobsWithBackground(thread) {
  const openJobs = sessionJobs.filter((job) => job.thread === thread && (job.status === 'pending' || job.status === 'running'));
  if (openJobs.length === 0) return;
  chrome.runtime
    .sendMessage({ type: 'ccsw-track-jobs', thread, jobs: openJobs.map((job) => ({ id: job.id, status: job.status })) })
    .catch((err) => {
      console.warn(`[CCswitchboard] SW menu: failed to register open jobs for thread "${thread}" with background:`, err.message);
      handlePossibleContextInvalidation(err);
    });
}

// On a plain refresh, activeToolbarJobs starts empty -- addJobBar is
// otherwise only ever called from a live dispatch (dispatchCcswBlock) or from
// reopening a job via the SW menu (reopenSessionJob), so a still-running
// job's pill would never reappear on its own. Re-shows one for every stored
// job that was pending/running as of the last time this thread was seen, but
// only after confirming with the relay that it's still non-terminal -- the
// stored status can be stale if the job actually finished while this tab was
// closed or mid-refresh. Finished jobs are left alone here; they still show
// up in the SW menu via updateSessionJobStatus, just without a pill.
async function restoreRunningJobBars(thread) {
  const candidates = sessionJobs.filter((job) => job.thread === thread && (job.status === 'pending' || job.status === 'running'));
  if (candidates.length === 0) return;

  let statuses = {};
  try {
    const response = await chrome.runtime.sendMessage({ type: 'ccsw-check-jobs-status', jobIds: candidates.map((job) => job.id) });
    statuses = response?.statuses || {};
  } catch (err) {
    console.warn(`[CCswitchboard] SW menu: failed to check current status for thread "${thread}"'s open jobs, leaving their pills as stored:`, err.message);
    handlePossibleContextInvalidation(err);
  }

  candidates.forEach((job) => {
    const currentStatus = statuses[job.id];
    // Unknown to the relay (fetch failed, or the job aged out of jobs.php's
    // batch limit) -- keep treating it as still open rather than assuming
    // it's done; trackOpenJobsWithBackground's ongoing poll will correct this
    // shortly if it's wrong.
    if (currentStatus && currentStatus !== job.status) {
      updateSessionJobStatus(job.id, currentStatus, thread);
    }
    if (job.status === 'pending' || job.status === 'running') {
      addJobBar(job.id, job.thread, job.name, job.summary, undefined, undefined, 'restore');
      const entry = activeToolbarJobs.get(job.id);
      if (entry) setJobBarStatus(job.id, entry, job.status);
    }
  });
}

// Pulls in whatever this thread already had stored from prior page loads,
// merging it into sessionJobs (deduped by job id) so the menu picks up
// where it left off instead of resetting to just this load's jobs.
async function hydrateSessionJobsForThread(thread) {
  if (!thread || thread === hydratedThread) return;
  hydratedThread = thread;
  rememberUrlThread(thread);

  // Now that this tab knows its thread, reflect any autopilot window already
  // armed for it (persisted from a prior load / armed in another tab) in the
  // menu row and the always-visible badge.
  updateAutopilotUi();

  // Enroll this thread for durable dispatched-key polling and pull its keys
  // now. Until they land, scan() defers every block in it (see
  // durableStateReadyFor) -- including, on a brand-new thread, the very first
  // one Claude emits.
  requestDurableState(thread);

  const stored = await loadStoredThreadJobs(thread);
  console.log(`[CCswitchboard] SW menu: hydrating thread "${thread}" -- ${stored.length} job(s) in storage.`);
  const known = new Set(sessionJobs.map((job) => job.id));
  stored.forEach((job) => {
    if (!known.has(job.id)) {
      sessionJobs.push(job);
      known.add(job.id);
    }
  });
  capSessionJobsForThread(thread);
  await restoreRunningJobBars(thread);
  trackOpenJobsWithBackground(thread);
  updateFaviconForJobState();

  console.log(`[CCswitchboard] SW menu: sessionJobs now has ${sessionJobs.length} job(s) after hydrating "${thread}".`);
  if (isSwMenuOpen()) renderSwMenuPanel();
}

// --- Ghost Reaper: client-side silence watchdog (note 448) ------------------
// restoreRunningJobBars above only reconciles a thread's pills against the
// relay at hydrate time -- a page load or thread switch. A pill can still go
// stale WITHOUT either of those happening: background.js's toolbarJobs Map
// (see pollToolbarJobs) lives only in the service worker's memory, and
// Chrome is free to kill an idle MV3 service worker at any time; when it
// restarts, that Map comes back empty, so the poll silently stops delivering
// ccsw-toolbar-status for whatever jobs it can no longer see -- their pills
// just freeze mid-spin with nothing left to correct them short of a reload.
// This periodic sweep is the safety net: any pill that's gone quiet for too
// long gets independently re-checked against the relay (via the same
// ccsw-check-jobs-status path restoreRunningJobBars uses, now backed by
// background.js's status.php fallback) and, if the relay can't confirm it's
// still open, force-resolved to a terminal "stale" pill -- no manual
// chrome.storage.local clear required.
//
// Deliberately aggressive per note 448's own call: a live, still-tracked job
// gets a fresh ccsw-toolbar-status message (and therefore a fresh
// lastSeenAt) roughly every TOOLBAR_POLL_INTERVAL_MS in background.js
// regardless of how long the agent itself is thinking, so this threshold
// only elapses when the delivery pipeline itself has broken, not when a job
// is merely slow. If this ever force-closes a job that was actually still
// alive, claude.ai just re-fires it with a fresh silence_timeout -- reaper +
// re-fire is the intended recovery path here, not a bug to route around.
const SILENCE_REAP_THRESHOLD_MS = 5 * 60 * 1000;
const SILENCE_REAP_SWEEP_INTERVAL_MS = 60 * 1000;

// #12b S4 -- hard ceiling on how many pills may be tracked in activeToolbarJobs
// at once. pillRegistry.cap() enforces it on each reaper sweep as a memory
// backstop: it DESTROYS the oldest-by-creation entries beyond this (routed
// through dispose, so it inherits the pillOrder-purge-without-applyToolbarCap
// semantic and logs every drop). Deliberately distinct from -- and set far
// above -- applyToolbarCap's TOOLBAR_VISIBLE_CAP (4), which only HIDES pills
// and never frees them, and MAX_JOBS_PER_THREAD (30): 50 is well above any
// realistic concurrent-job count, so cap() only ever fires on a genuine runaway
// leak, never in normal use.
const MAX_LIVE_PILLS = 50;

async function reapSilentPills() {
  // #12b S4 structural housekeeping -- runs first, before any early return, so
  // it happens on every sweep regardless of whether there are silent pills:
  //   (1) reap() disposes orphan entries whose barEl detached out from under the
  //       Map (the "Map entry with no removable DOM" ghost class the epic
  //       targets). Without this, the force-resolve pass below would call
  //       setJobBarStatus against a detached corpse and leave the Map entry to
  //       linger forever as a non-re-dispatchable ghost.
  //   (2) cap() is the hard memory backstop -- destroy oldest beyond
  //       MAX_LIVE_PILLS, logging what it drops.
  // Both route through pillRegistry.dispose, so neither reintroduces an
  // applyToolbarCap backfill on removal (shrink-don't-backfill preserved).
  // The silence-clock force-resolve below (relay re-check + setJobBarStatus,
  // note 448's durable fix) is unchanged -- it never removed pills, so nothing
  // there routes onto disposeIf.
  pillRegistry.reap();
  pillRegistry.cap(MAX_LIVE_PILLS);

  const now = Date.now();
  const candidateIds = [];
  for (const [jobId, entry] of activeToolbarJobs) {
    if (entry.status !== 'pending' && entry.status !== 'running') continue;
    if (now - (entry.lastSeenAt || 0) < SILENCE_REAP_THRESHOLD_MS) continue;
    candidateIds.push(jobId);
  }
  if (candidateIds.length === 0) return;

  console.log(`[CCswitchboard] Ghost Reaper: ${candidateIds.length} pill(s) silent for over ${SILENCE_REAP_THRESHOLD_MS / 1000}s, re-checking with relay:`, candidateIds);

  let statuses = {};
  try {
    const response = await chrome.runtime.sendMessage({ type: 'ccsw-check-jobs-status', jobIds: candidateIds });
    statuses = response?.statuses || {};
  } catch (err) {
    console.warn('[CCswitchboard] Ghost Reaper: relay re-check failed, will retry next sweep:', err.message);
    handlePossibleContextInvalidation(err);
    return;
  }

  candidateIds.forEach((jobId) => {
    const entry = activeToolbarJobs.get(jobId);
    if (!entry) return;
    const relayStatus = statuses[jobId];

    if (relayStatus === 'pending' || relayStatus === 'running') {
      // Relay confirms it's genuinely still open -- not a ghost, just a
      // pipeline gap. Reset the silence clock and re-register with
      // background.js so its poll resumes delivering status for it, rather
      // than leaving this pill to hit the same silent dead-end again.
      entry.lastSeenAt = now;
      trackOpenJobsWithBackground(entry.thread);
      return;
    }

    // Either the relay confirms it's terminal (done/error/cancelled/stale --
    // use that, it's the more informative answer) or it couldn't confirm
    // anything at all even after status.php's own fallback (fall back to the
    // generic 'stale' label) -- either way, this tab has heard nothing for
    // SILENCE_REAP_THRESHOLD_MS, so per note 448's durable-fix mandate, stop
    // trusting the local "running" state blindly.
    const resolvedStatus = relayStatus || 'stale';
    ccswDebug('ghost-reaper', { jobId, thread: entry.thread, relayStatus: relayStatus || 'unresolved', resolvedStatus });
    logPillTransition(jobId, entry.thread, 'reaped-stale');
    setJobBarStatus(jobId, entry, resolvedStatus);
    updateSessionJobStatus(jobId, resolvedStatus, entry.thread);
  });
}

setInterval(reapSilentPills, SILENCE_REAP_SWEEP_INTERVAL_MS);

function recordSessionJob(jobId, thread, name, summary, isCommand) {
  const job = { id: jobId, thread, name, summary, time: Date.now(), status: 'pending', waiting: false, isCommand: !!isCommand };
  sessionJobs.push(job);
  if (thread) {
    hydrateSessionJobsForThread(thread);
    appendStoredThreadJob(thread, job);
    capSessionJobsForThread(thread);
  }
  updateFaviconForJobState();
}

// Same shape/plumbing as recordSessionJob, but for a dropped dispatch (see
// showDroppedJobBar): status is a terminal 'dropped' rather than 'pending'
// (it will never become 'running'/'done' -- there's no real job behind it),
// and `id` is the dropped pill's own hovercardKey rather than a job.php id.
// buildSwMenuJobRow's click handler checks job.dropped before reopening for
// exactly this reason -- reopenSessionJob/addJobBar expect a real job id to
// poll the relay with, which this isn't.
function recordDroppedSessionJob(id, thread, name, summary, time, blockText) {
  // isCommand mirrors renderStashedBlockDetail's own parse of this same
  // blockText -- there's no live dispatchCcswBlock call behind a dropped
  // entry to hand it the type, so it's re-derived from the stashed block.
  let isCommand = false;
  if (blockText) {
    try {
      const parsed = JSON.parse(blockText);
      isCommand = String(parsed?.type).toLowerCase() === 'bash';
    } catch {
      // Not valid JSON -- leave isCommand false (renders as a CC job).
    }
  }
  const job = { id, thread, name, summary, time, status: 'dropped', dropped: true, waiting: false, blockText: blockText || null, isCommand };
  sessionJobs.push(job);
  if (thread) {
    hydrateSessionJobsForThread(thread);
    appendStoredThreadJob(thread, job);
    capSessionJobsForThread(thread);
  }
  updateFaviconForJobState();
}

// Removes one job from both the in-memory sessionJobs list and its persisted
// per-thread storage entry. Used when a dropped job's stored record is
// superseded by a fresh re-fire dispatch (see buildSwMenuJobRow's tap
// handler) so the menu doesn't accumulate a stale dropped row alongside the
// new one. The in-memory splice runs synchronously (before any await) so a
// same-tick recordSessionJob/recordDroppedSessionJob push for the re-fire
// can never race with it.
async function removeSessionJob(thread, jobId) {
  const idx = sessionJobs.findIndex((j) => j.id === jobId);
  if (idx !== -1) sessionJobs.splice(idx, 1);
  if (!thread) return;
  try {
    const all = await chrome.storage.local.get(SW_MENU_STORAGE_KEY);
    const map = all[SW_MENU_STORAGE_KEY] || {};
    const list = Array.isArray(map[thread]) ? map[thread] : [];
    const filtered = list.filter((job) => job.id !== jobId);
    if (filtered.length === list.length) return;
    map[thread] = filtered;
    await chrome.storage.local.set({ [SW_MENU_STORAGE_KEY]: map });
  } catch (err) {
    console.warn(`[CCswitchboard] SW menu: failed to remove stored job ${jobId} for thread "${thread}":`, err.message);
    handlePossibleContextInvalidation(err);
  }
}

// --- Favicon job-state indicator -----------------------------------------
// Reflects this thread's job state in the browser tab's favicon so a
// backgrounded/minimized tab still telegraphs "still working" / "done" /
// "errored" without the toolbar pills being visible. Derived from
// sessionJobs (this thread's whole job history for this page-load -- see
// above) rather than activeToolbarJobs alone, since a job whose pill was
// closed must not silently stop being reflected here.
const FAVICON_STATE_COLORS = {
  running: '#d97706', // amber-600
  success: '#16a34a', // green-600
  error: '#dc2626', // red-600
};
const FAVICON_SPINNER_FRAME_COUNT = 8;
const FAVICON_SPINNER_FRAME_MS = 120;
// claude.ai sets/re-sets its own <link rel="icon"> (navigation, theme
// changes, etc.) and will silently clobber ours if nothing keeps checking --
// belt-and-braces combo of a head MutationObserver (fires on the actual
// clobber) plus this periodic sweep (catches any update path the observer
// doesn't, e.g. a full head innerHTML replace).
const FAVICON_REASSERT_INTERVAL_MS = 2000;

// Suspected cause of whole-browser freezes (head MutationObserver reasserting
// the favicon, potentially looping) and it does nothing visible anyway --
// disabled entirely until investigated. Flip back to false to re-enable; the
// rest of the feature is left intact below.
const FAVICON_FEATURE_DISABLED = true;

let ccswFaviconState = null; // 'running' | 'success' | 'error' | null
let ccswCurrentIconHref = null;
let ccswOriginalFavicons = null; // captured once, restored when state clears back to null
let ccswSpinnerFrames = null; // cached data URLs, built lazily on first use
let ccswSpinnerTimer = null;
let ccswSpinnerFrameIdx = 0;
const ccswFaviconDotCache = {};

function renderFaviconCanvas(draw) {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  draw(canvas.getContext('2d'));
  return canvas.toDataURL('image/png');
}

function getFaviconDotDataUrl(color) {
  if (!ccswFaviconDotCache[color]) {
    ccswFaviconDotCache[color] = renderFaviconCanvas((ctx) => {
      ctx.beginPath();
      ctx.arc(16, 16, 13, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    });
  }
  return ccswFaviconDotCache[color];
}

function buildFaviconSpinnerFrames() {
  if (ccswSpinnerFrames) return ccswSpinnerFrames;
  const frames = [];
  for (let i = 0; i < FAVICON_SPINNER_FRAME_COUNT; i++) {
    const start = (i / FAVICON_SPINNER_FRAME_COUNT) * Math.PI * 2;
    frames.push(renderFaviconCanvas((ctx) => {
      ctx.beginPath();
      ctx.arc(16, 16, 13, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(217, 119, 6, 0.25)'; // dim track behind the spinner arc
      ctx.fill();
      ctx.beginPath();
      ctx.arc(16, 16, 13, start, start + Math.PI * 1.3);
      ctx.strokeStyle = FAVICON_STATE_COLORS.running;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.stroke();
    }));
  }
  ccswSpinnerFrames = frames;
  return frames;
}

function captureOriginalFavicons() {
  if (ccswOriginalFavicons !== null) return;
  ccswOriginalFavicons = Array.from(document.querySelectorAll('link[rel~="icon"]')).map((el) => ({
    rel: el.getAttribute('rel'),
    type: el.getAttribute('type'),
    sizes: el.getAttribute('sizes'),
    href: el.getAttribute('href'),
  }));
}

// Ensures our own <link> element is in <head>, appended last, with its href
// set to whatever ccswCurrentIconHref currently is -- browsers favor the
// last rel=icon link in document order, so appending last is enough to win
// over claude.ai's own without having to remove/fight over its element. Also
// doubles as the reassert path: safe (and cheap) to call repeatedly even
// when nothing changed, so both the mutation observer and the periodic
// sweep below just call this.
function ensureCcswFaviconEl() {
  let el = document.getElementById('ccsw-favicon');
  if (!el) {
    el = document.createElement('link');
    el.id = 'ccsw-favicon';
    el.rel = 'icon';
  }
  // appendChild always fires a childList mutation -- even when el is already
  // the last child of head, the spec treats re-appending as a remove+insert.
  // faviconHeadObserver watches document.head, so an unconditional call here
  // retriggers the observer, which calls back in here, forever. Only append
  // when el isn't already correctly placed so a no-op call stays a true no-op.
  if (el.parentNode !== document.head || document.head.lastChild !== el) {
    document.head.appendChild(el);
  }
  if (ccswCurrentIconHref && el.getAttribute('href') !== ccswCurrentIconHref) {
    el.setAttribute('href', ccswCurrentIconHref);
  }
  return el;
}

function setFaviconIconHref(href) {
  ccswCurrentIconHref = href;
  ensureCcswFaviconEl();
}

function stopFaviconSpinner() {
  if (ccswSpinnerTimer) {
    clearInterval(ccswSpinnerTimer);
    ccswSpinnerTimer = null;
  }
}

function startFaviconSpinner() {
  if (ccswSpinnerTimer) return;
  const frames = buildFaviconSpinnerFrames();
  ccswSpinnerFrameIdx = 0;
  setFaviconIconHref(frames[0]);
  ccswSpinnerTimer = setInterval(() => {
    ccswSpinnerFrameIdx = (ccswSpinnerFrameIdx + 1) % frames.length;
    setFaviconIconHref(frames[ccswSpinnerFrameIdx]);
  }, FAVICON_SPINNER_FRAME_MS);
}

function restoreOriginalFavicons() {
  stopFaviconSpinner();
  ccswCurrentIconHref = null;
  const ours = document.getElementById('ccsw-favicon');
  if (ours) ours.remove();
  // Only re-add our captured copies if nothing has already re-populated
  // rel=icon links in the meantime (claude.ai's own code may well have).
  if (ccswOriginalFavicons && ccswOriginalFavicons.length && !document.querySelector('link[rel~="icon"]')) {
    ccswOriginalFavicons.forEach((info) => {
      const el = document.createElement('link');
      el.rel = info.rel || 'icon';
      if (info.type) el.type = info.type;
      if (info.sizes) el.sizes = info.sizes;
      if (info.href) el.href = info.href;
      document.head.appendChild(el);
    });
  }
}

function applyFaviconState(state) {
  if (state === ccswFaviconState) {
    if (state) ensureCcswFaviconEl(); // still worth re-asserting placement/href
    return;
  }
  ccswFaviconState = state;

  if (!state) {
    restoreOriginalFavicons();
    return;
  }

  captureOriginalFavicons();
  if (state === 'running') {
    startFaviconSpinner();
  } else {
    stopFaviconSpinner();
    setFaviconIconHref(getFaviconDotDataUrl(FAVICON_STATE_COLORS[state]));
  }
}

// Recomputes this thread's job state and applies the matching favicon. Any
// pending/running job wins outright (still working); otherwise the
// most-recently-dispatched job's outcome decides green vs red -- jobs aren't
// always pushed in strict chronological order (see capSessionJobsForThread),
// so "most recent" is by `time`, not array position. No jobs at all for this
// thread this page-load -- leave/restore claude.ai's own icon.
function updateFaviconForJobState() {
  // Guinea tab (see fv2Allowed, in the fv2 section below): fv2 gets its own
  // last-event-wins state computation (#67) rather than reusing the
  // worst-of aggregation right below -- a pending/running job elsewhere in
  // the thread must NOT keep the icon on amber once the most-recently-
  // dispatched job has already resolved, and vice versa. "most recent" is
  // by `time` for the same reason as the paragraph above. `dropped` (job.php
  // rejected the dispatch, e.g. repo-locked 409) is its own amber `waiting`
  // frame rather than `error` -- content.css's --dropped pill is amber, not
  // red, since "didn't run" isn't a job-reported failure; fv2 now matches.
  // Every other tab falls through to the early-return right after, exactly
  // as today.
  if (fv2Allowed()) {
    let state;
    if (!sessionJobs.length) {
      state = null;
    } else {
      const last = sessionJobs.reduce((a, b) => (b.time > a.time ? b : a));
      if (last.status === 'pending' || last.status === 'running') {
        state = 'running';
      } else if (last.status === 'dropped') {
        state = 'waiting';
      } else if (last.status === 'error' || last.status === 'cancelled') {
        state = 'error';
      } else {
        state = 'success';
      }
    }
    // 'outputting' (claude.ai is generating -- see the GENERATION WATCHER)
    // slots in BELOW a live job and ABOVE everything else. A running job is
    // the thing Jody is actually waiting on, and it's the state the amber
    // spinner exists to show, so it wins outright; every other state here is
    // a SETTLED outcome (success/error, or `waiting` = dropped, "didn't
    // run"), and a settled outcome has no claim on the icon over something
    // happening right now. Once the generation ends the settled state comes
    // straight back -- the next tick recomputes from sessionJobs as before.
    // Gating is inherited, not re-checked: this whole branch is already
    // behind fv2Allowed()'s faviconIndicatorEnabled master toggle, and with
    // the toggle off the fall-through below is inert (FAVICON_FEATURE_DISABLED).
    // The RECORDING half runs regardless -- it never routes through here.
    if (state !== 'running' && outputGenerationActive) state = 'outputting';
    fv2SetState(state);
    return;
  }
  if (FAVICON_FEATURE_DISABLED) return;
  if (!faviconIndicatorEnabled || !sessionJobs.length) {
    applyFaviconState(null);
    return;
  }
  if (sessionJobs.some((job) => job.status === 'pending' || job.status === 'running')) {
    applyFaviconState('running');
    return;
  }
  const last = sessionJobs.reduce((a, b) => (b.time > a.time ? b : a));
  const failed = last.status === 'error' || last.status === 'cancelled' || last.status === 'dropped';
  applyFaviconState(failed ? 'error' : 'success');
}

// Diagnostic-only heartbeat, independent of FAVICON_FEATURE_DISABLED above --
// it never touches the on-screen favicon, so it isn't part of the (currently
// disabled) icon-rendering feature it's named after. Gated behind BOTH
// ccswFaviconDebug and faviconIndicatorEnabled, so a plain user never pays
// for this; started/stopped from loadFaviconDebugEnabled() and the two
// storage.onChanged branches above.
let ccswFaviconHeartbeatTimer = null;
let ccswFaviconHeartbeatSeq = 0;

function syncFaviconHeartbeat() {
  const shouldRun = ccswFaviconDebug === true && faviconIndicatorEnabled === true;
  if (!shouldRun) {
    if (ccswFaviconHeartbeatTimer !== null) {
      clearInterval(ccswFaviconHeartbeatTimer);
      ccswFaviconHeartbeatTimer = null;
    }
    return;
  }
  if (ccswFaviconHeartbeatTimer !== null) return;
  ccswFaviconHeartbeatTimer = setInterval(() => {
    ccswFaviconHeartbeatSeq += 1;
    // Deliberately NOT logged to the durable ring anymore: at 1/sec, urgent
    // (immediate-flush) writes, this alone rolled DEBUG_LOG_KEEP_ROWS's
    // 2000-row ring in minutes, wiping out real forensic events (job
    // dispatch, RedditWatch scan/dispatch) before anyone could pull them.
    // Nothing reads favicon_heartbeat back programmatically -- it was
    // purely for a human to eyeball, which the seq counter above still
    // supports via a debugger/console if ever needed.
  }, 1000);
}

// Disabled via FAVICON_FEATURE_DISABLED above -- neither the observer nor the
// reassertion timer is created while that flag is true. Flip the flag back
// to false to restore both.
if (!FAVICON_FEATURE_DISABLED) {
  const faviconHeadObserver = new MutationObserver(() => {
    if (ccswFaviconState) ensureCcswFaviconEl();
  });
  faviconHeadObserver.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'rel'] });
  setInterval(() => {
    if (ccswFaviconState) ensureCcswFaviconEl();
  }, FAVICON_REASSERT_INTERVAL_MS);
}

// --- Favicon job-state indicator, stage 2 (fv2) ----------------------------
// Ground-up rebuild of the indicator above using static PNG dots -- no
// MutationObserver. Self-contained (prefix fv2) and entirely separate from
// the FAVICON_FEATURE_DISABLED code above, which is left untouched and
// inert. Gated by the single "Favicon status spinner" Settings toggle
// (faviconIndicatorEnabled; see fv2Allowed below), ON by default and now
// live-flippable across every open tab -- originally a single guinea-pig tab
// via sessionStorage('ccswFaviconGuinea'), which fv2Allowed() still honours
// as a fallback OR for backwards compat. Every DOM-touching op
// funnels through fv2Apply()/fv2AdvanceSpinner() (href writes) or
// fv2RemoveCompetitors() (competitor-link removals); all three feed the
// overall hard ceiling, and the first and third additionally feed the main
// rolling-window circuit breaker, so a fight with claude.ai's own favicon
// code -- whether over href or over the competing links themselves --
// degrades to "stops trying" rather than a tight loop (suspected cause of
// the freezes that got the old version disabled). #66 adds a small amount of
// canvas: an animated amber spinner while state === 'running', built lazily
// on first use and cycled by fv2AdvanceSpinner via its own separately-
// budgeted write path (see FV2_SPINNER_BUDGET_* above) so a spinner fault
// can't itself trip the main breaker meant for real favicon fights.

function fv2Allowed() {
  let guinea = false;
  try {
    guinea = sessionStorage.getItem('ccswFaviconGuinea') === '1';
  } catch (err) {
    guinea = false;
  }
  // ON by default: fv2 (the reliable logo spinner) runs unless the single
  // "Favicon status spinner" Settings toggle has been explicitly switched off.
  // faviconIndicatorEnabled is loaded with the not-equal-to-false idiom (see
  // loadFaviconIndicatorEnabled), so a user who has never touched the setting
  // gets the spinner. The old per-tab sessionStorage('ccswFaviconGuinea') key
  // is still honoured as an OR override for testing, but is no longer required.
  return faviconIndicatorEnabled !== false || guinea;
}

// Static 32x32 RGBA PNGs (filled circle, r=13, transparent background) --
// the old buildFv2Svg() SVG data-URL wrote to the DOM fine but Brave never
// actually displayed it (lost icon selection against claude.ai's own
// favicons); PNG is what the earlier canvas-based indicator used and it
// rendered, so these frames are pre-baked PNGs instead. No canvas anywhere
// for these two -- generated offline. `waiting` is the plain solid amber
// dot (formerly keyed `running`, before 'running' grew an animated spinner
// below) -- it's now the static frame for "amber but nothing is actively
// happening" (dropped/held-family outcomes, see updateFaviconForJobState),
// same muted amber (#e0a030) as the --dropped pill in content.css.
// Rotating orange ring, 8 pre-baked 32x32 PNGs -- the 'outputting' state:
// claude.ai itself is generating (see the GENERATION WATCHER above), as
// distinct from OUR job running. Pre-baked constants, exactly like the three
// dots below and unlike the spinner's lazily-canvas-built frames: a plain
// arc is a fixed shape with nothing to decode, so there is nothing to build
// at runtime and therefore no build-failure path to guard.
//
// Deliberately unmistakable against the amber logo spinner in BOTH hue and
// FORM -- a rotating ring with a gap (a plain glyph, no logo) vs. the whole
// logo spinning -- so a glance at the tab strip says which of the two is
// happening without reading anything. A 90-degree gap sweeps around a
// 4px-wide ring (radius 9-13px), stepping 45 degrees per frame.
const FV2_ORBIT_FRAMES = Object.freeze([
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbUlEQVR42u2WwQ0AIAgDncJFnd6XbmACtIJCE77lQoC0tdJrmqOvU7k1poFIG0NBrM1NEBpDGITVxAyBGKPaA7lIKi/0OYn8GPcs8mQ9kwJwB+BsbAqAmkJeiOt5jxou2JHs3xgeci9C/IkSWhsxqBV0a355fQAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbElEQVR42u2WwQ0AIAgDncJFnd6XbmACHCpJm/i0XMSirUnVNEdfp/WscBqItTAKEi0egvAYYhBRkzAEcYxuD/IiubzoOJn8MvJs8swaJgIQQF2A6zF8Poi+GMUkBPYaUi1wbaRSoO+8JH2rDcElFXQTKAsXAAAAAElFTkSuQmCC',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAbElEQVR42u2Wyw0AIAhDncJFnd6TbmACLYimTby2zw9Ia9JrmqOv07oWHAZiDaaCoOEQhMeQBoGawBCMY3R7MB+Sy4tdTia/iHo2eUY1EwGk/RcCKAmQOjNo96XDUwDKDqt/junX77tMm5VQbY18FXRJ5Lr4AAAAAElFTkSuQmCC',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAYklEQVR42mNgGAVDDfwsFvuPDw+YxTRzCKkWU9UhlFpOsSNINZDmjqCVw4kykBqhNyiy7IA7YjQURh0w6oCR54ABz4Yj1/c0qZIHpDoe0AbJgDfJBrxROiia5YOmYzIKaAUAmBMVdHIWpCwAAAAASUVORK5CYII=',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAb0lEQVR42mNgGAVDHfwsFvuPjAfcAXR3CC4H0M0hhBwwaEJjZKULXI4YFDlktJwYDYXB7QBauXTUAWQ7gBqOINlMWjuArgUH2WZRwxEUmUFpdUqV6picxgXVGyTENLdo3iQbUMspccjwbYaPAmoDAB+lFXThlcsVAAAAAElFTkSuQmCC',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAd0lEQVR42u2WMQ7AIAwDeUU/2td3olMlhirCjoEMtsTosxkSpTXLsqrqua+u4sCsz5QtMXIgFm0MGNMc2qhiqcIpnvL3FFMdDnNdwAXKFdg+hscXUYlVrCqRYvyZEUDWH0IiEOOhSyBPPkbbwjNFlh6rR4KtVXoBkBkVdK3amtUAAAAASUVORK5CYII=',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAcElEQVR42mNgGAVDDfwsFvuPjAfMYro5AJfFdHEAIctp6oAB8/WAxjc+B4wMywc0n4/6ftQBtHQA0eaOOoAW2ZBkM2ntALoWRmSbRQ1HUGQGpdUxVapzchokVG/EENMko3mzbUAtp8Qhw7OZPgpoAQDDwhV0wjc4eQAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZElEQVR42mNgGAVDDfwsFvuPDw+YxTRzCKkWU9UhlFpOkSPIMZDmlpOqn6pBP6DZbEDz+YAXMiPH96MOGHXAoHTAaCgMaUdQvTYkpzqmiSNIbZDQzBFDpl049Jvlg6ZjMgpoBQC5KxV0DFoNLwAAAABJRU5ErkJggg==',
]);

const FV2_FRAMES = Object.freeze({
  waiting: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAm0lEQVR4nO2XSwrAIAxEIwy9ikfsGXpEr+Km3Rah/poxCs5WybwkEKMTY2EDSKPCedy5c39FR2lBKBin92pBoGXcCwKGeRojBwGmeQ0E2OYlCIixMCL7XBUgxsKo7L+qADEWNoDsFhgLUwH4Kzr2LJh7ErKrsMZryKpC00KiDdG1kmlB/FpK3wFaQdTW8lYQ2sek16AkaAZbEuABTm5aKWxv0yUAAAAASUVORK5CYII=',
  // Frame 0 of the orbit ring -- the static fallback, same role FV2_FRAMES.waiting
  // plays for the spinner. Stays ORANGE rather than degrading to amber: an
  // orbit-budget trip means "can't animate", not "isn't outputting", and
  // showing amber there would misreport it as a job state.
  outputting: FV2_ORBIT_FRAMES[0],
  success: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAnElEQVR4nO2X3QnAIAyEI9wMDtUdnK47OJRLtK+lUP+aMwreq5L7kkCMToyFDSCN8udx5c5TiI7SAl8wft+rBYGWcS8IGObvGDkIMM1rIMA2L0FAjIUR2eeqADEWRmX/VQWIsbABZLfAWJgKIIXo2LNg7knIrsIaryGrCk0LiTZE10qmBfFrKX0GaAVRW8tbQWgfk16DkqAZbEmAG274WnyltCMRAAAAAElFTkSuQmCC',
  error: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAl0lEQVR4nO2X0QnAIAxEI9wo4v7zSHdpf4tQNTZnFLxfJfeSQIxBnIUDIEpdKd2185hzoLTgahiX93pBYGU8CgKGeRmjBgGmeQ8E2OYtCIizMCP7WhUgzsKs7L+qAHEWDoCcFjgLSwHEnAN7Fqw9CdlV2OM1ZFVBtZBYQwytZFYQv5bSdwAtiNlargWhfUxGDVqCZbAtAR5KbFpXMhLn/AAAAABJRU5ErkJggg==',
});

const FV2_RATE_FLOOR_MS = 500;
const FV2_BREAKER_WINDOW_MS = 60000;
const FV2_BREAKER_LIMIT = 30;
const FV2_REASSERT_INTERVAL_MS = 2000;

// Spinner (#66): while state === 'running', the icon animates a blue arc
// segment on a transparent centre (matching the UI's .ccsw-spinner ring)
// instead of sitting on the plain waiting dot. Frames are canvas-rendered
// PNGs, built lazily on first use (not at module load) so a tab that never
// shows a running job never pays the canvas cost. FV2_SPINNER_ANIMATED=false
// is the static fallback: freeze on frame 0, no cycling, no frame cadence.
const FV2_SPINNER_ANIMATED = true;
// 12 frames at 30-degree steps (was 8 at 45): a few more rotation frames for
// angular smoothness -- built once and cached, so the extra frames are a
// one-time canvas cost, not a per-tick one.
const FV2_SPINNER_FRAME_COUNT = 12;
// ~5 frames/sec (was 500ms/2fps). 12 frames * 200ms = 2.4s/rev. The browser's
// own favicon-render throttle is the practical smoothness limit above this;
// pushing FRAME_MS lower just burns writes the browser coalesces anyway.
const FV2_SPINNER_FRAME_MS = 200;

// Scheduled frame-cycle writes get their own small, fast budget, separate
// from FV2_BREAKER_LIMIT/WINDOW above -- those keep guarding state-change/
// displace/reassert writes (a real fight with claude.ai's own favicon
// code), while this one only guards against the spinner itself somehow
// writing faster than intended. Tripping it self-disables the spinner back
// to the plain static amber dot for the rest of this page load; it does
// NOT take down the rest of fv2 (contrast with FV2_BREAKER_LIMIT, which
// feeds fv2Disable).
const FV2_SPINNER_BUDGET_WINDOW_MS = 1000;
// Sits comfortably above the ~5 writes/sec the animated spinner emits at
// FV2_SPINNER_FRAME_MS=200, so normal animation never trips it, while still
// catching a genuine spinner runaway (writing far faster than one frame per
// FV2_SPINNER_FRAME_MS). This is the ONLY ceiling that guards the spinner
// path -- see fv2AdvanceSpinner, which no longer feeds the hard ceiling below.
const FV2_SPINNER_BUDGET_LIMIT = 8;

// Orbit ('outputting') cadence + budget, mirroring the spinner tier above and
// deliberately NOT sharing its budget: the two never animate at once (see
// updateFaviconForJobState's precedence -- 'running' wins outright), so a
// shared log would only serve to let one path's history trip the other's
// ceiling after a state change. 8 frames * 250ms = a 2s revolution, ~4
// writes/sec, comfortably under the limit while still catching a genuine
// runaway. Same degrade-don't-latch contract as the spinner: a trip drops to
// the static orange frame 0 for the rest of this page load and leaves the
// main paths intact.
const FV2_ORBIT_ANIMATED = true;
const FV2_ORBIT_FRAME_MS = 250;
const FV2_ORBIT_BUDGET_WINDOW_MS = 1000;
const FV2_ORBIT_BUDGET_LIMIT = 8;

// Belt-and-braces overall ceiling across the module's state-change, displace
// and reassert writes (the MAIN paths). The scheduled spinner frame-advance
// is deliberately excluded -- it is already rationed by the spinner-budget
// tier above, and counting its steady ~5/sec against this 200-in-5-minutes
// ceiling would trip it deterministically on any long-running job (~100s).
// The per-budget limits are meant to catch their own runaway case well before
// this, so tripping this specifically means those budgets aren't holding, not
// just ordinary chatter. Full fv2Disable.
const FV2_HARD_CEILING_WINDOW_MS = 300000;
const FV2_HARD_CEILING_LIMIT = 200;

let fv2State = null; // 'running' | 'outputting' | 'waiting' | 'success' | 'error' | null
let fv2Broken = false;
let fv2PendingHref = null;
let fv2PendingTimer = null;
let fv2LastWriteAt = 0;
let fv2WriteLog = []; // timestamps of actual DOM writes, rolling 60s window
let fv2AllWriteLog = []; // main + displace writes only (spinner is excluded -- see fv2AdvanceSpinner), rolling FV2_HARD_CEILING_WINDOW_MS window
let fv2ReassertTimer = null; // single state-aware timer -- see fv2ScheduleTick
let fv2DisplacedCompetitors = null; // {rel,type,sizes,href}[] captured for the current activation, or null when not captured / already restored
let fv2SpinnerFrames = null; // lazily-built canvas PNGs, cached once generated
let fv2SpinnerBuildFailed = false; // canvas threw once -- don't retry every tick
let fv2SpinnerLoadStarted = false; // logo image load kicked off once -- don't re-request while it's in flight
let fv2SpinnerFrameIdx = 0;
let fv2SpinnerWriteLog = []; // spinner-only write timestamps, rolling FV2_SPINNER_BUDGET_WINDOW_MS window
let fv2SpinnerDisabled = false; // budget tripped (or canvas unavailable) -- static amber for the rest of this load
let fv2OrbitFrameIdx = 0;
let fv2OrbitWriteLog = []; // orbit-only write timestamps, rolling FV2_ORBIT_BUDGET_WINDOW_MS window
let fv2OrbitDisabled = false; // budget tripped -- static orange ring for the rest of this load

function fv2LogOp(op, extra) {
  // Deliberately a no-op now: favicon_op used to log here at up to 2/sec
  // (state-change/displace/spinner writes), urgent (immediate-flush), which
  // rolled the shared 2000-row debug_log ring in minutes and wiped out real
  // forensic events (job dispatch, RedditWatch scan/dispatch) before anyone
  // could pull them. Nothing reads favicon_op back programmatically. Call
  // sites are left as-is so re-enabling this is a one-line change if a
  // future favicon investigation genuinely needs it.
}

// Shared cleanup for both the circuit breaker and the catch-all below --
// once broken, fv2Apply refuses every further op until the page reloads.
// Idempotent: fv2Tick's mid-tick guards (see below) mean this can in theory
// run twice for the same activation (e.g. a hard-ceiling trip right after a
// main-breaker trip); a second pass just no-ops through each already-torn-
// down piece rather than double-cleaning anything live.
function fv2Disable(reason, detail) {
  if (fv2Broken) return;
  fv2Broken = true;
  if (fv2ReassertTimer) {
    clearTimeout(fv2ReassertTimer);
    fv2ReassertTimer = null;
  }
  if (fv2PendingTimer) {
    clearTimeout(fv2PendingTimer);
    fv2PendingTimer = null;
  }
  fv2RestoreCompetitors();
  try {
    const el = document.getElementById('ccsw-favicon2');
    if (el) el.remove();
  } catch (err) {
    // Already gone / DOM unavailable -- nothing left to clean up.
  }
  logEvent(reason, detail, null, true);
}

// The actual DOM write, gated by fv2Apply's rate floor below. Appends only
// when not already head's lastChild (unconditional appendChild is itself a
// remove+insert mutation -- see ensureCcswFaviconEl's comment above for why
// that matters) and sets href only when different, so a no-op reassert call
// stays a true no-op and doesn't count toward the breaker.
function fv2Snapshot() {
  return Array.from(document.querySelectorAll('link[rel~="icon"]')).map((l) => ({
    rel: l.rel,
    type: l.type || null,
    sizes: (l.sizes && l.sizes.value) || null,
    href: (l.href || '').slice(0, 40),
    ours: l.id === 'ccsw-favicon2',
  }));
}

// Removes competitor icon links from head, funneled through the same
// breaker bookkeeping as fv2DoApply's writes below -- each removal is a DOM
// write, so a runaway re-add fight (claude.ai fighting back on SPA nav)
// trips the breaker exactly like a href-write fight would, rather than
// looping forever.
function fv2RemoveCompetitors(els) {
  if (!els.length) return;
  for (const el of els) {
    try {
      el.remove();
    } catch (err) {
      // Already gone -- nothing left to remove.
    }
  }
  fv2LogOp('displace', { count: els.length });
  const now = Date.now();
  for (let i = 0; i < els.length; i++) fv2WriteLog.push(now);
  fv2WriteLog = fv2WriteLog.filter((t) => now - t <= FV2_BREAKER_WINDOW_MS);
  if (fv2WriteLog.length > FV2_BREAKER_LIMIT) {
    fv2Disable('favicon_breaker', { writesInWindow: fv2WriteLog.length });
    return;
  }
  fv2RecordHardCeilingWrite(els.length);
}

// Snapshots (as plain data, for later restoration) and removes every
// non-ours icon link currently in head -- once per activation. Guarded by
// fv2DisplacedCompetitors staying non-null for the rest of the activation,
// so a later reassert-sweep removal doesn't re-capture an already-displaced
// DOM and clobber the original snapshot.
function fv2CaptureCompetitors() {
  if (fv2DisplacedCompetitors !== null) return;
  const competitors = Array.from(document.querySelectorAll('link[rel~="icon"]')).filter((l) => l.id !== 'ccsw-favicon2');
  fv2DisplacedCompetitors = competitors.map((l) => ({
    rel: l.rel,
    type: l.type || null,
    sizes: (l.sizes && l.sizes.value) || null,
    href: l.href || null,
  }));
  fv2RemoveCompetitors(competitors);
}

// Recreates the originally-captured competitor links so claude.ai's own
// favicon state is left as we found it once our indicator steps aside.
// try/catch'd on purpose -- a failed restore must not block the caller from
// still cleaning up our own element right after this returns.
function fv2RestoreCompetitors() {
  const saved = fv2DisplacedCompetitors;
  fv2DisplacedCompetitors = null;
  if (!saved || !saved.length) return;
  try {
    for (const c of saved) {
      const el = document.createElement('link');
      el.rel = c.rel;
      if (c.type) el.type = c.type;
      if (c.sizes) el.setAttribute('sizes', c.sizes);
      if (c.href) el.href = c.href;
      document.head.appendChild(el);
    }
  } catch (err) {
    logEvent('favicon_error', { message: err && err.message, context: 'restore_competitors' }, null, true);
  }
}

// create -> declare type/sizes -> href -> append: href is set before the
// element ever mounts, so an empty-href link is never observable in the DOM
// (a suspected factor in Brave not picking our icon over claude.ai's own).
// type/sizes are declared at creation for the same reason -- an
// undeclared/unsized link loses Brave's icon-selection ranking against
// claude.ai's fully-declared SVG + sized PNGs. Pure DOM mechanics, no budget
// bookkeeping -- fv2DoApply (main writes) and fv2AdvanceSpinner (scheduled
// spinner writes) share this, then account the write against their own
// separate budgets. Returns whether it actually touched the DOM, so a no-op
// call doesn't get counted by either caller.
function fv2RawWrite(href) {
  let el = document.getElementById('ccsw-favicon2');
  const needsAppend = !el || el.parentNode !== document.head || document.head.lastChild !== el;
  if (!el) {
    el = document.createElement('link');
    el.id = 'ccsw-favicon2';
    el.rel = 'icon';
    el.setAttribute('type', 'image/png');
    el.setAttribute('sizes', '32x32');
  }
  const needsHref = el.getAttribute('href') !== href;
  if (!needsAppend && !needsHref) return false;

  if (needsHref) el.setAttribute('href', href);
  if (needsAppend) document.head.appendChild(el);
  return true;
}

// Main write path (state-change/reassert), gated by fv2Apply's rate floor
// below. Feeds both the 60s fight-detection breaker and the overall hard
// ceiling -- see fv2AdvanceSpinner for the separately-budgeted spinner path.
function fv2DoApply(href) {
  if (!fv2RawWrite(href)) return;
  fv2LogOp(
    'write',
    ccswFaviconDebug === true
      ? { competitors: fv2Snapshot(), displacedCount: fv2DisplacedCompetitors ? fv2DisplacedCompetitors.length : 0 }
      : null
  );
  fv2RecordMainWrite();
}

function fv2RecordMainWrite() {
  const now = Date.now();
  fv2WriteLog.push(now);
  fv2WriteLog = fv2WriteLog.filter((t) => now - t <= FV2_BREAKER_WINDOW_MS);
  if (fv2WriteLog.length > FV2_BREAKER_LIMIT) {
    fv2Disable('favicon_breaker', { writesInWindow: fv2WriteLog.length });
    return;
  }
  fv2RecordHardCeilingWrite(1);
}

// The belt-and-braces overall ceiling (see FV2_HARD_CEILING_LIMIT above) --
// fed by the main and displace write paths so it sees their true total
// regardless of which per-path budget let each write through. The scheduled
// spinner frame-advance does NOT call this (it would trip deterministically
// on any long job); the spinner-budget tier is its sole ceiling.
function fv2RecordHardCeilingWrite(count) {
  const now = Date.now();
  for (let i = 0; i < count; i++) fv2AllWriteLog.push(now);
  fv2AllWriteLog = fv2AllWriteLog.filter((t) => now - t <= FV2_HARD_CEILING_WINDOW_MS);
  if (fv2AllWriteLog.length > FV2_HARD_CEILING_LIMIT) {
    fv2Disable('favicon_hard_ceiling', { writesInWindow: fv2AllWriteLog.length });
  }
}

// The one choke point every DOM-touching favicon op goes through -- direct
// state-active writes above and the periodic reassert below both call this
// rather than touching the DOM themselves. Rate-floors actual writes to one
// per 500ms (a call sooner than that becomes "pending", applied via a single
// trailing timeout so the final state always lands), and the whole body is
// guarded so any throw self-disables instead of taking a real code path
// down with it.
function fv2Apply(href) {
  if (fv2Broken) return;
  try {
    const now = Date.now();
    if (now - fv2LastWriteAt < FV2_RATE_FLOOR_MS) {
      fv2PendingHref = href;
      if (!fv2PendingTimer) {
        const wait = FV2_RATE_FLOOR_MS - (now - fv2LastWriteAt);
        fv2PendingTimer = setTimeout(() => {
          fv2PendingTimer = null;
          const pending = fv2PendingHref;
          fv2PendingHref = null;
          if (pending === null) return;
          try {
            fv2LastWriteAt = Date.now();
            fv2DoApply(pending);
          } catch (err) {
            fv2Disable('favicon_error', { message: err && err.message });
          }
        }, wait);
      }
      return;
    }
    fv2LastWriteAt = now;
    fv2DoApply(href);
  } catch (err) {
    fv2Disable('favicon_error', { message: err && err.message });
  }
}

// Lazily builds the spinner frames -- the rotating CCSW logo (logo-32.png,
// the same bundled asset the pill uses), drawn at 45-degree steps onto the
// same 32x32 canvas the old blue arc used -- the first time 'running' is
// actually reached, so a tab that never runs a job never touches canvas.
//
// The logo has to be decoded before it can be drawn, so the build is now
// async: the first call kicks off a single Image load (fv2SpinnerLoadStarted
// guards against re-requesting while it's in flight) and returns null. Until
// onload fills fv2SpinnerFrames, callers get null and stay on the static
// waiting dot -- exactly the "frames not ready" path fv2HrefForState already
// had; the existing 2s reassert tick promotes to the spinner once frames land,
// so this adds NO new write path and NO new timer. Memoized three ways: built
// once and cached; load/decode/canvas failure marked fv2SpinnerBuildFailed so
// every later call is a cheap null rather than a retry storm; and load-in-
// flight returns null without re-issuing the request.
function fv2BuildSpinnerFrames() {
  if (fv2SpinnerFrames || fv2SpinnerBuildFailed) return fv2SpinnerFrames;
  if (fv2SpinnerLoadStarted) return null; // decode in flight -- stay on the waiting dot until onload builds
  fv2SpinnerLoadStarted = true;
  try {
    const img = new Image();
    img.onload = () => {
      try {
        const frames = [];
        for (let i = 0; i < FV2_SPINNER_FRAME_COUNT; i++) {
          const canvas = document.createElement('canvas');
          canvas.width = 32;
          canvas.height = 32;
          const ctx = canvas.getContext('2d');
          // Rotate about the centre so the logo spins in place; 12 frames at
          // 30-degree steps = 2.4s/rev at 200ms/frame.
          ctx.translate(16, 16);
          ctx.rotate((i / FV2_SPINNER_FRAME_COUNT) * Math.PI * 2);
          ctx.drawImage(img, -16, -16, 32, 32);
          frames.push(canvas.toDataURL('image/png'));
        }
        fv2SpinnerFrames = frames;
      } catch (err) {
        fv2SpinnerBuildFailed = true;
        logEvent('favicon_error', { message: err && err.message, context: 'build_spinner_frames' }, null, true);
      }
    };
    img.onerror = () => {
      fv2SpinnerBuildFailed = true;
      logEvent('favicon_error', { message: 'logo image load failed', context: 'build_spinner_frames' }, null, true);
    };
    img.src = CCSW_SPINNER_LOGO_URL; // same-extension URL -- canvas stays untainted, toDataURL works
  } catch (err) {
    fv2SpinnerBuildFailed = true;
    logEvent('favicon_error', { message: err && err.message, context: 'build_spinner_frames' }, null, true);
  }
  return fv2SpinnerFrames; // null now; onload fills it, the next reassert tick picks it up
}

// Resolves a state to the href it should show right now. For 'running' this
// is where FV2_SPINNER_ANIMATED and a runtime spinner-budget trip
// (fv2SpinnerDisabled) are reconciled: config-off freezes on frame 0 (still
// the arc, just not cycling); a runtime trip falls all the way back to the
// plain waiting dot, matching "self-disables ... back to static amber".
function fv2HrefForState(state) {
  if (state === 'outputting') {
    // Frames are constants -- nothing to build, so unlike 'running' there is
    // no not-ready path here; the only fallback is a runtime budget trip.
    if (fv2OrbitDisabled) return FV2_ORBIT_FRAMES[0];
    fv2OrbitFrameIdx = 0;
    return FV2_ORBIT_FRAMES[0];
  }
  if (state !== 'running') return FV2_FRAMES[state];
  if (fv2SpinnerDisabled) return FV2_FRAMES.waiting;
  const frames = fv2BuildSpinnerFrames();
  if (!frames) {
    // No frames yet: either the logo is still decoding (async load in flight)
    // or the build failed for good. Only a genuine failure disables the
    // spinner for this load; a decode in flight just shows the waiting dot,
    // and the next reassert tick promotes to the spinner once frames land.
    if (fv2SpinnerBuildFailed) fv2SpinnerDisabled = true;
    return FV2_FRAMES.waiting;
  }
  fv2SpinnerFrameIdx = 0;
  return frames[0];
}

function fv2IsSpinnerCycling() {
  return fv2State === 'running' && FV2_SPINNER_ANIMATED && !fv2SpinnerDisabled && fv2SpinnerFrames !== null;
}

function fv2IsOrbitCycling() {
  return fv2State === 'outputting' && FV2_ORBIT_ANIMATED && !fv2OrbitDisabled;
}

// The orbit ring's counterpart to fv2AdvanceSpinner -- same contract, same
// reasons: called only from fv2Tick's orbit branch, bypasses fv2Apply's rate
// floor (the tick's own 250ms cadence paces this), writes through
// fv2RawWrite so these land against fv2OrbitWriteLog alone, and does NOT
// feed the hard ceiling (a steady ~4/sec would trip the 200-in-5-minutes
// ceiling during any long generation and latch the whole module off). A
// trip or a throw degrades to the static orange ring rather than taking fv2
// down.
function fv2AdvanceOrbit() {
  try {
    fv2OrbitFrameIdx = (fv2OrbitFrameIdx + 1) % FV2_ORBIT_FRAMES.length;
    if (!fv2RawWrite(FV2_ORBIT_FRAMES[fv2OrbitFrameIdx])) return;
    fv2LogOp('orbit_write');

    const now = Date.now();
    fv2OrbitWriteLog.push(now);
    fv2OrbitWriteLog = fv2OrbitWriteLog.filter((t) => now - t <= FV2_ORBIT_BUDGET_WINDOW_MS);
    if (fv2OrbitWriteLog.length > FV2_ORBIT_BUDGET_LIMIT) {
      fv2OrbitDisabled = true;
      logEvent('favicon_orbit_disabled', { writesInWindow: fv2OrbitWriteLog.length }, null, true);
      fv2Apply(FV2_ORBIT_FRAMES[0]);
    }
  } catch (err) {
    fv2OrbitDisabled = true;
    logEvent('favicon_orbit_disabled', { message: err && err.message, context: 'orbit' }, null, true);
    fv2Apply(FV2_ORBIT_FRAMES[0]);
  }
}

// The scheduled cycle write, called only from fv2Tick's spinner branch --
// bypasses fv2Apply's rate floor (the tick's own cadence already paces this)
// and writes straight through fv2RawWrite so these writes land in
// fv2SpinnerWriteLog/FV2_SPINNER_BUDGET_* alone. Deliberately does NOT feed
// the hard ceiling (fv2RecordHardCeilingWrite): its steady ~5/sec would trip
// the 200-in-5-minutes ceiling on any long job and latch the whole module
// off. The spinner-budget tier is this path's sole runaway guard, and
// exceeding it (or any throw here) degrades to the static waiting dot rather
// than latching fv2 off -- contrast fv2DoApply/fv2RemoveCompetitors, whose
// main-path runaways still hit the breaker and hard ceiling.
function fv2AdvanceSpinner() {
  try {
    const frames = fv2SpinnerFrames;
    if (!frames) return;
    fv2SpinnerFrameIdx = (fv2SpinnerFrameIdx + 1) % frames.length;
    if (!fv2RawWrite(frames[fv2SpinnerFrameIdx])) return;
    fv2LogOp('spinner_write');

    const now = Date.now();
    fv2SpinnerWriteLog.push(now);
    fv2SpinnerWriteLog = fv2SpinnerWriteLog.filter((t) => now - t <= FV2_SPINNER_BUDGET_WINDOW_MS);
    if (fv2SpinnerWriteLog.length > FV2_SPINNER_BUDGET_LIMIT) {
      fv2SpinnerDisabled = true;
      logEvent('favicon_spinner_disabled', { writesInWindow: fv2SpinnerWriteLog.length }, null, true);
      fv2Apply(FV2_FRAMES.waiting);
    }
  } catch (err) {
    // Degrade, don't latch: a spinner-path fault drops us to the static
    // waiting dot for the rest of this load (same fallback as a budget trip),
    // leaving the main favicon paths -- and their runaway guards -- intact.
    fv2SpinnerDisabled = true;
    logEvent('favicon_spinner_disabled', { message: err && err.message, context: 'spinner' }, null, true);
    fv2Apply(FV2_FRAMES.waiting);
  }
}

// The single timer fv2 runs (#66): state-aware cadence, FV2_SPINNER_FRAME_MS
// (200ms) while the spinner is actively cycling and 2000ms otherwise (the old
// fixed reassert interval) -- one setTimeout chain rather than two competing
// intervals, so a state change never leaves a stale faster/slower timer ticking
// alongside a fresh one. fv2Broken is rechecked after every step that could
// itself call fv2Disable (spinner write, reassert write, competitor sweep)
// so a mid-tick disable can't have this same tick resurrect the timer it
// just tore down.
function fv2TickIntervalMs() {
  if (fv2IsSpinnerCycling()) return FV2_SPINNER_FRAME_MS;
  if (fv2IsOrbitCycling()) return FV2_ORBIT_FRAME_MS;
  return FV2_REASSERT_INTERVAL_MS;
}

function fv2ScheduleTick() {
  fv2ReassertTimer = setTimeout(fv2Tick, fv2TickIntervalMs());
}

function fv2Tick() {
  fv2ReassertTimer = null;
  if (fv2Broken || !fv2State) return;

  if (fv2IsSpinnerCycling()) {
    fv2AdvanceSpinner();
  } else if (fv2IsOrbitCycling()) {
    fv2AdvanceOrbit();
  } else {
    fv2Apply(fv2HrefForState(fv2State));
  }
  if (fv2Broken || !fv2State) return;

  if (fv2DisplaceEnabled) {
    const reappeared = Array.from(document.querySelectorAll('link[rel~="icon"]')).filter((l) => l.id !== 'ccsw-favicon2');
    if (reappeared.length) fv2RemoveCompetitors(reappeared);
  }
  if (fv2Broken || !fv2State) return;

  fv2ScheduleTick();
}

// null clears our link and the timer outright, and restores whatever
// competitor icon links this activation displaced -- claude.ai also
// restores its own icon on next nav regardless, but leaving stale state
// around in the interim isn't worth the risk. Non-null captures/displaces
// competitors, then routes through fv2Apply and (re)starts fv2Tick's
// single state-aware timer, which itself goes back through fv2Apply's
// guards so a fight with claude.ai's own icon code trips the breaker
// rather than looping.
function fv2SetState(state) {
  if (fv2Broken) return;
  if (state === fv2State) return;
  fv2State = state;

  if (!state) {
    if (fv2ReassertTimer) {
      clearTimeout(fv2ReassertTimer);
      fv2ReassertTimer = null;
    }
    if (fv2PendingTimer) {
      clearTimeout(fv2PendingTimer);
      fv2PendingTimer = null;
    }
    fv2PendingHref = null;
    fv2RestoreCompetitors();
    try {
      const el = document.getElementById('ccsw-favicon2');
      if (el) el.remove();
    } catch (err) {
      // Already gone / DOM unavailable -- nothing left to clean up.
    }
    return;
  }

  if (fv2DisplaceEnabled) fv2CaptureCompetitors();
  if (fv2Broken) return;
  fv2LogOp('set_state');
  fv2Apply(fv2HrefForState(state));
  if (fv2Broken) return;
  if (!fv2ReassertTimer) fv2ScheduleTick();
}

// Recreates the pill (if its bar was closed) and expands its panel so the
// feed is visible again -- addJobBar() is a no-op if the pill is still open.
// addJobBar() always seeds a fresh bar's status text as 'pending' (its
// starting state when a job is first dispatched), so a reopened job needs
// its actual last-known status re-applied here, or a since-finished (or
// cancelled) job would show a spinner and "pending" again.
function reopenSessionJob(job) {
  // Close first -- see the closeSwMenu()-before-window.open() comment on the
  // "Open board" handler for why an explicit close must run before any
  // action that could steal focus, rather than after or via outside-click.
  closeSwMenu();
  addJobBar(job.id, job.thread, job.name, job.summary, undefined, undefined, 'reopen');
  const entry = activeToolbarJobs.get(job.id);
  if (entry) {
    setJobBarStatus(job.id, entry, job.status);
    if (!entry.expanded) toggleJobBar(job.id);
    // A fresh bar always seeds model/prompt as null (see addJobBar) -- fine
    // for a job background.js is still actively polling, but a reopened
    // terminal job dropped out of that poll once it finished, so its
    // hovercard would otherwise be stuck summary-only with no "more info"
    // link. jobs.php serves model/prompt from the job's payload regardless
    // of status, so fetch it once here instead.
    if (entry.model === null && entry.prompt === null) {
      fetchJobDetailsForHovercard(job.id);
    }
  }
}

async function fetchJobDetailsForHovercard(jobId) {
  try {
    const details = await chrome.runtime.sendMessage({ type: 'ccsw-get-job-details', jobId });
    if (details) {
      const entry = activeToolbarJobs.get(jobId);
      if (entry) setJobBarType(jobId, entry, details.isCommand);
      applyJobHovercardDetails(jobId, details.model, details.prompt, details.isCommand, details.silenceTimeout, details.summary);
    }
  } catch (err) {
    console.warn(`[CCswitchboard] toolbar: failed to fetch job ${jobId} details for hovercard:`, err.message);
    handlePossibleContextInvalidation(err);
  }
}

function formatElapsedSince(startMs) {
  const elapsed = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const h = Math.floor(elapsed / 3600);
  const m = Math.floor((elapsed % 3600) / 60);
  const s = elapsed % 60;
  if (h > 0) return `${h}h ${m}m ${s}s ago`;
  if (m > 0) return `${m}m ${s}s ago`;
  return `${s}s ago`;
}

// --- Unified disclosure contract (epic #11, Stage S1) -----------------
// Additive helper introduced ahead of migrating the toolbar's several
// menus/dialogs onto one open/close contract. NOTHING is wired to it yet:
// S1 only builds the helper so later stages can move one surface at a time
// (order: Advanced -> Settings -> Action-list -> SW menu last). No existing
// menu's behaviour changes in this stage.
//
// The core problem it centralises: "outside click closes the menu" is wrong
// when a press STARTS inside the menu but the browser reports the resulting
// 'click' on an outside element. That happens whenever mousedown and mouseup
// land on different nodes -- the click then fires on their nearest common
// ancestor (often document.body): a top-edge resize drag, a scroll-hold
// chevron dragged off itself, or a text selection released outside. Before
// this contract the SW-menu resize was guarded by a bespoke swMenuResizing
// flag (removed in S5) while the scroll-hold and selection cases were
// unguarded latent bugs. Per-interaction boolean flags don't scale -- every
// new inner control needs its own and someone always forgets -- so this
// decides by PROVENANCE instead: a capture-phase pointerdown records whether
// the press began inside the disclosure's own scope, and the capture-phase
// click consults that record rather than trusting the click's reported
// target. Press-began-inside -> never an outside-close, wherever the
// synthesized click lands. One rule retires the resize synth-click, the
// scroll-hold case, and selection drags with no per-interaction flags.

// The five toolbar-owned roots that all count as "inside" for outside-click
// purposes -- a click anywhere in the extension's own UI must not close a
// disclosure. This is the same selector list already used ad hoc elsewhere
// (e.g. the send-button suppression around findComposerInputNear); the
// contract takes it as the default ignoreWithin so every migrated surface
// shares one definition of "ours". Semantics unchanged -- the SAME five
// selectors, just named once.
const SHARED_DISCLOSURE_SCOPE = '#ccsw-toolbar, #ccsw-job-hovercard, #ccsw-sw-menu, #ccsw-plan-pills, #ccsw-action-list-pill';

// Module-level stack of currently-open disclosures, most-recently-opened
// last. Escape closes only the topmost so stacked dialogs (e.g. Advanced
// opened over Settings) peel off one level per keypress rather than all at
// once.
const disclosureOpenStack = [];

// createDisclosure({ el|el(), trigger, onOpen, onClose, closeOnOutside,
// closeOnEscape, closeOnHide, closeWhenDetached, ignoreWithin })
//   -> { open, close, toggle, holdOpen, isOpen }
// See the section comment above for the design. All document listeners are
// attached per-open and detached per-close -- nothing is always-on, and the
// only timer (closeWhenDetached) is per-open and cleared on close.
function createDisclosure(options) {
  const {
    el: elOption,
    trigger = null,
    onOpen = null,
    onClose = null,
    closeOnOutside = true,
    closeOnEscape = true,
    closeOnHide = false,
    closeWhenDetached = false,
    ignoreWithin = SHARED_DISCLOSURE_SCOPE,
  } = options || {};

  let isOpenState = false;
  let panelEl = null;           // resolved element while open (from el or el())
  let heldCount = 0;            // active holdOpen() latches
  let pendingClose = false;     // a deferred close awaiting the last latch release
  let pressBeganInside = false; // provenance recorded by the pointerdown listener
  let detachTimer = null;       // closeWhenDetached interval handle

  // Resolve `el` (element) or `el()` (lazy factory, e.g. a dialog built on
  // first open). Called once per open, before any listener is attached, so a
  // factory that throws aborts the open cleanly with nothing stranded.
  function resolvePanel() {
    return typeof elOption === 'function' ? elOption() : elOption;
  }

  // "Inside" = the panel, its trigger, or any toolbar-owned scope. Used by
  // both the pointerdown provenance record and the click's fallback check. A
  // text node (selection endpoints can be text nodes) is tested via its
  // parent element, since only Elements have closest().
  function isInsideScope(node) {
    if (!(node instanceof Node)) return false;
    if (panelEl && panelEl.contains(node)) return true;
    if (trigger && trigger.contains(node)) return true;
    if (ignoreWithin) {
      const scopeEl = node instanceof Element ? node : node.parentElement;
      if (scopeEl && scopeEl.closest(ignoreWithin)) return true;
    }
    return false;
  }

  function onDocPointerDown(evt) {
    pressBeganInside = isInsideScope(evt.target);
  }

  // Rule 2 in the flesh: a press that began inside never triggers an
  // outside-close, no matter where the resulting click is reported. The flag
  // is consumed (reset) on every click so a later keyboard-synthesized click
  // -- which fires no pointerdown -- can't inherit a stale "inside" reading;
  // in that no-pointerdown case we fall back to the click target's own scope.
  function onDocClick(evt) {
    const began = pressBeganInside;
    pressBeganInside = false;
    if (began) return;
    if (isInsideScope(evt.target)) return;
    requestClose();
  }

  function onDocKeyDown(evt) {
    if (evt.key !== 'Escape' && evt.key !== 'Esc') return;
    // Only the topmost open disclosure reacts, so a single Escape closes one
    // level of a stack rather than every open disclosure at once.
    if (disclosureOpenStack[disclosureOpenStack.length - 1] !== instance) return;
    evt.stopPropagation();
    requestClose();
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') requestClose();
  }

  function checkDetached() {
    if (panelEl && !panelEl.isConnected) requestClose();
  }

  function attachListeners() {
    if (closeOnOutside) {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('click', onDocClick, true);
    }
    if (closeOnEscape) document.addEventListener('keydown', onDocKeyDown, true);
    if (closeOnHide) document.addEventListener('visibilitychange', onVisibilityChange);
    if (closeWhenDetached) detachTimer = setInterval(checkDetached, 1000);
  }

  function detachListeners() {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onDocKeyDown, true);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (detachTimer !== null) {
      clearInterval(detachTimer);
      detachTimer = null;
    }
  }

  // The automatic closers (outside click, Escape, detach, hide) route through
  // here so an active holdOpen() latch defers them: the reason is remembered
  // (pendingClose) and re-applied when the last latch releases, never dropped.
  function requestClose() {
    if (!isOpenState) return;
    if (heldCount > 0) {
      pendingClose = true;
      return;
    }
    close();
  }

  function open() {
    if (isOpenState) return;
    let resolved;
    try {
      resolved = resolvePanel();
    } catch (err) {
      console.warn('[CCswitchboard] disclosure: panel factory threw, open aborted:', err);
      return;
    }
    panelEl = resolved || null;
    isOpenState = true;
    pressBeganInside = false;
    pendingClose = false;
    heldCount = 0;
    // Listeners + open state + stack membership are all in place BEFORE
    // onOpen runs, so a throwing render can't strand a visible overlay with
    // no way to close it (the 0292827 lesson): close() still works fully.
    attachListeners();
    disclosureOpenStack.push(instance);
    try {
      if (onOpen) onOpen(panelEl);
    } catch (err) {
      console.warn('[CCswitchboard] disclosure: onOpen threw:', err);
    }
  }

  // Idempotent and never-throw: a double close is a no-op, and an onClose
  // that throws still leaves the disclosure fully torn down (listeners
  // removed, timer cleared, stack popped) rather than half-open.
  function close() {
    if (!isOpenState) return;
    isOpenState = false;
    detachListeners();
    const idx = disclosureOpenStack.indexOf(instance);
    if (idx !== -1) disclosureOpenStack.splice(idx, 1);
    heldCount = 0;
    pendingClose = false;
    pressBeganInside = false;
    const closingEl = panelEl;
    panelEl = null;
    try {
      if (onClose) onClose(closingEl);
    } catch (err) {
      console.warn('[CCswitchboard] disclosure: onClose threw (torn down anyway):', err);
    }
  }

  function toggle() {
    if (isOpenState) close();
    else open();
  }

  // Explicit latch for interactions that outlive pointer provenance -- e.g.
  // the SW-menu resize drag continues past blur/pointercancel, well after the
  // pointerdown that began it. While any latch is held, automatic closes are
  // deferred (see requestClose) and re-evaluated when the last one releases.
  // Returns an idempotent release fn; a resize's blur/pointercancel/failsafe
  // teardown paths each map to one release call.
  function holdOpen() {
    heldCount += 1;
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      if (heldCount > 0) heldCount -= 1;
      if (heldCount === 0 && pendingClose) close();
    };
  }

  const instance = {
    open,
    close,
    toggle,
    holdOpen,
    get isOpen() {
      return isOpenState;
    },
  };
  return instance;
}

let swMenuTimer = null;
let swMenuTimeEls = [];

// #11 S5 (final stage): the SW menu is a lightweight anchored popover driven by
// a createDisclosure instance, so open/close/toggle, outside-click (by
// pointerdown provenance), Escape (topmost-only), and tab-away close all come
// from the shared contract -- no bespoke swMenuOpen flag, no per-open
// onSwMenuOutsideClick listener, and (crucially) no per-interaction
// swMenuResizing flag: the resize drag now holds the disclosure open with a
// holdOpen() latch instead (see startSwMenuResize). Built lazily on first use,
// once addSwMenuButton has created swMenuPanelEl.
let swMenuDisclosure = null;

function getSwMenuDisclosure() {
  if (swMenuDisclosure) return swMenuDisclosure;
  swMenuDisclosure = createDisclosure({
    // swMenuPanelEl is built once in addSwMenuButton and never recreated, so a
    // plain-element el would be fine; the factory form just defers reading it
    // to the first open, matching the other migrated surfaces.
    el: () => swMenuPanelEl,
    // No `trigger`: the SW button lives inside #ccsw-sw-menu, already part of
    // the shared ignore-scope, so a click on it counts as "inside" without
    // naming it here (same as the action-list pill's disclosure).
    closeOnOutside: true,
    closeOnEscape: true,
    // Anchored popover, not a workspace dialog: close on tab-away like the
    // other pill popovers. This supersedes the former always-on visibilitychange
    // listener that closed the menu on tab-BACK -- with closeOnHide the menu is
    // already closed by the time the tab returns.
    closeOnHide: true,
    onOpen: (panelEl) => {
      applySwMenuHeight();
      // Add the open class before rendering -- renderSwMenuPanel's scroll-button
      // check reads scrollHeight/clientHeight, which need the panel to already
      // be laid out (display: flex) to measure correctly.
      panelEl.classList.add('ccsw-sw-menu-panel--open');
      swMenuTimer = setInterval(tickSwMenuTimes, 1000);
      try {
        renderSwMenuPanel();
      } catch (err) {
        console.warn('[CCswitchboard] SW menu render failed:', err);
        handlePossibleContextInvalidation(err);
      }
    },
    onClose: (panelEl) => {
      panelEl?.classList.remove('ccsw-sw-menu-panel--open');
      clearInterval(swMenuTimer);
      swMenuTimer = null;
      swMenuTimeEls = [];
      stopSwMenuScrollHold();
    },
  });
  return swMenuDisclosure;
}

// Read-only "is the menu currently open" used by the render-if-open gates
// elsewhere. Avoids forcing the disclosure into existence just to answer false
// before it has ever been opened.
function isSwMenuOpen() {
  return !!swMenuDisclosure && swMenuDisclosure.isOpen;
}

// Safety net for the resize hold latch: a resize drag never legitimately runs
// this long, so if every other release path (mouseup, blur, pointercancel) is
// somehow missed the failsafe still fires onAbort and releases the hold (see
// startSwMenuResize) rather than leaving the menu latched open.
const SW_MENU_RESIZE_FAILSAFE_MS = 10000;

// The job list (#ccsw-sw-menu-jobs) is itself the scrollable region -- the
// listening/board rows and the scroll chevrons all sit outside it as fixed
// siblings in panelEl, so only the job rows ever scroll and none of them get
// wiped out by renderSwMenuPanel's re-renders (which only touch this node).
let swMenuListEl = null;
let swMenuScrollUpEl = null;
let swMenuScrollDownEl = null;
// The listening toggle and "Open board" row are built once (in
// addSwMenuButton) and never recreated, unlike the job rows below. A job's
// status/waiting flag can flip asynchronously (chrome.runtime messages)
// while the menu is open, and renderSwMenuPanel used to rebuild the *entire*
// list -- including these two rows -- on every such tick. If that landed
// between a click's mousedown and mouseup, the row the user was clicking got
// swapped out from under the gesture, so the browser never dispatched the
// click at all: neither the row's action nor closeSwMenu() ran, leaving the
// menu stuck open. Keeping them as stable, never-replaced nodes and only
// rebuilding the job rows (into swMenuJobsListEl) avoids that race.
let swMenuListeningItemEl = null;
let swMenuGlobalListeningItemEl = null;
let swMenuJobsListEl = null;
let swMenuScrollHoldTimeout = null;
let swMenuScrollRepeatInterval = null;

// job.id -> { itemEl, ledWrapEl, ledEl, waitingDotEl, nameEl, timeEl }.
// renderSwMenuPanel used to rebuild every job row from scratch (innerHTML =
// '') on each call, which had the exact same click-swallowing race described
// above for the listening/board rows -- if a status/waiting message ticked
// in between a job row's mousedown and mouseup, that row got replaced out
// from under the gesture and neither reopenSessionJob() nor closeSwMenu()
// ran, leaving the menu stuck open. This is especially likely right after
// switching back to the tab (e.g. after "Open board" opened a new one):
// background tabs get their message delivery throttled, so a burst of
// queued job-status updates tends to land right as the user clicks a row to
// check on it. Reusing/updating existing row nodes instead of recreating
// them removes the window entirely.
let swMenuJobRowEls = new Map();

const SW_MENU_SCROLL_STEP = 48;
const SW_MENU_SCROLL_HOLD_DELAY = 350;
const SW_MENU_SCROLL_REPEAT_INTERVAL = 60;

function tickSwMenuTimes() {
  swMenuTimeEls.forEach(({ el, time }) => {
    el.textContent = formatElapsedSince(time);
  });
}

// Thin wrapper over the disclosure so the many existing closeSwMenu() call
// sites (row clicks, "Open board", Settings/Advanced menu items, etc.) keep
// working unchanged. Idempotent + never-throw via the contract's close().
function closeSwMenu() {
  getSwMenuDisclosure().close();
}

// Enables/disables the up/down scroll chevrons based on whether the job list
// has more content in that direction. The buttons are always visible; when a
// direction can't scroll (already at that limit, or too few items to fill the
// scroll area) the button is greyed out and disabled instead of hidden.
// Reading scrollTop/clientHeight/scrollHeight forces a synchronous layout, so
// this is safe to call right after the panel becomes visible (no need to wait
// for the next paint).
function updateSwMenuScrollButtons() {
  if (!swMenuListEl) return;
  const canScrollUp = swMenuListEl.scrollTop > 1;
  const canScrollDown = swMenuListEl.scrollTop + swMenuListEl.clientHeight < swMenuListEl.scrollHeight - 1;
  swMenuScrollUpEl.classList.toggle('ccsw-sw-menu-scroll-btn--disabled', !canScrollUp);
  swMenuScrollUpEl.disabled = !canScrollUp;
  swMenuScrollDownEl.classList.toggle('ccsw-sw-menu-scroll-btn--disabled', !canScrollDown);
  swMenuScrollDownEl.disabled = !canScrollDown;
}

function scrollSwMenuList(direction) {
  if (!swMenuListEl) return;
  swMenuListEl.scrollBy({ top: direction * SW_MENU_SCROLL_STEP, behavior: 'auto' });
  updateSwMenuScrollButtons();
}

// A single click scrolls once immediately; holding past SW_MENU_SCROLL_HOLD_DELAY
// starts continuous scrolling until stopSwMenuScrollHold() fires on mouseup/blur.
function startSwMenuScrollHold(direction) {
  stopSwMenuScrollHold();
  scrollSwMenuList(direction);
  swMenuScrollHoldTimeout = setTimeout(() => {
    swMenuScrollRepeatInterval = setInterval(() => scrollSwMenuList(direction), SW_MENU_SCROLL_REPEAT_INTERVAL);
  }, SW_MENU_SCROLL_HOLD_DELAY);
}

function stopSwMenuScrollHold() {
  clearTimeout(swMenuScrollHoldTimeout);
  clearInterval(swMenuScrollRepeatInterval);
  swMenuScrollHoldTimeout = null;
  swMenuScrollRepeatInterval = null;
}

// Syncs the persistent "Listening: On/Off" row's label/class from the
// current listeningEnabled flag. Called instead of a full renderSwMenuPanel
// so toggling it doesn't rebuild (and risk swapping out from under a click)
// the rest of the menu -- see the swMenuListeningItemEl comment above.
function updateSwMenuListeningItem() {
  const el = document.getElementById('ccsw-sw-menu-listening');
  if (!el) return;
  el.classList.toggle('ccsw-sw-menu-item--listening-off', !listeningEnabled);
  el.textContent = `Listening: ${listeningEnabled ? 'On' : 'Off'}`;
}

// Syncs the persistent "Global listening: On/Off" row -- same reasoning as
// updateSwMenuListeningItem above, plus this one is also called from the
// storage.onChanged listener so a toggle made in another tab reflects here
// without a reload.
function updateSwMenuGlobalListeningItem() {
  const el = document.getElementById('ccsw-sw-menu-global-listening');
  if (!el) return;
  el.classList.toggle('ccsw-sw-menu-item--listening-off', !globalListeningEnabled);
  el.textContent = `Global listening: ${globalListeningEnabled ? 'On' : 'Off'}`;
}

// Syncs the SW menu's autopilot-window row for THIS tab's thread. Disarmed it
// reads "Autopilot window - start 30m"; armed it shows the live countdown
// "Autopilot 24m left - tap to disarm". A plain single-row toggle: click arms
// when disarmed, disarms when armed (see the click handler in addSwMenuButton).
function updateSwMenuAutopilotItem(armed = autopilotArmedFor(hydratedThread)) {
  const el = document.getElementById('ccsw-sw-menu-autopilot');
  if (!el) return;
  el.classList.toggle('ccsw-sw-menu-item--autopilot-armed', armed);
  if (armed) {
    el.textContent = `Autopilot ${autopilotTimeLeftLabel(hydratedThread)} - tap to disarm`;
    el.title = 'Autopilot window is armed: held jobs auto-dispatch without a fresh send. Tap to disarm now.';
  } else {
    const mins = Math.round(autopilotDurationMs() / 60000);
    el.textContent = `Autopilot window - start ${mins}m`;
    el.title = `Arm a ${mins}-minute window: held jobs in this thread auto-dispatch with no fresh human send, then it auto-expires.`;
  }
}

// Syncs the SW menu's autopilot-window DURATION lever -- a separate row from the
// arm/disarm toggle. Shows the current effective preset (ccswAutopilotWindowMinutes
// if set, else AUTOPILOT_DEFAULT_MINUTES) in compact form; a click steps up the
// ladder (see the handler in addSwMenuButton). Refreshed on the same 1s tick as
// updateSwMenuAutopilotItem via updateAutopilotUi.
function updateSwMenuAutopilotDurationItem() {
  const el = document.getElementById('ccsw-sw-menu-autopilot-duration');
  if (!el) return;
  const label = formatAutopilotMinutes(autopilotWindowMinutes);
  el.textContent = `Autopilot window: ${label} (tap to extend)`;
  el.title = `Sets how long a newly armed autopilot window lasts (currently ${label}). Tap to step up to the next preset; wraps back to ${formatAutopilotMinutes(AUTOPILOT_WINDOW_LADDER[0])} from the top. Applies to the next window you arm, not one already running.`;
}

// The always-visible armed indicator: a small badge on the ever-present SW menu
// button, so autopilot is never silently armed. Shown only while THIS tab's
// thread is armed; its tooltip carries the live time-left.
function updateAutopilotIndicator(armed = autopilotArmedFor(hydratedThread)) {
  const badge = document.getElementById('ccsw-autopilot-badge');
  if (!badge) return;
  badge.classList.toggle('ccsw-autopilot-badge--on', armed);
  badge.title = armed ? `Autopilot armed - ${autopilotTimeLeftLabel(hydratedThread)}` : '';
}

function buildSwMenuJobRow(jobId) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'ccsw-sw-menu-item';

  // ledEl and (if waiting) waitingDotEl share one wrapper so this stays
  // exactly 3 top-level flex children (matching .ccsw-sw-menu-item's
  // justify-content: space-between layout) whether or not the waiting dot
  // is present -- a 4th sibling would shift how space-between divides the
  // row's free space and throw off the name/time spacing.
  const ledWrapEl = document.createElement('span');
  ledWrapEl.className = 'ccsw-sw-menu-item-led-wrap';

  const ledEl = document.createElement('span');
  ledWrapEl.appendChild(ledEl);

  const spinnerEl = document.createElement('span');
  spinnerEl.className = 'ccsw-sw-menu-item-spinner';
  ensureSpinnerLogo(spinnerEl);
  ledWrapEl.appendChild(spinnerEl);

  // Type glyph goes INSIDE ledWrapEl, right after the LED -- not as a new
  // top-level row child -- so .ccsw-sw-menu-item stays at exactly 3
  // top-level flex children (see the comment above ledWrapEl). Old stored
  // records predate isCommand and read as undefined, which is treated as
  // falsy (CC job/spark), matching the pill's own isCommand=false default.
  const job = sessionJobs.find((j) => j.id === jobId);
  if (job && job.isCommand) {
    const typeGlyphEl = document.createElement('span');
    typeGlyphEl.className = 'ccsw-job-bar-type-glyph';
    typeGlyphEl.textContent = '>_';
    ledWrapEl.appendChild(typeGlyphEl);
  } else {
    ledWrapEl.appendChild(buildClaudeSparkIcon());
  }

  const nameEl = document.createElement('span');
  nameEl.className = 'ccsw-sw-menu-item-name';

  const timeEl = document.createElement('span');
  timeEl.className = 'ccsw-sw-menu-item-time';

  item.append(ledWrapEl, nameEl, timeEl);
  // Looks the current job up by id (rather than closing over the job object
  // passed in at row-creation time) so a row built for an earlier tick still
  // reopens whatever that id's latest sessionJobs entry is.
  item.addEventListener('click', () => {
    const current = sessionJobs.find((j) => j.id === jobId);
    if (!current) return;
    if (current.pendingDelivery) {
      // D2: a delivered/parked pending-delivery pill's history row (see
      // recordPendingDeliverySessionJob) -- like a dropped entry, there's no
      // real job.php id behind it, so reopenSessionJob/addJobBar can't poll
      // for it. Purely informational; the row's name/summary already show
      // kind, origin, and preview, so there's nothing further to reopen.
      closeSwMenu();
      return;
    }
    if (current.dropped) {
      // A dropped entry has no real job id behind it (see
      // recordDroppedSessionJob), so reopenSessionJob/addJobBar can't poll
      // the relay for it. Menu rows stay plain tappable rows with no button
      // of their own (consistent with every other entry) -- the actual
      // re-fire affordance lives on a PILL instead, same as tapping a normal
      // entry reopens its pill via reopenSessionJob. showDroppedJobBar(null,
      // ...) with an existing id reopens without re-recording/re-persisting
      // a duplicate session-job entry (see its isReopen branch). Records
      // from before blockText was stashed just show info, no re-fire button.
      closeSwMenu();
      console.log(`[CCswitchboard] SW menu: reopening dropped-job pill for "${current.name}".`);
      showDroppedJobBar(null, {
        id: current.id,
        name: (current.name || 'Job').replace(/ - repo busy$/, ''),
        summary: current.summary,
        thread: current.thread,
        blockText: current.blockText,
        droppedAt: current.time,
      });
      return;
    }
    reopenSessionJob(current);
  });

  return { itemEl: item, ledWrapEl, ledEl, spinnerEl, waitingDotEl: null, nameEl, timeEl };
}

function updateSwMenuJobRow(row, job) {
  row.itemEl.title = [job.thread, job.summary].filter(Boolean).join('\n');

  const isRunning = job.status === 'pending' || job.status === 'running';
  if (isRunning) {
    row.ledEl.style.display = 'none';
    row.spinnerEl.style.display = '';
  } else {
    row.ledEl.style.display = '';
    row.spinnerEl.style.display = 'none';
  }
  row.ledEl.className = `ccsw-sw-menu-item-led ${ledClassForJobStatus(job.status)}`;

  if (job.waiting && !row.waitingDotEl) {
    const waitingDotEl = document.createElement('span');
    waitingDotEl.className = 'ccsw-sw-menu-item-waiting-dot';
    waitingDotEl.title = 'Result waiting to be delivered to chat';
    row.ledWrapEl.appendChild(waitingDotEl);
    row.waitingDotEl = waitingDotEl;
  } else if (!job.waiting && row.waitingDotEl) {
    row.waitingDotEl.remove();
    row.waitingDotEl = null;
  }

  row.nameEl.textContent = job.name || `#${job.id}`;
  row.timeEl.textContent = formatElapsedSince(job.time);
  swMenuTimeEls.push({ el: row.timeEl, time: job.time });
}

function renderSwMenuPanel() {
  if (!swMenuJobsListEl) return;
  updateSwMenuListeningItem();
  swMenuTimeEls = [];

  const openableJobs = sessionJobs.filter((job) => !job.pendingDelivery);

  if (openableJobs.length === 0) {
    swMenuJobRowEls.forEach((row) => row.itemEl.remove());
    swMenuJobRowEls.clear();
    if (!swMenuJobsListEl.querySelector('.ccsw-sw-menu-empty')) {
      const empty = document.createElement('div');
      empty.className = 'ccsw-sw-menu-empty';
      empty.textContent = 'No jobs dispatched yet this session.';
      swMenuJobsListEl.appendChild(empty);
    }
    updateSwMenuScrollButtons();
    return;
  }

  swMenuJobsListEl.querySelector('.ccsw-sw-menu-empty')?.remove();

  const seenIds = new Set();
  [...openableJobs]
    .sort((a, b) => b.time - a.time)
    .slice(0, SW_MENU_RENDER_CAP)
    .forEach((job) => {
      seenIds.add(job.id);
      let row = swMenuJobRowEls.get(job.id);
      if (!row) {
        row = buildSwMenuJobRow(job.id);
        swMenuJobRowEls.set(job.id, row);
      }
      updateSwMenuJobRow(row, job);
      // appendChild on an already-attached node moves it to the end instead
      // of cloning -- this is what lets rows reorder by time without ever
      // detaching+recreating a node the user might be mid-click on.
      swMenuJobsListEl.appendChild(row.itemEl);
    });

  for (const [id, row] of swMenuJobRowEls) {
    if (!seenIds.has(id)) {
      row.itemEl.remove();
      swMenuJobRowEls.delete(id);
    }
  }

  updateSwMenuScrollButtons();
}

// Maps a job's tracked status to the SW menu row's LED color. Jobs recorded
// before this LED existed (or hydrated from old storage) have no status
// field at all -- treated as done, since they finished long before this
// page load and nothing is still polling them.
function ledClassForJobStatus(status) {
  if (status === 'pending' || status === 'running') return 'ccsw-sw-menu-item-led--running';
  if (status === 'error') return 'ccsw-sw-menu-item-led--error';
  if (status === 'cancelled') return 'ccsw-sw-menu-item-led--cancelled';
  if (status === 'dropped') return 'ccsw-sw-menu-item-led--dropped';
  // D2: 'delivered' reuses the plain --done green (it's a successful
  // terminal outcome, same family); 'parked' gets --dropped's amber -- same
  // "didn't complete cleanly, worth a second look" read as an actual drop.
  if (status === 'parked') return 'ccsw-sw-menu-item-led--dropped';
  return 'ccsw-sw-menu-item-led--done';
}

// Thin wrappers over the disclosure. The redundant-re-open guard, listener
// setup, height apply, open-class, timer and render all live in the
// disclosure's onOpen (and its own idempotent open()); the render-throw safety
// the old inline body called out is now the contract's guarantee (listeners +
// open state are in place before onOpen runs, and a throwing onOpen is caught).
function toggleSwMenu() {
  getSwMenuDisclosure().toggle();
}

// Wired to the single top-edge (.ccsw-resize-n) handle appended to panelEl in
// addSwMenuButton below -- unlike every other startPanelResize consumer,
// #ccsw-sw-menu-panel is a plain in-flow (position: static) flex child of the
// bottom-anchored #ccsw-sw-menu container, not an independently positioned
// panel of its own. That's deliberate: startPanelResize's left/top pinning
// has no effect on a static element (left/top only apply to positioned
// boxes), so it becomes a no-op here and only the height it sets actually
// lands -- which is exactly what's wanted, since growing panelEl's height
// while the container's bottom stays fixed (#ccsw-sw-menu's own bottom: 70px)
// naturally pushes the whole menu upward, i.e. resizes from the top. Giving
// panelEl its own `position` (e.g. relative) instead would make that same
// left/top pinning start actually moving the box -- which is exactly the
// kind of layout "wedging" this rewrite is trying to avoid, so don't add one.
function startSwMenuResize(evt, panelEl) {
  // Hold the disclosure open for the whole drag with the contract's holdOpen()
  // latch, replacing the old bespoke swMenuResizing flag. While this latch is
  // held, any outside-close / Escape / tab-away close the disclosure would
  // otherwise apply is DEFERRED and re-evaluated when the latch releases --
  // never silently dropped. The drag's mouseup can synthesize a 'click' whose
  // target lands outside #ccsw-sw-menu (mousedown and mouseup land on different
  // nodes, so the browser fires the click on their common ancestor, often
  // document.body); the latch means that synthesized click can't slip a close
  // through mid-drag, and pointerdown provenance (the press began inside the
  // panel) independently blocks it too.
  const releaseHold = getSwMenuDisclosure().holdOpen();
  // Let the drag grow past the panel's default 416px CSS max-height, up to
  // the min(600px, 80vh) cap -- see swMenuMaxHeight(). startPanelResize's own
  // RESIZE_MIN_HEIGHT floor (250px) still applies as the lower bound.
  panelEl.style.maxHeight = `${swMenuMaxHeight()}px`;
  const cancelPanelResize = startPanelResize(evt, panelEl, 'n');

  let failsafeTimer = null;

  // Single teardown path for every way a resize drag can end -- normal
  // mouseup, window blur (tab switch / focus loss mid-drag), pointercancel
  // (touch/pointer interrupted), or the failsafe timeout below. Funnelling
  // them all through here means there's exactly one place that removes the
  // listeners, clears the failsafe, persists the height, and releases the
  // hold latch -- no path can do a partial cleanup and leave something
  // stranded (or the disclosure latched open). releaseHold() is idempotent, so
  // a double end (e.g. an abort followed by a late mouseup) is harmless; and it
  // applies any close that was deferred while the drag was in progress, so an
  // abort by blur/pointercancel leaves the next outside click free to close
  // the menu normally.
  function endSwMenuResize() {
    cancelPanelResize?.();
    document.removeEventListener('mouseup', onResizeEnd);
    window.removeEventListener('blur', onAbort);
    document.removeEventListener('pointercancel', onAbort);
    if (failsafeTimer !== null) {
      clearTimeout(failsafeTimer);
      failsafeTimer = null;
    }
    const height = Math.round(panelEl.getBoundingClientRect().height);
    setSwMenuHeight(height).catch((err) => handlePossibleContextInvalidation(err));
    releaseHold();
  }

  function onResizeEnd() {
    endSwMenuResize();
  }

  function onAbort() {
    endSwMenuResize();
  }

  // Backstop for a missed mouseup (pointer released off-window, browser eats
  // the event, etc.) that even blur/pointercancel don't catch -- a resize
  // drag never legitimately lasts this long, so force-end it regardless.
  failsafeTimer = setTimeout(onAbort, SW_MENU_RESIZE_FAILSAFE_MS);

  document.addEventListener('mouseup', onResizeEnd);
  window.addEventListener('blur', onAbort);
  document.addEventListener('pointercancel', onAbort);
}

function addSwMenuButton() {
  const containerEl = document.createElement('div');
  containerEl.id = 'ccsw-sw-menu';

  const panelEl = document.createElement('div');
  panelEl.id = 'ccsw-sw-menu-panel';
  panelEl.className = 'ccsw-sw-menu-panel';
  swMenuPanelEl = panelEl;

  // Top-edge-only resize handle -- see startSwMenuResize above for why this
  // reuses the shared .ccsw-resize-n styling but NOT attachResizeHandles
  // (that would add all 8 directions; the menu only ever resizes taller/
  // shorter from the top). The mousedown listener is capture-phase and
  // stopPropagation()s belt-and-braces alongside the drag's holdOpen() latch
  // (and the disclosure's pointerdown provenance) -- any one of those should be
  // enough on its own to stop a resize drag from closing the menu, but together
  // they make it impossible regardless of where the drag's mouseup actually
  // lands.
  const resizeHandleEl = document.createElement('div');
  resizeHandleEl.className = 'ccsw-resize-handle ccsw-resize-n';
  resizeHandleEl.addEventListener('mousedown', (evt) => {
    evt.stopPropagation();
    startSwMenuResize(evt, panelEl);
  }, true);
  panelEl.appendChild(resizeHandleEl);

  // Built once and never recreated -- see the swMenuListeningItemEl comment
  // near its declaration for why these two rows must stay stable nodes. They
  // (and their dividers) are direct children of panelEl, outside the
  // scrollable job list below, so they never move when the job list scrolls.
  // The global row sits above the per-thread one: it's the master switch, so
  // it reads first, same order as the "global overrides per-thread" gating
  // in scan().
  const globalListeningItem = document.createElement('button');
  globalListeningItem.type = 'button';
  globalListeningItem.id = 'ccsw-sw-menu-global-listening';
  globalListeningItem.className = 'ccsw-sw-menu-item ccsw-sw-menu-item--listening';
  globalListeningItem.addEventListener('click', async () => {
    try {
      // setGlobalListeningEnabled flips globalListeningEnabled and updates the
      // tooltip synchronously before its own internal await (the storage
      // write) -- so the row repaint below must not wait on that promise
      // either, or a slow/stale-context storage write delays the repaint
      // right along with it. Persistence is fire-and-forget; a failure still
      // reaches handlePossibleContextInvalidation via its own .catch.
      const newValue = !globalListeningEnabled;
      setGlobalListeningEnabled(newValue).catch((err) => handlePossibleContextInvalidation(err));
      updateSwMenuGlobalListeningItem();
    } catch (err) {
      handlePossibleContextInvalidation(err);
    }
  });
  swMenuGlobalListeningItemEl = globalListeningItem;
  updateSwMenuGlobalListeningItem();
  panelEl.appendChild(globalListeningItem);

  const globalListeningDivider = document.createElement('div');
  globalListeningDivider.className = 'ccsw-sw-menu-divider';
  panelEl.appendChild(globalListeningDivider);

  const listeningItem = document.createElement('button');
  listeningItem.type = 'button';
  listeningItem.id = 'ccsw-sw-menu-listening';
  listeningItem.className = 'ccsw-sw-menu-item ccsw-sw-menu-item--listening';
  listeningItem.addEventListener('click', async () => {
    try {
      // Same reasoning as the global handler above -- setListeningEnabled
      // flips listeningEnabled synchronously before its own awaited storage
      // write, so the repaint must not wait on that write either.
      const newValue = !listeningEnabled;
      setListeningEnabled(newValue).catch((err) => handlePossibleContextInvalidation(err));
      updateSwMenuListeningItem();
    } catch (err) {
      handlePossibleContextInvalidation(err);
    }
  });
  swMenuListeningItemEl = listeningItem;
  updateSwMenuListeningItem();
  panelEl.appendChild(listeningItem);

  const listeningDivider = document.createElement('div');
  listeningDivider.className = 'ccsw-sw-menu-divider';
  panelEl.appendChild(listeningDivider);

  // Autopilot window: a transient, on-demand action (not a Settings toggle)
  // whose live state matters, so it lives here in the always-reachable menu.
  // Single toggle row -- arms for this tab's thread when disarmed, disarms when
  // armed. Left open after a click so the user watches it flip to a countdown.
  const autopilotItem = document.createElement('button');
  autopilotItem.type = 'button';
  autopilotItem.id = 'ccsw-sw-menu-autopilot';
  autopilotItem.className = 'ccsw-sw-menu-item ccsw-sw-menu-item--autopilot';
  autopilotItem.addEventListener('click', () => {
    const thread = hydratedThread;
    if (!thread) {
      console.warn('[CCswitchboard] autopilot: this tab has no thread yet; cannot arm.');
      return;
    }
    if (autopilotArmedFor(thread)) {
      disarmAutopilotWindow(thread, 'cancelled').catch((err) => handlePossibleContextInvalidation(err));
    } else {
      armAutopilotWindow(thread).catch((err) => handlePossibleContextInvalidation(err));
    }
    updateAutopilotUi();
  });
  panelEl.appendChild(autopilotItem);
  updateSwMenuAutopilotItem();

  // Duration lever: a separate row directly under the arm/disarm toggle that
  // steps ccswAutopilotWindowMinutes up a preset ladder without DevTools. Only
  // sets the preference for the NEXT armed window; the storage.onChanged sync
  // propagates it to all tabs, and we refresh this row's label immediately on
  // click too (it otherwise refreshes on updateAutopilotUi's 1s tick).
  const autopilotDurationItem = document.createElement('button');
  autopilotDurationItem.type = 'button';
  autopilotDurationItem.id = 'ccsw-sw-menu-autopilot-duration';
  autopilotDurationItem.className = 'ccsw-sw-menu-item ccsw-sw-menu-item--autopilot-duration';
  autopilotDurationItem.addEventListener('click', () => {
    const next = nextAutopilotWindowMinutes(autopilotWindowMinutes);
    // Update the live var first so the label reflects the new preset even
    // before storage echoes back; the onChanged handler will set the same
    // value again, which is idempotent.
    autopilotWindowMinutes = next;
    try {
      chrome.storage.local.set({ [AUTOPILOT_DURATION_STORAGE_KEY]: next })
        .catch((err) => handlePossibleContextInvalidation(err));
    } catch (err) {
      handlePossibleContextInvalidation(err);
    }
    updateSwMenuAutopilotDurationItem();
  });
  panelEl.appendChild(autopilotDurationItem);
  updateSwMenuAutopilotDurationItem();

  const autopilotDivider = document.createElement('div');
  autopilotDivider.className = 'ccsw-sw-menu-divider';
  panelEl.appendChild(autopilotDivider);

  const boardItem = document.createElement('button');
  boardItem.type = 'button';
  boardItem.className = 'ccsw-sw-menu-item ccsw-sw-menu-item--board';
  boardItem.textContent = 'Open board';
  boardItem.addEventListener('click', async () => {
    // Close first, then open -- window.open() hands focus to the new tab,
    // and if that focus steal (or a popup-blocker exception) ever happens
    // before this line runs, closeSwMenu() would never fire and the menu
    // would be stuck open with no outside-click available to dismiss it.
    closeSwMenu();
    // Pre-set the board gate's auth cookie from the stored relay token so
    // the board loads straight in, skipping its manual "Relay token" prompt.
    // Either way the outcome is shown via showBoardCookieToast -- a silent
    // failure here is undiagnosable, so the board is opened regardless (Jody
    // still gets in, just via the manual gate) and the toast says why.
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ccsw-set-board-cookie' });
      showBoardCookieToast(response);
      if (!response?.ok) console.warn('[CCswitchboard] board cookie not set:', response?.stage, response?.error);
    } catch (err) {
      showBoardCookieToast({ ok: false, stage: 'message-failed', error: err?.message ?? String(err) });
      console.warn('[CCswitchboard] board cookie not set:', err);
    }
    // Re-asked rather than read from the cached copy: the cookie was just set
    // for whichever relay background.js considers active, so the board we open
    // has to be that same one or the pre-set cookie is for the wrong host.
    let boardUrl = relayInfo && relayInfo.boardUrl;
    try {
      const info = await chrome.runtime.sendMessage({ type: 'ccsw-get-relay-info' });
      if (info?.boardUrl) {
        applyRelayInfo(info);
        boardUrl = info.boardUrl;
      }
    } catch (err) {
      // Fall through to the cached value below.
    }
    if (!boardUrl) {
      showBoardCookieToast({ ok: false, stage: 'no-relay', error: 'no active relay known yet -- reload the extension' });
      return;
    }
    window.open(boardUrl, '_blank', 'noopener');
  });
  panelEl.appendChild(boardItem);

  const settingsMenuItem = document.createElement('button');
  settingsMenuItem.type = 'button';
  settingsMenuItem.className = 'ccsw-sw-menu-item ccsw-sw-menu-item--settings';
  settingsMenuItem.textContent = 'Settings...';
  settingsMenuItem.addEventListener('click', () => {
    closeSwMenu();
    toggleSettingsDialog();
  });
  panelEl.appendChild(settingsMenuItem);

  // "Clear ghost pills" used to live here as its own row; it's now a button
  // inside the Advanced dialog alongside the other manual-recovery actions
  // (clear locks, force-close, restart agent) -- see clearGhostPills() and
  // ensureAdvancedDialog() below.
  const advancedMenuItem = document.createElement('button');
  advancedMenuItem.type = 'button';
  advancedMenuItem.className = 'ccsw-sw-menu-item ccsw-sw-menu-item--settings';
  advancedMenuItem.textContent = 'Advanced...';
  advancedMenuItem.addEventListener('click', () => {
    closeSwMenu();
    toggleAdvancedDialog();
  });
  panelEl.appendChild(advancedMenuItem);

  // #53: last-resort manual re-scan -- see rescueLastBlock's own comment for
  // why it's safe to bypass rules A/B here.
  const rescueMenuItem = document.createElement('button');
  rescueMenuItem.type = 'button';
  rescueMenuItem.className = 'ccsw-sw-menu-item ccsw-sw-menu-item--rescue';
  rescueMenuItem.textContent = 'Rescue: re-scan last block';
  rescueMenuItem.addEventListener('click', () => {
    closeSwMenu();
    rescueLastBlock();
  });
  panelEl.appendChild(rescueMenuItem);

  const closeMenuDivider = document.createElement('div');
  closeMenuDivider.className = 'ccsw-sw-menu-divider';
  panelEl.appendChild(closeMenuDivider);

  const closeMenuItem = document.createElement('button');
  closeMenuItem.type = 'button';
  closeMenuItem.className = 'ccsw-sw-menu-item ccsw-sw-menu-item--close';
  closeMenuItem.textContent = 'Close menu';
  closeMenuItem.addEventListener('click', () => {
    closeSwMenu();
  });
  panelEl.appendChild(closeMenuItem);

  const divider = document.createElement('div');
  divider.className = 'ccsw-sw-menu-divider';
  panelEl.appendChild(divider);

  // The scroll chevrons bracket only the job list from here down -- the
  // listening/board rows above are outside this scroll region entirely.
  const scrollUpEl = document.createElement('button');
  scrollUpEl.type = 'button';
  scrollUpEl.id = 'ccsw-sw-menu-scroll-up';
  scrollUpEl.className = 'ccsw-sw-menu-scroll-btn';
  scrollUpEl.setAttribute('aria-label', 'Scroll up');
  const scrollUpChevronEl = document.createElement('span');
  scrollUpChevronEl.className = 'ccsw-sw-menu-chevron ccsw-sw-menu-chevron--up';
  scrollUpEl.appendChild(scrollUpChevronEl);
  scrollUpEl.addEventListener('mousedown', (evt) => {
    evt.preventDefault();
    startSwMenuScrollHold(-1);
  });
  swMenuScrollUpEl = scrollUpEl;
  panelEl.appendChild(scrollUpEl);

  // The job list is itself the scrollable element -- see the swMenuListEl
  // comment near its declaration.
  const jobsListEl = document.createElement('div');
  jobsListEl.id = 'ccsw-sw-menu-jobs';
  jobsListEl.className = 'ccsw-sw-menu-list';
  jobsListEl.addEventListener('scroll', updateSwMenuScrollButtons);
  swMenuListEl = jobsListEl;
  swMenuJobsListEl = jobsListEl;
  panelEl.appendChild(jobsListEl);

  // Chevron enabled/disabled state (updateSwMenuScrollButtons) only gets
  // re-evaluated on render/scroll by default, so dragging the panel's top-edge
  // resize handle (startSwMenuResize) smaller never re-checked it -- content
  // could clip without the chevrons ever re-enabling, since their last
  // computed state was from when the panel was tall enough to fit everything.
  // A ResizeObserver on the list itself (rather than hooking the drag handler)
  // catches every way this element's box can shrink/grow, not just the
  // top-edge drag.
  new ResizeObserver(updateSwMenuScrollButtons).observe(jobsListEl);

  const scrollDownEl = document.createElement('button');
  scrollDownEl.type = 'button';
  scrollDownEl.id = 'ccsw-sw-menu-scroll-down';
  scrollDownEl.className = 'ccsw-sw-menu-scroll-btn';
  scrollDownEl.setAttribute('aria-label', 'Scroll down');
  const scrollDownChevronEl = document.createElement('span');
  scrollDownChevronEl.className = 'ccsw-sw-menu-chevron ccsw-sw-menu-chevron--down';
  scrollDownEl.appendChild(scrollDownChevronEl);
  scrollDownEl.addEventListener('mousedown', (evt) => {
    evt.preventDefault();
    startSwMenuScrollHold(1);
  });
  swMenuScrollDownEl = scrollDownEl;
  panelEl.appendChild(scrollDownEl);

  // Held-mouse scrolling needs to stop even if the button is released (or the
  // window loses focus) after the cursor has moved off it.
  document.addEventListener('mouseup', stopSwMenuScrollHold);
  window.addEventListener('blur', stopSwMenuScrollHold);

  // The stale-menu-across-tab-cycle concern that used to justify an always-on
  // visibilitychange listener here (close on tab-BACK) is now handled by the
  // disclosure's closeOnHide (close on tab-AWAY): the menu is already closed by
  // the time the tab returns, so nothing per-open needs to be reasserted here.

  const buttonEl = document.createElement('button');
  buttonEl.type = 'button';
  buttonEl.id = 'ccsw-sw-menu-button';
  swMenuButtonEl = buttonEl;
  updateSwMenuButtonTooltip();
  const iconEl = document.createElement('img');
  iconEl.src = chrome.runtime.getURL('logo-32.png');
  iconEl.width = 27;
  iconEl.height = 27;
  iconEl.alt = 'CCswitchboard';
  buttonEl.appendChild(iconEl);
  buttonEl.addEventListener('click', (evt) => {
    evt.stopPropagation();
    toggleSwMenu();
  });

  // The button itself is overflow:hidden (it crops the zoomed logo), so the
  // always-visible autopilot badge can't live inside it -- it goes on a
  // positioned wrapper as a sibling of the button and is pinned to its
  // top-right corner (see updateAutopilotIndicator + the badge CSS).
  const buttonWrapEl = document.createElement('div');
  buttonWrapEl.id = 'ccsw-sw-menu-button-wrap';
  const autopilotBadgeEl = document.createElement('span');
  autopilotBadgeEl.id = 'ccsw-autopilot-badge';
  autopilotBadgeEl.textContent = 'AP';
  buttonWrapEl.append(buttonEl, autopilotBadgeEl);

  containerEl.append(panelEl, buttonWrapEl);
  document.body.appendChild(containerEl);

  // The two calls above (right after each row's creation, before panelEl/
  // containerEl are attached anywhere) are no-ops under the id-based lookup
  // now that getElementById requires the node to be connected to `document`
  // -- so the initial label/class must be synced again here, now that
  // containerEl is actually in the document.
  updateSwMenuGlobalListeningItem();
  updateSwMenuListeningItem();
  // Now that the row and badge are connected to the document, paint them from
  // whatever loadAutopilotWindows() already resolved (it may have run before
  // this button existed, so its own updateAutopilotUi() was a no-op).
  updateAutopilotUi();
}

addSwMenuButton();

// --- personal pills ---------------------------------------------------------
// A row of text pills sitting to the LEFT of the action-list pill, gated on
// CCSW_PERSONAL_FEATURES. Each one composes some text into this tab's composer
// on click and stops there -- no send, no relay round trip -- so the text can
// be read and edited before Jody sends it himself.
//
// createPersonalPill(label, textProvider, tooltip, onClick) is the whole
// contract: textProvider is called at click time (not at mount time) and
// returns the string to paste, so a pill whose text depends on live state just
// reads that state when asked. It may return a promise; a null/empty return
// means "nothing to paste" and is a silent no-op. tooltip is optional -- omit
// it to fall back to the generic "paste ... into the composer" title.
//
// onClick opts out of the paste-into-this-composer behaviour entirely: when
// given, it is awaited on click and textProvider is ignored. Issue #28's
// "Status" pill needs that because it prompts first and then delivers to a
// DIFFERENT tab than the one clicked, so there's nothing to paste locally.
// Everything else about the pill -- chrome, gating, row mounting, tooltip --
// is shared.

let personalPillsEl = null;

// The pills live in their own fixed-position row rather than inside
// #ccsw-action-list, because that container is rebuilt by the action-list
// render path and its width changes with the tier badges.
function ensurePersonalPillsRow() {
  if (personalPillsEl) return personalPillsEl;
  personalPillsEl = document.createElement('div');
  personalPillsEl.id = 'ccsw-personal-pills';
  document.body.appendChild(personalPillsEl);
  return personalPillsEl;
}

// Both the SW logo button and the action-list pill are fixed to the bottom
// right, so "the same gap as between the todo pill and the SW logo" is a
// measurement, not a constant: read the real gap off the live layout and mirror
// it. The logo sits to the RIGHT of the action-list pill (right: 6px vs 45px --
// a bigger `right` is further left), so the gap runs from the pill's right edge
// to the logo's left edge. Falls back to the 11px those two currently have if
// the logo isn't mounted yet or the layout puts them somewhere unexpected.
const PERSONAL_PILLS_FALLBACK_GAP = 11;

function repositionPersonalPills() {
  if (!personalPillsEl) return;
  const actionListEl = document.getElementById('ccsw-action-list');
  if (!actionListEl) return;
  const swButtonEl = document.getElementById('ccsw-sw-menu-button');

  const actionRect = actionListEl.getBoundingClientRect();
  const swRect = swButtonEl?.getBoundingClientRect();
  const gap = swRect && swRect.width > 0 && swRect.left > actionRect.right
    ? swRect.left - actionRect.right
    : PERSONAL_PILLS_FALLBACK_GAP;

  // Anchored off the action-list pill's LEFT edge, so the row keeps its gap as
  // that pill widens and narrows with its badge counts.
  personalPillsEl.style.right = `${Math.round(window.innerWidth - actionRect.left + gap)}px`;
}

// Writes `text` into claude.ai's composer at the caret and leaves it there.
//
// Deliberately a separate implementation from background.js's ccswInjInsertText
// even though the DOM dance is the same: that one is passed by reference to
// chrome.scripting.executeScript (so it can't close over anything here), it
// wipes the composer before inserting, and it stamps window.__ccswSendMarker to
// hand the text off to the send state machine. None of that is wanted for a
// paste the user is about to edit -- in particular the marker would make a
// pending job delivery treat this text as its own and send it.
//
// Leaving the text in the composer also parks any queued delivery: background's
// ccswInjCheckHold holds while the input is non-empty, so a job finishing mid-
// review can't clobber what's sitting here.
function pasteIntoComposer(text) {
  let input = null;
  for (const sel of INPUT_SELECTORS) {
    input = document.querySelector(sel);
    if (input) break;
  }
  if (!input) return false;

  input.focus();
  const inserted = document.execCommand('insertText', false, text);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
  if (inserted && input.textContent.trim().length > 0) return true;

  // execCommand('insertText') no-ops when the document isn't really focused.
  // A pill click means it should be, but fall back to writing ProseMirror's own
  // paragraph DOM (one <p> per line) the way ccswInjInsertText does. Appends
  // rather than replaces, so anything already typed survives.
  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = text.split('\n').map((line) => `<p>${line ? escapeHtml(line) : '<br>'}</p>`).join('');
  input.insertAdjacentHTML('beforeend', html);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
  return input.textContent.trim().length > 0;
}

function createPersonalPill(label, textProvider, tooltip, onClick) {
  if (!CCSW_PERSONAL_FEATURES) return null;

  const rowEl = ensurePersonalPillsRow();
  const pillEl = document.createElement('button');
  pillEl.type = 'button';
  pillEl.className = 'ccsw-personal-pill';
  pillEl.textContent = label;
  pillEl.setAttribute('aria-label', onClick ? label : `${label} (pastes into the composer, does not send)`);
  pillEl.title = tooltip || `Paste ${label.toLowerCase()} text into the composer -- not sent`;

  // #77: every personal pill click is logged the instant it happens -- before
  // onClick/textProvider even run -- so a click that dies somewhere downstream
  // (an old dangling reference, a payload built but never dispatched, a thrown
  // exception) still leaves a button_click trail. The #28 Status pill's
  // prompt->OK path shipped with none of this, and a silent console.warn on
  // failure meant a real error looked identical to "nothing happened".
  const buttonKey = label.toLowerCase();

  pillEl.addEventListener('click', async (evt) => {
    evt.stopPropagation();
    logEvent('button_click', { button: `${buttonKey}-open` });

    if (onClick) {
      try {
        await onClick();
      } catch (err) {
        console.error(`[CCswitchboard] personal pill "${label}" click handler failed:`, err);
        logEvent('button_click', { button: `${buttonKey}-error`, error: err?.message ?? String(err) });
        showRescueToast(`${label} failed: ${err?.message ?? String(err)}`);
      }
      return;
    }

    let text;
    try {
      text = await textProvider();
    } catch (err) {
      console.error(`[CCswitchboard] personal pill "${label}" text provider failed:`, err);
      logEvent('button_click', { button: `${buttonKey}-error`, error: err?.message ?? String(err) });
      showRescueToast(`${label} failed: ${err?.message ?? String(err)}`);
      return;
    }
    if (!text) return;
    if (!pasteIntoComposer(text)) {
      console.error(`[CCswitchboard] personal pill "${label}": composer input not found, nothing pasted.`);
      logEvent('button_click', { button: `${buttonKey}-error`, error: 'composer input not found' });
      showRescueToast(`${label}: composer not found, nothing pasted`);
    }
  });

  rowEl.appendChild(pillEl);
  repositionPersonalPills();
  return pillEl;
}

// --- issue #28: dump pill status ---------------------------------------------
// A live snapshot of what is on screen in THIS tab right now, annotated with
// whatever Jody types at the prompt. Deliberately NOT the debug log: that
// ({"debuglog": true}) is a cross-tab event history over time, pulled from the
// relay. This is the opposite -- no history, no relay, just the pills this tab
// is currently rendering, so a "why does that pill look wrong" question comes
// with the on-screen evidence attached.

// A pill's state is not one field. A live job keeps it in entry.status, but
// held and dropped pills are separate entry shapes built by showHeldJobBar /
// showDroppedJobBar and carry no status at all.
//
// Order matters: a DROPPED entry has both `dropped: true` AND a `held` field
// (job.php's 409 lock array -- which repo/thread it collided with), so testing
// `held` first would mislabel every repo-busy pill as held.
function pillStateLabel(entry) {
  if (entry.dropped) return 'dropped (repo busy)';
  if (entry.held) return 'held (stale-replay guard)';
  return entry.status || '(unknown)';
}

// "Visible" means actually painted, not merely tracked: removeJobBar deletes
// from activeToolbarJobs, but a pill can also be detached or display:none'd
// while its entry lingers. getClientRects() catches both.
function isPillVisible(entry) {
  const barEl = entry.barEl;
  return !!barEl && barEl.isConnected && barEl.getClientRects().length > 0;
}

// Output-pending and delivery-failed live only as CSS classes on the pill (see
// setJobBarWaiting / setJobBarDeliveryFailed) -- there is no entry field for
// either, so read them back off the element.
function describePill(recordId, entry) {
  const classList = entry.barEl.classList;
  const bits = [`state=${pillStateLabel(entry)}`];
  if (classList.contains('ccsw-job-bar--waiting')) bits.push('output-pending');
  if (classList.contains('ccsw-job-bar--delivery-failed')) bits.push('delivery-failed');
  if (entry.expanded) bits.push('expanded');
  if (entry.thread) bits.push(`thread=${entry.thread}`);
  if (entry.model) bits.push(`model=${entry.model}`);
  if (entry.dropped && entry.heldText) bits.push(`collided-with=${entry.heldText}`);
  if (entry.dropped && entry.droppedAt) bits.push(`dropped-at=${new Date(entry.droppedAt).toISOString()}`);

  const name = entry.name || '(unnamed)';
  const summary = entry.summary ? ` -- ${entry.summary}` : '';
  return `- ${recordId} "${name}"${summary}\n    ${bits.join(' | ')}`;
}

function formatPillStatusSnapshot() {
  const described = [];
  activeToolbarJobs.forEach((entry, recordId) => {
    if (isPillVisible(entry)) described.push(describePill(recordId, entry));
  });

  const source = hydratedThread ? `thread "${hydratedThread}"` : 'an unhydrated tab';
  const header = `FYI: CCSW pill snapshot, taken in ${source} (build ${CCSW_BUILD}).`;
  const body = described.length ? described.join('\n') : '(no visible toolbar pills)';
  return `${header}\n${described.length} visible pill(s):\n${body}`;
}

// Snapshot SOURCE and delivery DESTINATION are now BOTH this tab: Status pastes
// the board snapshot straight into THIS composer, the same client-side path the
// Instruct pill uses (pasteIntoComposer), and leaves it for Jody to send.
//
// It used to dispatch via chrome.runtime.sendMessage('ccsw-pillstatus-deliver'),
// which routed the snapshot through background.js to whichever tab last spoke
// for the thread. That is exactly the machinery that is DOWN when Jody most
// needs Status: when a dispatch is failing (background asleep, relay
// unreachable, no resolvable destination tab) the message resolved to nothing
// and the click looked dead -- the #28 "Status does nothing" report. Status is
// how Jody reports a broken board to Claude, so it must never depend on the
// relay/background/messaging that may be the thing that is broken. It reads the
// in-memory pill state this tab already holds and pastes it locally -- no
// runtime messaging, no await, nothing that can silently no-op.
function dumpPillStatus() {
  // #77: logged BEFORE the paste so a thrown exception (e.g. an invalidated
  // extension context) still leaves a trail showing the click was handled.
  logEvent('button_click', { button: 'status-send' });

  const text = formatPillStatusSnapshot();

  if (!pasteIntoComposer(text)) {
    console.error('[CCswitchboard] pill status: composer input not found, nothing pasted.');
    logEvent('button_click', { button: 'status-send-error', error: 'composer input not found' });
    showRescueToast('Status: composer not found, nothing pasted');
    return;
  }
  console.log('[CCswitchboard] pill status: board snapshot pasted into this composer.');
  logEvent('button_click', { button: 'status-send-ok' });
}

// --- ALWAYS-ON JOB-STATUS FOOTER ---------------------------------------------
// Every send this extension puts into a thread -- a job result background.js
// delivers, AND the user's own suppressed-then-resent message -- carries a
// footer naming every job this thread still owes an answer on, so the Claude
// reading it always sees current board state rather than inferring it from
// whichever single delivery happened to land.
//
// Built HERE, not in background.js, because this tab's pill registry is the
// only place all three states are known at once: background.js's toolbarJobs
// is jobId->tabId with no names, and it never learns about a repo-busy drop at
// all -- job.php's 409 is handled entirely in content.js (showDroppedJobBar).
//
// ALWAYS emitted, empty state included. "Nothing is running" is itself board
// state, and a silently absent footer is indistinguishable from a broken one
// to the Claude reading it -- which is the whole point of the feature.
//
// Delimiters are bracket tags, not a markdown rule: a bare "---" line under
// text makes claude.ai's markdown render the line above it as a heading.
const STATUS_FOOTER_OPEN = '[CCSW board]';
const STATUS_FOOTER_CLOSE = '[/CCSW board]';
const STATUS_FOOTER_EMPTY = '-- no active jobs --';

// Order matters and mirrors pillStateLabel's: a DROPPED entry carries a `held`
// field too (job.php's 409 collision array), so testing `held` first would
// label every repo-busy job "held".
//
// Returns null for anything NOT owed/active. A delivered or finished job is
// board history, not board state -- listing it would misreport the board.
//
// 'held' means ONE thing: the stale-replay guard stopped this job from ever
// dispatching. It is not the fallback bucket. A job that ran to completion is
// the opposite of held, and must never be labelled it -- which is exactly what
// the pendingDelivery branch below used to do to every job in the act of
// delivering its own result.
function footerStateFor(entry) {
  if (entry.dropped) return 'repo busy';       // dispatch refused, repo locked
  if (entry.held) return 'held';               // stale-replay guard, never dispatched
  // Pending-delivery pill: the job FINISHED and its result is queued for this
  // composer. 'sent' is terminal. 'parked' means background.js gave up and a
  // human must send it -- a state no amount of waiting resolves, so it says so
  // rather than hiding behind a generic wait word. Anything else is in flight.
  if (entry.pendingDelivery) {
    if (entry.state === 'sent') return null;
    return entry.state === 'parked' ? 'needs manual send' : 'delivering';
  }
  if (entry.status === 'running' || entry.status === 'pending') return 'running';
  return null; // done | error | cancelled | dropped-from-registry
}

// Dropped pills store the name pre-suffixed ("<name> - repo busy", see
// showDroppedJobBar); strip it so the state isn't printed twice on one line.
// Pending-delivery pills carry the job name in `label`, not `name`.
function footerNameFor(entry) {
  const raw = entry.name || entry.label || entry.kindLabel || 'Job';
  return String(raw).replace(/ - repo busy$/, '').trim() || 'Job';
}

// Jobs owed by THIS thread. A pill with no thread of its own is this tab's by
// construction (it was built here), so it counts; a pill explicitly tagged for
// a different thread does not.
//
// deliveringJobIds names the job(s) whose results are IN the very message this
// footer is being built for -- background.js passes them, since only it knows
// what it is about to insert. They are answered BY this message, so by the time
// anything reads the footer they are not owed at all; listing them describes a
// board that stopped being true one paragraph higher up. Skipping is by JOB,
// before any per-pill classification, because a just-finished job can still be
// holding a stale 'running' pill alongside its pending-delivery one -- dropping
// only the latter would resurrect it as "running".
function collectFooterJobs(deliveringJobIds) {
  const delivering = new Set((deliveringJobIds ?? []).filter((id) => id != null).map((id) => String(id)));
  const rows = [];
  const byJobId = new Map();
  activeToolbarJobs.forEach((entry) => {
    if (hydratedThread && entry.thread && entry.thread !== hydratedThread) return;
    if (entry.jobId != null && delivering.has(String(entry.jobId))) return;
    const state = footerStateFor(entry);
    if (!state) return;
    const row = { name: footerNameFor(entry), state };
    // One job can briefly hold two pills (a running pill and the pending-
    // delivery pill for its result). Report it once, at its LATER lifecycle
    // stage: a result waiting to land is "delivering", not still "running".
    if (entry.jobId != null) {
      const seen = byJobId.get(entry.jobId);
      if (seen) {
        if (entry.pendingDelivery) { seen.name = row.name; seen.state = row.state; }
        return;
      }
      byJobId.set(entry.jobId, row);
    }
    rows.push(row);
  });
  return rows;
}

function buildJobStatusFooter(deliveringJobIds) {
  const rows = collectFooterJobs(deliveringJobIds);
  const body = rows.length
    ? rows.map((row) => `${row.name} - ${row.state}`).join('\n')
    : STATUS_FOOTER_EMPTY;
  return `${STATUS_FOOTER_OPEN}\n${body}\n${STATUS_FOOTER_CLOSE}`;
}

// background.js asks for this immediately before each insert (see
// fetchStatusFooter) rather than caching, so the footer reflects the board as
// of the send itself. Read-only: builds a string, touches no pill state.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-status-footer') return false;
  let footer = '';
  try {
    // Absent/malformed deliveringJobIds degrades to "exclude nothing" -- the
    // pre-existing behaviour, minus the 'held' mislabel.
    footer = buildJobStatusFooter(Array.isArray(message.deliveringJobIds) ? message.deliveringJobIds : []);
  } catch (err) {
    // Never let a footer failure block a delivery -- background.js sends
    // without one on an empty/failed response.
    console.warn('[CCswitchboard] status footer: build failed:', err.message);
  }
  sendResponse({ footer });
  return false;
});

function mountPersonalPills() {
  if (!CCSW_PERSONAL_FEATURES) return;
  // Created before Instruct so it sits to its LEFT: the row is a plain flex
  // container, so DOM order is left-to-right and its own `gap` spaces them.
  createPersonalPill('Status', null, "Paste this tab's CCSW board snapshot into the composer (not sent)", dumpPillStatus);
  createPersonalPill('Instruct', () => CCSW_INSTRUCT_TEXT, 'Send Claude.ai instructions for using CCSW');
  repositionPersonalPills();
  // The measure above runs against a just-appended node; re-measure once the
  // first frame has actually laid the row out, in case widths read as 0.
  requestAnimationFrame(repositionPersonalPills);
  window.addEventListener('resize', repositionPersonalPills);
}

// Persistent regardless of listening state or any job ever being dispatched
// from this tab -- mount it immediately, then ask background.js for
// whatever it already has cached rather than waiting for the next
// ACTIONS_POLL_INTERVAL_MS broadcast (this tab may have just opened long
// after that cache was last populated).
ensureActionListPill();
renderActionListPill();

// After the action-list pill, so repositionPersonalPills has a mounted pill to
// measure its gap against.
mountPersonalPills();

// Backfill the dialog's thread tab for the common case where scan() hasn't
// found a ccsw block yet (so hydratedThread is still null) -- same
// remembered-URL fallback the SW menu and sendActionsAdd use. Re-renders only
// if the dialog is somehow already open; otherwise openActionListDialog
// resolves the thread itself.
loadUrlThread().then((thread) => {
  actionListUrlThread = thread || null;
  if (actionListDisclosure?.isOpen) renderActionListDialog();
}).catch(() => {});

chrome.runtime.sendMessage({ type: 'ccsw-actions-get' }).then((response) => {
  if (!response) return;
  actionListState = {
    actions: Array.isArray(response.actions) ? response.actions : [],
    counts: response.counts || actionListState.counts,
  };
  renderActionListPill();
}).catch((err) => {
  handlePossibleContextInvalidation(err);
});

// #18: pull the current stale-tab set too, so this tab's state stays in sync
// with the fleet's stale tabs (the sweep only broadcasts to tabs open at the
// time it runs). This tab itself is fresh, so it won't be in the set. The stale
// set is surfaced to the user by background.js's OS notification, not here.
chrome.runtime.sendMessage({ type: 'ccsw-stale-tabs-get' }).then((response) => {
  if (!response) return;
  staleTabsState = Array.isArray(response.staleTabs) ? response.staleTabs : [];
}).catch((err) => {
  handlePossibleContextInvalidation(err);
});

} // end ccswInitContentScript
