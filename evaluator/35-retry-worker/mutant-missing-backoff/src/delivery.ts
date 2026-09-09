import { retryDelay } from './policy.ts';
export async function deliver(send:any,sleep:any,record:any,maxAttempts:number,baseDelay:number){retryDelay(null,1,maxAttempts,baseDelay);for(let attempt=1;;attempt++){record(attempt);try{return await send();}catch(error){const delay=retryDelay(error,attempt,maxAttempts,baseDelay);if(delay===null)throw error;await sleep(baseDelay);}}}
