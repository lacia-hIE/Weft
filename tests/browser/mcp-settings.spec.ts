import {test, expect} from '@playwright/test';

test('Settings adds, edits and removes a remote MCP server without reading header values back', async ({page, request}) => {
  const me = await (await request.get('/v1/me')).json() as {tenantId: string};
  const id = 'mcp-'+crypto.randomUUID().slice(0, 8);
  const base = `/v1/tenants/${me.tenantId}/environments/${id}`;
  expect((await request.post(`/v1/tenants/${me.tenantId}/environments`, {data: {id, name: id}})).status()).toBe(201);
  const described = async () => {
    const response = await (await request.post(base+'/native/api/settings/describe', {data: {type: 'client-request', rpcId: crypto.randomUUID(), method: 'settings/describe', payload: {args: {}}}})).json();
    return response.result.value.namespaces.find((row: {ns: string}) => row.ns === 'mcp-servers') as {value: {servers: {name: string; url: string; enabled: boolean; headers?: Record<string, string>}[]}; secrets: {path: string[]; set: boolean}[]};
  };
  await page.goto('/agents/'+id);
  await page.getByRole('button', {name: 'Continue', exact: true}).click({timeout: 45_000});
  await expect(page.getByRole('treeitem', {name: /New Session/}).first()).toBeVisible({timeout: 45_000});
  await page.getByRole('button', {name: 'Settings', exact: true}).click({timeout: 45_000});
  await page.getByRole('button', {name: 'MCP servers', exact: true}).click();
  const section = page.getByRole('region', {name: 'MCP servers', exact: true});
  await expect(section.getByText('No MCP servers yet.', {exact: true})).toBeVisible();

  await section.getByRole('button', {name: 'Add server', exact: true}).click();
  const form = section.getByRole('region', {name: 'Add server', exact: true});
  await form.getByRole('button', {name: 'Fill in the GitHub preset', exact: true}).click();
  await expect(form.getByLabel('URL', {exact: true})).toHaveValue('https://api.githubcopilot.com/mcp/');
  await form.getByLabel('Value', {exact: true}).first().fill('Bearer github_pat_fixture');
  await form.getByRole('button', {name: 'Save', exact: true}).click();

  const card = section.getByRole('article', {name: 'github', exact: true});
  await expect(card).toBeVisible();
  await expect.poll(async () => (await described()).value.servers.map(server => server.url)).toEqual(['https://api.githubcopilot.com/mcp/']);
  const saved = await described();
  expect(JSON.stringify(saved.value)).not.toContain('github_pat_fixture');
  expect(saved.secrets.filter(secret => secret.path[2] === 'headers' && secret.set).map(secret => secret.path[3]).sort()).toEqual(['Authorization', 'X-MCP-Toolsets']);
  await expect(card.getByText('Set', {exact: true})).toHaveCount(2);
  await expect(page.getByText('github_pat_fixture')).toHaveCount(0);

  // A refused list keeps the stored one: the Host accepts only public https URLs.
  await card.getByLabel('URL', {exact: true}).fill('http://localhost/mcp');
  await card.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(card.getByRole('alert')).toContainText('public https');
  expect((await described()).value.servers[0]!.url).toBe('https://api.githubcopilot.com/mcp/');

  await card.getByRole('switch', {name: 'Enabled', exact: true}).click();
  await expect.poll(async () => (await described()).value.servers[0]!.enabled).toBe(false);
  await card.getByRole('button', {name: 'Remove server', exact: true}).click();
  await card.getByRole('button', {name: 'Confirm removal', exact: true}).click();
  await expect(section.getByText('No MCP servers yet.', {exact: true})).toBeVisible();
  expect((await described()).value.servers).toEqual([]);
});
