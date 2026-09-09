import { decodeAccount } from './decode.ts';
export function createAccountClient(transport: any) {
 return { async get(id: string) { return decodeAccount(await transport('/accounts/' + encodeURIComponent(id))); } };
}
