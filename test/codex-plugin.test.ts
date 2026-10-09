import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMaatCodexServer } from '../packages/codex/src/server.ts';

test('Codex plugin manifests expose Skills and local stdio tools', async () => {
  const root = path.resolve(import.meta.dirname, '../packages/codex');
  const manifest = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8')) as {
    name: string;
    version: string;
  };
  const mcp = JSON.parse(await readFile(path.join(root, 'mcp.json'), 'utf8')) as {
    mcpServers: Record<string, { type: string; command: string; args: string[] }>;
  };
  assert.equal(manifest.name, 'maat');
  assert.equal(manifest.version, '0.3.1');
  assert.deepEqual(mcp.mcpServers.maat, {
    type: 'stdio',
    command: 'node',
    args: ['${PLUGIN_ROOT}/dist/server.js'],
  });
  for (const skill of ['maat-setup', 'maat-case-builder', 'maat-test-runner']) {
    assert.match(
      await readFile(path.join(root, 'skills', skill, 'SKILL.md'), 'utf8'),
      new RegExp(`^---\nname: ${skill}\n`, 'm'),
    );
  }
});

test('Codex Tool Server exposes a persistent Maat workflow', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const { server, runtime } = createMaatCodexServer({ workspaceRoot: process.cwd() });
  const client = new Client({ name: 'maat-test', version: '1.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    for (const name of [
      'maat_list_platforms',
      'maat_select_platform',
      'maat_check_setup',
      'maat_execute_javascript',
      'maat_begin_case',
      'maat_save_case',
      'maat_run_tests',
      'maat_show_evidence',
    ]) {
      assert.ok(names.has(name), `${name} was not registered`);
    }

    const platforms = await client.callTool({ name: 'maat_list_platforms', arguments: {} });
    assert.match(JSON.stringify(platforms.structuredContent), /"web"/);
    await client.callTool({
      name: 'maat_begin_case',
      arguments: {
        id: 'codex-smoke',
        name: 'Codex smoke',
        description: 'Verify persistent Tool state',
        objectives: ['Ready'],
      },
    });
    const status = await client.callTool({ name: 'maat_get_case_status', arguments: {} });
    assert.equal((status.structuredContent as { id?: string }).id, 'codex-smoke');
  } finally {
    await client.close();
    await runtime.close();
    await server.close();
  }
});

test('Codex request metadata relocates Maat from the plugin cache to the user workspace', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const workspace = await mkdtemp(path.join(tmpdir(), 'maat-codex-workspace-'));
  const { server, runtime } = createMaatCodexServer({ workspaceRoot: '/tmp/plugin-cache' });
  try {
    await runtime.bindRequest({
      'x-codex-turn-metadata': { workspaces: { [workspace]: { has_changes: false } } },
    });
    assert.equal(runtime.workspaceRoot, workspace);
    assert.equal(runtime.maat.platforms.current().root, path.join(workspace, 'maat-tests/web'));
  } finally {
    await runtime.close();
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
