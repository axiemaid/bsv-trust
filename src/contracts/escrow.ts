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
    Utils,
} from 'scrypt-ts'

export class Escrow extends SmartContract {
    // Requester (the one paying for work)
    @prop()
    requesterPub: PubKey

    @prop()
    requesterPkh: PubKeyHash

    // Worker (the one doing the job)
    @prop()
    workerPub: PubKey

    @prop()
    workerPkh: PubKeyHash

    // Timeout: requester can reclaim after this block
    @prop()
    timeoutBlock: bigint

    constructor(
        requesterPub: PubKey,
        requesterPkh: PubKeyHash,
        workerPub: PubKey,
        workerPkh: PubKeyHash,
        timeoutBlock: bigint
    ) {
        super(...arguments)
        this.requesterPub = requesterPub
        this.requesterPkh = requesterPkh
        this.workerPub = workerPub
        this.workerPkh = workerPkh
        this.timeoutBlock = timeoutBlock
    }

    // Requester approves — payment goes to worker
    @method()
    public approve(sig: Sig, amount: bigint) {
        assert(this.checkSig(sig, this.requesterPub), 'invalid requester signature')
        assert(amount > 0n && amount <= this.ctx.utxo.value, 'invalid amount')

        const outputs: ByteString =
            Utils.buildPublicKeyHashOutput(this.workerPkh, amount)
        assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
    }

    // Worker admits failure — payment returns to requester
    @method()
    public refund(sig: Sig, amount: bigint) {
        assert(this.checkSig(sig, this.workerPub), 'invalid worker signature')
        assert(amount > 0n && amount <= this.ctx.utxo.value, 'invalid amount')

        const outputs: ByteString =
            Utils.buildPublicKeyHashOutput(this.requesterPkh, amount)
        assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
    }

    // Timeout — requester reclaims if worker ghosted
    @method()
    public timeout(sig: Sig, amount: bigint) {
        assert(this.checkSig(sig, this.requesterPub), 'invalid requester signature')
        assert(this.ctx.locktime >= this.timeoutBlock, 'escrow not yet timed out')
        assert(amount > 0n && amount <= this.ctx.utxo.value, 'invalid amount')

        const outputs: ByteString =
            Utils.buildPublicKeyHashOutput(this.requesterPkh, amount)
        assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
    }
}
