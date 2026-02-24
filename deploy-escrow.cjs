#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { Escrow } = require('./dist/src/contracts/escrow');
const { bsv, toByteString, PubKeyHash, PubKey, DefaultProvider, TestWallet } = require('scrypt-ts');

const ARTIFACT_PATH = path.join(__dirname, 'artifacts/escrow.json');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}

const AMOUNT = parseInt(args.amount || '10000');
const TIMEOUT_BLOCKS = parseInt(args['timeout-blocks'] || '100');
const WORKER_PUB = args['worker-pub'];
const WORKER_ADDR = args['worker-addr'];
const WALLET_PATH = args.wallet || path.join(__dirname, 'wallet.json');

if (!WORKER_PUB || !WORKER_ADDR) {
  console.log('Usage: node deploy-escrow.cjs --worker-pub <hex> --worker-addr <address> [options]');
  console.log();
  console.log('Options:');
  console.log('  --amount <sats>          Escrow amount (default: 10000)');
  console.log('  --timeout-blocks <n>     Blocks until requester can reclaim (default: 100)');
  console.log('  --worker-pub <hex>       Worker public key (hex)');
  console.log('  --worker-addr <address>  Worker BSV address');
  console.log('  --wallet <path>          Requester wallet (default: ./wallet.json)');
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

  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  const requesterKey = bsv.PrivateKey.fromWIF(wallet.wif);
  const requesterPub = requesterKey.toPublicKey();
  const requesterAddr = requesterKey.toAddress();

  const chainInfo = await httpGet('https://api.whatsonchain.com/v1/bsv/main/chain/info');
  const currentHeight = chainInfo.blocks;
  const timeoutBlock = currentHeight + TIMEOUT_BLOCKS;

  console.log('💰 Deploying Escrow');
  console.log(`   Requester:  ${requesterAddr.toString()}`);
  console.log(`   Worker:     ${WORKER_ADDR}`);
  console.log(`   Amount:     ${AMOUNT} sats`);
  console.log(`   Timeout:    block ${timeoutBlock} (current: ${currentHeight}, +${TIMEOUT_BLOCKS} blocks)`);
  console.log();

  const requesterPkh = toByteString(bsv.Address.fromString(requesterAddr.toString()).hashBuffer.toString('hex'));
  const workerPkh = toByteString(bsv.Address.fromString(WORKER_ADDR).hashBuffer.toString('hex'));

  const escrow = new Escrow(
    PubKey(toByteString(requesterPub.toHex())),
    PubKeyHash(requesterPkh),
    PubKey(toByteString(WORKER_PUB)),
    PubKeyHash(workerPkh),
    BigInt(timeoutBlock)
  );

  const provider = new DefaultProvider({ network: bsv.Networks.mainnet });
  const signer = new TestWallet(requesterKey, provider);
  await escrow.connect(signer);

  const deployTx = await escrow.deploy(AMOUNT);
  const txid = deployTx.id;

  // Save state
  const escrowsDir = path.join(__dirname, 'escrows');
  if (!fs.existsSync(escrowsDir)) fs.mkdirSync(escrowsDir);

  const state = {
    escrowTxid: txid,
    outputIndex: 0,
    amount: AMOUNT,
    timeoutBlock,
    requesterAddress: requesterAddr.toString(),
    requesterPub: requesterPub.toHex(),
    workerAddress: WORKER_ADDR,
    workerPub: WORKER_PUB,
    deployedAt: new Date().toISOString(),
    blockHeight: currentHeight,
  };
  fs.writeFileSync(path.join(escrowsDir, `${txid.slice(0, 16)}.json`), JSON.stringify(state, null, 2));

  console.log('═══════════════════════════════════════════════');
  console.log('   💰 Escrow deployed!');
  console.log(`   TXID:       ${txid}`);
  console.log(`   Amount:     ${AMOUNT} sats`);
  console.log(`   Timeout:    block ${timeoutBlock}`);
  console.log(`   https://whatsonchain.com/tx/${txid}`);
  console.log('═══════════════════════════════════════════════');
  console.log(`   State: ${path.join(escrowsDir, txid.slice(0, 16) + '.json')}`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
