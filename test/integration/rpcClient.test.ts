import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {afterEach, describe, expect, it} from 'vitest';
import {
  RpcClient,
  RpcError,
  rpcEndpointLabel,
  sanitizeRpcError,
} from '../../src/bitcoin/rpcClient';

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
) => void;

interface TestServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const testServer = servers.pop();
    if (!testServer) {
      continue;
    }
    testServer.server.closeAllConnections();
    await new Promise<void>(resolve =>
      testServer.server.close(() => resolve()),
    );
  }
});

async function startServer(handler: Handler): Promise<TestServer> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      handler(request, response, Buffer.concat(chunks).toString('utf8'));
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('server did not bind');
  }

  const testServer: TestServer = {
    url: `http://127.0.0.1:${address.port}`,
    server,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(testServer);
  return testServer;
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

describe('RpcClient', () => {
  it('calls JSON-RPC with basic user/password auth', async () => {
    const testServer = await startServer((request, response, body) => {
      expect(request.headers.authorization).toBe(
        `Basic ${Buffer.from('rpcuser:rpcpass').toString('base64')}`,
      );
      const parsed = JSON.parse(body) as {method: string; id: number};
      expect(parsed.method).toBe('getblockchaininfo');
      sendJson(response, 200, {
        result: {chain: 'main'},
        error: null,
        id: parsed.id,
      });
    });

    const client = new RpcClient({
      url: testServer.url,
      user: 'rpcuser',
      password: 'rpcpass',
      timeoutMs: 2_000,
    });

    await expect(client.getBlockchainInfo()).resolves.toMatchObject({
      chain: 'main',
    });
  });

  it('maps Bitcoin Core RPC errors', async () => {
    const testServer = await startServer((_request, response) => {
      sendJson(response, 500, {
        result: null,
        error: {code: -5, message: 'No such mempool or blockchain transaction'},
        id: 1,
      });
    });

    const client = new RpcClient({
      url: testServer.url,
      user: 'u',
      password: 'p',
      timeoutMs: 2_000,
    });
    await expect(client.call('getmempoolentry', ['aa'])).rejects.toMatchObject({
      kind: 'rpc',
      rpcCode: -5,
    });
  });

  it('returns null for an unknown getchainstates method', async () => {
    const testServer = await startServer((_request, response) => {
      sendJson(response, 500, {
        result: null,
        error: {code: -32601, message: 'Method not found'},
        id: 1,
      });
    });

    const client = new RpcClient({
      url: testServer.url,
      user: 'u',
      password: 'p',
      timeoutMs: 2_000,
    });
    await expect(client.getChainStates()).resolves.toBeNull();
  });

  it('times out slow requests', async () => {
    const testServer = await startServer(() => {
      // never respond
    });

    const client = new RpcClient({
      url: testServer.url,
      user: 'u',
      password: 'p',
      timeoutMs: 25,
    });
    const error = await client
      .getBlockchainInfo()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).kind).toBe('timeout');
  });

  it('reports auth failures without retrying static credentials', async () => {
    let requests = 0;
    const testServer = await startServer((_request, response) => {
      requests += 1;
      sendJson(response, 401, {
        error: {code: -1, message: 'bad auth'},
        result: null,
        id: null,
      });
    });

    const client = new RpcClient({
      url: testServer.url,
      user: 'u',
      password: 'p',
      timeoutMs: 2_000,
    });
    await expect(client.getBlockchainInfo()).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(requests).toBe(1);
  });
});

describe('rpc error sanitization', () => {
  it('never leaks password-like tokens', () => {
    const message = sanitizeRpcError(
      new Error('login failed: password=hunter2 cookie=abcd1234'),
    );
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('abcd1234');
    expect(message).toContain('[redacted]');
  });

  it('truncates long messages and strips URL userinfo', () => {
    const long = sanitizeRpcError(
      new Error(`https://user:secret@example.test/${'x'.repeat(1_000)}`),
    );
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long).not.toContain('secret');
  });

  it('labels the endpoint without credentials', () => {
    expect(rpcEndpointLabel('http://user:pass@127.0.0.1:8332')).toBe(
      '127.0.0.1:8332',
    );
    expect(rpcEndpointLabel('not a url')).toBe('the configured RPC endpoint');
  });
});
