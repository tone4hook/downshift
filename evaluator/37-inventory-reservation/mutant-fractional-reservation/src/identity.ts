export function reservationInput(sku:string,quantity:number){if(!sku||!Number.isFinite(quantity)||quantity<=0)throw Error('INVALID_RESERVATION');return JSON.stringify([sku,quantity]);}
