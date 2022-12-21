# Telemint
This is the smart contract that Telegram intends to use in order to put some of its best usernames up for auction. The blockchain network for this smart contract is The Open Network (https://ton.org).

Anyone who finds serious security vulnerabilities in this smart contract prior to the auction launch will be rewarded.

## Description
There are two smart contracts in the repository: NftCollection and NftItem.

NftCollection source files: [nft-collection.fc](func/nft-collection.fc), [common.fc](func/common.fc) [stdlib.fc](func/stdlib.fc).

NftItem source files: [nft-item.fc](func/nft-item.fc), [common.fc](func/common.fc) [stdlib.fc](func/stdlib.fc).

One may also look at the [tlb decription](telemint.tlb) of internal messages and smart contract data.

There are also two additional smart contracts in the repository: NftCollectionNoDns and NftItemNoDns. They do not support DNS and allow to set additional restrictions on first bid.

NftCollectionNoDns source files: [nft-collection-no-dns.fc](func/nft-collection-no-dns.fc), [common.fc](func/common.fc) [stdlib.fc](func/stdlib.fc).

NftItemNoDns source files: [nft-item-no-dns.fc](func/nft-item-no-dns.fc), [common.fc](func/common.fc) [stdlib.fc](func/stdlib.fc).

### NftCollection

#### Internal messages
The first bidder receives a signed query from the server and sends it to NftCollection with the first bid attached.
```
// Create an NftItem and start an auction. Signed by auction's private key. Acts as a first bid in the auction.
telemint_unsigned_deploy$_ subwallet_id:uint32 valid_since:uint32 valid_till:uint32 token_name:TelemintText
  content:^Cell auction_config:^TeleitemAuctionConfig royalty_params:(Maybe ^NftRoyaltyParams) = TelemintUnsignedDeploy;
telemint_msg_deploy#4637289a  sig:bits512 msg:TelemintUnsignedDeploy = TelemintMsg;
```

The NftCollection interface is also supported.

#### External messages
The smart contract will accept the first external message to simplify the initialization of the smart contract.

### NftItem

#### Internal messages
The first bid is made through NftCollection, which will generate the following message.
```
// Create NftItem and start an auction. Accepted only from NftCollection.
teleitem_msg_deploy#299a3e15 sender_address:MsgAddressInt bid:Grams token_info:^TelemintTokenInfo nft_content:^Cell
  auction_config:^TeleitemAuctionConfig royalty_params:^NftRoyaltyParams = TeleitemMsg;
```

All following bids are simple transfers.

The owner of an NftItem may start a new auction.

```
// Start new auction. Accepted only from the owner.
teleitem_msg_start_auction#487a8e81 query_id:int64 auction_config:^TeleitemAuctionConfig = TeleitemMsg;

// Cancel auction auction. Accepted only from the owner. Forbidden if there are some active bids
teleitem_msg_cancel_auction#371638ae query_id:int64 = TeleitemMsg;
```

The NftItem interface is also supported, including transfer messages.

#### External messages
To finish a completed auction, one may send an empty message.
