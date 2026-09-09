export function createQueue() {
 const values:any[]=[];const waiters:Array<(v:any)=>void>=[];let ended=false;
 return {push(value:any){if(ended)return;const waiter=waiters.shift();if(waiter)waiter({value,done:false});else values.push(value);},next():Promise<any>{if(ended)return Promise.resolve({done:true});if(values.length)return Promise.resolve({value:values.shift(),done:false});return new Promise(r=>waiters.push(r));},end(){ended=true;values.length=0;waiters.length=0;}};
}
