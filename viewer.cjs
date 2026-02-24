#!/usr/bin/env node
'use strict';

/**
 * BSV Trust Viewer — bonds + assertions dashboard
 * Usage: node viewer.cjs [--port 3005]
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const PORT = parseInt(process.argv.find((a, i) => process.argv[i - 1] === '--port') || '3005');
const BONDS_DIR = path.join(__dirname, 'bonds');
const ESCROWS_DIR = path.join(__dirname, 'escrows');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error(`Bad JSON: ${d.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

async function getBondStatus(bond) {
  let spent = null;
  try {
    spent = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/tx/${bond.bondTxid}/0/spent`);
  } catch {}

  const chainInfo = await httpGet('https://api.whatsonchain.com/v1/bsv/main/chain/info');
  const currentHeight = chainInfo.blocks;

  const isSpent = spent && spent.txid;
  const isLocked = currentHeight < bond.lockUntil;
  const blocksLeft = isLocked ? bond.lockUntil - currentHeight : 0;

  let status = 'ACTIVE';
  let statusEmoji = '🔐';
  let spentTxid = null;
  let spentBy = null;

  if (isSpent) {
    spentTxid = spent.txid;
    try {
      const spentTx = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/tx/${spent.txid}`);
      if (spentTx && spentTx.vout) {
        const destAddr = spentTx.vout[0]?.scriptPubKey?.addresses?.[0];
        if (destAddr === bond.bondholderAddress) {
          status = 'RELEASED'; statusEmoji = '🔓'; spentBy = 'bondholder';
        } else if (destAddr === bond.slashDest) {
          status = 'SLASHED'; statusEmoji = '⚡'; spentBy = 'slasher';
        } else {
          status = 'SPENT'; statusEmoji = '❓'; spentBy = 'unknown';
        }
      }
    } catch {}
  }

  return { ...bond, currentHeight, isSpent, isLocked, blocksLeft, status, statusEmoji, spentTxid, spentBy };
}

async function scanAssertions(bonds) {
  // Scan bondholder addresses for ASSERT1 transactions
  const assertions = [];
  const addresses = [...new Set(bonds.map(b => b.bondholderAddress))];

  for (const addr of addresses) {
    try {
      const history = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/address/${addr}/history`);
      if (!history || !Array.isArray(history)) continue;

      for (const entry of history) {
        try {
          const tx = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/tx/${entry.tx_hash}`);
          if (!tx || !tx.vout) continue;

          for (const vout of tx.vout) {
            if (!vout.scriptPubKey || vout.scriptPubKey.type !== 'nulldata') continue;
            const hex = vout.scriptPubKey.hex;
            // Check for ASSERT1 in the script
            if (!hex.includes(Buffer.from('ASSERT1').toString('hex'))) continue;

            // Parse the OP_RETURN
            const parsed = parseAssertOpReturn(hex);
            if (!parsed) continue;

            // Find matching bond
            const bond = bonds.find(b => b.bondTxid === parsed.bondTxid);

            assertions.push({
              txid: entry.tx_hash,
              blockHeight: entry.height,
              asserter: addr,
              ...parsed,
              bondStatus: bond ? bond.status : 'UNKNOWN',
              bondAmount: bond ? bond.amount : 0,
            });
          }
        } catch {}
      }
    } catch {}
  }

  return assertions.sort((a, b) => (b.blockHeight || 0) - (a.blockHeight || 0));
}

function parseAssertOpReturn(hex) {
  try {
    const { bsv } = require('scrypt-ts');
    const script = bsv.Script.fromHex(hex);
    const pushes = [];
    for (const chunk of script.chunks) {
      if (chunk.buf) pushes.push(chunk.buf);
    }
    if (pushes.length < 5) return null;
    const prefix = pushes[0].toString('utf8');
    if (prefix !== 'ASSERT1') return null;

    const version = pushes[1][0];
    const bondTxid = Buffer.from(pushes[2]).reverse().toString('hex');
    const topic = pushes[3].toString('utf8');
    const claim = pushes[4].toString('utf8');

    return { version, bondTxid, topic, claim };
  } catch {
    return null;
  }
}

async function getEscrowStatus(escrow) {
  let spent = null;
  try {
    spent = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/tx/${escrow.escrowTxid}/0/spent`);
  } catch {}

  const chainInfo = await httpGet('https://api.whatsonchain.com/v1/bsv/main/chain/info');
  const currentHeight = chainInfo.blocks;

  const isSpent = spent && spent.txid;
  const isTimedOut = currentHeight >= escrow.timeoutBlock;
  const blocksLeft = isTimedOut ? 0 : escrow.timeoutBlock - currentHeight;

  let status = 'ACTIVE';
  let statusEmoji = '💰';
  let spentTxid = null;
  let spentBy = null;

  if (isSpent) {
    spentTxid = spent.txid;
    try {
      const spentTx = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/tx/${spent.txid}`);
      if (spentTx && spentTx.vout) {
        const destAddr = spentTx.vout[0]?.scriptPubKey?.addresses?.[0];
        if (destAddr === escrow.workerAddress) {
          status = 'APPROVED'; statusEmoji = '✅'; spentBy = 'requester → worker';
        } else if (destAddr === escrow.requesterAddress) {
          // Could be refund or timeout
          status = 'RETURNED'; statusEmoji = '↩️'; spentBy = 'refund/timeout';
        } else {
          status = 'SPENT'; statusEmoji = '❓'; spentBy = 'unknown';
        }
      }
    } catch {}
  }

  return { ...escrow, currentHeight, isSpent, isTimedOut, blocksLeft, status, statusEmoji, spentTxid, spentBy };
}

async function loadAndCheckEscrows() {
  if (!fs.existsSync(ESCROWS_DIR)) return [];
  const files = fs.readdirSync(ESCROWS_DIR).filter(f => f.endsWith('.json'));
  const escrows = [];
  for (const file of files) {
    const escrow = JSON.parse(fs.readFileSync(path.join(ESCROWS_DIR, file), 'utf-8'));
    const status = await getEscrowStatus(escrow);
    escrows.push(status);
  }
  return escrows.sort((a, b) => (b.blockHeight || 0) - (a.blockHeight || 0));
}

function renderHTML(bonds, assertions, escrows, currentHeight) {
  const bondRows = bonds.map(b => `
    <tr class="bond-row ${b.status.toLowerCase()}">
      <td><span class="status-badge ${b.status.toLowerCase()}">${b.statusEmoji} ${b.status}</span></td>
      <td><a href="https://whatsonchain.com/tx/${b.bondTxid}" target="_blank" class="txid">${b.bondTxid.slice(0, 16)}...</a></td>
      <td class="sats">${b.amount.toLocaleString()} sats</td>
      <td><span class="addr">${b.bondholderAddress.slice(0, 12)}...</span></td>
      <td><span class="addr">${b.slasherAddress.slice(0, 12)}...</span></td>
      <td>${b.isSpent ? '—' : b.isLocked
        ? `<span class="locked">🔒 ${b.blocksLeft} blocks</span>`
        : '<span class="unlocked">✅ Unlocked</span>'}</td>
      <td>Block ${b.lockUntil}</td>
      <td>${b.spentTxid
        ? `<a href="https://whatsonchain.com/tx/${b.spentTxid}" target="_blank" class="txid">${b.spentTxid.slice(0, 12)}...</a> (${b.spentBy})`
        : '—'}</td>
    </tr>`).join('');

  const assertRows = assertions.map(a => `
    <tr class="assert-row">
      <td><a href="https://whatsonchain.com/tx/${a.txid}" target="_blank" class="txid">${a.txid.slice(0, 16)}...</a></td>
      <td><span class="topic">${a.topic}</span></td>
      <td class="claim-text">${escapeHtml(a.claim)}</td>
      <td><a href="https://whatsonchain.com/tx/${a.bondTxid}" target="_blank" class="txid">${a.bondTxid.slice(0, 12)}...</a></td>
      <td class="sats">${a.bondAmount.toLocaleString()} sats</td>
      <td><span class="status-badge ${a.bondStatus.toLowerCase()}">${a.bondStatus}</span></td>
      <td><span class="addr">${a.asserter.slice(0, 12)}...</span></td>
      <td>${a.blockHeight > 0 ? `Block ${a.blockHeight}` : 'Unconfirmed'}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head>
<title>BSV Trust — Viewer</title>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Fira Code', monospace;
    background: #0a0a0a;
    color: #e0e0e0;
    padding: 24px;
  }
  h1 { font-size: 24px; margin-bottom: 8px; color: #fff; }
  h2 { font-size: 18px; margin: 32px 0 16px; color: #fff; }
  .subtitle { color: #666; font-size: 13px; margin-bottom: 24px; }
  .stats { display: flex; gap: 24px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat {
    background: #141414; border: 1px solid #222;
    border-radius: 8px; padding: 16px 24px;
  }
  .stat-label { color: #666; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
  .stat-value { font-size: 24px; color: #fff; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th {
    text-align: left; padding: 10px 12px; color: #666;
    font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
    border-bottom: 1px solid #222;
  }
  td { padding: 12px; border-bottom: 1px solid #1a1a1a; }
  .txid { color: #4a9eff; text-decoration: none; font-family: inherit; }
  .txid:hover { text-decoration: underline; }
  .addr { color: #888; }
  .sats { color: #f5a623; font-weight: bold; }
  .topic { color: #a78bfa; background: #1a1a2e; padding: 2px 8px; border-radius: 4px; font-size: 12px; }
  .claim-text { color: #d1d5db; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status-badge {
    padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: bold;
  }
  .status-badge.active { background: #1a3a1a; color: #4ade80; }
  .status-badge.released { background: #1a2a3a; color: #60a5fa; }
  .status-badge.slashed { background: #3a1a1a; color: #f87171; }
  .status-badge.spent { background: #2a2a1a; color: #fbbf24; }
  .status-badge.unknown { background: #2a2a2a; color: #888; }
  .locked { color: #f87171; }
  .unlocked { color: #4ade80; }
  .status-badge.approved { background: #1a3a1a; color: #4ade80; }
  .status-badge.returned { background: #1a2a3a; color: #60a5fa; }
  .bond-row:hover, .assert-row:hover, .escrow-row:hover { background: #141414; }
  .section-divider { border-top: 1px solid #222; margin-top: 32px; padding-top: 8px; }
  .footer { margin-top: 24px; color: #444; font-size: 11px; }
</style>
</head>
<body>
  <h1>🔐 BSV Trust</h1>
  <div class="subtitle">Bonds, assertions, and trust — backed by locked sats. Auto-refreshes every 30s.</div>

  <div class="stats">
    <div class="stat">
      <div class="stat-label">Bonds</div>
      <div class="stat-value">${bonds.length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Active Bonds</div>
      <div class="stat-value">${bonds.filter(b => b.status === 'ACTIVE').length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Total Locked</div>
      <div class="stat-value">${bonds.filter(b => b.status === 'ACTIVE').reduce((s, b) => s + b.amount, 0).toLocaleString()} sats</div>
    </div>
    <div class="stat">
      <div class="stat-label">Escrows</div>
      <div class="stat-value">${escrows.length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Assertions</div>
      <div class="stat-value">${assertions.length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">Block Height</div>
      <div class="stat-value">${currentHeight}</div>
    </div>
  </div>

  <h2>📜 Bonds</h2>
  <table>
    <thead>
      <tr>
        <th>Status</th><th>Bond TX</th><th>Amount</th><th>Bondholder</th>
        <th>Slasher</th><th>Time Lock</th><th>Unlock Block</th><th>Resolution</th>
      </tr>
    </thead>
    <tbody>
      ${bondRows || '<tr><td colspan="8" style="text-align:center;color:#666;padding:40px">No bonds found</td></tr>'}
    </tbody>
  </table>

  <div class="section-divider"></div>
  <h2>💰 Escrows</h2>
  <table>
    <thead>
      <tr>
        <th>Status</th><th>Escrow TX</th><th>Amount</th><th>Requester</th>
        <th>Worker</th><th>Timeout</th><th>Resolution</th>
      </tr>
    </thead>
    <tbody>
      ${escrows.map(e => `
    <tr class="escrow-row ${e.status.toLowerCase()}">
      <td><span class="status-badge ${e.status.toLowerCase()}">${e.statusEmoji} ${e.status}</span></td>
      <td><a href="https://whatsonchain.com/tx/${e.escrowTxid}" target="_blank" class="txid">${e.escrowTxid.slice(0, 16)}...</a></td>
      <td class="sats">${e.amount.toLocaleString()} sats</td>
      <td><span class="addr">${e.requesterAddress.slice(0, 12)}...</span></td>
      <td><span class="addr">${e.workerAddress.slice(0, 12)}...</span></td>
      <td>${e.isSpent ? '—' : e.isTimedOut
        ? '<span class="unlocked">⏰ Expired</span>'
        : `<span class="locked">🔒 ${e.blocksLeft} blocks</span>`}</td>
      <td>${e.spentTxid
        ? `<a href="https://whatsonchain.com/tx/${e.spentTxid}" target="_blank" class="txid">${e.spentTxid.slice(0, 12)}...</a> (${e.spentBy})`
        : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;color:#666;padding:40px">No escrows found</td></tr>'}
    </tbody>
  </table>

  <div class="section-divider"></div>
  <h2>📢 Assertions (ASSERT1)</h2>
  <table>
    <thead>
      <tr>
        <th>TX</th><th>Topic</th><th>Claim</th><th>Bond</th>
        <th>Bond Amount</th><th>Bond Status</th><th>Asserter</th><th>Block</th>
      </tr>
    </thead>
    <tbody>
      ${assertRows || '<tr><td colspan="8" style="text-align:center;color:#666;padding:40px">No assertions found</td></tr>'}
    </tbody>
  </table>

  <div class="footer">
    BSV Trust — No authority, no platform. Trust backed by locked sats.
    <br>Block ${currentHeight} · ${new Date().toISOString()}
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/bonds') {
    try {
      const bonds = await loadAndCheckBonds();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(bonds, null, 2));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url === '/api/assertions') {
    try {
      const bonds = await loadAndCheckBonds();
      const assertions = await scanAssertions(bonds);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(assertions, null, 2));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.url === '/api/escrows') {
    try {
      const escrows = await loadAndCheckEscrows();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(escrows, null, 2));
    } catch (err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  try {
    const bonds = await loadAndCheckBonds();
    const assertions = await scanAssertions(bonds);
    const escrows = await loadAndCheckEscrows();
    const currentHeight = bonds.length > 0 ? bonds[0].currentHeight : (escrows.length > 0 ? escrows[0].currentHeight : '?');
    const html = renderHTML(bonds, assertions, escrows, currentHeight);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch (err) {
    res.writeHead(500); res.end(`Error: ${err.message}`);
  }
});

async function loadAndCheckBonds() {
  if (!fs.existsSync(BONDS_DIR)) return [];
  const files = fs.readdirSync(BONDS_DIR).filter(f => f.endsWith('.json'));
  const bonds = [];
  for (const file of files) {
    const bond = JSON.parse(fs.readFileSync(path.join(BONDS_DIR, file), 'utf-8'));
    const status = await getBondStatus(bond);
    bonds.push(status);
  }
  return bonds.sort((a, b) => (b.blockHeight || 0) - (a.blockHeight || 0));
}

server.listen(PORT, () => {
  console.log(`🔐 BSV Trust Viewer running at http://localhost:${PORT}`);
  console.log(`   Watching: ${BONDS_DIR}`);
});
