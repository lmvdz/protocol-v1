import { Program } from '@project-serum/anchor';

export interface AccountToPoll<T> {
    key: string,
    publicKey: string,
    onPoll: (data: any) => void
    raw: string
    data: T
}

export class PollingAccountSubscriber {
    isSubscribed: boolean;
	program: Program;
	lastSlot: number;
	pollingFrequency: number;
	intervalId?: NodeJS.Timer;

	public constructor(program: Program, pollingFrequency = 1000) {
		this.program = program;
		this.lastSlot = 0;
		this.pollingFrequency = pollingFrequency;
	}

    private pollingAccountMap : Map<string, AccountToPoll<any>> = new Map<string, AccountToPoll<any>>();

    addAccountToPoll(key: string, publicKey: string, onPoll: (data : any) => void) : void {
        this.pollingAccountMap.set(publicKey, { key, onPoll, publicKey, raw: null, data: null });
    }

    removeAccountToPoll(publicKey: string) : boolean {
        return this.pollingAccountMap.delete(publicKey);
    }

	capitalize(value: string): string {
		return value[0].toUpperCase() + value.slice(1).toLowerCase();
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
        }
        
    }

    clean() : void {
        this.pollingAccountMap = new Map<string, AccountToPoll<any>>();
    }

	async pollAccounts(): Promise<void> {
		const accounts = [
			[...this.pollingAccountMap.keys()].map((publicKey) =>
                publicKey
			),
			{ commitment: 'recent' },
		];

		// @ts-ignore
		const rpcResponse = await this.program.provider.connection._rpcRequest(
			'getMultipleAccounts',
			accounts
		);

		const newSlot = rpcResponse.result.context.slot;
		if (newSlot <= this.lastSlot) {
			return;
		}

		this.lastSlot = newSlot;

		[...this.pollingAccountMap].forEach(([key, accountToPoll], i) => {
			const raw: string = rpcResponse.result.value[i].data[0];
			const dataType = rpcResponse.result.value[i].data[1];
			const buffer = Buffer.from(raw, dataType);

			const account = this.program.account[
				accountToPoll.key
			].coder.accounts.decode(
				this.capitalize(accountToPoll.key),
				buffer
			);

			
			const oldValue = this.pollingAccountMap.get(key);

            const newValue = { ...oldValue, data: account, raw };

			if (oldValue === undefined || oldValue.raw !== newValue.raw) {
				this.pollingAccountMap.set(key, newValue);
                newValue.onPoll(account);
			}
		});
	}
}
