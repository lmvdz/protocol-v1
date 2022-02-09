import { Program } from '@project-serum/anchor';

interface AccountToPoll<T> {
    accountKey: string,
    accountPublicKey: string,
    onPoll: (data: any) => void
    slot: number,
    raw: string
    data: T
}

const MAX_KEYS = 100;

export class PollingAccountSubscriber {
    isSubscribed: boolean;
	program: Program;
	pollingFrequency: number;
	intervalId?: NodeJS.Timer;

	public constructor(program: Program, pollingFrequency = 1000) {
		this.program = program;
		this.pollingFrequency = pollingFrequency;
	}

    private pollingAccountMap : Map<string, Map<string, AccountToPoll<any>>> = new Map<string, Map<string, AccountToPoll<any>>>();

    getAllKeys() : Array<string> {
        return [...this.pollingAccountMap.keys()];
    }

    hasAccount(publicKey: string) : boolean {
        return this.pollingAccountMap.has(publicKey);
    }

    addAccountToPoll(publicKey: string, accountKey: string, accountPublicKey: string, onPoll: (data : any) => void) : void {
        let accountsToPoll = this.pollingAccountMap.get(publicKey);
        if (accountsToPoll === undefined) {
            accountsToPoll = new Map<string, AccountToPoll<any>>();
        }
        if (!accountsToPoll.has(accountKey)) {
            accountsToPoll.set(accountKey, { accountKey, onPoll, accountPublicKey, raw: null, data: null } as AccountToPoll<any>);
        }
        this.pollingAccountMap.set(publicKey, accountsToPoll);
    }

    removeAccountToPoll(publicKey: string, accountKey: string) : boolean {
        return this.pollingAccountMap.get(publicKey).delete(accountKey);
    }

    removeAccountsToPoll(publicKey: string) : boolean {
        return this.pollingAccountMap.delete(publicKey);
    }

	capitalize(value: string): string {
		return value[0].toUpperCase() + value.slice(1);
	}


    public async fetch(): Promise<void> {
		await this.pollAccounts();
	}

    subscribe() : void {
        if (!this.isSubscribed) {
            if (this.intervalId) {
                clearInterval(this.intervalId);
            }
            this.intervalId = setInterval(this.pollAccounts.bind(this), this.pollingFrequency);
            this.isSubscribed = true;
        }
    }

    unsubscribe() : void {
        if (this.isSubscribed) {
            if (this.intervalId) {
                clearInterval(this.intervalId);
            }
            this.isSubscribed = false;
            this.clean();
        }
    }

    clean() : void {
        this.pollingAccountMap = new Map<string, Map<string, AccountToPoll<any>>>();
    }

    flatDeep(arr : Array<any>, d = 1) : Array<any> {
        return d > 0 ? arr.reduce((acc, val) => acc.concat(Array.isArray(val) ? this.flatDeep(val, d - 1) : val), []) : arr.slice();
    }

    chunkArray(array : Array<any>, chunk_size : number) : Array<any> {
        return new Array(Math.ceil(array.length / chunk_size)).fill(null).map((_, index) => index * chunk_size).map(begin => array.slice(begin, begin + chunk_size));
    } 

	async pollAccounts(): Promise<void> {
        const flattenedAccounts = {};
        if (this.pollingAccountMap.size > 0) {

            [...this.pollingAccountMap].forEach(([publicKey, accountMap], i) => {
                if (publicKey && accountMap) {
                    flattenedAccounts[i] = {
                        publicKey,
                        accounts: [...accountMap.values()],
                        accountPublicKeys: [...accountMap.values()].map(acc => acc.accountPublicKey)
                    };
                }
            });

            if (Object.keys(flattenedAccounts).length > 0) {
                let allkeys = this.flatDeep(Object.keys(flattenedAccounts).map(key => flattenedAccounts[key]['accountPublicKeys']), Infinity);
                if (allkeys.length > MAX_KEYS) {
                    allkeys = this.chunkArray(allkeys, MAX_KEYS);
                    const rpcResponses = await Promise.all(allkeys.map(async chunk => {
                        const accounts = [
                            chunk,
                            { commitment: 'recent' },
                        ];
                        // @ts-ignore
                        return (await this.program.provider.connection._rpcRequest(
                            'getMultipleAccounts',
                            accounts
                        ));
                    }));
                    let index = 0;
                    for (let x = 0; x < Object.keys(flattenedAccounts).length; x++) {
                        const key =  Object.keys(flattenedAccounts)[x];
                        const accounts = flattenedAccounts[key]['accounts'];
                        const rpcResponseIndex = Math.floor(index / MAX_KEYS);
                        const rpcResponse = rpcResponses[rpcResponseIndex];
                        const slot = rpcResponse.result.context.slot;

                        for (let x = 0; x < accounts.length; x++) {
                            
                            let accIndex = index;
                            while (accIndex >= 100) {
                                accIndex -= 100;
                            }
                            const raw: string = rpcResponse.result.value[ accIndex + x ].data[0];
                            const dataType = rpcResponse.result.value[ accIndex + x ].data[1];
                            const buffer = Buffer.from(raw, dataType);
                            
                            const account = this.program.account[
                                flattenedAccounts[key]['accounts'][x].accountKey
                            ].coder.accounts.decode(
                                this.capitalize(flattenedAccounts[key]['accounts'][x].accountKey),
                                buffer
                            );
                                
                            if (this.pollingAccountMap.has(flattenedAccounts[key].publicKey)) {
                                const oldValue = this.pollingAccountMap.get( flattenedAccounts[key].publicKey ).get( flattenedAccounts[key]['accounts'][x].accountKey);
            
                                const newValue = { ...oldValue, slot, data: account, raw };
                                // console.log('polling?', oldValue === undefined, oldValue.slot, newValue.slot, oldValue.data !== newValue.data);
                                if (oldValue === undefined || ((oldValue.slot === undefined || oldValue.slot < newValue.slot) && oldValue.data !== newValue.data)) {
                                    // console.log('polled');
                                    this.pollingAccountMap.get( flattenedAccounts[key].publicKey ).set(flattenedAccounts[key]['accounts'][x].accountKey, newValue);
                                    newValue.onPoll(account);
                                }
                            } else {
                                accounts[x].onPoll(account);
                            }
                        }
                        index += flattenedAccounts[key]['accounts'].length;
                    }
                } else {
                    const accounts = [
                        allkeys,
                        { commitment: 'recent' },
                    ];
                
                    // @ts-ignore
                    const rpcResponse = await this.program.provider.connection._rpcRequest(
                        'getMultipleAccounts',
                        accounts
                    );
                    const slot = rpcResponse.result.context.slot;

                    let index = 0;
                    for(let x = 0; x < Object.keys(flattenedAccounts).length; x++) {
                        const key = Object.keys(flattenedAccounts)[x];
                        const accounts = flattenedAccounts[key]['accounts'];
    
                        for (let x = 0; x < accounts.length; x++) {
                            const raw: string = rpcResponse.result.value[ index + x ].data[0];
                            const dataType = rpcResponse.result.value[ index + x ].data[1];
                            const buffer = Buffer.from(raw, dataType);
            
                            const account = this.program.account[
                                flattenedAccounts[key]['accounts'][x].accountKey
                            ].coder.accounts.decode(
                                this.capitalize(flattenedAccounts[key]['accounts'][x].accountKey),
                                buffer
                            );
                            if (this.pollingAccountMap.has(flattenedAccounts[key].publicKey)) {
                                const oldValue = this.pollingAccountMap.get( flattenedAccounts[key].publicKey ).get( accounts[x].accountKey );
            
                                const newValue = { ...oldValue, slot, data: account, raw };
                                // console.log('polling?', oldValue === undefined, oldValue.slot, newValue.slot, oldValue.data !== newValue.data);
                                if (oldValue === undefined || ((oldValue.slot === undefined || oldValue.slot < newValue.slot) && oldValue.data !== newValue.data)) {
                                    // console.log('polled');
                                    this.pollingAccountMap.get( flattenedAccounts[key].publicKey ).set( accounts[x].accountKey, newValue );
                                    newValue.onPoll(account);
                                }
                            } else {
                                accounts[x].onPoll(account);
                            }
                        }
                        index += flattenedAccounts[key]['accounts'].length;
                    }
                }
            }
        }
	}
}
