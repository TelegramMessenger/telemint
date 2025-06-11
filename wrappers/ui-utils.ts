import { sleep, NetworkProvider, UIProvider} from '@ton/blueprint';
import { Address, beginCell, Builder, Cell, Dictionary, DictionaryValue, Slice } from "@ton/core";
import { sha256 } from 'ton-crypto';

export const defaultJettonKeys = ["uri", "name", "description", "image", "image_data", "symbol", "decimals", "amount_style"];
export const defaultNftKeys    = ["uri", "name", "description", "image", "image_data"];

export const promptBool = async (prompt:string, options:[string, string], ui:UIProvider, choice: boolean = false) => {
    let yes  = false;
    let no   = false;
    let opts = options.map(o => o.toLowerCase());

    do {
        let res = (choice ? await ui.choose(prompt, options, (c: string) => c) : await ui.input(`${prompt}(${options[0]}/${options[1]})`)).toLowerCase();
        yes = res == opts[0]
        if(!yes)
            no  = res == opts[1];
    } while(!(yes || no));

    return yes;
}

export const promptAddress = async (prompt:string, provider:UIProvider, fallback?:Address) => {
    let promptFinal = fallback ? prompt.replace(/:$/,'') + `(default:${fallback}):` : prompt ;
    do {
        let testAddr = (await provider.input(promptFinal)).replace(/^\s+|\s+$/g,'');
        try{
            return testAddr == "" && fallback ? fallback : Address.parse(testAddr);
        }
        catch(e) {
            provider.write(testAddr + " is not valid!\n");
            prompt = "Please try again:";
        }
    } while(true);

};

export const promptAmount = async (prompt:string, provider:UIProvider) => {
    let resAmount:number;
    do {
        let inputAmount = await provider.input(prompt);
        resAmount = Number(inputAmount);
        if(isNaN(resAmount)) {
            provider.write("Failed to convert " + inputAmount + " to float number");
        }
        else {
            return resAmount.toFixed(9);
        }
    } while(true);
}

export const getLastBlock = async (provider: NetworkProvider) => {
    return (await provider.api().getLastBlock()).last.seqno;
}
export const getAccountLastTx = async (provider: NetworkProvider, address: Address) => {
    const res = await provider.api().getAccountLite(await getLastBlock(provider), address);
    if(res.account.last == null)
        throw(Error("Contract is not active"));
    return res.account.last.lt;
}
export const waitForTransaction = async (provider:NetworkProvider, address:Address, curTx:string | null, maxRetry:number, interval:number=1000) => {
    let done  = false;
    let count = 0;
    const ui  = provider.ui();

    do {
        const lastBlock = await getLastBlock(provider);
        ui.write(`Awaiting transaction completion (${++count}/${maxRetry})`);
        await sleep(interval);
        const curState = await provider.api().getAccountLite(lastBlock, address);
        if(curState.account.last !== null){
            done = curState.account.last.lt !== curTx;
        }
    } while(!done && count < maxRetry);
    return done;
}

const keysToHashMap = async (keys: string[]) => {
    let keyMap: {[key: string]: bigint} = {};
    for (let i = 0; i < keys.length; i++) {
        keyMap[keys[i]] = BigInt("0x" + (await sha256(keys[i])).toString('hex'));
    }
}

const contentValue: DictionaryValue<string> = {
    serialize: (src: string, builder:Builder) => {
        builder.storeRef(beginCell().storeUint(0, 8).storeStringTail(src).endCell());
    },
    parse: (src: Slice) => {
        const sc = src.loadRef().beginParse();
        const prefix = sc.loadUint(8);
        if(prefix == 0) {
            return sc.loadStringTail();
        }
        else if(prefix == 1) {
            // Not really tested, but feels like it should work
            const chunkDict = Dictionary.loadDirect(Dictionary.Keys.Uint(32), Dictionary.Values.Cell(), sc);
            return chunkDict.values().map(x => x.beginParse().loadStringTail()).join('');
        }
        else {
            throw(Error(`Prefix ${prefix} is not supported yet`));
        }
    }
};
export const displayContentCell = async (content:Cell, ui:UIProvider, jetton:boolean = true, additional?: string[]) => {
    const cs = content.beginParse();
    const contentType = cs.loadUint(8);
    if(contentType == 1) {
        const noData = cs.remainingBits == 0;
        if(noData && cs.remainingRefs == 0) {
            ui.write("No data in content cell!\n");
        }
        else {
            const contentUrl = noData ? cs.loadStringRefTail() : cs.loadStringTail();
            ui.write(`Content metadata url:${contentUrl}\n`);
        }
    }
    else if(contentType == 0) {
        let   contentKeys: string[];
        const hasAdditional = additional !== undefined && additional.length > 0;
        const contentDict   = Dictionary.load(Dictionary.Keys.BigUint(256), contentValue, cs);
        const contentMap : {[key: string]: string} = {};

        if(jetton) {
            contentKeys = hasAdditional ? [...defaultJettonKeys, ...additional] : defaultJettonKeys;
        }
        else {
            contentKeys = hasAdditional ? [...defaultNftKeys, ...additional] : defaultNftKeys;
        }
        for (const name of contentKeys) {
            // I know we should pre-compute hashed keys for known values... just not today.
            const dictKey   = BigInt("0x" + (await sha256(name)).toString('hex'))
            const dictValue = contentDict.get(dictKey);
            if(dictValue !== undefined) {
                contentMap[name] = dictValue;
            }
        }
        ui.write(`Content:${JSON.stringify(contentMap,null, 2)}`);
    }
    else {
        ui.write(`Unknown content format indicator:${contentType}\n`);
    }
}

export const promptUrl = async(prompt:string, ui:UIProvider) => {
    let retry  = false;
    let input  = "";
    let res    = "";

    do {
        input = await ui.input(prompt);
        try{
            let testUrl = new URL(input);
            res   = testUrl.toString();
            retry = false;
        }
        catch(e) {
            ui.write(input + " doesn't look like a valid url:\n" + e);
            retry = !(await promptBool('Use anyway?(y/n)', ['y', 'n'], ui));
        }
    } while(retry);
    return input;
}
