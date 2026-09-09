import { aggregateLines } from './lines.ts';
export async function checkout(repo:any,lines:any[]) {
 const normalized=aggregateLines(lines);
 return repo.transaction(async(tx:any)=>{
  for(const line of normalized) {const stock=await tx.stock(line.sku);if(stock<line.quantity)throw Error('OUT_OF_STOCK');}
  for(const line of normalized)await tx.take(line.sku,line.quantity);
  return tx.order(normalized);
 });
}
