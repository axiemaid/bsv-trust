#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { Escrow } = require('./dist/src/contracts/escrow');
const { bsv, toByteString, PubKeyHash, PubKey, DefaultProvider, TestWallet } = require('scrypt-ts');

const ARTIFACT_PATH = path.join(__dirname, 'artifacts/escrow.json');
const FEE = 500;

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const TXID = args.txid;
const WALLET_PATH = args.wallet || path.join(__dirname, 'wallet.json');

if (!TXID) {
  console.log('Usage: node timeout-escrow.cjs --txid <escrow-txid> [--wallet <path>]');
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

function httpGetRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = ''; res.on('data', c => d += c);
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
        if (res.statusCode >= 400) return reject(new Error(`Broadcast: ${d}`));
        resolve(d.replace(/"/g, '').trim());
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  Escrow.loadArtifact(JSON.parse(fs.readFileSync(ARTIFACT_PATH, 'utf8')));

  const escrowsDir = path.join(__dirname, 'escrows');
  const stateFile = fs.readdirSync(escrowsDir).find(f => f.startsWith(TXID.slice(0, 16)));
  if (!stateFile) { console.error('❌ Escrow state not found'); process.exit(1); }
  const state = JSON.parse(fs.readFileSync(path.join(escrowsDir, stateFile), 'utf8'));

  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  const requesterKey = bsv.PrivateKey.fromWIF(wallet.wif);

  const chainInfo = await httpGet('https://api.whatsonchain.com/v1/bsv/main/chain/info');
  const currentHeight = chainInfo.blocks;

  const outputAmount = state.amount - FEE;

  console.log('⏰ Timeout Escrow — reclaiming funds');
  console.log(`   Escrow:   ${TXID.slice(0, 16)}...`);
  console.log(`   Amount:   ${state.amount} sats`);
  console.log(`   Timeout:  block ${state.timeoutBlock} (current: ${currentHeight})`);

  if (currentHeight < state.timeoutBlock) {
    console.log(`   ❌ Not yet timed out — ${state.timeoutBlock - currentHeight} blocks remaining`);
    process.exit(1);
  }
  console.log(`   ✅ Timed out (${currentHeight - state.timeoutBlock} blocks past)`);
  console.log();

  const requesterPkh = toByteString(bsv.Address.fromString(state.requesterAddress).hashBuffer.toString('hex'));
  const workerPkh = toByteString(bsv.Address.fromString(state.workerAddress).hashBuffer.toString('hex'));

  const escrow = new Escrow(
    PubKey(toByteString(state.requesterPub)),
    PubKeyHash(requesterPkh),
    PubKey(toByteString(state.workerPub)),
    PubKeyHash(workerPkh),
    BigInt(state.timeoutBlock)
  );

  const rawHex = await httpGetRaw(`https://api.whatsonchain.com/v1/bsv/main/tx/${TXID}/hex`);
  const prevTx = new bsv.Transaction(rawHex);
  escrow.from = { tx: prevTx, outputIndex: 0 };

  const provider = new DefaultProvider({ network: bsv.Networks.mainnet });
  const signer = new TestWallet(requesterKey, provider);
  await escrow.connect(signer);

  escrow.bindTxBuilder('timeout', (current, options) => {
    const unsignedTx = new bsv.Transaction();
    unsignedTx.addInput(current.buildContractInput());
    unsignedTx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildPublicKeyHashOut(bsv.Address.fromString(state.requesterAddress)),
      satoshis: outputAmount,
    }));
    unsignedTx.nLockTime = currentHeight;
    unsignedTx.inputs[0].sequenceNumber = 0xFFFFFFFE;
    return Promise.resolve({ tx: unsignedTx, atInputIndex: 0, nexts: [] });
  });

  console.log('   Building transaction...');
  const callResult = await escrow.methods.timeout(
    (sigResps) => {
      const match = sigResps.find(s => s.pubKey === requesterKey.toPublicKey().toHex());
      if (!match && sigResps.length > 0) return sigResps[0].sig;
      return match.sig;
    },
    BigInt(outputAmount),
    { autoPayFee: false, partiallySigned: true, estimateFee: false }
  );

  const txhex = callResult.tx.uncheckedSerialize();
  console.log(`   TX size: ${txhex.length / 2} bytes`);
  console.log('   Broadcasting...');

  const txid = await wocBroadcast(txhex);

  console.log();
  console.log('═══════════════════════════════════════════════');
  console.log('   ⏰ Escrow timed out — funds reclaimed!');
  console.log(`   TXID:   ${txid}`);
  console.log(`   ${outputAmount} sats → ${state.requesterAddress}`);
  console.log(`   https://whatsonchain.com/tx/${txid}`);
  console.log('═══════════════════════════════════════════════');
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
