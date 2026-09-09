export function aggregateLines(lines:any[]) {
 const totals=new Map<string,number>();
 for(const line of lines) {
  if(typeof line.sku!=='string'||!line.sku||!Number.isSafeInteger(line.quantity)||line.quantity<=0)throw Error('INVALID_QUANTITY');
  const quantity=(totals.get(line.sku)??0)+line.quantity;

  totals.set(line.sku,quantity);
 }
 return [...totals].map(([sku,quantity])=>({sku,quantity}));
}
