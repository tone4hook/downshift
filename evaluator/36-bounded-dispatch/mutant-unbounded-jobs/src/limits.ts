export function validateConcurrency(value:number){if(!Number.isInteger(value)||value<1)throw Error('INVALID_CONCURRENCY');return value;}
