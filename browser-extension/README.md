# CCswitchboard browser extension -- E1 (read) + E2 (dispatch) + E3 (wake)

Manifest V3 extension that loads on claude.ai, detects Claude's assistant
messages as they finish streaming in, and looks inside each one for a
fenced ` ```ccsw ` code block containing a JSON job payload. If it finds
one, it POSTs that JSON to the ccswitchboard relay's `job.php` as a new
job (everything else in a message -- prose, other code blocks -- is
ignored), then polls the relay for that job's result. Once the job is
done, it types a wake-prompt into Claude's input and sends it, so the
conversation continues with the result.

## Load it in Brave

1. Go to `brave://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `browser-extension/` folder.
   You should see a `background.js` service worker start up too (visible
   under the extension's "service worker" link on that page); check its
   console for `registered User-Agent rewrite rule` to confirm it ran.
4. Open `https://claude.ai`, open any conversation (or start a new one).
5. Open DevTools (F12) -> **Console** tab.
6. Send a message. Expect something like:
   ```
   [CCswitchboard] content script loaded on https://claude.ai/...
   [CCswitchboard] scan() via startup: found 5 feedback button(s) (= assistant messages).
   [CCswitchboard] anchor #0: walked up to <div class="...">
   [CCswitchboard] anchor #0: text captured (len=142): "..." -- stability timer (re)started.
   [CCswitchboard] observer fired: 3 mutation record(s), scan in 300ms.
   [CCswitchboard] scan() via mutation-observer: found 5 feedback button(s) (= assistant messages).
   [CCswitchboard] anchor #0: stability timer fired -- Completed assistant message:
   <the message text>
   ```
   To test dispatch, put a fenced code block tagged `ccsw` in a message to
   Claude, containing a JSON job payload, e.g.:
   ````
   ```ccsw
   {"prompt": "say hi", "model": "claude-sonnet-5", "cwd": "V:/ccswitchboard"}
   ```
   ````
   Once Claude's reply (containing that block, echoed back or otherwise)
   finishes streaming, look for:
   ```
   [CCswitchboard] dispatched job <id>
   ```
   in the *page's* console. The actual POST happens in the background
   service worker, not the page, so to see it in a Network tab you need
   the service worker's own DevTools: `brave://extensions` -> click
   "service worker" under CCswitchboard -> Network tab there -> confirm a
   POST to `https://dabblelabs.uk/ccswitchboard/board/job.php` went out and
   returned `{"id": <id>}`.
7. Once dispatched, the service worker's console should show:
   ```
   [CCswitchboard] background: polling result.php for job <id> every 3000ms.
   [CCswitchboard] background: job <id> status = pending
   [CCswitchboard] background: job <id> status = running
   [CCswitchboard] background: job <id> status = done
   [CCswitchboard] background: job <id> done, sending wake-prompt to tab <tabId>.
   ```
   (statuses depend on how far along the job actually is when polling
   starts -- something else has to actually move the job from pending to
   running to done, e.g. `CcswAgent` or a manual `curl` against
   `result.php`; the extension only reads status, it doesn't process
   jobs). Once that fires, the *page's* console should show:
   ```
   [CCswitchboard] wake (job <id>): received wake-prompt: Job <id> finished. Result: ...
   [CCswitchboard] wake (job <id>): found input via "...", focusing.
   [CCswitchboard] wake (job <id>): inserting text via execCommand('insertText').
   [CCswitchboard] wake (job <id>): found send button via "...", clicking.
   [CCswitchboard] wake (job <id>): sent.
   ```
   and the wake-prompt should actually appear typed into Claude's input and
   get sent.

If `scan()` reports 0 feedback buttons where you'd expect some, the anchor
selector itself needs fixing (see below). If it reports the right count
but no `anchor #N: text captured` line ever appears for a given anchor, the
DOM walk (`findMessageTurnContainer`) is landing somewhere with no text --
check the `walked up to <...>` log for that anchor to see what it found. If
a message is logged but no job is dispatched, the ` ```ccsw ` block wasn't
found or didn't parse as JSON -- check for a `ccsw block is not valid
JSON` warning.

Note: the `scan() via fallback-interval` heartbeat that used to print every
2s is now silent unless it finds something new to report -- the periodic
scan itself still runs, it just doesn't log on its own anymore.

## Relays and auth tokens

The relay's URL is **not** hardcoded any more. `background.js` holds an
**ordered list** of relays and fails over between them automatically, so
an outage on one doesn't take the extension down with it:

| priority | base | role |
|---|---|---|
| 0 | `https://dabblelabs.uk/ccswitchboard/board` | primary |
| 1 | `https://relay.z4ps.uk` | reserve |

Only the endpoint **filenames** (`feed.php`, `job.php`, ...) are constants
in `background.js`; every full URL is derived from whichever relay is
active, so a failover redirects all ~20 endpoints at once. `ccswFetch()` is
the single choke point -- give it a bare filename (`ccswFetch('jobs.php?limit=1')`)
and it resolves it against the active relay and attaches that relay's token.

### Storage keys (`chrome.storage.local`)

| key | meaning |
|---|---|
| `ccswRelays` | `[{base, token}, ...]` -- ordered, index 0 is the primary |
| `ccswActiveRelay` | index of the relay currently in use (sticky across restarts) |
| `ccswToken` | **legacy** single token, migrated into `ccswRelays` on first run |

Tokens are **per relay**: each relay is a separate deployment with its own
`auth.config.php`, so one relay's token is meaningless (a 401) on the other.

On first run after the multi-relay change, `ccswRelays` is built from the
defaults and any existing `ccswToken` is migrated onto the **reserve**
entry -- that legacy value was set during the dabblelabs.uk outage, so it
is the reserve's token. The primary's token starts empty.

**A relay with an empty token is skipped entirely** (logged once, not
hammered with requests that could only 401). That is why the extension
lands on the reserve on its own until the primary's token is filled in.

### Setting a token (service-worker console)

There's no options page yet, so set tokens from the service worker console
(`brave://extensions` -> the extension's "service worker" link):

```js
// Inspect the current list (tokens included -- don't paste this anywhere).
await chrome.storage.local.get(['ccswRelays', 'ccswActiveRelay']);

// Give the primary its token; the probe below then switches back to it.
const { ccswRelays } = await chrome.storage.local.get('ccswRelays');
ccswRelays[0].token = '<primary relay token>';
await chrome.storage.local.set({ ccswRelays });
```

Writing `ccswRelays` re-reads the list immediately, re-registers the
relay-scoped `declarativeNetRequest` rules, and brings a previously-skipped
relay back into rotation -- no extension reload needed.

### Failover rules

* **Failover**: 3 consecutive failures (network error, 8s timeout, or 5xx)
  on the active relay switch to the next usable one and retry the request
  once there. A **404 is not a failover signal** -- the relay answered, so
  it's alive (e.g. `alert.php` 404s until it's deployed).
* **401**: the relay is marked token-rejected and dropped from rotation
  immediately, with no 3-strike wait -- retrying can't fix a bad token.
* **Failback**: while running on the reserve, the primary is probed every
  ~60s with a cheap authenticated `GET jobs.php?limit=1` (**not** `poll.php`,
  which would *claim* a job and strand it). Two **consecutive** OKs switch
  back -- the hysteresis stops a flapping relay from dragging the extension
  back and forth.

`content.js` never learns a relay URL of its own: it can't fetch the relay
anyway (CORS -- see "Why the actual POST happens in background.js"), so it
asks `background.js` for the active one and is pushed a fresh copy on every
switch.

## How assistant messages are identified

Claude's DOM doesn't have an obvious `class="assistant-message"` to select
on (classes are build-hashed and unstable), so this uses a structural
signal instead. The starting point was a real, actively-maintained
open-source project ([`agarwalvishal/claude-chat-exporter`](https://github.com/agarwalvishal/claude-chat-exporter),
main branch as of 2026-02-23) that has to solve the same problem, but its
`messageActionsGroup` wrapper selector
(`[role="group"][aria-label="Message actions"]`) turned out not to match
on the live DOM when this was first tried -- confirmed live in Brave
DevTools that it matched 0 elements while the bare feedback-button
attribute matched exactly the expected count of assistant messages.

So the **primary, load-bearing selector** is just:

```
[aria-label="Give positive feedback"]
```

confirmed live to match one element per Claude response (the human's own
messages don't get an option to give feedback, so this is what tells the
two apart). Note it's used *without* a `button` tag qualifier -- an
earlier version required `button[aria-label="Give positive feedback"]`
and that may be part of why it silently matched nothing; keep it bare
unless you've confirmed the tag in DevTools yourself.

`messageActionsGroup` is kept as a best-effort cleanup step (stripping
action-bar button labels like "Copy"/"Retry" back out of the extracted
text) and, more importantly, as the **primary boundary signal** for the DOM
walk below -- if it doesn't match anything on the page, both fall back to
counting `feedbackButton` instead.

To get from "found Claude's feedback button" to "here's the message text,"
`content.js` walks up the DOM from the button to find the smallest
ancestor that contains exactly that one message turn (`findMessageTurnContainer`).
It stops climbing as soon as going one level higher would sweep in a
*second* message-turn boundary. That boundary is counted via
`messageActionsGroup` rather than `feedbackButton`, because
`messageActionsGroup` exists once per turn regardless of sender (human or
assistant) -- counting `feedbackButton` alone was tested (via a small
jsdom harness, no real browser available in this environment) to
over-climb past the assistant's own turn and merge in the *preceding
human message's text* whenever there's no later assistant turn yet to
serve as a second boundary marker. That's exactly the situation for the
newest message in a conversation, i.e. the one this extension cares about
most, so it was worth fixing rather than leaving as a known gap.

`extractMessageText` also collapses duplicated content: Claude's DOM was
observed to sometimes contain the same message text twice (e.g. "X X"),
likely from a hidden/measurement copy of the same content. `dedupeSiblingText`
recursively drops any element whose full text exactly duplicates an
earlier sibling's, and `collapseExactDuplicate` is a string-level backstop
for duplication that isn't a clean sibling pair (e.g. the copy lives
somewhere else under the same container, or is plain text rather than a
wrapped element `dedupeSiblingText` could see). Both compare text after
whitespace-normalizing it (collapsing runs of whitespace, trimming) rather
than requiring byte-identical matches -- the two copies were observed to
still differ in incidental whitespace even when reporting messages as
still doubled after the first dedup attempt, so exact-match comparison
alone wasn't enough. `collapseExactDuplicate` also no longer requires the
whole string to split into two exactly-equal-length halves; it searches
for where the message's own opening text re-occurs later in the string,
accepting the split only if it lands near the middle. Both are guarded by
`CONFIG.MIN_DEDUPE_LEN` so two coincidentally-identical short strings
(e.g. two list items that both just say "Yes") aren't wrongly treated as
duplicates. When it fires, `collapseExactDuplicate` logs
`collapsed duplicated text (N chars -> M chars)` so it's visible in the
console when it actually did something.

A `MutationObserver` watches `document.body` (not a specific "chat
container" div -- see the comment in `content.js` for why) and re-queries
the DOM fresh on every mutation batch, so it survives claude.ai's React
navigation remounting things. A message is treated as complete once its
text stops changing for `CONFIG.STABLE_MS` (1.2s by default), which is how
streaming completion is detected without depending on a specific
"is this still streaming" attribute. Only once a message is complete does
`content.js` look inside it for a ` ```ccsw ` block.

## How a ccsw block becomes a dispatched job

`findCcswBlocks` looks for a `<code>` element classed by its fence's
info-string (the common markdown-renderer convention, e.g.
`class="language-ccsw"`), falling back to a raw regex over the container's
text for a literal ` ```ccsw ... ``` ` block if no such element is found.
Its contents are `JSON.parse`d; anything that isn't valid JSON is skipped
with a console warning rather than dispatched.

Each message tracks its own dispatched-block history (in a `Set`, scoped to
that message's state) so the exact same block text is never POSTed twice
from the same message, even if `scan()` runs again after the message is
already marked complete.

### Planned-job pills (`plan`)

A ccsw block can carry a `plan` array of short strings alongside its normal
fields -- e.g. `{"thread": "foo", "plan": ["fix bug", "write tests"]}` --
naming jobs that are expected but not dispatched yet. `dispatchCcswBlock`
renders these as dashed/dimmed "planned" pills stacked above the live job
pills (newest last in the array, at the top; see `renderPlanPills` in
`content.js`), non-interactive and with no feed of their own. Each new block
that carries a `plan` array replaces the whole displayed set; an empty
array (or the block moving on without one) clears or leaves it as-is
respectively.

A block with `plan` but no `prompt`/`command` is plan-only and is never
POSTed to `job.php` -- those two fields are the only ones `CcswAgent`
actually runs (see `AgentCore.cs`), so a block missing both has nothing
dispatchable. A block can still carry both a real job and a `plan` at the
same time; the job dispatches as normal and the plan pills render alongside
it.

### Action List (`actions`)

A ccsw block can also carry an `actions` array of manual-action items for
Jody to do himself -- e.g.
`{"actions": [{"text": "reload extension", "tier": "blocking"}]}`. Each item
is `{text, tier}` with `tier` one of `blocking` / `recommended` /
`nice_to_have`. Same plan-only-style precedent as `plan` above: this field
works whether or not the block also has `prompt`/`command`, so a standalone
block with only `actions` (no job dispatch at all) is a valid way to add
items outside of a real job.

Unlike `plan`, the Action List is global (not per-thread, no `thread` field
needed) and is never rendered inline in the pills stack -- it's a single
persistent pill between the job pills and the SW icon (see
`ensureActionListPill`/`renderActionListPill` in `content.js`), synced
through a new relay endpoint, `actions.php` (POST `{"add": [...]}`), via
`background.js`'s `ccsw-actions-add` handler. Three nested inner pills show
each tier's uncleared count (hollow outline when zero, filled when not); the
whole pill's background goes flat grey when all three are zero. Clicking it
opens a draggable/resizable dialog (reusing the feed panel's resize-handle
machinery) listing open items grouped by tier with a tick-to-clear
checkbox each. Jody ticks items off himself -- there's no auto-detection.
Ticking doesn't auto-send; a dialog button explicitly sends the revised list
back into the chat (reusing the same send state machine as the advice
button, via a new `ccsw-deliver-actions` message).

To poll the current Action List state from a ccsw job (rather than the
extension's own pill), dispatch a readonly bash job that curls it, e.g.
`{"type": "bash", "readonly": true, "command": "curl -s https://dabblelabs.uk/ccswitchboard/board/actions.php"}`
-- same pattern as any other read-only relay query run via the agent.

### Why the actual POST happens in background.js, not content.js

The first version of this had `content.js` `fetch()` `job.php` directly,
which hit a CORS error in real use: a content script's `fetch()` is bound
by the hosting *page's* (claude.ai's) CORS policy in Manifest V3 --
`host_permissions` granting a cross-origin bypass only applies to the
extension's own privileged contexts (the background service worker, popup,
options page), not to code injected into a page. So `content.js` no longer
fetches anything itself; it JSON-parses the ccsw block, then
`chrome.runtime.sendMessage({type: 'ccsw-dispatch', payload})`s it to
`background.js`, which does the actual cross-origin POST (that context
*does* get the bypass) and responds with `{ok: true, id}` or
`{ok: false, ...}`. `background.js`'s listener returns `true` to keep the
message channel open for that async `sendResponse`.

### The User-Agent header

The relay's host WAF returns 429 for requests with no/blank `User-Agent`
(the exact same problem `CcswAgent`'s C# `HttpClient` hit and fixed
earlier in this project). Even from `background.js`, a plain `fetch()`
call **cannot** set this header directly -- Chromium doesn't allow
script-level control of `User-Agent` via `fetch()`/`XMLHttpRequest`,
regardless of extension permissions or which context makes the call.
`background.js` also registers a `chrome.declarativeNetRequest` rule that
rewrites the `User-Agent` header on any request to the **active relay's**
base at the network layer, which *is* one of the headers
`declarativeNetRequest` is documented to support modifying. This is why
`manifest.json` has a `background.service_worker`, the
`declarativeNetRequest` permission, and **both** relay hosts
(`https://dabblelabs.uk/*` and `https://relay.z4ps.uk/*`) in
`host_permissions` -- needed both for that rule to apply and for
`background.js`'s own cross-origin `fetch()` to reach either relay at all,
since claude.ai and the relays are different origins.

Both this rule and the `feed.php` iframe token rule are **relay-scoped**, so
both are re-registered on every failover as well as at startup (see
`onActiveRelayChanged`) -- a rule left pointing at the previous relay would
strip the new relay's User-Agent (429) or attach the wrong relay's token
(401).

## E3: the wake loop

Once `background.js` dispatches a job and gets its id back, it starts
polling `GET /result.php?id=<id>` every 3 seconds until `status` comes
back `"done"`, then `chrome.tabs.sendMessage`s the originating tab with
`{type: 'ccsw-wake', jobId, prompt}`, where `prompt` is
`"Job <id> finished. Result: <result>"`.

**This required a relay change.** `result.php` was POST-only before this
milestone (it's how an agent *writes* a finished job's result) -- there
was no way to *read* a job's status by id anywhere in the API. Added a
`GET /result.php?id=<id>` branch returning
`{"id", "status": "pending"|"running"|"done", "result"}`, alongside the
unchanged `POST` behavior. See the top-level `README.md` for the full
endpoint list.

`content.js` receives the wake message and calls `injectWakePrompt`, which:

1. Finds Claude's input via a cascade of attribute-based selectors
   (`INPUT_SELECTORS`), most-specific first: `data-testid`, then the
   ProseMirror editor's own semantic class (not a build-hashed one --
   it's the actual rich-text library's name for itself), then a couple of
   looser fallbacks, down to a bare `div[contenteditable="true"]` as a
   last resort.
2. Focuses it, then runs `document.execCommand('insertText', false, text)`.
   Claude's input is a ProseMirror editor, which ignores direct DOM
   writes like `.value`/`.innerHTML` entirely -- it only reacts to real
   browser input events, and `execCommand('insertText', ...)` is what
   still triggers those (despite `execCommand` being broadly deprecated
   for most other uses).
3. Finds the send button via `SEND_BUTTON_SELECTORS`
   (`[data-testid="send-button"]`, then `button[aria-label*="Send"]`) and
   clicks it.

Every step logs what it found and did, prefixed `wake (job <id>):`, so a
failure at any stage (no input found, `execCommand` returning `false`, no
send button found) is visible rather than silent.

None of the input/send-button/`messageActionsGroup`/`feedbackButton`
selectors were independently confirmed against the live claude.ai DOM in
this environment (no browser available) -- the feedback-button one *was*
confirmed live in an earlier milestone (see above), but the input and
send-button selectors are sourced from public write-ups of other people
solving the same problem, not verified firsthand. If wake-prompt injection
doesn't work, check the console for which stage failed and follow
**Fixing the selectors** below, adjusting `INPUT_SELECTORS` /
`SEND_BUTTON_SELECTORS` instead of `SELECTORS`.

One known simplification: `background.js` polls via a plain `setInterval`
rather than `chrome.alarms`. MV3 service workers can be torn down after a
period of inactivity, silently dropping a `setInterval` timer along with
them -- `chrome.alarms` survives worker restarts, at the cost of a
1-minute minimum period for packed extensions (unpacked/dev-mode
extensions, which is how this is always loaded, get to use sub-minute
periods too). Left as `setInterval` since this is a short,
actively-watched test loop rather than an unattended deployment; worth
revisiting if jobs end up taking long enough (or the browser sitting idle
enough) for the worker to actually get killed mid-poll.

## Fixing the selectors if claude.ai's UI changes

1. Open a conversation with at least one Claude reply.
2. In the DevTools Console, run:
   `document.querySelectorAll('[aria-label="Give positive feedback"]').length`
   It should equal the number of Claude replies visible. If it's 0, the
   button's accessible name has changed -- right-click the thumbs-up icon
   on a Claude message, **Inspect**, and read its actual `aria-label` (or
   whatever attribute now marks it) from the Elements panel.
3. Update `SELECTORS.feedbackButton` in `content.js` to match.
4. If message text still isn't captured correctly once the anchor count is
   right, check the `anchor #N: walked up to <...>` log -- if it's landing
   somewhere odd, the ancestor-walk in `findMessageTurnContainer` may need
   a different stopping condition for the new DOM shape.
5. Reload the extension (`brave://extensions` -> the refresh icon on the
   CCswitchboard card). Open claude.ai tabs get the new content script
   re-injected automatically (see `reinjectClaudeTabs` in `background.js`) --
   no manual tab refresh needed.

`CONFIG` and the two selectors are the only things that should need to
change -- the observing/debouncing/text-cleanup logic doesn't assume
anything else about the DOM shape.
