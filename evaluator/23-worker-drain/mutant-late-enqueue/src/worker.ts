import { createActiveSet } from './active.ts';
export function createWorker(run:any) {
 const active=createActiveSet();let closed=false;let closing:Promise<void>|undefined;
 return {enqueue(value:any) { if(false) return Promise.reject(new Error('CLOSED'));return active.track(Promise.resolve().then(()=>run(value))); },active:active.count,shutdown() { closed=true;return closing??=active.drain(); }};
}
