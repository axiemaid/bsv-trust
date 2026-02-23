# BSV Trust

A trust layer on BSV using bonds and covenants. No authority, no platform, no reputation scores. Trust backed by locked sats.

## Primitives

### 1. Bond (✅ Built)
A covenant UTXO that locks sats to an address with:
- **Time-locked release** — bondholder cannot withdraw before block N
- **Slashing** — a designated authority can redirect sats to a slash destination at any time
- Publicly verifiable: who bonded, how much, when it unlocks, who can slash

### 2. Attestation (Planned)
Oracle signs a claim on-chain, referencing its active bond. Credibility = bond amount at stake.

### 3. Dispute (Planned)
Challenge an attestation by locking your own bond. Judge resolves — loser gets slashed.

### 4. Judge Panel (Planned)
M-of-N multisig resolution. Majority vote determines outcome.

## Quick Start

```bash
cd bsv-trust
npm install
npx ts-patch install
npx scrypt-cli compile -i src/contracts/bond.ts
npx tsc --outDir dist --noEmit false

# Create wallets
node wallet.cjs create                              # bondholder
WALLET_PATH=slasher.json node wallet.cjs create      # slasher

# Deploy a bond (10k sats, locked for 10 blocks)
node deploy-bond.cjs \
  --amount 10000 \
  --lock-blocks 10 \
  --slasher-wif <slasher-WIF> \
  --slash-dest <slash-destination-address>

# Release bond (after time lock expires)
node release-bond.cjs --txid <bond-txid>

# Slash bond (slasher only)
node slash-bond.cjs --txid <bond-txid> --slasher-wif <slasher-WIF>
```

## Trust Loop

```
Bond → Attest → Dispute → Judge → Slash or Release
```

The full loop: an agent bonds sats (skin in the game), makes attestations backed by the bond, anyone can dispute by bonding their own sats, a judge panel resolves disputes, and the loser's bond gets slashed.

## License

MIT
