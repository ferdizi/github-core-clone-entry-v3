// app.ts — the HTTP server: routes /healthz, /api/v3, /api/graphql, /mcp and
// the git smart-HTTP paths onto the forge. Every JSON reply carries a
// non-empty X-GitHub-Request-Id. Node built-ins only.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export interface AppOptions {
  /** The bearer token the suite presents (MAKEFUN_SHOP_TOKEN in a trial). */
  token: string;
}

let requestSeq = 0;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  requestSeq += 1;
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': `req-${requestSeq}`,
    ...extraHeaders,
  });
  res.end(payload);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': `req-${requestSeq}`,
    'content-length': String(body.length),
  });
  res.end(body);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match !== null ? match[1] : null;
}

export function createApp(forge: Forge, options: AppOptions) {
  const server = createServer((req, res) => {
    void handleRequest(forge, options, req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, 500, { message: `internal error: ${message}` });
      } else {
        res.destroy();
      }
    });
  });
  return server;
}

async function handleRequest(forge: Forge, options: AppOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();

  // Health probe (no auth).
  if (pathname === '/healthz' && method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // GraphQL.
  if (pathname === '/api/graphql' && method === 'POST') {
    const token = bearerToken(req);
    if (token === null || token === '' || token !== options.token) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const result = handleGraphQL({ forge }, parsed);
    sendJson(res, result.status, result.body);
    return;
  }

  // MCP.
  if (pathname === '/mcp' && method === 'POST') {
    const token = bearerToken(req);
    const body = await readBody(req);
    const result = handleMcp(forge, body, token, options.token);
    if (result.body === null) {
      requestSeq += 1;
      res.writeHead(result.status, { 'x-github-request-id': `req-${requestSeq}` });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body);
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const segments = pathname
      .slice('/api/v3'.length)
      .split('/')
      .filter((s) => s !== '')
      .map((s) => decodeURIComponent(s));
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    const host = req.headers.host ?? '127.0.0.1';
    const origin = `http://${host}`;
    const restReq: RestRequest = {
      method,
      segments,
      query: url.searchParams,
      body,
      token: bearerToken(req),
      requestId: `req-${requestSeq + 1}`,
      origin,
    };
    const result = await handleRest({ forge, token: options.token }, restReq);
    const headers: Record<string, string> = {};
    if (result.headers !== undefined) Object.assign(headers, result.headers);
    if (result.status === 204) {
      requestSeq += 1;
      res.writeHead(204, { 'x-github-request-id': `req-${requestSeq}`, ...headers });
      res.end();
      return;
    }
    sendJson(res, result.status, result.body, headers);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1]);
    const repoName = decodeURIComponent(gitMatch[2]);
    const service = gitMatch[3];
    if (service === 'info/refs' && method === 'GET') {
      const serviceParam = url.searchParams.get('service');
      if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'service parameter is required' });
        return;
      }
      const gitProtocol = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
      const result = handleInfoRefs(forge, owner, repoName, serviceParam, gitProtocol);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    if (service === 'git-upload-pack' && method === 'POST') {
      const gitProtocol = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
      const body = await readBody(req);
      const result = handleUploadPack(forge, owner, repoName, body, gitProtocol);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    if (service === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      const result = handleReceivePack(forge, owner, repoName, body);
      sendRaw(res, result.status, result.contentType, result.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
