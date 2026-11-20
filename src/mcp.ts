// mcp.ts — Model Context Protocol endpoint (POST /mcp, JSON-RPC 2.0).
// Speaks the modern 2026-07-28 era (server/discover, no handshake) and the
// legacy initialize handshake. Tools: create_repo, get_repo, create_issue,
// list_issues, create_pull_request, merge_pull_request.

import { VIEWER_LOGIN, type Forge } from './store.ts';

export interface McpResult {
  status: number;
  body: unknown;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string; enum?: string[] }>;
    required: string[];
  };
  run: (forge: Forge, args: Record<string, unknown>) => { ok: true; value: unknown } | { ok: false; message: string };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
    run: (forge, args) => {
      const name = String(args.name ?? '');
      if (name === '') return { ok: false, message: 'name is required' };
      if (forge.getRepo(VIEWER_LOGIN, name) !== undefined) {
        return { ok: false, message: `Repository ${VIEWER_LOGIN}/${name} already exists` };
      }
      const repo = forge.createRepo(VIEWER_LOGIN, name, {
        description: typeof args.description === 'string' ? args.description : '',
        private: typeof args.private === 'boolean' ? args.private : false,
      });
      return { ok: true, value: { id: repo.id, name: repo.name, full_name: `${repo.owner}/${repo.name}`, owner: repo.owner, private: repo.private, description: repo.description, default_branch: repo.defaultBranch } };
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const owner = String(args.owner ?? '');
      const repo = String(args.repo ?? '');
      const found = forge.getRepo(owner, repo);
      if (found === undefined) return { ok: false, message: `Repository ${owner}/${repo} not found` };
      return { ok: true, value: { id: found.id, name: found.name, full_name: `${found.owner}/${found.name}`, owner: found.owner, private: found.private, description: found.description, default_branch: found.defaultBranch } };
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
    run: (forge, args) => {
      const owner = String(args.owner ?? '');
      const repo = String(args.repo ?? '');
      const found = forge.getRepo(owner, repo);
      if (found === undefined) return { ok: false, message: `Repository ${owner}/${repo} not found` };
      const title = String(args.title ?? '');
      if (title === '') return { ok: false, message: 'title is required' };
      const issue = forge.createIssue(found, { title, body: typeof args.body === 'string' ? args.body : '' });
      return { ok: true, value: { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, url: `https://github.com/${owner}/${repo}/issues/${issue.number}` } };
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
    run: (forge, args) => {
      const owner = String(args.owner ?? '');
      const repo = String(args.repo ?? '');
      const found = forge.getRepo(owner, repo);
      if (found === undefined) return { ok: false, message: `Repository ${owner}/${repo} not found` };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...found.issues];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      return { ok: true, value: list.map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels })) };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    run: (forge, args) => {
      const owner = String(args.owner ?? '');
      const repo = String(args.repo ?? '');
      const found = forge.getRepo(owner, repo);
      if (found === undefined) return { ok: false, message: `Repository ${owner}/${repo} not found` };
      const result = forge.createPull(found, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head ?? ''),
        base: String(args.base ?? ''),
      });
      if ('error' in result) return { ok: false, message: result.error };
      return { ok: true, value: { id: result.id, number: result.number, title: result.title, body: result.body, state: result.state, head: result.headRef, base: result.baseRef, merged: result.merged } };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    run: (forge, args) => {
      const owner = String(args.owner ?? '');
      const repo = String(args.repo ?? '');
      const found = forge.getRepo(owner, repo);
      if (found === undefined) return { ok: false, message: `Repository ${owner}/${repo} not found` };
      const number = Number(args.pull_number);
      if (!Number.isInteger(number) || number < 1) return { ok: false, message: 'pull_number is required and must be a positive integer' };
      const pull = forge.getPull(found, number);
      if (pull === undefined) return { ok: false, message: `Pull request #${number} not found` };
      const result = forge.mergePull(found, pull);
      if ('error' in result) return { ok: false, message: result.error };
      return { ok: true, value: { id: pull.id, number: pull.number, title: pull.title, state: pull.state, merged: pull.merged, merge_commit_sha: result.mergeCommitSha } };
    },
  },
];

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

export function handleMcp(forge: Forge, rawBody: Buffer, token: string | null, expectedToken: string): McpResult {
  // Auth: a tools/call (and every other RPC) needs the bearer token.
  if (token === null || token === '') {
    return { status: 401, body: { message: 'Requires authentication' } };
  }
  if (token !== expectedToken) {
    return { status: 401, body: { message: 'Bad credentials' } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const req = parsed as Record<string, unknown>;
  const id = (typeof req.id === 'string' || typeof req.id === 'number') ? req.id : null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (typeof req.params === 'object' && req.params !== null ? req.params : {}) as Record<string, unknown>;

  // Notifications carry no id and expect no response body.
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        resultType: 'DiscoverResult',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    };
  }

  if (method === 'initialize') {
    const requested = typeof (params as Record<string, unknown>).protocolVersion === 'string'
      ? (params as Record<string, unknown>).protocolVersion as string
      : '2026-07-28';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    };
  }

  if (method === 'tools/list') {
    const tools = TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return { status: 200, body: rpcResult(id, { tools }) };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name}`) };
    }
    // Missing required arguments -> isError: true.
    const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }],
          isError: true,
        }),
      };
    }
    const outcome = tool.run(forge, args);
    if (!outcome.ok) {
      return {
        status: 200,
        body: rpcResult(id, {
          content: [{ type: 'text', text: outcome.message }],
          isError: true,
        }),
      };
    }
    const text = JSON.stringify(outcome.value);
    return {
      status: 200,
      body: rpcResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.value,
        isError: false,
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
