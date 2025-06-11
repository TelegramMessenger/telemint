import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'func',
    targets: ['func/stdlib.fc', 'func/common.fc', 'func/nft-item-no-dns-cheap.fc']
}
