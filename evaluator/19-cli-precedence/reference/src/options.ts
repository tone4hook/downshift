export function mergeOptions(file: any, env: any, flags: any) {
  const fromEnv: any = {};
  if (env.DEPLOY_PORT !== undefined && env.DEPLOY_PORT !== '') fromEnv.port = env.DEPLOY_PORT;
  if (env.DEPLOY_DRY_RUN !== undefined && env.DEPLOY_DRY_RUN !== '') {
    if (!['true', 'false'].includes(env.DEPLOY_DRY_RUN)) throw new Error('INVALID_DRY_RUN');
    fromEnv.dryRun = env.DEPLOY_DRY_RUN === 'true';
  }
  return { port: 3000, dryRun: false, ...file, ...fromEnv, ...flags };
}
