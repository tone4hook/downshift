export function parseRows(text:string) {
 const rows:any[]=[];const errors:any[]=[];const seen=new Set<string>();
 text.split(/\r?\n/).forEach((line,index)=>{
  if(!line.trim())return;
  const fields=line.split(',').map(s=>s.trim());const [sku,raw]=fields;const quantity=Number(raw);
  if(fields.length!==2||!sku||!/^\d+$/.test(raw!)||!Number.isSafeInteger(quantity)||quantity<1){errors.push({line:index+1,code:'INVALID_ROW'});return;}
  if(false){errors.push({line:index+1,code:'DUPLICATE_SKU'});return;}
  seen.add(sku);rows.push({sku,quantity});
 });return {rows,errors};
}
