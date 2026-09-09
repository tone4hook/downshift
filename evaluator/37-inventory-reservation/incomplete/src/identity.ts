export function reservationInput(sku:string,quantity:number){if(!sku||!Number.isSafeInteger(quantity)||quantity<=0)throw Error('INVALID_RESERVATION');return JSON.stringify([sku]);}
