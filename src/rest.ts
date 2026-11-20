// rest.ts — GitHub REST v3 surface: repos, contents, issues, pulls, labels,
// comments, branches, commits, git refs/objects, users. Every reply is JSON
// with a non-empty X-GitHub-Request-Id. No token -> 401; another owner's repo -> 404.

import { buildCommit, buildTree, parseCommit, parseTree, isObjectId, type GitObject } from './gitproto.ts';
import { VIEWER_LOGIN, type Forge, type Issue, type Pull, type Repo } from './store.ts';

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3 (decoded). */
  segments: string[];
  query: URLSearchParams;
  /** Raw request body bytes (may be empty). */
  body: Buffer;
  /** Authorization: Bearer <token> value, or null. */
  token: string | null;
  /** The request id for the X-GitHub-Request-Id header. */
  requestId: string;
  /** The entry's origin (scheme + host + port) for absolute Link URLs. */
  origin: string;
}

export interface RestResult {
  status: number;
  body: unknown;
  /** Extra headers (Link for pagination). */
  headers?: Record<string, string>;
}

export interface RestContext {
  forge: Forge;
  token: string;
}

function json(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function parseJsonBody(req: RestRequest): { ok: true; value: unknown } | { ok: false; result: RestResult } {
  if (req.body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(req.body.toString('utf8')) };
  } catch {
    return { ok: false, result: err(400, 'Problems parsing JSON') };
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Parse a positive integer query param with a default and a cap. */
function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** Paginate a list; returns the page and a Link header value (or null).
 * `baseUrl` is an absolute URL (origin + path) so Link rel="next" stays on the entry's origin. */
function paginate<T>(items: readonly T[], page: number, perPage: number, baseUrl: string, extra: Record<string, string>): { page: T[]; link: string | null } {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const q = new URLSearchParams(extra);
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(q);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `${baseUrl}?${params.toString()}`;
  };
  if (page < pages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(pages)}>; rel="last"`);
  return { page: [...slice], link: links.length ? links.join(', ') : null };
}

function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

// ---------------------------------------------------------------- shapes

function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: `U_${id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, repo.owner === VIEWER_LOGIN ? 1000 : 1001),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((i) => i.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: { id: number; name: string; color: string; description: string }, repo: Repo): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: true,
    description: label.description,
  };
}

function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    user: userJson(issue.user, 1000),
    labels: issue.labels.map((name) => {
      const found = repo.labels.find((l) => l.name === name);
      return found !== undefined
        ? labelJson(found, repo)
        : { id: 0, node_id: `L_0`, url: '', name, color: 'ededed', default: false, description: '' };
    }),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    body: issue.body,
    reactions: { url: '', total_count: 0, '+1': 0, '-1': 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0 },
    timeline_url: '',
    performed_via_github_app: null,
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `P_${pull.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    diff_url: '',
    patch_url: '',
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(pull.user, 1000),
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: '',
    review_comments_url: '',
    review_comment_url: '',
    comments_url: '',
    statuses_url: '',
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: userJson(repo.owner, 1000), repo: repoJson(forge, repo) },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: userJson(repo.owner, 1000), repo: repoJson(forge, repo) },
    _links: {},
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    merged: pull.merged,
    mergeable: pull.state === 'open',
    rebaseable: pull.state === 'open',
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    merged_by: pull.merged ? userJson(pull.user, 1000) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

/** All files in a tree, recursively, as path -> blob oid. */
function treeFiles(repo: Repo, treeOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (oid: string, prefix: string): void => {
    const tree = repo.objects.get(oid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const e of parseTree(tree.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, e.oid);
    }
  };
  walk(treeOid, '');
  return out;
}

/** Commits reachable from a tip, newest first (by traversal order). */
function commitsFrom(repo: Repo, tip: string | undefined): Array<{ sha: string; commit: GitObject }> {
  const out: Array<{ sha: string; commit: GitObject }> = [];
  if (tip === undefined) return out;
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push({ sha: oid, commit: obj });
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- auth + repo lookup

function requireAuth(ctx: RestContext, req: RestRequest): RestResult | null {
  if (req.token === null || req.token === '') return err(401, 'Requires authentication');
  if (req.token !== ctx.token) return err(401, 'Bad credentials');
  return null;
}

function getRepoOr404(ctx: RestContext, owner: string, name: string): { repo: Repo } | { result: RestResult } {
  const repo = ctx.forge.getRepo(owner, name);
  if (repo === undefined) return { result: err(404, 'Not Found') };
  if (repo.owner !== owner) return { result: err(404, 'Not Found') };
  return { repo };
}

// ---------------------------------------------------------------- router

export async function handleRest(ctx: RestContext, req: RestRequest): Promise<RestResult> {
  const seg = req.segments;
  // Root and meta do not need a repo.
  if (seg.length === 0) {
    const auth = requireAuth(ctx, req);
    if (auth !== null) return auth;
    return json(200, { current_user_url: '/api/v3/user', authorizations_url: '/api/v3/authorizations' }, { 'x-oauth-scopes': 'repo, read:user' });
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    const auth = requireAuth(ctx, req);
    if (auth !== null) return auth;
    return json(200, { verifiable_password_authentication: true, installed_version: '1.0.0', git_host: 'github.com' });
  }
  // All other routes require auth.
  const auth = requireAuth(ctx, req);
  if (auth !== null) return auth;

  if (seg[0] === 'user') {
    return handleUser(ctx, req, seg.slice(1));
  }
  if (seg[0] === 'users' && seg.length === 2) {
    const user = ctx.forge.getUser(seg[1]);
    if (user === undefined) return err(404, 'Not Found');
    return json(200, userJson(user.login, user.id));
  }
  if (seg[0] === 'repos' && seg.length >= 2) {
    return handleRepo(ctx, req, seg[1], seg[2], seg.slice(3));
  }
  return err(404, 'Not Found');
}

function handleUser(ctx: RestContext, req: RestRequest, seg: string[]): RestResult {
  if (seg.length === 0) {
    if (req.method !== 'GET') return err(404, 'Not Found');
    const viewer = ctx.forge.viewer();
    return json(200, {
      ...userJson(viewer.login, viewer.id),
      name: viewer.name,
      email: viewer.email,
      public_repos: ctx.forge.listRepos(viewer.login).length,
      followers: 0,
      following: 0,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: ctx.forge.nowIso(),
    });
  }
  if (seg[0] === 'repos') {
    if (req.method === 'POST') return createRepo(ctx, req);
    if (req.method === 'GET') return listUserRepos(ctx, req);
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

function createRepo(ctx: RestContext, req: RestRequest): RestResult {
  const parsed = parseJsonBody(req);
  if (!parsed.ok) return parsed.result;
  const body = asObject(parsed.value);
  if (body === null) return err(400, 'Problems parsing JSON');
  const name = str(body.name);
  if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    return err(422, 'Validation Failed: name is invalid');
  }
  if (ctx.forge.getRepo(VIEWER_LOGIN, name) !== undefined) {
    return err(422, 'Validation Failed: name already exists on this account');
  }
  const repo = ctx.forge.createRepo(VIEWER_LOGIN, name, {
    description: str(body.description),
    private: bool(body.private, false),
  });
  return json(201, repoJson(ctx.forge, repo));
}

function listUserRepos(ctx: RestContext, req: RestRequest): RestResult {
  const { page, perPage } = pageParams(req.query);
  const repos = ctx.forge.listRepos(VIEWER_LOGIN);
  const { page: items, link } = paginate(
    repos,
    page,
    perPage,
    `${req.origin}/api/v3/user/repos`,
    Object.fromEntries([...req.query.entries()].filter(([k]) => k !== 'page' && k !== 'per_page')),
  );
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  return json(200, items.map((r) => repoJson(ctx.forge, r)), headers);
}

function handleRepo(ctx: RestContext, req: RestRequest, owner: string, name: string, seg: string[]): RestResult {
  const found = getRepoOr404(ctx, owner, name);
  if ('result' in found) return found.result;
  const repo = found.repo;
  if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');

  if (seg.length === 0) {
    if (req.method === 'GET') return json(200, repoJson(ctx.forge, repo));
    if (req.method === 'PATCH') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return parsed.result;
      const body = asObject(parsed.value);
      if (body === null) return err(400, 'Problems parsing JSON');
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      ctx.forge.bump(repo);
      return json(200, repoJson(ctx.forge, repo));
    }
    if (req.method === 'DELETE') {
      ctx.forge.repos.delete(ctx.forge.repoKey(owner, name));
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  switch (seg[0]) {
    case 'branches':
      return handleBranches(ctx, req, repo);
    case 'commits':
      return handleCommits(ctx, req, repo, seg.slice(1));
    case 'contents':
      return handleContents(ctx, req, repo, seg.slice(1));
    case 'git':
      return handleGit(ctx, req, repo, seg.slice(1));
    case 'issues':
      return handleIssues(ctx, req, repo, seg.slice(1));
    case 'labels':
      return handleLabels(ctx, req, repo, seg.slice(1));
    case 'pulls':
      return handlePulls(ctx, req, repo, seg.slice(1));
    default:
      return err(404, 'Not Found');
  }
}

function handleBranches(ctx: RestContext, req: RestRequest, repo: Repo): RestResult {
  if (req.method !== 'GET') return err(404, 'Not Found');
  const branches = [...repo.refs.entries()]
    .filter(([name]) => name.startsWith('refs/heads/'))
    .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid, url: '' }, protected: false }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return json(200, branches);
}

function handleCommits(ctx: RestContext, req: RestRequest, repo: Repo, seg: string[]): RestResult {
  if (req.method !== 'GET' || seg.length > 0) return err(404, 'Not Found');
  const ref = req.query.get('sha') ?? repo.defaultBranch;
  const tip = ctx.forge.resolveRef(repo, ref);
  const list = commitsFrom(repo, tip);
  const { page, perPage } = pageParams(req.query);
  const { page: items, link } = paginate(list, page, perPage, `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/commits`, { sha: ref });
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  return json(200, items.map(({ sha, commit }) => {
    const view = parseCommit(commit.data);
    return {
      sha,
      node_id: `C_${sha}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
      commit: {
        // The stored commit message ends with a newline (git convention); the
        // REST view reports it without the trailing newline.
        message: view.message.replace(/\n$/, ''),
        author: { name: view.author, email: '', date: repo.createdAt },
        committer: { name: view.committer, email: '', date: repo.createdAt },
        tree: { sha: view.tree, url: '' },
      },
      author: userJson(VIEWER_LOGIN, 1000),
      committer: userJson(VIEWER_LOGIN, 1000),
      parents: view.parents.map((p) => ({ sha: p, url: '' })),
    };
  }), headers);
}

function handleContents(ctx: RestContext, req: RestRequest, repo: Repo, seg: string[]): RestResult {
  const path = seg.map((s) => decodeURIComponent(s)).join('/');
  if (path === '') return err(404, 'Not Found');
  const refName = req.query.get('ref') ?? repo.defaultBranch;
  const tip = ctx.forge.resolveRef(repo, refName);
  if (req.method === 'GET') {
    if (tip === undefined) return err(404, 'Not Found');
    const found = ctx.forge.readPathAtCommit(repo, tip, path);
    if (found !== undefined) {
      if (found.type === 'tree') {
        const entries = ctx.forge.listDirAtCommit(repo, tip, path);
        if (entries === undefined) return err(404, 'Not Found');
        return json(200, entries.map((e) => ({
          type: e.type,
          name: e.name,
          path,
          sha: e.oid,
          size: 0,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
          html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${refName}/${path}`,
          download_url: null,
        })));
      }
      const blob = repo.objects.get(found.oid);
      if (blob === undefined) return err(404, 'Not Found');
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: b64encode(blob.data),
        sha: found.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${refName}/${path}`,
        download_url: null,
        _links: {},
      });
    }
    // Maybe a directory.
    const entries = ctx.forge.listDirAtCommit(repo, tip, path);
    if (entries === undefined) return err(404, 'Not Found');
    return json(200, entries.map((e) => ({
      type: e.type,
      name: e.name,
      path: `${path}/${e.name}`,
      sha: e.oid,
      size: 0,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}/${e.name}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${refName}/${path}/${e.name}`,
      download_url: null,
    })));
  }
  if (req.method === 'PUT') {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.result;
    const body = asObject(parsed.value);
    if (body === null) return err(400, 'Problems parsing JSON');
    const message = str(body.message);
    const contentB64 = str(body.content);
    if (message === '' || contentB64 === '') return err(422, 'Validation Failed: message and content are required');
    let content: Buffer;
    try {
      content = b64decode(contentB64);
    } catch {
      return err(422, 'Validation Failed: content is not valid base64');
    }
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const expectedSha = typeof body.sha === 'string' && body.sha !== '' ? body.sha : undefined;
    const result = ctx.forge.commitFile(repo, { branch, path, content, message, expectedSha });
    if ('error' in result) return err(result.status, result.error);
    return json(result.isUpdate ? 200 : 201, {
      content: { name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: content.length, url: '', html_url: '', download_url: null, type: 'file', encoding: 'base64' },
      commit: { sha: result.commitSha, node_id: `C_${result.commitSha}`, url: '', html_url: '', message },
    });
  }
  if (req.method === 'DELETE') {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.result;
    const body = asObject(parsed.value);
    if (body === null) return err(400, 'Problems parsing JSON');
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const sha = str(body.sha);
    const refName2 = `refs/heads/${branch}`;
    const tip2 = repo.refs.get(refName2);
    if (tip2 === undefined) return err(404, 'Not Found');
    const found = ctx.forge.readPathAtCommit(repo, tip2, path);
    if (found === undefined) return err(404, 'Not Found');
    if (sha !== '' && found.oid !== sha) return err(422, 'Validation Failed: sha does not match');
    // Commit a tree without the file.
    const commit = repo.objects.get(tip2);
    if (commit === undefined || commit.type !== 'commit') return err(422, 'Validation Failed');
    const treeOid = parseCommit(commit.data).tree;
    const newTree = removePathFromTree(ctx.forge, repo, treeOid, path);
    if (newTree === null) return err(422, 'Validation Failed');
    ctx.forge.tick();
    const ts = ctx.forge.nowSec();
    const author = `${'Ada Iversen'} <${'adaiversen@example.invalid'}>`;
    const data = buildCommit({
      tree: newTree,
      parents: [tip2],
      message: `${str(body.message) || 'Delete file'}\n`,
      author,
      timestamp: ts,
    });
    const commitOid = ctx.forge.putObject(repo, 'commit', data);
    repo.refs.set(refName2, commitOid);
    repo.pushedAt = ctx.forge.nowIso();
    ctx.forge.bump(repo);
    return json(200, { commit: { sha: commitOid, node_id: `C_${commitOid}`, url: '', html_url: '', message: str(body.message) } });
  }
  return err(404, 'Not Found');
}

function removePathFromTree(forge: Forge, repo: Repo, treeOid: string, path: string): string | null {
  const segments = path.split('/').filter((s) => s !== '');
  const build = (current: string, depth: number): string | null => {
    const tree = repo.objects.get(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entries = parseTree(tree.data);
    const name = segments[depth];
    const isLast = depth === segments.length - 1;
    const next = entries.filter((e) => e.name !== name);
    if (!isLast) {
      const child = entries.find((e) => e.name === name);
      if (child === undefined || child.mode !== '40000') return null;
      const rebuilt = build(child.oid, depth + 1);
      if (rebuilt === null) return null;
      next.push({ mode: '40000', name, oid: rebuilt });
    }
    return forge.putObject(repo, 'tree', buildTree(next));
  };
  return build(treeOid, 0);
}

function handleGit(ctx: RestContext, req: RestRequest, repo: Repo, seg: string[]): RestResult {
  if (seg[0] === 'refs' && req.method === 'POST' && seg.length === 1) {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.result;
    const body = asObject(parsed.value);
    if (body === null) return err(400, 'Problems parsing JSON');
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/') || !isObjectId(sha)) return err(422, 'Validation Failed: ref and sha are required');
    if (repo.objects.get(sha) === undefined) return err(422, 'Validation Failed: object does not exist');
    if (repo.refs.has(ref)) return err(422, 'Validation Failed: reference already exists');
    repo.refs.set(ref, sha);
    ctx.forge.bump(repo);
    return json(201, { ref, node_id: `R_${ref}`, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.slice(5)}`, object: { sha, type: 'commit', url: '' } });
  }
  if (seg[0] === 'refs' && req.method === 'GET') {
    const refName = seg.slice(1).join('/');
    const full = refName.startsWith('refs/') ? refName : `refs/${refName}`;
    const oid = repo.refs.get(full);
    if (oid === undefined) return err(404, 'Not Found');
    return json(200, { ref: full, node_id: `R_${full}`, url: '', object: { sha: oid, type: 'commit', url: '' } });
  }
  if (seg[0] === 'commits' && req.method === 'GET' && seg.length === 2) {
    const obj = repo.objects.get(seg[1]);
    if (obj === undefined || obj.type !== 'commit') return err(404, 'Not Found');
    const view = parseCommit(obj.data);
    return json(200, {
      sha: seg[1],
      node_id: `C_${seg[1]}`,
      url: '',
      html_url: '',
      message: view.message,
      tree: { sha: view.tree, url: '' },
      parents: view.parents.map((p) => ({ sha: p, url: '' })),
      author: { name: view.author, email: '', date: repo.createdAt },
      committer: { name: view.committer, email: '', date: repo.createdAt },
    });
  }
  if (seg[0] === 'trees' && req.method === 'GET' && seg.length === 2) {
    const obj = repo.objects.get(seg[1]);
    if (obj === undefined || obj.type !== 'tree') return err(404, 'Not Found');
    return json(200, {
      sha: seg[1],
      url: '',
      tree: parseTree(obj.data).map((e) => ({
        path: e.name,
        mode: e.mode,
        type: e.mode === '40000' ? 'tree' : 'blob',
        sha: e.oid,
        size: e.mode === '40000' ? undefined : 0,
        url: '',
      })),
      truncated: false,
    });
  }
  if (seg[0] === 'blobs' && req.method === 'GET' && seg.length === 2) {
    const obj = repo.objects.get(seg[1]);
    if (obj === undefined || obj.type !== 'blob') return err(404, 'Not Found');
    return json(200, { sha: seg[1], url: '', content: b64encode(obj.data), encoding: 'base64', size: obj.data.length });
  }
  return err(404, 'Not Found');
}

function handleLabels(ctx: RestContext, req: RestRequest, repo: Repo, seg: string[]): RestResult {
  if (seg.length === 0 && req.method === 'GET') {
    return json(200, repo.labels.map((l) => labelJson(l, repo)));
  }
  if (seg.length === 0 && req.method === 'POST') {
    const parsed = parseJsonBody(req);
    if (!parsed.ok) return parsed.result;
    const body = asObject(parsed.value);
    if (body === null) return err(400, 'Problems parsing JSON');
    const name = str(body.name);
    if (name === '') return err(422, 'Validation Failed: name is required');
    const existing = repo.labels.find((l) => l.name === name);
    if (existing !== undefined) return json(201, labelJson(existing, repo));
    const label = { id: repo.nextLabelId++, name, color: str(body.color) || 'ededed', description: str(body.description) };
    repo.labels.push(label);
    ctx.forge.bump(repo);
    return json(201, labelJson(label, repo));
  }
  return err(404, 'Not Found');
}

function handleIssues(ctx: RestContext, req: RestRequest, repo: Repo, seg: string[]): RestResult {
  if (seg.length === 0) {
    if (req.method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return parsed.result;
      const body = asObject(parsed.value);
      if (body === null) return err(400, 'Problems parsing JSON');
      const title = str(body.title);
      if (title === '') return err(422, 'Validation Failed: title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.some((l) => l.name === label)) {
          return err(422, `Validation Failed: label "${label}" does not exist`);
        }
      }
      const issue = ctx.forge.createIssue(repo, { title, body: str(body.body), labels });
      return json(201, issueJson(ctx.forge, repo, issue));
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      const labelFilter = req.query.get('labels');
      if (labelFilter !== null && labelFilter !== '') {
        const wanted = labelFilter.split(',');
        list = list.filter((i) => wanted.every((w) => i.labels.includes(w)));
      }
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      const { page, perPage } = pageParams(req.query);
      const { page: items, link } = paginate(list, page, perPage, `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues`, {
        state,
        sort,
        direction,
      });
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return json(200, items.map((i) => issueJson(ctx.forge, repo, i)), headers);
    }
    return err(404, 'Not Found');
  }
  const number = parseInt(seg[0], 10);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const issue = ctx.forge.getIssue(repo, number);
  if (issue === undefined) return err(404, 'Not Found');
  if (seg.length === 1) {
    if (req.method === 'GET') return json(200, issueJson(ctx.forge, repo, issue));
    if (req.method === 'PATCH') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return parsed.result;
      const body = asObject(parsed.value);
      if (body === null) return err(400, 'Problems parsing JSON');
      if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
        issue.state = body.state;
        issue.updatedAt = ctx.forge.nowIso();
      }
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((l): l is string => typeof l === 'string');
        for (const label of labels) {
          if (!repo.labels.some((l) => l.name === label)) return err(422, `Validation Failed: label "${label}" does not exist`);
        }
        issue.labels = labels;
      }
      ctx.forge.bump(repo);
      return json(200, issueJson(ctx.forge, repo, issue));
    }
    return err(404, 'Not Found');
  }
  if (seg[1] === 'comments') {
    if (req.method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return parsed.result;
      const body = asObject(parsed.value);
      if (body === null) return err(400, 'Problems parsing JSON');
      const text = str(body.body);
      if (text === '') return err(422, 'Validation Failed: body is required');
      const comment = ctx.forge.createComment(repo, issue, text);
      return json(201, {
        id: comment.id,
        node_id: `M_${comment.id}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
        html_url: '',
        body: comment.body,
        user: userJson(comment.user, 1000),
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
      });
    }
    if (req.method === 'GET') {
      return json(200, issue.comments.map((c) => ({
        id: c.id,
        node_id: `M_${c.id}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
        html_url: '',
        body: c.body,
        user: userJson(c.user, 1000),
        created_at: c.createdAt,
        updated_at: c.updatedAt,
      })));
    }
    return err(404, 'Not Found');
  }
  return err(404, 'Not Found');
}

function handlePulls(ctx: RestContext, req: RestRequest, repo: Repo, seg: string[]): RestResult {
  if (seg.length === 0) {
    if (req.method === 'POST') {
      const parsed = parseJsonBody(req);
      if (!parsed.ok) return parsed.result;
      const body = asObject(parsed.value);
      if (body === null) return err(400, 'Problems parsing JSON');
      const title = str(body.title);
      const head = str(body.head);
      const base = str(body.base);
      if (title === '' || head === '' || base === '') return err(422, 'Validation Failed: title, head and base are required');
      const result = ctx.forge.createPull(repo, { title, body: str(body.body), head, base });
      if ('error' in result) return err(422, result.error);
      return json(201, pullJson(ctx.forge, repo, result));
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      const { page, perPage } = pageParams(req.query);
      const { page: items, link } = paginate(list, page, perPage, `${req.origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls`, { state });
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      return json(200, items.map((p) => pullJson(ctx.forge, repo, p)), headers);
    }
    return err(404, 'Not Found');
  }
  const number = parseInt(seg[0], 10);
  if (!Number.isInteger(number) || number < 1) return err(404, 'Not Found');
  const pull = ctx.forge.getPull(repo, number);
  if (pull === undefined) return err(404, 'Not Found');
  if (seg.length === 1) {
    if (req.method === 'GET') return json(200, pullJson(ctx.forge, repo, pull));
    return err(404, 'Not Found');
  }
  if (seg[1] === 'files' && req.method === 'GET') {
    return json(200, pullFiles(ctx.forge, repo, pull));
  }
  if (seg[1] === 'merge' && req.method === 'PUT') {
    const result = ctx.forge.mergePull(repo, pull);
    if ('error' in result) {
      if (result.error === 'Merge conflict') {
        return err(405, result.error);
      }
      if (result.error === 'pull request is not open' || result.error === 'pull request is already merged') {
        return err(405, result.error);
      }
      return err(409, result.error);
    }
    return json(200, { merged: true, sha: result.mergeCommitSha, message: 'Pull Request successfully merged' });
  }
  return err(404, 'Not Found');
}

/** Files changed between a pull's base and head. */
function pullFiles(forge: Forge, repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const baseTip = forge.refCommitOid(repo, pull.baseRef);
  const headTip = forge.refCommitOid(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return [];
  const baseCommit = repo.objects.get(baseTip);
  const headCommit = repo.objects.get(headTip);
  if (baseCommit === undefined || headCommit === undefined) return [];
  const baseFiles = treeFiles(repo, parseCommit(baseCommit.data).tree);
  const headFiles = treeFiles(repo, parseCommit(headCommit.data).tree);
  const out: Array<Record<string, unknown>> = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const inBase = baseFiles.get(path);
    const inHead = headFiles.get(path);
    if (inBase === inHead) continue;
    let status = 'modified';
    let additions = 0;
    let deletions = 0;
    if (inBase === undefined) {
      status = 'added';
      additions = countLines(repo, inHead);
    } else if (inHead === undefined) {
      status = 'removed';
      deletions = countLines(repo, inBase);
    } else {
      additions = countLines(repo, inHead);
      deletions = countLines(repo, inBase);
    }
    out.push({
      sha: inHead ?? inBase,
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
      patch: '',
    });
  }
  return out;
}

function countLines(repo: Repo, oid: string | undefined): number {
  if (oid === undefined) return 0;
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'blob') return 0;
  const text = obj.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length;
}
