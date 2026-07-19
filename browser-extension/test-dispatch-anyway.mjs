// Unit test for the "Dispatch anyway" path on a HELD block (dispatchCcswBlock
// in content.js). Extracts the REAL source of the function out of content.js and
// evals it against stubbed collaborators, so this tests the shipping code rather
// than a re-typed copy of it that could drift -- same approach as
// test-status-footer.mjs.
//
// THE BUG THIS PINS. A block held by the recent-send gate ("needs a recent
// send") shows a held pill with a "Dispatch anyway" override. That handler
// disposes the held pill and then calls dispatchCcswBlock with ghostEl = null.
// dispatchCcswBlock renders every outcome by MORPHING the node it was handed, so
// with null:
//   - success        -> addJobBar builds a fresh running pill (fine)
//   - 409 repo lock  -> showDroppedJobBar builds a fresh repo-busy pill (fine)
//   - any OTHER fail -> removeGhostBar(null) == NO-OP -> nothing rendered at all
// That last case is the silent data loss: pill gone, no job, no error on screen.
// Cases (c) and (d) below fail against the pre-fix content.js and pass after it.
//
// Run: node test-dispatch-anyway.mjs
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./content.js', import.meta.url), 'utf8');

const START = 'async function dispatchCcswBlock(';
const END = '// --- #14 Gate B: auto-re-fire a dropped job on its repo-free wake';
const from = src.indexOf(START);
const to = src.indexOf(END);
if (from < 0 || to < 0 || to <= from) {
  console.error('FAIL: could not locate dispatchCcswBlock in content.js -- did it move or get renamed?');
  process.exit(1);
}
const block = src.slice(from, to);

// Every collaborator dispatchCcswBlock touches, stubbed. `calls` records what
// the function actually did so each case can assert on real behaviour rather
// than on a return value (the function returns nothing).
function makeHarness({ response, throws } = {}) {
  const calls = {
    dispatched: [],      // payloads that reached the relay
    running: [],         // addJobBar -- the running pill
    dropped: [],         // showDroppedJobBar -- repo-busy pill
    failedBar: [],       // showDispatchFailedBar -- the loud failure pill
    ghostsRemoved: [],   // removeGhostBar -- the silent path
    markedKeys: [],      // recordLocalDispatchedKey -- must only follow success
  };

  const env = {
    // Parse: the real block text is valid JSON in these tests, so a plain
    // JSON.parse mirrors parseCcswBlockText's wrapper shape closely enough.
    parseCcswBlockText: (text) => {
      try {
        return { parsed: JSON.parse(text), usedSanitize: false, foundClasses: [], error: null };
      } catch (err) {
        return { parsed: null, usedSanitize: false, foundClasses: [], error: err.message };
      }
    },
    recoverCcswBlockName: () => null,
    selfHealJsonEnabled: false,
    selfHealBlockKey: () => 'k',
    selfHealAttempts: new Map(),
    SELF_HEAL_MAX_ATTEMPTS: 2,
    sendSelfHealFeedback: () => {},
    showInvalidBlockBar: () => {},
    renderPlanPills: () => {},
    fingerprintActionsBlock: () => 'actions-key',
    isStableKeyDispatched: () => false,
    sendActionsAdd: () => {},
    hydratedThread: 'thread-abc',
    fingerprintBlockStable: () => 'stable-key-1',
    resolveDedupBucket: (t) => t || 'thread-abc',
    deriveJobDisplayName: (n) => n || 'Job',
    speakJobStart: () => {},
    recordSessionJob: () => {},
    reconcilePlanWithDispatchedJob: () => {},
    resolveSupersededDroppedTwin: () => {},
    rememberUrlThread: () => {},
    handlePossibleContextInvalidation: () => {},
    logEvent: () => {},
    inFlightDispatch: new Set(),
    console: { log() {}, warn() {}, error() {} },

    removeGhostBar: (ghostEl, reason) => calls.ghostsRemoved.push(reason),
    addJobBar: (jobId, thread, name) => calls.running.push({ jobId, thread, name }),
    showDroppedJobBar: (ghostEl, info) => calls.dropped.push(info),
    showDispatchFailedBar: (ghostEl, info) => calls.failedBar.push(info),
    recordLocalDispatchedKey: (bucket, key) => calls.markedKeys.push({ bucket, key }),

    chrome: {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type !== 'ccsw-dispatch') return undefined;
          calls.dispatched.push(msg);
          if (throws) throw new Error(throws);
          return response;
        },
      },
    },
  };

  const names = Object.keys(env);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `${block}; return dispatchCcswBlock;`);
  return { fn: factory(...names.map((n) => env[n])), calls };
}

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok && detail) console.log(`  ${detail}`);
}

// The block a held pill stashes and hands back on "Dispatch anyway". The held
// call site passes ghostEl = null, which is the whole point of these tests.
const HELD_BLOCK = JSON.stringify({
  name: 'Fix Login',
  summary: 'repair the auth redirect',
  thread: 'thread-abc',
  prompt: 'go fix the login',
});

// (a) THE HEADLINE CASE: held -> "Dispatch anyway" -> actually dispatched.
// Guards requirement 1: the override must reliably reach the relay and produce
// a running pill, bypassing only the recent-send gate.
{
  const { fn, calls } = makeHarness({ response: { ok: true, id: 42 } });
  await fn(3, HELD_BLOCK, null);
  check('dispatch anyway reaches the relay', calls.dispatched.length === 1,
    `expected 1 dispatch, got ${calls.dispatched.length}`);
  check('dispatch anyway sends the held block payload',
    calls.dispatched[0]?.payload?.prompt === 'go fix the login');
  check('dispatch anyway produces a running pill', calls.running.length === 1 && calls.running[0].jobId === 42,
    `running pills: ${JSON.stringify(calls.running)}`);
  check('successful dispatch marks the block spent', calls.markedKeys.length === 1);
  check('successful dispatch shows no failure pill', calls.failedBar.length === 0);
}

// (b) Repo lock (409) still drops loudly -- the override must bypass ONLY the
// recent-send gate, never a real guard. Requirement 1's second half.
{
  const { fn, calls } = makeHarness({
    response: { ok: false, status: 409, body: { locked: true, held: [{ repo: 'V:/x' }], held_by: 'other' } },
  });
  await fn(3, HELD_BLOCK, null);
  check('409 repo lock still shows a repo-busy pill', calls.dropped.length === 1);
  check('409 repo lock does NOT mark the block spent', calls.markedKeys.length === 0,
    'a block that never ran must stay eligible to re-fire');
  check('409 repo lock produces no running pill', calls.running.length === 0);
}

// (c) THE SILENT-LOSS REGRESSION TEST. Relay answered, but not with a lock and
// not with an id (500, auth failure, malformed body...). Pre-fix this hit
// removeGhostBar(null) and rendered NOTHING: the held pill was already gone, so
// the job vanished with no pill and no error. Requirement 2: fail loud.
{
  const { fn, calls } = makeHarness({ response: { ok: false, status: 500, body: null } });
  await fn(3, HELD_BLOCK, null);
  check('non-409 dispatch failure shows an explicit error pill', calls.failedBar.length === 1,
    'the job must NEVER vanish silently -- this is the reported data-loss bug');
  check('failure pill reports the relay status', calls.failedBar[0]?.status === 500);
  check('failure pill keeps the block text so it can be retried',
    calls.failedBar[0]?.blockText === HELD_BLOCK);
  check('failed dispatch does NOT mark the block spent', calls.markedKeys.length === 0,
    'mark-before-send would make the block permanently un-redispatchable');
  check('failed dispatch does not silently remove a ghost',
    !calls.ghostsRemoved.includes('dispatch_failed'));
}

// (d) Relay/worker unreachable -- sendMessage throws. Same requirement: the
// error is surfaced on a pill, not swallowed into the console.
{
  const { fn, calls } = makeHarness({ throws: 'Could not establish connection.' });
  await fn(3, HELD_BLOCK, null);
  check('thrown dispatch error shows an explicit error pill', calls.failedBar.length === 1);
  check('error pill carries the thrown message',
    calls.failedBar[0]?.error === 'Could not establish connection.');
  check('thrown dispatch error does NOT mark the block spent', calls.markedKeys.length === 0);
  check('thrown dispatch error does not silently remove a ghost',
    !calls.ghostsRemoved.includes('dispatch_error'));
}

// (e) A plan-only block still has no job to dispatch -- the ghost is removed and
// no failure pill is invented. Guards against the fix turning every non-job
// block into a red error.
{
  const { fn, calls } = makeHarness({ response: { ok: true, id: 1 } });
  await fn(3, JSON.stringify({ name: 'Plan', thread: 'thread-abc', plan: [{ step: 'a' }] }), null);
  check('plan-only block does not dispatch', calls.dispatched.length === 0);
  check('plan-only block shows no failure pill', calls.failedBar.length === 0);
  check('plan-only block releases its ghost', calls.ghostsRemoved.includes('plan_only'));
}

console.log(failures === 0 ? '\nAll dispatch-anyway tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
