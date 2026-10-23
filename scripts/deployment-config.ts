import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {createHash} from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
export const deploymentFile = resolve(root, '.weft/deployment.json');
const name = z.string().regex(/^[a-z][a-z0-9-]{0,49}$/);
const domain = z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);
const registryImage = z.string().regex(/^registry\.cloudflare\.com\/[a-f0-9]{32}\/weft-(?:workspace-shell|plugin-builder):[a-f0-9]{12}$/);
const schema = z.object({
  workerName: name.default('weft'),
  uiWorkerName: name.default('weft-ui-assets'),
  domain: domain.optional(),
  accessAudience: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  accessTeamDomain: z.string().regex(/^[a-z0-9-]+\.cloudflareaccess\.com$/).optional(),
  databaseName: name.default('weft-config'),
  databaseId: z.uuid().optional(),
  artifactBucketName: name.default('weft-plugin-artifacts'),
  workspaceContainerPrefix: name.default('weft-workspace-shell'),
  pluginBuilderName: name.default('weft-plugin-builder'),
  workspaceImage: registryImage.optional(),
  pluginBuilderImage: registryImage.optional(),
}).strict();

export type DeploymentConfig = z.infer<typeof schema>;
export function deploymentFingerprint(config: DeploymentConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

// A complete build variable takes precedence over the ignored local file.
// Neither source is bundled into the public browser application.
export function loadDeploymentConfig(options: {
  env?: Record<string, string | undefined>;
  filename?: string;
} = {}): DeploymentConfig {
  const env = options.env ?? process.env, filename = options.filename ?? deploymentFile;
  let input: unknown;
  try {
    input = env.WEFT_DEPLOY_CONFIG !== undefined
      ? JSON.parse(env.WEFT_DEPLOY_CONFIG)
      : existsSync(filename) ? JSON.parse(readFileSync(filename, 'utf8')) : {};
  } catch {
    throw new Error('Invalid deployment JSON; check WEFT_DEPLOY_CONFIG or .weft/deployment.json');
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    // Report field names only: configuration errors must never echo private values.
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'root'))];
    throw new Error(`Invalid deployment configuration fields: ${fields.join(', ')}`);
  }
  if (parsed.data.workerName === parsed.data.uiWorkerName) throw new Error('Main and UI Worker names must differ');
  return parsed.data;
}

export function requireDeploymentConfig(config: DeploymentConfig): void {
  const missing = (['domain', 'accessAudience', 'accessTeamDomain', 'databaseId', 'workspaceImage', 'pluginBuilderImage'] as const)
    .filter(key => !config[key]);
  if (missing.length) throw new Error(`Deployment configuration is incomplete: ${missing.join(', ')}. See docs/deployment.md`);
  for (const [field, directory] of [['workspaceImage', 'workspace-container'], ['pluginBuilderImage', 'plugin-builder']] as const) {
    const {reference} = JSON.parse(readFileSync(resolve(root, `apps/${directory}/image.json`), 'utf8')) as {reference: string};
    if (!config[field]!.endsWith('/' + reference)) throw new Error(`Deployment ${field} does not match the reviewed image tag`);
  }
}

export function recordDeploymentImage(field: 'workspaceImage' | 'pluginBuilderImage', reference: string): void {
  const current = loadDeploymentConfig();
  const next = schema.parse({...current, [field]: reference});
  mkdirSync(dirname(deploymentFile), {recursive: true});
  writeFileSync(deploymentFile, JSON.stringify(next, null, 2) + '\n', {mode: 0o600});
}

export const deployment = loadDeploymentConfig();
