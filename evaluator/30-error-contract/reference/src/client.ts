import { RequestError } from './errors.ts';
export async function requestJson(transport:any,url:string) {const response=await transport(url);if(response.status>=200&&response.status<300){if(response.status===204)return null;return response.json();}let body;try{body=await response.json();}catch{body=null;}throw new RequestError(response.status,body);}
