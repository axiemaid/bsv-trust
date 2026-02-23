import {
    assert,
    ByteString,
    hash256,
    method,
    prop,
    PubKey,
    PubKeyHash,
    Sig,
    SmartContract,
    toByteString,
    Utils,
} from 'scrypt-ts'

/**
 * Bond — Trust Primitive #1
 *
 * A covenant UTXO that locks sats to a bondholder address with:
 * - Time-locked release (cannot withdraw before lockUntil block height)
 * - Slashing by a designated authority (sats go to slash destination)
 *
 * On-chain anyone can verify: who bonded, how much, when it unlocks,
 * and who can slash it.
 */
export class Bond extends SmartContract {
    // Bond owner — can release after time lock
    @prop()
    bondholderPkh: PubKeyHash

    // Public key of the bondholder (for sig verification)
    @prop()
    bondholderPub: PubKey

    // Block height after which the bondholder can release
    @prop()
    lockUntil: bigint

    // Authority that can slash (e.g. a judge or dispute resolver)
    @prop()
    slasherPub: PubKey

    // Where slashed sats go
    @prop()
    slashDestPkh: PubKeyHash

    constructor(
        bondholderPkh: PubKeyHash,
        bondholderPub: PubKey,
        lockUntil: bigint,
        slasherPub: PubKey,
        slashDestPkh: PubKeyHash
    ) {
        super(...arguments)
        this.bondholderPkh = bondholderPkh
        this.bondholderPub = bondholderPub
        this.lockUntil = lockUntil
        this.slasherPub = slasherPub
        this.slashDestPkh = slashDestPkh
    }

    @method()
    public release(sig: Sig) {
        // Only bondholder can release
        assert(this.checkSig(sig, this.bondholderPub), 'invalid bondholder signature')

        // Enforce time lock — tx nLockTime must be >= lockUntil
        assert(this.ctx.locktime >= this.lockUntil, 'bond still locked')

        // Pay back to bondholder
        const outputs: ByteString =
            Utils.buildPublicKeyHashOutput(this.bondholderPkh, this.ctx.utxo.value) +
            this.buildChangeOutput()

        assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
    }

    @method()
    public slash(sig: Sig) {
        // Only the designated slasher can slash
        assert(this.checkSig(sig, this.slasherPub), 'invalid slasher signature')

        // No time lock on slashing — can happen any time

        // Send sats to slash destination
        const outputs: ByteString =
            Utils.buildPublicKeyHashOutput(this.slashDestPkh, this.ctx.utxo.value) +
            this.buildChangeOutput()

        assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
    }
}
