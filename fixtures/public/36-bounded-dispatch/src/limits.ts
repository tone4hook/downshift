export function validateConcurrency(value:number){if(!Number.isFinite(value)||value<1)throw Error('INVALID_CONCURRENCY');return value;}
