/**
 * A small, dependency-free Model Context Protocol server over stdio.
 *
 * Codex talks MCP as newline-delimited JSON-RPC 2.0: one UTF-8 JSON object per
 * line on stdin/stdout. Nothing but protocol messages may reach stdout, so all
 * diagnostics go to stderr.
 *
 * Supported surface: initialize, ping, tools/list, tools/call, plus empty
 * resources/prompts listings. The server never advertises capabilities it does
 * not implement.
 */

import { createInterface } from 'node:readline';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TEXT_RESULT_CHARS = 200_000;

function log(message) {
  process.stderr.write(`[dsh-bridge] ${message}\n`);
}

function textResult(text, extra = {}) {
  const value = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  const clipped =
    value.length > MAX_TEXT_RESULT_CHARS
      ? `${value.slice(0, MAX_TEXT_RESULT_CHARS)}\n\n[truncated ${value.length - MAX_TEXT_RESULT_CHARS} characters]`
      : value;
  return { content: [{ type: 'text', text: clipped }], ...extra };
}

function normalizeResult(result) {
  if (result === undefined || result === null) return textResult('');
  if (typeof result === 'string') return textResult(result);
  if (result && Array.isArray(result.content)) return result;
  return textResult(result);
}

/**
 * @param {object} options
 * @param {string} options.name            server name reported to the client
 * @param {string} options.version         server version reported to the client
 * @param {string} [options.instructions]  optional guidance shown to the model
 * @param {Array<{definition: object, call: (args: object, ctx: object) => any}>} options.tools
 */
export function createMcpServer({ name, version, instructions = '', tools, context = {} }) {
  const toolByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const pending = new Map();
  let nextRequestId = 1;
  let clientCapabilities = {};
  let finished = false;
  let closing = false;
  let initialized = false;
  let activeRequests = 0;
  const idleWaiters = [];

  const write = (message) => {
    if (finished) return;
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const markBusy = () => {
    activeRequests += 1;
  };
  const markIdle = () => {
    activeRequests = Math.max(0, activeRequests - 1);
    if (activeRequests === 0) {
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  };
  const waitForIdle = (timeoutMs) => {
    if (activeRequests === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      idleWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message, data) =>
    write({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });

  /** Ask the client something (for example `roots/list`). */
  const request = (method, params, timeoutMs = 5_000) => {
    const id = `dsh-bridge-${nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`client did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      write({ jsonrpc: '2.0', id, method, params });
    });
  };

  const handleToolCall = async (id, params) => {
    const requestedName = params && params.name;
    const tool = toolByName.get(requestedName);
    if (!tool) {
      respondError(id, -32602, `Unknown tool: ${String(requestedName)}`);
      return;
    }
    const args = params && typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {};
    try {
      const result = await tool.call(args, {
        ...context,
        request,
        clientCapabilities,
        serverInfo: { name, version },
      });
      respond(id, normalizeResult(result));
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      log(`tool ${requestedName} failed: ${message}`);
      respond(id, { content: [{ type: 'text', text: message }], isError: true });
    }
  };

  const handleRequest = async (message) => {
    const { id, method } = message;
    switch (method) {
      case 'initialize': {
        const requested = message.params && message.params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOL_VERSIONS[0];
        clientCapabilities = (message.params && message.params.capabilities) || {};
        initialized = true;
        log(`initialize from ${(message.params && message.params.clientInfo && message.params.clientInfo.name) || 'unknown client'} (protocol ${protocolVersion})`);
        respond(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          ...(instructions ? { instructions } : {}),
        });
        return;
      }
      case 'ping':
        respond(id, {});
        return;
      case 'tools/list':
        respond(id, { tools: tools.map((tool) => tool.definition) });
        return;
      case 'tools/call':
        await handleToolCall(id, message.params || {});
        return;
      case 'resources/list':
        respond(id, { resources: [] });
        return;
      case 'resources/templates/list':
        respond(id, { resourceTemplates: [] });
        return;
      case 'prompts/list':
        respond(id, { prompts: [] });
        return;
      case 'logging/setLevel':
        respond(id, {});
        return;
      default:
        respondError(id, -32601, `Method not found: ${String(method)}`);
    }
  };

  const handleMessage = async (message) => {
    if (!message || message.jsonrpc !== '2.0') {
      log('ignoring malformed message');
      return;
    }
    // A response to a server-initiated request.
    if (message.method === undefined && message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || 'client error'));
      else waiter.resolve(message.result);
      return;
    }
    // Notifications carry no id and produce no response.
    if (message.id === undefined) return;
    try {
      await handleRequest(message);
    } catch (error) {
      respondError(message.id, -32603, error && error.message ? error.message : String(error));
    }
  };

  const shutdown = async (reason) => {
    if (closing) return;
    closing = true;
    // A client may send a batch and close stdin immediately; let in-flight
    // tool calls finish and write their responses before exiting.
    await waitForIdle(10_000);
    if (finished) return;
    finished = true;
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('server shutting down'));
    }
    pending.clear();
    log(`shutting down (${reason})`);
    // Give stdout a tick to flush before exiting.
    setTimeout(() => process.exit(0), 10).unref();
  };

  const listen = () => {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch (error) {
        log(`dropping non-JSON stdin line: ${error.message}`);
        return;
      }
      markBusy();
      void handleMessage(message).finally(markIdle);
    });
    rl.on('close', () => {
      void shutdown('stdin closed');
    });
    process.stdin.on('error', (error) => {
      log(`stdin error: ${error.message}`);
      void shutdown('stdin error');
    });
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('uncaughtException', (error) => {
      log(`uncaught exception: ${error.stack || error.message}`);
    });
    process.on('unhandledRejection', (error) => {
      log(`unhandled rejection: ${error && error.stack ? error.stack : String(error)}`);
    });
    log(`${name} ${version} ready (tools: ${tools.map((tool) => tool.definition.name).join(', ')})`);
    // `initialized` is tracked so a future version can require it; probe clients
    // sometimes skip the notification, so tools stay available either way.
    void initialized;
  };

  return { listen, request, shutdown };
}
