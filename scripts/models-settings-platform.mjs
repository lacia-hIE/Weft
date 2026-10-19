// Keep the original Models editor and credential protocol. Only its host-specific
// copy changes: workerd credentials live in the environment's durable store.
const copies = [
  ['Leave blank to use env as auth ({hint})', 'Enter your API key for this environment'],
  ['Env var not detected. Enter an API key, or configure {hint} in your env.', 'No API key saved for this environment. Enter your API key here.'],
  ['Env var detected. ({hint})', 'API key saved for this environment.'],
  ['Env var detected.', 'API key saved for this environment.'],
  ['Environment credential status has not been confirmed.', 'Saved credential status has not been confirmed.'],
  ['Saved credentials are used first. Environment fallbacks shown here, in order: {env}. Sources are launch environment, $cwd/.env, then $DSH_HOME/.env.', 'Credentials are saved only for this environment and are never read back to the browser. Model configuration does not use server environment variables or .env files.'],
  ['https://api.deepseek.com/anthropic (Default to use DEEPSEEK_BASE_URL)', 'https://api.deepseek.com/anthropic'],
  ['留空使用环境认证（{hint}）', '请输入当前环境的 API 密钥'],
  ['未检测到环境变量。请填写 API 密钥，或设置环境变量 {hint}。', '当前环境尚未保存 API 密钥，请在此填写。'],
  ['已检测到环境变量（{hint}）', '当前环境已保存 API 密钥'],
  ['已检测到环境变量', '当前环境已保存 API 密钥'],
  ['环境凭据状态尚未确认', '已保存凭据的状态尚未确认'],
  ['优先使用已保存的凭据。此处显示的环境后备按以下顺序排列：{env}。来源依次为启动环境、$cwd/.env、$DSH_HOME/.env。', '密钥仅保存在当前环境中，不会读取回浏览器。模型配置不读取服务端环境变量或 .env 文件。'],
  ['https://api.deepseek.com/anthropic（默认使用环境 DEEPSEEK_BASE_URL）', 'https://api.deepseek.com/anthropic'],
];

export const modelsSettingsPlatform = {
  name: 'weft-models-settings-platform-copy',
  transform(source, id) {
    if (!id.replaceAll('\\', '/').endsWith('/packages/client/ui-settings-models/src/client/locales.ts')) return null;
    for (const [before, after] of copies) {
      const literal = `'${before}'`;
      if (!source.includes(literal) || source.indexOf(literal) !== source.lastIndexOf(literal)) {
        throw new Error('Upstream Models credential copy changed; review the workerd adaptation');
      }
      source = source.replace(literal, JSON.stringify(after));
    }
    return {code: source, map: null};
  },
};
