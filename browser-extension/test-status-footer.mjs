// Unit test for the always-on job-status footer (buildJobStatusFooter in
// content.js). Extracts the REAL source of the footer block out of content.js
// and evals it against stubbed pill state, so this tests the shipping code
// rather than a re-typed copy of it that could drift.
//
// Run: node test-status-footer.mjs
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./content.js', import.meta.url), 'utf8');

const START = "const STATUS_FOOTER_OPEN";
const END = "// background.js asks for this immediately before each insert";
const from = src.indexOf(START);
const to = src.indexOf(END);
if (from < 0 || to < 0 || to <= from) {
  console.error('FAIL: could not locate the footer block in content.js -- did it move or get renamed?');
  process.exit(1);
}
const block = src.slice(from, to);

// The block closes over exactly two things from content.js's scope.
// deliveringJobIds is what background.js passes at insert time -- the job(s)
// whose results are in the message the footer is riding on.
function makeFooter(entries, hydratedThread, deliveringJobIds = []) {
  const activeToolbarJobs = new Map(entries.map((e, i) => [e.key ?? `k${i}`, e]));
  // eslint-disable-next-line no-new-func
  const factory = new Function('activeToolbarJobs', 'hydratedThread', 'deliveringJobIds',
    `${block}; return buildJobStatusFooter(deliveringJobIds);`);
  return factory(activeToolbarJobs, hydratedThread, deliveringJobIds);
}

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) {
    console.log(`  expected:\n${JSON.stringify(expected)}`);
    console.log(`  actual:\n${JSON.stringify(actual)}`);
  }
}

const T = 'thread-abc';

// (a) one running job
check('one running job',
  makeFooter([{ jobId: 1, name: 'Fix Login', status: 'running', thread: T }], T),
  '[CCSW board]\nFix Login - running\n[/CCSW board]');

// (b) a running + held + repo-busy mix. The dropped entry carries BOTH
// dropped:true and a held field (job.php's 409 collision array) -- if state
// order regressed it would render as "held", so this is the ordering guard.
check('running + held + repo busy mix',
  makeFooter([
    { jobId: 1, name: 'Fix Login', status: 'running', thread: T },
    { jobId: 2, name: 'Sync Repo', held: true, thread: T },
    { jobId: 3, name: 'Build Docs - repo busy', dropped: true, held: [{ repo: 'V:/x' }], thread: T },
  ], T),
  '[CCSW board]\nFix Login - running\nSync Repo - held\nBuild Docs - repo busy\n[/CCSW board]');

// (c) zero jobs -> the explicit empty line. The core of the request: never
// silently absent.
check('zero jobs -> explicit empty line',
  makeFooter([], T),
  '[CCSW board]\n-- no active jobs --\n[/CCSW board]');

// (c2) zero OWED jobs, but finished pills still in the registry -> still the
// empty line, not a list of history.
check('only terminal jobs -> empty line',
  makeFooter([
    { jobId: 1, name: 'Fix Login', status: 'done', thread: T },
    { jobId: 2, name: 'Old Job', status: 'error', thread: T },
    { jobId: 3, name: 'Gone Job', status: 'cancelled', thread: T },
  ], T),
  '[CCSW board]\n-- no active jobs --\n[/CCSW board]');

// BUG A. A pending-delivery pill is a job that RAN and FINISHED; its result is
// queued for the composer. It is the opposite of held (= never dispatched), and
// must never be labelled so.
check('pending-delivery pill reads as delivering, NOT held',
  makeFooter([{ jobId: 7, label: 'Run Tests', pendingDelivery: true, state: 'pending', thread: T }], T),
  '[CCSW board]\nRun Tests - delivering\n[/CCSW board]');

// 'parked' needs a human, which waiting never fixes -- so it gets its own words
// rather than a generic wait label.
check('parked pending-delivery pill asks for a manual send, NOT held',
  makeFooter([{ jobId: 7, label: 'Run Tests', pendingDelivery: true, state: 'parked', thread: T }], T),
  '[CCSW board]\nRun Tests - needs manual send\n[/CCSW board]');

check('sent pending-delivery pill is terminal, not listed',
  makeFooter([{ jobId: 7, label: 'Run Tests', pendingDelivery: true, state: 'sent', thread: T }], T),
  '[CCSW board]\n-- no active jobs --\n[/CCSW board]');

// BUG A, the reported symptom: the job whose result this very message carries
// showed up in that message's own footer as 'held'. It is answered BY this
// message, so it must not be listed at all.
check('the job being delivered is excluded from its own footer',
  makeFooter([{ jobId: 7, label: 'Footer Ride', pendingDelivery: true, state: 'pending', thread: T }], T, [7]),
  '[CCSW board]\n-- no active jobs --\n[/CCSW board]');

// The delivering job goes; genuinely-owed neighbours stay.
check('delivering job excluded, other owed jobs still listed',
  makeFooter([
    { key: 'pd:7', jobId: 7, label: 'Footer Ride', pendingDelivery: true, state: 'pending', thread: T },
    { key: '8', jobId: 8, name: 'Other Job', status: 'running', thread: T },
  ], T, [7]),
  '[CCSW board]\nOther Job - running\n[/CCSW board]');

// A batched send delivers several results in one message: none of them are owed.
check('batched delivery excludes every job it carries',
  makeFooter([
    { key: 'pd:7', jobId: 7, label: 'Job Seven', pendingDelivery: true, state: 'pending', thread: T },
    { key: 'pd:8', jobId: 8, label: 'Job Eight', pendingDelivery: true, state: 'pending', thread: T },
    { key: '9', jobId: 9, name: 'Still Going', status: 'running', thread: T },
  ], T, [7, 8]),
  '[CCSW board]\nStill Going - running\n[/CCSW board]');

// Exclusion is by JOB, not by pill: a just-finished job can still hold a stale
// 'running' pill next to its pending-delivery one. Dropping only the latter
// would resurrect it as "running" in the message delivering it.
check('delivering job excluded even if a stale running pill lingers',
  makeFooter([
    { key: '7', jobId: 7, name: 'Footer Ride', status: 'running', thread: T },
    { key: 'pd:7', jobId: 7, label: 'Footer Ride', pendingDelivery: true, state: 'pending', thread: T },
  ], T, [7]),
  '[CCSW board]\n-- no active jobs --\n[/CCSW board]');

// jobIds cross the runtime.sendMessage boundary as JSON; don't let 7 !== '7'
// silently defeat the exclusion.
check('delivering jobId matches across string/number types',
  makeFooter([{ jobId: 7, label: 'Footer Ride', pendingDelivery: true, state: 'pending', thread: T }], T, ['7']),
  '[CCSW board]\n-- no active jobs --\n[/CCSW board]');

// A held job is still held while an unrelated job delivers -- the real 'held'
// (stale-replay guard, never dispatched) must survive the Bug A fix.
check('genuine held survives alongside a delivering job',
  makeFooter([
    { key: 'pd:7', jobId: 7, label: 'Footer Ride', pendingDelivery: true, state: 'pending', thread: T },
    { key: '8', jobId: 8, name: 'Sync Repo', held: true, thread: T },
  ], T, [7]),
  '[CCSW board]\nSync Repo - held\n[/CCSW board]');

// No deliveringJobIds (unknown/legacy caller) must not start hiding jobs.
check('absent deliveringJobIds excludes nothing',
  makeFooter([{ jobId: 7, label: 'Run Tests', pendingDelivery: true, state: 'pending', thread: T }], T),
  '[CCSW board]\nRun Tests - delivering\n[/CCSW board]');

// Another thread's pill must not leak into this thread's footer.
check('other thread excluded',
  makeFooter([
    { jobId: 1, name: 'Mine Job', status: 'running', thread: T },
    { jobId: 2, name: 'Their Job', status: 'running', thread: 'other-thread' },
  ], T),
  '[CCSW board]\nMine Job - running\n[/CCSW board]');

// A pill with no thread was built by this tab, so it counts.
check('untagged pill counts as this thread',
  makeFooter([{ jobId: 1, name: 'Local Job', status: 'running', thread: null }], T),
  '[CCSW board]\nLocal Job - running\n[/CCSW board]');

// Same job holding a running pill AND its pending-delivery pill: reported
// once, at the later stage.
check('duplicate jobId dedupes to the later stage',
  makeFooter([
    { key: '9', jobId: 9, name: 'Twin Job', status: 'running', thread: T },
    { key: 'pd:9', jobId: 9, label: 'Twin Job', pendingDelivery: true, state: 'pending', thread: T },
  ], T),
  '[CCSW board]\nTwin Job - delivering\n[/CCSW board]');

// pending == the agent hasn't claimed it yet; still active, reads as running.
check('pending status reads as running',
  makeFooter([{ jobId: 1, name: 'Queued Job', status: 'pending', thread: T }], T),
  '[CCSW board]\nQueued Job - running\n[/CCSW board]');

// Unhydrated tab (no thread known): show this tab's pills rather than nothing.
check('unhydrated tab still lists its pills',
  makeFooter([{ jobId: 1, name: 'Fix Login', status: 'running', thread: T }], null),
  '[CCSW board]\nFix Login - running\n[/CCSW board]');

// Nameless pill must not render "undefined - running".
check('missing name falls back to Job',
  makeFooter([{ jobId: 1, status: 'running', thread: T }], T),
  '[CCSW board]\nJob - running\n[/CCSW board]');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
