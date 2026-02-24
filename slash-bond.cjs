#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { Bond } = require('./dist/src/contracts/bond');
const { bsv, toByteString, PubKeyHash, PubKey, DefaultProvider, TestWallet } = require('scrypt-ts');

const ARTIFACT_PATH = path.join(__dirname, 'artifacts/bond.json');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const TXID = args.txid;
const SLASHER_WIF = args['slasher-wif'];

if (!TXID || !SLASHER_WIF) {
  console.log('Usage: node slash-bond.cjs --txid <bond-txid> --slasher-wif <wif>');
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

async function slash() {
  const slasherKey = bsv.PrivateKey.fromWIF(SLASHER_WIF);

  Bond.loadArtifact(require(ARTIFACT_PATH));

  const spentInfo = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/tx/${TXID}/0/spent`).catch(() => null);
  if (spentInfo && spentInfo.txid) {
    console.error('❌ Bond already spent.');
    process.exit(1);
  }

  const txHex = await wocGetRaw(`/tx/${TXID}/hex`);
  const bsvTx = new bsv.Transaction(txHex);

  const provider = new DefaultProvider({ network: bsv.Networks.mainnet });
  const signer = new TestWallet(slasherKey, provider);
  await provider.connect();

  const bond = Bond.fromTx(bsvTx, 0);
  await bond.connect(signer);

  const bondAmount = Number(bond.balance);
  const slashDestPkh = bond.slashDestPkh;

  const slashDestAddr = bsv.Address.fromPublicKeyHash(
    Buffer.from(slashDestPkh, 'hex'),
    'mainnet'
  );

  console.log('⚡ Slashing Bond');
  console.log(`   Bond:      ${TXID.slice(0, 16)}...`);
  console.log(`   Amount:    ${bondAmount} sats`);
  console.log(`   Slash to:  ${slashDestAddr.toString()}`);

  const FEE = 500;
  const outputAmount = bondAmount - FEE;

  bond.bindTxBuilder('slash', (current, options) => {
    const unsignedTx = new bsv.Transaction();
    unsignedTx.addInput(current.buildContractInput());

    unsignedTx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildPublicKeyHashOut(slashDestAddr),
      satoshis: outputAmount,
    }));

    return Promise.resolve({
      tx: unsignedTx,
      atInputIndex: 0,
      nexts: [],
    });
  });

  console.log('   Building transaction...');

  const callResult = await bond.methods.slash(
    (sigResps) => {
      const match = sigResps.find(s => s.pubKey === slasherKey.toPublicKey().toHex());
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
  console.log('   ⚡ Bond slashed!');
  console.log(`   TXID:   ${txid}`);
  console.log(`   ${outputAmount} sats → ${slashDestAddr.toString()}`);
  console.log(`   https://whatsonchain.com/tx/${txid}`);
  console.log('═══════════════════════════════════════════════');
}

slash().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
