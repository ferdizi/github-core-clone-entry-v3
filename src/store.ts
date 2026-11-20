// store.ts — the forge's in-memory state and deterministic logical clock.
// No Date.now(), no Math.random() in state: every timestamp comes from a
// monotonically increasing sequence over a fixed epoch, so two runs of the
// same operation sequence produce byte-identical responses.

import { buildCommit, buildTree, hashObject, parseCommit, parseTag, parseTree, type GitObject, type GitObjectType, isObjectId } from './gitproto.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'Ada Iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** Fixed epoch (2025-01-01T00:00:00Z) for the logical clock. */
export const EPOCH = 1735689600;

/** The token the suite presents (MAKEFUN_SHOP_TOKEN in a trial). */
export const SHOP_TOKEN_ENV = 'MAKEFUN_SHOP_TOKEN';

export interface User {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
  readonly type: 'User' | 'Organization';
  readonly avatarUrl: string;
}

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Comment {
  readonly id: number;
  readonly issueNumber: number;
  readonly body: string;
  readonly user: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Pull {
  readonly id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  /** ref name -> tip oid. */
  readonly refs: Map<string, string>;
  /** oid -> object. */
  readonly objects: Map<string, GitObject>;
  /** Annotated tag name -> tag object oid (refs/tags/<name> points here too). */
  readonly tags: Map<string, string>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  readonly labels: Label[];
  /** Next issue/PR number for this repo. */
  nextNumber: number;
  nextIssueId: number;
  nextPullId: number;
  nextCommentId: number;
  nextLabelId: number;
  /** Monotonic version, bumped on every mutation (for response caching). */
  version: number;
  /** Cached issue-list bodies keyed by query, invalidated by version. */
  issueBodyCache: Map<string, { version: number; body: Buffer }>;
}

export const DEFAULT_LABELS: ReadonlyArray<{ name: string; color: string; description: string }> = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
];

export class Forge {
  /** Logical clock: increments on every state-changing operation. */
  private seq = 0;
  private nextRepoId = 5000;
  private nextUserId = 1000;
  private nextGlobalIssueId = 100000;
  private nextGlobalPullId = 200000;
  private nextGlobalCommentId = 300000;
  private nextGlobalLabelId = 400000;

  readonly repos = new Map<string, Repo>(); // "owner/name" -> Repo
  readonly users = new Map<string, User>();

  constructor() {
    this.users.set(VIEWER_LOGIN, {
      id: VIEWER_ID,
      login: VIEWER_LOGIN,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
      avatarUrl: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
    });
  }

  /** Advance the clock and return the new sequence number. */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Current logical time as ISO 8601 (epoch + seq seconds). */
  nowIso(): string {
    return new Date((EPOCH + this.seq) * 1000).toISOString();
  }

  /** Current logical time as Unix seconds. */
  nowSec(): number {
    return EPOCH + this.seq;
  }

  viewer(): User {
    return this.users.get(VIEWER_LOGIN)!;
  }

  getUser(login: string): User | undefined {
    return this.users.get(login);
  }

  ensureUser(login: string): User {
    const existing = this.users.get(login);
    if (existing) return existing;
    const user: User = {
      id: this.nextUserId++,
      login,
      name: login,
      email: `${login}@example.invalid`,
      type: 'User',
      avatarUrl: `https://avatars.githubusercontent.com/u/${this.nextUserId}?v=4`,
    };
    this.users.set(login, user);
    return user;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listRepos(owner?: string): Repo[] {
    const all = [...this.repos.values()];
    const filtered = owner === undefined ? all : all.filter((r) => r.owner === owner);
    return filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean }): Repo {
    this.tick();
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      pushedAt: null,
      refs: new Map(),
      objects: new Map(),
      tags: new Map(),
      issues: [],
      pulls: [],
      labels: DEFAULT_LABELS.map((l) => ({ id: this.nextGlobalLabelId++, ...l })),
      nextNumber: 1,
      nextIssueId: 1,
      nextPullId: 1,
      nextCommentId: 1,
      nextLabelId: 1000,
      version: 0,
      issueBodyCache: new Map(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  bump(repo: Repo): void {
    repo.version += 1;
    repo.updatedAt = this.nowIso();
  }

  // ---------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Resolve a ref name (full or short) to its tip oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    return repo.refs.get(full);
  }

  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  headOid(repo: Repo): string | undefined {
    return repo.refs.get(this.headRef(repo));
  }

  /** All refs sorted by name, for advertisements. */
  sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
    return [...repo.refs.entries()]
      .map(([name, oid]) => ({ name, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The commit a ref points at (following an annotated tag once). */
  refCommitOid(repo: Repo, ref: string): string | undefined {
    const oid = this.resolveRef(repo, ref);
    if (oid === undefined) return undefined;
    const obj = repo.objects.get(oid);
    if (obj === undefined) return undefined;
    if (obj.type === 'tag') {
      return parseTag(obj.data).object;
    }
    return obj.type === 'commit' ? oid : undefined;
  }

  // ---------------------------------------------------------- issues

  createIssue(repo: Repo, input: { title: string; body?: string; labels?: string[] }): Issue {
    this.tick();
    const now = this.nowIso();
    const number = repo.nextNumber++;
    const issue: Issue = {
      id: this.nextGlobalIssueId++,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...(input.labels ?? [])],
      user: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    repo.issues.push(issue);
    this.bump(repo);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    this.tick();
    const now = this.nowIso();
    const comment: Comment = {
      id: this.nextGlobalCommentId++,
      issueNumber: issue.number,
      body,
      user: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
    };
    issue.comments.push(comment);
    issue.updatedAt = now;
    this.bump(repo);
    return comment;
  }

  // ---------------------------------------------------------- pulls

  createPull(repo: Repo, input: { title: string; body?: string; head: string; base: string }): Pull | { error: string } {
    const headOid = this.refCommitOid(repo, input.head);
    const baseOid = this.refCommitOid(repo, input.base);
    if (headOid === undefined) return { error: `head ref ${input.head} not found` };
    if (baseOid === undefined) return { error: `base ref ${input.base} not found` };
    this.tick();
    const now = this.nowIso();
    const number = repo.nextNumber++;
    const pull: Pull = {
      id: this.nextGlobalPullId++,
      number,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      headRef: input.head,
      headSha: headOid,
      baseRef: input.base,
      baseSha: baseOid,
      user: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.pulls.push(pull);
    this.bump(repo);
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  /** Squash-merge a pull: create one merge commit on the base branch.
   * Returns 405-style conflict when head and base both changed the same file
   * differently since their merge-base. */
  mergePull(repo: Repo, pull: Pull): { mergeCommitSha: string } | { error: string } {
    if (pull.state !== 'open') return { error: 'pull request is not open' };
    if (pull.merged) return { error: 'pull request is already merged' };
    const baseOid = this.refCommitOid(repo, pull.baseRef);
    const headOid = this.refCommitOid(repo, pull.headRef);
    if (baseOid === undefined || headOid === undefined) return { error: 'base or head ref missing' };
    const headCommit = repo.objects.get(headOid);
    if (headCommit === undefined || headCommit.type !== 'commit') return { error: 'head is not a commit' };
    const headTree = parseCommit(headCommit.data).tree;
    // Conflict check: a path changed by both sides (vs the merge-base) with
    // different contents cannot be squash-merged.
    const baseCommit = repo.objects.get(baseOid);
    if (baseCommit !== undefined && baseCommit.type === 'commit') {
      const baseTree = parseCommit(baseCommit.data).tree;
      const mergeBase = findMergeBase(repo, headOid, baseOid);
      if (mergeBase !== undefined) {
        const mergeBaseCommit = repo.objects.get(mergeBase);
        if (mergeBaseCommit !== undefined && mergeBaseCommit.type === 'commit') {
          const ancestorTree = parseCommit(mergeBaseCommit.data).tree;
          const ancestorFiles = treeFiles(repo, ancestorTree);
          const headFiles = treeFiles(repo, headTree);
          const baseFiles = treeFiles(repo, baseTree);
          const paths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
          for (const path of paths) {
            const ancestor = ancestorFiles.get(path);
            const head = headFiles.get(path);
            const base = baseFiles.get(path);
            const headChanged = head !== ancestor;
            const baseChanged = base !== ancestor;
            if (headChanged && baseChanged && head !== base) {
              return { error: 'Merge conflict' };
            }
          }
        }
      }
    }
    this.tick();
    const ts = this.nowSec();
    const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const message = `${pull.title} (#${pull.number})\n`;
    const mergeData = buildCommit({
      tree: headTree,
      parents: [baseOid],
      message,
      author,
      timestamp: ts,
    });
    const mergeOid = this.putObject(repo, 'commit', mergeData);
    const baseRefName = pull.baseRef.startsWith('refs/') ? pull.baseRef : `refs/heads/${pull.baseRef}`;
    repo.refs.set(baseRefName, mergeOid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = mergeOid;
    pull.updatedAt = this.nowIso();
    repo.pushedAt = this.nowIso();
    this.bump(repo);
    return { mergeCommitSha: mergeOid };
  }

  // ---------------------------------------------------------- contents

  /** Read a file at a commit's tree, following path segments. Returns the blob oid. */
  readPathAtCommit(repo: Repo, commitOid: string, path: string): { oid: string; type: 'blob' | 'tree' } | undefined {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return undefined;
    const treeOid = parseCommit(commit.data).tree;
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const tree = repo.objects.get(current);
      if (tree === undefined || tree.type !== 'tree') return undefined;
      const entry = parseTree(tree.data).find((e) => e.name === segments[i]);
      if (entry === undefined) return undefined;
      if (i === segments.length - 1) {
        return { oid: entry.oid, type: entry.mode === '40000' ? 'tree' : 'blob' };
      }
      if (entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    return undefined;
  }

  /** Build a new tree with one file replaced/added, returning the new tree oid. */
  writePathAtTree(repo: Repo, treeOid: string, path: string, blobOid: string): string {
    const segments = path.split('/').filter((s) => s !== '');
    const build = (currentTreeOid: string, depth: number): string => {
      const tree = repo.objects.get(currentTreeOid);
      const entries = tree !== undefined && tree.type === 'tree' ? parseTree(tree.data) : [];
      const name = segments[depth];
      const isLast = depth === segments.length - 1;
      const next = entries.filter((e) => e.name !== name);
      if (isLast) {
        next.push({ mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.find((e) => e.name === name);
        const childTree = child !== undefined && child.mode === '40000' ? child.oid : this.putObject(repo, 'tree', Buffer.alloc(0));
        const newChild = build(childTree, depth + 1);
        next.push({ mode: '40000', name, oid: newChild });
      }
      return this.putObject(repo, 'tree', buildTree(next));
    };
    return build(treeOid, 0);
  }

  /** Commit one file on a branch (creates the branch's first commit if unborn). */
  commitFile(repo: Repo, options: {
    branch: string;
    path: string;
    content: Buffer;
    message: string;
    expectedSha?: string;
  }): { commitSha: string; contentSha: string; isUpdate: boolean } | { error: string; status: number } {
    const refName = `refs/heads/${options.branch}`;
    const currentTip = repo.refs.get(refName);
    const blobOid = this.putObject(repo, 'blob', options.content);
    if (options.expectedSha !== undefined) {
      if (currentTip === undefined) return { error: 'sha does not match', status: 409 };
      const found = this.readPathAtCommit(repo, currentTip, options.path);
      if (found === undefined || found.oid !== options.expectedSha) {
        return { error: 'sha does not match the file at that ref', status: 409 };
      }
    }
    this.tick();
    const ts = this.nowSec();
    const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    let treeOid: string;
    let parents: string[] = [];
    let isUpdate = false;
    if (currentTip !== undefined) {
      const commit = repo.objects.get(currentTip);
      if (commit === undefined || commit.type !== 'commit') return { error: 'tip is not a commit', status: 422 };
      const existing = this.readPathAtCommit(repo, currentTip, options.path);
      if (existing !== undefined) isUpdate = true;
      treeOid = this.writePathAtTree(repo, parseCommit(commit.data).tree, options.path, blobOid);
      parents = [currentTip];
    } else {
      treeOid = this.writePathAtTree(repo, this.putObject(repo, 'tree', buildTree([])), options.path, blobOid);
    }
    const commitData = buildCommit({
      tree: treeOid,
      parents,
      message: options.message.endsWith('\n') ? options.message : `${options.message}\n`,
      author,
      timestamp: ts,
    });
    const commitOid = this.putObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitOid);
    repo.pushedAt = this.nowIso();
    this.bump(repo);
    return { commitSha: commitOid, contentSha: blobOid, isUpdate };
  }

  /** List a directory at a commit. Returns entries with type file/dir. */
  listDirAtCommit(repo: Repo, commitOid: string, path: string): Array<{ name: string; type: 'file' | 'dir'; oid: string }> | undefined {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return undefined;
    let current = parseCommit(commit.data).tree;
    const segments = path.split('/').filter((s) => s !== '');
    for (const seg of segments) {
      const tree = repo.objects.get(current);
      if (tree === undefined || tree.type !== 'tree') return undefined;
      const entry = parseTree(tree.data).find((e) => e.name === seg);
      if (entry === undefined || entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    const tree = repo.objects.get(current);
    if (tree === undefined || tree.type !== 'tree') return undefined;
    return parseTree(tree.data).map((e) => ({
      name: e.name,
      type: e.mode === '40000' ? ('dir' as const) : ('file' as const),
      oid: e.oid,
    }));
  }
}

/** All files in a tree, recursively, as path -> blob oid. */
export function treeFiles(repo: Repo, treeOid: string): Map<string, string> {
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

/** The nearest common ancestor of two commits (first found by BFS from both). */
export function findMergeBase(repo: Repo, a: string, b: string): string | undefined {
  const ancestorsOf = (tip: string): Set<string> => {
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      seen.add(oid);
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return seen;
  };
  const aAncestors = ancestorsOf(a);
  const stack: string[] = [b];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (aAncestors.has(oid)) return oid;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return undefined;
}
