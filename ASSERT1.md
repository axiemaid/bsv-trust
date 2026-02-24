# ASSERT1 — On-Chain Assertions Backed by Bonds

## Overview

An agent makes a signed assertion on-chain, referencing an active bond. The bond gives the assertion weight — if the assertion is disputed and found false, the bond gets slashed.

## OP_RETURN Format

```
OP_FALSE OP_RETURN "ASSERT1" <version:1B> <bondTxid:32B> <topic> <claim> <sig>
```

| Field | Size | Description |
|-------|------|-------------|
| Prefix | 7B | `ASSERT1` protocol identifier |
| Version | 1B | `0x01` |
| Bond TXID | 32B | The bond UTXO backing this assertion (little-endian) |
| Topic | variable | UTF-8 string — short category/namespace (e.g. `"price"`, `"identity"`, `"audit"`) |
| Claim | variable | UTF-8 string — the actual assertion text, readable on-chain |
| Signature | ~72B | DER-encoded ECDSA sig by bondholder key over `SHA256(bondTxid + topic + claim)` |

## Verification

Anyone can verify an assertion by:

1. Parse the OP_RETURN, extract `bondTxid`
2. Look up the bond UTXO — confirm it's **unspent** (still active)
3. Extract the bondholder public key from the bond contract
4. Verify the signature against `SHA256(bondTxid + topic + claim)`
5. Assertion weight = bond amount in sats

If the bond has been released or slashed, the assertion has no backing.

## Claim Data

The full claim text is stored directly in the OP_RETURN — human-readable on-chain, no external lookups needed. BSV has no practical OP_RETURN size limit.

## Properties

- **No new covenant needed** — assertions are plain signed transactions
- **Bond-weighted** — credibility scales with sats at stake
- **Publicly verifiable** — anyone can check bond status + signature
- **Composable** — multiple assertions can reference the same bond
- **Revocable** — releasing the bond implicitly weakens all assertions it backed

## Example Flow

```
1. Agent deploys bond (5,000 sats, locked 1000 blocks)
2. Agent publishes: ASSERT1 | bondTxid | "price" | "BTC > 100k USD on 2026-03-01" | sig
3. Anyone reads it on-chain: "This agent asserts BTC > 100k, backed by 5,000 sats"
4. If wrong → slasher slashes the bond
5. If right → bond eventually releases, agent keeps sats + reputation
```

## CLI

```bash
# Make an assertion (claim text goes directly on-chain)
node assert.cjs --bond-txid <txid> --topic "price" --claim "BTC > 100k USD on 2026-03-01"

# Verify an assertion (reads claim text + checks bond + verifies sig)
node verify-assert.cjs --txid <assert-txid>
```

## Connects To

- **Bond** (BOND) — backing for assertions
- **Dispute** (planned) — challenge an assertion by locking your own bond
- **Judge** (planned) — resolve disputes, slash the loser
- **REG1** — discover agents who make assertions
- **MA1** — agents can assert things in conversations
