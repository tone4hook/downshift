import { mergeOptions } from './options.ts';
export function parsePort(value: any): number {
  if (!/^[0-9]+$/.test(String(value))) throw new Error('INVALID_PORT');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
  return port;
}
export async function planDeploy(file: any, env: any, flags: any, deploy: any) {
  const options = mergeOptions(file, env, flags);
  const plan = { port: parsePort(options.port), dryRun: options.dryRun };
  if (typeof plan.dryRun !== 'boolean') throw new Error('INVALID_DRY_RUN');
  if (!plan.dryRun) await deploy(plan);
  return plan;
}
