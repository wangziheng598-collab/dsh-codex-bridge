import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { startServer } from './helpers.mjs';

describe('MCP protocol', () => {
  let server;

  before(async () => {
    server = startServer();
    const init = await server.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'protocol-test', version: '0.0.0' },
    });
    assert.equal(init.serverInfo.name, 'dsh-bridge');
    assert.equal(init.protocolVersion, '2025-06-18');
    assert.ok(init.capabilities.tools, 'advertises the tools capability');
    assert.ok(typeof init.instructions === 'string' && init.instructions.length > 0, 'ships model instructions');
    server.notify('notifications/initialized');
  });

  after(async () => {
    await server.stop();
  });

  it('falls back to a supported protocol version', async () => {
    const other = startServer();
    try {
      const init = await other.request('initialize', {
        protocolVersion: '1999-01-01',
        capabilities: {},
        clientInfo: { name: 'old-client', version: '0.0.0' },
      });
      assert.ok(['2025-06-18', '2025-03-26', '2024-11-05'].includes(init.protocolVersion));
    } finally {
      await other.stop();
    }
  });

  it('lists five tools with object schemas', async () => {
    const { tools } = await server.request('tools/list', {});
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['dsh_doctor', 'dsh_resume', 'dsh_run', 'dsh_session_read', 'dsh_sessions']);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} has an object schema`);
      assert.ok(typeof tool.description === 'string' && tool.description.length > 20, `${tool.name} is documented`);
    }
  });

  it('answers ping', async () => {
    const result = await server.request('ping', {});
    assert.deepEqual(result, {});
  });

  it('rejects unknown methods', async () => {
    await assert.rejects(server.request('no/such/method', {}), (error) => {
      assert.equal(error.rpc.code, -32601);
      return true;
    });
  });

  it('rejects unknown tools with an invalid-params error', async () => {
    await assert.rejects(server.request('tools/call', { name: 'nope', arguments: {} }), (error) => {
      assert.equal(error.rpc.code, -32602);
      return true;
    });
  });

  it('reports setup state through dsh_doctor', async () => {
    const result = await server.request('tools/call', { name: 'dsh_doctor', arguments: {} });
    assert.ok(!result.isError, 'doctor succeeds even without DSH installed');
    const text = result.content.map((item) => item.text).join('\n');
    assert.match(text, /DSH bridge doctor/);
    assert.match(text, /launcher:/);
  });

  it('returns an actionable error for unknown sessions', async () => {
    const result = await server.request('tools/call', {
      name: 'dsh_session_read',
      arguments: { session_id: 'session-does-not-exist' },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No DSH session found/);
  });

  it('validates tool arguments', async () => {
    const result = await server.request('tools/call', { name: 'dsh_run', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /prompt/);
  });
});
