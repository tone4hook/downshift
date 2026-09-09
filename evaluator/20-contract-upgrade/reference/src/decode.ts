export function decodeAccount(payload: any) {
 const raw = payload.account ?? payload;
 if (typeof raw.id !== 'string' || !raw.id) throw new Error('INVALID_ACCOUNT');
 const name = raw.displayName ?? raw.name ?? '';
 if (typeof name !== 'string') throw new Error('INVALID_ACCOUNT');
 return { id: raw.id, displayName: name.trim() };
}
