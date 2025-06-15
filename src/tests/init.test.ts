import {describe, expect, test} from '@jest/globals';
import { SmartContract } from "ton-contract-executor";
import {Address, Cell, CellMessage, CommonMessageInfo, ExternalMessage, InternalMessage, Slice, toNano} from "ton";
import Utils from './utils';
import BN from "bn.js";


describe("telemint", () => {
    test("nft-item compiles?", async () => {
        await Utils.compileAndGetItem()
    })
    test("nft-collection compiles?", async () => {
        await Utils.compileAndGetCollection()
    })
    test('should handle topup', async () => {
        let collection = await Utils.compileAndGetCollection()
        collection.setBalance(new BN(500))
        let msgBody = new Cell()
        msgBody.bits.writeUint(0, 32)
        msgBody.bits.writeBuffer(Buffer.from("#topup", "utf-8"))
        let res = await collection.sendInternalMessage(new InternalMessage({
            to: Address.parse('EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6_0t'),
            value: toNano(1),
            bounce: false,
            body: new CommonMessageInfo({
                body: new CellMessage(msgBody)
            })
        }))
        expect(res.exit_code).toEqual(0)
    })
    test('should reject wrong topup', async () => {
        let collection = await Utils.compileAndGetCollection()
        collection.setBalance(new BN(500))
        let msgBody = new Cell()
        msgBody.bits.writeUint(0, 32)
        msgBody.bits.writeBuffer(Buffer.from("#topup - wrong one!", "utf-8"))
        let res = await collection.sendInternalMessage(new InternalMessage({
            to: Address.parse('EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6_0t'),
            value: toNano(1),
            bounce: false,
            body: new CommonMessageInfo({
                body: new CellMessage(msgBody)
            })
        }))
        expect(res.exit_code).toEqual(207)
    })
})