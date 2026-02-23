#!/usr/bin/env node
'use strict';

/**
 * Deploy a Bond covenant to BSV mainnet.
 *
 * Usage: node deploy-bond.cjs [options]
 *   --amount <sats>       Bond amount (default: 10000)
 *   --lock-blocks <n>     Blocks until release is allowed (default: 10)
 *   --slasher-wif <wif>   WIF of the slashing authority
 *   --slash-dest <addr>   Address where slashed sats go
 *   --wallet <path>       Bondholder wallet (default: ./wallet.json)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { Bond } = require('./dist/src/contracts/bond');
const { bsv, toByteString, PubKey, PubKeyHash } = require('scrypt-ts');

const ARTIFACT_PATH = path.join(__dirname, 'artifacts/bond.json');

// Parse args
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const AMOUNT = parseInt(args.amount || '10000');
const LOCK_BLOCKS = parseInt(args['lock-blocks'] || '10');
const SLASHER_WIF = args['slasher-wif'];
const SLASH_DEST = args['slash-dest'];
const WALLET_PATH = args.wallet || path.join(__dirname, 'wallet.json');
const DEPLOY_FEE = 3000;

if (!SLASHER_WIF || !SLASH_DEST) {
  console.log('Usage: node deploy-bond.cjs --slasher-wif <wif> --slash-dest <address> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --amount <sats>       Bond amount (default: 10000)');
  console.log('  --lock-blocks <n>     Blocks from current height until release (default: 10)');
  console.log('  --slasher-wif <wif>   WIF of slashing authority');
  console.log('  --slash-dest <addr>   Destination for slashed sats');
  console.log('  --wallet <path>       Bondholder wallet (default: ./wallet.json)');
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

async function deploy() {
  // Load wallets
  if (!fs.existsSync(WALLET_PATH)) {
    console.error(`Wallet not found: ${WALLET_PATH}`);
    process.exit(1);
  }

  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
  const bondholderKey = bsv.PrivateKey.fromWIF(wallet.wif);
  const bondholderAddr = bondholderKey.toAddress();
  const bondholderPkh = toByteString(bondholderAddr.hashBuffer.toString('hex'));
  const bondholderPub = PubKey(toByteString(bondholderKey.toPublicKey().toHex()));

  const slasherKey = bsv.PrivateKey.fromWIF(SLASHER_WIF);
  const slasherPub = PubKey(toByteString(slasherKey.toPublicKey().toHex()));

  const slashDestAddr = bsv.Address.fromString(SLASH_DEST);
  const slashDestPkh = toByteString(slashDestAddr.hashBuffer.toString('hex'));

  // Get current block height
  const chainInfo = await httpGet('https://api.whatsonchain.com/v1/bsv/main/chain/info');
  const currentHeight = chainInfo.blocks;
  const lockUntil = currentHeight + LOCK_BLOCKS;

  console.log('🔐 Deploying Bond');
  console.log(`   Bondholder: ${bondholderAddr.toString()}`);
  console.log(`   Amount:     ${AMOUNT} sats`);
  console.log(`   Lock until: block ${lockUntil} (current: ${currentHeight}, +${LOCK_BLOCKS} blocks)`);
  console.log(`   Slasher:    ${slasherKey.toAddress().toString()}`);
  console.log(`   Slash dest: ${SLASH_DEST}`);
  console.log();

  // Load artifact
  Bond.loadArtifact(require(ARTIFACT_PATH));

  // Create bond instance
  const bond = new Bond(
    PubKeyHash(bondholderPkh),
    bondholderPub,
    BigInt(lockUntil),
    slasherPub,
    PubKeyHash(slashDestPkh)
  );

  // Fetch UTXOs
  const utxos = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/address/${bondholderAddr.toString()}/unspent`);
  if (!utxos || utxos.length === 0) {
    console.error(`❌ No UTXOs at ${bondholderAddr.toString()}`);
    process.exit(1);
  }

  const totalAvailable = utxos.reduce((s, u) => s + u.value, 0);
  const needed = AMOUNT + DEPLOY_FEE;
  if (totalAvailable < needed) {
    console.error(`❌ Need ${needed} sats, only ${totalAvailable} available`);
    process.exit(1);
  }

  // Build tx
  const tx = new bsv.Transaction();

  for (const u of utxos) {
    tx.from({
      txId: u.tx_hash,
      outputIndex: u.tx_pos,
      script: bsv.Script.buildPublicKeyHashOut(bondholderAddr).toHex(),
      satoshis: u.value,
    });
  }

  // Output 0: bond covenant
  tx.addOutput(new bsv.Transaction.Output({
    script: bond.lockingScript,
    satoshis: AMOUNT,
  }));

  // Change
  const change = totalAvailable - AMOUNT - DEPLOY_FEE;
  if (change > 546) {
    tx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildPublicKeyHashOut(bondholderAddr),
      satoshis: change,
    }));
  }

  tx.sign(bondholderKey);

  const txhex = tx.serialize();
  console.log(`   TX size: ${txhex.length / 2} bytes`);
  console.log('   Broadcasting...');

  const txid = await wocBroadcast(txhex);

  console.log();
  console.log('═══════════════════════════════════════════════');
  console.log('   🔐 Bond deployed!');
  console.log(`   TXID:       ${txid}`);
  console.log(`   Amount:     ${AMOUNT} sats`);
  console.log(`   Lock until: block ${lockUntil}`);
  console.log(`   https://whatsonchain.com/tx/${txid}`);
  console.log('═══════════════════════════════════════════════');

  // Save state
  const state = {
    bondTxid: txid,
    outputIndex: 0,
    amount: AMOUNT,
    lockUntil,
    bondholderAddress: bondholderAddr.toString(),
    slasherAddress: slasherKey.toAddress().toString(),
    slashDest: SLASH_DEST,
    deployedAt: new Date().toISOString(),
    blockHeight: currentHeight,
  };

  const statePath = path.join(__dirname, 'bonds', `${txid.slice(0, 16)}.json`);
  fs.mkdirSync(path.join(__dirname, 'bonds'), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`   State: ${statePath}`);
}

deploy().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
