import { SmartContract } from "ton-contract-executor";
import {Cell, Address} from "ton";
import BN from "bn.js";


export type NftRoyaltyParams = {
    numerator: number | BN,
    denominator: number | BN,
    destination: Address
}

export type TelemintData = {
    touched: boolean,
    subwallet_id: number | BN,
    public_key: BN,
    content: Cell,
    item_code: Cell,
    full_domain: string,
    royalty: NftRoyaltyParams
}

export default class Utils {
    static async compileAndGetItem(): Promise<SmartContract> {
        let contract = await SmartContract.fromFuncFiles(
            [
                "func/stdlib.fc",
                "func/common.fc",
                "func/nft-item.fc",
            ],
            new Cell()
        );
        return contract
    }
    static async compileAndGetCollection(): Promise<SmartContract> {
        let contract = await SmartContract.fromFuncFiles(
            [
                "func/stdlib.fc",
                "func/common.fc",
                "func/nft-collection.fc",
            ],
            new Cell()
        );
        return contract
    }

    static createText(text: string): Cell {
        /*
        telimint_text$_ len:(## 8) text:(bits (len * 8)) = TelemintText;
        */
        let b = Buffer.from(text, "utf-8");
        let c = new Cell();
        c.bits.writeUint(b.length, 8)
        c.bits.writeBuffer(b)
        return c
    }

    static createRoyaltyParams(data: NftRoyaltyParams): Cell {
        /*
        nft_royalty_params#_ numerator:uint16 denominator:uint16 destination:MsgAddress = NftRoyaltyParams;       
        */
        let c = new Cell();
        c.bits.writeUint(data.numerator, 16)
        c.bits.writeUint(data.denominator, 16)
        c.bits.writeAddress(data.destination)
        return c
    }

    static createCollectionData(data: TelemintData): Cell {
        /*
        telemint_data$_ touched:Bool subwallet_id:uint32 public_key:bits256 collection_content:^Cell nft_item_code:^Cell
        full_domain:^TelemintText royalty_params:^NftRoyaltyParams = TelemintData;
        */
        let dataCell = new Cell();
        dataCell.bits.writeBit(data.touched)
        dataCell.bits.writeUint(data.subwallet_id, 32)
        dataCell.bits.writeUint(data.public_key, 256)
        dataCell.refs.push(data.content)
        dataCell.refs.push(data.item_code)
        dataCell.refs.push(Utils.createText(data.full_domain))
        dataCell.refs.push(Utils.createRoyaltyParams(data.royalty))
        return dataCell;
    }
}