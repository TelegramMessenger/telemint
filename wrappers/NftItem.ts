import { auctionConfigToCell, AuctionParameters } from './NftCollection';
import { Op } from './NftConstants';
import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Dictionary, DictionaryValue, Sender, SendMode, toNano, internal as internal_relaxed, storeMessageRelaxed, Slice } from '@ton/core';


export class NftItem implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new NftItem(address);
    }

    static transferMessage(to: Address, response: Address | null, forwardAmount: bigint = 1n,  forwardPayload?: Cell | Slice | null,  queryId: bigint | number = 0) {
        const byRef = forwardPayload instanceof Cell
        const body = beginCell()
                .storeUint(Op.transfer, 32)
                .storeUint(queryId, 64)
                .storeAddress(to)
                .storeAddress(response)
                .storeBit(false) // No custom payload
                .storeCoins(forwardAmount)
                .storeBit(byRef)
        if(byRef) {
            body.storeRef(forwardPayload)
        } else if(forwardPayload) {
            body.storeSlice(forwardPayload)
        }
        return body.endCell();
    }

    static royaltyParamsMessage(queryId: bigint | number = 0) {
        return beginCell()
                .storeUint(Op.get_royalty_params, 32)
                .storeUint(queryId, 64)
               .endCell();
    }

    async sendGetRoyaltyParams(provider: ContractProvider, via: Sender, value: bigint = toNano('0.05'), queryId: bigint | number = 0) {
        await provider.internal(via, {
            value,
            body: NftItem.royaltyParamsMessage(queryId),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });
    }

    async sendTransfer(provider: ContractProvider, via: Sender, to: Address, response: Address | null, forwardAmount: bigint = 1n, forwardPayload?: Cell | Slice | null,  value: bigint = toNano('0.05'), queryId: bigint | number = 0) {
        if(value <= forwardAmount) {
            throw Error("Value has to exceed forwardAmount");
        }
        await provider.internal(via, {
            value,
            body: NftItem.transferMessage(to, response, forwardAmount, forwardPayload, queryId),
            sendMode: SendMode.PAY_GAS_SEPARATELY
        });
    }

    async sendBet(provider: ContractProvider, via: Sender, value: bigint, mode: 'empty_body' | 'op_zero' = 'empty_body') {
        await provider.internal(via, {
            value,
            body: mode == 'empty_body' ? undefined : beginCell().storeUint(0, 32).endCell(),
            sendMode: SendMode.PAY_GAS_SEPARATELY
        });
    }
    
    static startAuctionMsg( auctionConfig: AuctionParameters | Cell, queryId: bigint | number = 0) {
        return beginCell()
                .storeUint(Op.teleitem_start_auction, 32)
                .storeUint(queryId, 64)
                .storeRef(auctionConfig instanceof Cell ? auctionConfig : auctionConfigToCell(auctionConfig))
               .endCell();
    }

    async sendStartAuction(provider: ContractProvider, via: Sender, config: AuctionParameters | Cell, value: bigint = toNano('0.05'), queryId: bigint | number = 0) {
        await provider.internal(via, {
            value,
            body: NftItem.startAuctionMsg(config, queryId),
            sendMode: SendMode.PAY_GAS_SEPARATELY
        });
    }
    static cancelAuctionMsg(queryId: bigint | number = 0) {
        return beginCell()
                .storeUint(Op.teleitem_cancel_auction, 32)
                .storeUint(queryId, 64)
               .endCell();
    }

    async sendCancelAuction(provider: ContractProvider, via: Sender, value: bigint = toNano('0.05'), queryId: bigint | number = 0) {
        await provider.internal(via, {
            value,
            body: NftItem.cancelAuctionMsg(queryId),
            sendMode: SendMode.PAY_GAS_SEPARATELY
        });
    }
    async sendCheckEndExternal(provider: ContractProvider) {
        await provider.external(beginCell().endCell());
    }

    static staticDataMessage(queryId: bigint | number = 0) {
        return beginCell()
                .storeUint(Op.get_static_data, 32)
                .storeUint(queryId, 64)
               .endCell();
    }

    async sendGetStaticData(provider: ContractProvider, via: Sender, value: bigint = toNano('0.05'), queryId: bigint | number = 0) {
        await provider.internal(via, {
            value,
            body: NftItem.staticDataMessage(queryId),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });
    }

    async getNftData(provider: ContractProvider) {
        const { stack } = await provider.get('get_nft_data', []);

        return {
            isInit: stack.readBoolean(),
            index: stack.readBigNumber(),
            collection: stack.readAddress(),
            owner: stack.readAddressOpt(),
            content: stack.readCellOpt()
        }
    }

    async getTokenName(provider: ContractProvider) {
        const { stack } = await provider.get('get_telemint_token_name', []);
        return stack.readString();
    }
    async getAuctionState(provider: ContractProvider) {
        const { stack } = await provider.get('get_telemint_auction_state', []);

        return {
            bidder_address: stack.readAddressOpt(),
            bid: stack.readBigNumber(),
            bid_ts: stack.readNumber(),
            min_bid: stack.readBigNumber(),
            end_time: stack.readNumber()
        }
    }
    async getAuctionConfig(provider: ContractProvider) {
        const { stack } = await provider.get('get_telemint_auction_config', []);

        return {
            benificiary: stack.readAddressOpt(),
            initial_bid: stack.readBigNumber(),
            max_bid: stack.readBigNumber(),
            min_bid_step: stack.readBigNumber(),
            extend_time: stack.readNumber(),
            duration: stack.readNumber()
        }
    }
    async getRoyaltyParams(provider: ContractProvider) {
        const { stack } = await provider.get('royalty_params', []);

        return {
            factor: stack.readBigNumber(),
            base: stack.readBigNumber(),
            royalty_dst: stack.readAddress()
        }
    }
}
