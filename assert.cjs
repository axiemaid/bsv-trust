#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const https = require('https');
const { bsv } = require('scrypt-ts');
const fs = require('fs');
const path = require('path');

// Parse args
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const key = process.argv[i].replace(/^--/, '');
    args[key] = process.argv[++i];
  }
}

const BOND_TXID = args['bond-txid'];
const TOPIC = args.topic;
const CLAIM = args.claim;
const WALLET_PATH = args.wallet || path.join(__dirname, 'wallet.json');

if (!BOND_TXID || !TOPIC || !CLAIM) {
  console.log('Usage: node assert.cjs --bond-txid <txid> --topic <topic> --claim <text> [--wallet <path>]');
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
        if (res.statusCode >= 400) return reject(new Error(`Broadcast failed: ${d}`));
        // WoC returns txid as quoted string
        resolve(d.replace(/"/g, '').trim());
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  // Load wallet
  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  const privKey = bsv.PrivateKey.fromWIF(wallet.wif);
  const pubKey = privKey.toPublicKey();
  const address = privKey.toAddress();

  console.log('📢 ASSERT1 — Publishing Assertion');
  console.log(`   Bond:    ${BOND_TXID}`);
  console.log(`   Topic:   ${TOPIC}`);
  console.log(`   Claim:   ${CLAIM}`);
  console.log(`   Signer:  ${address.toString()}`);
  console.log();

  // Verify bond exists and is unspent
  console.log('   Checking bond status...');
  let bondUtxos = null;
  try {
    bondUtxos = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/tx/${BOND_TXID}/out/0/spent`);
  } catch (e) {
    // 404 = not spent, which is good
  }
  if (bondUtxos && bondUtxos.txid) {
    console.log(`⚠️  Warning: Bond has been spent (${bondUtxos.txid.slice(0, 16)}...)`);
    console.log('   Assertion will have no active backing. Continue anyway...');
  } else {
    console.log('   ✅ Bond is active (unspent)');
  }

  // Get UTXOs for funding the assertion tx
  const utxoResp = await httpGet(`https://api.whatsonchain.com/v1/bsv/main/address/${address.toString()}/unspent`);
  if (!utxoResp || utxoResp.length === 0) {
    console.error('❌ No UTXOs available to fund assertion tx');
    process.exit(1);
  }

  // Sign the assertion: SHA256(bondTxid + topic + claim)
  const msgBuf = Buffer.concat([
    Buffer.from(BOND_TXID, 'hex'),
    Buffer.from(TOPIC, 'utf8'),
    Buffer.from(CLAIM, 'utf8'),
  ]);
  const msgHash = crypto.createHash('sha256').update(msgBuf).digest();
  console.log('   msgHash length:', msgHash.length);
  const ecSig = bsv.crypto.ECDSA.sign(msgHash, privKey);
  const sigDER = ecSig.toDER();
  console.log('   sigDER length:', sigDER.length);

  // Build OP_RETURN: ASSERT1 <version> <bondTxid> <topic> <claim> <sig>
  // Build OP_FALSE OP_RETURN manually for BSV safe data carrier
  const opReturn = new bsv.Script();
  opReturn.add(bsv.Opcode.OP_FALSE);
  opReturn.add(bsv.Opcode.OP_RETURN);
  opReturn.add(Buffer.from('ASSERT1', 'utf8'));
  opReturn.add(Buffer.from([0x01]));                          // version
  opReturn.add(Buffer.from(BOND_TXID, 'hex').reverse());     // little-endian txid
  opReturn.add(Buffer.from(TOPIC, 'utf8'));
  opReturn.add(Buffer.from(CLAIM, 'utf8'));
  opReturn.add(Buffer.from(sigDER));

  // Build tx
  const tx = new bsv.Transaction();

  // Add funding input(s)
  let totalIn = 0;
  for (const utxo of utxoResp) {
    tx.addInput(new bsv.Transaction.Input.PublicKeyHash({
      output: new bsv.Transaction.Output({
        script: bsv.Script.buildPublicKeyHashOut(address),
        satoshis: utxo.value,
      }),
      prevTxId: utxo.tx_hash,
      outputIndex: utxo.tx_pos,
      script: bsv.Script.empty(),
    }));
    totalIn += utxo.value;
    if (totalIn >= 500) break; // enough for fee
  }

  // OP_RETURN output (0 sats)
  tx.addOutput(new bsv.Transaction.Output({
    script: opReturn,
    satoshis: 0,
  }));

  // Change output
  const fee = 500;
  const change = totalIn - fee;
  if (change > 0) {
    tx.addOutput(new bsv.Transaction.Output({
      script: bsv.Script.buildPublicKeyHashOut(address),
      satoshis: change,
    }));
  }

  // Sign inputs
  const sighashType = bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID;
  for (let i = 0; i < tx.inputs.length; i++) {
    const sig = bsv.Transaction.Sighash.sign(
      tx, privKey, sighashType,
      i, tx.inputs[i].output.script, new bsv.crypto.BN(tx.inputs[i].output.satoshis)
    );
    const scriptSig = new bsv.Script();
    scriptSig.add(Buffer.concat([sig.toDER(), Buffer.from([sighashType & 0xff])]));
    scriptSig.add(pubKey.toBuffer());
    tx.inputs[i].setScript(scriptSig);
  }

  const txhex = tx.uncheckedSerialize();
  console.log(`   TX size: ${txhex.length / 2} bytes`);
  console.log('   Broadcasting...');

  const txid = await wocBroadcast(txhex);

  console.log();
  console.log('═══════════════════════════════════════════════');
  console.log('   📢 Assertion published!');
  console.log(`   TXID:   ${txid}`);
  console.log(`   Topic:  ${TOPIC}`);
  console.log(`   Claim:  ${CLAIM}`);
  console.log(`   Bond:   ${BOND_TXID}`);
  console.log(`   https://whatsonchain.com/tx/${txid}`);
  console.log('═══════════════════════════════════════════════');
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
