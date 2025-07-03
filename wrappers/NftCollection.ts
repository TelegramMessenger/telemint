import { sha256_sync } from '@ton/crypto';
import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Dictionary, DictionaryValue, Sender, SendMode, toNano, internal as internal_relaxed, storeMessageRelaxed } from '@ton/core';
import { sign } from '@ton/crypto';
import { Op } from './NftConstants';
import { storeTextRef, storeText } from '../tests/utils';

type NftContentOffchain = {
    type: 'offchain',
    uri: string
}
type OnChainContentData = 'uri' | 'name' | 'description' | 'image' | 'image_data' | 'symbol' | 'decimals' | 'amount_style' | 'render_type' | 'currency' | 'game';

type NftContentOnchain = {
    type: 'onchain',
    data: Partial<Record<OnChainContentData, string>>
}

export type NftContent = NftContentOnchain | NftContentOffchain;

export type AuctionParameters = {
    benificiary: Address,
    min_bid: bigint,
    max_bid: bigint,
    min_bid_step: bigint,
    min_extend_time: number,
    duration: number
}

export type RoyaltyParameters = {
    address: Address,
    royalty_factor: number | bigint,
    royalty_base: number | bigint
};

export type  NftCollectionConfig = {
    public_key: Buffer,
    subwallet_id: number,
    content: NftContent | Cell,
    full_domain: string,
    item_code: Cell,
    royalty: RoyaltyParameters
};

export type SignatureParams = {
    subwallet_id: number,
    valid_since: number,
    valid_till: number,
    privateKey: Buffer
}

export type ItemRestrictions = {
    force_sender: Address | null,
    rewrite_sender: Address | null,
}

export type NewNftItem = {
    token_name: string,
    content: NftContent | Cell,
    actuion_config: AuctionParameters,
    royalty?: RoyaltyParameters | Cell,
    restrictions?: ItemRestrictions
}

type BatchDeployValue = NewNftItem & {
    forwardAmount: bigint
}

function signDataHash(data: Cell, priv:Buffer) {
	const hash = data instanceof Cell ? data.hash() : data;
        const signature = sign(hash, priv);
	return beginCell().storeBuffer(signature).storeSlice(data.asSlice()).endCell();
}

function OnChainString(): DictionaryValue<string> {
    return {
        serialize(src, builder) {
            builder.storeRef(beginCell().storeUint(0, 8).storeStringTail(src));
        },
        parse(src) {
            const sc  = src.loadRef().beginParse();
            const tag = sc.loadUint(8);
            if(tag == 0) {
                return sc.loadStringTail();
            } else if(tag == 1) {
                // Not really tested, but feels like it should work
                const chunkDict = Dictionary.loadDirect(Dictionary.Keys.Uint(32), Dictionary.Values.Cell(), sc);
                return chunkDict.values().map(x => x.beginParse().loadStringTail()).join('');

            } else {
                throw Error(`Prefix ${tag} is not supported yet!`);
            }
        }
    }
}

export function nftContentToCell(content: NftContent) {
    if(content.type == 'offchain') {
        return beginCell()
            .storeUint(1, 8)
            .storeStringRefTail(content.uri) //Snake logic under the hood
            .endCell();
    }
    let keySet = new Set(['uri' , 'name' , 'description' , 'image' , 'image_data' , 'symbol' , 'decimals' , 'amount_style' , 'render_type' , 'currency' , 'game']);
    let contentDict = Dictionary.empty(Dictionary.Keys.Buffer(32), OnChainString());

    for (let contentKey in content.data) {
        if(keySet.has(contentKey)) {
            contentDict.set(
                sha256_sync(contentKey),
                content.data[contentKey as OnChainContentData]!
            );
        }
    }
    return beginCell().storeUint(0, 8).storeDict(contentDict).endCell();
}

export function royaltyParamsToCell(royalty: RoyaltyParameters): Cell {
    return beginCell()
            .storeUint(royalty.royalty_factor, 16)
            .storeUint(royalty.royalty_base, 16)
            .storeAddress(royalty.address)
           .endCell();
}

export function auctionConfigToCell(config: AuctionParameters) {
    return beginCell()
            .storeAddress(config.benificiary)
            .storeCoins(config.min_bid)
            .storeCoins(config.max_bid)
            .storeUint(config.min_bid_step, 8)
            .storeUint(config.min_extend_time, 32)
            .storeUint(config.duration, 32)
          .endCell();
}

export function itemRestrictionsToCell(restrictions: ItemRestrictions) {
    const forceSender   = Boolean(restrictions.force_sender);
    const rewriteSender = Boolean(restrictions.rewrite_sender);

    const restBuilder = beginCell().storeBit(forceSender);

    if(forceSender) {
        restBuilder.storeAddress(restrictions.force_sender);
    }

    restBuilder.storeBit(rewriteSender);

    if(rewriteSender) {
        restBuilder.storeAddress(restrictions.rewrite_sender);
    }

    return restBuilder.endCell();
}

export function collectionConfigToCell(config: NftCollectionConfig): Cell {
    return beginCell()
            .storeUint(0, 1)
            .storeUint(config.subwallet_id, 32)
            .storeBuffer(config.public_key, 32)
            .storeRef(config.content instanceof Cell ? config.content : nftContentToCell(config.content))
            .storeRef(config.item_code)
            .store(storeTextRef(config.full_domain))
            .storeRef(royaltyParamsToCell(config.royalty))
          .endCell();
}

/*
export function BathDeployValue() : DictionaryValue<BatchDeployValue> {
    return {
        parse: (src) => {
            const nftContent = src.loadRef().beginParse();
            return {
                forwardAmount: src.loadCoins(),
                owner: nftContent.loadAddress(),
                content: nftContent.loadRef()
            }
        },
        serialize: (src, builder) => {
            builder.storeCoins(src.forwardAmount)
            builder.storeRef(beginCell().storeAddress(src.owner).storeRef(src.content instanceof Cell ? src.content : nftContentToCell(src.content)).endCell())
        }
    }
}
*/

export class NftCollection implements Contract {

    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new NftCollection(address);
    }

    static createFromConfig(config: NftCollectionConfig, code: Cell, workchain = 0) {
        const data = collectionConfigToCell(config);
        const init = { code, data };
        return new NftCollection(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.external(
            beginCell().endCell()
        );
    }

    static newItemMessage(item: NewNftItem, signature_params: SignatureParams, queryId: number | bigint = 0) {
        const dataCell = beginCell()
                            .storeUint(signature_params.subwallet_id, 32)
                            .storeUint(signature_params.valid_since, 32)
                            .storeUint(signature_params.valid_till, 32)
                            .store(storeText(item.token_name))
                            .storeRef(item.content instanceof Cell ? item.content : nftContentToCell(item.content))
                            .storeRef(auctionConfigToCell(item.actuion_config))
                            .storeMaybeRef(item.royalty instanceof Cell ? item.royalty : item.royalty ? royaltyParamsToCell(item.royalty) : null)
                            .storeMaybeRef(item.restrictions ? itemRestrictionsToCell(item.restrictions) : null)
                        .endCell();

        const signedCell = signDataHash(dataCell, signature_params.privateKey);
                            
        return beginCell()
                .storeUint(Op.telemint_msg_deploy_v2, 32)
                .storeSlice(signedCell.beginParse())
               .endCell();
    }

    async sendDeployItem(provider: ContractProvider, via: Sender, item: NewNftItem, signature_params: SignatureParams, value: bigint = toNano('0.1'), queryId: number | bigint = 0) {
        await provider.internal(via,{
            value,
            body: NftCollection.newItemMessage(item, signature_params),
            sendMode: SendMode.PAY_GAS_SEPARATELY
        });
    }

    static changeOwnerMessage(newOwner: Address, queryId: number | bigint = 0) {
        return beginCell()
                .storeUint(Op.change_owner, 32)
                .storeUint(queryId, 64)
                .storeAddress(newOwner)
               .endCell();
    }
    async sendChangeOwner(provider: ContractProvider, via: Sender, newOwner: Address, value: bigint = toNano('0.05'), queryId: number | bigint = 0) {
        await provider.internal(via,{
            value,
            body: NftCollection.changeOwnerMessage(newOwner, queryId),
            sendMode: SendMode.PAY_GAS_SEPARATELY
        });
    }

    /*
    static batchDeployMessage(batchItems: Dictionary<bigint, BatchDeployValue>, queryId: bigint | number = 0) {
        return beginCell()
                .storeUint(Op.batch_deploy_item, 32)
                .storeUint(queryId, 64)
                .storeDict(batchItems)
               .endCell();
    }
    async sendDeployBatch(provider: ContractProvider, via: Sender, items: {item: NewNftItem, index: number | bigint, forwardAmount: bigint}[], value: bigint, queryId: bigint | number = 0) {
        let batchDictionary = Dictionary.empty(Dictionary.Keys.BigUint(64), BathDeployValue());
        for(let nftItem of items) {
            batchDictionary.set(BigInt(nftItem.index), {forwardAmount: nftItem.forwardAmount, ...nftItem.item});
        }

        await provider.internal(via,{
            value,
            body: NftCollection.batchDeployMessage(batchDictionary, queryId),
            sendMode: SendMode.PAY_GAS_SEPARATELY
        });
    }
    */

    static royaltyParamsMessage(queryId: bigint | number = 0) {
        return beginCell()
                .storeUint(Op.get_royalty_params, 32)
                .storeUint(queryId, 64)
               .endCell();
    }
    async sendGetRoyaltyParams(provider: ContractProvider, via: Sender, value: bigint = toNano('0.05'), queryId: bigint | number = 0) {
        await provider.internal(via, {
            value,
            body: NftCollection.royaltyParamsMessage(queryId),
            sendMode: SendMode.PAY_GAS_SEPARATELY,
        });
    }

    async getNftAddressByIndex(provider: ContractProvider, idx: number | bigint) {
        const { stack } = await provider.get('get_nft_address_by_index', [{type: 'int', value: BigInt(idx)}]);
        return stack.readAddress();
    }

    async getCollectionData(provider: ContractProvider) {
        const { stack } = await provider.get('get_collection_data', []);

        return {
            nextItemIndex : stack.readNumber(),
            collectionContent: stack.readCell(),
            owner: stack.readAddressOpt()
        };
    }

    async getNftContent(provider: ContractProvider, index: number | bigint, content: Cell) {

        const { stack } = await provider.get('get_nft_content', [{
            type: 'int',
            value: BigInt(index)
        },
        {
            type: 'cell',
            cell: content
        }]);

        return stack.readCell();
    }
}
