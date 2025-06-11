import { Blockchain, SandboxContract, TreasuryContract, BlockchainSnapshot, SendMessageResult } from '@ton/sandbox';
import { Cell, toNano, beginCell, Transaction, ExternalAddress } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { randomAddress, getRandomInt } from './utils';
import { auctionConfigToCell, AuctionParameters, ItemRestrictions, NewNftItem, NftCollection, NftContent, nftContentToCell, RoyaltyParameters, royaltyParamsToCell } from '../wrappers/NftCollection';
import { NftItem } from '../wrappers/NftItem';
import { Op, Errors } from '../wrappers/NftConstants';
import { collectCellStats, computedGeneric, computeMessageForwardFees, getMsgPrices, reportGas, storageGeneric } from './gasUtils';
import { findTransactionRequired } from '@ton/test-utils';
import { getSecureRandomBytes, KeyPair, keyPairFromSeed, sha256 } from '@ton/crypto';

describe('NFT', () => {
    let collection_code = new Cell();
    let item_code = new Cell();
    let blockchain: Blockchain;
    let deployer:SandboxContract<TreasuryContract>;
    let royaltyWallet:SandboxContract<TreasuryContract>;
    let minterTreasury: SandboxContract<TreasuryContract>;
    let otherBidder: SandboxContract<TreasuryContract>;
    let balanceStrict = false;

    let keyPair: KeyPair;

    let nftCollection: SandboxContract<NftCollection>;

    let regularItem: SandboxContract<NftItem>;

    let commonContent: string;
    let royaltyFactor: number;
    let royaltyBase: number;

    let defaultAuctionConfig: AuctionParameters;

    let initialState: BlockchainSnapshot;
    let itemsDeployedState: BlockchainSnapshot;
    let initialAuctionDone: BlockchainSnapshot;
    let ownerStartedAuction: BlockchainSnapshot;

    let msgPrices: ReturnType<typeof getMsgPrices>;

    const defaultTestName = "Test Item";
    const defaultContent: NftContent = { type: 'offchain', uri: 'my_nft.json' };
    const subwallet_id = 0;
    const min_storage  = toNano('0.03');

    let nftItemByName: (name: string) => Promise<SandboxContract<NftItem>>;

    let curTime: () => number;
    let computeNextBid: (cur_bid: bigint, bid_step: bigint) => bigint;
    let assertAuctionConfigIsEmpty: (item: SandboxContract<NftItem>, isEmpty: boolean) => Promise<void>;

    beforeAll(async () => {
        collection_code = await compile('NftCollection');
        keyPair = keyPairFromSeed(await getSecureRandomBytes(32));
        let collectionStats = collectCellStats(collection_code, []);
        console.log(`Deduplicated collection code stats: ${collectionStats.bits} bits ${collectionStats.cells} cells`);

        collectionStats = collectCellStats(collection_code, [], false, true);
        console.log(`Raw collection code takes ${collectionStats.bits} bits ${collectionStats.cells} cells`);

        item_code       = await compile('NftItem');
        let itemStats = collectCellStats(item_code, [], false, true)
        console.log(`Deduplicated item code stats: ${itemStats.bits} bits ${itemStats.cells} cells`);
        itemStats = collectCellStats(item_code, [], false, true)
        console.log(`Raw item code stats: ${itemStats.bits} bits ${itemStats.cells} cells`);

        blockchain = await Blockchain.create();

        blockchain.now = 1000;

        deployer       = await blockchain.treasury('deployer');
        royaltyWallet  = await blockchain.treasury('Royalty$toMe');
        minterTreasury = await blockchain.treasury('Minter treasury');
        otherBidder    = await blockchain.treasury('other_bidder');
        royaltyFactor  = getRandomInt(10, 50); // From 1 to 5 percent
        royaltyBase    = 1000;

        msgPrices = getMsgPrices(blockchain.config, 0);

        defaultAuctionConfig = {
                duration : 3600,
                benificiary: minterTreasury.address,
                min_bid: toNano('1'),
                max_bid: toNano('100'),
                min_extend_time: 1800,
                min_bid_step: 10n,
        };


        commonContent  = 'https://raw.githubusercontent.com/Trinketer22/token-contract/main/nft/web-example/'
        nftCollection  = blockchain.openContract(
            NftCollection.createFromConfig({
                subwallet_id,
                item_code,
                public_key: keyPair.publicKey,
                content: {type: 'offchain', uri:'https://raw.githubusercontent.com/Trinketer22/token-contract/main/nft/web-example/my_collection.json'},
                full_domain: "",
                royalty: {
                    address: royaltyWallet.address,
                    royalty_factor: royaltyFactor,
                    royalty_base: royaltyBase
                }
            }, collection_code)
        );

        const topUp = await deployer.send({
            to: nftCollection.address,
            value: toNano('1'),
            bounce: false
        });
        const deployRes = await nftCollection.sendDeploy(deployer.getSender(), toNano('1'));

        expect(deployRes.transactions).toHaveTransaction({
            on: nftCollection.address,
            aborted: false,
            deploy: true
        });

        nftItemByName = async (name) => {
            const idx = BigInt('0x' + (await sha256(name)).toString('hex'));
            return blockchain.openContract(
                NftItem.createFromAddress(
                    await nftCollection.getNftAddressByIndex(idx)
                )
            );
        }

        curTime = () => {
            return blockchain.now ?? Math.floor(Date.now() / 1000);
        }

        computeNextBid = (cur_bid, bid_step) => {
            let nextBid = (cur_bid * (100n + bid_step) + 99n) / 100n;
            let minNextBid = cur_bid + toNano('1');

            return nextBid > minNextBid ? nextBid : minNextBid;
        }

        assertAuctionConfigIsEmpty = async (item, isEmpty) => {
            const auctionConfig = await item.getAuctionConfig();
            if(isEmpty) {
                expect(auctionConfig.benificiary).toBeNull();
                expect(auctionConfig.max_bid).toBe(0n);
                expect(auctionConfig.initial_bid).toBe(0n);
                expect(auctionConfig.duration).toBe(0);
                expect(auctionConfig.extend_time).toBe(0);
            } else {
                expect(auctionConfig.benificiary).not.toBeNull();
                expect(auctionConfig.max_bid).not.toBe(0n);
                expect(auctionConfig.initial_bid).not.toBe(0n);
                expect(auctionConfig.duration).not.toBe(0);
                expect(auctionConfig.extend_time).not.toBe(0);
            }
        };

        initialState = blockchain.snapshot();
    });

    beforeEach(async () => await blockchain.loadFrom(initialState));

    describe('Collection', () => {
    it('collection should deploy', async () => {
        const collectionData = await nftCollection.getCollectionData();
        expect(collectionData.owner).toBe(null);
        expect(collectionData.nextItemIndex).toBe(-1);
    });

    it('admin should be able to deploy item', async () => {
        const bidValue = defaultAuctionConfig.min_bid + (BigInt(getRandomInt(1, 10)) * toNano('0.1'))
        const itemContentCell = nftContentToCell({type: 'offchain', uri: `my_nft.json`});
        const token_name = "Test item";
        const nftItem = await nftItemByName(token_name);

        const res = await nftCollection.sendDeployItem(deployer.getSender(), {
            token_name,
            actuion_config: defaultAuctionConfig,
            content: itemContentCell
        },
        {
            privateKey: keyPair.secretKey,
            valid_since: blockchain.now! - 1,
            valid_till: blockchain.now! + 100,
            subwallet_id
        }, bidValue);

        const collectionPart = findTransactionRequired(res.transactions,{
            on: nftCollection.address,
            from: deployer.address,
            aborted: false,
            outMessagesCount: 1
        });
        reportGas("Deploy on collection costs", collectionPart);

        const deployTx = findTransactionRequired(res.transactions, {
            on: nftItem.address,
            from: nftCollection.address,
            deploy: true,
            aborted: false
        });

        reportGas("Deploy on item costs", deployTx);

        const itemData = await nftItem.getNftData();

        expect(itemData.index).toEqual(BigInt('0x' + (await sha256(token_name)).toString('hex')));
        expect(itemData.isInit).toBe(true);
        expect(itemData.owner).toBe(null);

        expect(await nftItem.getTokenName()).toEqual(token_name);

        const auctionState = await nftItem.getAuctionState();
        expect(auctionState.bidder_address).toEqualAddress(deployer.address);
        expect(auctionState.bid).toEqual(bidValue);
        expect(auctionState.min_bid).toEqual(computeNextBid(bidValue, defaultAuctionConfig.min_bid_step));
        expect(auctionState.bid_ts).toEqual(deployTx.now);
        expect(auctionState.end_time).toEqual(deployTx.now + defaultAuctionConfig.duration);

        const royaltyParams = await nftItem.getRoyaltyParams();
        expect(royaltyParams.royalty_dst).toEqualAddress(royaltyWallet.address);
        expect(royaltyParams.factor).toEqual(BigInt(royaltyFactor));
        expect(royaltyParams.base).toEqual(BigInt(royaltyBase));

        regularItem = nftItem;

        itemsDeployedState = blockchain.snapshot();
    });
    it('collection should allow to deploy item with custom royalty parameters', async () => {
        const bidValue = defaultAuctionConfig.min_bid + (BigInt(getRandomInt(1, 10)) * toNano('0.1'))
        const customTokenName = "Custom royalty token";

        const nftItem = await nftItemByName(customTokenName);
        const newRoyalty : RoyaltyParameters = {
            address: randomAddress(0),
            royalty_base: royaltyBase * 2,
            royalty_factor: royaltyFactor * 3
        }

        const res = await nftCollection.sendDeployItem(deployer.getSender(), {
            token_name: customTokenName,
            actuion_config: defaultAuctionConfig,
            content: defaultContent,
            royalty: newRoyalty
        },
        {
            privateKey: keyPair.secretKey,
            valid_since: blockchain.now! - 1,
            valid_till: blockchain.now! + 100,
            subwallet_id
        }, bidValue);

        const collectionPart = findTransactionRequired(res.transactions,{
            on: nftCollection.address,
            from: deployer.address,
            aborted: false,
            outMessagesCount: 1
        });
        reportGas("Custom royalty deploy", collectionPart);

        const royaltyParams = await nftItem.getRoyaltyParams();
        expect(royaltyParams.royalty_dst).toEqualAddress(newRoyalty.address);
        expect(royaltyParams.base).toEqual(BigInt(newRoyalty.royalty_base));
        expect(royaltyParams.factor).toEqual(BigInt(newRoyalty.royalty_factor));
    });
    it.skip('collection should not allow to deploy item with malformed royalty', async () => {
        const bidValue = defaultAuctionConfig.min_bid + (BigInt(getRandomInt(1, 10)) * toNano('0.1'))
        const nftItem = await nftItemByName(defaultTestName);
        // Definitely not parsable, because string is stored in a ref
        const malformedRoyalty = beginCell().storeStringRefTail("Not a royalty you looking for").endCell();
        expect(malformedRoyalty.asSlice().remainingBits).toBe(0);

        const res = await nftCollection.sendDeployItem(deployer.getSender(), {
            token_name: defaultTestName,
            actuion_config: defaultAuctionConfig,
            content: defaultContent,
            royalty: malformedRoyalty
        },
        {
            privateKey: keyPair.secretKey,
            valid_since: blockchain.now! - 1,
            valid_till: blockchain.now! + 100,
            subwallet_id
        }, bidValue);

        expect(res.transactions).not.toHaveTransaction({
            on: nftItem.address,
            from: nftCollection.address,
            deploy: true,
            aborted: false
        });
        //So what?
        // Thing is that royalty is only unpacked during the end of the auction
        // And this will prevent the owner from changint
    });
    it('different key pair should not be able to deploy new items', async () => {
        let testKp: KeyPair;

        do {
            testKp = keyPairFromSeed(await getSecureRandomBytes(32));
        } while(testKp.secretKey.equals(keyPair.secretKey));

        for(let testState of [initialState, itemsDeployedState]) {
            await blockchain.loadFrom(testState);

            const res = await nftCollection.sendDeployItem(deployer.getSender(), {
                token_name: "Test token",
                actuion_config: defaultAuctionConfig,
                content: { type: 'offchain', uri: 'my_nft.json' }
            },
            {
                privateKey: testKp.secretKey,
                valid_since: curTime() - 1,
                valid_till: curTime() + 3600,
                subwallet_id
            }, defaultAuctionConfig.min_bid * 2n);

            expect(res.transactions).toHaveTransaction({
                on: nftCollection.address,
                from: deployer.address,
                op: Op.telemint_msg_deploy_v2,
                aborted: true,
                exitCode: Errors.invalid_signature
            });
        }
    });
    it('should reject not yet valid signatures', async () => {
        const now = curTime();

        let res = await nftCollection.sendDeployItem(deployer.getSender(), {
            token_name: defaultTestName,
            actuion_config: defaultAuctionConfig,
            content: defaultContent
        },
        {
            privateKey: keyPair.secretKey,
            valid_since: now, // Will reject because of > instead of >=
            valid_till: now + 3600,
            subwallet_id
        }, defaultAuctionConfig.min_bid * 2n);

        expect(res.transactions).toHaveTransaction({
            on: nftCollection.address,
            from: deployer.address,
            op: Op.telemint_msg_deploy_v2,
            aborted: true,
            exitCode: Errors.not_yet_valid_signature
        });

        blockchain.now = now + 1;
        res = await nftCollection.sendDeployItem(deployer.getSender(), {
            token_name: defaultTestName,
            actuion_config: defaultAuctionConfig,
            content: defaultContent
        },
        {
            privateKey: keyPair.secretKey,
            valid_since: now, // Will reject because of > instead of >=
            valid_till: now + 3600,
            subwallet_id
        }, defaultAuctionConfig.min_bid * 2n);

        expect(res.transactions).toHaveTransaction({
            on: nftCollection.address,
            from: deployer.address,
            op: Op.telemint_msg_deploy_v2,
            aborted: false
        });
    });
    it('should reject expired signatures', async () => {
        const valid_since = curTime() - 1;
        const valid_time = 3600;
        const prevState = blockchain.snapshot();

        let res = await nftCollection.sendDeployItem(deployer.getSender(), {
            token_name: defaultTestName,
            actuion_config: defaultAuctionConfig,
            content: defaultContent
        },
        {
            privateKey: keyPair.secretKey,
            valid_since,
            valid_till: valid_since + valid_time,
            subwallet_id
        }, defaultAuctionConfig.min_bid * 2n);

        blockchain.now = valid_since + valid_time - 1;

        expect(res.transactions).toHaveTransaction({
            on: nftCollection.address,
            from: deployer.address,
            op: Op.telemint_msg_deploy_v2,
            aborted: false
        });

        await blockchain.loadFrom(prevState);

        blockchain.now = valid_since + valid_time;

        res = await nftCollection.sendDeployItem(deployer.getSender(), {
            token_name: defaultTestName,
            actuion_config: defaultAuctionConfig,
            content: defaultContent
        },
        {
            privateKey: keyPair.secretKey,
            valid_since,
            valid_till: valid_since + valid_time,
            subwallet_id
        }, defaultAuctionConfig.min_bid * 2n);

        expect(res.transactions).toHaveTransaction({
            on: nftCollection.address,
            from: deployer.address,
            op: Op.telemint_msg_deploy_v2,
            aborted: true,
            exitCode: Errors.expired_signature
        });
    });
    it('should reject signatures for different subwallet_id', async () => {
        const randomSubwallet = subwallet_id + getRandomInt(1, 100000);
        const valid_since = curTime() - 1;
        const valid_till  = valid_since + 3600;

        let res = await nftCollection.sendDeployItem(deployer.getSender(), {
            token_name: defaultTestName,
            actuion_config: defaultAuctionConfig,
            content: defaultContent
        },
        {
            privateKey: keyPair.secretKey,
            valid_since,
            valid_till,
            subwallet_id: randomSubwallet
        }, defaultAuctionConfig.min_bid * 2n);

        expect(res.transactions).toHaveTransaction({
            on: nftCollection.address,
            from: deployer.address,
            op: Op.telemint_msg_deploy_v2,
            aborted: true,
            exitCode: Errors.wrong_subwallet_id
        });
    });
    it('sender restriction should reject other senders', async () => {
        const allowedSender = await blockchain.treasury('allowed_sender');

        const nftItem = await nftItemByName(defaultTestName);

        let forceAllowed: ItemRestrictions = {
            force_sender: allowedSender.address,
            rewrite_sender: null
        };

        // Make sure this case will be rejected too
        let forceAllowedRewrite: ItemRestrictions = {
            force_sender: allowedSender.address,
            rewrite_sender: deployer.address
        }

        for(let restrictions of [ forceAllowed, forceAllowedRewrite ]) {
            let res = await nftCollection.sendDeployItem(deployer.getSender(), {
                token_name: defaultTestName,
                actuion_config: defaultAuctionConfig,
                content: defaultContent,
                restrictions
            },
            {
                privateKey: keyPair.secretKey,
                valid_since: blockchain.now! - 1,
                valid_till: blockchain.now! + 3600,
                subwallet_id
            }, defaultAuctionConfig.min_bid * 2n);

            expect(res.transactions).toHaveTransaction({
                on: nftCollection.address,
                op: Op.telemint_msg_deploy_v2,
                aborted: true,
                exitCode: Errors.invalid_sender_address
            });
        }

        let res = await nftCollection.sendDeployItem(allowedSender.getSender(), {
            token_name: defaultTestName,
            actuion_config: defaultAuctionConfig,
            content: defaultContent,
            restrictions: {
                force_sender: allowedSender.address,
                rewrite_sender: null
            }
        },
        {
            privateKey: keyPair.secretKey,
            valid_since: blockchain.now! - 1,
            valid_till: blockchain.now! + 3600,
            subwallet_id
        }, defaultAuctionConfig.min_bid * 2n);

        const deployTx = findTransactionRequired(res.transactions, {
            on: nftCollection.address,
            op: Op.telemint_msg_deploy_v2,
            aborted: false,
            outMessagesCount: 1
        });

        expect(res.transactions).toHaveTransaction({
            on: nftItem.address,
            from: nftCollection.address,
            deploy: true,
            aborted: false
        });
        reportGas("Force sender restrictions deploy", deployTx);

        const auctionState = await nftItem.getAuctionState();
        expect(auctionState.bidder_address).toEqualAddress(allowedSender.address);
    });
    it('restrictions sender overwrite should work', async () => {
        const allowedSender = await blockchain.treasury('allowed_sender');
        const prevState = blockchain.snapshot();

        let justRewrite: ItemRestrictions = {
            force_sender: null,
            rewrite_sender: deployer.address
        };

        // Negative tested in previous case
        let forceAllowedRewrite: ItemRestrictions = {
            force_sender: allowedSender.address,
            rewrite_sender: deployer.address
        }

        const bidValue = defaultAuctionConfig.min_bid * 2n;
        for(let restrictions of [ justRewrite, forceAllowedRewrite ]) {
            let res = await nftCollection.sendDeployItem(allowedSender.getSender(), {
                token_name: defaultTestName,
                actuion_config: defaultAuctionConfig,
                content: { type: 'offchain', uri: 'my_nft.json' },
                restrictions
            },
            {
                privateKey: keyPair.secretKey,
                valid_since: blockchain.now! - 1,
                valid_till: blockchain.now! + 3600,
                subwallet_id
            }, bidValue);

            const deployTx = findTransactionRequired(res.transactions, {
                on: nftCollection.address,
                op: Op.telemint_msg_deploy_v2,
                aborted: false
            });

            const nftItem = await nftItemByName(defaultTestName);

            expect(res.transactions).toHaveTransaction({
                on: nftItem.address,
                from: nftCollection.address,
                deploy: true,
                aborted: false
            });

            if(restrictions === justRewrite) {
                reportGas("Rewrite restrictions deploy", deployTx);
            } else {
                reportGas("Rewrite and force sender restrictions deploy", deployTx);
            }
            const auctionState = await nftItem.getAuctionState();

            expect(auctionState.bidder_address).toEqualAddress(deployer.address);
            expect(auctionState.bid).toEqual(bidValue);
            expect(auctionState.min_bid).toEqual(computeNextBid(bidValue, defaultAuctionConfig.min_bid_step));
            expect(auctionState.bid_ts).toEqual(deployTx.now);

            await blockchain.loadFrom(prevState);
        }
    });


    it.skip('should return joined content', async () => {
        const testContent = nftContentToCell({type: 'offchain', 'uri': 'my_nft.json'});
        const resContent = await nftCollection.getNftContent(1, testContent);
        expect(resContent).toEqualCell(beginCell()
                                            .storeUint(1, 8)
                                            .storeStringTail(commonContent)
                                            .storeRef(testContent)
                                          .endCell());
    });
    it('item should return royalty parameters', async () => {
        await blockchain.loadFrom(itemsDeployedState);
        const msgPrices = getMsgPrices(blockchain.config, 0);
        const msgValue  = toNano('0.05');
        const queryId   = getRandomInt(0, 100);

        const res = await regularItem.sendGetRoyaltyParams(deployer.getSender(), msgValue, queryId);

        const getRoyaltyTx = findTransactionRequired(res.transactions, {
            on: regularItem.address,
            from: deployer.address,
            op: Op.get_royalty_params,
            aborted: false,
            outMessagesCount: 1
        });

        const outMsg = getRoyaltyTx.outMessages.get(0)!;
        if(outMsg.info.type !== 'internal') {
            throw Error("No way!");
        }

        reportGas("Report royalty parameters", getRoyaltyTx);
        const fwdFee       = computeMessageForwardFees(msgPrices, outMsg);
        const computePhase = computedGeneric(getRoyaltyTx);

        expect(res.transactions).toHaveTransaction({
            on: deployer.address,
            from: regularItem.address,
            value: msgValue - fwdFee.fees.total - computePhase.gasFees, // Should return change
            body: beginCell()
                    .storeUint(Op.report_royalty_params, 32)
                    .storeUint(queryId, 64)
                    .storeUint(royaltyFactor, 16)
                    .storeUint(royaltyBase, 16)
                    .storeAddress(royaltyWallet.address)
                  .endCell()
        });
    });
    });
    describe('Auction', () => {
        let bidsMade: BlockchainSnapshot;
        let ownerBidsMade: BlockchainSnapshot;
        let assertAuctionEnded: ( item: SandboxContract<NftItem>,endAuction: (item: SandboxContract<NftItem>, bid: bigint) => Promise<SendMessageResult>, bid?: bigint) => Promise<SendMessageResult>;

        beforeAll(() => {
            assertAuctionEnded = async (item, endAuction, bid: bigint = 0n) => {

                const smc = await blockchain.getContract(item.address);
                let balanceBefore = smc.balance;
                const auctionState = await item.getAuctionState();
                const configBefore  = await item.getAuctionConfig();
                const stateBefore   = await item.getNftData();
                const royaltyParams = await item.getRoyaltyParams();

                // Was't empty before
                expect(configBefore.benificiary).not.toBeNull();
                expect(configBefore.max_bid).not.toBe(0n);
                expect(configBefore.initial_bid).not.toBe(0n);
                expect(configBefore.duration).not.toBe(0);
                expect(configBefore.extend_time).not.toBe(0);

                const res = await endAuction(item, bid) // await item.sendBet(otherBidder.getSender(), defaultAuctionConfig.max_bid);

                const newOwner = (await item.getNftData()).owner;

                const newBid = bid > 0n && auctionState.bid > 0n;
                const bidTx = findTransactionRequired(res.transactions, {
                    on: item.address,
                    value: bid > 0n ? bid : undefined, // If no bid specify, just don't check value at all
                    aborted: false,
                    outMessagesCount: newBid ? 4 : 3
                });

                const computed = computedGeneric(bidTx);
                const storage  = storageGeneric(bidTx);

                const configAfter = await item.getAuctionConfig();
                expect(configAfter.benificiary).toBeNull();
                expect(configAfter.max_bid).toEqual(0n);
                expect(configAfter.initial_bid).toEqual(0n);
                expect(configAfter.duration).toEqual(0);
                expect(configAfter.extend_time).toEqual(0);

                let bidTs: number;
                let lastBid: bigint;
                let inFee = 0n;

                if(bid > 0n) {
                    if(auctionState.bidder_address !== null) {
                        expect(res.transactions).toHaveTransaction({
                            on: auctionState.bidder_address,
                            value: auctionState.bid,
                            op: Op.outbid_notification
                        });
                    }
                    lastBid = bid;
                    bidTs   = bidTx.now;
                } else {
                    lastBid = auctionState.bid;
                    bidTs   = auctionState.bid_ts;
                    if(bidTx.inMessage!.info.type == 'external-in') {
                        inFee = msgPrices.lumpPrice;
                    }
                }

                const royaltyAmount = lastBid * royaltyParams.factor / royaltyParams.base;
                expect(res.transactions).toHaveTransaction({
                    on: royaltyWallet.address,
                    op: Op.fill_up,
                    value: royaltyAmount - msgPrices.lumpPrice
                });

                const balanceDuring = balanceBefore - storage.storageFeesCollected - inFee + (lastBid - auctionState.bid) - royaltyAmount;
                let expTransfer = configBefore.benificiary?.equals(royaltyParams.royalty_dst) ? lastBid : lastBid - royaltyAmount;

                if(expTransfer > balanceDuring - min_storage) {
                    expTransfer = balanceDuring - min_storage;
                }

                expect(res.transactions).toHaveTransaction({
                    from: item.address,
                    on: newOwner ?? undefined,
                    body: beginCell()
                            .storeUint(Op.ownership_assigned, 32)
                            .storeUint(bidTx.lt, 64)
                            .storeAddress(stateBefore.owner)
                            .storeUint(0, 1)
                            .storeUint(Op.teleitem_bid_info, 32)
                            .storeCoins(lastBid)
                            .storeUint(bidTs, 32)
                         .endCell()
                });
                expect(res.transactions).toHaveTransaction({
                    on: configBefore.benificiary ?? undefined,
                    op: Op.fill_up,
                    value: expTransfer - msgPrices.lumpPrice,
                });

                if(balanceStrict) {
                    expect(smc.balance).toBeGreaterThanOrEqual(min_storage);
                }
                return res;
            }
        });
        beforeEach(async () => await blockchain.loadFrom(itemsDeployedState));

        it('not accept bid below min_bid', async () => {
            const auctionState = await regularItem.getAuctionState();
            const newBet = auctionState.min_bid - 1n;

            for(let testWallet of [otherBidder, deployer]) {
                const res = await regularItem.sendBet(testWallet.getSender(), newBet);
                    expect(res.transactions).toHaveTransaction({
                        on: regularItem.address,
                        value: newBet,
                        aborted: true,
                        exitCode: Errors.too_small_stake
                    });
                }
        });

        it('should accept bit higher than min_bid and increase next bid accordingly to bid_step', async () => {
            let auctionState = await regularItem.getAuctionState();
            let betBefore = auctionState.min_bid;
            let newBet = betBefore + 200n;
            const endTimeBefore = auctionState.end_time;
            // Min bid step is 10%, meaning that if 10% of new bet <= 1 TON
            // next bet should be max(newBet + 1TON, newBet * 1.10)
            let nextBet = computeNextBid(newBet, defaultAuctionConfig.min_bid_step);

            blockchain.now = curTime() + getRandomInt(1, 1000);
            let res = await regularItem.sendBet(otherBidder.getSender(), newBet);

            const smc = await blockchain.getContract(regularItem.address);

            let bidTx = findTransactionRequired(res.transactions, {
                on:regularItem.address,
                from: otherBidder.address,
                value: newBet,
                aborted: false,
                outMessagesCount: 1
            });

            reportGas("Outbid bid_step < 1 TON", bidTx);

            expect(res.transactions).toHaveTransaction({
                on: deployer.address,
                from: regularItem.address,
                value: auctionState.bid
            })

            auctionState = await regularItem.getAuctionState();

            expect(auctionState.bidder_address).toEqualAddress(otherBidder.address);
            expect(auctionState.min_bid).toEqual(nextBet);
            expect(nextBet - betBefore).toEqual(toNano('1') + (newBet - betBefore));
            expect(auctionState.bid).toEqual(newBet);
            expect(auctionState.bid_ts).toEqual(blockchain.now);
            expect(auctionState.end_time).toEqual(endTimeBefore);

            betBefore = auctionState.min_bid;
            newBet = betBefore + toNano('11');
            nextBet = computeNextBid(newBet, defaultAuctionConfig.min_bid_step);

            // Now let's test case where nextBet 10% is larger than 1 TON

            res = await regularItem.sendBet(deployer.getSender(), newBet);

            bidTx = findTransactionRequired(res.transactions, {
                on:regularItem.address,
                from: deployer.address,
                value: newBet,
                aborted: false,
                outMessagesCount: 1
            });

            reportGas("Outbid bid_step > 1 TON", bidTx);
            expect(res.transactions).toHaveTransaction({
                on: otherBidder.address,
                from: regularItem.address,
                value: auctionState.bid
            });
            expect(smc.balance).toBeGreaterThanOrEqual(min_storage);

            auctionState = await regularItem.getAuctionState();

            expect(auctionState.bidder_address).toEqualAddress(deployer.address);
            expect(auctionState.min_bid).toEqual(nextBet);
            expect(nextBet - betBefore).toBeGreaterThan(toNano('1') + (newBet - betBefore));
            expect(auctionState.bid).toEqual(newBet);
            expect(auctionState.end_time).toEqual(endTimeBefore);

            expect(smc.balance).toBeGreaterThanOrEqual(min_storage);

            bidsMade = blockchain.snapshot();
        });
        it('should be able to extend auction with new stake', async () => {
            await blockchain.loadFrom(bidsMade);
            const stateBefore = await regularItem.getAuctionState();

            blockchain.now = stateBefore.end_time - getRandomInt(1, defaultAuctionConfig.min_extend_time - 1);
            const res = await regularItem.sendBet(otherBidder.getSender(), stateBefore.min_bid + 1n);

            expect(res.transactions).toHaveTransaction({
                on: regularItem.address,
                from: otherBidder.address,
                value: stateBefore.min_bid + 1n,
                aborted: false
            });

            const stateAfter = await regularItem.getAuctionState();
            expect(stateAfter.end_time).toEqual(blockchain.now + defaultAuctionConfig.min_extend_time);
            expect(stateAfter.end_time).toBeGreaterThan(stateBefore.end_time);
        });
        it('should be able to end initial auction when time expire', async () => {
            await blockchain.loadFrom(bidsMade);
            const stateBefore = await regularItem.getAuctionState();

            let reported = false;

            for (let testTime of [stateBefore.end_time, stateBefore.end_time + getRandomInt(1, 360000)]) {
                blockchain.now = testTime;

                const res = await assertAuctionEnded(regularItem, async (item, bid) => await item.sendCheckEndExternal(), 0n);
                if(!reported) {
                    reportGas("Auction ended external", res.transactions[0]);
                    reported = true;
                }
                initialAuctionDone = blockchain.snapshot();
                await blockchain.loadFrom(itemsDeployedState);
            }
            // Should not end
            blockchain.now = stateBefore.end_time - 1;
            expect(assertAuctionEnded(regularItem, async (item, bid) => await item.sendCheckEndExternal(), 0n)).rejects.toThrow();
        });

        it('should not accept bids after end_time', async () => {
            const stateBefore = await regularItem.getAuctionState();
            blockchain.now = stateBefore.end_time + 1;
            const res = await regularItem.sendBet(otherBidder.getSender(), stateBefore.min_bid + 1n);
            expect(res.transactions).toHaveTransaction({
                on: regularItem.address,
                from: otherBidder.address,
                aborted: true,
                exitCode: Errors.forbidden_topup
            });
        });

        it('should be able to end initial auction by reaching max bid', async () => {
            let reported = false;
            for(let testState of [itemsDeployedState, bidsMade]) {
                await blockchain.loadFrom(bidsMade);
                for(let testBid of [defaultAuctionConfig.max_bid, defaultAuctionConfig.max_bid * 2n]) {
                    const res = await assertAuctionEnded(regularItem, async (item, bid) => item.sendBet(otherBidder.getSender(), bid), testBid);

                    if(!reported) {
                        reportGas("Auction ended max_bid", findTransactionRequired(res.transactions, {
                            on: regularItem.address,
                            from: otherBidder.address,
                            aborted: false
                        }));
                        reported = true;
                    }
                    expect((await regularItem.getNftData()).owner).toEqualAddress(otherBidder.address);
                    await blockchain.loadFrom(testState);
                    // Other sender should not matter
                    await assertAuctionEnded(regularItem, async (item, bid) => item.sendBet(deployer.getSender(), bid), testBid);
                    expect((await regularItem.getNftData()).owner).toEqualAddress(deployer.address);
                    await blockchain.loadFrom(testState);
                }
                // Souldn't end if off by one
                await expect(assertAuctionEnded(regularItem, async (item, bid) => item.sendBet(otherBidder.getSender(), bid), defaultAuctionConfig.max_bid - 1n)).rejects.toThrow();
            }
        });
        it('non-owner should not be able to start an auction', async () => {
            await blockchain.loadFrom(initialAuctionDone);

            const itemData = await regularItem.getNftData();
            expect(itemData.owner).not.toEqualAddress(otherBidder.address);

            await assertAuctionConfigIsEmpty(regularItem, true);

            const minBid = BigInt(getRandomInt(2, 5)) * min_storage;

            const newConfig: AuctionParameters = {
                min_bid: minBid,
                max_bid: BigInt(getRandomInt(10, 100)) * minBid,
                duration: getRandomInt(1, 3600) * 60,
                min_extend_time:getRandomInt(10, 1800),
                benificiary: randomAddress(0),
                min_bid_step: BigInt(getRandomInt(10, 100))
            }

            for(let testConfig of [newConfig, defaultAuctionConfig]) {
                const res = await regularItem.sendStartAuction(otherBidder.getSender(), testConfig);
                expect(res.transactions).toHaveTransaction({
                    on: regularItem.address,
                    from: otherBidder.address,
                    op: Op.teleitem_start_auction,
                    aborted: true,
                    exitCode: Errors.forbidden_auction
                });
            }
        });
        it('owner should be able to start an auction', async () => {
            await blockchain.loadFrom(initialAuctionDone);
            const itemData = await regularItem.getNftData();

            expect(itemData.owner).toEqualAddress(deployer.address);
            const testAddress = randomAddress(0);

            await assertAuctionConfigIsEmpty(regularItem, true);

            const minBid = BigInt(getRandomInt(2, 5)) * min_storage;

            const newConfig: AuctionParameters = {
                min_bid: minBid,
                max_bid: BigInt(getRandomInt(100, 10000)) * toNano('1'),
                duration: getRandomInt(1, 3600) * 60,
                min_extend_time:getRandomInt(10, 1800),
                benificiary: testAddress,
                min_bid_step: BigInt(getRandomInt(1, 100))
            }

            const res = await regularItem.sendStartAuction(deployer.getSender(), newConfig);

            const startTx = findTransactionRequired(res.transactions, {
                on: regularItem.address,
                op: Op.teleitem_start_auction,
                aborted: false
            });
            reportGas("Auction start", startTx);

            const auctionAfter = await regularItem.getAuctionConfig();

            expect(auctionAfter.duration).toEqual(newConfig.duration);
            expect(auctionAfter.max_bid).toEqual(newConfig.max_bid);
            expect(auctionAfter.initial_bid).toEqual(newConfig.min_bid);
            expect(auctionAfter.min_bid_step).toEqual(newConfig.min_bid_step);
            expect(auctionAfter.extend_time).toEqual(newConfig.min_extend_time);
            expect(auctionAfter.benificiary).toEqualAddress(newConfig.benificiary);

            ownerStartedAuction = blockchain.snapshot();
        });
        it('If no bids were made, owner should be able to get item back on time expiration', async () => {
            await blockchain.loadFrom(ownerStartedAuction);
            const curState = await regularItem.getAuctionState();
            assertAuctionConfigIsEmpty(regularItem, false);
            const itemBefore = await regularItem.getNftData();

            blockchain.now = curState.end_time;

            const res =await regularItem.sendCheckEndExternal();
            assertAuctionConfigIsEmpty(regularItem, true);
            reportGas("End auction, no bids", res.transactions[0]);

            const itemAfter = await regularItem.getNftData();
            expect(itemBefore.owner).toEqualAddress(itemAfter.owner!);

        });
        it.skip('should not be able to start auction with non-standard benificiary address', async () => {
            await blockchain.loadFrom(initialAuctionDone);
            const itemData = await regularItem.getNftData();

            expect(itemData.owner).toEqualAddress(deployer.address);
            await assertAuctionConfigIsEmpty(regularItem, true);

            const ds = auctionConfigToCell(defaultAuctionConfig).beginParse();
            // Skip address
            ds.loadAddress();

            const addrNone = beginCell().storeUint(0, 2).storeSlice(ds).endCell();
            const externalAddr = beginCell().storeAddress(new ExternalAddress(42n, 256)).storeSlice(ds).endCell();
            const varAddress   = beginCell().storeUint(0b11, 2).storeBit(false).storeUint(256, 9).storeUint(0, 32).storeUint(42n, 256).storeSlice(ds).endCell();

            for(let testPayload of [addrNone, varAddress, externalAddr]) {
                let res = await regularItem.sendStartAuction(deployer.getSender(), testPayload);

                // Auction should stay empty
                await assertAuctionConfigIsEmpty(regularItem, true);
                expect(res.transactions).toHaveTransaction({
                    on: regularItem.address,
                    from: deployer.address,
                    op: Op.teleitem_start_auction,
                    aborted: true 
                });
            }
        });
        it('should only accept auction with min_bid >= minimal value', async () => {
            await blockchain.loadFrom(initialAuctionDone);

            const itemData = await regularItem.getNftData();
            expect(itemData.owner).toEqualAddress(deployer.address);

            // Minimal value from contract
            const minValue = min_storage * 2n;
            await assertAuctionConfigIsEmpty(regularItem, true);

            let res = await regularItem.sendStartAuction(deployer.getSender(), {...defaultAuctionConfig, min_bid: minValue - 1n});
            await assertAuctionConfigIsEmpty(regularItem, true);

            res = await regularItem.sendStartAuction(deployer.getSender(), {...defaultAuctionConfig, min_bid: minValue});
            await assertAuctionConfigIsEmpty(regularItem, false);
        });
        it('minimal bid value should be enough for auction with expected duration to happen', async () => {
            /**
             * NOTE
             * Nft content cell has, no upper limit, so
             * theoretically, one could still
             * deploy item with larger that expected content,
             * and exceed min_storage over the duration period
             **/
            await blockchain.loadFrom(initialAuctionDone);

            let itemData = await regularItem.getNftData();
            expect(itemData.owner).toEqualAddress(deployer.address);
            await assertAuctionConfigIsEmpty(regularItem, true);

            const minValue = min_storage * 2n;
            // Max duration from contract
            const maxDuration = 3600 * 24 * 365;

            let res = await regularItem.sendStartAuction(deployer.getSender(), {...defaultAuctionConfig, min_bid: minValue, duration: maxDuration});
            await assertAuctionConfigIsEmpty(regularItem, false);

            // Sending absolute minimal bid
            res = await regularItem.sendBet(otherBidder.getSender(), minValue);

            const auctionAfter = await regularItem.getAuctionState();
            expect(auctionAfter.bidder_address).toEqualAddress(otherBidder.address);
            expect(auctionAfter.bid).toEqual(minValue);

            blockchain.now = curTime() + maxDuration;
            await assertAuctionEnded(regularItem, async (item, bid) => item.sendCheckEndExternal(), 0n);
        });
        it('should only accept auctions with min_bid_step > 0', async () => {
            // Actually it can't be < 0, because it is loaded as unsigned (load_uint(8))
            await blockchain.loadFrom(initialAuctionDone);
            await assertAuctionConfigIsEmpty(regularItem, true);

            let res = await regularItem.sendStartAuction(deployer.getSender(), {...defaultAuctionConfig, min_bid_step: 0n});
            await assertAuctionConfigIsEmpty(regularItem, true);

            for(let testStep of [1n, 255n, BigInt(getRandomInt(2, 254))]) {
                res = await regularItem.sendStartAuction(deployer.getSender(), {...defaultAuctionConfig, min_bid_step: testStep});
                await assertAuctionConfigIsEmpty(regularItem, false);
                await blockchain.loadFrom(initialAuctionDone);
            }
        });
        it('should not accept auctions with max_bid < min_bid, unless max_bid = 0', async () => {
            await blockchain.loadFrom(initialAuctionDone);

            let minValue = Number(min_storage * 2n) + 1;
            let minBid = 0;
            let maxBid = 0;

            const itemData = await regularItem.getNftData();
            expect(itemData.owner).toEqualAddress(deployer.address);

            await assertAuctionConfigIsEmpty(regularItem, true);

            for(let i = 0; i < 5; i++) {
                do {
                    let bidA = getRandomInt(minValue, 10 ** 9);
                    let bidB = getRandomInt(minValue, 10 ** 9);
                    // Remember, we're flipping how it's supposed to be
                    if(bidA > bidB) {
                        minBid = bidA;
                        maxBid = bidB;
                    } else {
                        minBid = bidB;
                        maxBid = bidA;
                    }
                } while(maxBid == minBid);

                expect(maxBid).toBeLessThan(minBid);
                await regularItem.sendStartAuction(deployer.getSender(), {...defaultAuctionConfig, min_bid: BigInt(minBid), max_bid: BigInt(maxBid)});
                const auctionConfig = await regularItem.getAuctionConfig();
                expect(auctionConfig.max_bid).not.toBeLessThan(auctionConfig.initial_bid);
                await assertAuctionConfigIsEmpty(regularItem, true);
            }
            // But should accept max_bid 0
            await regularItem.sendStartAuction(deployer.getSender(), {...defaultAuctionConfig, min_bid: BigInt(minBid), max_bid: BigInt(maxBid)});
        });
        it('owner should not be able to re-start already started auction', async () => {
            await blockchain.loadFrom(ownerStartedAuction);

            assertAuctionConfigIsEmpty(regularItem, false);
            const minBid = BigInt(getRandomInt(2, 5)) * min_storage;

            const newConfig: AuctionParameters = {
                min_bid: minBid,
                max_bid: BigInt(getRandomInt(10, 100)) * minBid,
                duration: getRandomInt(1, 3600) * 60,
                min_extend_time:getRandomInt(10, 1800),
                benificiary: randomAddress(0),
                min_bid_step: BigInt(getRandomInt(1, 100))
            }

            for(let testConfig of [newConfig, defaultAuctionConfig]) {
                const res = await regularItem.sendStartAuction(deployer.getSender(), testConfig);
                expect(res.transactions).toHaveTransaction({
                    on: regularItem.address,
                    from: deployer.address,
                    op: Op.teleitem_start_auction,
                    aborted: true,
                    exitCode: Errors.forbidden_not_stake
                });
            }
        });
        it('owner should be able to cancel auction if no bids made', async () => {
            await blockchain.loadFrom(ownerStartedAuction);

            // Config is not empty
            await assertAuctionConfigIsEmpty(regularItem, false);

            const res = await regularItem.sendCancelAuction(deployer.getSender());
            const cancelTx = findTransactionRequired(res.transactions,{
                on: regularItem.address,
                from: deployer.address,
                op: Op.teleitem_cancel_auction,
                aborted: false
            });
            // Now should become empty
            await assertAuctionConfigIsEmpty(regularItem, true);
            reportGas("Cancel auction", cancelTx);
        });
        it('owner started auction should handle bids in same way as initial auction', async () => {
            await blockchain.loadFrom(ownerStartedAuction);

            let auctionState = await regularItem.getAuctionState();
            const auctionConfig = await regularItem.getAuctionConfig();
            // Litteraly copy case
            let betBefore = auctionState.min_bid;
            let newBet = betBefore + 1n;
            const endTimeBefore = auctionState.end_time;
            // Min bid step is 10%, meaning that if 10% of new bet <= 1 TON
            // next bet should be max(newBet + 1TON, newBet * 1.10)
            let nextBet = computeNextBid(newBet, defaultAuctionConfig.min_bid_step);

            blockchain.now = curTime() + getRandomInt(1, 1000);
            let res = await regularItem.sendBet(otherBidder.getSender(), newBet);

            const smc = await blockchain.getContract(regularItem.address);

            let msgCount = 0;
            if(auctionState.bid > 0n) {
                expect(res.transactions).toHaveTransaction({
                    on: deployer.address,
                    from: regularItem.address,
                    value: auctionState.bid
                })

                msgCount = 1;
            }
            let bidTx = findTransactionRequired(res.transactions, {
                on:regularItem.address,
                from: otherBidder.address,
                value: newBet,
                aborted: false,
                outMessagesCount: msgCount
            });

            reportGas("First bid", bidTx);

            auctionState = await regularItem.getAuctionState();

            expect(auctionState.bidder_address).toEqualAddress(otherBidder.address);
            expect(auctionState.min_bid).toEqual(nextBet);
            expect(nextBet - betBefore).toEqual(toNano('1') + (newBet - betBefore));
            expect(auctionState.bid).toEqual(newBet);
            expect(auctionState.bid_ts).toEqual(blockchain.now);
            expect(auctionState.end_time).toEqual(endTimeBefore);

            betBefore = auctionState.min_bid;
            newBet = betBefore + toNano('11');
            nextBet = computeNextBid(newBet, auctionConfig.min_bid_step);

            // Now let's test case where nextBet 10% is larger than 1 TON

            res = await regularItem.sendBet(deployer.getSender(), newBet);

            bidTx = findTransactionRequired(res.transactions, {
                on:regularItem.address,
                from: deployer.address,
                value: newBet,
                aborted: false,
                // outMessagesCount: 1
            });

            reportGas("Next bid", bidTx);
            expect(res.transactions).toHaveTransaction({
                on: otherBidder.address,
                from: regularItem.address,
                value: auctionState.bid
            });
            expect(smc.balance).toBeGreaterThanOrEqual(min_storage);

            auctionState = await regularItem.getAuctionState();

            expect(auctionState.bidder_address).toEqualAddress(deployer.address);
            expect(auctionState.min_bid).toEqual(nextBet);
            expect(nextBet - betBefore).toBeGreaterThan(toNano('1') + (newBet - betBefore));
            expect(auctionState.bid).toEqual(newBet);
            expect(auctionState.end_time).toEqual(endTimeBefore);

            expect(smc.balance).toBeGreaterThanOrEqual(min_storage);

            ownerBidsMade = blockchain.snapshot();
        });
        it('owner should not be able to cancel auction when bids were maid', async () => {
            await blockchain.loadFrom(ownerBidsMade);
            const itemData = await regularItem.getNftData();
            expect(itemData.owner).toEqualAddress(deployer.address);
            await assertAuctionConfigIsEmpty(regularItem, false);

            const res = await regularItem.sendCancelAuction(deployer.getSender());
            expect(res.transactions).toHaveTransaction({
                on: regularItem.address,
                from: deployer.address,
                op: Op.teleitem_cancel_auction,
                aborted: true,
                exitCode: Errors.already_has_stakes
            });
        });
        it('owner should not be able to transfer item while auction is active', async () => {
            await blockchain.loadFrom(ownerBidsMade);
            const itemData = await regularItem.getNftData();
            expect(itemData.owner).toEqualAddress(deployer.address);
            await assertAuctionConfigIsEmpty(regularItem, false);
            const testAddress = randomAddress(0);

            const res = await regularItem.sendTransfer(deployer.getSender(), testAddress, deployer.address);

            expect(res.transactions).toHaveTransaction({
                on: regularItem.address,
                from: deployer.address,
                op: Op.transfer,
                aborted: true,
                exitCode: Errors.forbidden_not_stake
            });
        });
        it('should be able to end owner auction when time expire', async () => {
            let reported = false;
            await blockchain.loadFrom(ownerBidsMade);
            const stateBefore = await regularItem.getAuctionState();

            for (let testTime of [stateBefore.end_time, stateBefore.end_time + getRandomInt(1, 360000)]) {
                blockchain.now = testTime;

                const res = await assertAuctionEnded(regularItem, async (item, bid) => await item.sendCheckEndExternal(), 0n);
                if(!reported) {
                    reportGas("Owner auction ended ext", findTransactionRequired(res.transactions, {
                        on: regularItem.address,
                        outMessagesCount: 3,
                        aborted: false
                    }));
                    reported = true;
                }
                await blockchain.loadFrom(ownerBidsMade);
            }
            // Should not end
            blockchain.now = stateBefore.end_time - 1;
            await expect(assertAuctionEnded(regularItem, async (item, bid) => await item.sendCheckEndExternal(), 0n)).rejects.toThrow();
        });
        it('should be able to end owner auction by reaching max bid', async () => {
            for (let testState of [ownerStartedAuction, ownerBidsMade]) {
                await blockchain.loadFrom(testState);
                const curConfig = await regularItem.getAuctionConfig();
                expect(curConfig.max_bid).toBeGreaterThan(0n);
                for(let testBid of [curConfig.max_bid, curConfig.max_bid * 2n]) {
                    const res = await assertAuctionEnded(regularItem, async (item, bid) => item.sendBet(otherBidder.getSender(), bid), testBid);
                    const finishTx = findTransactionRequired(res.transactions, {
                            on: regularItem.address,
                            from: otherBidder.address,
                            aborted: false
                    });
                    if(testState === ownerStartedAuction) {
                        reportGas("Owner first bid -> max_bid",finishTx);
                    } else {
                        reportGas("Owner next bid -> max_bid",finishTx);
                    }
                    expect((await regularItem.getNftData()).owner).toEqualAddress(otherBidder.address);
                    await blockchain.loadFrom(testState);
                    // Other sender should not matter
                    await assertAuctionEnded(regularItem, async (item, bid) => item.sendBet(deployer.getSender(), bid), testBid);
                    expect((await regularItem.getNftData()).owner).toEqualAddress(deployer.address);
                    await blockchain.loadFrom(testState);
                }

                // Souldn't end if off by one
                await expect(assertAuctionEnded(regularItem, async (item, bid) => item.sendBet(otherBidder.getSender(), bid), curConfig.max_bid - 1n)).rejects.toThrow();
            }
        });
    });
    describe('Item', () => {
        beforeEach(async () => await blockchain.loadFrom(initialAuctionDone));
    it('item owner should be able to transfer item', async () => {

        const deployerItem = regularItem;
        const dstAddr = randomAddress(0);

        const forwardAmount = BigInt(getRandomInt(1, 10)) * toNano('1');
        const forwardPayload = beginCell().storeStringTail("Hop hey!").endCell();
        const testQueryId    = getRandomInt(42, 142);
        const res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload, forwardAmount + toNano('1'), testQueryId);

        reportGas("Item transfer", findTransactionRequired(res.transactions, {
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            outMessagesCount: 2,
            aborted: false
        }));

        expect(res.transactions).toHaveTransaction({
            on: dstAddr,
            from: deployerItem.address,
            value: forwardAmount,
            body: beginCell().storeUint(Op.ownership_assigned, 32)
                             .storeUint(testQueryId, 64)
                             .storeAddress(deployer.address)
                             .storeBit(true).storeRef(forwardPayload)
                  .endCell()
        });

        expect(res.transactions).toHaveTransaction({
            on: royaltyWallet.address,
            from: deployerItem.address,
            op: Op.excesses
        });

        const dataAfter = await deployerItem.getNftData();
        expect(dataAfter.owner).toEqualAddress(dstAddr);

        const msgPrices = getMsgPrices(blockchain.config, 0);

        const inMsg = res.transactions[1].inMessage!;

        if(inMsg.info.type !== 'internal') {
            throw "No way!";
        }

        // Make sure that 3/2 approach is applicable
        expect(inMsg.info.forwardFee * 3n / 2n).toBeGreaterThanOrEqual(computeMessageForwardFees(msgPrices, inMsg).fees.total);
    });
    it('non-owner should not be able to transfer item', async () => {

        const deployerItem = regularItem;

        const forwardAmount = BigInt(getRandomInt(1, 10)) * toNano('1');
        const forwardPayload = beginCell().storeStringTail("Hop hey!").endCell();

        // Make sure transfer mode doesn't impact auth check
        for(let testVector of [
            {response: royaltyWallet.address, amount: forwardAmount, payload: forwardPayload},
            {response: royaltyWallet.address, amount: forwardAmount, payload: null},
            {response: royaltyWallet.address, amount: 0n, payload: null},
            {response: null, amount: forwardAmount, payload: forwardPayload},
            {response: null, amount: forwardAmount, payload: null},
            {response: null, amount: 0n, payload: null},
        ]) {

            const res = await deployerItem.sendTransfer(royaltyWallet.getSender(),
                                                        royaltyWallet.address,
                                                        testVector.response,
                                                        testVector.amount,
                                                        testVector.payload,
                                                        testVector.amount + toNano('1'));
            expect(res.transactions).toHaveTransaction({
                on: deployerItem.address,
                from: royaltyWallet.address,
                op: Op.transfer,
                aborted: true,
                exitCode: Errors.forbidden_transfer
            });
        }

    });

    it('transfer should work with minimal amount, and amount depends on number of outgoing messages', async () => {

        const deployerItem = regularItem;
        const dstAddr = randomAddress(0);

        const forwardAmount = BigInt(getRandomInt(1, 10)) * toNano('1');
        const forwardPayload = beginCell().storeStringTail("Hop hey!").endCell();
        const testQueryId    = getRandomInt(42, 142);

        let smc = await blockchain.getContract(deployerItem.address);
        smc.balance = min_storage;

        let res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload, forwardAmount + toNano('1'), testQueryId);

        let dataAfter = await deployerItem.getNftData();
        expect(dataAfter.owner).toEqualAddress(dstAddr);

        const transferTx = findTransactionRequired(res.transactions, {
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: false,
            outMessagesCount: 2
        });

        const inMsg = transferTx.inMessage!;

        if(inMsg.info.type !== 'internal') {
            throw "No way!";
        }

        // ExpectedFee
        const expFee = inMsg.info.forwardFee * 3n / 2n;

        let minFee = forwardAmount + expFee * 2n;

        // Roll back and try again with value below minFee
        await blockchain.loadFrom(initialAuctionDone);

        smc = await blockchain.getContract(deployerItem.address);
        smc.balance = min_storage


        res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload, minFee - 1n, testQueryId);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: true,
            exitCode: Errors.not_enough_funds
        });

        // Now with minimalFee but balance below storage value
        smc.balance = min_storage - (BigInt(getRandomInt(1, 3)) * toNano('0.01'));
        res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload, minFee, testQueryId);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: true,
            exitCode: Errors.not_enough_funds
        });

        res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload, minFee + (min_storage - smc.balance), testQueryId);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: false,
            outMessagesCount: 2
        });

        // Make sure forwardAmount particpates in fee calculation
        await blockchain.loadFrom(initialAuctionDone);
        res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount + 1n, forwardPayload, minFee, testQueryId);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: true,
            exitCode: Errors.not_enough_funds
        });

        // Dropping outgoing messages should result in lowering minimal fee
        for(let testVector of [{refund: null, amount: forwardAmount}, {refund: dstAddr, amount: 0n}]) {
            await blockchain.loadFrom(initialAuctionDone);
            // Accepted minFee should be lowered by 1 expected forward fee
            res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, testVector.refund, testVector.amount, forwardPayload, minFee - expFee, testQueryId);

            expect(res.transactions).toHaveTransaction({
                on: deployerItem.address,
                from: deployer.address,
                op: Op.transfer,
                aborted: false,
                outMessagesCount: 1
            });

            dataAfter = await deployerItem.getNftData();
            expect(dataAfter.owner).toEqualAddress(dstAddr);
        }

        // console.log(res.transactions[1].description);
        if(balanceStrict) {
            expect(smc.balance).toBeGreaterThanOrEqual(min_storage);
        }


        // Now try minimal fee
        await blockchain.loadFrom(initialAuctionDone);
        res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload, minFee, testQueryId);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: false,
            outMessagesCount: 2
        });

        dataAfter = await deployerItem.getNftData();
        expect(dataAfter.owner).toEqualAddress(dstAddr);

        if(balanceStrict) {
            // console.log(res.transactions[1].description);
            expect(smc.balance).toBeGreaterThanOrEqual(min_storage); // Min storage should be left on contract
        }
    });

    it('owner should be able to transfer item without notification', async () => {

        const deployerItem = regularItem;
        const dstAddr = randomAddress(0);

        const forwardAmount = 0n; // Forward amount is zero, payload should be ignored
        const forwardPayload = beginCell().storeStringTail("Hop hey!").endCell();

        let res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload, forwardAmount + toNano('1'));

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: false,
            outMessagesCount: 1
        });

        expect(res.transactions).toHaveTransaction({
            on: royaltyWallet.address,
            from: deployerItem.address,
            op: Op.excesses
        });

        const dataAfter = await deployerItem.getNftData();
        expect(dataAfter.owner).toEqualAddress(dstAddr);
    });
    it('owner should be able to attach data directly into ownership_assigned body', async () => {

        const deployerItem = regularItem;
        const dstAddr = randomAddress(0);

        const forwardAmount = 1n;
        const forwardPayload = beginCell().storeStringTail("Hop hey!").endCell();

        let res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, royaltyWallet.address, forwardAmount, forwardPayload.asSlice(), forwardAmount + toNano('1'), 42n);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            outMessagesCount: 2,
            aborted: false
        });

        expect(res.transactions).toHaveTransaction({
            on: dstAddr,
            from: deployerItem.address,
            value: forwardAmount,
            body: beginCell().storeUint(Op.ownership_assigned, 32)
                             .storeUint(42n, 64)
                             .storeAddress(deployer.address)
                             .storeBit(false)
                             .storeSlice(forwardPayload.asSlice())
                  .endCell()
        });
    });

    it.skip('should validate Either forward_payload', async () => {

        const deployerItem = regularItem;
        const dstAddr = randomAddress(0);

        const forwardAmount = 1n;
        const forwardPayload = beginCell().storeStringTail("Hop hey!").endCell();

        const transferMsg = NftItem.transferMessage(dstAddr, deployer.address, forwardAmount, forwardPayload);
        // Last indicator bit cut
        const truncated   = beginCell().storeBits(transferMsg.beginParse().loadBits(transferMsg.bits.length - 1)).endCell();
        // Indicator bit set to true, but ref is absent
        const noRef       = new Cell({bits: transferMsg.bits, refs: []});

        for(let testPayload of [truncated, noRef]) {
            const res = await deployer.send({
                to: deployerItem.address,
                body: testPayload,
                value: toNano('1')
            });
            expect(res.transactions).toHaveTransaction({
                on: deployerItem.address,
                from: deployer.address,
                op: Op.transfer,
                aborted: true,
            });
        }
    });
    it('owner should be able to transfer item without excess and forward payload', async () => {
        const deployerItem = regularItem
        const dstAddr = randomAddress(0);

        const forwardAmount = 0n; // Forward amount is zero, payload should be ignored

        let res = await deployerItem.sendTransfer(deployer.getSender(), dstAddr, null, forwardAmount);

        expect(res.transactions).toHaveTransaction({
            on: deployerItem.address,
            from: deployer.address,
            op: Op.transfer,
            aborted: false,
            outMessagesCount: 0
        });

        const dataAfter = await deployerItem.getNftData();
        expect(dataAfter.owner).toEqualAddress(dstAddr);
    });
    // TG Collection doesn't return static data
    it.skip('should return static data', async () => {
        const msgPrices = getMsgPrices(blockchain.config, 0);
        const colData = await nftCollection.getCollectionData();
        const lastIdx = colData.nextItemIndex;

        expect(lastIdx).toBeGreaterThan(0);

        const testIdx = getRandomInt(0, lastIdx - 1);

        const testItem = regularItem;

        const msgValue = toNano('0.05');
        const queryId  = getRandomInt(0, 100);
        const res = await testItem.sendGetStaticData(deployer.getSender(), msgValue, queryId);

        const getDataTx = findTransactionRequired(res.transactions, {
            on: testItem.address,
            from: deployer.address,
            op: Op.get_static_data,
            aborted: false,
            outMessagesCount: 1
        });

        reportGas("Get static data", getDataTx);

        const outMsg = getDataTx.outMessages.get(0)!;
        if(outMsg.info.type !== 'internal') {
            throw Error("No way!");
        }
        const fwdFee = computeMessageForwardFees(msgPrices, outMsg);

        const computePhase = computedGeneric(getDataTx);
        expect(res.transactions).toHaveTransaction({
            on: deployer.address,
            from: testItem.address,
            value: msgValue - fwdFee.fees.total - computePhase.gasFees,
            body: beginCell()
                    .storeUint(Op.report_static_data, 32)
                    .storeUint(queryId, 64)
                    .storeUint(testIdx, 256)
                    .storeAddress(nftCollection.address)
                  .endCell()
        });
    });
    });
});

