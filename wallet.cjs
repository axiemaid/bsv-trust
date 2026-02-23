#!/usr/bin/env node
// Wallet management — create, show address, check balance
const fs = require('fs');
const path = require('path');
const { bsv } = require('scrypt-ts');

const WALLET_PATH = process.env.WALLET_PATH || path.join(__dirname, 'wallet.json');

const cmd = process.argv[2];

if (cmd === 'create') {
  if (fs.existsSync(WALLET_PATH)) {
    console.error(`Wallet already exists: ${WALLET_PATH}`);
    console.error('Delete it first if you want a new one.');
    process.exit(1);
  }
  const key = bsv.PrivateKey.fromRandom('mainnet');
  const wallet = {
    wif: key.toWIF(),
    address: key.toAddress().toString(),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, null, 2));
  console.log(`✅ Wallet created: ${WALLET_PATH}`);
  console.log(`   Address: ${wallet.address}`);
  console.log(`\nSend BSV to this address to fund organism spawns.`);

} else if (cmd === 'address') {
  if (!fs.existsSync(WALLET_PATH)) {
    console.error('No wallet found. Run: node wallet.cjs create');
    process.exit(1);
  }
  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
  console.log(wallet.address);

} else if (cmd === 'balance') {
  if (!fs.existsSync(WALLET_PATH)) {
    console.error('No wallet found. Run: node wallet.cjs create');
    process.exit(1);
  }
  const wallet = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
  const https = require('https');
  https.get(`https://api.whatsonchain.com/v1/bsv/main/address/${wallet.address}/balance`, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      const bal = JSON.parse(d);
      const confirmed = bal.confirmed || 0;
      const unconfirmed = bal.unconfirmed || 0;
      console.log(`Address:     ${wallet.address}`);
      console.log(`Confirmed:   ${confirmed} sats`);
      console.log(`Unconfirmed: ${unconfirmed} sats`);
      console.log(`Total:       ${confirmed + unconfirmed} sats`);
    });
  });

} else {
  console.log('Usage: node wallet.cjs <create|address|balance>');
  console.log('');
  console.log('Set WALLET_PATH env var to use a custom wallet location.');
}
