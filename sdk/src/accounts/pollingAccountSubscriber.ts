import { Program } from '@project-serum/anchor';
import axios from 'axios';

interface AccountToPoll<T> {
    accountKey: string
    accountPublicKey: string
    onPoll: (data: any) => void
    onError: (error: any) => void
    slot: number
    raw: string
    dataType: BufferEncoding
    data: T
}

const MAX_KEYS = 100;

export class PollingAccountSubscriber {
    isSubscribed: boolean;
	program: Program;
	pollingFrequency: number;
	intervalId?: NodeJS.Timer;
    index: number
    name: string

	public constructor(name: string, program: Program, index: number, pollingFrequency = 1000) {
        this.name = name;
		this.program = program;
        this.index = index;
		this.pollingFrequency = pollingFrequency;
	}

    private pollingAccountMap : Map<string, Map<string, AccountToPoll<any>>> = new Map<string, Map<string, AccountToPoll<any>>>();

    getAllKeys() : Array<string> {
        return [...this.pollingAccountMap.keys()];
    }

    hasAccount(publicKey: string) : boolean {
        return this.pollingAccountMap.has(publicKey);
    }

    addAccountToPoll(publicKey: string, accountKey: string, accountPublicKey: string, onPoll: (data : any) => void, onError: (error: any) => void) : void {
        let accountsToPoll = this.pollingAccountMap.get(publicKey);
        if (accountsToPoll === undefined) {
            accountsToPoll = new Map<string, AccountToPoll<any>>();
        }
        if (!accountsToPoll.has(accountKey)) {
            accountsToPoll.set(accountKey, { accountKey, onPoll, onError, accountPublicKey, raw: null, data: null } as AccountToPoll<any>);
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
            this.intervalId = setInterval(() => this.pollAccounts(), this.pollingFrequency);
            console.log(this.name + ' subscribed');
            this.isSubscribed = true;
        }
    }

    unsubscribe() : void {
        if (this.isSubscribed) {
            if (this.intervalId) {
                clearInterval(this.intervalId);
            }
            this.isSubscribed = false;
            console.log(this.name + ' unsubscribed');
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

    constructAccount(accountKey: string, raw: string, dataType: BufferEncoding) : any {
        return this.program.account[
            accountKey
        ].coder.accounts.decode(
            this.capitalize(accountKey),
            Buffer.from(raw, dataType)
        );
    }

	async pollAccounts(): Promise<void> {
        const flattenedAccounts = {};
        if (this.pollingAccountMap.size > 0) {

            await Promise.all([...this.pollingAccountMap].map(async ([publicKey, accountMap], i) => {
                if (publicKey && accountMap) {
                    flattenedAccounts[i] = {
                        publicKey,
                        accounts: [...accountMap.values()],
                        accountPublicKeys: [...accountMap.values()].map(acc => acc.accountPublicKey)
                    };
                }
            }));


            if (Object.keys(flattenedAccounts).length > 0) {
                const allkeys = this.flatDeep(Object.keys(flattenedAccounts).map(key => flattenedAccounts[key]['accountPublicKeys']), Infinity);
                if (allkeys.length > MAX_KEYS) {
                    const chunkedKeys = this.chunkArray(allkeys, MAX_KEYS);

                    const payloads = this.chunkArray(chunkedKeys, 10);

                    const requests = this.chunkArray(payloads, 5);

                    const rpcResponses = this.flatDeep(
                        await Promise.all(
                            requests.map((request, index) => 
                                new Promise((resolve) => {
                                    setTimeout(() => {
                                        Promise.all(request.map((requestChunk) => 
                                            new Promise((resolve) => {
                                                //@ts-ignore 
                                                axios.post(this.program.provider.connection._rpcEndpoint, requestChunk.map(payload => 
                                                    ({
                                                        jsonrpc: "2.0",
                                                        id: "1",
                                                        method: "getMultipleAccounts",
                                                        params: [
                                                            payload,
                                                            { commitment: "processed", },
                                                        ]
                                                    })
                                                )).then(response => {
                                                    resolve(response.data);
                                                });
                                            }) 
                                        )).then(responses => {
                                            resolve(this.flatDeep(
                                                responses, 
                                                Infinity
                                            ));
                                        });
                                    }, index * 1000);
                                })
                            )
                        ),
                        Infinity
                    );

                    let index = 0;
                    
                    for (let x = 0; x < Object.keys(flattenedAccounts).length; x++) {
                        const key =  Object.keys(flattenedAccounts)[x];
                        const accounts = flattenedAccounts[key]['accounts'];

                        for (let x = 0; x < accounts.length; x++) {

                            const rpcResponseIndex = Math.floor((index + x) / MAX_KEYS);
                            const rpcResponse = rpcResponses[rpcResponseIndex];
                            const slot = (rpcResponse as any).result.context.slot;
                            
                            let accIndex = index + x;
                            while (accIndex >= MAX_KEYS) {
                                accIndex -= MAX_KEYS;
                            }
                            try {
                                const raw: string = (rpcResponse as any).result.value[ accIndex ].data[0];
                                const dataType = (rpcResponse as any).result.value[ accIndex ].data[1] as BufferEncoding;
                                const account = this.constructAccount(flattenedAccounts[key]['accounts'][x].accountKey, raw, dataType);
                                    
                                if (this.pollingAccountMap.has(flattenedAccounts[key].publicKey)) {
                                    const oldValue = this.pollingAccountMap.get( flattenedAccounts[key].publicKey ).get( flattenedAccounts[key]['accounts'][x].accountKey );
                                    const newValue = { ...oldValue, slot, data: account, raw, dataType };
                                    // console.log('polling?', oldValue === undefined, oldValue.slot, newValue.slot, oldValue.data !== newValue.data);
                                    if ( oldValue.data === null || ((oldValue.slot === undefined || oldValue.slot < newValue.slot) && oldValue.raw !== newValue.raw )) {
                                        // console.log('polled');
                                        this.pollingAccountMap.get( flattenedAccounts[key].publicKey ).set(flattenedAccounts[key]['accounts'][x].accountKey, newValue);
                                        newValue.onPoll(account);
                                    }
                                } else {
                                    accounts[x].onPoll(account);
                                }
                            } catch (error) {
                                accounts[x].onError(error);
                            }

                        }
                        index += flattenedAccounts[key]['accounts'].length;
                    }
                } else {
                    //@ts-ignore
                    const rpcResponse = (await axios.post(this.program.provider.connection._rpcEndpoint, [{
                        jsonrpc: "2.0",
                        id: "1",
                        method: "getMultipleAccounts",
                        params: [
                            allkeys,
                          {
                            commitment: "processed",
                          },
                        ],
                    }])).data[0];
                    
                    const slot = rpcResponse.result.context.slot;

                    let index = 0;
                    for(let x = 0; x < Object.keys(flattenedAccounts).length; x++) {
                        const key = Object.keys(flattenedAccounts)[x];
                        const accounts = flattenedAccounts[key]['accounts'];
    
                        for (let x = 0; x < accounts.length; x++) {
                            try {
                                const raw: string = rpcResponse.result.value[ index + x ].data[0];
                                const dataType = rpcResponse.result.value[ index + x ].data[1] as BufferEncoding;
                                const account = this.constructAccount(flattenedAccounts[key]['accounts'][x].accountKey, raw, dataType);
                                
                                if (this.pollingAccountMap.has(flattenedAccounts[key].publicKey)) {
                                    const oldValue = this.pollingAccountMap.get( flattenedAccounts[key].publicKey ).get( accounts[x].accountKey );
                
                                    const newValue = { ...oldValue, slot, data: account, raw, dataType };
                                    // console.log('polling?', oldValue === undefined, oldValue.slot, newValue.slot, oldValue.data !== newValue.data);
                                    if (oldValue.data === null || ((oldValue.slot === undefined || oldValue.slot < newValue.slot) && oldValue.raw !== newValue.raw)) {
                                        // console.log('polled');
                                        this.pollingAccountMap.get( flattenedAccounts[key].publicKey ).set( accounts[x].accountKey, newValue );
                                        newValue.onPoll(account);
                                    }
                                } else {
                                    accounts[x].onPoll(account);
                                }
                            } catch(error) {
                                accounts[x].onError(error);
                            }
                        }
                        index += flattenedAccounts[key]['accounts'].length;
                    }
                }
            }
        }
	}
}
