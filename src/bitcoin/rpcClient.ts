export type RpcErrorKind =
  'network' | 'timeout' | 'auth' | 'http' | 'rpc' | 'parse';

export class RpcError extends Error {
  readonly kind: RpcErrorKind;
  readonly rpcCode: number | undefined;
  readonly httpStatus: number | undefined;

  constructor(
    message: string,
    kind: RpcErrorKind,
    details: {rpcCode?: number; httpStatus?: number; cause?: unknown} = {},
  ) {
    super(
      message,
      details.cause === undefined ? undefined : {cause: details.cause},
    );
    this.name = 'RpcError';
    this.kind = kind;
    this.rpcCode = details.rpcCode;
    this.httpStatus = details.httpStatus;
  }
}

export interface RpcClientOptions {
  url: string;
  user?: string;
  password?: string;
  timeoutMs?: number;
}

export interface BlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  verificationprogress: number;
  initialblockdownload: boolean;
  size_on_disk: number;
  pruned: boolean;
  warnings?: string | string[];
  time?: number;
}

export interface NetworkInfo {
  connections: number;
  connections_in?: number;
  connections_out?: number;
  warnings?: string | string[];
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: {code: number; message: string} | null;
  id?: string | number | null;
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as {name?: unknown}).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function networkErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const cause = (error as {cause?: unknown}).cause;
    if (typeof cause === 'object' && cause !== null) {
      const code = (cause as {code?: unknown}).code;
      if (typeof code === 'string') {
        return code;
      }
    }
    const message = (error as {message?: unknown}).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  return 'connection failed';
}

/**
 * Sanitize an RPC error before logging it or forwarding it to Telegram.
 * Never includes credentials: the password is not part of the message, and
 * any URL userinfo or password-like tokens are stripped defensively.
 */
export function sanitizeRpcError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = raw
    .replace(
      /(password|passwd|rpcpassword|cookie)\s*[=:]\s*\S+/gi,
      '$1=[redacted]',
    )
    .replace(/(https?:\/\/)[^@\s/]+@/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const text = redacted.length > 0 ? redacted : 'unknown error';
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** Human-friendly RPC endpoint label (host:port, no credentials). */
export function rpcEndpointLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the configured RPC endpoint';
  }
}

/**
 * Minimal Bitcoin Core JSON-RPC client over fetch.
 *
 * Uses HTTP Basic auth with the `user`/`password` pair from a Bitcoin Core
 * `rpcauth` credential. The bot only sends the plaintext password; bitcoind
 * stores the salt/hash verifier and never receives it.
 */
export class RpcClient {
  private readonly url: string;
  private readonly user: string | undefined;
  private readonly password: string | undefined;
  private readonly timeoutMs: number;
  private requestId = 0;

  constructor(options: RpcClientOptions) {
    this.url = options.url;
    this.user = options.user;
    this.password = options.password;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  private buildAuthHeader(): string {
    if (this.user && this.password) {
      return `Basic ${Buffer.from(`${this.user}:${this.password}`, 'utf8').toString('base64')}`;
    }
    throw new RpcError('no RPC credentials configured', 'auth');
  }

  /** POST a JSON-RPC body, mapping transport failures to `RpcError`. */
  private async post(body: string): Promise<Response> {
    try {
      return await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this.buildAuthHeader(),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof RpcError) {
        throw error;
      }
      if (isAbortError(error)) {
        throw new RpcError(
          `RPC request timed out after ${this.timeoutMs} ms`,
          'timeout',
          {cause: error},
        );
      }
      throw new RpcError(
        `RPC connection failed: ${networkErrorMessage(error)}`,
        'network',
        {cause: error},
      );
    }
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const body = JSON.stringify({
      jsonrpc: '1.0',
      id: ++this.requestId,
      method,
      params,
    });

    const response = await this.post(body);

    if (response.status === 401) {
      throw new RpcError(
        'RPC authentication failed (401 Unauthorized)',
        'auth',
        {
          httpStatus: response.status,
        },
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new RpcError(
        `failed to read RPC response: ${networkErrorMessage(error)}`,
        'network',
        {cause: error},
      );
    }

    let payload: JsonRpcResponse<T> | null = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as JsonRpcResponse<T>;
      } catch (error) {
        if (!response.ok) {
          throw new RpcError(`RPC HTTP ${response.status}`, 'http', {
            httpStatus: response.status,
            cause: error,
          });
        }
        throw new RpcError('RPC returned a non-JSON response', 'parse', {
          cause: error,
        });
      }
    }

    if (payload?.error) {
      throw new RpcError(payload.error.message, 'rpc', {
        rpcCode: payload.error.code,
        httpStatus: response.status,
      });
    }

    if (!response.ok) {
      throw new RpcError(`RPC HTTP ${response.status}`, 'http', {
        httpStatus: response.status,
      });
    }

    if (payload === null || !('result' in payload)) {
      throw new RpcError('RPC response did not include a result', 'parse', {
        httpStatus: response.status,
      });
    }

    return payload.result as T;
  }

  getBlockchainInfo(): Promise<BlockchainInfo> {
    return this.call<BlockchainInfo>('getblockchaininfo');
  }

  getNetworkInfo(): Promise<NetworkInfo> {
    return this.call<NetworkInfo>('getnetworkinfo');
  }
}
