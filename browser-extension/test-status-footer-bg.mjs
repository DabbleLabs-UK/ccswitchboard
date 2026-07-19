// Integration test for background.js's fetchStatusFooter -- the half that
// decides whether a send carries a footer at all. Extracts the REAL function
// source out of background.js and runs it against a stubbed chrome API.
//
// Run: node test-status-footer-bg.mjs
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./background.js', import.meta.url), 'utf8');

const START = 'async function fetchStatusFooter(tabId, deliveringJobIds = []) {';
const from = src.indexOf(START);
const to = src.indexOf('\n}', from);
if (from < 0 || to < 0) {
  console.error('FAIL: could not locate fetchStatusFooter in background.js -- did it move or get renamed?');
  process.exit(1);
}
const block = src.slice(from, to + 2);

function makeFetcher({ enabled, respond }) {
  const chrome = { tabs: { sendMessage: respond } };
  const getPiggybackProbeEnabled = async () => enabled;
  const console_ = { warn() {} }; // silence the expected unreachable-tab warning
  // eslint-disable-next-line no-new-func
  const factory = new Function('chrome', 'getPiggybackProbeEnabled', 'console',
    `${block}; return fetchStatusFooter;`);
  return factory(chrome, getPiggybackProbeEnabled, console_);
}

let failures = 0;
async function check(label, fetcher, expected) {
  const actual = await fetcher(42);
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`);
  if (!ok) console.log(`  expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const FOOTER = '[CCSW board]\nFix Login - running\n[/CCSW board]';

// The flag stays the on/off switch for the whole feature.
await check('flag OFF -> no footer',
  makeFetcher({ enabled: false, respond: async () => ({ footer: FOOTER }) }), '');

// Flag on: footer arrives as its own block, separated from the body.
await check('flag ON -> footer appended as its own block',
  makeFetcher({ enabled: true, respond: async () => ({ footer: FOOTER }) }), `\n\n${FOOTER}`);

// Empty state still rides -- it is NOT the same as "no footer".
const EMPTY = '[CCSW board]\n-- no active jobs --\n[/CCSW board]';
await check('empty-state footer still appended',
  makeFetcher({ enabled: true, respond: async () => ({ footer: EMPTY }) }), `\n\n${EMPTY}`);

// A footer must never be able to fail a delivery.
await check('unreachable tab -> delivery proceeds without footer',
  makeFetcher({ enabled: true, respond: async () => { throw new Error('Could not establish connection'); } }), '');

await check('no response -> delivery proceeds without footer',
  makeFetcher({ enabled: true, respond: async () => undefined }), '');

await check('malformed response -> delivery proceeds without footer',
  makeFetcher({ enabled: true, respond: async () => ({ footer: 123 }) }), '');

// Verify the tab actually asked is the one being delivered to.
let askedTab = null;
await check('asks the delivery target tab',
  makeFetcher({ enabled: true, respond: async (tabId) => { askedTab = tabId; return { footer: FOOTER }; } }),
  `\n\n${FOOTER}`);
const okTab = askedTab === 42;
if (!okTab) failures++;
console.log(`${okTab ? 'PASS' : 'FAIL'}: tab id forwarded (got ${askedTab})`);

// BUG A: the ids of the job(s) this insert carries have to reach content.js, or
// it cannot exclude them and lists them as owed in the message answering them.
let askedMsg = null;
const capture = makeFetcher({ enabled: true, respond: async (_tabId, msg) => { askedMsg = msg; return { footer: FOOTER }; } });
await capture(42, [7, 8]);
const okIds = JSON.stringify(askedMsg?.deliveringJobIds) === JSON.stringify([7, 8]);
if (!okIds) failures++;
console.log(`${okIds ? 'PASS' : 'FAIL'}: deliveringJobIds forwarded (got ${JSON.stringify(askedMsg?.deliveringJobIds)})`);

// A non-wake entry has jobId null; that must not reach content.js as a real id.
askedMsg = null;
const capture2 = makeFetcher({ enabled: true, respond: async (_tabId, msg) => { askedMsg = msg; return { footer: FOOTER }; } });
await capture2(42, [null, 5, undefined]);
const okFilter = JSON.stringify(askedMsg?.deliveringJobIds) === JSON.stringify([5]);
if (!okFilter) failures++;
console.log(`${okFilter ? 'PASS' : 'FAIL'}: null/undefined jobIds filtered out (got ${JSON.stringify(askedMsg?.deliveringJobIds)})`);

// Callers that pass nothing must still work (the arg defaults, not throws).
askedMsg = null;
const capture3 = makeFetcher({ enabled: true, respond: async (_tabId, msg) => { askedMsg = msg; return { footer: FOOTER }; } });
const noArgs = await capture3(42);
const okDefault = noArgs === `\n\n${FOOTER}` && JSON.stringify(askedMsg?.deliveringJobIds) === '[]';
if (!okDefault) failures++;
console.log(`${okDefault ? 'PASS' : 'FAIL'}: omitted deliveringJobIds defaults to []`);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
