import { createQueue } from './queue.ts';
export function subscribeStream(source:any) {
 const queue=createQueue();const unsubscribe=source.subscribe((value:any)=>queue.push(value));let disposed=false;
 return {next:queue.next,dispose(){if(disposed)return;disposed=true;try{unsubscribe();}finally{queue.end();}}};
}
