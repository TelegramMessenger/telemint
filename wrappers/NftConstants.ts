export abstract class Op {
    static fill_up = 0x370fec51;
    static outbid_notification = 0x557cea20;
    static change_dns_record = 0x4eb1f0f9;
    static dns_balance_release = 0x4ed14b65;

    static telemint_msg_deploy = 0x4637289a;
    static telemint_msg_deploy_v2 = 0x4637289b;

    static teleitem_msg_deploy = 0x299a3e15;
    static teleitem_start_auction = 0x487a8e81;
    static teleitem_cancel_auction = 0x371638ae;
    static teleitem_bid_info = 0x38127de1;
    static teleitem_return_bid = 0xa43227e1;
    static teleitem_ok = 0xa37a0983;

    static nft_cmd_transfer = 0x5fcc3d14;
    static nft_cmd_get_static_data = 0x2fcb26a2;
    static nft_cmd_edit_content = 0x1a0b9d51;
    static nft_answer_ownership_assigned = 0x05138d91;
    static nft_answer_excesses = 0xd53276db;


    static transfer  = 0x5fcc3d14;
    static ownership_assigned = 0x05138d91;
    static excesses = 0xd53276db;
    static get_static_data = 0x2fcb26a2;
    static report_static_data = 0x8b771735;
    static get_royalty_params = 0x693d3950;
    static report_royalty_params = 0xa8cb00ad;

    static deploy_item = 1;
    static batch_deploy_item = 2;
    static change_owner = 3;
}

export abstract class Errors {
    static invalid_length = 201;
    static invalid_signature = 202;
    static wrong_subwallet_id = 203;
    static not_yet_valid_signature = 204;
    static expired_signature = 205;
    static not_enough_funds = 206;
    static wrong_topup_comment = 207;
    static unknown_op = 208;
    static uninited = 210;
    static too_small_stake = 211;
    static expected_onchain_content = 212;
    static forbidden_not_deploy = 213;
    static forbidden_not_stake = 214;
    static forbidden_topup = 215;
    static forbidden_transfer = 216;
    static forbidden_change_dns = 217;
    static forbidden_touch = 218;
    static no_auction = 219;
    static forbidden_auction = 220;
    static already_has_stakes = 221;
    static auction_already_started = 222;
    static invalid_auction_config = 223;
    static invalid_sender_address = 224;
    static incorrect_workchain = 333;
    static no_first_zero_byte = 413;
    static bad_subdomain_length = 70;
}
