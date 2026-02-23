#!/usr/bin/env node
'use strict';

/**
 * Release a bond after the time lock expires.
 *
 * Usage: node release-bond.cjs --txid <bond-txid> --wallet <bondholder-wallet>
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { Bond } = require('./dist/src/contracts/bond');
const { bsv, toByteString, PubKeyHash, PubKey, Sig, DefaultProvider, TestWallet } = require('scrypt-ts');

const ARTIFACT_PATH = path.join(__dirname, 'artifacts/bond.json');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const TXID = args.txid;
const WALLET_PATH = args.wallet || path.join(__dirname, 'wallet.json');

if (!TXID) {
  console.log('Usage: node release-bond.cjs --txid <bond-txid> --wallet <path>');
  process.exit(1);
}

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

function wocGetRaw(endpoint) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.whatsonchain.com/v1/bsv/main${endpoint}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d.trim()));
    }).on('error', reject);
  });
}

function wocBroadcast(txhex) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ txhex });
    const req = https.request({
      hostname: 'api.whatsonchain.com',
      path: '/v1/bsv/main/tx/raw',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error(`Broadcast failed (${res.statusCode}): ${d}`));
        else resolve(d.replace(/"/g, '').trim());
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function release() {
  if (!fs.existsSync(WALLET_PATH)) {
    console.error(`Wallet not found: ${WALLET_PATH}`);
    process.exit(1);
  }

  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
  const bondholderKey = bsv.PrivateKey.fromWIF(wallet.wif);
  const bondholderAddr = bondholderKey.toAddress();

  // Load artifact
  Bond.loadArtifact(require(ARTIFACT_PATH));

  // Check if UTXO is still unspent
  const spentInfo = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/tx/${TXID}/0/spent`).catch(() => null);
  if (spentInfo && spentInfo.txid) {
    console.error('❌ Bond already spent.');
    process.exit(1);
  }

  // Fetch bond tx
  const txHex = await wocGetRaw(`/tx/${TXID}/hex`);
  const bsvTx = new bsv.Transaction(txHex);

  // Reconstruct bond from tx
  const provider = new DefaultProvider({ network: bsv.Networks.mainnet });
  const signer = new TestWallet(bondholderKey, provider);
  await provider.connect();

  const bond = Bond.fromTx(bsvTx, 0);
  await bond.connect(signer);

  const bondAmount = Number(bond.balance);
  const lockUntil = Number(bond.lockUntil);

  // Get current height
  const chainInfo = await httpGet('https://api.whatsonchain.com/v1/bsv/main/chain/info');
  const currentHeight = chainInfo.blocks;

  console.log('🔓 Releasing Bond');
  console.log(`   Bond:    ${TXID.slice(0, 16)}...`);
  console.log(`   Amount:  ${bondAmount} sats`);
  console.log(`   Lock:    block ${lockUntil} (current: ${currentHeight})`);

  if (currentHeight < lockUntil) {
    console.error(`❌ Bond still locked. ${lockUntil - currentHeight} blocks remaining.`);
    process.exit(1);
  }

  console.log(`   Status:  ✅ Unlocked (${currentHeight - lockUntil} blocks past lock)`);

  // Build release tx
  const FEE = 1000;

  bond.bindTxBuilder('release', (current, options) => {
    const unsignedTx = new bsv.Transaction();
    unsignedTx.addInput(current.buildContractInput());

    // Pay back to bondholder
    unsignedTx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildPublicKeyHashOut(bondholderAddr),
      satoshis: bondAmount - FEE,
    }));

    // Set nLockTime to satisfy the covenant's locktime check
    unsignedTx.nLockTime = currentHeight;
    // Set sequence to allow nLockTime
    unsignedTx.inputs[0].sequenceNumber = 0xFFFFFFFE;

    return Promise.resolve({
      tx: unsignedTx,
      atInputIndex: 0,
      nexts: [],
    });
  });

  console.log('   Building transaction...');

  const callResult = await bond.methods.release(
    (sigResps) => {
      return sigResps.find(s => s.pubKey === bondholderKey.toPublicKey().toHex()).sig;
    },
    { autoPayFee: false, partiallySigned: true, estimateFee: false }
  );

  const txhex = callResult.tx.uncheckedSerialize();
  console.log(`   TX size: ${txhex.length / 2} bytes`);
  console.log('   Broadcasting...');

  const txid = await wocBroadcast(txhex);

  console.log();
  console.log('═══════════════════════════════════════════════');
  console.log('   🔓 Bond released!');
  console.log(`   TXID:   ${txid}`);
  console.log(`   ${bondAmount - FEE} sats → ${bondholderAddr.toString()}`);
  console.log(`   https://whatsonchain.com/tx/${txid}`);
  console.log('═══════════════════════════════════════════════');
}

release().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
