try {
  importScripts('better-voices.web.js');
} catch (e) {
  console.warn('[CCswitchboard] better-voices bundle failed to load:', e);
}

// Rewrites the User-Agent header on requests this extension makes to the
// ccswitchboard relay.
//
// content.js's fetch() call cannot do this itself: Chromium silently drops
// (or refuses) a script-set "User-Agent" header on a plain fetch()/XHR --
// it's one of the small set of headers that require declarativeNetRequest's
// modifyHeaders action instead of being settable directly. This matters
// here because the relay's host WAF returns 429 for requests with no/blank
// User-Agent (hit and fixed the same way for CcswAgent's HttpClient calls
// earlier in this project -- see agent/CcswAgent/Program.cs).
const RULE_ID = 1;
// Second dynamic rule (see registerFeedTokenRule): attaches the relay token to
// the cross-origin feed.php iframe navigation. Kept distinct from RULE_ID so
// the two rules are updated independently.
const FEED_TOKEN_RULE_ID = 2;
const USER_AGENT = 'CCswitchboard-Extension/0.4 (+https://github.com/DabbleLabs-UK/ccswitchboard)';

// --- Relay endpoints -------------------------------------------------------
// These are FILENAMES, not URLs: there is no single relay any more. The full
// URL is derived from whichever relay is currently active (see relayUrl /
// ccswFetch below), so a failover redirects every endpoint at once instead of
// needing 20-odd constants rewritten. Pass a bare filename (optionally with a
// query string) to ccswFetch and it resolves it against the active relay.
const RELAY_FEED_FILE = 'feed.php';
const RELAY_JOB_FILE = 'job.php';
const RELAY_RESULT_FILE = 'result.php';
const RELAY_JOBS_FILE = 'jobs.php';
const RELAY_STATUS_FILE = 'status.php';
const RELAY_REGISTER_TAB_FILE = 'register_tab.php';
const RELAY_FOCUS_REQUEST_FILE = 'focus_request.php';
const RELAY_WAKE_FILE = 'wake.php';
const RELAY_DELIVERY_FILE = 'delivery.php';
// Bug A observability safety net: the extension has no Pushover token of its
// own (token/user live outside the relay's web root -- see board/pushover.php),
// so a client-side delivery-loss alert is fired by POSTing this endpoint, which
// calls sendPushoverNotification server-side. NOTE: alert.php must be DEPLOYED
// to the live relay for the phone buzz to land; until then the POST 404s
// harmlessly and the durable debug_log trace (see alertDeliveryLoss) still stands.
const RELAY_ALERT_FILE = 'alert.php';
const RELAY_PLAN_FILE = 'plan.php';
const RELAY_PLAN_WAKE_FILE = 'plan_wake.php';
const RELAY_ACTIONS_FILE = 'actions.php';
// The two durable dispatch records (see beacon.php / dispatched.php): the
// per-thread last-user-send beacon, and the set of block identities that have
// already dispatched a job. Written to by this worker, cached below, and
// broadcast to every claude.ai tab -- together they ARE the dispatch decision
// content.js's scan() now makes (see its dispatch-eligibility rule).
const RELAY_BEACON_FILE = 'beacon.php';
const RELAY_DISPATCHED_FILE = 'dispatched.php';

// How far back dispatched.php is asked to look when answering "has this block
// already run?". A key older than this drops out of the set, so a block that
// last ran over a week ago is eligible to run again rather than being
// suppressed forever. Bounds the payload too -- see dispatched.php's AGE
// WINDOW comment for the full reasoning.
const DISPATCHED_AGE_WINDOW_DAYS = 7;
const RELAY_DEBUG_FILE = 'debug_log.php';
// Note the missing underscore -- debuglog.php is the NEW structured, per-event
// central debug log (the `debug_log` table), not the older flat-file
// debug_log.php above. Both exist on purpose; see debuglog.php's header.
const RELAY_DEBUGLOG_FILE = 'debuglog.php';
// Durable, append-only record of claude.ai's OWN generations (start/end,
// duration, model/effort) -- content.js's generation watcher POSTs one row per
// generation through here. Distinct from both debug logs above: debuglog.php
// is a trimmed diagnostic ring, this is never rotated.
const RELAY_OUTPUT_LOG_FILE = 'output_log.php';
const RELAY_CLEAR_LOCK_FILE = 'clear_lock.php';
const RELAY_CLEAR_LOCKS_FILE = 'clear_locks.php';
const RELAY_DEBUG_LOCKS_FILE = 'debug_locks.php';
const BOARD_FILE = 'index.php';
// Matches index.php's gate cookie: Secure+SameSite, ~13 month lifetime.
const BOARD_COOKIE_NAME = 'ccsw_token';
const BOARD_COOKIE_MAX_AGE_SECONDS = 34560000;

// The cookie path is scoped to the relay's OWN directory so it isn't sent to
// unrelated paths on the same host -- which means it is relay-specific, not a
// constant: the primary lives under /ccswitchboard/board while the reserve is
// served from its host root. Derived from the active relay's base rather than
// hardcoded, or the cookie would be set on a path the board never reads and
// 'Open board' would silently fall through to the manual token gate.
function boardCookiePath(base) {
  try {
    const path = new URL(base).pathname.replace(/\/+$/, '');
    return path === '' ? '/' : path;
  } catch (e) {
    return '/';
  }
}

// --- Relays + auth tokens (X-CCSW-Token) -----------------------------------
// There is no single relay any more: an ORDERED list is tried in priority
// order, index 0 first. Each relay is a separate deployment with its own
// auth.config.php, so tokens are PER RELAY -- one relay's token is meaningless
// (401) on the other.
//
// Storage (chrome.storage.local):
//   ccswRelays      [{base, token}, ...] -- ordered, index 0 = primary
//   ccswActiveRelay  index of the relay currently in use (sticky across restarts)
//   ccswToken        LEGACY single token, migrated into ccswRelays on startup
//
// Set a token from the service-worker console (no options page yet):
//   const { ccswRelays } = await chrome.storage.local.get('ccswRelays');
//   ccswRelays[0].token = '<primary token>';
//   await chrome.storage.local.set({ ccswRelays });
//
// A relay with an empty token is SKIPPED entirely rather than hammered with
// requests that can only 401 -- so today, with the primary's token not yet
// filled in, the extension lands on the reserve on its own.
const DEFAULT_RELAYS = [
  { base: 'https://dabblelabs.uk/ccswitchboard/board', token: '' },
  { base: 'https://relay.z4ps.uk/ccswitchboard/board', token: '' },
];

// Which default entry inherits a pre-existing 'ccswToken'. That legacy value
// was set during the dabblelabs.uk outage and is therefore the RESERVE's
// token -- migrating it onto the primary would just produce 401s.
const LEGACY_TOKEN_RELAY_BASE = 'https://relay.z4ps.uk/ccswitchboard/board';

// Consecutive failed requests against the active relay before failing over.
const RELAY_FAILURE_THRESHOLD = 3;
// Kept short so a dead relay is noticed in seconds, not on fetch()'s own
// multi-minute default. This is the whole reason failover feels instant.
const RELAY_TIMEOUT_MS = 8000;
// How often the primary is re-checked while running on a lower-priority relay,
// and how many consecutive OKs it takes to go back. The hysteresis stops a
// flapping relay from dragging the extension back and forth.
const RELAY_PROBE_INTERVAL_MS = 60000;
const RELAY_PROBE_OKS_TO_SWITCH_BACK = 2;

// In-memory mirror of storage + per-relay health. relays[i] = {base, token,
// failures, tokenRejected}. Health is deliberately NOT persisted: a fresh
// worker should re-test rather than inherit a stale verdict.
let relays = null;
let activeRelayIndex = 0;
let relaysLoading = null;
let relayProbeOks = 0;

function relayUsable(relay) {
  return !!relay && !!relay.token && !relay.tokenRejected;
}

// First usable relay at or after `start`, wrapping. -1 when none qualifies.
function firstUsableRelayIndex(start) {
  if (!relays || relays.length === 0) return -1;
  for (let i = 0; i < relays.length; i++) {
    const idx = (start + i) % relays.length;
    if (relayUsable(relays[idx])) return idx;
  }
  return -1;
}

async function ensureRelaysLoaded() {
  if (relays) return relays;
  if (relaysLoading) return relaysLoading;
  relaysLoading = (async () => {
    let stored = {};
    try {
      stored = await chrome.storage.local.get(['ccswRelays', 'ccswActiveRelay', 'ccswToken']);
    } catch (e) {
      stored = {};
    }

    // Note the length re-check AFTER filtering: a stored list whose entries are
    // all malformed filters down to [], which is truthy and would otherwise
    // leave us with zero relays and no way to make a request at all. Falling
    // back to the defaults is always better than that.
    let list = Array.isArray(stored.ccswRelays)
      ? stored.ccswRelays.filter((r) => r && typeof r.base === 'string' && r.base !== '')
      : null;
    if (list && list.length === 0) list = null;

    if (!list) {
      // MIGRATION: first run after the multi-relay change. Build the default
      // list and hand any legacy token to the relay it actually belongs to.
      list = DEFAULT_RELAYS.map((r) => ({ ...r }));
      const legacy = stored.ccswToken;
      if (legacy) {
        const owner = list.find((r) => r.base === LEGACY_TOKEN_RELAY_BASE);
        if (owner) owner.token = legacy;
        console.log(`[CCswitchboard] relays: migrated legacy ccswToken onto ${LEGACY_TOKEN_RELAY_BASE}`);
      }
      try {
        await chrome.storage.local.set({ ccswRelays: list.map((r) => ({ base: r.base, token: r.token || '' })) });
      } catch (e) {
        console.warn('[CCswitchboard] relays: could not persist migrated relay list:', e);
      }
    } else if (stored.ccswToken) {
      // Mid-migration fallback: a stored list that predates a token being
      // filled in still honours the legacy value, so a half-migrated profile
      // never ends up with no usable token at all.
      const owner = list.find((r) => r.base === LEGACY_TOKEN_RELAY_BASE);
      if (owner && !owner.token) owner.token = stored.ccswToken;
    }

    relays = list.map((r) => ({ base: r.base.replace(/\/+$/, ''), token: r.token || '', failures: 0, tokenRejected: false }));

    for (const relay of relays) {
      if (!relay.token) {
        // Logged ONCE, here, rather than on every request against it.
        console.log(`[CCswitchboard] relays: ${relay.base} has no token -- skipping it. Set one via chrome.storage.local ccswRelays to enable it.`);
      }
    }

    const storedIndex = Number.isInteger(stored.ccswActiveRelay) ? stored.ccswActiveRelay : 0;
    // Sticky, but only if that relay is actually usable; otherwise fall to the
    // first that is (which is how an empty-token primary is skipped).
    activeRelayIndex = relayUsable(relays[storedIndex]) ? storedIndex : firstUsableRelayIndex(0);
    if (activeRelayIndex < 0) {
      activeRelayIndex = 0;
      console.warn('[CCswitchboard] relays: NO relay has a token -- relay calls will fail until one is set.');
    }

    console.log(`[CCswitchboard] relays: ${relays.length} configured, active = ${relays[activeRelayIndex].base}`);
    return relays;
  })();
  try {
    return await relaysLoading;
  } finally {
    relaysLoading = null;
  }
}

function activeRelay() {
  return relays ? relays[activeRelayIndex] : null;
}

async function getActiveRelay() {
  await ensureRelaysLoaded();
  return activeRelay();
}

// Full URL for an endpoint filename on a GIVEN relay. Takes the relay rather
// than reading the active one itself, deliberately: a caller that needs both a
// URL and that relay's token (the DNR rules, the board cookie) must derive
// both from the SAME relay object, or a failover landing between the two reads
// would pair one relay's base with another's token -- a 401 that only ever
// reproduces mid-outage.
function relayUrl(relay, file) {
  return `${relay.base}/${file}`;
}

async function persistActiveRelayIndex() {
  try {
    await chrome.storage.local.set({ ccswActiveRelay: activeRelayIndex });
  } catch (e) {
    // Non-fatal: the switch still holds for this worker's lifetime.
    console.warn('[CCswitchboard] relays: could not persist active relay index:', e);
  }
}

// Called on every switch: the two declarativeNetRequest rules and the tabs'
// cached base are all relay-specific, so they must follow the active relay or
// they'd keep pointing at the dead one.
//
// Every step is best-effort and the whole thing is caught: this runs on the
// failover path, from inside ccswFetch's error handling, and a throw here
// would propagate out and lose the retry that the failover exists to enable.
// The switch itself has already happened by this point -- these are just the
// side effects, and a failed DNR update must not cost the caller its request.
async function onActiveRelayChanged(reason) {
  try {
    await persistActiveRelayIndex();
    await registerHeaderRule().catch(() => {});
    await registerFeedTokenRule().catch(() => {});
    broadcastRelayInfo();

    // Durable dispatched-key / beacon caches are RELAY-SPECIFIC: they were
    // fetched from the relay we just left, and its stable_keys/beacons say
    // nothing about the one we switched to (each relay is a separate deployment
    // with its own DB). Leaving them in place would let a stale old-relay bucket
    // answer rule (a) for a thread the NEW relay has never heard of -- suppressing
    // a block that should fire, or broadcasting keys the new relay can't back up.
    // Drop them and refetch from the new relay. fetchedAt is deliberately NOT
    // reset: content.js's arrived-test keys on "a fetch has completed", and a
    // fresh/empty relay legitimately returns no bucket -- with fetchedAt intact,
    // a thread with no bucket reads as the empty set (favour dispatch) instead of
    // re-deferring every tab's blocks during the switch.
    durableDispatchedKeys.clear();
    durableBeacons.clear();
    // Fire-and-forget: this runs from inside ccswFetch's failover error path, so
    // awaiting a fresh round of ccswFetch calls here would re-enter and stall the
    // very retry the failover exists to enable. Let it run on the next tick.
    refreshDurableDispatchState().catch((e) => {
      console.warn('[CCswitchboard] relays: post-failover durable refetch failed (will retry on next poll):', e && e.message ? e.message : e);
    });

    console.warn(`[CCswitchboard] relays: *** now using ${activeRelay().base} (${reason}) ***`);
  } catch (e) {
    console.warn('[CCswitchboard] relays: post-switch housekeeping failed (switch itself stands):', e);
  }
}

function recordRelaySuccess(relay) {
  relay.failures = 0;
}

// Returns true when the active relay actually changed, so the caller can retry.
async function switchAwayFrom(relay, reason) {
  if (activeRelay() !== relay) return true; // someone else already moved us
  const next = firstUsableRelayIndex((activeRelayIndex + 1) % relays.length);
  if (next < 0 || next === activeRelayIndex) {
    console.warn(`[CCswitchboard] relays: *** ${relay.base} is failing (${reason}) but there is NO other usable relay -- staying put. ***`);
    relay.failures = 0; // don't scream on every subsequent request
    return false;
  }
  const from = relay.base;
  activeRelayIndex = next;
  relays[next].failures = 0;
  relay.failures = 0;
  relayProbeOks = 0;
  console.warn(`[CCswitchboard] relays: *** FAILOVER: ${from} -> ${relays[next].base} (${reason}) ***`);
  await onActiveRelayChanged(`failover from ${from}`);
  return true;
}

async function markRelayTokenRejected(relay) {
  if (relay.tokenRejected) return;
  relay.tokenRejected = true;
  console.error(`[CCswitchboard] relays: *** ${relay.base} REJECTED our token (401) -- dropping it from rotation. Set a valid token in chrome.storage.local ccswRelays. ***`);
  await switchAwayFrom(relay, 'token rejected');
}

// Books a failed request and reports whether to retry elsewhere. A 401 has
// already dropped the relay from rotation inside relaySend, so it doesn't also
// burn a strike -- but it IS worth retrying on whatever we switched to.
async function handleRelayFailure(relay, err) {
  if (relay.tokenRejected) return activeRelay() !== relay;
  relay.failures += 1;
  console.warn(`[CCswitchboard] relays: ${relay.base} failure ${relay.failures}/${RELAY_FAILURE_THRESHOLD}: ${err && err.message ? err.message : err}`);
  if (relay.failures < RELAY_FAILURE_THRESHOLD) return false;
  return switchAwayFrom(relay, `${relay.failures} consecutive failures`);
}

// Resolves a bare 'feed.php?x=1' against a relay; an absolute URL is passed
// through untouched (a caller that already built one is pinning deliberately).
function resolveRelayPath(relay, path) {
  return /^https?:\/\//i.test(path) ? path : relayUrl(relay, path);
}

// The single place a relay request is made and the ONLY place the token header
// is attached. Throws on transport failure, timeout or 5xx (all count as
// strikes) and on 401 (which drops the relay from rotation instead). Every
// other status -- notably 404 -- is returned as-is: the relay answered, so it
// is alive, and an endpoint that isn't deployed there must not trigger
// failover (see alert.php, which 404s until deployed).
async function relaySend(relay, path, init) {
  const headers = new Headers(init.headers || {});
  if (relay.token) headers.set('X-CCSW-Token', relay.token);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(resolveRelayPath(relay, path), { ...init, headers, signal: controller.signal });
  } catch (err) {
    // AbortError here is our own timeout, which is a failure, not a cancel.
    throw err && err.name === 'AbortError'
      ? new Error(`request to ${relay.base}/${path} timed out after ${RELAY_TIMEOUT_MS}ms`)
      : err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    await markRelayTokenRejected(relay);
    throw new Error(`${relay.base}/${path} returned 401 (token rejected)`);
  }
  if (res.status >= 500) {
    throw new Error(`${relay.base}/${path} returned ${res.status}`);
  }

  recordRelaySuccess(relay);
  return res;
}

// Drop-in fetch replacement for ALL relay calls. Takes an endpoint FILENAME
// (optionally with a query string), resolves it against the active relay,
// attaches that relay's token, and fails over + retries once when the active
// relay has failed RELAY_FAILURE_THRESHOLD times in a row.
async function ccswFetch(path, init = {}) {
  await ensureRelaysLoaded();
  const relay = activeRelay();
  try {
    return await relaySend(relay, path, init);
  } catch (err) {
    const switched = await handleRelayFailure(relay, err);
    if (!switched) throw err;
    const next = activeRelay();
    console.warn(`[CCswitchboard] relays: retrying ${path} on ${next.base}`);
    return relaySend(next, path, init);
  }
}

// While running on anything other than the primary, poke it every ~60s and go
// back once it answers cleanly RELAY_PROBE_OKS_TO_SWITCH_BACK times running.
// A cheap authenticated GET -- NOT poll.php, which would CLAIM a job the probe
// then throws away.
const RELAY_PROBE_PATH = `${RELAY_JOBS_FILE}?status=all&limit=1`;

async function probePrimaryRelay() {
  await ensureRelaysLoaded();
  const primary = relays[0];
  if (activeRelay() === primary) {
    relayProbeOks = 0;
    return;
  }
  // No token, or one it already rejected: probing can only fail.
  if (!relayUsable(primary)) return;

  try {
    // Pinned to the primary deliberately: a probe must never fail over.
    await relaySend(primary, RELAY_PROBE_PATH, { method: 'GET' });
    relayProbeOks += 1;
    console.log(`[CCswitchboard] relays: probe of ${primary.base} OK (${relayProbeOks}/${RELAY_PROBE_OKS_TO_SWITCH_BACK} to switch back)`);
    if (relayProbeOks < RELAY_PROBE_OKS_TO_SWITCH_BACK) return;
    const from = activeRelay().base;
    activeRelayIndex = 0;
    primary.failures = 0;
    relayProbeOks = 0;
    console.warn(`[CCswitchboard] relays: *** FAILBACK: ${from} -> ${primary.base} (primary healthy) ***`);
    await onActiveRelayChanged('primary healthy again');
  } catch (err) {
    // Reset: the OKs must be CONSECUTIVE, or a relay that flaps every other
    // minute would eventually accumulate its way back to active.
    relayProbeOks = 0;
    console.log(`[CCswitchboard] relays: probe of ${primary.base} failed, staying on ${activeRelay().base}: ${err && err.message ? err.message : err}`);
  }
}

// --- relay info for content scripts ----------------------------------------
// content.js can't fetch the relay itself (CORS) and must not hardcode a base
// either, so it asks for the active one and gets pushed a fresh copy on every
// failover. `origins` carries EVERY configured relay, not just the active one:
// content.js validates postMessage origins against it, and an iframe created
// just before a switch still legitimately speaks from the previous relay.
function relayInfoPayload() {
  const relay = activeRelay();
  if (!relay) return null;
  return {
    base: relay.base,
    feedUrl: relayUrl(relay, RELAY_FEED_FILE),
    boardUrl: relayUrl(relay, BOARD_FILE),
    origins: relays.map((r) => {
      try {
        return new URL(r.base).origin;
      } catch (e) {
        return null;
      }
    }).filter(Boolean),
  };
}

async function broadcastRelayInfo() {
  const info = relayInfoPayload();
  if (!info) return;
  try {
    const tabs = await chrome.tabs.query({ url: CLAUDE_TAB_URL_PATTERN });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'ccsw-relay-info', info }).catch(() => {});
    }
  } catch (e) {
    // Cosmetic, same as every other broadcast here.
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-get-relay-info') return false;
  (async () => {
    await ensureRelaysLoaded();
    sendResponse(relayInfoPayload());
  })();
  return true; // async sendResponse
});

// A plain setInterval, re-established every time this script loads, exactly
// like pollToolbarJobs/pollWake/pollFocusRequests -- same tradeoff as those
// (see the setInterval-vs-chrome.alarms note above pollToolbarJobs), and this
// worker is kept alive by their 2-4s polling regardless. chrome.alarms would
// also need a new manifest permission this extension doesn't currently hold.
setInterval(() => { probePrimaryRelay().catch(() => {}); }, RELAY_PROBE_INTERVAL_MS);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.prototype.hasOwnProperty.call(changes, 'ccswRelays')
    || Object.prototype.hasOwnProperty.call(changes, 'ccswToken')) {
    // Drop the cache so the next call re-reads (and re-migrates if needed):
    // a freshly-set/rotated token must start authenticating immediately, and
    // a token filled in for a skipped relay must bring it back into rotation.
    relays = null;
    relayProbeOks = 0;
    ensureRelaysLoaded()
      .then(() => {
        registerHeaderRule().catch(() => {});
        registerFeedTokenRule().catch(() => {});
        broadcastRelayInfo();
      })
      .catch(() => {});
  }
});

// feed.php only inlines the shared relay token for an ALREADY-authenticated
// request (it verifies X-CCSW-Token / the ccsw_token cookie server-side; an
// unauthenticated GET gets an empty token, never the secret). The board's own
// feed dialog is same-origin and rides the ccsw_token cookie automatically,
// but this extension embeds feed.php as a CROSS-ORIGIN iframe on claude.ai,
// where the SameSite=Strict gate cookie is withheld and an iframe navigation
// can't carry a script-set header. So mirror registerHeaderRule's trick: a
// declarativeNetRequest rule attaches X-CCSW-Token to the feed.php sub_frame
// request (the UA rule only covers xmlhttprequest, so it doesn't apply here).
// With no token stored yet the rule is removed -- nothing is attached and
// feed.php falls back to its no-secret gate.
//
// BOTH the token and the urlFilter are ACTIVE-RELAY-SPECIFIC, so this is
// re-registered on every failover as well as at startup (see
// onActiveRelayChanged): a rule still pointing at the previous relay would
// attach the wrong relay's token to the new relay's iframe, i.e. a 401.
async function registerFeedTokenRule() {
  const relay = await getActiveRelay();
  const token = relay && relay.token;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [FEED_TOKEN_RULE_ID],
    addRules: token
      ? [
          {
            id: FEED_TOKEN_RULE_ID,
            priority: 1,
            action: {
              type: 'modifyHeaders',
              requestHeaders: [{ header: 'X-CCSW-Token', operation: 'set', value: token }],
            },
            condition: {
              urlFilter: relayUrl(relay, RELAY_FEED_FILE),
              resourceTypes: ['sub_frame'],
            },
          },
        ]
      : [],
  });
}

// Pre-sets the board page's gate cookie from the same token used for the
// X-CCSW-Token header, so 'Open board' can skip the manual "Relay token"
// prompt. Same token value, different transport -- header for relay
// endpoints, cookie for the browser-rendered gate.
//
// Returns a DETAILED result so content.js's click handler can show Jody
// exactly why this silently failed, rather than falling through to the gate
// with no explanation (which is what 131100a shipped and is undiagnosable):
//   {ok:true, cookie:<the cookie chrome.cookies.set resolved with>}
//   {ok:false, stage:'cookies-api-missing', error} -- 'cookies' permission not active
//   {ok:false, stage:'no-token', error}             -- active relay has no token set
// Both the cookie's URL and its path follow the ACTIVE relay: the gate cookie
// only means anything to the relay whose token it holds.
//   {ok:false, stage:'set-threw', error}             -- cookies.set threw OR resolved null
//     (a null resolve is cookies.set's own way of saying "rejected" -- e.g. a
//     secure/sameSite/url mismatch -- it does not throw for that case)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-set-board-cookie') return false; // not for us

  (async () => {
    let result;
    try {
      if (!chrome.cookies) {
        result = { ok: false, stage: 'cookies-api-missing', error: 'chrome.cookies unavailable -- cookies permission not active' };
      } else {
        const relay = await getActiveRelay();
        const token = relay && relay.token;
        if (!token) {
          result = { ok: false, stage: 'no-token', error: `active relay ${relay ? relay.base : '(none)'} has no token in ccswRelays` };
        } else {
          try {
            const cookie = await chrome.cookies.set({
              url: relayUrl(relay, BOARD_FILE),
              name: BOARD_COOKIE_NAME,
              value: token,
              path: boardCookiePath(relay.base),
              secure: true,
              sameSite: 'lax',
              expirationDate: Date.now() / 1000 + BOARD_COOKIE_MAX_AGE_SECONDS,
            });
            if (!cookie) {
              result = { ok: false, stage: 'set-threw', error: 'cookies.set returned null (rejected -- check secure/sameSite/url match)' };
            } else {
              result = { ok: true, cookie };
            }
          } catch (err) {
            result = { ok: false, stage: 'set-threw', error: err.message };
          }
        }
      }
    } catch (err) {
      result = { ok: false, stage: 'set-threw', error: err.message };
    }
    console.log('[CCswitchboard] board cookie set result:', result);
    sendResponse(result);
  })();

  return true; // keep the message channel open for the async sendResponse above
});

const POLL_INTERVAL_MS = 3000;
const FOCUS_POLL_INTERVAL_MS = 2000;
const WAKE_POLL_INTERVAL_MS = 3000;
const PLAN_WAKE_POLL_INTERVAL_MS = 3000;
const TOOLBAR_POLL_INTERVAL_MS = 2000;
const ACTIONS_POLL_INTERVAL_MS = 4000;
const AGENT_OFFLINE_POLL_INTERVAL_MS = 5000;
const TAB_HEARTBEAT_MS = 5000;
const CLAUDE_TAB_URL_PATTERN = 'https://claude.ai/*';

// The urlFilter is ACTIVE-RELAY-SPECIFIC, so like registerFeedTokenRule this
// is re-registered on every failover as well as at startup (see
// onActiveRelayChanged) -- a rule still scoped to the previous relay would
// leave the new relay's requests with no User-Agent, which its host WAF 429s.
async function registerHeaderRule() {
  const relay = await getActiveRelay();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'User-Agent', operation: 'set', value: USER_AGENT }],
        },
        condition: {
          urlFilter: relayUrl(relay, '*'),
          resourceTypes: ['xmlhttprequest'],
        },
      },
    ],
  });
  console.log(`[CCswitchboard] background: registered User-Agent rewrite rule for ${relay.base}.`);
}

// Seed both relay-scoped DNR rules at install/startup, so the cross-origin
// iframe authenticates and relay XHRs carry a User-Agent without waiting for a
// token change or a failover to re-register them.
function registerRelayRules() {
  registerHeaderRule().catch(() => {});
  registerFeedTokenRule().catch(() => {});
}

chrome.runtime.onInstalled.addListener(registerRelayRules);
chrome.runtime.onStartup.addListener(registerRelayRules);
// The service worker is also spun up cold (no onInstalled/onStartup) whenever
// an event wakes it, so seed the rules on plain worker load too.
registerRelayRules();

// --- diagnostic channel --------------------------------------------------
// Fire-and-forget log of extension-side events to debug_log.php's
// debug.log, so CC can inspect what actually happened (e.g. a job pill
// stuck spinning) via curl instead of a human relaying DevTools console
// output by hand. Never allowed to affect real behaviour -- every call site
// below is a bare, uncaught-error-swallowing side effect.
const DEBUG = true;

function ccswDebug(tag, data) {
  if (!DEBUG) return;
  ccswFetch(RELAY_DEBUG_FILE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag, data }),
  }).catch(() => {});
}

// content.js can't fetch dabblelabs.uk directly (same CORS wall documented
// on registerHeaderRule above), so its own ccswDebug() relays through here.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-debug-log') return false;
  ccswDebug(message.tag, message.data);
  return false; // no response needed
});

// --- central debug log -----------------------------------------------------
// Build stamp, bumped by hand whenever a change needs to be distinguishable in
// the log. Its whole job is to expose a STALE TAB: a claude.ai tab that hasn't
// been reloaded since the extension updated keeps running the old content.js,
// so its events arrive stamped with the old build while background.js's events
// carry the new one. Same const lives in content.js -- keep them in step.
const CCSW_BUILD = '20260719-usability-rescue-1';

// --- verbose logging gate --------------------------------------------------
// The service-worker console is otherwise flooded by the send state machine's
// per-tick trace lines (hold-check fires roughly every 200ms per held job;
// find-button and await-clear fire every send tick) plus the per-poll wake
// chatter, drowning the one-shot lifecycle lines that actually matter.
// ccswVerboseLog (chrome.storage.local, default OFF) gates that noise: vlog()
// forwards to console.log ONLY when verbose is on. Mirrored into an in-memory
// cache the same way piggybackProbeCache is -- an initial load plus a
// storage.onChanged listener -- so vlog() stays synchronous (no await per call).
// Turn it on from the service-worker DevTools console with:
//   chrome.storage.local.set({ ccswVerboseLog: true })
// and off again with { ccswVerboseLog: false } (or remove the key).
let verboseLogCache = false;
chrome.storage.local.get('ccswVerboseLog').then((stored) => {
  verboseLogCache = stored.ccswVerboseLog === true;
}).catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, 'ccswVerboseLog')) {
    verboseLogCache = changes.ccswVerboseLog.newValue === true;
  }
});
function vlog(...args) {
  if (verboseLogCache) console.log(...args);
}

// Every content script sees only its own tab; this service worker is the one
// place that sees all of them. Content scripts fire logEvent() -> the ring
// buffer below -> a throttled POST to debuglog.php, giving Claude a single
// cross-tab view. Logging is strictly best-effort: it must never block, retry
// hard, or throw into a real code path.
const DEBUG_EVENT_RING_MAX = 500;
const DEBUG_EVENT_FLUSH_MS = 2500;
const DEBUG_EVENT_FLUSH_AT = 25;
// A failed flush re-queues its events, so cap what we're willing to carry --
// an offline relay must not grow this without bound.
const DEBUG_EVENT_PENDING_MAX = 500;

// Last DEBUG_EVENT_RING_MAX events seen by this worker, kept in memory purely
// so a flush failure (or a service-worker restart mid-batch) doesn't lose the
// most recent context. The relay's table is the durable copy.
const debugEventRing = [];
let debugEventPending = [];
let debugEventFlushTimer = null;

function recordDebugEvent(event, urgent = false) {
  debugEventRing.push(event);
  if (debugEventRing.length > DEBUG_EVENT_RING_MAX) {
    debugEventRing.splice(0, debugEventRing.length - DEBUG_EVENT_RING_MAX);
  }

  debugEventPending.push(event);
  if (debugEventPending.length > DEBUG_EVENT_PENDING_MAX) {
    debugEventPending.splice(0, debugEventPending.length - DEBUG_EVENT_PENDING_MAX);
  }

  // Urgent events (e.g. the favicon-debug heartbeat) bypass both the
  // flush-at-25 batch check and the coalesce timer below -- they need to land
  // immediately, not wait out DEBUG_EVENT_FLUSH_MS or a full batch.
  if (urgent) {
    flushDebugEvents();
    return;
  }

  // Flush on a full-enough batch, otherwise coalesce a burst into one POST.
  if (debugEventPending.length >= DEBUG_EVENT_FLUSH_AT) {
    flushDebugEvents();
    return;
  }
  if (debugEventFlushTimer === null) {
    debugEventFlushTimer = setTimeout(() => {
      debugEventFlushTimer = null;
      flushDebugEvents();
    }, DEBUG_EVENT_FLUSH_MS);
  }
}

async function flushDebugEvents() {
  if (debugEventFlushTimer !== null) {
    clearTimeout(debugEventFlushTimer);
    debugEventFlushTimer = null;
  }
  if (debugEventPending.length === 0) return;

  // Take the batch before awaiting, so events logged during the POST queue up
  // for the next flush rather than being dropped by the success path below.
  const batch = debugEventPending;
  debugEventPending = [];

  try {
    const res = await ccswFetch(RELAY_DEBUGLOG_FILE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    // Put the batch back in front of anything logged while we were away, then
    // re-cap. Dropping the OLDEST is right: a stale event matters less than
    // the one that just fired.
    debugEventPending = batch.concat(debugEventPending);
    if (debugEventPending.length > DEBUG_EVENT_PENDING_MAX) {
      debugEventPending.splice(0, debugEventPending.length - DEBUG_EVENT_PENDING_MAX);
    }
    console.warn('[CCswitchboard] background: debug log flush failed, will retry:', err.message);
  }
}

// content.js's logEvent() lands here. Fire-and-forget by design: no response,
// no await, and a malformed event is dropped rather than throwing back into
// the content script's real code path.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'ccsw-debug-event') return false; // not for us

  const event = message.event;
  if (!event || typeof event.type !== 'string' || event.type === '') return false;

  const urgent = message.urgent === true;

  recordDebugEvent({
    ts: typeof event.ts === 'string' && event.ts !== '' ? event.ts : new Date().toISOString(),
    build: typeof event.build === 'string' ? event.build : null,
    thread: typeof event.thread === 'string' && event.thread !== '' ? event.thread : null,
    type: event.type,
    // Tab id isn't something the content script can know about itself, but
    // it's the one field that lets Claude tell two same-thread tabs apart.
    detail: { ...(event.detail && typeof event.detail === 'object' ? event.detail : { value: event.detail ?? null }), tabId: sender.tab?.id ?? null },
  }, urgent);

  return false; // no response needed
});

// --- claude.ai generation records ------------------------------------------
// content.js's generation watcher lands here, one message per completed
// generation (never per tick). Same shape as every other RELAY_* call: the
// content script can't reach dabblelabs.uk itself (CORS), so it messages us
// and we POST via ccswFetch, which attaches X-CCSW-Token.
//
// Fire-and-forget, and deliberately WITHOUT the debug ring's re-queue-and-
// retry machinery: this is passive telemetry, not a delivery path -- a lost
// row costs one line of history, whereas a retry loop against a down relay
// costs a wedged worker. One warn, then drop.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-output-record') return false; // not for us

  const record = message.record;
  // output_log.php 400s without these three; drop rather than POST a reject.
  if (!record || !record.ts_start || !record.ts_end || typeof record.duration_ms !== 'number') return false;

  ccswFetch(RELAY_OUTPUT_LOG_FILE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }).catch((err) => {
    console.warn('[CCswitchboard] background: output record POST failed:', err.message);
  });

  return false; // no response needed
});

// --- debug log retrieval ---------------------------------------------------
// One line per event, oldest first, in the order debuglog.php returns them.
function formatDebugEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return 'FYI: CCSW debug log: (empty -- no events recorded)';
  }
  const lines = events.map((e) => {
    let detail = '';
    try {
      detail = e.detail === null || e.detail === undefined ? '' : JSON.stringify(e.detail);
    } catch (err) {
      detail = '(undisplayable)';
    }
    return `${e.ts}|${e.build ?? '-'}|${e.thread ?? '-'}|${e.type}|${detail}`;
  });
  return `FYI: CCSW debug log (${events.length} events, oldest first):\n${lines.join('\n')}`;
}

const DEBUGLOG_DELIVER_DEFAULT_LIMIT = 150;

// Shared by BOTH retrieval paths -- the Advanced panel's "Send debug log to
// chat" button and a Claude-authored {"debuglog": true} ccsw block. Neither
// can fetch the relay itself (content.js is behind the same CORS wall as every
// other RELAY_* call), so both message us and we do the fetch + the typing.
//
// Delivery reuses the send state machine via queueSend, exactly as
// ccsw-deliver-actions does: no job id (the debug log isn't tied to one), so
// jobId: null, same as the plan-quiet/repo-free wakes.
async function deliverDebugLog({ tabId, thread, limit, type }) {
  // Built as a RELATIVE path (filename + query) and left for ccswFetch to
  // resolve against the active relay -- URLSearchParams rather than new URL(),
  // which needs an absolute base this function no longer has.
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEBUGLOG_DELIVER_DEFAULT_LIMIT;
  const params = new URLSearchParams({ limit: String(n) });
  if (typeof type === 'string' && type !== '') params.set('type', type);
  const path = `${RELAY_DEBUGLOG_FILE}?${params.toString()}`;

  // Flush anything still buffered first, so the log we hand back includes the
  // events that prompted someone to ask for it. Best-effort: a failed flush
  // still lets the fetch below return whatever did make it to the relay.
  await flushDebugEvents();

  const res = await ccswFetch(path, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const events = Array.isArray(body?.events) ? body.events : [];

  queueSend(`debuglog:${Date.now()}`, {
    tabId,
    jobId: null,
    thread: thread ?? null,
    kind: 'debuglog',
    text: formatDebugEvents(events),
    speakPhrase: null,
    label: 'debug log',
  });

  return events.length;
}

// Advanced panel button + {"debuglog": true} ccsw block both send this.
// Answers with {ok, count} so the panel can report what it delivered; the
// ccsw-block path ignores the response.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-debuglog-deliver') return false; // not for us

  const senderTabId = sender.tab?.id;
  if (senderTabId === undefined) return false;

  (async () => {
    try {
      // D1 #28: same cross-thread destination fix as ccsw-pillstatus-deliver
      // -- deliver to whichever tab is the CCSW control thread (or, failing
      // that, the most recently active CCSW tab), not necessarily the tab
      // that asked for the log.
      const tabId = await resolveLatestCcswTabId(senderTabId);
      let thread = null;
      for (const [t, id] of registeredThreads) {
        if (id === tabId) thread = t;
      }

      const count = await deliverDebugLog({
        tabId,
        thread,
        limit: message.limit,
        type: message.logType,
      });
      sendResponse({ ok: true, count });
    } catch (err) {
      console.warn('[CCswitchboard] background: failed to deliver debug log:', err.message);
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
});

// Issue #28's "Status" pill. The text is composed entirely content-side (it's a
// snapshot of that tab's own pills, which only it can see), so unlike
// deliverDebugLog there's nothing to fetch -- this is purely the delivery half.
//
// Same delivery engine as deliverDebugLog and ccsw-deliver-actions: queueSend,
// with jobId: null since a pill snapshot isn't tied to one job. The difference
// is the target -- the debug log types into the tab that asked for it, whereas
// this goes to the most recently active CCSW tab, which is usually NOT the tab
// holding the pills being described.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-pillstatus-deliver') return false; // not for us

  const senderTabId = sender.tab?.id;
  if (senderTabId === undefined) return false;
  if (typeof message.text !== 'string' || message.text === '') return false;

  (async () => {
    try {
      const tabId = await resolveLatestCcswTabId(senderTabId);

      // Tag the send with whatever thread that TARGET tab speaks for (not the
      // sender's), so the send state machine's logging lines up with where the
      // text actually lands.
      let thread = null;
      for (const [t, id] of registeredThreads) {
        if (id === tabId) thread = t;
      }

      queueSend(`pillstatus:${Date.now()}`, {
        tabId,
        jobId: null,
        thread,
        kind: 'pillstatus',
        text: message.text,
        speakPhrase: null,
        label: 'pill status',
      });
      sendResponse({ ok: true, tabId, deliveredToSender: tabId === senderTabId });
    } catch (err) {
      console.warn('[CCswitchboard] background: failed to deliver pill status:', err.message);
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
});

// jobId -> last logged lifecycle state, for the transition log below.
// Covers the slice of the JOB PILL lifecycle
// (dispatched -> running -> output -> result-landed -> marked-done ->
// spinner-clear) this file can observe directly; content.js tracks its own
// slice (output/result-landed/spinner-clear) with an identical helper,
// since the two contexts see different events for the same job.
const pillLifecycleState = new Map();

function logPillTransition(jobId, thread, newState) {
  const oldState = pillLifecycleState.get(jobId) ?? null;
  if (oldState === newState) return;
  pillLifecycleState.set(jobId, newState);
  ccswDebug('pill-lifecycle', { jobId, thread, oldState, newState });
}

// A content_scripts-declared injection (manifest.json) only ever runs on a
// fresh page load -- installing, updating, or reloading (chrome://extensions)
// this extension does NOT retroactively inject into tabs that were already
// open, leaving them stuck running the previous version's content.js until
// the user manually refreshes. This re-injects the current content.js +
// content.css into every already-open claude.ai tab right after
// install/update/reload, so a manual refresh is never required.
//
// content.js itself guards against running twice on the same page (see its
// own top-of-file check) since this executeScript call and the manifest's
// own content_scripts declaration can otherwise both fire for the same tab
// (e.g. a tab that finishes navigating at the same moment the extension
// reloads).
const CONTENT_SCRIPT_FILES = ['content.js'];
const CONTENT_STYLE_FILES = ['content.css'];

async function reinjectClaudeTabs(context) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: CLAUDE_TAB_URL_PATTERN });
  } catch (err) {
    console.warn(`[CCswitchboard] background: ${context}: failed to query claude.ai tabs for re-injection:`, err.message);
    return;
  }

  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: CONTENT_STYLE_FILES });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPT_FILES });
      console.log(`[CCswitchboard] background: ${context}: re-injected content script into tab ${tab.id} (${tab.url}).`);
    } catch (err) {
      console.warn(`[CCswitchboard] background: ${context}: failed to re-inject into tab ${tab.id}:`, err.message);
    }
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  reinjectClaudeTabs(`onInstalled (reason: ${details.reason})`);
});

// --- stale-tab detection & recovery (issue #18) -----------------------------
// reinjectClaudeTabs above re-runs content.js in every open tab, but content.js
// guards itself against double-init via window.__ccswContentScriptLoaded (see
// its own top-of-file comment) -- and that flag is still set from the tab's
// PREVIOUS content script instance, since a page that was never reloaded never
// cleared it. So the re-injected file loads, sees the guard already tripped,
// and skips ccswInitContentScript() entirely: the tab silently keeps running
// the old script's closures/state even though reinjectClaudeTabs logged a
// "success". This sweep is what actually catches that: probe each tab for
// window.__ccswBuild (set by the current content.js at load) and compare it
// against this worker's own CCSW_BUILD. A tab that's missing it, or reports an
// old value, is stale.
//
// The sweep surfaces the stale set THREE ways (staged per fable-plans #18):
//   S1 -- the passive F5 banner (kept below), plus an OS notification and a
//         blocking Action-List item naming the stale tabs, so a quiet tab that
//         never errors is no longer discovered only by things not happening.
//   S2 -- a one-tap "Reload empty tabs" action (on both the notification and the
//         Action-List item) that reloads stale tabs, but ONLY after a fresh
//         probe confirms the composer is empty -- never destroying typed text.
//   S3 -- an optional Settings toggle (default ON, ccswStaleAutoHeal) that
//         auto-reloads stale-but-composer-empty hidden tabs without the tap.
//
// The composer read below reuses the same selector list and textContent.trim()
// emptiness test the send state machine's probes use (see ccswInjProbeDelivery),
// inlined because chrome.scripting.executeScript serializes func in isolation.

// This worker's cache of the last sweep's stale set, pushed to every tab's
// Action List via broadcastStaleTabsState (client-local, NOT relay-synced: a
// stale tab is a transient per-browser condition, not a durable task). Each
// entry: { tabId, title, build, composerEmpty }.
let latestStaleTabs = [];

// Notification dedupe: the signature of the stale set we last raised an OS
// notification for. SW restarts re-run the sweep, and without this every
// restart would re-nag for the same already-surfaced tabs. Keyed by the stale
// builds + tab ids so a genuinely new stale tab (or a new build) still notifies.
let lastStaleNotifyKey = null;
const STALE_NOTIFICATION_ID = 'ccsw-stale-tabs';

// One read-only probe injected into every claude.ai tab: its running build and
// whether its composer currently holds text. Self-contained (no outer-scope
// refs) because executeScript serializes it in isolation. Never focuses,
// clicks, or mutates -- purely reports, safe to run alongside a live delivery.
function ccswInjStaleProbe() {
  try {
    const inputSelectors = [
      'div[contenteditable="true"][data-testid="chat-input"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"][data-testid]',
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"][class*="composer"]',
      'div[contenteditable="true"][placeholder]',
      'div[contenteditable="true"]',
    ];
    let input = null;
    for (const sel of inputSelectors) { input = document.querySelector(sel); if (input) break; }
    const composerText = input ? input.textContent.trim() : '';
    return {
      build: (window.__ccswBuild ?? null),
      composerFound: !!input,
      composerLen: composerText.length,
      composerEmpty: composerText.length === 0,
    };
  } catch {
    // A probe must never throw back into executeScript; a null result is
    // treated the same as "no script / unknown build" == stale below.
    return null;
  }
}

// The passive F5 banner (unchanged behaviour): injected into each stale tab.
function ccswInjStaleBanner() {
  try {
    if (document.getElementById('ccsw-stale-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'ccsw-stale-banner';
    banner.style.position = 'fixed';
    banner.style.top = '0';
    banner.style.left = '0';
    banner.style.right = '0';
    banner.style.zIndex = '2147483647';
    banner.style.backgroundColor = '#b91c1c';
    banner.style.color = '#ffffff';
    banner.style.padding = '10px 16px';
    banner.style.fontFamily = 'sans-serif';
    banner.style.fontSize = '14px';
    banner.style.display = 'flex';
    banner.style.alignItems = 'center';
    banner.style.justifyContent = 'center';
    banner.style.gap = '12px';
    banner.style.boxShadow = '0 2px 6px rgba(0,0,0,0.3)';

    const text = document.createElement('span');
    text.textContent = 'CCSW was updated - press F5 to reconnect this tab';

    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.style.backgroundColor = '#ffffff';
    dismiss.style.color = '#b91c1c';
    dismiss.style.border = 'none';
    dismiss.style.borderRadius = '4px';
    dismiss.style.padding = '4px 10px';
    dismiss.style.cursor = 'pointer';
    dismiss.style.fontSize = '13px';
    dismiss.addEventListener('click', () => banner.remove());

    banner.appendChild(text);
    banner.appendChild(dismiss);
    (document.body || document.documentElement).appendChild(banner);
  } catch {
    // Injected functions must never throw back into executeScript.
  }
}

// A short, human name for a stale tab in the notification / Action List. Uses
// the tab title (claude.ai sets it to the conversation name), which -- unlike
// window.__ccswThread -- is readable even for a tab whose script never injected
// at all. Falls back to the path, then a generic label.
function staleTabDisplayName(tab) {
  const title = (tab.title || '').trim();
  if (title) return title.length > 60 ? title.slice(0, 57) + '...' : title;
  try {
    const path = new URL(tab.url).pathname;
    if (path && path !== '/') return path;
  } catch {
    // fall through
  }
  return `tab ${tab.id}`;
}

// S3 toggle mirror: content.js persists ccswStaleAutoHeal; background reads it
// here the same lazy way getPiggybackProbeEnabled reads its flag. Default ON
// (!== false) -- enabled unless the stored value is explicitly false.
let staleAutoHealCache = false;
let staleAutoHealLoaded = false;

async function getStaleAutoHealEnabled() {
  if (staleAutoHealLoaded) return staleAutoHealCache;
  try {
    const stored = await chrome.storage.local.get('ccswStaleAutoHeal');
    staleAutoHealCache = stored.ccswStaleAutoHeal !== false;
  } catch {
    staleAutoHealCache = false;
  }
  staleAutoHealLoaded = true;
  return staleAutoHealCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, 'ccswStaleAutoHeal')) {
    staleAutoHealCache = changes.ccswStaleAutoHeal.newValue !== false;
    staleAutoHealLoaded = true;
  }
});

// Pushes the current stale set to every open claude.ai tab so their Action
// List pill/dialog can surface it (see content.js's ccsw-stale-tabs-state
// handler). Global, like broadcastActionsState -- the pill is browser-wide.
async function broadcastStaleTabsState() {
  let claudeTabs;
  try {
    claudeTabs = await chrome.tabs.query({ url: CLAUDE_TAB_URL_PATTERN });
  } catch (err) {
    console.warn('[CCswitchboard] background: stale-tabs broadcast: failed to query claude.ai tabs:', err.message);
    return;
  }
  const staleTabs = latestStaleTabs.map((s) => ({ tabId: s.tabId, title: s.title, composerFound: s.composerFound, composerEmpty: s.composerEmpty }));
  for (const tab of claudeTabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'ccsw-stale-tabs-state', staleTabs }).catch(() => {});
  }
}

// S1 notification. Deduped by the stale-set signature so repeated sweeps within
// (or across) SW restarts don't re-nag for tabs already surfaced. Carries a
// "Reload empty tabs" button wired through onButtonClicked below (S2 alt path).
function notifyStaleTabs() {
  if (latestStaleTabs.length === 0) {
    // Nothing stale now -- clear any prior notification and reset dedupe so a
    // future stale tab notifies again.
    if (lastStaleNotifyKey !== null) {
      chrome.notifications.clear(STALE_NOTIFICATION_ID);
      lastStaleNotifyKey = null;
    }
    return;
  }

  const key = latestStaleTabs
    .map((s) => `${s.tabId}:${s.build ?? 'none'}`)
    .sort()
    .join('|');
  if (key === lastStaleNotifyKey) return; // already surfaced this exact set
  lastStaleNotifyKey = key;

  const names = latestStaleTabs.map(staleTabDisplayName);
  const shown = names.slice(0, 4).join(', ');
  const extra = names.length > 4 ? ` +${names.length - 4} more` : '';
  const emptyCount = latestStaleTabs.filter((s) => s.composerFound && s.composerEmpty).length;
  const n = latestStaleTabs.length;

  chrome.notifications.create(
    STALE_NOTIFICATION_ID,
    {
      type: 'basic',
      iconUrl: NOTIFICATION_ICON,
      title: `${n} tab${n === 1 ? '' : 's'} running old CCSW build - F5 needed`,
      message: `${shown}${extra}`,
      buttons: emptyCount > 0 ? [{ title: `Reload ${emptyCount} empty tab${emptyCount === 1 ? '' : 's'}` }] : [],
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn('[CCswitchboard] background: stale-tab notification create failed:', chrome.runtime.lastError.message);
      }
    }
  );
}

// Bug A fix 4 (delivery-aware auto-heal): tabs that must NEVER be auto-reloaded
// because a delivery is in flight to them (a live pendingSends entry) or is
// still OWED to them (a durable active-delivery-registry job). A build-driven
// reload of such a tab would yank the composer out mid- or pre-delivery -- the
// exact "the build reload ate my job's output" loss this whole pass exists to
// prevent. Resolves each in-flight/owed entry to BOTH the tabId it froze at AND
// the thread's CURRENT registered tab (registeredThreads), so a thread that has
// since been handed off to another tab protects the live one too.
async function getDeliveryProtectedTabIds() {
  const protectedIds = new Set();
  const addTab = (tabId) => { if (tabId !== undefined && tabId !== null) protectedIds.add(tabId); };
  for (const entry of pendingSends.values()) {
    addTab(entry.tabId);
    if (entry.thread) addTab(registeredThreads.get(entry.thread));
  }
  let activeJobs = [];
  try {
    activeJobs = await loadActiveDeliveryJobs();
  } catch (err) {
    console.warn('[CCswitchboard] background: failed to load active-delivery registry for reload guard:', err.message);
  }
  for (const job of activeJobs) {
    addTab(job.tabId);
    if (job.thread) addTab(registeredThreads.get(job.thread));
  }
  return protectedIds;
}

// S2 core: reload stale tabs whose composer is EMPTY, re-probing each one right
// before the reload so a tab that gained text since the sweep is left alone
// (never destroy user text -- #68 spirit applies to F5 too). When autoHeal is
// true (S3), it additionally skips whichever tab is active in its window, so a
// tab the user is looking at is never yanked out from under them. Returns the
// count reloaded.
async function reloadStaleEmptyTabs(context, { autoHeal = false } = {}) {
  const targets = latestStaleTabs.slice();
  const reloadedIds = new Set(); // tabs to drop from the cached set (reloaded or already-fresh)
  let reloadedCount = 0; // genuine reloads WE performed, for the caller's report

  // Fix 4: never reload a tab that a delivery is mid-flight or owed to. Left in
  // latestStaleTabs (NOT added to reloadedIds) so it stays flagged and gets
  // healed on a later sweep once the delivery has cleared -- deferring the
  // reload, never cancelling it.
  const protectedTabIds = await getDeliveryProtectedTabIds();

  for (const stale of targets) {
    if (protectedTabIds.has(stale.tabId)) {
      logDeliveryEvent('stale_reload_skipped', { tabId: stale.tabId }, { reason: 'delivery_in_flight', context });
      continue;
    }

    let tab;
    try {
      tab = await chrome.tabs.get(stale.tabId);
    } catch {
      continue; // tab already gone
    }
    if (autoHeal && tab.active) continue; // auto-heal never yanks the tab selected in its window out from under the user (composer-empty is separately enforced below)

    // Fresh probe right before reload -- the sweep's snapshot may be stale.
    let probe = null;
    try {
      const results = await chrome.scripting.executeScript({ target: { tabId: stale.tabId }, func: ccswInjStaleProbe });
      probe = results?.[0]?.result ?? null;
    } catch {
      probe = null;
    }
    // A tab already on the current build is fresh (e.g. the user F5'd it, or a
    // concurrent heal got it) -- drop it from the cached set regardless of its
    // composer, so it stops being reported as stale.
    if (probe && probe.build === CCSW_BUILD) { reloadedIds.add(stale.tabId); continue; }

    // Reload ONLY when we POSITIVELY confirm an empty composer. A null probe
    // (page couldn't run a read-only func) OR a composer we couldn't even
    // locate (composerFound false) are both "unknown" -- never reload on
    // unknown, since composerEmpty is derived from an empty textContent that a
    // missing element also produces. Confirmed-empty is the only safe signal;
    // anything else is left for the user's own F5 (never destroy typed text).
    if (!probe || !probe.composerFound || !probe.composerEmpty) {
      const reason = !probe ? 'probe_failed' : (!probe.composerFound ? 'composer_not_found' : 'composer_has_text');
      logDeliveryEvent('stale_reload_skipped', { tabId: stale.tabId }, { reason, context });
      continue;
    }

    try {
      await chrome.tabs.reload(stale.tabId);
      reloadedIds.add(stale.tabId);
      reloadedCount += 1;
      logDeliveryEvent('stale_reload', { tabId: stale.tabId }, { autoHeal, context });
    } catch (err) {
      console.warn(`[CCswitchboard] background: ${context}: failed to reload stale tab ${stale.tabId}:`, err.message);
    }
  }

  if (reloadedIds.size > 0) {
    // Reloaded tabs will re-inject a fresh content script; drop ONLY those from
    // the cached set (tabs left for having text stay listed) and re-surface so
    // the pill/notification reflect exactly what remains stale.
    latestStaleTabs = latestStaleTabs.filter((s) => !reloadedIds.has(s.tabId));
    await broadcastStaleTabsState();
    notifyStaleTabs();
  }
  return reloadedCount;
}

async function sweepStaleTabs(context) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: CLAUDE_TAB_URL_PATTERN });
  } catch (err) {
    console.warn(`[CCswitchboard] background: ${context}: failed to query claude.ai tabs for stale-tab sweep:`, err.message);
    return;
  }

  const stale = [];
  for (const tab of tabs) {
    if (tab.id === undefined) continue;

    let probe = null;
    try {
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: ccswInjStaleProbe });
      probe = results?.[0]?.result ?? null;
    } catch (err) {
      console.warn(`[CCswitchboard] background: ${context}: failed to probe tab ${tab.id} for build:`, err.message);
      continue;
    }

    const tabBuild = probe?.build ?? null;
    if (tabBuild === CCSW_BUILD) continue;

    // composerFound distinguishes "found an empty composer" (safe to reload)
    // from "couldn't locate the composer at all" -- both yield an empty
    // textContent, but only the former is a confirmed-empty signal. A null
    // probe (script couldn't run) is neither. reloadStaleEmptyTabs and the UI
    // treat only (composerFound && composerEmpty) as reloadable.
    const composerFound = probe ? probe.composerFound === true : false;
    const composerEmpty = probe ? probe.composerEmpty === true : false;
    stale.push({ tabId: tab.id, title: tab.title || '', url: tab.url || '', build: tabBuild, composerFound, composerEmpty });

    logDeliveryEvent('stale_tab', { tabId: tab.id }, { staleBuild: tabBuild, composerFound, composerEmpty });

    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: ccswInjStaleBanner });
    } catch (err) {
      console.warn(`[CCswitchboard] background: ${context}: failed to inject stale banner into tab ${tab.id}:`, err.message);
    }
  }

  latestStaleTabs = stale;
  await broadcastStaleTabsState();
  notifyStaleTabs();

  // S3: auto-heal the composer-empty, hidden stale tabs if the toggle is on.
  if (stale.length > 0 && (await getStaleAutoHealEnabled())) {
    const healed = await reloadStaleEmptyTabs(`${context} (auto-heal)`, { autoHeal: true });
    if (healed > 0) console.log(`[CCswitchboard] background: ${context}: auto-healed ${healed} stale tab(s).`);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  sweepStaleTabs(`onInstalled (reason: ${details.reason})`);
});

// Also sweep on browser startup -- claude.ai tabs restored from the previous
// session may be running whatever build shipped before the restart. (Extension
// reload/update is covered by onInstalled above, the same trigger the reinject
// machinery relies on; a plain MV3 worker respawn is deliberately NOT swept --
// the build hasn't changed under it, so there'd be nothing stale to find and it
// would only cost a probe into every tab on every wake.)
chrome.runtime.onStartup.addListener(() => {
  sweepStaleTabs('onStartup');
});

// S1: a freshly-loaded tab asks for the current stale set (it may have opened
// after the last sweep's broadcast). Answered from this worker's cache.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ccsw-stale-tabs-get') return false; // not for us
  sendResponse({ staleTabs: latestStaleTabs.map((s) => ({ tabId: s.tabId, title: s.title, composerFound: s.composerFound, composerEmpty: s.composerEmpty })) });
  return false; // synchronous response
});

// S2 (manual): the Action List item's "Reload empty tabs" button posts this.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ccsw-reload-stale-tabs') return false; // not for us
  reloadStaleEmptyTabs('action-list-button', { autoHeal: false })
    .then((reloaded) => sendResponse({ ok: true, reloaded }))
    .catch(() => sendResponse({ ok: false, reloaded: 0 }));
  return true; // async sendResponse
});

// S2 (alt): the OS notification's "Reload empty tabs" button.
chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId !== STALE_NOTIFICATION_ID || buttonIndex !== 0) return;
  chrome.notifications.clear(STALE_NOTIFICATION_ID);
  reloadStaleEmptyTabs('notification-button', { autoHeal: false }).catch(() => {});
});

// Performs the actual job.php POST on content.js's behalf.
//
// A content script's fetch() is subject to the PAGE's (claude.ai's) CORS
// policy in MV3, regardless of this extension's host_permissions -- that
// bypass only applies to the extension's own privileged contexts (this
// service worker, popup, options page), not to code injected into a page.
// So content.js sends the parsed payload here via chrome.runtime.sendMessage
// instead of fetching directly, and this listener does the cross-origin
// POST where it's actually permitted to.
// Records which tab owns a thread, so anything else that knows the thread
// name (e.g. a future job dispatched without a live tab reference) can look
// up where to deliver it. Fire-and-forget: never blocks or fails the actual
// job dispatch below.
// thread -> tabId, for every thread this background worker has registered at
// least once. reregisterThreads() below re-POSTs every entry on a heartbeat
// so a registration never goes stale from a single fire-and-forget call at
// dispatch time -- register_tab.php's row is the thing focus_request.php and
// wake.php resolve a thread back to a tab through, so it must keep tracking
// whichever tab most recently spoke for a thread (dispatch, or a reopened/
// handed-off tab's ccsw-track-jobs message below).
const registeredThreads = new Map();

async function registerTab(thread, tabId) {
  // Capture the prior mapping BEFORE overwriting it so the success log below
  // can fire only when this thread's tab actually CHANGED. reregisterThreads()
  // re-POSTs every entry on a heartbeat, so without this an unchanged
  // re-registration would log on every tick; here it stays silent (even in
  // verbose mode) unless the thread->tab mapping really moved.
  const prevTabId = registeredThreads.get(thread);
  const mappingChanged = prevTabId !== tabId;
  registeredThreads.set(thread, tabId);
  try {
    const res = await ccswFetch(RELAY_REGISTER_TAB_FILE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread, tabId }),
    });
    if (!res.ok) {
      console.warn(`[CCswitchboard] background: register_tab failed for thread "${thread}" (HTTP ${res.status}).`);
      return;
    }
    if (mappingChanged) {
      vlog(`[CCswitchboard] background: registered thread "${thread}" -> tab ${tabId}.`);
    }
  } catch (err) {
    console.warn(`[CCswitchboard] background: register_tab error for thread "${thread}":`, err.message);
  }
}

async function reregisterThreads() {
  for (const [thread, tabId] of registeredThreads) {
    await registerTab(thread, tabId);
  }
}

// #62 STRANDED SENTINEL: piggybacks this heartbeat instead of adding a second
// alarm/interval -- every STRANDED_SENTINEL_INTERVAL_MS worth of heartbeat
// ticks, it also sweeps lastInjectedByTab for composer text abandoned by a
// delivery that already reached a terminal outcome (see runStrandedSentinelSweep,
// defined near lastInjectedByTab further down).
let tabHeartbeatTicks = 0;
setInterval(() => {
  reregisterThreads();
  tabHeartbeatTicks += 1;
  if (tabHeartbeatTicks * TAB_HEARTBEAT_MS >= STRANDED_SENTINEL_INTERVAL_MS) {
    tabHeartbeatTicks = 0;
    runStrandedSentinelSweep().catch((err) => {
      console.warn('[CCswitchboard] stranded sentinel: sweep failed:', err.message);
    });
  }
}, TAB_HEARTBEAT_MS);

// Which tab is "the CCSW chat" (issue #28's delivery target). A CCSW tab is one
// that has spoken for a thread, and the active one is whichever did so most
// recently -- Claude dispatches ccsw blocks from the conversation Jody is
// actually working in, so last-to-dispatch IS the live conversation.
//
// Kept in its own map rather than leaning on registeredThreads' iteration
// order, for two reasons. Map.set on an existing key does NOT move it to the
// end, so that order is FIRST-registration, not recency. And reregisterThreads
// re-registers every thread on a heartbeat, so bumping recency inside
// registerTab would flatten it -- only real activity (a dispatch, or a
// reopened tab reporting its live jobs) counts. Monotonic counter, not
// Date.now(), so two bumps in the same millisecond still order.
let ccswTabActivitySeq = 0;
const ccswTabActivity = new Map(); // tabId -> sequence number

function noteCcswTabActivity(tabId) {
  if (tabId === undefined || tabId === null) return;
  ccswTabActivity.set(tabId, ++ccswTabActivitySeq);
}

// D1 #28: the tab registered for the literal 'CCSwitchboard' control thread,
// if one is open. Checked BEFORE recency below -- "most recently active CCSW
// tab" (last to dispatch a job) can point at whichever working thread Claude
// last used, which is often NOT the control thread these status/debuglog/
// rescue-FYI deliveries are actually meant to land in. registeredThreads is
// this worker's own thread->tabId map (registerTab), kept current by the
// TAB_HEARTBEAT_MS re-registration below.
async function resolveCcswControlTabId() {
  const tabId = registeredThreads.get('CCSwitchboard');
  if (tabId === undefined) return undefined;
  try {
    await chrome.tabs.get(tabId);
    return tabId;
  } catch {
    registeredThreads.delete('CCSwitchboard'); // gone -- stop considering it
    return undefined;
  }
}

// Most recently active CCSW tab that still exists, else the tab that asked.
// Tabs closed while the worker slept are still in the map (onRemoved only fires
// while it's alive), so each candidate is probed before being trusted.
async function resolveLatestCcswTabId(fallbackTabId) {
  const controlTabId = await resolveCcswControlTabId();
  if (controlTabId !== undefined) return controlTabId;

  const byRecency = [...ccswTabActivity.entries()].sort((a, b) => b[1] - a[1]);
  for (const [tabId] of byRecency) {
    try {
      await chrome.tabs.get(tabId);
      return tabId;
    } catch {
      ccswTabActivity.delete(tabId); // gone -- stop considering it
    }
  }
  return fallbackTabId;
}

// Drop a closed tab's entries so the heartbeat above stops re-POSTing a dead
// tabId, and so pollToolbarJobs (below) stops retrying delivery to it.
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [thread, id] of registeredThreads) {
    if (id === tabId) registeredThreads.delete(thread);
  }
  for (const [jobId, id] of toolbarJobs) {
    if (id === tabId) toolbarJobs.delete(jobId);
  }
  for (const [key, entry] of pendingSends) {
    if (entry.tabId === tabId) pendingSends.delete(key);
  }
  if (pendingSends.size === 0) stopDeliveryKeepAlive();
  ccswTabActivity.delete(tabId);
  lastInjectedByTab.delete(tabId);
  ccswGenerationStateByTab.delete(tabId);
  queueFlushLoggedHead.delete(tabId);
});

// E6: in-thread live job toolbar. jobId -> tabId, for jobs a content script's
// toolbar bar is tracking. Populated below whenever a dispatch's sender tab
// is known; pollToolbarJobs() drains an entry once that job reaches "done".
const toolbarJobs = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-dispatch') return false; // not for us

  const tabId = sender.tab?.id;
  const thread = message.thread;

  if (thread && tabId !== undefined) {
    registerTab(thread, tabId);
    noteCcswTabActivity(tabId);
  }

  // #84 (threadless-block triple-dispatch): content.js's resolveDedupBucket()
  // result -- `thread` when the block declared one (identical value), or the
  // conversation's URL identity when it didn't. Kept separate from `thread`
  // itself (job payload routing, locks, the pill's displayed thread all stay
  // keyed on `thread`, unchanged) and carried as its own field end to end so
  // an older content script that never sends it just leaves it undefined,
  // same back-compat shape as stable_key below.
  const dispatchBucket = typeof message.dispatchBucket === 'string' && message.dispatchBucket !== ''
    ? message.dispatchBucket
    : thread;

  (async () => {
    try {
      // stable_key: content.js's fingerprintBlockStable for the block that
      // produced this dispatch, stamped onto the job row (job.php ignores it
      // if absent, so an older content script still dispatches fine). This is
      // the durable half of the identity the old per-tab in-memory set used to
      // hold alone -- dispatched.php reads it back.
      const res = await ccswFetch(RELAY_JOB_FILE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payload: message.payload,
          thread,
          continue: message.continue === true,
          readonly: message.readonly === true,
          stable_key: typeof message.stableKey === 'string' ? message.stableKey : undefined,
          dispatch_bucket: typeof message.dispatchBucket === 'string' ? message.dispatchBucket : undefined,
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body && body.id !== undefined) {
        sendResponse({ ok: true, id: body.id });
        logPillTransition(body.id, thread, 'dispatched');
        // Write through to the durable cache so this key reads as "already
        // dispatched" for every tab immediately, rather than only after the
        // next dispatched.php poll -- the row exists on the relay as of now.
        //
        // ONLY for a bucket already in the map. Creating a fresh entry here
        // would flip content.js's durableStateReadyFor(dispatchBucket) to true
        // while holding just this one key, which reads as "no other block in
        // this bucket has ever dispatched" -- resurrecting the bucket's entire
        // history on the next scan. An unfetched bucket must stay unfetched.
        if (typeof message.stableKey === 'string' && durableDispatchedKeys.has(dispatchBucket)) {
          durableDispatchedKeys.get(dispatchBucket).add(message.stableKey);
        }
        if (tabId !== undefined) {
          addActiveDeliveryJob(body.id, tabId, thread);
          toolbarJobs.set(body.id, tabId);
        } else {
          console.warn('[CCswitchboard] background: dispatch had no sender tab, cannot deliver a wake-prompt for job', body.id);
        }
      } else {
        sendResponse({ ok: false, status: res.status, body });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
});

// content.js's markUserSend() lands here, on every genuine user send (Enter, or
// a click on claude.ai's send button). Records the send in the relay's durable
// per-thread beacon table, which -- unlike the per-tab timestamp it replaced --
// survives a reload, a tab close, and this worker being torn down and restarted.
//
// THIS BEACON IS RULE (b) OF THE DISPATCH DECISION. A thread with no recent one
// dispatches nothing; content.js holds the block instead.
//
// AUTOPILOT DEPENDS ON THIS PATH, NON-OBVIOUSLY. A chained job's follow-up block
// needs a fresh beacon, and there is no user at the keyboard to make one. It
// gets one because this worker's own wake delivery (see ccswInjTryClickSend /
// ccswInjTryEnterSend) submits by clicking claude.ai's real send button or
// dispatching a real Enter KeyboardEvent into the composer -- both of which
// bubble to content.js's send listeners, which do not (and must not) filter on
// event.isTrusted. Adding such a filter would silently strand every autopilot
// chain in a held pill. The keep-alive hacks this replaced (a running job
// counting as a send) existed only because the old guard could not see across
// tabs; the beacon can.
//
// Fire-and-forget, exactly like ccsw-plan-update below: no response, nothing
// awaited on the content script's side, and a failed POST is a warning rather
// than anything the send path can notice.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-beacon') return false; // not for us

  const thread = message.thread;
  if (typeof thread !== 'string' || thread === '') return false; // beacon.php rejects an empty thread

  // Omitting a non-numeric sentAt lets beacon.php stamp its own clock rather
  // than persisting a garbage timestamp a recency check would later trust.
  const sentAt = typeof message.sentAt === 'number' && Number.isFinite(message.sentAt) ? message.sentAt : undefined;

  // Reflect the send into this worker's cache at once. The dispatch decision
  // hinges on beacon recency, and Claude can begin emitting a block well inside
  // one ACTIONS_POLL_INTERVAL_MS of the send that authorized it -- a cache that
  // only learned of the send on the next poll would hold that block instead.
  // Unlike dispatchedKeys above this is safe to create unconditionally: a
  // beacon's absence means "hold", so inventing one can only ever be as
  // authorizing as the send the user just made.
  durableBeacons.set(thread, sentAt ?? Date.now());

  ccswFetch(RELAY_BEACON_FILE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread, sentAt }),
  }).catch((err) => {
    console.warn(`[CCswitchboard] background: failed to post user-send beacon for thread "${thread}":`, err.message);
  });

  return false; // no response needed
});

// M3: content.js sends this whenever a ccsw block carries a `plan` array --
// plan-only blocks (no prompt/command) never reach the ccsw-dispatch handler
// above, so this is the only path a plan update reaches the relay through.
// Fire-and-forget: syncs db.php's plans table for checkPlanQuietWakes() but
// has no effect on the pill rendering content.js already did locally.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'ccsw-plan-update') return false; // not for us

  const thread = message.thread;
  if (!thread) return false;

  const plan = Array.isArray(message.plan) ? message.plan : [];
  ccswFetch(RELAY_PLAN_FILE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread, plan }),
  }).catch((err) => {
    console.warn(`[CCswitchboard] background: failed to sync plan for thread "${thread}":`, err.message);
  });

  return false; // no response needed
});

// Action List: content.js sends this whenever a ccsw block carries an
// `actions` array -- may ride alongside a real job dispatch or arrive on a
// standalone plan-only-style block, same as ccsw-plan-update above. It arrives
// carrying the thread the items were authored from (see content.js's
// sendActionsAdd), which rides up as actions.php's top-level batch `thread`;
// an absent/unresolvable thread is simply omitted and the items land untagged
// in the Global bucket. This then re-broadcasts the resulting full state to
// every open claude.ai tab, rather than replying only to the sender -- every
// tab's Action List pill must stay in sync, not just the one that happened to
// dispatch this block.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-actions-add') return false; // not for us

  const items = Array.isArray(message.actions) ? message.actions : [];
  if (items.length === 0) return false;

  const thread = typeof message.thread === 'string' && message.thread.trim() !== '' ? message.thread : null;

  (async () => {
    try {
      const payload = { add: items };
      if (thread) payload.thread = thread;
      const res = await ccswFetch(RELAY_ACTIONS_FILE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        latestActionsState = { actions: body.actions || [], counts: body.counts || latestActionsState.counts };
        await broadcastActionsState();
      }
    } catch (err) {
      console.warn('[CCswitchboard] background: failed to add action list item(s):', err.message);
    }
  })();

  return false; // no response needed
});

// Dialog's tick-off (see content.js's clearActionItem) -- deletes item(s) by
// id, then re-broadcasts so every open tab's pill/dialog drops them too.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'ccsw-actions-clear') return false; // not for us

  const ids = Array.isArray(message.ids) ? message.ids : [];
  if (ids.length === 0) return false;

  (async () => {
    try {
      const res = await ccswFetch(RELAY_ACTIONS_FILE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clear: ids }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        latestActionsState = { actions: body.actions || [], counts: body.counts || latestActionsState.counts };
        await broadcastActionsState();
      }
    } catch (err) {
      console.warn('[CCswitchboard] background: failed to clear action list item(s):', err.message);
    }
  })();

  return false; // no response needed
});

// Todo window's "other threads" expander (content.js): click a row -> jump to
// that thread. Deliberately reuses the two thread<->tab/URL mappings this
// extension already keeps rather than inventing a third:
//   (a) registeredThreads (thread -> tabId, in-memory, kept current by
//       registerTab below on every dispatch/heartbeat) -- the same map
//       pollFocusRequests/pollWake resolve a thread's tab through -- for a
//       tab that's still open;
//   (b) content.js's own URL_THREAD_STORAGE_KEY-backed map (conversation URL
//       -> thread, chrome.storage.local key 'ccswUrlThreads', written by
//       rememberUrlThread there) -- read back here and searched in reverse --
//       for a conversation whose tab has since closed.
// Unlike focusTabWithFallback above, this does NOT fall back to "any" open
// claude.ai tab when neither resolves -- landing on an unrelated conversation
// would be worse than the dialog's own inline "no known tab" message.
const URL_THREAD_STORAGE_KEY = 'ccswUrlThreads'; // must match content.js's own const of the same name

function focusExistingTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { active: true }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        reject(new Error(chrome.runtime.lastError?.message || 'tab update failed'));
        return;
      }
      chrome.windows.update(tab.windowId, { focused: true }, () => resolve());
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-open-thread') return false; // not for us

  const thread = typeof message.thread === 'string' ? message.thread.trim() : '';
  if (!thread) {
    sendResponse({ ok: false, error: 'no thread given' });
    return false;
  }

  (async () => {
    const knownTabId = registeredThreads.get(thread) ?? null;
    let tabStillExists = false;
    let rememberedUrlFound = false;
    let branch = 'failed';
    let error = null;

    // Single self-logging point for this whole decision, so Jody never has to
    // paste console output for a click that silently did (or didn't) work --
    // fired exactly once, right before whichever return actually runs.
    const logDecision = () => {
      recordDebugEvent({
        ts: new Date().toISOString(),
        build: CCSW_BUILD,
        thread,
        type: 'open_thread',
        detail: {
          thread,
          registered: Array.from(registeredThreads.entries()),
          branch,
          knownTabId,
          tabStillExists,
          rememberedUrlFound,
          error,
        },
      }, true);
    };

    if (knownTabId !== null) {
      try {
        await chrome.tabs.get(knownTabId);
        tabStillExists = true;
        await focusExistingTab(knownTabId);
        branch = 'focused';
        sendResponse({ ok: true, via: 'tab' });
        logDecision();
        return;
      } catch (err) {
        error = err.message;
        console.warn(`[CCswitchboard] background: ccsw-open-thread: registered tab ${knownTabId} for "${thread}" is gone, trying remembered URL:`, err.message);
      }
    }

    try {
      const all = await chrome.storage.local.get(URL_THREAD_STORAGE_KEY);
      const map = all[URL_THREAD_STORAGE_KEY] || {};
      const conversationKey = Object.keys(map).find((key) => map[key] === thread);
      if (conversationKey) {
        rememberedUrlFound = true;
        await chrome.tabs.create({ url: `https://claude.ai${conversationKey}` });
        branch = 'reopened';
        sendResponse({ ok: true, via: 'url' });
        logDecision();
        return;
      }
    } catch (err) {
      error = error ?? err.message;
      console.warn(`[CCswitchboard] background: ccsw-open-thread: remembered-URL lookup failed for "${thread}":`, err.message);
    }

    branch = 'failed';
    if (!error) error = `no known tab or URL for thread "${thread}"`;
    sendResponse({ ok: false, error: `no known tab or URL for thread "${thread}"` });
    logDecision();
  })();

  return true; // keep the message channel open for the async sendResponse above
});

// --- Advanced dialog: manual recovery relay round-trips -------------------
// content.js's Advanced dialog (SW menu -> "Advanced...") can't fetch
// dabblelabs.uk directly (same CORS wall as every other relay call in this
// file), so each of its actions is a request/response round-trip through
// here. Mirrors the exact same relay endpoints board/index.php's Manual
// Controls admin panel already calls by hand from the board page.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-advanced-locks-get') return false; // not for us

  (async () => {
    try {
      const res = await ccswFetch(RELAY_DEBUG_LOCKS_FILE, { method: 'GET' });
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        sendResponse({ ok: true, locks: body.locks || [], waiters: body.waiters || [], wakes: body.wakes || [] });
      } else {
        sendResponse({ ok: false, status: res.status, error: body?.error });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-advanced-jobs-get') return false; // not for us

  (async () => {
    try {
      // status=all so the list covers running/pending/stale jobs (the ones
      // worth force-closing) alongside recently-done ones for context;
      // limit=25 keeps the dialog's list short instead of pulling the same
      // 200-row batch pollToolbarJobs uses (see fetchRelayJobs further down).
      const res = await ccswFetch(`${RELAY_JOBS_FILE}?status=all&limit=25`, { method: 'GET' });
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        sendResponse({ ok: true, jobs: body.jobs || [] });
      } else {
        sendResponse({ ok: false, status: res.status, error: body?.error });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-advanced-clear-lock') return false; // not for us

  (async () => {
    try {
      const res = await ccswFetch(RELAY_CLEAR_LOCK_FILE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: message.repo }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        sendResponse({ ok: true, repo: body.repo });
      } else {
        sendResponse({ ok: false, status: res.status, error: body?.error });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-advanced-clear-locks') return false; // not for us

  (async () => {
    try {
      const res = await ccswFetch(RELAY_CLEAR_LOCKS_FILE, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        sendResponse({ ok: true, cleared: body.cleared });
      } else {
        sendResponse({ ok: false, status: res.status, error: body?.error });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-advanced-force-close') return false; // not for us

  (async () => {
    try {
      const res = await ccswFetch(RELAY_RESULT_FILE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: message.id, result: 'FORCE-CLOSED' }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body) {
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, status: res.status, error: body?.error });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});

// Settings panel's Test button (#76): proves the stored ccswToken actually
// authenticates without needing a real job id. result.php's id=1 is a
// benign probe row -- 200/400 both mean the request got PAST the auth gate
// (400 = bad/missing param, which only happens once auth succeeds); 401
// means the token itself was rejected.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-token-test') return false; // not for us

  (async () => {
    try {
      const res = await ccswFetch(`${RELAY_RESULT_FILE}?id=1`, { method: 'GET' });
      sendResponse({ ok: true, status: res.status });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});

// The exact "spawn restart-agent.ps1 detached, then let it report this job's
// own completion" one-liner board/index.php's admin panel dispatches --
// $CCSW_JOB_ID/$CCSW_RELAY_BASE are expanded by bash (the job runs via Git
// Bash, see AgentCore.cs's RunBash), not by PowerShell, which is why they're
// left unescaped here even though the rest of the -Command string is quoted
// for PowerShell's own parser.
const RESTART_AGENT_COMMAND = 'powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList \'-NoProfile -ExecutionPolicy Bypass -File \\"V:\\ccswitchboard\\agent\\restart-agent.ps1\\" -JobId $CCSW_JOB_ID -RelayBase $CCSW_RELAY_BASE\'"';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-advanced-restart-agent') return false; // not for us

  (async () => {
    try {
      // readonly:true -- this is a bash job whose cwd happens to be the
      // ccswitchboard repo, but it doesn't touch repo content, so it
      // shouldn't take that repo's lock (see job.php's readonly flag).
      const res = await ccswFetch(RELAY_JOB_FILE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payload: { type: 'bash', cwd: 'V:/ccswitchboard', command: RESTART_AGENT_COMMAND },
          readonly: true,
        }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body && body.id !== undefined) {
        sendResponse({ ok: true, id: body.id });
      } else {
        sendResponse({ ok: false, status: res.status, error: body?.error });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});

// A freshly-injected content script (tab open/reload) has no state to render
// its Action List pill from until the next ACTIONS_POLL_INTERVAL_MS tick --
// this lets it ask for whatever this service worker last fetched instead of
// waiting, mirroring ccsw-check-jobs-status's one-shot request/response.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-actions-get') return false; // not for us

  sendResponse({ actions: latestActionsState.actions, counts: latestActionsState.counts });
  return false; // responded synchronously, no need to keep the channel open
});

// Action List dialog's "send revised list to chat" button -- content.js
// composes the text (current state, grouped by tier) and forwards it here,
// same reasoning as ccsw-deliver-advice: only this service worker's send
// state machine actually types/sends into the tab. Unlike a job wake/advice,
// there's no job id (the Action List is global, not tied to one job), so
// this mirrors the repo-free/plan-quiet wakes above (jobId: null) rather
// than ccsw-deliver-advice, which requires one.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'ccsw-deliver-actions') return false; // not for us

  const tabId = sender.tab?.id;
  if (tabId === undefined || typeof message.text !== 'string') return false;

  queueSend(`actions:${Date.now()}`, {
    tabId,
    jobId: null,
    thread: null,
    kind: 'actions',
    text: message.text,
    speakPhrase: null,
    label: 'Tasks for you',
  });

  return false; // no response needed
});

// Q pill (#60): the Action List dialog's per-item query button. Unlike
// ccsw-deliver-actions above (always the sender's own tab), the query must
// land in the ITEM'S OWN THREAD -- which can differ from whatever
// conversation the dialog happens to be open in, e.g. a Global-tab item or
// one surfaced via the 'other threads' expander (see openOtherThread).
// Resolves thread -> tabId the same way ccsw-open-thread's known-tab branch
// does. An untagged (Global) item has no thread to resolve, so it falls back
// to the sender's own tab, same as ccsw-deliver-actions's thread:null send.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'ccsw-deliver-to-thread') return false; // not for us

  const thread = typeof message.thread === 'string' && message.thread !== '' ? message.thread : null;
  if (typeof message.text !== 'string') return false;
  const tabId = (thread && registeredThreads.get(thread)) ?? sender.tab?.id;
  if (tabId === undefined) return false;

  queueSend(`qquery:${Date.now()}`, {
    tabId,
    jobId: null,
    thread,
    kind: 'qquery',
    text: message.text,
    speakPhrase: null,
    label: 'Todo query',
  });

  return false; // no response needed
});

// A content script sends this whenever it hydrates a thread's job history
// from chrome.storage.local (page load, tab reopened after a job finished
// while it was closed, or a thread handed off to a different tab) -- it's
// how toolbarJobs (and registeredThreads, via registerTab) learn about jobs
// and threads this particular service-worker instance never saw dispatched,
// so pollToolbarJobs below still has a live tab to deliver relay-sourced
// status to instead of the pill/LED being stuck on whatever it last knew.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'ccsw-track-jobs') return false; // not for us

  const tabId = sender.tab?.id;
  if (tabId === undefined) return false;

  if (message.thread) {
    registerTab(message.thread, tabId);
    noteCcswTabActivity(tabId);
  }

  const jobs = Array.isArray(message.jobs) ? message.jobs : [];
  for (const job of jobs) {
    if (job && job.id !== undefined) {
      toolbarJobs.set(job.id, tabId);
      // This job is pending/running per the content script's own hydrated
      // history -- this worker instance may never have dispatched it (e.g.
      // it started after a restart), so it wouldn't otherwise be in the
      // active-delivery registry at all. Idempotent if it's already there.
      if (job.status === 'pending' || job.status === 'running') {
        addActiveDeliveryJob(job.id, tabId, message.thread);
      }
    }
  }

  return false; // no response needed
});

// A content script sends this right after hydrating a thread's job history
// from storage (see content.js's restoreRunningJobBars), to confirm which of
// the stored pending/running jobs are ACTUALLY still non-terminal before
// re-showing their toolbar pill -- the stored status is whatever it was when
// this tab last saw it, which can be stale (e.g. the job finished while the
// tab was closed/refreshing). One-shot request/response, unlike
// ccsw-track-jobs' fire-and-forget registration.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-check-jobs-status') return false; // not for us

  const jobIds = Array.isArray(message.jobIds) ? message.jobIds : [];
  if (jobIds.length === 0) {
    sendResponse({ statuses: {} });
    return false;
  }

  (async () => {
    const jobs = await fetchRelayJobs();
    const statuses = {};
    const unresolved = [];
    if (jobs) {
      const byId = new Map(jobs.map((job) => [job.id, job]));
      for (const jobId of jobIds) {
        const job = byId.get(jobId);
        if (job) statuses[jobId] = classifyJobStatus(job);
        else unresolved.push(jobId);
      }
    } else {
      unresolved.push(...jobIds);
    }

    // Batch miss (aged out of jobs.php's LIMIT, or the batch fetch failed
    // outright) -- fall back to a per-id status.php lookup instead of leaving
    // these unresolved, which is what let ghost pills survive reconciliation
    // indefinitely (see fetchSingleJobStatus's comment).
    if (unresolved.length > 0) {
      const singles = await Promise.all(unresolved.map((jobId) => fetchSingleJobStatus(jobId)));
      unresolved.forEach((jobId, i) => {
        if (singles[i]) statuses[jobId] = singles[i];
      });
    }

    sendResponse({ statuses });
  })();

  return true; // keep the message channel open for the async sendResponse above
});

// A content script sends this when reopening a job whose bar was previously
// closed (see content.js's reopenSessionJob) -- pollToolbarJobs below only
// ever delivers model/prompt while a job is actively tracked in toolbarJobs,
// and that tracking is dropped once the job reaches a terminal status, so a
// reopened done job's hovercard would otherwise be stuck showing summary-only
// with no "more info" link. jobs.php returns model/prompt from the job's
// payload regardless of status, so a fresh one-shot fetch here fills the gap.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-get-job-details') return false; // not for us

  (async () => {
    const jobs = await fetchRelayJobs();
    const job = jobs?.find((j) => j.id === message.jobId);
    sendResponse(job ? { model: job.model, prompt: job.prompt, isCommand: job.is_command, silenceTimeout: job.silence_timeout, summary: job.summary } : null);
  })();

  return true; // keep the message channel open for the async sendResponse above
});

// feed.php's "send progress for advice" button (embedded in a job's toolbar
// panel iframe) has content.js forward the request here rather than typing
// it in itself -- see the send state machine above for why the actual
// typing/sending always happens from this service worker now.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'ccsw-deliver-advice') return false; // not for us

  const tabId = sender.tab?.id;
  if (tabId === undefined || !message.jobId || typeof message.text !== 'string') return false;

  queueSend(`advice:${message.jobId}`, {
    tabId,
    jobId: message.jobId,
    thread: message.thread,
    kind: 'advice',
    text: message.text,
    speakPhrase: null,
    label: `advice ${message.jobId}`,
  });

  return false; // no response needed
});

// E5 part 2: native OS notification companion to the tab-side voice
// announcement (content.js's speakWakeResult) -- these stack top-right and
// persist even if you're not looking at the Claude tab (or any Brave
// window) at all. Clicking one jumps back to the tab that dispatched the
// job.
const NOTIFICATION_ICON = chrome.runtime.getURL('icon128.png');
const NOTIFICATION_BODY_MAX = 200;
const ERROR_RESULT_PREFIXES = ['ERROR:', 'TIMEOUT:', 'LAUNCH-ERROR:'];

// claude -p --output-format json's envelope reports a failed run (hitting
// --max-turns, an internal execution error, etc) via `is_error`/`subtype`
// rather than a `result` string -- the CLI still exits 0 for these, so
// AgentCore.cs forwards the raw envelope untouched. Map the subtypes we know
// about to a short human-readable reason; anything else falls back to a
// de-slugged subtype or a generic message, but is still surfaced as an
// ERROR: string so isErrorResultText (below) recognizes it.
const ERROR_SUBTYPE_MESSAGES = {
  error_max_turns: 'Reached maximum number of turns',
  error_during_execution: 'Error during execution',
};

function describeErrorEnvelope(parsed) {
  if (typeof parsed.subtype === 'string' && ERROR_SUBTYPE_MESSAGES[parsed.subtype]) {
    return ERROR_SUBTYPE_MESSAGES[parsed.subtype];
  }
  if (typeof parsed.result === 'string' && parsed.result.trim() !== '') {
    return parsed.result;
  }
  if (typeof parsed.subtype === 'string' && parsed.subtype !== '') {
    return parsed.subtype.replace(/^error_/, '').replace(/_/g, ' ');
  }
  return 'Claude Code reported an error';
}

// jobs.php and result.php both hand back the same shape for a job's `result`
// column (json_decode'd once server-side): either a plain string -- CcswAgent's
// "ERROR: ..."/"TIMEOUT: ..."/"LAUNCH-ERROR: ..." when claude itself never ran
// -- or `claude -p --output-format json`'s whole response envelope, whose own
// "result" field is the actual reply text (success) or which reports failure
// via is_error/subtype (see describeErrorEnvelope above). Shared here so
// pollToolbarJobs's relay-sourced done/error classification (for the pill and
// SW-menu LED) and deliverJobResult's wake-prompt text agree on what a job's
// result actually says.
function extractResultText(result) {
  if (typeof result === 'string') {
    try {
      const parsed = JSON.parse(result);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const isErrorEnvelope = parsed.is_error === true || (typeof parsed.subtype === 'string' && parsed.subtype.startsWith('error'));
        if (isErrorEnvelope) {
          return `ERROR: ${describeErrorEnvelope(parsed)}`;
        }
        if (typeof parsed.result === 'string') {
          return parsed.result;
        }
      }
      return result;
    } catch (err) {
      return result;
    }
  }
  return JSON.stringify(result);
}

function isErrorResultText(resultText) {
  return typeof resultText === 'string' && ERROR_RESULT_PREFIXES.some((prefix) => resultText.startsWith(prefix));
}

// CcswAgent posts the plain string "CANCELLED" (no trailing detail) when a
// job is killed via cancel.php -- distinct from the ERROR:/TIMEOUT:/
// LAUNCH-ERROR: prefixes above, since a cancelled job isn't a failure.
function isCancelledResultText(resultText) {
  return typeof resultText === 'string' && resultText.startsWith('CANCELLED');
}

// notificationId -> tab id, since chrome.notifications.onClicked only hands
// back the notificationId, not any data we created it with.
const notificationTabs = new Map();

// --- delivered-job dedupe -----------------------------------------------
// A job's result must be typed into the chat AT MOST ONCE. Marked ONLY once
// the send state machine's finishSend() sees a genuinely confirmed 'sent'
// outcome (input verified cleared) -- never merely on detecting status
// "done" -- so this can never record a job as delivered before it actually
// was. That distinction is the fix for note 448's silent-drop bug: the old
// code marked "delivered" the moment the status poll saw "done", BEFORE the
// wake-prompt was actually typed/sent; if the service worker died in that
// window, the job was permanently (and wrongly) considered delivered on
// every future restart, and its result never reached chat. Tracked in
// chrome.storage.local (not just an in-memory Set) so the dedupe survives a
// worker restart, layered on top of delivery.php's own server-side
// delivered_at ACK (the cross-restart authority resultWatcherTick actually
// trusts; this local copy just avoids a redundant re-delivery attempt in the
// narrow window before that ACK POST lands).
const DELIVERED_JOBS_STORAGE_KEY = 'ccswDeliveredJobIds';
const MAX_DELIVERED_JOBS_TRACKED = 500;

// Bug #84: the delivered-dedupe ledger keys on the FULL delivery key
// (kind + jobId), NOT the bare jobId. Historically it stored bare jobIds, but
// that flat key let an advice delivery (kind 'advice') and a job-result wake
// (kind 'wake') for the SAME job collide -- confirmDelivered fired for a 'sent'
// advice send and wrote the bare jobId, which then suppressed that job's
// genuine result-wake in queueSend's already-delivered gate. Namespacing the
// key (`job:<id>` for wakes, `advice:<id>` for advice) makes the two dedupe
// independently: marking an advice delivery can never mask a wake and vice
// versa. Only ever called for kinds 'wake' and 'advice'; anything else maps to
// the wake namespace (harmless -- no other kind consults this ledger).
function deliveryLedgerKey(kind, jobId) {
  return kind === 'advice' ? `advice:${jobId}` : `job:${jobId}`;
}

let deliveredJobIds = new Set();
const deliveredJobIdsReady = (async () => {
  try {
    const stored = await chrome.storage.local.get(DELIVERED_JOBS_STORAGE_KEY);
    const list = Array.isArray(stored[DELIVERED_JOBS_STORAGE_KEY]) ? stored[DELIVERED_JOBS_STORAGE_KEY] : [];
    // Bug #84 migration: entries persisted before the full-key switch are bare
    // jobIds, and the ledger only EVER recorded wake (job-result) deliveries
    // back then (advice writing it was the very bug being fixed). Namespace
    // every legacy bare entry as a wake key so already-delivered jobs stay
    // deduped across the upgrade. Anything already carrying a known prefix is a
    // post-upgrade entry -- leave it untouched.
    const migrated = list.map((k) =>
      (typeof k === 'string' && (k.startsWith('job:') || k.startsWith('advice:'))) ? k : `job:${k}`);
    deliveredJobIds = new Set(migrated);
    // Settle the migrated shape back to storage ONCE (only if something changed)
    // so subsequent loads see already-prefixed keys and skip re-migrating.
    if (migrated.some((k, i) => k !== list[i])) {
      chrome.storage.local.set({ [DELIVERED_JOBS_STORAGE_KEY]: [...deliveredJobIds] }).catch(() => {});
    }
  } catch (err) {
    console.warn('[CCswitchboard] background: failed to load delivered-job ids:', err.message);
  }
})();

// Synchronous check against the in-memory set -- callers must await
// deliveredJobIdsReady (directly or via markJobDelivered having already been
// awaited elsewhere) before this reflects storage. Takes a FULL ledger key
// (see deliveryLedgerKey), never a bare jobId. Marking happens synchronously
// (before the persist below is awaited) so a second overlapping tick for the
// same key sees the mark immediately rather than racing the first tick's
// storage write.
function isJobDelivered(ledgerKey) {
  return deliveredJobIds.has(ledgerKey);
}

async function markJobDelivered(ledgerKey) {
  deliveredJobIds.add(ledgerKey);
  if (deliveredJobIds.size > MAX_DELIVERED_JOBS_TRACKED) {
    deliveredJobIds = new Set([...deliveredJobIds].slice(-MAX_DELIVERED_JOBS_TRACKED));
  }
  try {
    await chrome.storage.local.set({ [DELIVERED_JOBS_STORAGE_KEY]: [...deliveredJobIds] });
  } catch (err) {
    console.warn(`[CCswitchboard] background: failed to persist delivered marker for ${ledgerKey}:`, err.message);
  }
}

// Fire-and-forget ACK to the relay (delivery.php) that a job's result has
// actually landed in chat -- see delivery.php's `delivered` branch and note
// 448's ACK+RETRY layer. This, not local storage, is what resultWatcherTick
// below trusts as the durable cross-restart signal that a job no longer
// needs (re-)delivering.
function ackDeliveryToRelay(jobId) {
  ccswFetch(RELAY_DELIVERY_FILE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, delivered: true }),
  }).catch((err) => {
    console.warn(`[CCswitchboard] background: delivery-ack failed for job ${jobId}:`, err.message);
  });
}

// --- delivery-loss safety net (Bug A observability) ------------------------
// A "done" job whose result never reaches the composer would be a SILENT
// output loss: the relay thinks the job finished, but nothing landed in chat.
// Bug A PREVENTION turned the two former loss paths into RETRIES, so this net
// now fires far less often:
//   - the user-text-guard wake path no longer calls this at all -- it holds
//     the job in the durable registry and retries once the composer clears
//     (see finishSend), so there is no loss to page.
//   - handleDeliveryFailure's give-up ALSO keeps retrying now, but it still
//     calls this once (de-duped) when a delivery has failed
//     DELIVERY_FAILURE_VISIBLE_THRESHOLD times in a row -- a genuinely stuck
//     delivery is surfaced loudly even though the durable retry continues
//     beneath it.
// alertDeliveryLoss (a) writes a durable delivery_lost event to the
// already-deployed debug_log table so the stall is auditable IMMEDIATELY, and
// (b) fires a Pushover push (naming jobId, thread, reason) so it becomes a
// phone buzz. De-duped per jobId -- a job can page at most once ever, even
// across a service-worker restart (the id set is persisted the same way
// deliveredJobIds is). STRICTLY additive: every call runs AFTER the delivery
// decision is already final; it reads and changes NO delivery state.
const ALERTED_LOSS_JOBS_STORAGE_KEY = 'ccswAlertedLossJobIds';
const MAX_ALERTED_LOSS_JOBS_TRACKED = 500;

let alertedLossJobIds = new Set();
const alertedLossJobIdsReady = (async () => {
  try {
    const stored = await chrome.storage.local.get(ALERTED_LOSS_JOBS_STORAGE_KEY);
    const list = Array.isArray(stored[ALERTED_LOSS_JOBS_STORAGE_KEY]) ? stored[ALERTED_LOSS_JOBS_STORAGE_KEY] : [];
    alertedLossJobIds = new Set(list);
  } catch (err) {
    console.warn('[CCswitchboard] background: failed to load delivery-loss alert ids:', err.message);
  }
})();

async function alertDeliveryLoss(jobId, thread, reason) {
  try {
    if (!jobId) return;
    await alertedLossJobIdsReady;
    if (alertedLossJobIds.has(jobId)) return; // already paged for this job -- never double-buzz
    alertedLossJobIds.add(jobId);
    if (alertedLossJobIds.size > MAX_ALERTED_LOSS_JOBS_TRACKED) {
      alertedLossJobIds = new Set([...alertedLossJobIds].slice(-MAX_ALERTED_LOSS_JOBS_TRACKED));
    }
    chrome.storage.local.set({ [ALERTED_LOSS_JOBS_STORAGE_KEY]: [...alertedLossJobIds] }).catch((err) => {
      console.warn(`[CCswitchboard] background: failed to persist delivery-loss alert marker for job ${jobId}:`, err.message);
    });

    // (a) Durable, deploy-free ledger trace: lands in the debug_log table that
    // is ALREADY live, so the loss is queryable ({debuglog:true, type:'delivery_lost'})
    // regardless of whether alert.php has been deployed yet. urgent=true flushes
    // it immediately instead of waiting out the coalesce timer.
    logDeliveryEvent('delivery_lost', { jobId, thread: thread ?? null, tabId: null }, { reason: reason ?? null }, true);
    console.error(`[CCswitchboard] delivery: SILENT LOSS -- job ${jobId} (thread ${thread ?? 'n/a'}) terminated not-delivered: ${reason}`);

    // (b) Phone buzz: best-effort POST to the relay's alert endpoint, which
    // calls sendPushoverNotification server-side. Requires alert.php deployed
    // to the live relay to actually notify; the .catch keeps a 404/offline
    // relay from ever throwing into a delivery path.
    ccswFetch(RELAY_ALERT_FILE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, thread: thread ?? null, reason: reason ?? null }),
    }).catch((err) => {
      console.warn(`[CCswitchboard] background: delivery-loss Pushover POST failed for job ${jobId}:`, err.message);
    });
  } catch (err) {
    // The safety net must never itself break delivery.
    console.warn('[CCswitchboard] background: alertDeliveryLoss failed:', err?.message);
  }
}

// --- active-delivery registry (note 448, Layer 1: decouple from the status
// poll) ---------------------------------------------------------------------
// jobId -> {tabId, thread}, persisted in chrome.storage.local. The OLD
// mechanism (startPolling, removed below) started one setInterval PER
// dispatched job, alive only in this service-worker instance's memory --
// MV3 can kill an idle worker at any time, and when it restarts that
// interval (and every job it was tracking) is simply gone, with nothing left
// to ever deliver that job's result. This registry plus resultWatcherTick's
// single top-level interval fixes that: the registry survives a worker
// restart in storage, and the interval re-establishes itself unconditionally
// every time this script loads (same pattern pollToolbarJobs/pollWake/etc.
// already use), so there is always exactly one live watcher covering every
// job this extension still owes a chat delivery to, regardless of which
// worker instance dispatched it or tracked it before.
const ACTIVE_DELIVERY_JOBS_STORAGE_KEY = 'ccswActiveDeliveryJobs';
// Bug A fix 2: how many CONSECUTIVE auto-delivery failures before the stuck
// delivery is surfaced loudly (speak + pill + de-duped page). resultWatcherTick
// re-serves an owed job roughly once per POLL_INTERVAL_MS (3s), so at the old
// value of 2 a mere ~6s outage -- e.g. the brief window while a tab reloads for
// a new build and its content script re-registers -- was enough to trip the
// loud surface AND (before this pass) retire the delivery outright. Raised so a
// transient outage rides out quietly; a genuinely stuck delivery still surfaces
// within ~15s, and -- critically -- the give-up no longer retires the job at
// all, it keeps retrying (see handleDeliveryFailure).
const DELIVERY_FAILURE_VISIBLE_THRESHOLD = 5;

async function loadActiveDeliveryJobs() {
  try {
    const stored = await chrome.storage.local.get(ACTIVE_DELIVERY_JOBS_STORAGE_KEY);
    return Array.isArray(stored[ACTIVE_DELIVERY_JOBS_STORAGE_KEY]) ? stored[ACTIVE_DELIVERY_JOBS_STORAGE_KEY] : [];
  } catch (err) {
    console.warn('[CCswitchboard] background: failed to load active-delivery registry:', err.message);
    return [];
  }
}

async function saveActiveDeliveryJobs(list) {
  try {
    await chrome.storage.local.set({ [ACTIVE_DELIVERY_JOBS_STORAGE_KEY]: list });
  } catch (err) {
    console.warn('[CCswitchboard] background: failed to persist active-delivery registry:', err.message);
  }
}

// Registers a job as owing a chat delivery once it finishes. Called from the
// dispatch handler (this worker instance just fired it) AND from
// ccsw-track-jobs (a content script reporting a pending/running job this
// worker instance never saw dispatched, e.g. it started after a restart) --
// either path is enough to pick the job up, and a job already present is
// left alone (idempotent).
async function addActiveDeliveryJob(jobId, tabId, thread) {
  const list = await loadActiveDeliveryJobs();
  if (list.some((entry) => entry.jobId === jobId)) return;
  list.push({ jobId, tabId, thread: thread || null });
  await saveActiveDeliveryJobs(list);
  ccswDebug('active-delivery-add', { jobId, tabId, thread });
}

async function removeActiveDeliveryJob(jobId) {
  const list = await loadActiveDeliveryJobs();
  const next = list.filter((entry) => entry.jobId !== jobId);
  if (next.length !== list.length) await saveActiveDeliveryJobs(next);
}

// jobId -> consecutive auto-delivery failure count (Layer 3: visible
// fallback). In-memory only -- a restart getting a fresh count and one more
// quiet retry before re-escalating is an acceptable trade for the added
// complexity of persisting it.
const deliveryFailureCounts = new Map();

// Marks a job as durably delivered (server ACK + local dedupe), stops the
// watcher from re-offering it, and clears any visible-failure state a prior
// escalation may have set on its pill -- covers a job that eventually gets
// through after one or more quiet retries.
async function confirmDelivered(jobId, tabId) {
  deliveryFailureCounts.delete(jobId);
  // Bug #84: this path is the job-RESULT (wake) delivery confirmation -- mark
  // the wake ledger key so it never collides with an advice:<id> entry for the
  // same job. Advice 'sent' is handled separately in finishSend and marks its
  // own key WITHOUT the ack/registry side effects below.
  await markJobDelivered(deliveryLedgerKey('wake', jobId));
  await removeActiveDeliveryJob(jobId);
  ackDeliveryToRelay(jobId);
  ccswDebug('delivery-confirmed', { jobId });
  if (tabId !== undefined) {
    chrome.tabs.sendMessage(tabId, { type: 'ccsw-delivery-failed', jobId, failed: false }).catch(() => {});
  }
}

// Layer 3: visible fallback. Only auto-triggered wake deliveries (kind
// 'wake') are tracked/escalated here -- a manual resend (kind 'advice') has
// no durable retry registry backing it and already gets the old generic
// "Send failed" notice from finishSend below. Hides transient retries (per
// note 448: "JANK is a bug" but a single quiet retry is normal operation, not
// jank) -- only escalates loudly once a job has failed
// DELIVERY_FAILURE_VISIBLE_THRESHOLD times in a row with nothing landing.
function handleDeliveryFailure(entry, outcome) {
  if (entry.kind !== 'wake' || !entry.jobId) return;

  const count = (deliveryFailureCounts.get(entry.jobId) || 0) + 1;
  deliveryFailureCounts.set(entry.jobId, count);
  ccswDebug('delivery-failure', { jobId: entry.jobId, outcome, attempt: count });

  if (count < DELIVERY_FAILURE_VISIBLE_THRESHOLD) {
    console.warn(`[CCswitchboard] delivery: job ${entry.jobId} failed (${outcome}), retry ${count}/${DELIVERY_FAILURE_VISIBLE_THRESHOLD} -- retrying quietly.`);
    return; // stays in the active-delivery registry; resultWatcherTick retries it next tick
  }

  console.warn(`[CCswitchboard] delivery: job ${entry.jobId} failed ${count} times (${outcome}) -- surfacing loudly, keeping the durable retry alive.`);
  ccswDebug('delivery-failed-visible', { jobId: entry.jobId, outcome, attempts: count });
  logDeliveryEvent('deliver_stuck_retry', entry, { key: `job:${entry.jobId}`, tabId: entry.tabId, attempts: count, reason: outcome }, true);
  // Bug A fix 2: DO NOT removeActiveDeliveryJob here. Retiring the durable
  // registry entry on a give-up was the second silent-loss path -- a tab that
  // was merely reloading/handed off (tab-gone) or briefly wedged got its owed
  // result permanently abandoned, frozen to a dead tabId. Keep the job in the
  // registry so resultWatcherTick keeps re-resolving the thread's CURRENT tab
  // (registeredThreads.get(thread), see its own tab re-resolve) and retrying
  // there. "Give up" now means surface loudly and KEEP retrying, never stop.
  // Reset the consecutive-failure counter so the next stretch of failures goes
  // quiet again for another THRESHOLD ticks before re-surfacing -- a stuck
  // delivery re-announces periodically instead of spamming every tick.
  deliveryFailureCounts.delete(entry.jobId);
  // Bug A safety net: a delivery that has failed the visible threshold is
  // genuinely stuck. Page it -- alertDeliveryLoss is de-duped per jobId so it
  // buzzes AT MOST ONCE ever for this job, even though we keep retrying beneath
  // it. Far fewer of these now fire than before this pass: user-text-guard no
  // longer pages at all (it holds and retries), and the raised threshold means
  // transient outages never reach here.
  alertDeliveryLoss(entry.jobId, entry.thread, `stuck-retrying:${outcome}`);
  // Fix 3: re-resolve the failure surface to the thread's CURRENT registered
  // tab, not the frozen (possibly dead) entry.tabId. If the original tab closed
  // and the thread was reopened elsewhere, the pill/speak land where the user
  // actually is. If no live tab is known, the durable retry + the page above
  // keep the loss recoverable and loud -- we simply don't fire the pill at a
  // tab that is gone.
  const surfaceTabId = (entry.thread && registeredThreads.get(entry.thread)) ?? entry.tabId;
  if (surfaceTabId !== undefined) {
    execInTab(surfaceTabId, ccswInjSpeak, [`Delivery stuck for job ${entry.jobId}, still retrying`]).catch(() => {});
    chrome.tabs.sendMessage(surfaceTabId, { type: 'ccsw-delivery-failed', jobId: entry.jobId, failed: true }).catch(() => {});
  }
}

function notifyJobDone(jobId, tabId, resultText) {
  const notificationId = `ccsw-job-${jobId}`;
  const isError = isErrorResultText(resultText);
  const title = `Job ${jobId} ${isError ? 'needs input' : 'completed'}`;
  const resultString = typeof resultText === 'string' ? resultText : String(resultText);
  const body = resultString.length > NOTIFICATION_BODY_MAX ? resultString.slice(0, NOTIFICATION_BODY_MAX) + '...' : resultString;

  notificationTabs.set(notificationId, tabId);
  chrome.notifications.create(
    notificationId,
    {
      type: 'basic',
      iconUrl: NOTIFICATION_ICON,
      title,
      message: body,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn(`[CCswitchboard] background: notification create failed for job ${jobId}:`, chrome.runtime.lastError.message);
        return;
      }
      console.log(`[CCswitchboard] background: notification shown for job ${jobId} ("${title}").`);
    }
  );
}

chrome.notifications.onClicked.addListener((notificationId) => {
  const tabId = notificationTabs.get(notificationId);
  if (tabId === undefined) return;

  chrome.tabs.update(tabId, { active: true }, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      console.warn(`[CCswitchboard] background: notification ${notificationId} clicked, but tab ${tabId} is gone:`, chrome.runtime.lastError?.message);
      return;
    }
    chrome.windows.update(tab.windowId, { focused: true });
  });
  chrome.notifications.clear(notificationId);
});

// --- send state machine: insert + click + verify, driven entirely from here
// -----------------------------------------------------------------------
// Earlier versions had content.js do the actual typing-hold check, text
// insertion, send-button click, and cleared-input verification itself,
// paced by a 'ccsw-tick' message this service worker pushed on a plain
// interval (see git history) -- the idea being that since THIS worker isn't
// a page, it isn't subject to a backgrounded tab's setTimeout/setInterval
// throttling, so ticking content.js from here would keep its wait loops
// moving even while the tab was hidden. That didn't fully fix the reported
// bug: a wake/result prompt's text still landed in the input but sat there
// unsent until Jody refocused the tab. Root cause: Chrome doesn't only
// throttle a hidden tab's OWN timers -- it can also deprioritize/delay
// delivering chrome.runtime messages to that tab's content scripts, since
// message dispatch still has to run as a task on that same (deprioritized)
// tab. Ticking content.js from here doesn't help if content.js's message
// listener itself doesn't get scheduled promptly.
//
// chrome.scripting.executeScript is different: it's a privileged extension
// API call that runs a function inside the target tab on demand, the same
// mechanism devtools uses to evaluate an expression in an inspected (but
// backgrounded) tab -- it isn't gated behind the tab's own message-handling
// priority. So every step of the send -- check hold state, insert text,
// click send, verify the input cleared -- is now a fresh executeScript call
// issued FROM here, paced by this worker's own setInterval. content.js no
// longer does any of the actual sending; it only reflects UI state (the
// toolbar pill's waiting indicator, session job status) once told to.
//
// The functions below (ccswInj*) are passed BY REFERENCE to
// chrome.scripting.executeScript, which serializes and re-runs them inside
// the tab -- they can only use their own parameters and browser globals
// (document, window), never anything from this file's outer scope. Their
// selector lists are therefore duplicated from content.js's INPUT_SELECTORS/
// SEND_BUTTON_SELECTORS/STOP_BUTTON_SELECTORS rather than shared -- keep the
// two in sync if claude.ai's DOM selectors ever change.

const SEND_TICK_MS = 200;
const SEND_TYPING_HOLD_MS = 2000;
const SEND_DELIVERY_SETTLE_MS = 2000;
const SEND_MAX_ATTEMPTS = 8;
const SEND_RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 15000, 15000];
const SEND_BUTTON_WAIT_TIMEOUT_MS = 5000;
// #19 shape-1 secondary: once our text is already in the composer but the send
// button is found-yet-disabled, a stalled hidden-tab render will not enable it
// no matter how long we wait -- so escalate to the Enter fallback after this
// short floor instead of burning the full SEND_BUTTON_WAIT_TIMEOUT_MS. A floor
// (not zero) so a button that's merely a few hundred ms slow to enable on a
// healthy tab still gets clicked normally rather than pre-empted by Enter.
const SEND_BUTTON_STALL_ENTER_MS = 1500;
const SEND_VERIFY_TIMEOUT_MS = 3000;
// Ceiling on how long a single delivery may sit in phase 'hold' (Claude
// generating, input occupied by the user, or -- worst case -- the input
// never found at all) before this entry gives up and steps aside. Without
// this, one permanently-held entry would wedge every other queued entry
// behind it forever (see queueHeadsByTab below), since only the head of a
// tab's queue is ever advanced.
const SEND_HOLD_TIMEOUT_MS = 5 * 60 * 1000;

// Minimum gap between full probe dumps for a single held delivery (see the
// hold-probe block in advanceHoldPhase). A change in the hold REASON always
// logs immediately regardless of this; the interval only rate-limits the
// "still stuck on the same thing" samples.
const HOLD_PROBE_LOG_INTERVAL_MS = 15000;
// #19 shape-1 (greenlit STALE-DOM fix): in a hidden tab claude.ai stops
// re-rendering, so the Stop button lingers in the DOM after the reply finished
// and isGenerating reads true long after generation actually ended. A present
// Stop button ALONE is therefore no longer sufficient to keep holding a
// completion_running delivery: to KEEP holding, the hold gate requires the
// Stop button PLUS a corroborating live-generating signal (a growing
// assistant-message text length, a streaming cursor, or aria-busy -- see
// ccswInjProbeDelivery/updateActiveGeneration). If the Stop button is present
// but no live signal corroborates it, generation is treated as finished (stale
// DOM) and the delivery proceeds to the send phase, where the #68 user-text
// guards still protect everything. This is visibility-agnostic by
// construction: no focus/visibilitychange/hidden term enters the hold or
// release decision (the plan forbids making focus load-bearing) -- the tab's
// hidden state stays observational (log fields only). A genuinely streaming
// reply is never cut short: while any live signal is present the hold
// continues exactly as before, and the SEND_HOLD_TIMEOUT_MS absolute cap is
// unchanged. HOLD_STALE_CONFIRM_MS is the tolerance window a flat text length
// with no streaming marker must persist before the hold is released, so a
// brief inter-token pause in a real reply is bridged rather than cut short --
// releasing a demonstrably-stale hold in seconds instead of the old fixed
// 3-minute wait.
const HOLD_STALE_CONFIRM_MS = 8 * 1000;
// Cap on how many times a single delivery may bounce from the 'send' phase
// back to 'insert' after detecting its page context was reset out from under
// it (see restartAfterContextLoss) -- a reload mid-paste is expected to
// recover in one bounce; this just stops a pathologically reloading tab from
// retyping forever instead of ever reaching a terminal outcome.
const SEND_MAX_CONTEXT_LOST_RETRIES = 3;
// Cap on how many times a single delivery may bounce from 'send' back to
// 'hold' after handleSendExhausted reclaims a stranded composer (D1) -- a
// genuinely wedged tab (e.g. the send button structurally never renders)
// would otherwise reclaim-and-requeue forever instead of ever reaching a
// terminal outcome. See handleSendExhausted.
const SEND_MAX_RECLAIM_RETRIES = 3;

// Every ccswInj* function below also reports document.visibilityState/
// hidden/hasFocus() at the moment it actually ran inside the tab -- added
// to chase a bug where a wake/result prompt would type into Claude's input
// but not actually send until Jody switched back to the tab. Folding this
// into the SAME executeScript call that does the real check (rather than a
// separate call) matters: it's the tab's own state at the exact instant of
// that check, not skewed by a second round-trip.
//
// This snippet is inlined into each ccswInj* function below rather than
// factored into a shared helper: chrome.scripting.executeScript's `func`
// only serializes the ONE function passed to it and re-runs that source
// inside the tab -- it does not carry along other top-level declarations
// from this file's scope. A prior refactor split this out into its own
// ccswInjVisibility() function, which threw "ReferenceError:
// ccswInjVisibility is not defined" on every call once injected, since the
// tab has no idea that function exists.

function ccswInjInsertText(text, marker, expectedHash, allowUserTextClobber) {
  const inputSelectors = [
    'div[contenteditable="true"][data-testid="chat-input"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][data-testid]',
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][class*="composer"]',
    'div[contenteditable="true"][placeholder]',
    'div[contenteditable="true"]',
  ];
  let input = null;
  for (const sel of inputSelectors) {
    input = document.querySelector(sel);
    if (input) break;
  }
  if (!input) return { ok: false, inputFound: false, visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() };
  input.focus();
  // #68 USER TEXT IS SACRED -- P1 STRUCTURAL BACKSTOP (pre-insert twin of the
  // post-insert send-phase guards). A non-empty composer at this instant is
  // EITHER our own stranded prior insert (safe to clear and retype) OR the
  // user's in-progress draft (must NEVER be wiped). The unconditional
  // selectAll/delete/innerHTML clear below cannot tell them apart, so a
  // delivery that raced a user keystroke -- from ANY path (state machine,
  // redeliver-by-jobId, self-heal, concurrent-send, future) -- used to destroy
  // that draft (the 5-minute-cap clobber bug and every recency-timer race like
  // it). Distinguish by fingerprint: our own prior insert stamped
  // window.__ccswSendMarkerHash into THIS document, and the caller passes the
  // background-side lastInjectedByTab hash (expectedHash) for the case where
  // this document's marker was lost (e.g. a service-worker restart) but our
  // text wasn't. If the current content matches NEITHER, it's the user's:
  // ABORT without touching anything and report composer-has-user-text -- a
  // NON-terminal failure the caller treats as "keep the delivery OWED and
  // retry", never a clobber, never a drop. fnvHash is hoisted from its
  // declaration lower in this function. allowUserTextClobber is set ONLY by the
  // piggyback resend, which has already captured the composer's current text
  // into `text` and is deliberately re-sending it (no data loss) -- every other
  // caller leaves it falsy and gets the full guard.
  if (!allowUserTextClobber) {
    const existing = input.textContent.trim();
    if (existing.length > 0) {
      const currentHash = fnvHash(existing);
      const ours = currentHash === window.__ccswSendMarkerHash
        || (expectedHash != null && currentHash === expectedHash);
      if (!ours) {
        return {
          ok: false,
          reason: 'composer-has-user-text',
          inputFound: true,
          composerHash: currentHash,
          visibilityState: document.visibilityState,
          hidden: document.hidden,
          hasFocus: document.hasFocus(),
        };
      }
    }
  }
  // Clear any leftover text before inserting. A prior attempt that got cut
  // short mid-paste (e.g. a page reload landed here before send was clicked)
  // can leave a stale partial paste sitting in the input; execCommand('insertText')
  // inserts at the caret rather than replacing, so without this a retry would
  // append onto that leftover fragment instead of sending a clean message.
  if (input.textContent.length > 0) {
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    if (input.textContent.length > 0) input.innerHTML = '';
  }
  let inserted = document.execCommand('insertText', false, text);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
  let landed = input.textContent.trim().length > 0;
  if (!inserted || !landed) {
    // execCommand('insertText') silently no-ops when the document/input isn't
    // actually focused -- which a backgrounded tab never is, even after
    // input.focus() above -- so nothing lands and this branch fires. Fall
    // back to writing the ProseMirror editor's own DOM directly (one <p> per
    // line, matching what execCommand would have produced) and dispatch the
    // input event ourselves so the app picks up the new content.
    input.focus();
    const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    input.innerHTML = text.split('\n').map((line) => `<p>${line ? escapeHtml(line) : '<br>'}</p>`).join('');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
    landed = input.textContent.trim().length > 0;
    inserted = landed;
  }
  // Stamps the document that actually received this text, keyed on this
  // delivery attempt. A reload replaces `window` wholesale, so this marker
  // can never survive one -- later steps (ccswInjTryClickSend/ccswInjTryEnterSend/
  // ccswInjCheckCleared) check it to tell "our text is genuinely gone because
  // Claude sent it" apart from "this is a brand-new post-reload input that
  // never had our text in the first place." See note on the mid-paste-reload
  // fix for the full rationale.
  window.__ccswSendMarker = marker;
  // #68 USER TEXT IS SACRED: the moment + fingerprint of what WE put in the
  // composer, so every later click/Enter attempt can re-verify -- right
  // before it fires -- that nothing has touched the composer since. A
  // keystroke timestamped after this, or a hash that no longer matches, means
  // the user has typed into the box in the meantime and this delivery must
  // not click send or wipe anything (see ccswInjTryClickSend/ccswInjTryEnterSend/
  // ccswInjClearComposer). fnvHash duplicated here for the same reason noted
  // above ccswInjInsertText -- each injected function only serializes itself.
  function fnvHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
  }
  window.__ccswSendMarkerAt = Date.now();
  // #72B FIX A: hash the DOM's own post-insert textContent, not the source
  // string -- ProseMirror's rendering (block-join, whitespace normalization)
  // means the two are NOT the same string for any multi-line payload, and
  // every later guard/reclaim/strandedOurs check below compares against THIS
  // hash, so it must describe what's actually sitting in the composer.
  window.__ccswSendMarkerHash = fnvHash(input.textContent.trim());
  return { ok: true, inputFound: true, inserted, landed, textHash: window.__ccswSendMarkerHash, visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() };
}

function ccswInjTryClickSend(marker) {
  if (window.__ccswSendMarker !== marker) {
    // This document never received our inserted text (or didn't survive to
    // this tick) -- a reload/navigation happened since insert. Whatever's in
    // this fresh input isn't ours, so don't click send on it; report
    // contextLost so advanceSendPhase re-types from scratch instead.
    return { ready: false, clicked: false, contextLost: true, visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() };
  }
  // #68 USER TEXT IS SACRED: see fnvHash's twin in ccswInjInsertText.
  function fnvHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
  }
  const sendSelectors = ['[data-testid="send-button"]', 'button[aria-label*="Send"]'];
  let btn = null;
  for (const sel of sendSelectors) {
    btn = document.querySelector(sel);
    if (btn) break;
  }
  const buttonFound = !!btn;
  const buttonDisabled = btn ? (btn.disabled || btn.getAttribute('aria-disabled') === 'true') : null;
  const ready = !!btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
  // #62 CLICK-PHASE DETAIL: composerLen, read here (not via a separate probe
  // round-trip), tests the synthetic-insert-doesn't-wake-React theory -- if
  // the composer still visibly holds our text tick after tick while
  // buttonFound/buttonDisabled never changes, the insert landed in the DOM
  // but never triggered whatever render flips the send button enabled.
  const inputSelectors = [
    'div[contenteditable="true"][data-testid="chat-input"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][data-testid]',
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][class*="composer"]',
    'div[contenteditable="true"][placeholder]',
    'div[contenteditable="true"]',
  ];
  let input = null;
  for (const sel of inputSelectors) {
    input = document.querySelector(sel);
    if (input) break;
  }
  const composerLen = input ? input.textContent.length : 0;
  if (!ready) return { ready: false, clicked: false, buttonFound, buttonDisabled, composerLen, visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() };

  // #68 USER TEXT IS SACRED: re-probe right before EVERY click attempt, not
  // just once pre-insert -- the user may have started typing (into our own
  // inserted text, producing mixed content) in the gap between insert and
  // this retry, or between two retries. A keystroke timestamped after our
  // insert, or a composer hash that no longer matches exactly what we
  // inserted, means clicking send here could submit the user's own words --
  // abort instead. The caller (advanceSendPhase's handleUserTextGuard)
  // decides whether it's safe to reclaim (hash still ours) or must park
  // untouched (mixed/user content) based on hashMatches below.
  const composerText = input ? input.textContent.trim() : '';
  const currentHash = composerText.length > 0 ? fnvHash(composerText) : null;
  const expectedHash = window.__ccswSendMarkerHash ?? null;
  const hashMatches = currentHash === expectedHash;
  const typedSinceInsert = (window.__ccswLastKeystrokeAt || 0) > (window.__ccswSendMarkerAt || 0);
  if (typedSinceInsert || !hashMatches) {
    return {
      ready, clicked: false, guardBlocked: true,
      guardReason: !hashMatches ? 'hash_mismatch' : 'typed_since_insert',
      hashMatches, typedSinceInsert, buttonFound, buttonDisabled, composerLen,
      visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus(),
    };
  }

  // D4: content.js's markUserSend() fires synchronously off this click (see
  // its send listeners) and must be able to tell this delivery's own click
  // apart from a genuine user click on the same button -- flag it for the
  // duration of the synchronous dispatch only, so a later, real user click
  // reads the flag as false again. See markUserSend's ccsw-user-send-landed
  // guard.
  window.__ccswDeliverySending = true;
  try {
    btn.click();
  } finally {
    window.__ccswDeliverySending = false;
  }
  return { ready: true, clicked: true, buttonFound, buttonDisabled, composerLen, visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() };
}

// Fallback submit path, tried once per attempt if the send button never
// reports itself enabled within SEND_BUTTON_WAIT_TIMEOUT_MS (see
// advanceSendPhase). claude.ai's composer submits on a bare Enter keypress,
// handled directly on the input's own keydown listener -- that handler reads
// the editor's live text synchronously, so unlike the send button's
// disabled/aria-disabled attribute (which only flips once whatever re-render
// marks the button enabled has actually run) it doesn't depend on that
// render having caught up, which is the theorized reason a hidden/backgrounded
// tab can leave text sitting in the input indefinitely: the button-enabling
// render stalls while hidden, but the keydown handler doesn't need it.
function ccswInjTryEnterSend(marker) {
  if (window.__ccswSendMarker !== marker) {
    // Same reasoning as ccswInjTryClickSend: don't submit a fresh (reloaded)
    // input we never actually typed into.
    return { dispatched: false, inputFound: false, contextLost: true, visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() };
  }
  // #68 USER TEXT IS SACRED: see fnvHash's twin in ccswInjInsertText.
  function fnvHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
  }
  const inputSelectors = [
    'div[contenteditable="true"][data-testid="chat-input"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][data-testid]',
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][class*="composer"]',
    'div[contenteditable="true"][placeholder]',
    'div[contenteditable="true"]',
  ];
  let input = null;
  for (const sel of inputSelectors) {
    input = document.querySelector(sel);
    if (input) break;
  }
  if (!input) return { dispatched: false, inputFound: false, visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() };

  // #68 USER TEXT IS SACRED: same re-probe-before-firing gate as
  // ccswInjTryClickSend -- this is the fallback submit path, tried after the
  // send button stalls, so it's exactly as capable of submitting mixed
  // user+ours text as the click path is.
  const composerText = input.textContent.trim();
  const currentHash = composerText.length > 0 ? fnvHash(composerText) : null;
  const expectedHash = window.__ccswSendMarkerHash ?? null;
  const hashMatches = currentHash === expectedHash;
  const typedSinceInsert = (window.__ccswLastKeystrokeAt || 0) > (window.__ccswSendMarkerAt || 0);
  if (typedSinceInsert || !hashMatches) {
    return {
      dispatched: false, inputFound: true, guardBlocked: true,
      guardReason: !hashMatches ? 'hash_mismatch' : 'typed_since_insert',
      hashMatches, typedSinceInsert,
      visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus(),
    };
  }

  input.focus();
  const eventInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  // D4: same reasoning as ccswInjTryClickSend's flag above -- flag this
  // synthetic Enter as our own delivery for the duration of the synchronous
  // dispatch, so markUserSend's ccsw-user-send-landed guard can tell it apart
  // from a genuine Enter keypress.
  window.__ccswDeliverySending = true;
  try {
    input.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    input.dispatchEvent(new KeyboardEvent('keyup', eventInit));
  } finally {
    window.__ccswDeliverySending = false;
  }
  return { dispatched: true, inputFound: true, visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() };
}

function ccswInjCheckCleared(marker) {
  if (window.__ccswSendMarker !== marker) {
    // An empty input here does NOT mean our message sent and cleared -- it
    // may just be a reload's fresh, never-touched input. Only trust
    // "cleared" when it's the same document we actually typed into (note
    // 448's ACK+RETRY layer only acks on a TRUE confirmed send; this is what
    // makes that guarantee hold across a mid-paste reload). Report
    // contextLost so advanceSendPhase re-types instead of falsely confirming.
    return { cleared: false, contextLost: true, visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() };
  }
  const inputSelectors = [
    'div[contenteditable="true"][data-testid="chat-input"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][data-testid]',
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][class*="composer"]',
    'div[contenteditable="true"][placeholder]',
    'div[contenteditable="true"]',
  ];
  let input = null;
  for (const sel of inputSelectors) {
    input = document.querySelector(sel);
    if (input) break;
  }
  return { cleared: !input || input.textContent.trim().length === 0, visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() };
}

// D1 reclaim: wipes the composer, but ONLY after re-verifying (right here, at
// the DOM side, in the same tick as the wipe itself) that its content still
// hashes to expectedHash. #68 USER TEXT IS SACRED: the caller's own
// composerHash check (see reclaimStrandedComposer's callers) happens in a
// separate executeScript round-trip, which leaves a race window for the user
// to type in between "caller decided this looks like our stranded text" and
// "this function actually wipes it." Re-checking here, immediately before the
// wipe, closes that window -- expectedHash is mandatory; a null/undefined
// value or any mismatch refuses instead of guessing. Same clear approach
// ccswInjInsertText uses before pasting: execCommand first, innerHTML
// fallback if that leaves a residue (some ProseMirror builds no-op
// execCommand('delete') on a detached/backgrounded selection).
function ccswInjClearComposer(expectedHash) {
  // #68 USER TEXT IS SACRED: see fnvHash's twin in ccswInjInsertText.
  function fnvHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
  }
  const inputSelectors = [
    'div[contenteditable="true"][data-testid="chat-input"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][data-testid]',
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][class*="composer"]',
    'div[contenteditable="true"][placeholder]',
    'div[contenteditable="true"]',
  ];
  let input = null;
  for (const sel of inputSelectors) {
    input = document.querySelector(sel);
    if (input) break;
  }
  if (!input) return { cleared: true, inputFound: false, refused: false, visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() };
  const composerText = input.textContent.trim();
  if (composerText.length > 0) {
    if (expectedHash == null || fnvHash(composerText) !== expectedHash) {
      return { cleared: false, inputFound: true, refused: true, visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() };
    }
  }
  if (input.textContent.length > 0) {
    input.focus();
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    if (input.textContent.length > 0) input.innerHTML = '';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward', data: null }));
  }
  return { cleared: input.textContent.trim().length === 0, inputFound: true, refused: false, visibilityState: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus() };
}

// The pre-insert delivery gate's probe, in one executeScript round-trip:
// completion running, composer empty/typed/hash, and the send button's
// found/enabled state ccswInjTryClickSend would separately check post-insert.
// advanceHoldPhase (D1/D1b) gates insertion on this directly -- text is NEVER
// pasted until it reports sendButtonFound, so a tab whose composer toolbar
// doesn't render at all (the proven hidden-tab failure mode) holds with zero
// insertion instead of pasting into a dead end. sendButtonEnabled is also
// returned here but is NOT part of the pre-insert gate (see D1b note in
// advanceHoldPhase) -- it's only consumed post-insert. Also feeds
// the deliver_attempt log below and the stranded-ours reclaim check, both of
// which predate this being an actual gate (see queueSend/reclaimStrandedComposer).
// Deliberately does NOT call input.focus(), btn.click(), or touch
// window.__ccswSendMarker -- it must be safe to run alongside a live delivery
// without perturbing it.
function ccswInjProbeDelivery(typingHoldMs) {
  const stopSelectors = ['button[aria-label="Stop response"]', 'button[aria-label*="Stop"]'];
  const inputSelectors = [
    'div[contenteditable="true"][data-testid="chat-input"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][data-testid]',
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][class*="composer"]',
    'div[contenteditable="true"][placeholder]',
    'div[contenteditable="true"]',
  ];
  const sendSelectors = ['[data-testid="send-button"]', 'button[aria-label*="Send"]'];
  const isGenerating = stopSelectors.some((sel) => !!document.querySelector(sel));

  // #19 shape-1: unambiguous page-level streaming markers -- these nodes exist
  // ONLY while a reply is actively streaming (mirrors the confirmed entries of
  // content.js CONCURRENT_SEND_STREAMING_CURSOR_SELECTORS). One of the live
  // signals that corroborates the Stop button. Deliberately NOT page-wide
  // aria-busy, which unrelated UI can set and which would then pin every hold
  // open -- re-breaking the very stall this fixes.
  const streamingMarkerPresent = !!document.querySelector('[data-is-streaming="true"], .result-streaming');

  // Fix 1 / note 486: corroborating signal for isGenerating. A lingering Stop
  // button (see const above isGenerating) reads as "generating" even once
  // Claude has actually finished; the one thing that tells the two apart is
  // whether the last assistant reply's rendered text is still GROWING.
  // background.js's hold gate already re-probes this tab every SEND_TICK_MS
  // (200ms) while held, so rather than blocking here on an in-page
  // setTimeout, this just reports the current text length and lets
  // updateActiveGeneration() in background.js diff it against the previous
  // tick.
  //
  // '[aria-label="Give positive feedback"]' is CONFIRMED live (see
  // content.js SELECTORS.feedbackButton) -- only Claude's own messages
  // render it, one per reply, so the LAST match is always the latest
  // assistant turn. The container-widening walk below duplicates
  // content.js's findMessageTurnContainer (same reason ccswInjInsertText's
  // fnvHash is duplicated instead of shared: chrome.scripting.executeScript
  // only serializes this one function, nothing from the outer file).
  const feedbackButtonSelector = '[aria-label="Give positive feedback"]';
  const messageActionsGroupSelector = '[role="group"][aria-label="Message actions"]';
  const feedbackButtons = document.querySelectorAll(feedbackButtonSelector);
  let lastAssistantTextLen = null;
  let activeGenerationAttr = false;
  if (feedbackButtons.length > 0) {
    const lastAnchor = feedbackButtons[feedbackButtons.length - 1];
    const hasGroups = document.querySelectorAll(messageActionsGroupSelector).length > 0;
    const boundarySelector = hasGroups ? messageActionsGroupSelector : feedbackButtonSelector;
    let tight = lastAnchor;
    let candidate = lastAnchor.parentElement;
    while (candidate && candidate !== document.body) {
      if (candidate.querySelectorAll(boundarySelector).length > 1) break;
      tight = candidate;
      candidate = candidate.parentElement;
    }
    lastAssistantTextLen = (tight.textContent || '').length;
    // Best-effort bonus OR, not a dependency: neither attribute is confirmed
    // present on claude.ai's current DOM (unlike feedbackButtonSelector
    // above). If either ever appears, it corroborates activeGeneration
    // immediately instead of waiting a tick for the length to move; if
    // neither ever matches, this is just always false and the length-diff
    // signal alone still holds.
    activeGenerationAttr = tight.getAttribute('aria-busy') === 'true'
      || !!tight.querySelector('[aria-busy="true"], [data-is-streaming="true"]');
  }

  let input = null;
  for (const sel of inputSelectors) {
    input = document.querySelector(sel);
    if (input) break;
  }
  let btn = null;
  for (const sel of sendSelectors) {
    btn = document.querySelector(sel);
    if (btn) break;
  }
  const lastKeystrokeAt = window.__ccswLastKeystrokeAt || 0;
  const composerText = input ? input.textContent.trim() : '';
  // Tiny FNV-1a-style hash, duplicated from ccswInjInsertText's copy --
  // chrome.scripting.executeScript's `func` only serializes this one
  // function, so it can't call out to that copy (see the note above
  // ccswInjInsertText). Used only to fingerprint text for the stranded-ours
  // comparison in queueSend's deliver_attempt log -- never logged raw.
  function fnvHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16);
  }
  return {
    isGenerating,
    lastAssistantTextLen,
    activeGenerationAttr,
    streamingMarkerPresent,
    inputFound: !!input,
    inputEmpty: composerText.length === 0,
    inputLen: composerText.length,
    composerHash: composerText.length > 0 ? fnvHash(composerText) : null,
    composerHead30: composerText.slice(0, 30),
    recentlyTyped: Date.now() - lastKeystrokeAt < typingHoldMs,
    lastKeystrokeAt,
    sendButtonFound: !!btn,
    sendButtonEnabled: !!btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true',
    visibilityState: document.visibilityState,
    hidden: document.hidden,
    hasFocus: document.hasFocus(),
  };
}

function ccswInjSpeak(phrase) {
  if (!('speechSynthesis' in window)) return { spoke: false };
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(phrase));
  return { spoke: true };
}

async function execInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return results?.[0]?.result;
}

// Mirrored cache of content.js's ccswPiggybackProbe setting, loaded the same
// lazy way getConcurrentSendProbeEnabled() below does -- background.js has no
// content.js scope to read piggybackProbeEnabled from, so the resend handler
// below caches it here to decide whether to BUNDLE this tab's ready wake
// outputs into the one resend (flag on) or fall back to the byte-for-byte
// original single-text resend (flag off).
let piggybackProbeCache = false;
let piggybackProbeLoaded = false;

async function getPiggybackProbeEnabled() {
  if (piggybackProbeLoaded) return piggybackProbeCache;
  try {
    const stored = await chrome.storage.local.get('ccswPiggybackProbe');
    // Default ON: enabled unless the stored value is explicitly false, mirroring
    // content.js's loadPiggybackProbeEnabled.
    piggybackProbeCache = stored.ccswPiggybackProbe !== false;
  } catch (e) {
    piggybackProbeCache = false;
  }
  piggybackProbeLoaded = true;
  return piggybackProbeCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, 'ccswPiggybackProbe')) {
    // Default ON: enabled unless the new value is explicitly false.
    piggybackProbeCache = changes.ccswPiggybackProbe.newValue !== false;
    piggybackProbeLoaded = true;
  }
});

// --- ALWAYS-ON JOB-STATUS FOOTER ---------------------------------------------
// Pulls the board-state footer from the target tab's content script, which is
// the only place job names AND all three states (running / held / repo busy)
// are known -- see buildJobStatusFooter in content.js for why it's built there.
//
// Asked for fresh at each insert, not cached, so the footer describes the board
// as of the send. Gated ONLY on ccswPiggybackProbe (the feature's on/off
// switch) -- deliberately NOT on suppression or bundling: every send carries
// it, including deliveries with nothing else queued.
//
// Returns '' on any failure. A footer is an annotation; it must never be able
// to block or fail a delivery, so an unreachable content script (mid-navigation
// tab, injection lost to a reload) just means this send goes without one.
//
// deliveringJobIds is the job(s) whose results this very insert carries. Only
// this side knows that -- the tab's pill registry can't tell "result queued"
// from "result being pasted right now" -- so every caller must pass it, or the
// footer describes the delivering job as still owed in the message answering it.
async function fetchStatusFooter(tabId, deliveringJobIds = []) {
  if (!(await getPiggybackProbeEnabled())) return '';
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'ccsw-status-footer',
      deliveringJobIds: deliveringJobIds.filter((id) => id != null),
    });
    const footer = response?.footer;
    return typeof footer === 'string' && footer ? `\n\n${footer}` : '';
  } catch (err) {
    console.warn(`[CCswitchboard] status footer: tab ${tabId} unreachable, sending without it:`, err.message);
    return '';
  }
}

// Fix 5a: PIGGYBACK SUPPRESSION PROBE resend, now also PIGGYBACK BUNDLING.
// content.js only sends this once it has positively CONFIRMED (via
// runPiggybackProbe) that claude.ai's own native send was suppressed -- this
// handler never runs on a leaked send, since content.js simply never asks for
// a resend in that case. This is a deliberately minimal one-shot attempt
// (insert, click, else Enter) -- NOT the full retry/backoff/reclaim state
// machine advanceSendPhase below runs for real job-result delivery -- since a
// probe run is short, watched live by a tester, and doesn't need to survive a
// backgrounded/idle tab. Reuses ccswInjInsertText/ccswInjTryClickSend/
// ccswInjTryEnterSend UNCHANGED, so the resend goes through the exact same #68
// USER TEXT IS SACRED hash/marker + typed-since-insert guard every real
// wake-delivery resend does.
//
// PIGGYBACK BUNDLING (flag-gated on ccswPiggybackProbe): background owns
// pendingSends, so this is where the user's suppressed send is folded together
// with EVERY ready wake output for this tab into ONE combined chat message,
// instead of D4 (content.js's ccsw-user-send-landed flush, which content.js
// now skips while the flag is on) delivering those outputs as a separate
// message. Only AFTER the combined send is confirmed is each bundled job put
// through finishSend(key, entry, 'sent') -- the exact same terminal path the
// normal single-delivery send uses -- which marks it delivered (confirmDelivered
// -> markJobDelivered + removeActiveDeliveryJob + ackDeliveryToRelay), drops it
// from pendingSends, AND emits the UI-clear broadcasts (ccsw-send-outcome ->
// setJobBarWaiting(false), the D2 'sent' queue-state terminal,
// reportDeliveryPending(false)) so the "output waiting" indicators clear exactly
// as on the normal path. finishSend is terminal bookkeeping only and never
// re-sends, so nothing is delivered twice; on send failure the outputs stay
// queued for the normal tick/retry. With the flag OFF this branch never bundles
// and the injection is byte-for-byte the original single-text resend.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-piggyback-probe-resend') return false; // not for us

  const tabId = sender.tab?.id;
  const text = typeof message.text === 'string' ? message.text : '';
  const method = message.method === 'click' ? 'click' : 'enter';
  if (!tabId || !text) {
    sendResponse({ ok: false, error: 'missing tabId or text' });
    return false;
  }

  (async () => {
    const bundling = await getPiggybackProbeEnabled();

    // Ready wake outputs for THIS tab still awaiting delivery. Filter by the
    // existing delivered ledger too (isJobDelivered) so a job the normal tick
    // already delivered in the probe window is never bundled a second time --
    // reusing the existing dedup rather than building a parallel one.
    const bundled = bundling
      ? [...pendingSends.entries()].filter(([, entry]) =>
          entry.tabId === tabId && entry.kind === 'wake' && entry.jobId && !isJobDelivered(deliveryLedgerKey('wake', entry.jobId)))
      : [];
    const bundledJobIds = bundled.map(([, entry]) => entry.jobId);

    // Assemble the ONE combined message: user's text, then each ready output
    // verbatim. join('\n\n') keeps them as distinct paragraphs in the composer.
    const parts = [text];
    for (const [, entry] of bundled) {
      if (typeof entry.text === 'string' && entry.text) parts.push(entry.text);
    }

    // The board-state footer replaces the old "Still running: job 41, job 42"
    // line this path used to build from toolbarJobs. That line could only ever
    // name running jobs BY ID (toolbarJobs holds no names), said nothing about
    // held or repo-busy jobs, and omitted itself entirely when the map happened
    // to be empty -- so "no line" meant both "nothing is running" and "nothing
    // is known". The footer names every owed job in all three states and is
    // always present, so it strictly supersedes it.
    const combined = parts.join('\n\n') + (await fetchStatusFooter(tabId, bundledJobIds));

    const marker = `piggyback-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      // #68 P1: allowUserTextClobber=true is the ONE audited exception to the
      // insert primitive's pre-insert user-text guard. This resend fires only
      // after content.js positively CONFIRMED the user's native send was
      // suppressed (their text is still sitting in the composer) and has folded
      // that exact text into `combined` as its first paragraph -- so clearing
      // the composer here re-sends the user's text, it does not destroy it. No
      // other caller sets this flag.
      const insertResult = await execInTab(tabId, ccswInjInsertText, [combined, marker, null, true]);
      if (!insertResult?.ok) {
        sendResponse({ ok: false, stage: 'insert', method, insertResult, outputCount: 0, jobIds: [] });
        return;
      }
      const clickResult = await execInTab(tabId, ccswInjTryClickSend, [marker]);
      let stage = 'click';
      let sent = !!clickResult?.clicked;
      let enterResult = null;
      if (!sent) {
        enterResult = await execInTab(tabId, ccswInjTryEnterSend, [marker]);
        stage = 'enter';
        sent = !!enterResult?.dispatched;
      }

      // Mark each bundled output delivered ONLY on a confirmed send by routing
      // it through finishSend(key, entry, 'sent') -- the SAME terminal path the
      // normal single-delivery send uses -- instead of the hand-rolled
      // markJobDelivered/removeActiveDeliveryJob/ackDeliveryToRelay/delete block
      // this used to run. That block marked the data layer delivered but emitted
      // NONE of the UI-clear steps finishSend does, so all three "output
      // waiting" indicators (the collapsed toolbar pill's waiting label, the
      // expanded pill's title bar, and the terminal-box banner -- every one of
      // them keyed off the single ccsw-job-bar--waiting class content.js toggles
      // via setJobBarWaiting) stayed stuck on after a bundled send. finishSend
      // does everything that block did -- pendingSends.delete, the delivered
      // ledger + active-delivery-registry + relay ack (via confirmDelivered),
      // stopDeliveryKeepAlive once the queue drains -- AND the clears that were
      // missing: reportDeliveryPending(jobId,false), the 'ccsw-send-outcome'
      // message that drives setJobBarWaiting(false) (clearing all three
      // indicators at once), the D2 broadcastQueueStateForTab 'sent' terminal
      // for the pending-delivery pill, and confirmDelivered's
      // ccsw-delivery-failed(false) that clears any escalated red state. So a
      // bundle-delivered job is now byte-for-byte indistinguishable from a
      // normally delivered one. finishSend is terminal bookkeeping ONLY -- it
      // never inserts/clicks -- so this reintroduces no duplicate send. On a
      // failed send (sent === false) this block is skipped and the entries stay
      // in pendingSends for the normal tick/retry, exactly as before.
      let deliveredIds = [];
      if (sent && bundled.length > 0) {
        // D3-style additive batch tag so each deliver_sent log line records that
        // it rode in one combined message (same shape finishBatchedSend uses).
        const batchInfo = bundled.length > 1
          ? { batchedKeys: bundled.map(([bkey]) => bkey), batchSize: bundled.length }
          : null;
        for (const [key, entry] of bundled) {
          finishSend(key, entry, 'sent', batchInfo);
        }
        deliveredIds = bundledJobIds;
      }

      const outputCount = deliveredIds.length;
      logDeliveryEvent('piggyback_bundle', null, { tabId, outputCount, jobIds: deliveredIds, method, stage }, true);
      sendResponse({ ok: sent, stage, method, insertResult, clickResult, enterResult, outputCount, jobIds: deliveredIds });
    } catch (err) {
      sendResponse({ ok: false, error: err.message, outputCount: 0, jobIds: [] });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
});

// --- CONCURRENT-SEND PROBE: ATTEMPT MODE (flag-gated) -----------------------
//
// Jody reports newer claude.ai tabs accept a send while Claude is still
// generating (THINKING: tacks onto the current turn; OUTPUTTING: queues it)
// instead of rejecting it. If true, advanceHoldPhase's `generating` branch
// below (held reason 'completion_running') could inject a pending result as
// soon as it's ready instead of holding for a gap. This proves it live, on a
// REAL pending delivery, without ever risking the result being lost -- see
// the hook in advanceHoldPhase for the gate this only fires behind, and
// attemptConcurrentSend's own comment for the fallback guarantee.
//
// Mirrored cache of content.js's ccswConcurrentSendProbe setting, loaded the
// same lazy way ensureRelaysLoaded() loads 'ccswRelays' above -- background.js has
// no content.js scope to read piggybackProbeEnabled-style module state from,
// so every flag content.js and background.js both need to gate on is
// separately cached here.
let concurrentSendProbeCache = false;
let concurrentSendProbeLoaded = false;

async function getConcurrentSendProbeEnabled() {
  if (concurrentSendProbeLoaded) return concurrentSendProbeCache;
  try {
    const stored = await chrome.storage.local.get('ccswConcurrentSendProbe');
    concurrentSendProbeCache = stored.ccswConcurrentSendProbe === true;
  } catch (e) {
    concurrentSendProbeCache = false;
  }
  concurrentSendProbeLoaded = true;
  return concurrentSendProbeCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, 'ccswConcurrentSendProbe')) {
    concurrentSendProbeCache = changes.ccswConcurrentSendProbe.newValue === true;
    concurrentSendProbeLoaded = true;
  }
});

// Injected read-only check for whether `marker` has landed IN THE
// CONVERSATION (not merely typed into the composer, which would report a
// false "landed" for a send that was never actually accepted). Excludes any
// match still sitting in the composer input from counting -- see `landed`
// below -- so a rejected/no-op send that leaves our tagged text stranded in
// the box reports lost, not landed.
function ccswInjCheckMarkerLanded(marker) {
  const inputSelectors = [
    'div[contenteditable="true"][data-testid="chat-input"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][data-testid]',
    'div[contenteditable="true"].ProseMirror',
    'div[contenteditable="true"][class*="composer"]',
    'div[contenteditable="true"][placeholder]',
    'div[contenteditable="true"]',
  ];
  let input = null;
  for (const sel of inputSelectors) {
    input = document.querySelector(sel);
    if (input) break;
  }
  const inComposer = !!input && input.textContent.includes(marker);
  const bodyText = document.body.textContent || '';
  const inBody = bodyText.includes(marker);
  return { landed: inBody && !inComposer, inComposer, inBody };
}

function notifyConcurrentSendToast(tabId, outcome) {
  chrome.tabs.sendMessage(tabId, { type: 'ccsw-concurrent-send-toast', outcome }).catch(() => {});
}

const CONCURRENT_SEND_OBSERVE_MS = 6000;
const CONCURRENT_SEND_OBSERVE_POLL_MS = 750;

// Polls ccswInjCheckMarkerLanded until it reports landed:true or timeoutMs
// elapses, whichever comes first -- an early landing (the common case, if
// the capability is real) doesn't sit out the full 6s.
async function waitForMarkerLanding(tabId, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await execInTab(tabId, ccswInjCheckMarkerLanded, [marker]).catch(() => null);
    if (result?.landed) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, CONCURRENT_SEND_OBSERVE_POLL_MS));
  }
}

// SAFETY INVARIANT (non-negotiable, same shape as runPiggybackProbe's in
// content.js): this entry is only ever finalized via finishSend -- removing
// it from pendingSends so the normal hold/timer tick can never also deliver
// it -- once the marker has been positively CONFIRMED landed IN THE
// CONVERSATION. Every other path (insert failed, click/Enter never fired,
// marker not found within CONCURRENT_SEND_OBSERVE_MS, an unexpected
// exception) clears entry.concurrentAttemptInFlight and returns WITHOUT
// touching pendingSends -- entry.text was never mutated (textToInsert is
// local to this function), entry.phase is still 'hold', so the very next
// SEND_TICK_MS tick's advanceHoldPhase (see its own guard on
// concurrentAttemptInFlight) picks this entry back up and holds/delivers it
// exactly as if this probe had never run. That's what "fall back to the
// normal hold/timer path" means in practice: never a separate delivery
// attempt, just handing the SAME entry back to the SAME gate.
//
// Called at most once per entry (advanceHoldPhase sets
// entry.concurrentAttempted before calling this, and never calls it twice
// for the same entry), so a rejected/lost attempt can strand its
// marker-tagged text in the composer without risking a second, overlapping
// attempt piling a second marker on top -- advanceHoldPhase's own
// strandedOurs reclaim (unchanged, see its comment) clears that leftover on
// the next tick like any other stranded paste.
async function attemptConcurrentSend(key, entry, probeAtStart) {
  entry.concurrentAttemptInFlight = true;
  const startedAt = Date.now();
  const contentMarker = `ccsw-concurrent-${key}`;
  const baseText = typeof entry.text === 'string' ? entry.text : '';
  // Footer sits between the body and the marker, so the marker stays the LAST
  // thing in the text and waitForMarkerLanding's search is unaffected. entry.text
  // itself is still never mutated (see this function's SAFETY INVARIANT above):
  // a lost attempt requeues the original body, footer and all, rebuilt fresh.
  const textToInsert = `${baseText}${await fetchStatusFooter(entry.tabId, [entry.jobId])}\n\n[${contentMarker}]`;

  logDeliveryEvent('concurrent_send_attempt', entry, {
    key,
    stage: 'start',
    generatingAtInject: true,
    signals: probeAtStart ? {
      isGenerating: probeAtStart.isGenerating,
      activeGenerationAttr: probeAtStart.activeGenerationAttr,
      lastAssistantTextLen: probeAtStart.lastAssistantTextLen,
      sendButtonFound: probeAtStart.sendButtonFound,
      sendButtonEnabled: probeAtStart.sendButtonEnabled,
    } : null,
  });

  const finish = (outcome, extra) => {
    const delayMs = Date.now() - startedAt;
    logDeliveryEvent('concurrent_send_attempt', entry, { key, outcome, generatingAtInject: true, delayMs, ...extra });
    notifyConcurrentSendToast(entry.tabId, outcome);
    if (outcome === 'landed') {
      finishSend(key, entry, 'sent');
    } else {
      entry.concurrentAttemptInFlight = false;
    }
  };

  try {
    // #68 P1: same protected insert as the state-machine path -- this only ever
    // fires when the pre-insert probe saw an EMPTY composer, but if the user
    // typed in the race window the primitive refuses (composer-has-user-text)
    // and finish('lost') below hands the entry straight back to the normal tick
    // still OWED (it does NOT finishSend), so nothing is clobbered or dropped.
    const expectedHash = lastInjectedByTab.get(entry.tabId)?.textHash ?? null;
    const insertResult = await execInTab(entry.tabId, ccswInjInsertText, [textToInsert, key, expectedHash]);
    if (!insertResult?.ok) {
      finish('lost', { stage: 'insert', insertResult });
      return;
    }
    // Carry the full payload (jobId above all) the same way the normal insert
    // path does (see advanceSendPhase's lastInjectedByTab.set). Without it, a
    // concurrent-send attempt that STRANDS its text (outcome 'lost' after the
    // insert succeeded) leaves lastInjected.payload undefined -- so
    // runStrandedSentinelSweep's parked pill + recentTerminalSends entry get
    // jobId:null, and the pill's manual "send now" (requestPendingRedeliver)
    // then hits the no-jobId branch and shows "payload expired" for what is
    // really a durable job result the relay still holds. textHash stays the
    // hash of textToInsert (what's actually in the composer, for the sweep's
    // strandedOurs comparison); payload.text is the ORIGINAL entry text
    // (baseText), not the marker-tagged textToInsert, so a requeue re-inserts
    // clean text.
    lastInjectedByTab.set(entry.tabId, {
      key, at: Date.now(), len: textToInsert.length, textHash: insertResult.textHash,
      payload: {
        jobId: entry.jobId ?? null, thread: entry.thread ?? null, kind: entry.kind ?? null,
        text: baseText, speakPhrase: entry.speakPhrase ?? null, label: entry.label ?? null, queuedAt: entry.queuedAt ?? null,
      },
    });

    let clickResult = await execInTab(entry.tabId, ccswInjTryClickSend, [key]);
    let sentVia = 'click';
    if (!clickResult?.clicked) {
      clickResult = await execInTab(entry.tabId, ccswInjTryEnterSend, [key]);
      sentVia = 'enter';
    }
    const dispatched = !!(clickResult?.clicked || clickResult?.dispatched);
    if (!dispatched) {
      finish('lost', { stage: 'submit', sentVia, clickResult });
      return;
    }

    const landed = await waitForMarkerLanding(entry.tabId, contentMarker, CONCURRENT_SEND_OBSERVE_MS);
    finish(landed ? 'landed' : 'lost', { stage: 'observe', sentVia });
  } catch (err) {
    finish('lost', { stage: 'error', error: err?.message ?? String(err) });
  }
}

async function tabStillOpen(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

function backoffForAttempt(attempt) {
  return SEND_RETRY_BACKOFF_MS[attempt - 1] ?? SEND_RETRY_BACKOFF_MS[SEND_RETRY_BACKOFF_MS.length - 1];
}

// --- send-path diagnostics ---------------------------------------------
// Detailed per-stage log of the send state machine below, persisted to
// chrome.storage.local under 'ccswSendLog' (inspect any time via
// chrome.storage.local.get('ccswSendLog', console.log) in this service
// worker's own DevTools -- brave://extensions -> "service worker" ->
// Console -- even after the fact, since it survives worker restarts).
// Added to chase a bug where a wake/result prompt would type into Claude's
// input but not actually send until Jody switched back to the tab: each
// entry below records which stage ran, what it found, and the tab's
// visibility/focus state at that exact moment, so a hidden-tab-only
// failure shows up as a distinct pattern (e.g. 'find-button' reporting
// buttonDisabled:true tick after tick while hidden:true, then clicked:true
// the moment hidden flips back to false).
const SEND_LOG_MAX_ENTRIES = 500;
let sendLogCache = null; // lazy-loaded once, then kept in memory and flushed to storage

async function loadSendLogCache() {
  if (sendLogCache) return sendLogCache;
  const { ccswSendLog } = await chrome.storage.local.get('ccswSendLog');
  sendLogCache = Array.isArray(ccswSendLog) ? ccswSendLog : [];
  return sendLogCache;
}

// The polling stages of the send state machine re-log on a timer: hold-check
// every hold tick (~200ms) per held job, and find-button / await-clear every
// send tick per in-flight delivery. Those three are the flood; route their
// console line through vlog so they're silent unless ccswVerboseLog is on.
// Every other stage is a one-shot per-job/per-event line (queued, insert,
// hold-cleared-untouched, the terminal outcome, the reclaim/guard/context-lost
// events, ...) and stays UNCONDITIONAL. Only the console line is gated -- the
// storage ring buffer below still records EVERY stage, so the state machine
// and its post-hoc diagnostics are unchanged.
const SEND_LOG_TRACE_STAGES = new Set(['hold-check', 'find-button', 'await-clear']);

async function appendSendLog(entry) {
  const record = { ts: Date.now(), ...entry };
  const line = `[CCswitchboard] sendLog (${record.key}): ${record.stage}`;
  if (SEND_LOG_TRACE_STAGES.has(record.stage)) vlog(line, record);
  else console.log(line, record);
  const cache = await loadSendLogCache();
  cache.push(record);
  if (cache.length > SEND_LOG_MAX_ENTRIES) cache.splice(0, cache.length - SEND_LOG_MAX_ENTRIES);
  await chrome.storage.local.set({ ccswSendLog: cache }).catch((err) => {
    console.warn('[CCswitchboard] sendLog: failed to persist:', err.message);
  });
}

// --- delivery instrumentation (observe-only) -----------------------------
// Feeds the same central ring buffer content.js's logEvent() does, so the
// delivery path shows up in {debuglog:true, type:'deliver_wait'} queries
// alongside the dispatch events. content.js's logEvent() relays through a
// runtime message so background can stamp sender.tab.id; delivery runs IN
// background, which has no sender tab, so tabId is stamped from the send
// entry itself.
//
// STRICTLY ADDITIVE: nothing in the send state machine reads these fields or
// branches on them. Every call is wrapped so a malformed detail object can
// never throw into a delivery step.
function logDeliveryEvent(type, entry, detail, urgent = false) {
  try {
    recordDebugEvent({
      ts: new Date().toISOString(),
      build: CCSW_BUILD,
      thread: entry?.thread ?? null,
      type,
      detail: {
        jobId: entry?.jobId ?? null,
        thread: entry?.thread ?? null,
        tabId: entry?.tabId ?? null,
        ...detail,
      },
    }, urgent);
  } catch {
    // Instrumentation must never break delivery.
  }
}

// The send tick runs every SEND_TICK_MS (200ms), so a gate that holds for the
// full SEND_HOLD_TIMEOUT_MS (5 min) would re-check ~1500 times. Logging each
// one would blow the 500-event ring and bury the surrounding context, so
// deliver_retry is throttled -- ticksSinceWait on each event carries the TRUE
// re-check count, so the real poll rate is still recoverable from the log.
const DELIVER_RETRY_LOG_THROTTLE_MS = 2000;

// Records that a delivery is blocked at `reason`. First block (or a change of
// reason) emits deliver_wait; every subsequent re-check of the same reason
// emits a throttled deliver_retry carrying waitedMs since the FIRST block.
// The wedge signature is a deliver_wait followed by deliver_retry events
// piling up with no deliver_release ever arriving.
function noteDeliverWait(entry, key, phase, reason, extra = {}) {
  try {
    const now = Date.now();
    if (entry.deliverWaitAt == null || entry.deliverWaitReason !== reason) {
      if (entry.deliverWaitAt == null) {
        entry.deliverWaitAt = now;
        entry.deliverWaitTicks = 0;
      }
      entry.deliverWaitReason = reason;
      // D2: stashed alongside the reason (not just logged) so
      // pendingEntryPayload's humanizeWaitReason can tell e.g. "tab hidden"
      // apart from a same-named reason with different context.
      entry.deliverWaitExtra = extra;
      entry.deliverRetryLoggedAt = now;
      logDeliveryEvent('deliver_wait', entry, { key, phase, reason, ...extra });
      broadcastQueueStateForTab(entry.tabId); // D2: pill-visible reason changed
      return;
    }
    entry.deliverWaitTicks += 1;
    if (now - entry.deliverRetryLoggedAt < DELIVER_RETRY_LOG_THROTTLE_MS) return;
    entry.deliverRetryLoggedAt = now;
    logDeliveryEvent('deliver_retry', entry, {
      key,
      phase,
      stillWaitingReason: reason,
      waitedMs: now - entry.deliverWaitAt,
      ticksSinceWait: entry.deliverWaitTicks,
      ...extra,
    });
  } catch {
    // Instrumentation must never break delivery.
  }
}

// The gate cleared and this delivery is proceeding. Ends the current wait
// epoch, so a later block (e.g. the send button never enabling, after the
// typing hold already cleared) opens a fresh deliver_wait with its own
// waitedMs rather than inheriting the hold phase's clock.
function noteDeliverRelease(entry, key, phase, extra = {}) {
  try {
    const waitedMs = entry.deliverWaitAt == null ? 0 : Date.now() - entry.deliverWaitAt;
    logDeliveryEvent('deliver_release', entry, { key, phase, waitedMs, ...extra });
    entry.deliverWaitAt = null;
    entry.deliverWaitReason = null;
    entry.deliverWaitExtra = null;
    entry.deliverWaitTicks = 0;
    entry.deliverRetryLoggedAt = 0;
    broadcastQueueStateForTab(entry.tabId); // D2: pill-visible wait cleared
  } catch {
    // Instrumentation must never break delivery.
  }
}

// #62 CLICK-PHASE DETAIL: send_click_state, logged once per STATE CHANGE
// rather than once per find-button retry (SEND_TICK_MS ticks the same attempt
// up to SEND_BUTTON_WAIT_TIMEOUT_MS worth of times) -- same throttling intent
// as noteDeliverWait's retry throttle, just keyed on the (buttonFound,
// buttonEnabled, composerLen) tuple actually changing instead of on elapsed
// time, since a wedge here means those three values sit frozen tick after
// tick.
function noteClickState(key, entry, state) {
  try {
    const stateKey = `${state.buttonFound}|${state.buttonEnabled}|${state.composerLen}`;
    if (entry.lastClickStateKey === stateKey) return;
    entry.lastClickStateKey = stateKey;
    logDeliveryEvent('send_click_state', entry, { key, ...state });
  } catch {
    // Instrumentation must never break delivery.
  }
}

// key -> { tabId, jobId, thread, kind, text, speakPhrase, label, phase,
// holdClearSince, subPhase, attempt, stageStartedAt, nextAttemptAt, busy }.
// One entry per in-flight delivery; advanceSend() below moves each entry
// through phase 'hold' -> 'insert' -> 'send' one step per tick.
const pendingSends = new Map();
let sendTickIntervalId = null;

// MV3 suspends this service worker after ~30s idle. If every Claude tab is
// backgrounded while a delivery sits in pendingSends, the suspended worker
// freezes advanceSendPhase mid-phase -- the result then only sends once a tab
// regains focus and wakes the worker back up. This keepalive holds the worker
// alive (a harmless API call every 20s resets Chrome's idle timer) for
// exactly as long as pendingSends is non-empty, and lets it sleep the rest of
// the time.
let keepAliveIntervalId = null;

function startDeliveryKeepAlive() {
  if (keepAliveIntervalId != null) return;
  keepAliveIntervalId = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo().catch(() => {});
    } catch {
      // Keepalive tick must never throw.
    }
  }, 20000);
  logDeliveryEvent('keepalive-start', null, { pendingSends: pendingSends.size }, true);
}

function stopDeliveryKeepAlive() {
  if (keepAliveIntervalId == null) return;
  clearInterval(keepAliveIntervalId);
  keepAliveIntervalId = null;
  logDeliveryEvent('keepalive-stop', null, {}, true);
}

// tabId -> {key, textHash, len, at}, the most recent delivery whose text
// actually landed in that tab's composer (set in advanceInsertPhase below).
// Lets deliver_attempt's probe (and, since D1, advanceHoldPhase's reclaim
// check) tell "the composer is occupied by OUR own stranded/unsent text"
// apart from "the user is typing something unrelated", which otherwise both
// look identical (inputEmpty:false). D1: a pre-insert probe whose composerHash
// matches this tab's entry triggers reclaimStrandedComposer instead of
// holding forever on composer_busy.
const lastInjectedByTab = new Map();

// Fix 1 / note 486: tabId -> { lastLen, lastChangeAt }. Tracks the last
// assistant message's rendered text length (ccswInjProbeDelivery's
// lastAssistantTextLen) across advanceHoldPhase's ~200ms probe ticks
// (SEND_TICK_MS), so updateActiveGeneration below can tell a genuinely
// still-streaming reply (length keeps growing tick to tick) apart from a
// Stop button that lingers in the DOM after generation truly ended (length
// stays flat). Cleared per tab in chrome.tabs.onRemoved below, same as
// lastInjectedByTab.
const ccswGenerationStateByTab = new Map();

// Diffs probe.lastAssistantTextLen against this tab's last-known length and
// reports whether generation looks ACTIVE right now. `probe` being null
// (execInTab failed) or having found no assistant message at all
// (lastAssistantTextLen === null, e.g. a fresh empty thread) can't
// corroborate either way, so this degrades to "trust the Stop button"
// (returns true) rather than forcing a false release on a probe that told us
// nothing.
function updateActiveGeneration(tabId, probe) {
  // Nothing to diff against (probe failed, or no assistant message on the page
  // yet -- e.g. a fresh empty thread): can't corroborate either way, so degrade
  // to trusting the Stop button rather than forcing a false release on a probe
  // that told us nothing.
  if (!probe || probe.lastAssistantTextLen == null) return true;
  const now = Date.now();
  const prev = ccswGenerationStateByTab.get(tabId);
  const grew = !prev || probe.lastAssistantTextLen !== prev.lastLen;
  if (grew) {
    // The reply's rendered text moved since the last tick -- unambiguously live.
    ccswGenerationStateByTab.set(tabId, { lastLen: probe.lastAssistantTextLen, lastChangeAt: now });
    return true;
  }
  // A DOM streaming marker (streaming cursor / data-is-streaming / container
  // aria-busy) corroborates live generation directly, no length movement
  // needed -- covers a genuine reply that pauses output briefly (tool call,
  // thinking) while still streaming.
  if (probe.streamingMarkerPresent || probe.activeGenerationAttr) return true;
  // Length flat AND no streaming marker: tolerate a brief inter-token gap so a
  // real reply is never cut short, but treat a length that has now stayed flat
  // past HOLD_STALE_CONFIRM_MS -- with no marker -- as the stale-DOM signature
  // (a lingering Stop button after generation truly ended). This is the point
  // at which the hold is released in seconds instead of riding the old fixed
  // 3-minute wait.
  return (now - prev.lastChangeAt) < HOLD_STALE_CONFIRM_MS;
}

// How many entries in pendingSends currently target this tab -- used by
// queue_enqueued/queue_flush logging below to report queue depth.
function countQueueDepthForTab(tabId) {
  let n = 0;
  for (const entry of pendingSends.values()) {
    if (entry.tabId === tabId) n++;
  }
  return n;
}

// D2 PENDING-DELIVERY PILLS: makes every queued send visible on its
// destination tab, not just 'wake' (job-completion) deliveries, which
// already had the job pill's own --waiting indicator. Everything below this
// point renders and refreshes those pills; the send state machine itself is
// unchanged by any of it.

// Human labels for entry.kind (see queueSend's callers) -- shown on the pill
// as "<label> from <thread>". Falls back to the raw kind string for anything
// not listed here, so a future kind never renders blank.
const PENDING_KIND_LABELS = {
  wake: 'Job result',
  'repo-free': 'Wake',
  'plan-quiet': 'Plan check-in',
  debuglog: 'Debug log',
  pillstatus: 'Status report',
  actions: 'Actions',
  advice: 'Advice',
  qquery: 'Todo query',
};
function humanizeKind(kind) {
  return PENDING_KIND_LABELS[kind] || kind || 'Message';
}

// Friendly text for the reason a delivery is currently held (see
// noteDeliverWait's reasons array in advanceHoldPhase) -- extra.hidden takes
// priority since "tab hidden" is the single most actionable thing Jody can
// read off the pill (switch to the tab), regardless of which gate is
// technically blocking underneath it.
const WAIT_REASON_LABELS = {
  completion_running: 'Claude replying',
  composer_missing: 'composer not ready',
  composer_busy: 'composer busy',
  user_typing: 'typing in progress',
  send_button_missing: 'send button not found',
  send_button_disabled: 'send button disabled',
  probe_failed: 'probe failed',
  queued_behind_head: 'queued behind another delivery',
};
function humanizeWaitReason(reason, extra) {
  if (!reason) return null;
  if (extra?.hidden) return 'tab hidden';
  return WAIT_REASON_LABELS[reason] || reason.replace(/_/g, ' ');
}

// Friendly text for finishSend's give-up outcomes -- shown on a parked
// pill's expanded box so "manual send needed" has a reason attached.
const PARK_REASON_LABELS = {
  failed: 'send failed',
  'hold-timeout': 'timed out waiting for the composer',
  'tab-gone': 'tab closed',
  'no-input': 'no composer found',
  // #68: never a "failure" -- the composer holds the user's own words, so
  // delivery stepped aside instead of sending or wiping them.
  'user-text-guard': 'held back -- your text is in the box',
};
function humanizeParkReason(outcome) {
  return PARK_REASON_LABELS[outcome] || outcome || 'delivery did not complete';
}

const PENDING_PREVIEW_MAX = 90;
function truncatePreview(text) {
  if (typeof text !== 'string' || text === '') return '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > PENDING_PREVIEW_MAX ? `${oneLine.slice(0, PENDING_PREVIEW_MAX - 1)}…` : oneLine;
}

// One entry's wire shape for the ccsw-pending-delivery-state broadcast below.
// `state` is 'pending' while still in pendingSends, or 'sent'/'parked' for
// the one-shot terminal entry finishSend rides along its own broadcast (see
// broadcastQueueStateForTab's terminal param) -- content.js never has to
// infer an outcome from a key merely disappearing off the list.
function pendingEntryPayload(key, entry, state, outcome) {
  return {
    key,
    kind: entry.kind ?? null,
    kindLabel: humanizeKind(entry.kind),
    jobId: entry.jobId ?? null,
    thread: entry.thread ?? null,
    label: entry.label ?? null,
    preview: truncatePreview(entry.text),
    state,
    waitReasonHuman: state === 'pending' ? humanizeWaitReason(entry.deliverWaitReason, entry.deliverWaitExtra) : null,
    parkReasonHuman: state === 'parked' ? humanizeParkReason(outcome) : null,
    queuedAt: entry.queuedAt ?? null,
  };
}

// Pushes this tab's full pending-delivery pill state to its content script --
// every entry still queued for it (state 'pending'), plus an optional
// one-shot terminal entry for the key finishSend just resolved. Fired on
// enqueue (queueSend), on a queue-head transition (ensureSendTickInterval's
// flush block), on a wait-reason change/clear (noteDeliverWait/Release), and
// on every terminal outcome (finishSend) -- see each call site's own comment.
// Fire-and-forget/cosmetic, same as every other chrome.tabs.sendMessage in
// this file: a tab with no content script (or one that's mid-navigation)
// just silently drops it, and the next broadcast supersedes it anyway.
function broadcastQueueStateForTab(tabId, terminal = null) {
  if (tabId === undefined || tabId === null) return;
  const entries = [];
  for (const [key, entry] of pendingSends) {
    if (entry.tabId !== tabId) continue;
    entries.push(pendingEntryPayload(key, entry, 'pending'));
  }
  if (terminal) entries.push(terminal);
  chrome.tabs.sendMessage(tabId, { type: 'ccsw-pending-delivery-state', tabId, entries }).catch(() => {});
}

// Short-lived cache of a parked delivery's original payload, keyed the same
// as pendingSends (finishSend deletes the real entry, so this is the only
// place a "send now" retry from the pill can still find the text/thread/etc
// to re-queue). Populated by finishSend for every non-'sent' outcome, pruned
// on redelivery or after PENDING_REDELIVER_TTL_MS, whichever comes first.
const recentTerminalSends = new Map();
const PENDING_REDELIVER_TTL_MS = 30 * 60 * 1000;

function pruneStaleTerminalSends() {
  const cutoff = Date.now() - PENDING_REDELIVER_TTL_MS;
  for (const [key, rec] of recentTerminalSends) {
    if (rec.at < cutoff) recentTerminalSends.delete(key);
  }
}

// D2 #12b twin cleanup and the parked pill's manual "send now" icon both
// live in content.js -- this is only the redeliver half. Re-queues the exact
// text/thread/kind a parked delivery originally had, through the normal
// queueSend/advanceSend pipeline (so it gets the same hold/insert/send gate,
// not a bypass). If an auto-retry (handleDeliveryFailure, for 'wake' kind)
// already re-queued this same key first, queueSend's own dedup guard makes
// this a harmless no-op log rather than a double-send.
//
// #65 TTL-PROOF REDELIVER: recentTerminalSends is pruned after
// PENDING_REDELIVER_TTL_MS (30 min) -- a parked pill can easily sit on
// screen longer than that before Jody gets to it. On a cache miss, a job-
// linked delivery (kind 'wake'/'advice' -- see queueSend's `job:`/`advice:`
// callers) isn't actually lost: the pill's own entry.jobId (rides along in
// pendingEntryPayload) still identifies the underlying job, so the original
// result can be refetched straight from the relay (result.php) and re-typed
// as a fresh wake, rather than telling Jody to go dig it up manually. A kind
// with no jobId (debuglog/pillstatus/actions/qquery/repo-free/plan-quiet)
// has no such backing record on the relay -- once its cache entry expires
// there's genuinely nothing left to redeliver.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-pending-redeliver') return false;
  (async () => {
    const rec = recentTerminalSends.get(message.key);
    if (rec) {
      recentTerminalSends.delete(message.key);
      console.log(`[CCswitchboard] pending-redeliver: manually re-queuing "${message.key}".`);
      // force:true -- this is a human clicking the parked pill's "send now"
      // icon, a deliberate re-send. Still routed through queueSend's own
      // already-delivered check (not bypassed silently) so the override is
      // logged, same as the refetch branch below.
      queueSend(message.key, {
        tabId: rec.tabId,
        jobId: rec.jobId,
        thread: rec.thread,
        kind: rec.kind,
        text: rec.text,
        speakPhrase: rec.speakPhrase,
        label: rec.label,
      }, { force: true });
      sendResponse({ ok: true });
      return;
    }

    logDeliveryEvent('redeliver_miss', { jobId: message.jobId ?? null, tabId: message.tabId ?? null, thread: null }, { key: message.key });

    if (!message.jobId) {
      console.warn(`[CCswitchboard] pending-redeliver: no cached payload for key "${message.key}" and no jobId to refetch, ignoring.`);
      sendResponse({ ok: false, reason: 'expired' });
      return;
    }

    console.log(`[CCswitchboard] pending-redeliver: cache expired for "${message.key}", refetching job ${message.jobId} from the relay.`);
    let ok = false;
    try {
      const res = await ccswFetch(`${RELAY_RESULT_FILE}?id=${message.jobId}`, { method: 'GET' });
      const body = await res.json().catch(() => null);
      if (res.ok && body && body.status === 'done' && typeof body.result === 'string') {
        const resultText = extractResultText(body.result);
        const outcomeLabel = isErrorResultText(resultText) ? 'ERRORED' : isCancelledResultText(resultText) ? 'CANCELLED' : 'finished';
        const prompt = `Job ${message.jobId} ${outcomeLabel}. Result: ${resultText}`;
        // #72/#74 STAGE 2: thread the relay's own delivered flag through to
        // queueSend's gate (previously only body.status was checked here, so
        // a job the relay already considers delivered -- genuinely, or via a
        // park-with-text ACK, see queueSend's own comment -- went straight
        // back into the queue with no record of that fact at all). force:true
        // because this is still a deliberate manual redeliver click; the gate
        // logs the override rather than silently skipping it.
        queueSend(message.key, {
          tabId: message.tabId,
          jobId: message.jobId,
          thread: body.thread ?? null,
          kind: 'wake',
          text: prompt,
          speakPhrase: normalizeForSpeech(buildWakeSpeechPhrase(message.jobId, resultText, body.thread, body.name, !!body.final)),
          label: body.name || `Job ${message.jobId}`,
          delivered: body.delivered === true,
        }, { force: true });
        ok = true;
      } else {
        console.warn(`[CCswitchboard] pending-redeliver: refetch for job ${message.jobId} found no usable result (status ${body?.status ?? res.status}).`);
      }
    } catch (err) {
      console.warn(`[CCswitchboard] pending-redeliver: refetch failed for job ${message.jobId}:`, err.message);
    }

    logDeliveryEvent('redeliver_refetch', { jobId: message.jobId, tabId: message.tabId ?? null, thread: null }, { key: message.key, ok }, true);
    sendResponse(ok ? { ok: true } : { ok: false, reason: 'expired' });
  })();
  return true; // keep the message channel open for the async sendResponse above
});

// tabId -> key of the head entry a queue_flush event was already logged for.
// A tab's head only changes when the current head finishes (finishSend
// deletes it) or a new one is queued ahead of nothing else -- logging once
// per head transition instead of once per SEND_TICK_MS (200ms) tick avoids
// flooding the ring buffer over a multi-minute hold.
const queueFlushLoggedHead = new Map();

// Two or more entries can target the same tab at once (e.g. two jobs in the
// same Claude thread finish within a few seconds of each other). They all
// share that one tab's chat input, so only the oldest-queued entry per tabId
// -- the "head" of that tab's queue -- is ever advanced on a given tick;
// everything else queued behind it for that tab just waits (still showing
// its own waiting indicator) until the head reaches a terminal outcome and
// finishSend() removes it, at which point the next entry becomes the head.
// Entries for different tabs have independent inputs and advance concurrently.
// Map iteration is insertion order, so the first entry seen per tabId here is
// the oldest.
function queueHeadsByTab() {
  const heads = new Map(); // tabId -> key
  for (const [key, entry] of pendingSends) {
    if (!heads.has(entry.tabId)) heads.set(entry.tabId, key);
  }
  return heads;
}

function ensureSendTickInterval() {
  if (sendTickIntervalId !== null) return;
  sendTickIntervalId = setInterval(() => {
    if (pendingSends.size === 0) {
      clearInterval(sendTickIntervalId);
      sendTickIntervalId = null;
      return;
    }
    const heads = queueHeadsByTab();
    for (const [key, entry] of pendingSends) {
      if (heads.get(entry.tabId) !== key) {
        // Queued behind this tab's head: never advanced, so no phase below
        // ever logs for it. Its pill still shows "output waiting", which makes
        // this a wedge candidate indistinguishable from a stuck hold unless
        // it's logged here.
        noteDeliverWait(entry, key, 'queue', 'queued_behind_head', { headKey: heads.get(entry.tabId) ?? null });
        continue;
      }
      if (queueFlushLoggedHead.get(entry.tabId) !== key) {
        queueFlushLoggedHead.set(entry.tabId, key);
        const keysForTab = [...pendingSends.keys()].filter((k) => pendingSends.get(k).tabId === entry.tabId);
        logDeliveryEvent('queue_flush', entry, { tabId: entry.tabId, depth: keysForTab.length, keys: keysForTab.slice(0, 5) });
        broadcastQueueStateForTab(entry.tabId); // D2: new head -- refresh pills for this tab
      }
      advanceSend(key, entry);
    }
  }, SEND_TICK_MS);
}

// D4: content.js's markUserSend() posts ccsw-user-send-landed right after the
// user's OWN message lands (guarded there against our own delivery clicks --
// see ccswInjTryClickSend/ccswInjTryEnterSend's __ccswDeliverySending flag).
// This flushes that tab's queue immediately instead of leaving it to the next
// SEND_TICK_MS (200ms) tick: only the head entry advances, same as a normal
// tick, so the atomic hold gate in advanceHoldPhase still applies in full --
// if Claude is generating a reply to the message that just landed, `held`
// stays true and this flush is a no-op that just re-checks a tick early.
function triggerFlushForTab(tabId) {
  const keysForTab = [...pendingSends.keys()].filter((k) => pendingSends.get(k).tabId === tabId);
  if (keysForTab.length === 0) return;
  const headKey = queueHeadsByTab().get(tabId);
  const entry = pendingSends.get(headKey);
  if (!entry) return;
  logDeliveryEvent('flush_on_user_send', entry, { tabId, depth: keysForTab.length, keys: keysForTab.slice(0, 5) });
  advanceSend(headKey, entry);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'ccsw-user-send-landed') return false;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return false;
  triggerFlushForTab(tabId);
  return false; // no response needed
});

// #65: reprioritizes `key`'s entry to be its tab's queue head -- pendingSends
// is a Map, and queueHeadsByTab picks each tab's FIRST entry in iteration
// (insertion) order, so moving this key to the front of the whole map is
// enough to make it win that per-tab check regardless of what else is queued
// ahead of it. Every other entry (this tab's and every other tab's) keeps its
// relative order, just shifted after this one -- harmless, since heads are
// computed per tabId, not globally. Returns the entry so the caller doesn't
// have to re-fetch it, or null if the key isn't queued at all (already sent,
// already parked, or never existed).
function forceFlushKey(key) {
  const entry = pendingSends.get(key);
  if (!entry) return null;
  if (queueHeadsByTab().get(entry.tabId) === key) return entry; // already head
  pendingSends.delete(key);
  const rest = [...pendingSends.entries()];
  pendingSends.clear();
  pendingSends.set(key, entry);
  for (const [k, v] of rest) pendingSends.set(k, v);
  return entry;
}

// #65 PENDING-STATE FORCE FLUSH: the waiting pd-pill's send icon used to be
// hidden outright (nothing to act on) -- now it's a manual "try the atomic
// gate right now, for THIS key" action, same underlying mechanism as D4's
// triggerFlushForTab (a just-landed user send) but prioritised to a specific
// key via forceFlushKey rather than deferring to whatever already happens to
// be the tab's head. advanceSend only ever advances ONE phase step per call
// (same as every normal SEND_TICK_MS tick), so this doesn't guarantee
// delivery -- it just forces the next check to happen now instead of up to
// SEND_TICK_MS later, and if the gate is still held, the response reports why
// so content.js can toast it instead of the click silently doing nothing.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-pending-force-flush') return false;
  (async () => {
    // EVERY path out of here MUST call sendResponse exactly once. This handler
    // returns true (keeping the message channel open), so a throw before
    // sendResponse leaves the channel open forever: content.js's `.then()`
    // never fires AND its `.catch()` never fires either, so clicking send on a
    // pill did nothing at all, silently, with no error anywhere -- the
    // "manual send hangs" bug. The previous version had no try/catch, so any
    // throw from logDeliveryEvent / advanceSend / humanizeWaitReason did
    // exactly that. (Compare the ccsw-pending-redeliver handler, which has
    // always been wrapped this way.)
    try {
      const entry = forceFlushKey(message.key);
      if (!entry) {
        sendResponse({ ok: false, reason: 'not-queued', reasonHuman: 'nothing queued for this' });
        return;
      }
      logDeliveryEvent('flush_forced', entry, { key: message.key, tabId: entry.tabId }, true);
      await advanceSend(message.key, entry);
      const after = pendingSends.get(message.key);
      if (!after || after.phase !== 'hold') {
        sendResponse({ ok: true });
      } else {
        sendResponse({
          ok: false,
          reason: after.deliverWaitReason ?? null,
          reasonHuman: humanizeWaitReason(after.deliverWaitReason, after.deliverWaitExtra) || 'composer busy',
        });
      }
    } catch (err) {
      console.warn(`[CCswitchboard] force-flush (${message.key}) threw:`, err?.message ?? err);
      try {
        sendResponse({
          ok: false,
          reason: 'flush-threw',
          reasonHuman: `send failed: ${err?.message ?? 'unknown error'}`,
        });
      } catch {
        // Channel already closed (tab navigated away mid-flush). Nothing to
        // deliver the answer to -- but never let this mask the original throw.
      }
    }
  })();
  return true; // keep the message channel open for the async sendResponse above
});

// Tells the relay a job's delivery just entered/left the send queue's 'hold'
// phase, so index.php's board row (a different origin the content script
// never runs on) and the SW menu's own next relay-backed read can show the
// same waiting dot the toolbar pill already shows locally (see content.js's
// ccsw-job-bar--waiting). Fire-and-forget: this is a cosmetic indicator,
// never allowed to affect the actual send.
function reportDeliveryPending(jobId, pending) {
  if (!jobId) return; // repo-free wakes have no job to mark
  ccswFetch(RELAY_DELIVERY_FILE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, pending }),
  }).catch((err) => {
    console.warn(`[CCswitchboard] delivery-pending report failed for job ${jobId}:`, err.message);
  });
}

// Acks a repo-lock wake (wake.php) once finishSend confirms it actually got
// typed/sent -- see finishSend's 'repo-free' branch above. Fire-and-forget,
// same as reportDeliveryPending: a failed ack just means wake.php re-offers
// this thread's wake once its claim's debounce window (WAKE_CLAIM_DEBOUNCE_
// SECONDS, db.php) expires, which is a harmless re-send, not a silent drop.
function ackWake(thread, repo) {
  if (!thread || !repo) return;
  ccswFetch(RELAY_WAKE_FILE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread, repo, ack: true }),
  }).catch((err) => {
    console.warn(`[CCswitchboard] wake ack failed for thread "${thread}" repo "${repo}":`, err.message);
  });
}

// Queues a prompt for delivery into tabId's chat input. Idempotent per key --
// a caller that somehow enqueues the same key twice (e.g. a relay poll racing
// itself) just keeps the first in-flight attempt.
//
// #72/#74 STAGE 2 UNIVERSAL GATE: this is the ONLY place a NEW entry is ever
// inserted into pendingSends -- every other path (forceFlushKey, the
// reclaim-requeues inside handleSendExhausted/handleUserTextGuard, the
// pending-redeliver listener, the stranded sentinel heal) either mutates an
// existing entry in place or funnels back through here. So this is also the
// only place that needs to refuse a re-serve: (a) a key that's already
// queued, (b) a wake OR advice delivery that's already delivered. opts.force
// lets a deliberate, human-triggered manual redeliver (the parked pill's "send
// now") push past (b) only -- it never overrides (a). Bug #84: the delivered
// check keys on the FULL delivery key (deliveryLedgerKey: `job:<id>` vs
// `advice:<id>`), so a wake and an advice send for the same job dedupe
// INDEPENDENTLY and never cross-suppress each other.
//
// Deliberately trusts isJobDelivered (the LOCAL ledger) as authoritative over
// a passed-in entry.delivered (relay-sourced), and only ever consults
// entry.delivered as an EXTRA thing to refuse (and log) on top of the local
// ledger -- never a substitute that could brand a park-with-text job
// "delivered". Historically the relay's delivered flag could be set WITHOUT
// the text ever being typed: finishSend's old user-text-guard branch called
// ackDeliveryToRelay without markJobDelivered (see INVESTIGATION-72B.md #5,
// "Stage 2"). Bug A fix 1 removed that ack, so today confirmDelivered is the
// only path that sets the relay flag and it always implies a real send -- but
// keeping the local ledger authoritative here stays strictly safe (it can only
// ever refuse MORE, never wrongly serve) and guards against any future ack
// path drifting apart from an actual delivery again.
function queueSend(key, entry, opts = {}) {
  const force = !!opts.force;

  const existing = pendingSends.get(key);
  if (existing) {
    console.log(`[CCswitchboard] send (${key}): already queued, ignoring duplicate.`);
    logDeliveryEvent('queue_refused', existing, { key, reason: 'already_queued' }, true);
    return existing;
  }

  // Bug #84: gate BOTH wake and advice deliveries, each against its OWN full
  // ledger key (deliveryLedgerKey), so an advice send dedupes against prior
  // advice sends and a wake dedupes against prior wakes -- never against each
  // other. The relay `delivered` flag tracks the job's RESULT delivery, so it
  // only refuses a wake; an advice send is never gated by it (advice dedupes
  // against itself alone).
  if ((entry.kind === 'wake' || entry.kind === 'advice') && entry.jobId) {
    const deliveredLocally = isJobDelivered(deliveryLedgerKey(entry.kind, entry.jobId));
    const deliveredRemotely = entry.kind === 'wake' && entry.delivered === true;
    if (deliveredLocally || deliveredRemotely) {
      logDeliveryEvent('queue_refused', entry, { key, reason: 'already_delivered', deliveredLocally, deliveredRemotely, forced: force }, true);
      if (!force) {
        console.log(`[CCswitchboard] send (${key}): ${entry.kind} for job ${entry.jobId} already delivered, refusing to queue.`);
        return null;
      }
      console.log(`[CCswitchboard] send (${key}): ${entry.kind} for job ${entry.jobId} already delivered, force flag set -- queuing anyway.`);
    }
  }

  console.log(`[CCswitchboard] send (${key}): queued for tab ${entry.tabId}.`);
  appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'queued' });
  pendingSends.set(key, {
    ...entry,
    phase: 'hold',
    holdClearSince: null,
    // P2: cap clock for the 5-minute stale-generation timeout. Only accumulates
    // while a hold is system-stalled; reset on every user-driven hold tick so a
    // long user prompt is never force-delivered over. See advanceHoldPhase.
    capHoldSince: null,
    subPhase: null,
    attempt: 0,
    stageStartedAt: 0,
    nextAttemptAt: 0,
    enterFallbackTried: false,
    // #72B ENTER ESCALATION: see advanceSendPhase's find-button subPhase --
    // awaitingClickClearCheck is the one-shot "check next attempt" flag set
    // right after a click reports clicked:true; enterEscalated is the sticky
    // "lead with Enter from now on" flag it can promote into.
    awaitingClickClearCheck: false,
    enterEscalated: false,
    contextLostRetries: 0,
    reclaimAttempts: 0,
    busy: false,
    queuedAt: Date.now(),
    // Instrumentation-only bookkeeping (see noteDeliverWait). Never read by
    // the state machine.
    deliverWaitAt: null,
    deliverWaitReason: null,
    deliverWaitTicks: 0,
    deliverRetryLoggedAt: 0,
    // #62: last send_click_state key logged for this entry -- see noteClickState.
    lastClickStateKey: null,
  });
  startDeliveryKeepAlive();

  const queued = pendingSends.get(key);
  const depthAfter = countQueueDepthForTab(entry.tabId);
  logDeliveryEvent('queue_enqueued', queued, { key, kind: entry.kind ?? null, depthAfter });
  broadcastQueueStateForTab(entry.tabId); // D2: new pending-delivery pill

  // deliver_attempt: capture the composer/send-button/typing state at the
  // instant delivery is first attempted, so the log shows what the gate was
  // looking at. Fired async and never awaited -- ccswInjProbeDelivery is
  // read-only, and the send tick below proceeds regardless of whether this
  // probe resolves, fails, or races it.
  const resultLen = typeof entry.text === 'string' ? entry.text.length : 0;
  execInTab(entry.tabId, ccswInjProbeDelivery, [SEND_TYPING_HOLD_MS])
    .then((probe) => {
      const now = Date.now();
      const last = lastInjectedByTab.get(entry.tabId) ?? null;
      const strandedOurs = !!(probe && probe.inputLen > 0 && last && probe.composerHash === last.textHash);
      logDeliveryEvent('deliver_attempt', queued, {
        key,
        kind: entry.kind ?? null,
        resultLen,
        probeFailed: !probe,
        composerBusy: probe ? !probe.inputEmpty : null,
        composerLen: probe ? probe.inputLen : null,
        sendButtonFound: probe ? probe.sendButtonFound : null,
        sendButtonEnabled: probe ? probe.sendButtonEnabled : null,
        userTyping: probe ? probe.recentlyTyped : null,
        completionRunning: probe ? probe.isGenerating : null,
        visibilityState: probe?.visibilityState ?? null,
        hidden: probe?.hidden ?? null,
        hasFocus: probe?.hasFocus ?? null,
        strandedOurs,
        composerHash: probe?.composerHash ?? null,
        composerHead30: probe?.composerHead30 ?? null,
        lastInjected: last ? { key: last.key, len: last.len, ageMs: now - last.at } : null,
        msSinceKeystroke: probe?.lastKeystrokeAt ? now - probe.lastKeystrokeAt : null,
      });
    })
    .catch((err) => {
      logDeliveryEvent('deliver_attempt', queued, { key, kind: entry.kind ?? null, resultLen, probeFailed: true, probeError: err?.message ?? String(err) });
    });

  reportDeliveryPending(entry.jobId, true);
  ensureSendTickInterval();
  return queued;
}

async function advanceSend(key, entry) {
  if (entry.busy) return; // previous step for this key still in flight
  // Concurrent-send probe (flag-gated): a marker-tagged attempt is in
  // flight for this exact entry (see attemptConcurrentSend) -- skip this
  // tick's normal hold/insert/send advance entirely rather than racing it.
  // Cleared by attemptConcurrentSend itself on every path (landed -> the
  // entry is gone from pendingSends via finishSend anyway; anything else ->
  // false, handing the entry straight back to the next tick's normal advance).
  if (entry.concurrentAttemptInFlight) return;
  entry.busy = true;
  try {
    if (!(await tabStillOpen(entry.tabId))) {
      console.warn(`[CCswitchboard] send (${key}): tab ${entry.tabId} is gone, abandoning.`);
      finishSend(key, entry, 'tab-gone');
      return;
    }

    if (entry.phase === 'hold') {
      await advanceHoldPhase(key, entry);
    } else if (entry.phase === 'insert') {
      await advanceInsertPhase(key, entry);
    } else if (entry.phase === 'send') {
      await advanceSendPhase(key, entry);
    }
  } catch (err) {
    console.warn(`[CCswitchboard] send (${key}): step failed, will retry next tick:`, err.message);
  } finally {
    entry.busy = false;
  }
}

// D1 ATOMIC PASTE-AND-SEND: holds delivery -- with ZERO insertion -- while
// Claude is generating a reply, while the input has text (the user composing
// something unrelated), while the input's been empty and idle for less than
// SEND_DELIVERY_SETTLE_MS, or while the send button isn't even present.
// That last one is the proven fix: a hidden/backgrounded tab that renders no
// send button at all used to still get pasted into (send_button_missing only
// showed up AFTER insertion, stranding the text -- see
// reclaimStrandedComposer/handleSendExhausted below for the other half of
// that fix). Now the button's own presence gates the paste itself, so a dead
// composer holds instead of receiving text it can never send. Mirrors the old
// content.js typing-hold state machine, just checked via executeScript
// instead of trusting a listener in the (possibly throttled) tab to notice.
// (D1b: this used to also require sendButtonEnabled pre-insert -- reverted,
// see the comment inside advanceHoldPhase's `held` check for why.)
//
// Fast Flush exception: SEND_DELIVERY_SETTLE_MS exists to give a
// mid-keystroke user a moment to keep typing before their unrelated draft
// gets clobbered -- it has nothing to protect when no keystroke has landed
// in the input at all since this delivery was queued. That case is
// delivered on the very next tick it's not held (one SEND_TICK_MS, not
// SEND_TICK_MS + SEND_DELIVERY_SETTLE_MS), while typedSinceQueued still
// falls through to the full settle wait so an in-progress edit is
// unaffected. (A first attempt at this, commit 307ebae, was reverted the
// same session because the fix appeared to make no difference on retest --
// that retest almost certainly ran against the service worker's pre-edit
// code, since chrome://extensions requires an explicit reload before an
// unpacked MV3 background script picks up new source; nothing in the state
// machine itself explains a residual multi-second delay on this path.)
async function advanceHoldPhase(key, entry) {
  const probe = await execInTab(entry.tabId, ccswInjProbeDelivery, [SEND_TYPING_HOLD_MS]);
  const now = Date.now();
  const typedSinceQueued = !!probe && probe.lastKeystrokeAt >= entry.queuedAt;
  appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'hold-check', typedSinceQueued, ...probe });

  // #19 shape-1: corroborating signal for probe.isGenerating (see
  // HOLD_STALE_CONFIRM_MS and updateActiveGeneration above). Computed on every
  // tick, win or lose, so both the `generating` decision below and the
  // 5-minute-cap re-verify further down use the SAME read of it.
  const heldMs = now - entry.queuedAt;
  const stopButtonPresent = !!probe && probe.isGenerating;
  // The Stop button ALONE no longer counts as generating. It must be
  // corroborated by a live signal -- a growing reply text, a streaming cursor,
  // or aria-busy (all folded into activeGeneration). A Stop button with no live
  // signal is a stale lingering button, so the hold is released. No visibility
  // term enters this decision. A real reply is never cut short because any live
  // signal keeps activeGeneration true (with the HOLD_STALE_CONFIRM_MS flat-text
  // tolerance to bridge inter-token pauses), and SEND_HOLD_TIMEOUT_MS remains
  // the absolute cap.
  const activeGeneration = updateActiveGeneration(entry.tabId, probe);
  const generating = stopButtonPresent && activeGeneration;

  // D1 RECLAIM (trigger 2 of 2, see reclaimStrandedComposer): the composer
  // isn't empty, but its content hashes to the last text WE landed in this
  // tab -- a prior delivery's stranded leftover (its own reclaim attempt
  // never ran, e.g. a worker restart between insert and the D1 fix landing).
  // Clear it and re-probe next tick rather than holding on composer_busy
  // forever, which was exactly the queue-wedging bug this replaces.
  const lastInjected = lastInjectedByTab.get(entry.tabId) ?? null;
  const strandedOurs = !!(probe && probe.inputLen > 0 && lastInjected && probe.composerHash === lastInjected.textHash);
  if (strandedOurs) {
    await reclaimStrandedComposer(entry, lastInjected.key, now - lastInjected.at, lastInjected.textHash);
    return;
  }

  // CONCURRENT-SEND PROBE (flag-gated, see attemptConcurrentSend above): the
  // ONLY thing standing between this entry and delivery right now is that
  // Claude is generating -- try sending it live instead of holding for a
  // gap. Scoped tightly to that one reason (composer genuinely empty, no
  // recent user keystroke, send button present) so this never touches an
  // entry that would have held for a DIFFERENT reason anyway (composer_busy,
  // user_typing, send_button_missing all fall through to the unchanged
  // `held` handling below exactly as before). Fires at most once per entry
  // (concurrentAttempted). Detached from this tick on purpose -- see
  // attemptConcurrentSend's own comment for why leaving entry.phase alone
  // and only flagging concurrentAttemptInFlight is what lets the unchanged
  // code below safely take back over on anything short of a confirmed
  // landing; this `held` computation and everything after it runs exactly
  // as it always has, whether or not this branch fires.
  if (
    generating &&
    probe &&
    probe.inputFound &&
    probe.inputEmpty &&
    !probe.recentlyTyped &&
    probe.sendButtonFound &&
    !entry.concurrentAttempted &&
    !entry.concurrentAttemptInFlight &&
    (await getConcurrentSendProbeEnabled())
  ) {
    entry.concurrentAttempted = true;
    attemptConcurrentSend(key, entry, probe).catch((err) => {
      console.warn(`[CCswitchboard] concurrent-send attempt (${key}) errored:`, err.message);
      entry.concurrentAttemptInFlight = false;
    });
  }

  // COMPOSER-READY HARDENING: !probe.inputFound gates insertion on the editable
  // composer ACTUALLY being present, not just proxied through sendButtonFound.
  // The proxy breaks in a re-render race: the send button ([data-testid=
  // "send-button"] or the broad button[aria-label*="Send"]) can linger while the
  // contenteditable composer is momentarily detached during SPA nav / ProseMirror
  // remount, or its contenteditable is toggled to "false" (which makes the
  // div[contenteditable="true"] selectors stop matching, so input is null and
  // inputFound is false). In that state inputEmpty reads true (null input -> ''),
  // recentlyTyped false and sendButtonFound true, so WITHOUT this term the gate
  // released and ccswInjInsertText then found no composer and finishSend'd the
  // delivery as 'no-input' -- a terminal DROP against a transient wrong state.
  // Holding here (non-terminal, re-probed every SEND_TICK_MS) lets a remount
  // settle a tick or two and then deliver cleanly. A missing composer is a
  // system-side reason (inputEmpty true, recentlyTyped false), so holdReasonIsUser
  // stays false and the user-text-sacred / cap logic below is unaffected --
  // identical treatment to send_button_missing.
  const held = !probe || generating || !probe.inputFound || !probe.inputEmpty || probe.recentlyTyped || !probe.sendButtonFound;

  // #19 shape-1 field signal: fires exactly when the corroboration check
  // releases a hold the OLD single-Stop-button rule would still have kept --
  // Stop button present but NO live-generating signal, i.e. a demonstrably
  // stale DOM. This is the "released via corroboration failure" event the fix
  // needs so staleness can be verified in the field. Never gates anything
  // (observe-only); logged once per entry (not every ~200ms tick this holds
  // for) -- one measurement per stale-hold episode is enough. Distinct from
  // the separate 5-minute-cap re-verify below (a park-vs-deliver decision).
  if (probe && !generating && stopButtonPresent && !entry.holdStaleReleaseLogged) {
    entry.holdStaleReleaseLogged = true;
    logDeliveryEvent('hold_stale_release', entry, {
      jobId: entry.jobId,
      key,
      heldMs,
      stopButtonPresent,
      activeGeneration,
      streamingMarkerPresent: probe.streamingMarkerPresent ?? null,
      hidden: probe.hidden ?? null,
    });
  }

  if (held) {
    // The things this gate actually checks, in the order `held` ORs them.
    // More than one can be true at once, so log the full set alongside the
    // primary reason -- "composer_busy AND user_typing" is a different bug
    // from either alone.
    //
    // D1b: deliberately NOT gating on sendButtonEnabled here (D1 did, and
    // that was the bug -- claude.ai disables the send button whenever the
    // composer is EMPTY, which is exactly the state an idle held tab sits in,
    // so every idle tab held forever on send_button_disabled until something
    // else -- e.g. a manual paste -- enabled the button, at which point BOTH
    // the manual send and this queued delivery fired: observed as tripled
    // sends. sendButtonFound still gates insertion (a tab with no send button
    // rendered at all is the genuine hidden-tab dead end this was built for);
    // enabled-ness is only meaningful once there's text to send, so it's
    // checked where it always was pre-D1: post-insert, in advanceSendPhase /
    // ccswInjTryClickSend below.
    const reasons = [];
    if (!probe) reasons.push('probe_failed');
    else {
      if (generating) reasons.push('completion_running');
      if (!probe.inputFound) reasons.push('composer_missing');
      if (!probe.inputEmpty) reasons.push('composer_busy');
      if (probe.recentlyTyped) reasons.push('user_typing');
      if (!probe.sendButtonFound) reasons.push('send_button_missing');
    }
    // HOLD PROBE DUMP: the full probe object behind THIS hold decision, sent to
    // the relay debug log. The `held` expression ORs six terms and, until now,
    // only the derived reason strings were ever recorded -- so a delivery stuck
    // on an empty, untouched composer was indistinguishable from any other
    // hold, and the actual stuck field could only be guessed at. (Guessing is
    // how this gate acquired its scar tissue: see the D1b comment below on
    // sendButtonEnabled.) This records every field so the stuck one can be
    // READ off the log instead.
    //
    // Throttled deliberately: this tick runs every SEND_TICK_MS (200ms), so an
    // unthrottled dump would be 5 relay writes per second per held delivery.
    // Logged on the FIRST hold tick, on every change to the reason set, and
    // then at most once per HOLD_PROBE_LOG_INTERVAL_MS -- which is what makes a
    // long stall legible (you get a periodic sample proving it's still stuck on
    // the same field) without drowning the log.
    const reasonSig = reasons.join(',');
    const probeLogDue = entry.holdProbeLoggedAt == null
      || reasonSig !== entry.holdProbeReasonSig
      || now - entry.holdProbeLoggedAt >= HOLD_PROBE_LOG_INTERVAL_MS;

    noteDeliverWait(entry, key, 'hold', reasons[0] ?? 'unknown', {
      reasons,
      heldMs,
      holdTimeoutMs: SEND_HOLD_TIMEOUT_MS,
      lastKeystrokeAt: probe?.lastKeystrokeAt ?? null,
      msSinceKeystroke: probe?.lastKeystrokeAt ? now - probe.lastKeystrokeAt : null,
      sendButtonFound: probe?.sendButtonFound ?? null,
      sendButtonEnabled: probe?.sendButtonEnabled ?? null,
      visibilityState: probe?.visibilityState ?? null,
      hidden: probe?.hidden ?? null,
      hasFocus: probe?.hasFocus ?? null,
      stopButtonPresent,
      activeGeneration,
    });

    // P2 -- CAP SEMANTICS: SEND_HOLD_TIMEOUT_MS bounds STALE-GENERATION holds,
    // NOT a user who is mid-prompt. A hold whose reason is the USER
    // (composer_busy = the box holds their text, or user_typing = a keystroke
    // within the typing-hold window) must not burn the cap clock down --
    // otherwise someone spending over five minutes on a long prompt gets
    // force-delivered over (the exact bug this fix exists for). So the cap is
    // measured against capHoldSince, a clock that RESETS on every user-driven
    // hold tick and only accumulates while the hold reason is system-side
    // (generating / stale Stop button / missing send button / probe failure).
    // heldMs is left untouched for logging (total wall time in hold). Our OWN
    // stranded text was already reclaimed far above (strandedOurs returned), so
    // a non-empty composer here is the user's, never ours.
    const holdReasonIsUser = !!probe && (!probe.inputEmpty || probe.recentlyTyped);
    if (holdReasonIsUser) {
      entry.capHoldSince = null;
    } else if (entry.capHoldSince == null) {
      entry.capHoldSince = now;
    }
    const capElapsed = entry.capHoldSince == null ? 0 : now - entry.capHoldSince;

    // Emitted HERE, after the cap clock has been updated for this tick, so
    // capElapsedMs reflects the decision actually being made rather than the
    // previous tick's value -- on the tick a user resumes typing and the cap
    // clock resets, logging it earlier would have reported the stale
    // accumulated figure. Placed before the cap branch below, which can return.
    if (probeLogDue) {
      entry.holdProbeLoggedAt = now;
      entry.holdProbeReasonSig = reasonSig;
      logDeliveryEvent('hold_probe', entry, {
        key,
        jobId: entry.jobId,
        tabId: entry.tabId,
        reasons,
        heldMs,
        capElapsedMs: capElapsed,
        typedSinceQueued,
        generating,
        stopButtonPresent,
        activeGeneration,
        // The probe verbatim -- every field the `held` expression reads, plus
        // the diagnostic ones. composerHead30 is a 30-char prefix that the
        // probe already truncates; composerHash is a hash, not the text.
        probe: probe ?? null,
      });
    }

    if (capElapsed >= SEND_HOLD_TIMEOUT_MS) {
      // Fix 1 / note 486: deep re-verify instead of an unconditional
      // terminal-park. A stale Stop button must never be the reason a
      // deliverable entry sits parked for good -- so the ONLY thing that can
      // still justify parking here is stopButtonPresent AND activeGeneration
      // both being true right now. Anything else (including every other
      // `held` reason above) proceeds to delivery instead: never send while
      // truly generating is the guard this re-check exists to uphold: it is
      // not a general escape hatch for other stuck reasons.
      const genuinelyGenerating = stopButtonPresent && activeGeneration;
      if (genuinelyGenerating) {
        console.warn(`[CCswitchboard] send (${key}): stale-generation hold exceeded ${SEND_HOLD_TIMEOUT_MS}ms and re-verify confirms generation is still active, giving up so the rest of this tab's queue can advance.`);
        appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'hold-timeout' });
        finishSend(key, entry, 'hold-timeout');
        return;
      }

      // P0 -- #68 USER TEXT IS SACRED, defense in depth. Even at the cap, NEVER
      // release-to-deliver over the user's text. abab5067 turned the
      // pre-existing "always terminal-park at the cap" into "release unless
      // genuinely generating" -- which, for a user who had spent 5+ minutes
      // typing a long prompt, saw not-generating and DELIVERED, letting
      // ccswInjInsertText wipe their draft. Restore the protection precisely:
      // only a genuinely EMPTY, not-recently-typed composer (a stale Stop
      // button with nothing to lose -- abab5067's legitimate intent) may
      // release below. Anything holding the user's text keeps HOLDING instead:
      // the delivery stays OWED in pendingSends (entry.phase is still 'hold')
      // and is re-evaluated every tick -- identical to an ordinary sub-cap
      // composer_busy hold -- so it delivers cleanly the instant the composer
      // frees. Never dropped, never double-delivered. With P2 above this branch
      // is normally unreachable while the user has text (the cap clock never
      // fills); this guard is the belt to P2's braces, holding regardless of
      // any recency timer.
      if (probe && (!probe.inputEmpty || probe.recentlyTyped)) {
        console.warn(`[CCswitchboard] send (${key}): cap reached but composer holds user text -- holding (never delivering over it), delivery stays owed.`);
        appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'hold-cap-user-text', inputEmpty: probe.inputEmpty, recentlyTyped: probe.recentlyTyped });
        logDeliveryEvent('user_text_guard', entry, { key, tabId: entry.tabId, stage: 'cap-hold', heldMs, capElapsed, inputEmpty: probe.inputEmpty, recentlyTyped: probe.recentlyTyped }, true);
        entry.holdClearSince = null;
        return;
      }

      console.warn(`[CCswitchboard] send (${key}): stale-generation hold exceeded ${SEND_HOLD_TIMEOUT_MS}ms but re-verify found no active generation and composer is empty -- releasing instead of parking.`);
      appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'hold-stale-release', stopButtonPresent, activeGeneration });
      logDeliveryEvent('hold_stale_release', entry, { jobId: entry.jobId, key, heldMs, capElapsed, stopButtonPresent, activeGeneration });
      noteDeliverRelease(entry, key, 'hold', { path: 'stale-release' });
      if (entry.speakPhrase) {
        execInTab(entry.tabId, ccswInjSpeak, [entry.speakPhrase]).catch(() => {});
      }
      enterInsertPhase(key, entry);
      return;
    }
    entry.holdClearSince = null;
    return;
  }

  // Not held any more -- the cap clock is only meaningful while a hold is
  // system-stalled, so clear it here so a future re-hold starts a fresh window
  // rather than inheriting a stale timestamp from an earlier stall.
  entry.capHoldSince = null;

  if (!typedSinceQueued) {
    console.log(`[CCswitchboard] send (${key}): input untouched since queued, delivering immediately.`);
    appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'hold-cleared-untouched' });
    noteDeliverRelease(entry, key, 'hold', { path: 'untouched' });
    if (entry.speakPhrase) {
      execInTab(entry.tabId, ccswInjSpeak, [entry.speakPhrase]).catch(() => {});
    }
    enterInsertPhase(key, entry);
    return;
  }

  if (entry.holdClearSince === null) {
    entry.holdClearSince = now;
    return;
  }
  if (now - entry.holdClearSince < SEND_DELIVERY_SETTLE_MS) {
    // Not "held" any more, but still not delivering: riding out
    // SEND_DELIVERY_SETTLE_MS so a mid-edit user isn't clobbered. Short-lived
    // in the healthy case; logged because a settle window that keeps being
    // restarted (holdClearSince reset by a fresh keystroke) looks exactly
    // like a wedge from the pill's point of view.
    noteDeliverWait(entry, key, 'hold', 'settle_wait', {
      settledMs: now - entry.holdClearSince,
      settleTargetMs: SEND_DELIVERY_SETTLE_MS,
    });
    return;
  }

  console.log(`[CCswitchboard] send (${key}): hold cleared, delivering.`);
  noteDeliverRelease(entry, key, 'hold', { path: 'settled' });
  if (entry.speakPhrase) {
    execInTab(entry.tabId, ccswInjSpeak, [entry.speakPhrase]).catch(() => {});
  }
  enterInsertPhase(key, entry);
}

// D3 QUEUE COALESCING: when the head clears the hold-phase gate above and
// other entries are waiting behind it for the SAME tab, fold them into one
// combined send instead of making each wait through its own hold/insert/send
// cycle -- they share one composer, so N separate round trips just meant N
// times the click/verify latency for no benefit. Solo case (nothing else
// queued, or everything else already over BATCH_MAX_CHARS) is unchanged: no
// divider, no batchKeys, entry.text goes in exactly as it did pre-D3.
const BATCH_MAX_CHARS = 30 * 1024;

function formatBatchSegment(key, entry) {
  const text = typeof entry.text === 'string' ? entry.text : '';
  return `--- ${humanizeKind(entry.kind)} (${key}) ---\n${text}`;
}

// Folds every other same-tab entry still sitting untouched in 'hold' (i.e.
// never individually gated -- only the head is ever advanced, see
// queueHeadsByTab) into headEntry's own text, respecting BATCH_MAX_CHARS.
// Entries that would push the combined payload over the cap are simply left
// out -- they stay queued and get reconsidered on the next flush, never
// dropped or truncated mid-message. Map iteration is insertion order, so
// this naturally preserves queue order.
function composeBatchForHead(headKey, headEntry) {
  const segments = [formatBatchSegment(headKey, headEntry)];
  let total = segments[0].length;
  const keys = [];
  for (const [key, entry] of pendingSends) {
    if (key === headKey || entry.tabId !== headEntry.tabId) continue;
    // Only entries that haven't been individually held/advanced for a
    // reason of their own are eligible -- a future per-entry pause/skip flag
    // would be checked here too; today 'hold' is the only phase a non-head
    // entry can be in.
    if (entry.phase !== 'hold') continue;
    const seg = formatBatchSegment(key, entry);
    if (total + seg.length + 2 > BATCH_MAX_CHARS) continue; // '\n\n' join
    segments.push(seg);
    total += seg.length + 2;
    keys.push(key);
  }
  return { text: segments.join('\n\n'), keys };
}

// Fix 2 / note 486: identity+status only, appended after the delivered body
// so the dispatching Claude can see what ELSE is still queued for its own
// tab instead of only ever seeing one delivery at a time and acting as if it
// were the last thing outstanding (see composeManifestForHead below).
const MANIFEST_COLLAPSE_THRESHOLD = 6;
const MANIFEST_SHORTNAME_MAX = 16;

function manifestShortName(entry) {
  const raw = entry.label || humanizeKind(entry.kind);
  const s = String(raw);
  return s.length > MANIFEST_SHORTNAME_MAX ? `${s.slice(0, MANIFEST_SHORTNAME_MAX - 3)}...` : s;
}

// Phase 1 finding: every other same-tab entry sits in phase:'hold' (only the
// head ever advances -- see composeBatchForHead's own comment), so
// deliverWaitReason is only ever populated on whichever entry IS the head.
// Checked here anyway, defensively, in case that ever stops being true.
// kind:'wake' is the one kind that represents an already-finished job's
// result (see PENDING_KIND_LABELS), so it alone reads as "result-ready";
// everything else queued behind the head is just that -- queued.
function manifestStatusFor(entry) {
  if (entry.deliverWaitReason) return `held(${humanizeWaitReason(entry.deliverWaitReason, entry.deliverWaitExtra)})`;
  if (entry.kind === 'wake') return 'result-ready';
  return 'queued-behind-head';
}

function manifestIdFor(key, entry) {
  return entry.jobId != null ? entry.jobId : key;
}

// Builds the <CCSW pending: ...> tail for headEntry's tab: every pendingSends
// entry sharing its tabId, MINUS excludeKeys (the entries actually being
// delivered in THIS send -- the head plus whatever composeBatchForHead just
// folded in). Identity + status only -- NEVER any result/body text, so this
// stays cheap and safe to build on every send. Returns null when nothing is
// left over (the normal case: one delivery in, nothing else queued).
function composeManifestForHead(headEntry, excludeKeys) {
  const others = [];
  for (const [key, entry] of pendingSends) {
    if (excludeKeys.has(key) || entry.tabId !== headEntry.tabId) continue;
    others.push({ key, entry });
  }
  if (others.length === 0) return null;

  let body;
  if (others.length > MANIFEST_COLLAPSE_THRESHOLD) {
    const oldest = manifestIdFor(others[0].key, others[0].entry);
    const newest = manifestIdFor(others[others.length - 1].key, others[others.length - 1].entry);
    const readyCount = others.filter(({ entry }) => manifestStatusFor(entry) === 'result-ready').length;
    body = `${others.length} items -- oldest ${oldest}, newest ${newest}, ${readyCount} results ready`;
  } else {
    body = others
      .map(({ key, entry }) => `${manifestIdFor(key, entry)} ${manifestShortName(entry)}·${manifestStatusFor(entry)}`)
      .join(' | ');
  }
  return { text: `\n\n⟨CCSW pending: ${body}⟩`, count: others.length };
}

// Transitions a cleared head into 'insert', composing a batch first when
// other entries are waiting behind it. batchKeys/batchedText live only on
// the head entry for the lifetime of this one combined send -- cleared by
// handleSendExhausted's requeue branch on retry, and irrelevant once
// finishSend deletes the head entry on any terminal outcome.
function enterInsertPhase(key, entry) {
  entry.batchKeys = undefined;
  entry.batchedText = undefined;
  entry.manifestTail = undefined;
  const hasOtherQueued = [...pendingSends.values()].some(
    (other) => other !== entry && other.tabId === entry.tabId && other.phase === 'hold',
  );
  if (hasOtherQueued) {
    const { text, keys } = composeBatchForHead(key, entry);
    if (keys.length > 0) {
      entry.batchKeys = keys;
      entry.batchedText = text;
      const batchedKeys = [key, ...keys];
      logDeliveryEvent('deliver_attempt', entry, {
        key,
        kind: entry.kind ?? null,
        batched: true,
        batchedKeys,
        batchSize: batchedKeys.length,
        combinedLen: text.length,
      });
    }
  }

  // Fix 2 / note 486: whatever's still in pendingSends for this tab once the
  // batch above is excluded is NOT part of this delivery -- tell the
  // dispatching Claude so it doesn't act one-behind on it.
  const excludeKeys = new Set([key, ...(entry.batchKeys ?? [])]);
  const manifest = composeManifestForHead(entry, excludeKeys);
  if (manifest) {
    entry.manifestTail = manifest.text;
    logDeliveryEvent('manifest_appended', entry, { key, tabId: entry.tabId, count: manifest.count }, true);
  }

  entry.phase = 'insert';
}

async function advanceInsertPhase(key, entry) {
  // D3: a composed batch inserts its combined text instead of entry's own --
  // batchedText is only ever set by enterInsertPhase, and only for the head.
  // manifestTail (Fix 2 / note 486) is appended on top regardless -- it's set
  // independently of whether a batch happened.
  //
  // The board footer goes last, after the manifest. The two are NOT redundant:
  // the manifest lists this TAB's other queued pendingSends entries (deliveries
  // waiting their turn behind this one), while the footer lists this THREAD's
  // owed JOBS by name and state -- including running jobs, which have no
  // pendingSends entry at all, and repo-busy drops, which background.js never
  // sees. Fetched here rather than in enterInsertPhase because that one is
  // synchronous; this is already the async step that talks to the tab.
  //
  // A batch carries the head's result AND every member's, so all of them are
  // answered by this one insert -- entry.jobId alone would leave the members
  // listed as owed in the message delivering them. batchKeys is set by
  // enterInsertPhase, which always runs before this.
  const deliveringJobIds = [
    entry.jobId,
    ...(entry.batchKeys ?? []).map((batchKey) => pendingSends.get(batchKey)?.jobId),
  ];
  const statusFooter = await fetchStatusFooter(entry.tabId, deliveringJobIds);
  const textToInsert = (entry.batchedText ?? entry.text) + (entry.manifestTail ?? '') + statusFooter;

  // `key` doubles as this delivery's context marker -- ccswInjInsertText
  // stamps it onto window once text actually lands, and the send-phase
  // checks below (ccswInjTryClickSend/ccswInjTryEnterSend/ccswInjCheckCleared)
  // refuse to trust the input unless that marker is still present, which a
  // reload always wipes. See restartAfterContextLoss.
  // #68 P1: hand the insert primitive our own last-injected hash so it can tell
  // "clear our stranded leftover" apart from "wipe the user's draft" even if the
  // tab's in-document marker was lost to a worker restart. Default (no clobber
  // flag) means the primitive protects any user text it finds.
  const expectedHash = lastInjectedByTab.get(entry.tabId)?.textHash ?? null;
  const result = await execInTab(entry.tabId, ccswInjInsertText, [textToInsert, key, expectedHash]);
  appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'insert', batched: !!entry.batchKeys, ...result });
  if (!result?.ok) {
    if (result?.reason === 'composer-has-user-text') {
      // #68 USER TEXT IS SACRED -- P1: the insert primitive refused to clear a
      // composer holding the USER's text (not our own stranded insert). This is
      // a NON-terminal failure: the delivery stays OWED. Bounce it back to
      // 'hold' so the normal hold gate (including the P0 user-text-sacred cap
      // guard and P2 cap exemption) re-evaluates every tick and delivers only
      // once the composer is genuinely free. The entry remains the single owed
      // record in pendingSends / activeDeliveryJobs, so this can never drop the
      // result and never double-deliver. Clear the batch/manifest composed for
      // this aborted attempt -- enterInsertPhase recomposes them fresh next time.
      console.warn(`[CCswitchboard] send (${key}): composer holds user text -- deferring insert, keeping delivery owed.`);
      appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'insert-deferred-user-text', composerHash: result.composerHash ?? null });
      logDeliveryEvent('user_text_guard', entry, { key, tabId: entry.tabId, stage: 'insert-abort', composerHash: result.composerHash ?? null }, true);
      entry.batchKeys = undefined;
      entry.batchedText = undefined;
      entry.manifestTail = undefined;
      entry.phase = 'hold';
      entry.holdClearSince = null;
      return;
    }
    console.warn(`[CCswitchboard] send (${key}): no chat input found in tab ${entry.tabId}, giving up.`);
    finishSend(key, entry, 'no-input');
    return;
  }
  if (result.landed) {
    // The moment our text actually landed in this tab's composer -- see
    // lastInjectedByTab's own comment for why this is recorded. `payload`
    // (#62) carries what queueSend would need to re-queue this exact
    // delivery -- see runStrandedSentinelSweep's auto-heal, which fires with
    // no pendingSends entry left to read entry.* from.
    const text = typeof textToInsert === 'string' ? textToInsert : '';
    // #72B FIX A: use the DOM-based hash ccswInjInsertText just computed and
    // returned (result.textHash), not a fresh source-string hash -- this is
    // the same value window.__ccswSendMarkerHash was set to in-tab, so every
    // later comparison against lastInjectedByTab's textHash (strandedOurs,
    // reclaim's expectedHash) stays DOM-vs-DOM instead of DOM-vs-source.
    lastInjectedByTab.set(entry.tabId, {
      key, textHash: result.textHash, len: text.length, at: Date.now(),
      payload: {
        jobId: entry.jobId ?? null, thread: entry.thread ?? null, kind: entry.kind ?? null,
        text, speakPhrase: entry.speakPhrase ?? null, label: entry.label ?? null, queuedAt: entry.queuedAt ?? null,
      },
    });
  }
  console.log(`[CCswitchboard] send (${key}): text inserted, moving to send phase.`);
  entry.phase = 'send';
  entry.subPhase = 'find-button';
  entry.attempt = 1;
  entry.enterFallbackTried = false;
  entry.awaitingClickClearCheck = false;
  entry.enterEscalated = false;
  entry.stageStartedAt = Date.now();
}

// Called when a send-phase check reports contextLost: the page reloaded (or
// otherwise navigated) since this delivery's text was inserted, so window.
// __ccswSendMarker no longer matches and whatever's now sitting in the input
// isn't ours. Before this existed, that fresh empty input was indistinguishable
// from "Claude cleared it after sending" (ccswInjCheckCleared would report
// cleared:true) or from "no button will ever enable" (ccswInjTryClickSend
// stuck retrying against a permanently-empty box) -- the former silently
// ACKed a message that never sent, the latter silently burned through
// SEND_MAX_ATTEMPTS and required a manual resend. Re-typing from 'insert'
// (which itself clears any stray leftover first) is the correct recovery in
// both cases. Bounded by SEND_MAX_CONTEXT_LOST_RETRIES so a tab stuck in a
// reload loop still reaches a terminal outcome instead of retyping forever.
function restartAfterContextLoss(key, entry) {
  entry.contextLostRetries += 1;
  appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'context-lost', attempt: entry.contextLostRetries });
  ccswDebug('send-context-lost', { key, jobId: entry.jobId, tabId: entry.tabId, attempt: entry.contextLostRetries });
  if (entry.contextLostRetries > SEND_MAX_CONTEXT_LOST_RETRIES) {
    console.warn(`[CCswitchboard] send (${key}): page context reset ${entry.contextLostRetries} times, giving up.`);
    finishSend(key, entry, 'failed');
    return;
  }
  console.warn(`[CCswitchboard] send (${key}): page context reset mid-send (reload?), re-typing from scratch.`);
  entry.phase = 'insert';
  entry.subPhase = null;
  entry.enterFallbackTried = false;
  entry.awaitingClickClearCheck = false;
  entry.enterEscalated = false;
}

// D1 RECLAIM: wipes a composer known (by hash match, see advanceHoldPhase and
// handleSendExhausted) to hold OUR OWN stranded text, so this tab is never
// left dirty by a delivery that gave up on it -- the proven bug where one
// failed send permanently wedged every later entry in this tab's queue on
// composer_busy. `strandedKey` is whichever delivery's text is actually
// sitting there (usually `entry`'s own key, from handleSendExhausted; can be
// a DIFFERENT, already-finished entry's key when triggered from
// advanceHoldPhase's pre-insert probe) -- logged separately from entry's own
// jobId/thread so deliver_reclaim always points at the text that was really
// cleared.
//
// #68 USER TEXT IS SACRED: expectedHash is mandatory and re-verified at the
// DOM side by ccswInjClearComposer itself, immediately before it wipes --
// every caller below has already done its OWN hash check (via composerHash),
// but that check ran in an earlier executeScript round-trip, leaving a race
// window for the user to type in between. When ccswInjClearComposer refuses
// (result.refused), NOTHING was touched: the composer still holds whatever
// mix of our text and the user's is actually sitting there. Callers must
// check the returned refused flag and park (never silently treat it as a
// successful reclaim).
async function reclaimStrandedComposer(entry, strandedKey, ageMs, expectedHash) {
  let result;
  try {
    result = await execInTab(entry.tabId, ccswInjClearComposer, [expectedHash ?? null]);
  } catch (err) {
    result = { cleared: false, error: err?.message ?? String(err) };
  }
  if (result?.refused) {
    console.warn(`[CCswitchboard] send (${strandedKey}): reclaim refused -- composer no longer matches our stranded text, leaving it untouched.`);
    logDeliveryEvent('user_text_guard', entry, { key: strandedKey, tabId: entry.tabId, ageMs, reason: 'hash_mismatch', stage: 'wipe-refused' }, true);
    appendSendLog({ key: strandedKey, jobId: entry.jobId, tabId: entry.tabId, stage: 'reclaim-refused', ageMs });
  } else {
    logDeliveryEvent('deliver_reclaim', entry, { key: strandedKey, tabId: entry.tabId, ageMs, cleared: result?.cleared ?? null }, true);
    appendSendLog({ key: strandedKey, jobId: entry.jobId, tabId: entry.tabId, stage: 'reclaim', ageMs, cleared: result?.cleared ?? null });
  }
  // Whether or not the clear actually landed (or was refused), this tab no
  // longer has a KNOWN stranded delivery -- a residual dirty composer now
  // reads as plain composer_busy on the next probe instead of retriggering
  // reclaim every 200ms tick.
  lastInjectedByTab.delete(entry.tabId);
  return result;
}

// Called when advanceSendPhase's attempt ladder (find-button/await-clear)
// exhausts SEND_MAX_ATTEMPTS with entry's own marker still intact -- i.e. our
// text really is sitting there, unsent. Before this existed, that path went
// straight to finishSend('failed'), which left the composer dirty (the other
// half of tonight's proven bug: stranded text then blocks the queue forever)
// and could also be a FALSE failure -- see #46b: a manual click/Enter this
// polling loop simply raced past would clear the composer between polls, and
// the old code reported 'failed' (no ACK, visible escalation) even though the
// message genuinely reached Claude. So this checks the composer's actual
// live state first: already clear -> treat as a real 'sent' (ACKs normally,
// wake path included, via finishSend's own outcome==='sent' branch); still
// dirty -> reclaim it and return the payload to the queue head (bounded by
// SEND_MAX_RECLAIM_RETRIES so a structurally dead composer still reaches a
// terminal outcome instead of reclaim-requeuing forever).
async function handleSendExhausted(key, entry) {
  const cleared = await execInTab(entry.tabId, ccswInjCheckCleared, [key]).catch(() => null);
  if (cleared?.cleared && !cleared.contextLost) {
    console.log(`[CCswitchboard] send (${key}): attempt ladder exhausted but composer was already clear -- treating as sent.`);
    appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'exhausted-already-clear' });
    finishBatchedSend(key, entry, 'sent');
    return;
  }

  entry.reclaimAttempts = (entry.reclaimAttempts ?? 0) + 1;
  const last = lastInjectedByTab.get(entry.tabId) ?? null;
  const ageMs = last ? Date.now() - last.at : null;
  const reclaimResult = await reclaimStrandedComposer(entry, key, ageMs, last?.textHash ?? null);

  // #68 USER TEXT IS SACRED: the composer no longer holds provably-ours text
  // (someone typed into/over it while our attempt ladder was burning through
  // SEND_MAX_ATTEMPTS) -- the reclaim above refused to touch it. Park loudly
  // instead of looping back into 'hold', which would just retry the same
  // dead end.
  if (reclaimResult?.refused) {
    console.warn(`[CCswitchboard] send (${key}): composer holds user text, not ours -- holding back instead of sending/wiping.`);
    finishSend(key, entry, 'user-text-guard');
    return;
  }

  if (entry.reclaimAttempts > SEND_MAX_RECLAIM_RETRIES) {
    console.warn(`[CCswitchboard] send (${key}): reclaimed ${entry.reclaimAttempts} times, giving up.`);
    // D3: only the head itself is parked here -- any other entries this
    // attempt had batched in (entry.batchKeys) were never removed from
    // pendingSends in the first place (only the head is ever inserted/sent),
    // so "returning them to the queue" needs no extra step: they're already
    // there, untouched, and simply become the next head once this one's
    // finishSend below deletes it -- no double broadcast, since nothing about
    // their own pending state ever changed.
    finishSend(key, entry, 'failed');
    return;
  }

  console.warn(`[CCswitchboard] send (${key}): send exhausted, reclaimed composer, returning to queue head (reclaim attempt ${entry.reclaimAttempts}).`);
  appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'reclaimed-requeued', reclaimAttempts: entry.reclaimAttempts });
  entry.phase = 'hold';
  entry.subPhase = null;
  entry.holdClearSince = null;
  entry.attempt = 0;
  entry.enterFallbackTried = false;
  entry.awaitingClickClearCheck = false;
  entry.enterEscalated = false;
  entry.contextLostRetries = 0;
  entry.stageStartedAt = 0;
  entry.nextAttemptAt = 0;
  // D3: the reclaimed composer no longer holds batchedText, and any member
  // keys folded in last time are still sitting in pendingSends exactly as
  // they were -- enterInsertPhase recomposes a fresh batch (possibly the
  // same members, possibly joined by whatever else queued up meanwhile) once
  // this head clears the hold gate again.
  entry.batchKeys = undefined;
  entry.batchedText = undefined;
}

// #68 USER TEXT IS SACRED: called from advanceSendPhase when ccswInjTryClickSend
// or ccswInjTryEnterSend reports guardBlocked -- a keystroke landed (or the
// composer hash no longer matches) in the gap between insert and this send
// attempt. hashMatches distinguishes the two outcomes the principle demands:
//   - hashMatches true: the composer still holds EXACTLY what we inserted (the
//     keystroke didn't change it, e.g. typed-then-undone) -- safe to reclaim
//     and requeue like any other stranded-ours case, bounded by
//     SEND_MAX_RECLAIM_RETRIES same as handleSendExhausted.
//   - hashMatches false: the composer holds something else now -- mixed
//     content, or purely the user's own words. NEVER click, NEVER wipe. Park
//     the delivery loudly (pill: 'held back -- your text is in the box') and
//     let the user's own composer stand exactly as they left it.
async function handleUserTextGuard(key, entry, reason, hashMatches) {
  logDeliveryEvent('user_text_guard', entry, { key, reason, tabId: entry.tabId, stage: entry.subPhase ?? null }, true);
  appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'user-text-guard', reason });

  if (!hashMatches) {
    console.warn(`[CCswitchboard] send (${key}): held back -- composer no longer matches our inserted text (${reason}).`);
    finishSend(key, entry, 'user-text-guard');
    return;
  }

  entry.reclaimAttempts = (entry.reclaimAttempts ?? 0) + 1;
  const last = lastInjectedByTab.get(entry.tabId) ?? null;
  const ageMs = last ? Date.now() - last.at : null;
  const reclaimResult = await reclaimStrandedComposer(entry, key, ageMs, last?.textHash ?? null);

  if (reclaimResult?.refused || entry.reclaimAttempts > SEND_MAX_RECLAIM_RETRIES) {
    console.warn(`[CCswitchboard] send (${key}): user-text-guard reclaim ${reclaimResult?.refused ? 'refused' : 'exhausted'}, giving up.`);
    finishSend(key, entry, 'user-text-guard');
    return;
  }

  console.warn(`[CCswitchboard] send (${key}): user-text-guard tripped mid-send, reclaimed composer, returning to queue head (reclaim attempt ${entry.reclaimAttempts}).`);
  appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'reclaimed-requeued', reclaimAttempts: entry.reclaimAttempts });
  entry.phase = 'hold';
  entry.subPhase = null;
  entry.holdClearSince = null;
  entry.attempt = 0;
  entry.enterFallbackTried = false;
  entry.awaitingClickClearCheck = false;
  entry.enterEscalated = false;
  entry.contextLostRetries = 0;
  entry.stageStartedAt = 0;
  entry.nextAttemptAt = 0;
  entry.batchKeys = undefined;
  entry.batchedText = undefined;
}

// #62 STRANDED SENTINEL: covers the gap D1's reclaim (advanceHoldPhase/
// handleSendExhausted above) doesn't -- both of those only run while a
// pendingSends entry for the tab is actually being advanced. If a delivery
// somehow reaches a terminal outcome (finishSend already ran, entry deleted)
// while STILL leaving our text sitting in the composer, nothing is left in
// the queue to ever notice. This sweep (piggybacked onto the TAB_HEARTBEAT_MS
// interval, see reregisterThreads' setInterval) independently re-checks every
// tab lastInjectedByTab knows about, with no dependency on a live entry.
const STRANDED_SENTINEL_INTERVAL_MS = 30 * 1000;
const STRANDED_SENTINEL_MIN_AGE_MS = 60 * 1000;
const STRANDED_SENTINEL_COOLDOWN_MS = 5 * 60 * 1000;

// tabId -> Date.now() of the last auto-heal for that tab -- caps auto-heal to
// once per STRANDED_SENTINEL_COOLDOWN_MS so a structurally-broken tab (one
// that will always leave stranded text, e.g. a genuinely dead composer) can't
// reclaim-and-requeue in an endless loop; past the cap this sweep still
// detects and logs (and pills), it just stops auto-healing.
const strandedAutoHealAt = new Map();

// Same wire shape pendingEntryPayload returns, built from lastInjectedByTab's
// stashed payload since there is no live pendingSends entry to read here.
function strandedPillPayload(key, payload, healed) {
  return {
    key,
    kind: payload?.kind ?? null,
    kindLabel: humanizeKind(payload?.kind),
    jobId: payload?.jobId ?? null,
    thread: payload?.thread ?? null,
    label: payload?.label ?? null,
    preview: truncatePreview(payload?.text),
    state: 'parked',
    waitReasonHuman: null,
    parkReasonHuman: healed ? 'stranded output detected -- reclaiming' : 'stranded again -- see log',
    queuedAt: payload?.queuedAt ?? null,
  };
}

async function runStrandedSentinelSweep() {
  for (const [tabId, lastInjected] of lastInjectedByTab) {
    // A live delivery for this tab already gets D1's own reclaim check
    // (advanceHoldPhase) every 200ms tick -- only a tab with NOTHING queued
    // is this sweep's job.
    if (countQueueDepthForTab(tabId) > 0) continue;

    const ageMs = Date.now() - lastInjected.at;
    if (ageMs < STRANDED_SENTINEL_MIN_AGE_MS) continue;

    let probe;
    try {
      probe = await execInTab(tabId, ccswInjProbeDelivery, [SEND_TYPING_HOLD_MS]);
    } catch {
      continue; // tab unreachable -- chrome.tabs.onRemoved cleans lastInjectedByTab up separately
    }
    const strandedOurs = !!(probe && probe.inputLen > 0 && probe.composerHash === lastInjected.textHash);
    if (!strandedOurs) continue;

    const pseudoEntry = { tabId, jobId: lastInjected.payload?.jobId ?? null, thread: lastInjected.payload?.thread ?? null };
    const lastHeal = strandedAutoHealAt.get(tabId) ?? 0;
    const withinCooldown = Date.now() - lastHeal < STRANDED_SENTINEL_COOLDOWN_MS;

    logDeliveryEvent('stranded_detected', pseudoEntry, {
      key: lastInjected.key,
      tabId,
      ageMs,
      queueDepth: countQueueDepthForTab(tabId),
      composerLen: probe.inputLen,
      entryStateIfKnown: pendingSends.has(lastInjected.key) ? 'pending' : recentTerminalSends.has(lastInjected.key) ? 'parked' : 'unknown',
      autoHealing: !withinCooldown,
    }, true);

    // So the pill's own "Send now" button (requestPendingRedeliver) has
    // something to redeliver even if this is the rate-limited log-only path
    // (no auto-heal below to requeue it another way) -- same cache finishSend
    // populates for every ordinary parked pill.
    recentTerminalSends.set(lastInjected.key, {
      tabId,
      jobId: lastInjected.payload?.jobId ?? null,
      thread: lastInjected.payload?.thread ?? null,
      kind: lastInjected.payload?.kind ?? null,
      text: lastInjected.payload?.text ?? null,
      speakPhrase: lastInjected.payload?.speakPhrase ?? null,
      label: lastInjected.payload?.label ?? null,
      at: Date.now(),
    });

    broadcastQueueStateForTab(tabId, strandedPillPayload(lastInjected.key, lastInjected.payload, !withinCooldown));

    if (withinCooldown) {
      console.warn(`[CCswitchboard] stranded sentinel: tab ${tabId} stranded again within cooldown, logging only.`);
      continue;
    }

    strandedAutoHealAt.set(tabId, Date.now());
    console.warn(`[CCswitchboard] stranded sentinel: tab ${tabId} has stranded output (age ${ageMs}ms), reclaiming and requeuing.`);
    const reclaimResult = await reclaimStrandedComposer(pseudoEntry, lastInjected.key, ageMs, lastInjected.textHash);

    // #68 USER TEXT IS SACRED: the composer changed between this sweep's own
    // probe (strandedOurs check above) and the reclaim's DOM-side re-check --
    // the user typed into it in that gap. Do not requeue: requeuing here would
    // re-run this exact payload's delivery over content we just confirmed
    // isn't (only) ours anymore.
    if (reclaimResult?.refused) {
      console.warn(`[CCswitchboard] stranded sentinel: tab ${tabId} reclaim refused -- composer holds user text, skipping auto-heal requeue.`);
      continue;
    }

    if (lastInjected.payload) {
      // #72/#74 STAGE 2: no force flag here -- this is an AUTOMATIC heal, not
      // a human clicking redeliver, so it must defer to queueSend's own
      // already-delivered check same as any other auto path. Previously this
      // requeued unconditionally with no delivered check at all.
      queueSend(lastInjected.key, {
        tabId,
        jobId: lastInjected.payload.jobId,
        thread: lastInjected.payload.thread,
        kind: lastInjected.payload.kind,
        text: lastInjected.payload.text,
        speakPhrase: lastInjected.payload.speakPhrase,
        label: lastInjected.payload.label,
      });
    }
  }
}

// Mirrors the old injectWakePrompt's attempt loop: each of up to
// SEND_MAX_ATTEMPTS attempts waits up to SEND_BUTTON_WAIT_TIMEOUT_MS for an
// enabled send button, clicks it, then waits up to SEND_VERIFY_TIMEOUT_MS to
// confirm the input actually cleared -- backing off between attempts if
// either wait times out, since claude.ai occasionally leaves the input
// filled with no message sent.
async function advanceSendPhase(key, entry) {
  const now = Date.now();

  if (entry.subPhase === 'backoff') {
    if (now < entry.nextAttemptAt) return;
    entry.attempt += 1;
    entry.enterFallbackTried = false;
    if (entry.attempt > SEND_MAX_ATTEMPTS) {
      await handleSendExhausted(key, entry);
      return;
    }
    entry.subPhase = 'find-button';
    entry.stageStartedAt = now;
    return;
  }

  if (entry.subPhase === 'find-button') {
    // #72B ENTER ESCALATION (job 1838): a click that reported clicked:true
    // but left the composer holding our own marker hash unchanged one
    // attempt later means the click event landed with no effect -- proven to
    // happen in hidden/backgrounded tabs, where five straight clicked:true
    // attempts never cleared the composer and the timeout-based Enter
    // fallback below never fires because the button DOES report enabled.
    // Read-only probe (ccswInjProbeDelivery never clicks/focuses/touches the
    // marker), so this is safe to run without perturbing a live delivery --
    // same stillOurs pattern as the stranded-composer checks elsewhere.
    if (entry.awaitingClickClearCheck) {
      entry.awaitingClickClearCheck = false;
      const probe = await execInTab(entry.tabId, ccswInjProbeDelivery, [SEND_TYPING_HOLD_MS]).catch(() => null);
      const last = lastInjectedByTab.get(entry.tabId) ?? null;
      const stillOurs = !!(probe && probe.inputLen > 0 && last && probe.composerHash === last.textHash);
      appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'click-not-cleared-check', attempt: entry.attempt, stillOurs });
      if (stillOurs) {
        console.warn(`[CCswitchboard] send (${key}): attempt ${entry.attempt}: previous click reported clicked but composer never cleared -- escalating to Enter.`);
        entry.enterEscalated = true;
      }
    }

    if (entry.enterEscalated) {
      const result = await execInTab(entry.tabId, ccswInjTryEnterSend, [key]);
      appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'find-button-escalated', attempt: entry.attempt, ...result });
      if (result?.contextLost) {
        restartAfterContextLoss(key, entry);
        return;
      }
      if (result?.guardBlocked) {
        await handleUserTextGuard(key, entry, result.guardReason, result.hashMatches);
        return;
      }
      if (result?.dispatched) {
        console.log(`[CCswitchboard] send (${key}): attempt ${entry.attempt}: dispatched escalated Enter.`);
        noteDeliverRelease(entry, key, 'send', { path: 'enter', attempt: entry.attempt, escalated: true });
        entry.subPhase = 'await-clear';
        entry.stageStartedAt = now;
        return;
      }

      // Escalated Enter couldn't even find an input this tick -- fall back
      // to the same backoff/exhausted ladder the click path uses below,
      // rather than adding a separate timeout track for this path.
      noteDeliverWait(entry, key, 'send', 'enter_escalate_no_input', {
        attempt: entry.attempt,
        stageMs: now - entry.stageStartedAt,
        visibilityState: result?.visibilityState ?? null,
        hidden: result?.hidden ?? null,
        hasFocus: result?.hasFocus ?? null,
      });
      if (entry.attempt >= SEND_MAX_ATTEMPTS) {
        await handleSendExhausted(key, entry);
        return;
      }
      entry.subPhase = 'backoff';
      entry.nextAttemptAt = now + backoffForAttempt(entry.attempt);
      return;
    }

    const result = await execInTab(entry.tabId, ccswInjTryClickSend, [key]);
    appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'find-button', attempt: entry.attempt, ...result });
    if (result?.contextLost) {
      restartAfterContextLoss(key, entry);
      return;
    }
    if (result?.guardBlocked) {
      await handleUserTextGuard(key, entry, result.guardReason, result.hashMatches);
      return;
    }
    noteClickState(key, entry, {
      buttonFound: result?.buttonFound ?? null,
      buttonEnabled: result ? !!result.buttonFound && !result.buttonDisabled : null,
      composerLen: result?.composerLen ?? null,
    });
    if (result?.clicked) {
      console.log(`[CCswitchboard] send (${key}): attempt ${entry.attempt}: clicked send.`);
      noteDeliverRelease(entry, key, 'send', { path: 'clicked', attempt: entry.attempt });
      entry.subPhase = 'await-clear';
      entry.stageStartedAt = now;
      entry.awaitingClickClearCheck = true;
      return;
    }

    // Text is already in the composer; the send button just isn't enabled yet.
    // Distinct from the hold-phase gate, hence phase:'send' -- this one burns
    // the button-wait timeout then falls through to the Enter fallback and the
    // backoff/retry ladder below.
    //
    // #19 shape-1 secondary: when the button is found-yet-disabled AND our text
    // is already in the composer, a stalled hidden-tab render will not enable it
    // no matter how long we wait -- so escalate to the Enter fallback after the
    // short SEND_BUTTON_STALL_ENTER_MS floor instead of the full
    // SEND_BUTTON_WAIT_TIMEOUT_MS. The send-button-missing case (no button
    // rendered at all) is a different failure mode and keeps the full timeout.
    const buttonStalled = result?.buttonFound === true
      && result?.buttonDisabled === true
      && (result?.composerLen ?? 0) > 0;
    const enterEscalateAfterMs = buttonStalled ? SEND_BUTTON_STALL_ENTER_MS : SEND_BUTTON_WAIT_TIMEOUT_MS;
    noteDeliverWait(entry, key, 'send', result?.buttonFound === false ? 'send_button_missing' : 'send_button_disabled', {
      attempt: entry.attempt,
      buttonFound: result?.buttonFound ?? null,
      buttonDisabled: result?.buttonDisabled ?? null,
      stageMs: now - entry.stageStartedAt,
      buttonWaitTimeoutMs: enterEscalateAfterMs,
      buttonStalled,
      visibilityState: result?.visibilityState ?? null,
      hidden: result?.hidden ?? null,
      hasFocus: result?.hasFocus ?? null,
    });

    if (now - entry.stageStartedAt >= enterEscalateAfterMs) {
      console.warn(`[CCswitchboard] send (${key}): attempt ${entry.attempt}: send button never enabled.`);

      // Before giving up on this attempt, try submitting via a bare Enter
      // keypress on the input instead of the button -- see ccswInjTryEnterSend's
      // comment for why this can succeed even when the button's own
      // enabled-state render appears permanently stuck (the theorized cause
      // of "typed but not sent until the tab is refocused": that render
      // stalls in a hidden/backgrounded tab, but the input's keydown-driven
      // submit handler doesn't depend on it). Tried once per attempt, not
      // every tick, so it doesn't fire redundantly while polling.
      if (!entry.enterFallbackTried) {
        entry.enterFallbackTried = true;
        const fallback = await execInTab(entry.tabId, ccswInjTryEnterSend, [key]);
        appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'enter-fallback', attempt: entry.attempt, ...fallback });
        if (fallback?.contextLost) {
          restartAfterContextLoss(key, entry);
          return;
        }
        if (fallback?.guardBlocked) {
          await handleUserTextGuard(key, entry, fallback.guardReason, fallback.hashMatches);
          return;
        }
        if (fallback?.dispatched) {
          console.log(`[CCswitchboard] send (${key}): attempt ${entry.attempt}: send button never enabled, dispatched Enter as fallback.`);
          noteDeliverRelease(entry, key, 'send', { path: 'enter-fallback', attempt: entry.attempt });
          entry.subPhase = 'await-clear';
          entry.stageStartedAt = now;
          return;
        }
      }

      if (entry.attempt >= SEND_MAX_ATTEMPTS) {
        await handleSendExhausted(key, entry);
        return;
      }
      entry.subPhase = 'backoff';
      entry.nextAttemptAt = now + backoffForAttempt(entry.attempt);
    }
    return;
  }

  if (entry.subPhase === 'await-clear') {
    const result = await execInTab(entry.tabId, ccswInjCheckCleared, [key]);
    appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'await-clear', attempt: entry.attempt, ...result });
    if (result?.contextLost) {
      restartAfterContextLoss(key, entry);
      return;
    }
    if (result?.cleared) {
      console.log(`[CCswitchboard] send (${key}): sent.`);
      finishBatchedSend(key, entry, 'sent');
      return;
    }
    if (now - entry.stageStartedAt >= SEND_VERIFY_TIMEOUT_MS) {
      console.warn(`[CCswitchboard] send (${key}): attempt ${entry.attempt}: input did not clear after click.`);
      if (entry.attempt >= SEND_MAX_ATTEMPTS) {
        await handleSendExhausted(key, entry);
        return;
      }
      entry.subPhase = 'backoff';
      entry.nextAttemptAt = now + backoffForAttempt(entry.attempt);
    }
    return;
  }
}

// #62 TERMINAL-PATH AUDIT: one shared helper, called from finishSend below --
// every entry-ending path in the send state machine (sent/parked/failed,
// handleSendExhausted's exhaustion give-up, its reclaim-cap give-up) funnels
// through finishSend (finishBatchedSend calls it too, for every batched
// member), so hooking it there covers all of them without a separate call
// site per path. Answers "does any path abandon our text?" by re-probing the
// composer at the exact moment this delivery reaches its terminal outcome.
// Fire-and-forget, like every other diagnostic probe in this file -- never
// awaited by finishSend's own (synchronous) callers.
function logEntryTerminal(key, entry, outcome) {
  execInTab(entry.tabId, ccswInjProbeDelivery, [SEND_TYPING_HOLD_MS])
    .then((probe) => {
      const last = lastInjectedByTab.get(entry.tabId) ?? null;
      const composerOursAtEnd = !!(probe && probe.inputLen > 0 && last && probe.composerHash === last.textHash);
      logDeliveryEvent('entry_terminal', entry, {
        key, outcome,
        composerLenAtEnd: probe ? probe.inputLen : null,
        composerOursAtEnd,
      });
    })
    .catch((err) => {
      logDeliveryEvent('entry_terminal', entry, { key, outcome, composerLenAtEnd: null, composerOursAtEnd: null, probeError: err?.message ?? String(err) });
    });
}

// D3: batchInfo is only set when this key rode along in a combined send
// (see finishBatchedSend below) -- { batchedKeys, batchSize } -- and is
// purely additive on the deliver_sent/deliver_fail log line so batching is
// visible in the ring buffer; nothing else in finishSend branches on it.
function finishSend(key, entry, outcome, batchInfo = null) {
  pendingSends.delete(key);
  if (pendingSends.size === 0) stopDeliveryKeepAlive();
  appendSendLog({ key, jobId: entry.jobId, tabId: entry.tabId, stage: 'outcome', outcome, ...(batchInfo ? { batchedKeys: batchInfo.batchedKeys, batchSize: batchInfo.batchSize } : {}) });
  logEntryTerminal(key, entry, outcome);

  // deliver_sent / deliver_fail: the terminal event for this delivery.
  // 'sent' here means the input was verified cleared after the click/Enter,
  // not merely that a click was issued (see the await-clear subPhase).
  // waitedMs is measured from the FIRST time this delivery was gated; queuedMs
  // from when it entered the queue, so a job that was never gated at all still
  // shows how long the whole delivery took.
  {
    const doneAt = Date.now();
    const waitedMs = entry.deliverWaitAt == null ? 0 : doneAt - entry.deliverWaitAt;
    const queuedMs = entry.queuedAt ? doneAt - entry.queuedAt : null;
    const common = {
      key, kind: entry.kind ?? null, waitedMs, queuedMs, attempts: entry.attempt ?? 0,
      contextLostRetries: entry.contextLostRetries ?? 0, reclaimAttempts: entry.reclaimAttempts ?? 0,
      ...(batchInfo ? { batchedKeys: batchInfo.batchedKeys, batchSize: batchInfo.batchSize } : {}),
    };
    if (outcome === 'sent') logDeliveryEvent('deliver_sent', entry, common);
    else logDeliveryEvent('deliver_fail', entry, { ...common, reason: outcome, lastWaitReason: entry.deliverWaitReason ?? null });
  }

  reportDeliveryPending(entry.jobId, false);

  if (outcome === 'sent' && entry.kind === 'advice' && entry.jobId) {
    // Bug #84: an advice send dedupes against its OWN ledger key only. It must
    // NOT run confirmDelivered -- that path acks the relay's job delivered_at
    // and drops the job from the active-delivery registry, which would suppress
    // the job's genuine RESULT wake. Mark just advice:<id> so a duplicate advice
    // resend is refused while the real wake stays completely unaffected.
    // Fire-and-forget like confirmDelivered below -- finishSend is sync.
    markJobDelivered(deliveryLedgerKey('advice', entry.jobId));
  } else if (outcome === 'sent' && entry.jobId) {
    // Note 448 ACK+RETRY: only NOW -- confirmed sent, input verified cleared
    // -- is this job allowed to stop being offered for delivery. See
    // confirmDelivered's own comment for why marking any earlier (e.g. at
    // "status poll saw done") was the actual root cause of the silent-drop bug.
    confirmDelivered(entry.jobId, entry.tabId);
  } else if (outcome === 'sent' && entry.kind === 'repo-free') {
    // Same ack principle as confirmDelivered above, applied to wake.php's
    // repo-lock wakes: only a confirmed-sent delivery acks the relay (POST
    // wake.php {thread, ack:true}) so it deletes the row. wake.php's GET no
    // longer deletes on read -- see its own comment for why an unacked wake
    // (delivery failed, tab closed mid-send, service worker restarted before
    // finishSend ran) must stay queued and be re-offered rather than vanish.
    ackWake(entry.thread, entry.repo);
  } else if (entry.kind === 'wake' && outcome === 'user-text-guard' && entry.jobId) {
    // Bug A fix 1 (STOP THE FALSE DELIVERED-ACK -- the zero-trace loss):
    // user-text-guard means the composer currently holds the USER'S OWN text,
    // not ours -- our payload was blocked/never sent. That is a transient HOLD
    // condition, not a delivered result and not a terminal loss. The old code
    // here called ackDeliveryToRelay (setting the relay's delivered_at) and
    // removeActiveDeliveryJob, which permanently suppressed EVERY backstop --
    // resultWatcherTick, the relay's checkUndeliveredResults, the server nudge
    // -- even though nothing ever landed in chat. That was the single most
    // invisible loss: the relay read "delivered" while the output vanished.
    //
    // Now: leave delivered_at NULL (NO ackDeliveryToRelay) and KEEP the job in
    // the durable active-delivery registry (NO removeActiveDeliveryJob). The
    // next resultWatcherTick re-serves it; the re-served entry re-enters the
    // hold phase and simply HOLDS on composer_busy (advanceHoldPhase never
    // inserts while the box has text) until the user's text clears, then
    // delivers cleanly. Keep retrying, never lose. Deliberately does NOT call
    // markJobDelivered (the payload was never typed) so the dedupe ledger still
    // reflects reality, and deliberately does NOT alertDeliveryLoss -- this is a
    // retry, not a terminal loss, so it must not page. The pill still shows
    // 'held back -- your text is in the box' via the ccsw-send-outcome
    // broadcast below. Reset the failure counter so a later genuine failure
    // starts its escalation fresh (a hold is not a hard failure).
    //
    // (This reverses #72's ff6e4ab terminate-on-guard, which was correct only
    // under the OLD premise that an unbounded re-serve was a bug to be stopped;
    // Bug A reframes it as the intended behaviour -- losing the output is worse
    // than re-serving a job that harmlessly holds until the composer is free.)
    deliveryFailureCounts.delete(entry.jobId);
    logDeliveryEvent('deliver_held_retry', entry, { key, tabId: entry.tabId, reason: outcome }, true);
    ccswDebug('user-text-guard-held-retrying', { jobId: entry.jobId, thread: entry.thread ?? null });
  } else if (entry.kind === 'wake' && (outcome === 'failed' || outcome === 'hold-timeout' || outcome === 'tab-gone' || outcome === 'no-input')) {
    // Auto-triggered job-completion delivery, durably tracked in the
    // active-delivery registry -- route through the counted/escalating
    // Layer 3 handling instead of the old unconditional "Send failed" notice
    // below, so a single quiet hiccup doesn't page Jody but a genuinely
    // stuck delivery still does, loudly, instead of dying silently.
    handleDeliveryFailure(entry, outcome);
  } else if (outcome === 'failed' || outcome === 'hold-timeout' || outcome === 'tab-gone' || outcome === 'no-input' || outcome === 'user-text-guard') {
    // Non-wake deliveries (manual resend/advice, repo-free wake, plan-quiet
    // wake) have no durable retry registry backing them -- unchanged
    // best-effort behaviour from before this pass. #72B FIX D: tab-gone,
    // no-input, and user-text-guard are legitimate park outcomes here too
    // (e.g. a manual advice resend that hit mixed content) -- widened so
    // they land here as benign terminals instead of falling through to the
    // unrouted_outcome assertion below, which is meant for genuinely
    // unhandled outcomes, not these expected non-wake parks.
    logDeliveryEvent('deliver_parked', entry, { key, tabId: entry.tabId, attempts: entry.attempt ?? 0, reason: outcome }, true);
    execInTab(entry.tabId, ccswInjSpeak, [`Send failed for ${entry.label || key}`]).catch(() => {});
  } else {
    // #72 ASSERTION: every terminal path above is enumerated by hand, which
    // is exactly how 'user-text-guard' fell through unnoticed for regression
    // ff6e4ab -- any FUTURE outcome added to the send state machine without a
    // matching arm here would silently repeat that bug (orphaned registry
    // entry, unbounded re-serve). Log it loudly and safe-terminate the
    // registry entry (if any) instead of leaving it to flood quietly.
    logDeliveryEvent('unrouted_outcome', entry, { key, outcome }, true);
    console.error(`[CCswitchboard] finishSend (${key}): unrouted outcome "${outcome}" -- safe-terminating registry entry to avoid an unbounded re-serve.`);
    if (entry.jobId) removeActiveDeliveryJob(entry.jobId);
  }

  // Cosmetic only (toolbar waiting indicator, SW menu) -- the actual send
  // above already happened or definitively failed regardless of whether
  // this reaches content.js.
  chrome.tabs.sendMessage(entry.tabId, { type: 'ccsw-send-outcome', jobId: entry.jobId, outcome }).catch(() => {});

  // D2 DELIVERED/PARKED LIFECYCLE: the pending-delivery pill's own terminal
  // transition. Rides one extra entry along the normal queue-state broadcast
  // (see broadcastQueueStateForTab) rather than a separate message, so
  // content.js never has to guess an outcome from a key silently dropping
  // off the pending list. A non-'sent' outcome also gets stashed for the
  // parked pill's "send now" icon (see the ccsw-pending-redeliver listener
  // above) -- pruned lazily here since finishSend already runs on every
  // terminal delivery, no separate timer needed.
  pruneStaleTerminalSends();
  if (outcome === 'sent') {
    broadcastQueueStateForTab(entry.tabId, pendingEntryPayload(key, entry, 'sent'));
  } else {
    recentTerminalSends.set(key, {
      tabId: entry.tabId,
      jobId: entry.jobId ?? null,
      thread: entry.thread ?? null,
      kind: entry.kind ?? null,
      text: entry.text,
      speakPhrase: entry.speakPhrase ?? null,
      label: entry.label ?? null,
      at: Date.now(),
    });
    broadcastQueueStateForTab(entry.tabId, pendingEntryPayload(key, entry, 'parked', outcome));
  }
}

// D3: fans a combined send's outcome out to every entry it carried. Only
// ever called with outcome 'sent' -- the composer was actually cleared, so
// every folded-in entry's text genuinely reached Claude and each gets its
// own full finishSend completion (ACK, D2 'sent' pill broadcast, session
// history) exactly as if it had been delivered alone. A failed/held combined
// send never reaches here at all (see the two call sites above and
// handleSendExhausted's give-up branch): only the head calls plain
// finishSend, and every member it had batched in is simply left in
// pendingSends, untouched, to be reconsidered -- unbatched -- on the next
// tick, which is what "return to the queue intact" means in practice.
function finishBatchedSend(key, entry, outcome) {
  const memberKeys = entry.batchKeys ?? [];
  if (memberKeys.length === 0) {
    finishSend(key, entry, outcome);
    return;
  }
  const batchedKeys = [key, ...memberKeys];
  const batchInfo = { batchedKeys, batchSize: batchedKeys.length };
  finishSend(key, entry, outcome, batchInfo);
  for (const memberKey of memberKeys) {
    const memberEntry = pendingSends.get(memberKey);
    if (!memberEntry) continue; // already gone (e.g. tab-closed cleanup raced this)
    finishSend(memberKey, memberEntry, outcome, batchInfo);
  }
}

// better-voices guarded helper -- must never throw. betterVoices is only
// defined here if the importScripts at the top of this file succeeded.
function normalizeForSpeech(text) {
  if (typeof betterVoices === 'undefined') return text;
  try {
    return betterVoices.normalize(text, 'webspeech');
  } catch {
    return text;
  }
}

// Builds the same voice-announcement phrase content.js's old
// speakWakeResult used to, for the 'hold cleared, delivering' step above.
function buildWakeSpeechPhrase(jobId, resultText, thread, name, final) {
  const jobLabel = name || `Job ${jobId}`;
  const isError = isErrorResultText(resultText);
  const statusText = isError ? 'Needs input' : 'Done';
  let phrase = thread ? `${statusText} (${thread}) Phase ${jobLabel}` : `${statusText} Phase ${jobLabel}`;
  if (final) {
    phrase += thread ? `. All phases now complete for ${thread}.` : '. All phases now complete.';
  }
  return phrase;
}

// E3 wake loop, note 448 Layer 1 rewrite: a SINGLE persistent watcher
// (resultWatcherTick, set up unconditionally below) polls result.php
// directly for every job in the active-delivery registry, and delivers a
// wake-prompt the moment one shows up done and unACKed. Deliberately NOT one
// setInterval per dispatched job (the old startPolling, removed here) --
// that per-job timer lived only in this service-worker instance's memory, so
// an MV3 worker restart silently dropped it (and the job) with nothing left
// to ever type its result into chat. This version is immune to that: the
// registry lives in chrome.storage.local (survives a restart) and the
// interval below re-establishes itself every time this script loads, exactly
// like pollToolbarJobs/pollWake/pollFocusRequests already do.
//
// Still a plain setInterval rather than chrome.alarms -- see the removed
// startPolling's own comment for that tradeoff, which applies here unchanged.

// Builds and queues a job's wake-prompt for delivery -- shared by
// resultWatcherTick below. Does NOT mark the job delivered; that only
// happens once finishSend's send state machine confirms the send actually
// went through (see confirmDelivered).
function deliverJobResult(jobId, tabId, body) {
  // body.result is CcswAgent's raw stdout from `claude -p --output-format
  // json` -- a whole CC response envelope (session_id, cost_usd, etc.), not
  // just the reply text. Pull out only its "result" field for the
  // wake-prompt. Falls back to the raw string when it's not JSON at all (the
  // agent posts plain "ERROR: ..."/"TIMEOUT: ..."/"LAUNCH-ERROR: ..." strings
  // when claude itself never ran).
  const resultText = extractResultText(body.result);
  // Claude only ever sees this typed prompt text, not the job's terminal
  // status -- an ERROR:/TIMEOUT:/LAUNCH-ERROR: result or a CANCELLED job must
  // say so up front, or Claude reads the raw text as a normal reply and never
  // realizes the run failed/was killed.
  const outcomeLabel = isErrorResultText(resultText) ? 'ERRORED' : isCancelledResultText(resultText) ? 'CANCELLED' : 'finished';
  const prompt = `Job ${jobId} ${outcomeLabel}. Result: ${resultText}`;
  console.log(`[CCswitchboard] result-watcher: job ${jobId} done, delivering to tab ${tabId}.`);
  ccswDebug('deliver-job-result', { jobId, tabId, thread: body.thread });

  notifyJobDone(jobId, tabId, resultText);

  // The message below is UI-only now (toolbar waiting indicator, SW menu
  // status) -- the actual typing/sending is queued into the send state
  // machine above, driven from this worker via chrome.scripting.executeScript
  // regardless of whether tab is focused/visible.
  chrome.tabs.sendMessage(tabId, { type: 'ccsw-wake', jobId, prompt, resultText, thread: body.thread, name: body.name, summary: body.summary, final: !!body.final }).catch((err) => {
    console.warn(`[CCswitchboard] result-watcher: failed to message tab ${tabId} for job ${jobId}'s status update:`, err.message);
  });

  queueSend(`job:${jobId}`, {
    tabId,
    jobId,
    thread: body.thread,
    kind: 'wake',
    text: prompt,
    speakPhrase: normalizeForSpeech(buildWakeSpeechPhrase(jobId, resultText, body.thread, body.name, !!body.final)),
    label: body.name || `Job ${jobId}`,
  });
}

// Guards against this tick overlapping the next one -- same reasoning as the
// old startPolling's tickInFlight, just shared across every active job now
// that they're all polled from one interval instead of one-per-job.
let resultWatcherInFlight = false;

async function resultWatcherTick() {
  if (resultWatcherInFlight) return;
  resultWatcherInFlight = true;
  try {
    const active = await loadActiveDeliveryJobs();
    if (active.length === 0) return;

    await deliveredJobIdsReady;

    await Promise.all(active.map(async (job) => {
      const { jobId, thread } = job;

      if (isJobDelivered(deliveryLedgerKey('wake', jobId))) {
        await removeActiveDeliveryJob(jobId);
        return;
      }
      if (pendingSends.has(`job:${jobId}`)) return; // already in flight this instance -- don't re-trigger

      let body;
      try {
        const res = await ccswFetch(`${RELAY_RESULT_FILE}?id=${jobId}`, { method: 'GET' });
        body = await res.json().catch(() => null);
        if (!res.ok || !body) {
          console.warn(`[CCswitchboard] result-watcher: poll for job ${jobId} got HTTP ${res?.status}, will retry.`);
          return;
        }
      } catch (err) {
        console.warn(`[CCswitchboard] result-watcher: poll error for job ${jobId}, will retry:`, err.message);
        return;
      }

      if (body.status === 'stale') {
        // Reaped without ever running (see reapStalePendingJobs) -- no
        // result exists to deliver, nothing more for this watcher to do.
        await removeActiveDeliveryJob(jobId);
        return;
      }
      if (body.status !== 'done') return; // still pending/running -- try again next tick

      if (body.delivered) {
        // The relay's own durable ACK (delivery.php) already confirms this
        // job was delivered -- e.g. by a since-restarted worker instance that
        // completed the send after this one died. Adopt it locally and stop
        // watching, rather than re-typing a result that already landed.
        await markJobDelivered(deliveryLedgerKey('wake', jobId));
        await removeActiveDeliveryJob(jobId);
        return;
      }

      // Re-resolve the current tab for this thread rather than trusting the
      // tabId captured at registration time -- register_tab.php's row (via
      // registeredThreads here) tracks whichever tab most recently spoke for
      // the thread, so this self-heals if the original tab closed and the
      // thread was reopened/handed off elsewhere in the meantime.
      const tabId = (thread && registeredThreads.get(thread)) ?? job.tabId;
      if (tabId === undefined) {
        console.warn(`[CCswitchboard] result-watcher: no known tab for job ${jobId} (thread "${thread}"), cannot deliver yet.`);
        return;
      }

      deliverJobResult(jobId, tabId, body);
    }));
  } finally {
    resultWatcherInFlight = false;
  }
}

setInterval(resultWatcherTick, POLL_INTERVAL_MS);

// Focuses a specific tab/window, but only after confirming with
// chrome.tabs.get that the tab still exists -- register_tab.php's row can
// easily outlive the tab it names (closed, or handed off and never
// re-registered before this fired). If it's gone, falls back to whatever
// claude.ai tab IS open rather than doing nothing (or, worse, letting
// chrome.tabs.update silently no-op and leave focus wherever it happened to
// be, e.g. some unrelated app). If no claude.ai tab is open at all, this is a
// no-op -- focus must never fall through to some other window/app.
async function focusAnyClaudeTab(context) {
  let claudeTabs;
  try {
    claudeTabs = await chrome.tabs.query({ url: CLAUDE_TAB_URL_PATTERN });
  } catch (err) {
    console.warn(`[CCswitchboard] background: ${context}: failed to query claude.ai tabs for fallback focus:`, err.message);
    return;
  }

  const fallbackTab = claudeTabs[0];
  if (!fallbackTab) {
    console.warn(`[CCswitchboard] background: ${context}: no open claude.ai tab to fall back to, doing nothing.`);
    return;
  }

  chrome.tabs.update(fallbackTab.id, { active: true }, (tab) => {
    if (chrome.runtime.lastError || !tab) {
      console.warn(`[CCswitchboard] background: ${context}: fallback focus on tab ${fallbackTab.id} failed:`, chrome.runtime.lastError?.message);
      return;
    }
    chrome.windows.update(tab.windowId, { focused: true });
    console.log(`[CCswitchboard] background: ${context}: fell back to focusing claude.ai tab ${fallbackTab.id}.`);
  });
}

async function focusTabWithFallback(tabId, context) {
  try {
    await chrome.tabs.get(tabId);
  } catch (err) {
    console.warn(`[CCswitchboard] background: ${context}, but tab ${tabId} is gone (${err.message}), falling back.`);
    await focusAnyClaudeTab(context);
    return;
  }

  chrome.tabs.update(tabId, { active: true }, async (tab) => {
    if (chrome.runtime.lastError || !tab) {
      console.warn(`[CCswitchboard] background: ${context}, but tab ${tabId} update failed:`, chrome.runtime.lastError?.message);
      await focusAnyClaudeTab(context);
      return;
    }
    chrome.windows.update(tab.windowId, { focused: true });
    console.log(`[CCswitchboard] background: ${context}: focused tab ${tabId}.`);
  });
}

// Popup click -> tab focus. The popup app is a separate desktop process and
// can't touch Brave directly, so it POSTs a "focus wanted" flag for a thread
// to the relay; this polls it back out and does the actual
// chrome.tabs/windows focusing, using the tab that register_tab.php already
// has on file for that thread. Same setInterval-vs-chrome.alarms tradeoff as
// resultWatcherTick above -- see that comment for the full rationale.
async function pollFocusRequests() {
  let body;
  try {
    const res = await ccswFetch(RELAY_FOCUS_REQUEST_FILE, { method: 'GET' });
    body = await res.json().catch(() => null);
    if (!res.ok || !body) return;
  } catch (err) {
    console.warn('[CCswitchboard] background: focus_request poll error, will retry:', err.message);
    return;
  }

  const thread = body.thread;
  if (!thread) return;

  console.log(`[CCswitchboard] background: focus requested for thread "${thread}", looking up its tab.`);

  let tabId;
  try {
    const res = await ccswFetch(`${RELAY_REGISTER_TAB_FILE}?thread=${encodeURIComponent(thread)}`, { method: 'GET' });
    const regBody = await res.json().catch(() => null);
    if (!res.ok || !regBody || regBody.tabId === undefined) {
      console.warn(`[CCswitchboard] background: no registered tab for thread "${thread}", cannot focus.`);
      return;
    }
    tabId = regBody.tabId;
  } catch (err) {
    console.warn(`[CCswitchboard] background: register_tab lookup failed for thread "${thread}":`, err.message);
    return;
  }

  await focusTabWithFallback(tabId, `focus requested for thread "${thread}"`);
}

setInterval(pollFocusRequests, FOCUS_POLL_INTERVAL_MS);

// Bug A backstop: an undelivered-result wake is keyed per job by the relay's
// checkUndeliveredResults as repo='result-watchdog#<jobId>' (db.php). Returns
// the numeric jobId that wake carries, or null for any other wake -- including
// a bare 'result-watchdog' emitted by an older relay build that predates
// per-job keying, which falls through to pollWake's generic nudge unchanged.
function parseWatchdogWakeJobId(repo) {
  if (typeof repo !== 'string') return null;
  const m = repo.match(/^result-watchdog#(\d+)$/);
  return m ? Number(m[1]) : null;
}

// Bug A backstop: recover an undelivered result by REDELIVERING the actual
// job result, not by typing a generic "check the board" nudge. The relay
// re-nudges a done-but-undelivered job periodically (delivered_at IS NULL, see
// checkUndeliveredResults) with a per-job wake carrying its jobId; here we
// refetch that job's result and hand it to the SAME delivery path
// resultWatcherTick uses (deliverJobResult -> queueSend `job:<id>`).
//
// Exactly-once holds regardless of how many times this fires: every redelivery
// funnels through queueSend's already-delivered gate, which refuses a 'wake'
// entry whose jobId is in the local delivered ledger (isJobDelivered) OR whose
// relay `delivered` flag is set. So a repeat nudge for a job that already
// landed can never re-type it -- it just clears the now-stale wake. A job that
// genuinely delivered has delivered_at set, so the relay stops nudging it at
// source too, closing the loop. If a redelivery is queued but its send later
// fails, delivered_at stays NULL and the relay simply re-nudges next interval.
async function redeliverUndeliveredResult(jobId, thread, repo, tabId) {
  await deliveredJobIdsReady;

  // Already delivered per our own durable ledger -- the wake is stale (the
  // relay hasn't seen our delivery.php ack yet, or this is a duplicate). Clear
  // it and re-type nothing.
  if (isJobDelivered(deliveryLedgerKey('wake', jobId))) {
    console.log(`[CCswitchboard] undelivered-wake: job ${jobId} already delivered locally, acking stale wake.`);
    ackWake(thread, repo);
    return;
  }

  let body;
  try {
    const res = await ccswFetch(`${RELAY_RESULT_FILE}?id=${jobId}`, { method: 'GET' });
    body = await res.json().catch(() => null);
    if (!res.ok || !body) {
      console.warn(`[CCswitchboard] undelivered-wake: refetch for job ${jobId} got HTTP ${res?.status}; leaving wake for the relay to re-nudge.`);
      return; // do NOT ack -- let the relay re-offer this wake next interval
    }
  } catch (err) {
    console.warn(`[CCswitchboard] undelivered-wake: refetch failed for job ${jobId}; leaving wake for the relay to re-nudge:`, err.message);
    return;
  }

  if (body.delivered) {
    // The relay already holds a durable delivery ACK for this job -- adopt it
    // locally (so our own gate agrees) and clear the wake. Nothing to re-type.
    console.log(`[CCswitchboard] undelivered-wake: job ${jobId} already delivered per relay, adopting and acking wake.`);
    await markJobDelivered(deliveryLedgerKey('wake', jobId));
    ackWake(thread, repo);
    return;
  }
  if (body.status !== 'done') {
    // The relay only nudges done jobs, so this is a rare race (e.g. a cancel/
    // reap between nudge and refetch). Stay safe: leave the wake for the relay
    // to re-evaluate rather than acking a job whose result may not exist.
    console.warn(`[CCswitchboard] undelivered-wake: job ${jobId} not done (status ${body.status}); leaving wake for re-nudge.`);
    return;
  }

  // Deliver the real result through the durable send state machine, exactly as
  // resultWatcherTick would. queueSend's gate makes this a harmless no-op if a
  // concurrent path (the result-watcher tick itself) already queued it.
  console.log(`[CCswitchboard] undelivered-wake: redelivering job ${jobId} result to tab ${tabId} for thread "${thread}".`);
  deliverJobResult(jobId, tabId, body);

  // The result is now queued for delivery (retried by the send state machine,
  // and durably re-nudged by the relay if that send ultimately fails). Ack the
  // wake so it isn't re-served every claim-debounce window; the relay's
  // delivered_at re-nudge -- not this wake row -- is the durable retry.
  ackWake(thread, repo);
}

// M2: repo-lock wake loop. When a repo a thread was queued for frees up,
// wake.php hands that thread back (one-shot); resolve its tab via
// register_tab.php and have content.js type a notice into the conversation
// via the same ProseMirror insert+send mechanism the E3 job-completion wake
// loop uses (message type differs since there's no job id here).
async function pollWake() {
  let body;
  try {
    const res = await ccswFetch(RELAY_WAKE_FILE, { method: 'GET' });
    body = await res.json().catch(() => null);
    if (!res.ok || !body) return;
  } catch (err) {
    console.warn('[CCswitchboard] background: wake poll error, will retry:', err.message);
    return;
  }

  const thread = body.thread;
  if (!thread) return;

  const repo = body.repo;
  vlog(`[CCswitchboard] background: repo "${repo}" freed for thread "${thread}", looking up its tab.`);

  let tabId;
  try {
    const res = await ccswFetch(`${RELAY_REGISTER_TAB_FILE}?thread=${encodeURIComponent(thread)}`, { method: 'GET' });
    const regBody = await res.json().catch(() => null);
    if (!res.ok || !regBody || regBody.tabId === undefined) {
      vlog(`[CCswitchboard] background: no registered tab for thread "${thread}", cannot deliver repo-free wake.`);
      return;
    }
    tabId = regBody.tabId;
  } catch (err) {
    console.warn(`[CCswitchboard] background: register_tab lookup failed for thread "${thread}":`, err.message);
    return;
  }

  // Bug A backstop: an undelivered-result wake (repo='result-watchdog#<jobId>')
  // carries the actual jobId -- refetch that result and REDELIVER it through the
  // normal delivery pipeline rather than typing a generic "check the board"
  // nudge. Handled before the repo-free auto-re-fire query below because it is
  // a pseudo-repo: no dropped pill ever waits on it, so that query would only
  // ever return handled:false and fall through to the generic nudge.
  const watchdogJobId = parseWatchdogWakeJobId(repo);
  if (watchdogJobId !== null) {
    await redeliverUndeliveredResult(watchdogJobId, thread, repo, tabId);
    return;
  }

  // #14 Gate B: before typing the "repo free, reassess and re-fire" nudge,
  // give the tab a chance to auto-re-fire a job it dropped on this repo. If the
  // tab reports it re-fired (content.js's ccsw-repo-free-wake handler), ack the
  // wake and deliver NO nudge -- a successful auto re-fire dispatches quietly
  // like a normal job. Any failure/absence (older build with no handler, no
  // matching dropped pill, toggle off, or the auto-re-fire itself double-
  // failing) falls through to the existing nudge below exactly as before.
  // 'result-watchdog' needs no special-casing here: no dropped pill ever waits
  // on that pseudo-repo, so the handler returns handled:false and we nudge.
  try {
    const refireResp = await chrome.tabs.sendMessage(tabId, { type: 'ccsw-repo-free-wake', thread, repo });
    if (refireResp?.handled) {
      console.log(`[CCswitchboard] background: tab ${tabId} auto-re-fired its dropped job for repo "${repo}"; acking wake, no nudge.`);
      ackWake(thread, repo);
      return;
    }
  } catch (err) {
    // No content script / no handler in this tab -- fall through to the nudge.
    vlog(`[CCswitchboard] background: repo-free auto-re-fire query failed for tab ${tabId}: ${err.message}`);
  }

  // 'result-watchdog' is not a real repo lock -- checkUndeliveredResults()
  // (relay db.php) reuses this same wakes-table poll path to nudge a thread
  // whose done job's result was never delivered, so the generic repo-free
  // text would read as nonsense ("Repo result-watchdog is now free").
  const prompt = repo === 'result-watchdog'
    ? "A finished job's result was never delivered to this thread - check the board/jobs."
    : `Repo ${repo} is now free - you were queued for it.`;
  console.log(`[CCswitchboard] background: sending repo-free wake-prompt to tab ${tabId} for thread "${thread}".`);

  // No toolbar pill exists for a repo-free nudge (no ccsw job was ever
  // dispatched for it), so there's no UI-only message to send here -- just
  // queue the actual delivery.
  queueSend(`repo:${thread}:${repo}`, { tabId, jobId: null, thread, repo, kind: 'repo-free', text: prompt, speakPhrase: null, label: repo });
}

setInterval(pollWake, WAKE_POLL_INTERVAL_MS);

// M3: plan-quiet wake loop. db.php's checkPlanQuietWakes() (run from
// jobs.php's poll) enqueues a thread here once its open plan (set via the
// ccsw-plan-update handler above) has sat with no running/pending job for
// PLAN_QUIET_THRESHOLD_SECONDS; plan_wake.php hands it back one-shot, same
// pop-and-delete shape as wake.php. Delivered through the same send state
// machine the repo-free wake above uses -- this never re-asserts a specific
// plan step, it only prompts Claude to look again and decide what's next.
async function pollPlanWake() {
  let body;
  try {
    const res = await ccswFetch(RELAY_PLAN_WAKE_FILE, { method: 'GET' });
    body = await res.json().catch(() => null);
    if (!res.ok || !body) return;
  } catch (err) {
    console.warn('[CCswitchboard] background: plan-wake poll error, will retry:', err.message);
    return;
  }

  const thread = body.thread;
  if (!thread) return;

  console.log(`[CCswitchboard] background: plan quiet for thread "${thread}", looking up its tab.`);

  let tabId;
  try {
    const res = await ccswFetch(`${RELAY_REGISTER_TAB_FILE}?thread=${encodeURIComponent(thread)}`, { method: 'GET' });
    const regBody = await res.json().catch(() => null);
    if (!res.ok || !regBody || regBody.tabId === undefined) {
      console.warn(`[CCswitchboard] background: no registered tab for thread "${thread}", cannot deliver plan-quiet wake.`);
      return;
    }
    tabId = regBody.tabId;
  } catch (err) {
    console.warn(`[CCswitchboard] background: register_tab lookup failed for thread "${thread}":`, err.message);
    return;
  }

  const prompt = "[CCSW DISPATCH QUEUE] This thread's CCSW job-queue plan (the pill you emitted via a ccsw plan block) has been idle. This refers ONLY to that CCSW job queue — not any written plan, proposal, or task list discussed in this thread. If jobs remain to run: emit the next ccsw job block. If the queue is finished or stale: emit an updated ccsw plan block (empty [] to clear the pill). If nothing is actually owed: say so briefly and do nothing.";
  console.log(`[CCswitchboard] background: sending plan-quiet wake-prompt to tab ${tabId} for thread "${thread}".`);

  // No toolbar pill exists for a plan-quiet nudge (no ccsw job was ever
  // dispatched for it), same as the repo-free wake above.
  queueSend(`plan:${thread}`, { tabId, jobId: null, thread, kind: 'plan-quiet', text: prompt, speakPhrase: null, label: 'Plan' });
}

setInterval(pollPlanWake, PLAN_WAKE_POLL_INTERVAL_MS);

// E6 (cont.): poll jobs.php for every job a tab's toolbar bar is tracking,
// and forward each one's current status to that tab so it can flip its bar
// from pending/running (spinning) to done. One shared GET covers however
// many jobs are in flight across however many tabs, rather than a
// poll-per-job -- jobs.php already returns thread + status for a whole
// batch, which is exactly what feed.php's own header poll uses it for.
//
// A content script's fetch() to dabblelabs.uk would hit the same claude.ai
// CORS wall job.php's POST does (see registerHeaderRule's comment above), so
// this has to run here rather than in content.js.
// Shared by pollToolbarJobs and the ccsw-check-jobs-status handler below --
// both need the same "current batch of jobs from the relay" fetch.
async function fetchRelayJobs() {
  try {
    const res = await ccswFetch(`${RELAY_JOBS_FILE}?status=all&limit=200`, { method: 'GET' });
    const body = await res.json().catch(() => null);
    if (!res.ok || !Array.isArray(body?.jobs)) return null;
    return body.jobs;
  } catch (err) {
    console.warn('[CCswitchboard] background: jobs.php fetch error:', err.message);
    return null;
  }
}

// Falls back to a single-job lookup for a jobId fetchRelayJobs' batch didn't
// return. jobs.php's "all" listing is capped at LIMIT 200 across every
// thread combined (see jobs.php), so a job idle long enough ages out of that
// window entirely -- ccsw-check-jobs-status previously had nothing to say
// about it and content.js's restoreRunningJobBars fell back to trusting
// whatever this tab last had stored, which is note 448's Ghost Reaper root
// cause: a job that finished (or was force-closed) server-side long ago, but
// aged out of the batch, gets silently believed "still running" forever, on
// every hydrate and every reload. status.php has no such cap -- it looks the
// row up by id directly -- so this closes that gap for good.
async function fetchSingleJobStatus(jobId) {
  try {
    const res = await ccswFetch(`${RELAY_STATUS_FILE}?id=${jobId}`, { method: 'GET' });
    if (res.status === 404) return 'stale'; // row is gone entirely -- it cannot possibly still be running
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.status) return null; // transient failure -- caller keeps treating it as unresolved
    return body.status; // pending | running | stale | done -- status.php has no result text, so no error/cancelled split here
  } catch (err) {
    console.warn(`[CCswitchboard] background: status.php fetch error for job ${jobId}:`, err.message);
    return null;
  }
}

// jobs.php reports the DB's plain 'done' for every finished job, whether
// CcswAgent actually succeeded, was cancelled, or posted one of its
// ERROR:/TIMEOUT:/LAUNCH-ERROR: strings -- classify using the same
// result-text checks the E3 wake loop uses, so a pill/LED sourced purely
// from a relay poll (no tab-scoped wake message required) still turns
// grey/red rather than green when the job didn't actually finish clean.
function classifyJobStatus(job) {
  const resultText = job.status === 'done' ? extractResultText(job.result) : null;
  return job.status === 'done' && isCancelledResultText(resultText)
    ? 'cancelled'
    : job.status === 'done' && isErrorResultText(resultText)
      ? 'error'
      : job.status;
}

async function pollToolbarJobs() {
  if (toolbarJobs.size === 0) return;

  const jobs = await fetchRelayJobs();
  if (!jobs) return; // will retry next tick

  const byId = new Map(jobs.map((job) => [job.id, job]));

  for (const [jobId, tabId] of toolbarJobs) {
    const job = byId.get(jobId);
    if (!job) continue; // not in this batch (e.g. aged out of the limit) -- try again next tick

    const status = classifyJobStatus(job);
    if (status === 'running') logPillTransition(jobId, job.thread, 'running');
    // Only an 'error' pill's hovercard needs the raw result text (see
    // renderJobHovercardContent's errored branch in content.js) -- done/
    // cancelled/etc never read it, so skip the re-extract for them.
    const resultText = status === 'error' ? extractResultText(job.result) : null;

    try {
      // model/prompt ride along here (rather than a separate fetch) so the
      // job bar's info hovercard (see content.js's showJobHovercard) can
      // show them without content.js ever hitting dabblelabs.uk itself --
      // see RELAY_JOBS_FILE's comment above for why that fetch has to happen
      // here, not there.
      await chrome.tabs.sendMessage(tabId, { type: 'ccsw-toolbar-status', jobId, status, resultText, thread: job.thread, name: job.name, summary: job.summary, model: job.model, prompt: job.prompt, isCommand: job.is_command, silenceTimeout: job.silence_timeout });
      // Only stop tracking once a terminal status has actually been
      // delivered. Deleting unconditionally here (the old behavior) would
      // drop the job if the send above failed -- e.g. the content script
      // momentarily unreachable mid-navigation -- leaving its pill stuck
      // spinning on whatever status it last received, since nothing would
      // ever resend the final flip.
      if (status === 'done' || status === 'error' || status === 'cancelled') {
        toolbarJobs.delete(jobId);
        logPillTransition(jobId, job.thread, 'marked-done');
      }
    } catch (err) {
      console.warn(`[CCswitchboard] background: failed to message tab ${tabId} for job ${jobId}'s toolbar status, will retry:`, err.message);
    }
  }
}

setInterval(pollToolbarJobs, TOOLBAR_POLL_INTERVAL_MS);

// Action List: this service worker's own cache of actions.php's last known
// state, kept so ccsw-actions-get (a freshly-injected tab asking before the
// next poll tick) has something to answer with immediately, and so the
// ccsw-actions-add/clear handlers above can broadcast right after their own
// POST without waiting for this interval to come back around.
let latestActionsState = { actions: [], counts: { blocking: 0, recommended: 0, nice_to_have: 0 } };

// Pushes the current cached state to every open claude.ai tab's Action List
// pill -- global (not per-thread), so unlike toolbar job status this always
// goes to every tab regardless of which thread dispatched the change.
async function broadcastActionsState() {
  let claudeTabs;
  try {
    claudeTabs = await chrome.tabs.query({ url: CLAUDE_TAB_URL_PATTERN });
  } catch (err) {
    console.warn('[CCswitchboard] background: actions broadcast: failed to query claude.ai tabs:', err.message);
    return;
  }

  for (const tab of claudeTabs) {
    chrome.tabs.sendMessage(tab.id, {
      type: 'ccsw-actions-state',
      actions: latestActionsState.actions,
      counts: latestActionsState.counts,
    }).catch(() => {}); // tab may have no content script yet (still loading) -- next tick catches it up
  }
}

async function refreshActionsState() {
  try {
    const res = await ccswFetch(RELAY_ACTIONS_FILE, { method: 'GET' });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body) return;
    latestActionsState = { actions: body.actions || [], counts: body.counts || latestActionsState.counts };
    await broadcastActionsState();
  } catch (err) {
    console.warn('[CCswitchboard] background: actions poll error, will retry:', err.message);
  }
}

// --- durable dispatch state ------------------------------------------------
// The read side of beacon.php + dispatched.php, cached in this worker so the
// dispatch decision is answered from memory on a block's arrival rather than by
// blocking on two network round-trips -- scan() is synchronous and cannot await.
//
// THIS IS THE DISPATCH DECISION'S INPUT. content.js's scan() dispatches a block
// iff its stableKey is absent from `dispatchedKeys` for its thread AND that
// thread's `beacons` entry is within the send window. Both facts live on the
// relay precisely because the per-tab in-memory guard they replaced did not
// survive a service-worker restart, a tab close, or a reload -- which is how a
// spent block came to re-fire.
//
// `beacons`:        thread -> sentAt (client epoch ms of the last user send)
// `dispatchedKeys`: thread -> Set of stable_key values that already dispatched,
//                   within DISPATCHED_AGE_WINDOW_DAYS
//
// A thread ABSENT from `dispatchedKeys` means "never fetched", NOT "nothing
// dispatched" -- the two are indistinguishable from an empty Set, and reading
// the former as the latter would resurrect every historical block on the first
// scan after a worker restart. content.js defers rather than guessing; see its
// durableStateReadyFor().
let durableBeacons = new Map();
let durableDispatchedKeys = new Map();
let durableStateFetchedAt = 0;

// Identifies THIS service-worker instance. MV3 tears the worker down when idle
// and starts a fresh one on the next event, which empties every Map above --
// including durableThreads, the record of which threads to poll. A tab that
// enrolled its thread with the previous instance would otherwise be silently
// dropped from the poll set and defer its blocks forever. Tabs watch this value
// and re-enroll when it changes.
const WORKER_INSTANCE_ID = `${Date.now()}`;

// Maps/Sets don't survive chrome.tabs.sendMessage's structured-clone-to-JSON
// hop, so the wire form is plain arrays. content.js rebuilds the Maps on receipt.
function serializeDurableDispatchState() {
  return {
    beacons: [...durableBeacons.entries()],
    dispatchedKeys: [...durableDispatchedKeys.entries()].map(([thread, keys]) => [thread, [...keys]]),
    fetchedAt: durableStateFetchedAt,
    workerInstanceId: WORKER_INSTANCE_ID,
  };
}

// Pushes the cached durable state to every claude.ai tab. Global, like the
// Action List broadcast: a tab filters to its own thread itself, and a tab may
// legitimately hold a block whose `thread` field names a DIFFERENT thread than
// the conversation it sits in.
async function broadcastDurableDispatchState() {
  let claudeTabs;
  try {
    claudeTabs = await chrome.tabs.query({ url: CLAUDE_TAB_URL_PATTERN });
  } catch (err) {
    console.warn('[CCswitchboard] background: durable-state broadcast: failed to query claude.ai tabs:', err.message);
    return;
  }

  const state = serializeDurableDispatchState();
  for (const tab of claudeTabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'ccsw-durable-state', ...state }).catch(() => {}); // tab may have no content script yet -- next tick catches it up
  }
}

// Threads whose dispatched-keys must be polled, beyond the ones registeredThreads
// already covers.
//
// registeredThreads alone is NOT enough, and relying on it would deadlock the
// dispatch rule. A thread lands there only once it DISPATCHES a job (or is found
// holding open ones) -- but content.js refuses to dispatch anything in a thread
// whose dispatched-key set it hasn't fetched, since it can't tell "nothing ran"
// from "don't know" (see durableStateReadyFor). A brand-new thread would sit in
// that deadlock forever: never fetched, so never dispatching, so never
// registered, so never fetched. Every tab therefore announces its own thread
// here the moment it hydrates one, dispatch or no dispatch.
//
// Capped, oldest-first: this grows by one per thread visited, and each entry
// costs a GET per poll tick. Threads evict long before the cap matters in
// practice -- a tab re-announces on hydration.
const MAX_DURABLE_THREADS = 24;
const durableThreads = new Set();

function noteDurableThread(thread) {
  if (typeof thread !== 'string' || thread === '') return;
  durableThreads.delete(thread); // re-insert so recency orders the Set
  durableThreads.add(thread);
  while (durableThreads.size > MAX_DURABLE_THREADS) {
    const oldest = durableThreads.values().next().value;
    durableThreads.delete(oldest);
    // Drop its cached keys too. A stale Set is worse than none: it would read
    // as authoritative ("ready") while missing every dispatch since eviction.
    durableDispatchedKeys.delete(oldest);
  }
}

// Every thread whose dispatched keys we poll: those that have dispatched, plus
// those a tab has merely opened.
function durablePollThreads() {
  return new Set([...registeredThreads.keys(), ...durableThreads]);
}

async function fetchDispatchedKeysForThread(thread) {
  try {
    const url = `${RELAY_DISPATCHED_FILE}?thread=${encodeURIComponent(thread)}&since_days=${DISPATCHED_AGE_WINDOW_DAYS}`;
    const res = await ccswFetch(url, { method: 'GET' });
    const body = await res.json().catch(() => null);
    // Only a successful, well-formed answer may write the cache. A failed poll
    // must leave the previous Set intact rather than clearing it to empty -- an
    // empty Set reads as "nothing has ever dispatched in this thread", which
    // would let every historical block in it fire again.
    if (res.ok && body && Array.isArray(body.stableKeys)) {
      durableDispatchedKeys.set(thread, new Set(body.stableKeys));
      // Stamped on ANY successful relay read, not just the full poll's: it
      // means "this cache has spoken to the relay", which is what content.js's
      // durableStateReadyFor tests before it trusts a per-thread entry. Leaving
      // it at 0 here would make the on-demand fetch above useless -- the tab
      // would hold its fresh keys and still defer every block.
      durableStateFetchedAt = Date.now();
      return true;
    }
  } catch (err) {
    console.warn(`[CCswitchboard] background: dispatched-keys poll error for thread "${thread}", will retry:`, err.message);
  }
  return false;
}

// A freshly-injected content script has no durable state to decide with until
// the next poll tick, and until it has some it defers every block (no dispatch,
// no pill). This lets it ask for whatever this worker last fetched instead of
// waiting -- mirrors ccsw-actions-get.
//
// `thread` (when the tab knows it yet) both enrolls it for polling and triggers
// an immediate fetch, so a tab that just opened an unseen thread waits one
// request rather than a poll interval before it can dispatch anything.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ccsw-durable-get') return false; // not for us

  const thread = message.thread;
  if (typeof thread === 'string' && thread !== '') {
    const known = durableDispatchedKeys.has(thread);
    noteDurableThread(thread);
    if (!known) {
      fetchDispatchedKeysForThread(thread).then((ok) => {
        if (ok) broadcastDurableDispatchState();
      });
    }
  }

  sendResponse(serializeDurableDispatchState());
  return false; // responded synchronously, no need to keep the channel open
});

async function refreshDurableDispatchState() {
  // One call for every thread's beacon (beacon.php returns the whole table
  // when given no thread -- it's one row per thread, so this stays small).
  try {
    const res = await ccswFetch(RELAY_BEACON_FILE, { method: 'GET' });
    const body = await res.json().catch(() => null);
    if (res.ok && body && Array.isArray(body.beacons)) {
      const next = new Map();
      for (const b of body.beacons) {
        if (b && typeof b.thread === 'string' && typeof b.sentAt === 'number') next.set(b.thread, b.sentAt);
      }
      // Swap wholesale rather than merging: the relay's table is authoritative,
      // and a thread deleted there must not linger in the cache.
      durableBeacons = next;
    }
  } catch (err) {
    console.warn('[CCswitchboard] background: beacon poll error, will retry:', err.message);
  }

  // dispatched.php is per-thread (it's a covering-index scan on a thread), so
  // this asks only about threads this worker has actually seen a tab for.
  // Sequential, not parallel: a handful of threads at a 4s cadence, and a
  // burst of concurrent requests buys nothing against a single SQLite relay.
  for (const thread of durablePollThreads()) {
    await fetchDispatchedKeysForThread(thread);
  }

  durableStateFetchedAt = Date.now();
  await broadcastDurableDispatchState();
}

// Piggybacked on the Action List's existing cadence rather than adding another
// timer -- see the setInterval-vs-chrome.alarms note above pollToolbarJobs.
setInterval(() => {
  refreshActionsState();
  refreshDurableDispatchState();
}, ACTIONS_POLL_INTERVAL_MS);
refreshActionsState(); // fetch immediately on load rather than waiting a full interval
refreshDurableDispatchState();

// In-thread "agent offline" banner: jobs.php's `agentOffline` field mirrors
// isAgentOffline() in db.php (the same heartbeat-staleness check that drives
// the board's own banner and the Pushover alert in checkAgentOfflineAlert()),
// so this poll is the extension's view of that same signal. Global (not
// per-thread), same broadcastActionsState() pattern -- every open claude.ai
// tab gets it regardless of which thread dispatched anything, since an
// offline agent affects every thread equally. Requesting limit=1 keeps this
// tick cheap; only the top-level agentOffline field is actually read.
let latestAgentOffline = false;

async function broadcastAgentOfflineState(offline) {
  let claudeTabs;
  try {
    claudeTabs = await chrome.tabs.query({ url: CLAUDE_TAB_URL_PATTERN });
  } catch (err) {
    console.warn('[CCswitchboard] background: agent-offline broadcast: failed to query claude.ai tabs:', err.message);
    return;
  }

  for (const tab of claudeTabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'ccsw-agent-offline', offline }).catch(() => {}); // tab may have no content script yet -- next tick catches it up
  }
}

async function refreshAgentOfflineState() {
  try {
    const res = await ccswFetch(`${RELAY_JOBS_FILE}?status=all&limit=1`, { method: 'GET' });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body.agentOffline !== 'boolean') return;
    latestAgentOffline = body.agentOffline;
    await broadcastAgentOfflineState(latestAgentOffline);
  } catch (err) {
    console.warn('[CCswitchboard] background: agent-offline poll error, will retry:', err.message);
  }
}

setInterval(refreshAgentOfflineState, AGENT_OFFLINE_POLL_INTERVAL_MS);
refreshAgentOfflineState(); // fetch immediately on load rather than waiting a full interval
