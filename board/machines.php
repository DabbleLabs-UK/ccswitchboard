<?php
declare(strict_types=1);

// Add-a-machine: the fleet view and the provisioning form (P1).
//
// Three jobs:
//   1. Show every machine the relay knows about -- alive (heartbeats),
//      provisioned (machines), or both -- with its job load.
//   2. Mint a machine: a token of its own, a `machines` row, and a grant in
//      auth.config.php's 'tokens' list. The token is then only ever emitted by
//      machine_installer.php, inside the .ps1 download. It is never shown on
//      this page, never logged, and never returned by ?data=1.
//   3. Revoke a machine: drop the grant, drop the row.
//
// Gated on the PRIMARY token, not the accepted set -- see requirePrimaryAuth()
// in auth.php for why minting must not be reachable with a machine's own token.

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requirePrimaryAuth();

$pdo = getDb();

// Fleet = heartbeats UNION machines, because neither table alone is the truth:
// the VM heartbeats but was never provisioned (it predates this page and runs
// on the primary token), and a freshly-minted box has a row but has never
// phoned home. A machine in one and not the other is a state worth SEEING, not
// an inconsistency to hide -- "provisioned, never started" is the normal
// halfway point of setting a box up, and "heartbeating, unmanaged" is the VM.
//
// Job counts come off jobs.target for BOTH pending and running, rather than
// pending-by-target and running-by-machine. target is the machine a job is FOR
// and is never null (defaults 'vm'); machine is stamped by poll.php only once
// running, and is null for jobs an older, pre-targeting agent picked up. Since
// poll.php only ever hands out jobs WHERE target = the polling machine, a
// running job's target IS the box running it -- so target gives the same answer
// as machine wherever machine is set, and a right answer where it isn't.
function fleetRows(PDO $pdo): array
{
    $counts = [];
    $rows = $pdo->query(
        "SELECT target,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
         FROM jobs
         WHERE status IN ('pending', 'running')
         GROUP BY target"
    )->fetchAll(PDO::FETCH_ASSOC);
    foreach ($rows as $row) {
        $counts[(string) $row['target']] = [
            'pending' => (int) $row['pending'],
            'running' => (int) $row['running'],
        ];
    }

    $beats = [];
    foreach ($pdo->query('SELECT machine, updated_at FROM heartbeats')->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $beats[(string) $row['machine']] = (string) $row['updated_at'];
    }

    $provisioned = [];
    foreach ($pdo->query('SELECT machine, created_at FROM machines')->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $provisioned[(string) $row['machine']] = (string) $row['created_at'];
    }

    $names = array_values(array_unique(array_merge(array_keys($beats), array_keys($provisioned))));
    sort($names, SORT_NATURAL | SORT_FLAG_CASE);

    $now = time();
    $out = [];
    foreach ($names as $name) {
        $lastBeat = $beats[$name] ?? null;
        $ageSeconds = $lastBeat !== null ? max(0, $now - strtotime($lastBeat)) : null;
        $isProvisioned = isset($provisioned[$name]);

        if ($ageSeconds === null) {
            $state = 'never-seen';       // minted, installer not run yet (or not reaching the relay)
        } elseif ($ageSeconds < AGENT_OFFLINE_AFTER_SECONDS) {
            $state = 'online';
        } else {
            $state = 'offline';
        }

        $out[] = [
            'machine' => $name,
            'provisioned' => $isProvisioned,
            'createdAt' => $provisioned[$name] ?? null,
            'lastBeat' => $lastBeat,
            'ageSeconds' => $ageSeconds,
            'state' => $state,
            'pending' => $counts[$name]['pending'] ?? 0,
            'running' => $counts[$name]['running'] ?? 0,
        ];
    }
    return $out;
}

// ---- JSON tick for the live-ish poll -------------------------------------
// Same shape the page renders server-side, minus anything secret. No token
// field, deliberately -- this is the endpoint most likely to get logged or
// left open in a tab.
if (isset($_GET['data'])) {
    jsonResponse(['machines' => fleetRows($pdo), 'offlineAfterSeconds' => AGENT_OFFLINE_AFTER_SECONDS]);
    exit;
}

// ---- Mint / revoke -------------------------------------------------------
// Post-Redirect-Get: a mint is not something to re-fire on refresh, and the
// result banner has to survive the redirect, so outcomes come back as query
// params. Only ever a machine NAME and a status word -- never the token.
$error = null;
$minted = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = (string) ($_POST['action'] ?? '');
    $machine = trim((string) ($_POST['machine'] ?? ''));
    $self = strtok((string) ($_SERVER['REQUEST_URI'] ?? 'machines.php'), '?');

    if (!isValidMachineName($machine)) {
        $error = 'Machine name must be 1-32 characters, letters/digits/underscore/hyphen only.';
    } elseif ($action === 'add') {
        $exists = $pdo->prepare('SELECT 1 FROM machines WHERE machine = :machine');
        $exists->execute(['machine' => $machine]);
        if ($exists->fetchColumn() !== false) {
            $error = 'A machine named "' . $machine . '" is already provisioned. Revoke it first to re-mint.';
        } else {
            // 32 bytes -> 64 hex, matching authToken()'s primary-token format.
            $token = bin2hex(random_bytes(32));

            // Order matters. The grant goes in auth.config.php FIRST, then the
            // row: if the write fails we throw before the row exists, and the
            // machine simply isn't provisioned -- retry and nothing is stale.
            // Row-first would risk a row whose token the relay never accepts,
            // which looks like provisioned-and-working right up until the
            // installer 401s on the box, miles from the cause.
            addAuthToken($token);

            $stmt = $pdo->prepare(
                'INSERT INTO machines (machine, token, created_at) VALUES (:machine, :token, :now)'
            );
            try {
                $stmt->execute(['machine' => $machine, 'token' => $token, 'now' => isoNow()]);
            } catch (Throwable $e) {
                // Don't leave a live grant with nothing pointing at it -- an
                // accepted token no page can show or revoke is exactly the kind
                // of thing that quietly accumulates.
                removeAuthToken($token);
                throw $e;
            }

            header('Location: ' . $self . '?minted=' . urlencode($machine));
            exit;
        }
    } elseif ($action === 'revoke') {
        $stmt = $pdo->prepare('SELECT token FROM machines WHERE machine = :machine');
        $stmt->execute(['machine' => $machine]);
        $token = $stmt->fetchColumn();
        if ($token === false) {
            $error = 'No provisioned machine named "' . $machine . '".';
        } else {
            // Grant first again, for the mirror-image reason: a row without a
            // grant is a dead installer, but a grant without a row is a token
            // nobody can see or revoke. Revoking the credential is the part
            // that actually matters, so it goes first and the row follows.
            removeAuthToken((string) $token);
            $del = $pdo->prepare('DELETE FROM machines WHERE machine = :machine');
            $del->execute(['machine' => $machine]);

            header('Location: ' . $self . '?revoked=' . urlencode($machine));
            exit;
        }
    } else {
        $error = 'Unknown action.';
    }
}

if (isset($_GET['minted']) && isValidMachineName((string) $_GET['minted'])) {
    $minted = (string) $_GET['minted'];
}
$revoked = isset($_GET['revoked']) && isValidMachineName((string) $_GET['revoked'])
    ? (string) $_GET['revoked']
    : null;

$machines = fleetRows($pdo);

// Same ea-nginx cache trap index.php documents: without the Set-Cookie in
// noCacheHeaders(), nginx caches this page and serves the stale copy -- here
// that would mean a fleet table frozen at whatever the first request saw.
noCacheHeaders(200);
header('Content-Type: text/html; charset=utf-8');

function h(?string $s): string
{
    return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Machines - CCSwitchboard</title>
<link rel="icon" href="favicon.ico">
<style>
  :root {
    --bg: #12141a;
    --panel: #181b22;
    --border: #2a2f3a;
    --text: #dfe3ec;
    --muted: #8a93a6;
    --accent: #6aa9ff;
    --ok: #4ec9a5;
    --warn: #e0b050;
    --err: #e06a6a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1000px; margin: 0 auto; }
  header.page {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 20px;
  }
  header.page h1 { font-size: 20px; margin: 0; }
  .back {
    margin-left: auto;
    color: var(--accent);
    text-decoration: none;
    font-size: 12.5px;
    font-weight: 600;
  }
  .back:hover { text-decoration: underline; }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 20px;
  }
  .panel h2 {
    margin: 0 0 12px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }
  table { width: 100%; border-collapse: collapse; }
  th, td {
    text-align: left;
    padding: 9px 10px;
    border-bottom: 1px solid var(--border);
  }
  th {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    font-weight: 600;
  }
  tbody tr:last-child td { border-bottom: none; }
  td.name { font-weight: 600; font-family: ui-monospace, Consolas, monospace; }
  .dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-right: 7px;
    vertical-align: middle;
  }
  .state-online  .dot { background: var(--ok); }
  .state-offline .dot { background: var(--err); }
  .state-never-seen .dot { background: var(--warn); }
  .state-label { font-size: 12.5px; }
  .state-online  .state-label { color: var(--ok); }
  .state-offline .state-label { color: var(--err); }
  .state-never-seen .state-label { color: var(--warn); }
  .sub { color: var(--muted); font-size: 11.5px; }
  .counts { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; }
  .counts .zero { color: var(--muted); }
  .btn {
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none;
    display: inline-block;
  }
  .btn:hover { filter: brightness(1.35); }
  .btn.primary { border-color: var(--accent); color: var(--accent); }
  .btn.danger { border-color: var(--err); color: var(--err); }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
  form.inline { display: inline; }
  .add-row { display: flex; gap: 10px; align-items: flex-start; flex-wrap: wrap; }
  input[type=text] {
    padding: 7px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    font: 13px ui-monospace, Consolas, monospace;
    min-width: 220px;
  }
  input[type=text]:focus { outline: none; border-color: var(--accent); }
  .note { color: var(--muted); font-size: 12px; margin-top: 10px; }
  .banner {
    border-radius: 8px;
    padding: 14px 16px;
    margin-bottom: 20px;
    border: 1px solid;
  }
  .banner.ok { border-color: var(--ok); background: rgba(78, 201, 165, 0.08); }
  .banner.err { border-color: var(--err); background: rgba(224, 106, 106, 0.08); }
  .banner h3 { margin: 0 0 8px; font-size: 14px; }
  .banner code {
    background: rgba(0,0,0,0.35);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 12.5px;
  }
  .banner ol { margin: 10px 0 0; padding-left: 20px; }
  .banner li { margin-bottom: 4px; }
  .empty { color: var(--muted); padding: 18px 10px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <header class="page">
    <img src="logo-64.png" alt="" width="28" height="28">
    <h1>Machines</h1>
    <a class="back" href="index.php">&larr; Board</a>
  </header>

<?php if ($error !== null): ?>
  <div class="banner err"><h3>Could not do that</h3><?php echo h($error); ?></div>
<?php endif; ?>

<?php if ($revoked !== null): ?>
  <div class="banner ok">
    <h3>Revoked <?php echo h($revoked); ?></h3>
    Its token no longer authenticates against the relay. Any agent still running
    on that box will start getting 401s -- uninstall it there
    (<code>schtasks /delete /tn CcswAgent /f</code>) when you get a chance.
  </div>
<?php endif; ?>

<?php if ($minted !== null): ?>
  <div class="banner ok">
    <h3>Provisioned <?php echo h($minted); ?></h3>
    <p style="margin:0">
      Download its installer and run it on the new machine. The script carries
      that machine's token, so treat it as a secret -- the relay will not show
      it again, and re-downloading is the only way to see it.
    </p>
    <ol>
      <li>Download <code>install-ccsw-<?php echo h($minted); ?>.ps1</code> below.</li>
      <li>Copy it to the new Windows machine.</li>
      <li>Run: <code>powershell -ExecutionPolicy Bypass -File install-ccsw-<?php echo h($minted); ?>.ps1</code></li>
      <li>Run <code>claude</code> once on that box to sign in (interactive -- the script can't).</li>
    </ol>
    <p style="margin:12px 0 0">
      <a class="btn primary" href="machine_installer.php?machine=<?php echo urlencode($minted); ?>">
        Download install-ccsw-<?php echo h($minted); ?>.ps1
      </a>
    </p>
  </div>
<?php endif; ?>

  <div class="panel">
    <h2>Fleet</h2>
    <table>
      <thead>
        <tr>
          <th>Machine</th>
          <th>State</th>
          <th>Last heartbeat</th>
          <th>Jobs</th>
          <th style="text-align:right">Actions</th>
        </tr>
      </thead>
      <tbody id="fleet">
<?php if ($machines === []): ?>
        <tr><td colspan="5" class="empty">No machines yet. Add one below.</td></tr>
<?php endif; ?>
<?php foreach ($machines as $m): ?>
        <tr>
          <td class="name">
            <?php echo h($m['machine']); ?>
            <?php if (!$m['provisioned']): ?>
              <div class="sub">unmanaged (no minted token)</div>
            <?php endif; ?>
          </td>
          <td class="state-<?php echo h($m['state']); ?>">
            <span class="dot"></span>
            <span class="state-label" data-state-for="<?php echo h($m['machine']); ?>">
              <?php
              echo $m['state'] === 'online' ? 'online'
                  : ($m['state'] === 'offline' ? 'offline' : 'never started');
              ?>
            </span>
          </td>
          <td class="sub" data-age-for="<?php echo h($m['machine']); ?>">
            <?php echo $m['ageSeconds'] === null ? 'never' : h((string) $m['ageSeconds']) . 's ago'; ?>
          </td>
          <td class="counts" data-counts-for="<?php echo h($m['machine']); ?>">
            <?php echo $m['running'] > 0 ? $m['running'] : '<span class="zero">0</span>'; ?> running /
            <?php echo $m['pending'] > 0 ? $m['pending'] : '<span class="zero">0</span>'; ?> pending
          </td>
          <td>
            <div class="actions">
<?php if ($m['provisioned']): ?>
              <a class="btn" href="machine_installer.php?machine=<?php echo urlencode($m['machine']); ?>">Installer</a>
              <form class="inline" method="post" onsubmit="return confirm('Revoke <?php echo h($m['machine']); ?>? Its token stops working immediately.');">
                <input type="hidden" name="action" value="revoke">
                <input type="hidden" name="machine" value="<?php echo h($m['machine']); ?>">
                <button class="btn danger" type="submit">Revoke</button>
              </form>
<?php else: ?>
              <span class="sub">&mdash;</span>
<?php endif; ?>
            </div>
          </td>
        </tr>
<?php endforeach; ?>
      </tbody>
    </table>
    <p class="note" id="poll-note">Heartbeat ages refresh every 5s. Offline after <?php echo AGENT_OFFLINE_AFTER_SECONDS; ?>s without a beat.</p>
  </div>

  <div class="panel">
    <h2>Add a machine</h2>
    <form method="post" class="add-row">
      <input type="hidden" name="action" value="add">
      <input type="text" name="machine" placeholder="DELL" pattern="[A-Za-z0-9_-]{1,32}" required
             title="1-32 characters: letters, digits, underscore, hyphen">
      <button class="btn primary" type="submit">Mint token + installer</button>
    </form>
    <p class="note">
      Mints a token for this machine and gives you a one-file PowerShell
      installer to run on it. The installer sets up .NET, Git, Node, Claude Code
      and the agent itself. Names are 1-32 characters of letters, digits,
      underscore or hyphen, and must match what you target jobs at.
    </p>
  </div>
</div>

<script>
// Light poll: refresh the volatile columns (age, state, counts) in place. The
// row set itself is only rebuilt by a real page load -- adding and revoking are
// form posts, so a machine can't appear or vanish between ticks without one.
const OFFLINE_AFTER = <?php echo AGENT_OFFLINE_AFTER_SECONDS; ?>;

function fmtAge(seconds) {
  if (seconds === null) return 'never';
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  return Math.floor(seconds / 86400) + 'd ago';
}

function stateLabel(state) {
  if (state === 'online') return 'online';
  if (state === 'offline') return 'offline';
  return 'never started';
}

async function tick() {
  try {
    const res = await fetch('machines.php?data=1', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    for (const m of data.machines) {
      const esc = (window.CSS && CSS.escape) ? CSS.escape(m.machine) : m.machine;

      const age = document.querySelector(`[data-age-for="${esc}"]`);
      if (age) age.textContent = fmtAge(m.ageSeconds);

      const label = document.querySelector(`[data-state-for="${esc}"]`);
      if (label) {
        label.textContent = stateLabel(m.state);
        // The dot and the text colour both hang off the <td>'s state- class,
        // so swap that rather than restyling two elements.
        const cell = label.closest('td');
        if (cell) cell.className = 'state-' + m.state;
      }

      const counts = document.querySelector(`[data-counts-for="${esc}"]`);
      if (counts) {
        const r = m.running > 0 ? String(m.running) : '<span class="zero">0</span>';
        const p = m.pending > 0 ? String(m.pending) : '<span class="zero">0</span>';
        counts.innerHTML = `${r} running / ${p} pending`;
      }
    }
  } catch (e) {
    // A failed tick is not worth surfacing -- the next one is 5s away, and the
    // page is still showing last-known-good rather than anything misleading.
  }
}

setInterval(tick, 5000);
tick();
</script>
</body>
</html>
