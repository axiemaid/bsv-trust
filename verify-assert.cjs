#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const https = require('https');
const { bsv } = require('scrypt-ts');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const key = process.argv[i].replace(/^--/, '');
    args[key] = process.argv[++i];
  }
}

const TXID = args.txid;
if (!TXID) {
  console.log('Usage: node verify-assert.cjs --txid <assert-txid>');
  process.exit(1);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Accept: 'application/json' } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { reject(new Error(`Bad JSON: ${d.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

function httpGetRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d.trim()));
    }).on('error', reject);
  });
}

async function main() {
  console.log('🔍 ASSERT1 — Verifying Assertion');
  console.log(`   TXID: ${TXID}`);
  console.log();

  // Fetch the assertion tx
  const txData = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/tx/${TXID}`);

  // Find OP_RETURN output
  let opReturnHex = null;
  for (const vout of txData.vout) {
    if (vout.scriptPubKey && vout.scriptPubKey.type === 'nulldata') {
      opReturnHex = vout.scriptPubKey.hex;
      break;
    }
  }

  if (!opReturnHex) {
    console.error('❌ No OP_RETURN found in transaction');
    process.exit(1);
  }

  // Parse OP_RETURN script
  const script = bsv.Script.fromHex(opReturnHex);
  const chunks = script.chunks;

  // Expected: OP_FALSE OP_RETURN <ASSERT1> <version> <bondTxid> <topic> <claim> <sig>
  // chunks[0] = OP_FALSE, chunks[1] = OP_RETURN, chunks[2..] = data pushes
  const dataPushes = [];
  for (const chunk of chunks) {
    if (chunk.buf) dataPushes.push(chunk.buf);
  }

  if (dataPushes.length < 5) {
    console.error('❌ Not enough data pushes in OP_RETURN');
    process.exit(1);
  }

  const prefix = dataPushes[0].toString('utf8');
  if (prefix !== 'ASSERT1') {
    console.error(`❌ Not an ASSERT1 transaction (prefix: ${prefix})`);
    process.exit(1);
  }

  const version = dataPushes[1][0];
  const bondTxidLE = dataPushes[2];
  const bondTxid = Buffer.from(bondTxidLE).reverse().toString('hex');
  const topic = dataPushes[3].toString('utf8');
  const claim = dataPushes[4].toString('utf8');
  const sigDER = dataPushes[5];

  console.log('   Protocol: ASSERT1');
  console.log(`   Version:  ${version}`);
  console.log(`   Bond:     ${bondTxid}`);
  console.log(`   Topic:    ${topic}`);
  console.log(`   Claim:    ${claim}`);
  console.log();

  // Check bond status
  console.log('   Checking bond...');
  const bondTx = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/tx/${bondTxid}`);
  if (!bondTx || bondTx.error) {
    console.error(`❌ Bond tx not found: ${bondTxid}`);
    process.exit(1);
  }

  const bondAmount = bondTx.vout[0] ? Math.round(bondTx.vout[0].value * 1e8) : 0;

  // Check if bond is still unspent
  let bondActive = true;
  try {
    const spentInfo = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/tx/${bondTxid}/out/0/spent`);
    if (spentInfo && spentInfo.txid) {
      bondActive = false;
    }
  } catch (e) {
    // If 404 or error, assume unspent
  }

  if (bondActive) {
    console.log(`   ✅ Bond ACTIVE — ${bondAmount} sats at stake`);
  } else {
    console.log(`   ⚠️  Bond SPENT — assertion no longer backed`);
  }

  // Get the asserter's public key from the tx input (the signer)
  const vin = txData.vin[0];
  const inputScript = bsv.Script.fromHex(vin.scriptSig.hex);
  const inputChunks = inputScript.chunks;
  // P2PKH input: <sig> <pubkey>
  const asserterPubKeyBuf = inputChunks[1].buf;
  const asserterPubKey = bsv.PublicKey.fromBuffer(asserterPubKeyBuf);

  console.log(`   Asserter: ${asserterPubKey.toAddress().toString()}`);

  // Verify signature: SHA256(bondTxid + topic + claim)
  const msgBuf = Buffer.concat([
    Buffer.from(bondTxid, 'hex'),
    Buffer.from(topic, 'utf8'),
    Buffer.from(claim, 'utf8'),
  ]);
  const msgHash = crypto.createHash('sha256').update(msgBuf).digest();

  try {
    const ecSig = bsv.crypto.Signature.fromDER(sigDER);
    const ecdsa = new bsv.crypto.ECDSA();
    ecdsa.hashbuf = msgHash;
    ecdsa.sig = ecSig;
    ecdsa.pubkey = asserterPubKey;
    ecdsa.verify();
    const verified = ecdsa.verified;

    console.log();
    if (verified) {
      console.log('═══════════════════════════════════════════════');
      console.log('   ✅ ASSERTION VERIFIED');
      console.log(`   "${claim}"`);
      console.log(`   Topic:    ${topic}`);
      console.log(`   Asserter: ${asserterPubKey.toAddress().toString()}`);
      console.log(`   Bond:     ${bondActive ? `${bondAmount} sats (active)` : 'SPENT (no backing)'}`);
      console.log('═══════════════════════════════════════════════');
    } else {
      console.log('   ❌ SIGNATURE INVALID — assertion cannot be trusted');
    }
  } catch (err) {
    console.error(`❌ Signature verification error: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
