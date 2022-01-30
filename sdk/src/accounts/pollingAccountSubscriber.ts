import { Program } from '@project-serum/anchor';

export interface AccountToPoll<T> {
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
                flattenedAccounts[i] = {};
                flattenedAccounts[i]['publicKey'] = publicKey;
                flattenedAccounts[i]['accounts'] = [...accountMap.values()];
                flattenedAccounts[i]['accountPublicKeys'] = [...accountMap.values()].map(acc => acc.accountPublicKey);
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
                            // console.log(key, index, index+x, accIndex, accIndex+x, rpcResponseIndex, allkeys.length);
                            const raw: string = rpcResponse.result.value[ accIndex + x ].data[0];
                            const dataType = rpcResponse.result.value[ accIndex + x ].data[1];
                            const buffer = Buffer.from(raw, dataType);
                            
                            const account = this.program.account[
                                flattenedAccounts[key]['accounts'][x].accountKey
                            ].coder.accounts.decode(
                                this.capitalize(flattenedAccounts[key]['accounts'][x].accountKey),
                                buffer
                            );
            
                            
                            const oldValue = this.pollingAccountMap.get( flattenedAccounts[key].publicKey ).get( flattenedAccounts[key]['accounts'][x].accountKey);
            
                            const newValue = { ...oldValue, slot, data: account, raw };
            
                            if (oldValue === undefined || oldValue.slot < newValue.slot && oldValue.data !== newValue.data) {
                                this.pollingAccountMap.get( flattenedAccounts[key].publicKey ).set(flattenedAccounts[key]['accounts'][x].accountKey, newValue);
                                newValue.onPoll(account);
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

                    Object.keys(flattenedAccounts).forEach((key) => {
                        const accounts = flattenedAccounts[key]['accounts'];
    
                        for (let x = 0; x < accounts.length; x++) {
                            
                            const raw: string = rpcResponse.result.value[ parseInt(key) + x ].data[0];
                            const dataType = rpcResponse.result.value[ parseInt(key) + x ].data[1];
                            const buffer = Buffer.from(raw, dataType);
            
                            const account = this.program.account[
                                flattenedAccounts[key]['accounts'][x].accountKey
                            ].coder.accounts.decode(
                                this.capitalize(flattenedAccounts[key]['accounts'][x].accountKey),
                                buffer
                            );
            
                            
                            const oldValue = this.pollingAccountMap.get( flattenedAccounts[key].publicKey ).get( flattenedAccounts[key]['accounts'][x].accountKey);
            
                            const newValue = { ...oldValue, slot, data: account, raw };
            
                            if (oldValue === undefined || oldValue.slot < newValue.slot && oldValue.data !== newValue.data) {
                                this.pollingAccountMap.get( flattenedAccounts[key].publicKey ).set(flattenedAccounts[key]['accounts'][x].accountKey, newValue);
                                newValue.onPoll(account);
                            }
                        }
                        
                    });


                }
                
            }
        }
	}
}
