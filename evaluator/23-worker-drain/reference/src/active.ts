export function createActiveSet() {
 const pending=new Set<Promise<any>>();
 return {track(p:Promise<any>) { pending.add(p);void p.then(()=>pending.delete(p),()=>pending.delete(p));return p; }, count:()=>pending.size, async drain() { await Promise.allSettled([...pending]); }};
}
