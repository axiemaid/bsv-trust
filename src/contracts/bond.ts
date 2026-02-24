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

export class Bond extends SmartContract {
    @prop()
    bondholderPkh: PubKeyHash

    @prop()
    bondholderPub: PubKey

    @prop()
    lockUntil: bigint

    @prop()
    slasherPub: PubKey

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
    public release(sig: Sig, amount: bigint) {
        assert(this.checkSig(sig, this.bondholderPub), 'invalid bondholder signature')
        assert(this.ctx.locktime >= this.lockUntil, 'bond still locked')
        assert(amount > 0n && amount <= this.ctx.utxo.value, 'invalid amount')

        const outputs: ByteString =
            Utils.buildPublicKeyHashOutput(this.bondholderPkh, amount)
        assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
    }

    @method()
    public slash(sig: Sig, amount: bigint) {
        assert(this.checkSig(sig, this.slasherPub), 'invalid slasher signature')
        assert(amount > 0n && amount <= this.ctx.utxo.value, 'invalid amount')

        const outputs: ByteString =
            Utils.buildPublicKeyHashOutput(this.slashDestPkh, amount)
        assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
    }
}
