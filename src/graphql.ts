// graphql.ts — a small GraphQL executor for the shapes gh and github-mcp-server send:
// viewer, repository, issues, pull requests, node(id:), __type introspection, and the
// create/close/merge/comment mutations. Parses documents (variables, aliases, inline
// fragments, input objects, enums, batching) and executes them against the forge.

import { VIEWER_LOGIN, findMergeBase, type Forge, type Issue, type Pull, type Repo } from './store.ts';
import { treeFiles } from './store.ts';
import { parseCommit } from './gitproto.ts';

// ---------------------------------------------------------------- global ids (opaque, stable)

export function globalId(kind: string, parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = decoded.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', [repo.id]);
}
function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', [repo.id, issue.number]);
}
function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', [repo.id, pull.number]);
}
function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return globalId('IssueComment', [repo.id, issue.number, commentId]);
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  arguments: Map<string, Value>;
  selectionSet: Selection[] | null;
}
interface InlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selectionSet: Selection[];
}
interface FragmentSpread {
  kind: 'spread';
  name: string;
}
type Selection = FieldSelection | InlineFragment | FragmentSpread;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Map<string, { type: string; defaultValue: Value | null }>;
  selectionSet: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selectionSet: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { i += 1; continue; }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!@$=&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      // Simple string (no block strings in the documents we serve).
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`GraphQL: unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) {
      throw new Error(`GraphQL: expected "${value}", got ${tokenDesc(t)}`);
    }
  }
  private acceptPunct(value: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`GraphQL: expected a name, got ${tokenDesc(t)}`);
    return t.value;
  }
  private acceptName(value: string): boolean {
    const t = this.peek();
    if (t.kind === 'name' && t.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ type: 'query', name: null, variableDefinitions: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        operations.push(this.parseOperation());
        continue;
      }
      if (t.kind === 'name' && t.value === 'fragment') {
        const frag = this.parseFragment();
        fragments.set(frag.name, frag);
        continue;
      }
      throw new Error(`GraphQL: unexpected token ${tokenDesc(t)} at document level`);
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    const type = this.expectName() as 'query' | 'mutation';
    let name: string | null = null;
    const t = this.peek();
    if (t.kind === 'name') name = this.next().value as string;
    const variableDefinitions = this.parseVariableDefinitions();
    const selectionSet = this.parseSelectionSet();
    return { type, name, variableDefinitions, selectionSet };
  }

  private parseVariableDefinitions(): Map<string, { type: string; defaultValue: Value | null }> {
    const defs = new Map<string, { type: string; defaultValue: Value | null }>();
    if (!this.acceptPunct('(')) return defs;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: Value | null = null;
      if (this.acceptPunct('=')) defaultValue = this.parseValue();
      defs.set(name, { type, defaultValue });
    }
    return defs;
  }

  private parseType(): string {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.acceptPunct('!')) out += '!';
      return out;
    }
    const name = this.expectName();
    let out = name;
    if (this.acceptPunct('!')) out += '!';
    return out;
  }

  private parseFragment(): FragmentDef {
    this.expectName(); // fragment
    const name = this.expectName();
    if (!this.acceptName('on')) throw new Error('GraphQL: fragment needs "on"');
    const typeCondition = this.expectName();
    const selectionSet = this.parseSelectionSet();
    return { name, typeCondition, selectionSet };
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.acceptPunct('}')) {
      const t = this.peek();
      if (t.kind === 'spread') {
        this.next();
        const next = this.peek();
        if (next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else if (next.kind === 'name') {
          selections.push({ kind: 'spread', name: this.next().value as string });
        } else if (next.kind === 'punct' && next.value === '{') {
          selections.push({ kind: 'inline', typeCondition: null, selectionSet: this.parseSelectionSet() });
        } else {
          throw new Error(`GraphQL: bad fragment spread ${tokenDesc(next)}`);
        }
        continue;
      }
      if (t.kind === 'name') {
        const first = this.next().value as string;
        let alias: string | null = null;
        let name = first;
        if (this.acceptPunct(':')) {
          alias = first;
          name = this.expectName();
        }
        const args = this.parseArguments();
        let selectionSet: Selection[] | null = null;
        if (this.peek().kind === 'punct' && this.peek().value === '{') {
          selectionSet = this.parseSelectionSet();
        }
        selections.push({ kind: 'field', alias, name, arguments: args, selectionSet });
        continue;
      }
      throw new Error(`GraphQL: unexpected token ${tokenDesc(t)} in selection set`);
    }
    return selections;
  }

  private parseArguments(): Map<string, Value> {
    const args = new Map<string, Value>();
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.set(name, this.parseValue());
    }
    return args;
  }

  private parseValue(): Value {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const values: Value[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields = new Map<string, Value>();
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue());
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`GraphQL: unexpected value token ${tokenDesc(t)}`);
  }
}

function tokenDesc(t: Token): string {
  if (t.kind === 'eof') return 'EOF';
  if (t.kind === 'spread') return '...';
  return `${t.kind} ${JSON.stringify((t as { value?: string }).value ?? '')}`;
}

export function parseGraphQL(source: string): Document {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------- execution

export interface GraphQLContext {
  forge: Forge;
}

type AnyRecord = Record<string, unknown>;

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': {
      const v = variables[value.name];
      return v === undefined ? null : v;
    }
    case 'string': return value.value;
    case 'int': return value.value;
    case 'float': return value.value;
    case 'boolean': return value.value;
    case 'null': return null;
    case 'enum': return value.value;
    case 'list': return value.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: AnyRecord = {};
      for (const [k, v] of value.fields) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

function argsOf(field: FieldSelection, variables: Record<string, unknown>): AnyRecord {
  const out: AnyRecord = {};
  for (const [k, v] of field.arguments) out[k] = resolveValue(v, variables);
  return out;
}

interface ExecState {
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentDef>;
  variables: Record<string, unknown>;
}

function fieldError(state: ExecState, message: string): void {
  state.errors.push({ message });
}

/** Resolve a selection set against an object value. Returns the result object. */
function executeSelectionSet(
  ctx: GraphQLContext,
  state: ExecState,
  parent: AnyRecord,
  parentType: string,
  selections: Selection[],
): AnyRecord {
  const out: AnyRecord = {};
  for (const sel of selections) {
    if (sel.kind === 'spread') {
      const frag = state.fragments.get(sel.name);
      if (frag === undefined) {
        fieldError(state, `Unknown fragment "${sel.name}"`);
        continue;
      }
      const sub = executeSelectionSet(ctx, state, parent, parentType, frag.selectionSet);
      Object.assign(out, sub);
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition !== null && sel.typeCondition !== parentType) continue;
      const sub = executeSelectionSet(ctx, state, parent, parentType, sel.selectionSet);
      Object.assign(out, sub);
      continue;
    }
    const responseKey = sel.alias ?? sel.name;
    const value = resolveField(ctx, state, parent, parentType, sel);
    if (value === undefined) {
      // Unknown field: record an error and set null.
      fieldError(state, `Cannot query field "${sel.name}" on type "${parentType}".`);
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

/** Resolve one field. Returns undefined when the field does not exist on the type. */
function resolveField(
  ctx: GraphQLContext,
  state: ExecState,
  parent: AnyRecord,
  parentType: string,
  field: FieldSelection,
): unknown {
  const args = argsOf(field, state.variables);
  const sub = field.selectionSet;
  const runSub = (value: AnyRecord, type: string): AnyRecord => {
    if (sub === null) return value;
    return executeSelectionSet(ctx, state, value, type, sub);
  };

  if (parentType === 'Query') {
    if (field.name === 'viewer') {
      const viewer = { login: VIEWER_LOGIN, __typename: 'User' };
      return sub === null ? viewer : runSub(viewer, 'User');
    }
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = ctx.forge.getRepo(owner, name);
      if (repo === undefined) return null;
      return sub === null ? repoRecord(ctx, repo) : runSub(repoRecord(ctx, repo), 'Repository');
    }
    if (field.name === 'node') {
      const id = String(args.id ?? '');
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repoId = parseInt(parsed.parts[0] ?? '', 10);
        const repo = [...ctx.forge.repos.values()].find((r) => r.id === repoId);
        if (repo === undefined) return null;
        return sub === null ? repoRecord(ctx, repo) : runSub(repoRecord(ctx, repo), 'Repository');
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      const type = introspectionType(name);
      if (type === null) return null;
      return sub === null ? type : runSub(type as unknown as AnyRecord, '__Type');
    }
    if (field.name === '__schema') {
      return sub === null ? { __typename: '__Schema' } : runSub({ __typename: '__Schema' }, '__Schema');
    }
    return undefined;
  }

  if (parentType === 'Mutation') {
    return resolveMutation(ctx, state, field, args, sub);
  }

  if (parentType === 'Repository') {
    const repo = parent.__repo as Repo | undefined;
    if (repo === undefined) return undefined;
    return resolveRepositoryField(ctx, state, repo, parent, field, args, sub, runSub);
  }

  if (parentType === 'Issue') {
    const issue = parent.__issue as Issue | undefined;
    const repo = parent.__repo as Repo | undefined;
    if (issue === undefined || repo === undefined) return undefined;
    if (field.name === 'id') return issueGlobalId(repo, issue);
    if (field.name === 'number') return issue.number;
    if (field.name === 'title') return issue.title;
    if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'body') return issue.body;
    if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
    if (field.name === 'createdAt') return issue.createdAt;
    if (field.name === 'updatedAt') return issue.updatedAt;
    if (field.name === 'closedAt') return issue.state === 'closed' ? issue.updatedAt : null;
    if (field.name === 'author') {
      const author = { login: issue.user, __typename: 'User' };
      return sub === null ? author : runSub(author, 'User');
    }
    if (field.name === 'labels') {
      const nodes = issue.labels.map((name) => ({ name, __typename: 'Label' }));
      return sub === null ? { nodes } : runSub({ nodes }, 'LabelConnection');
    }
    if (field.name === 'comments') {
      const nodes = issue.comments.map((c) => ({ id: commentGlobalId(repo, issue, c.id), body: c.body, __typename: 'IssueComment' }));
      return sub === null ? { nodes } : runSub({ nodes }, 'IssueCommentConnection');
    }
    return undefined;
  }

  if (parentType === 'PullRequest') {
    const pull = parent.__pull as Pull | undefined;
    const repo = parent.__repo as Repo | undefined;
    if (pull === undefined || repo === undefined) return undefined;
    if (field.name === 'id') return pullGlobalId(repo, pull);
    if (field.name === 'number') return pull.number;
    if (field.name === 'title') return pull.title;
    if (field.name === 'body') return pull.body;
    if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'merged') return pull.merged;
    if (field.name === 'headRefName') return pull.headRef;
    if (field.name === 'baseRefName') return pull.baseRef;
    if (field.name === 'mergeable') return pullMergeable(ctx, repo, pull);
    if (field.name === 'headRef') {
      const ref = { name: pull.headRef, __typename: 'Ref' };
      return sub === null ? ref : runSub(ref, 'Ref');
    }
    if (field.name === 'baseRef') {
      const ref = { name: pull.baseRef, __typename: 'Ref' };
      return sub === null ? ref : runSub(ref, 'Ref');
    }
    if (field.name === 'createdAt') return pull.createdAt;
    if (field.name === 'updatedAt') return pull.updatedAt;
    if (field.name === 'closedAt') return pull.state === 'closed' ? pull.updatedAt : null;
    if (field.name === 'mergedAt') return pull.mergedAt;
    if (field.name === 'mergeCommit') {
      if (pull.mergeCommitSha === null) return null;
      const commit = { oid: pull.mergeCommitSha, __typename: 'Commit' };
      return sub === null ? commit : runSub(commit, 'Commit');
    }
    if (field.name === 'files') {
      const first = typeof args.first === 'number' ? args.first : 10;
      const files = pullChangedFiles(ctx, repo, pull).slice(0, first);
      const nodes = files.map((path) => ({ path, __typename: 'PullRequestChangedFile' }));
      return sub === null ? { nodes } : runSub({ nodes }, 'PullRequestChangedFileConnection');
    }
    if (field.name === 'author') {
      const author = { login: pull.user, __typename: 'User' };
      return sub === null ? author : runSub(author, 'User');
    }
    return undefined;
  }

  if (parentType === 'User') {
    if (field.name === 'login') return parent.login;
    if (field.name === 'id') return globalId('User', [String(parent.login ?? '')]);
    if (field.name === 'name') return parent.login;
    return undefined;
  }

  if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection' || parentType === 'PullRequestChangedFileConnection' || parentType === 'LabelConnection' || parentType === 'IssueCommentConnection') {
    if (field.name === 'nodes') {
      const nodes = (parent.nodes as AnyRecord[] | undefined) ?? [];
      if (sub === null) return nodes;
      const itemType =
        parentType === 'IssueConnection' ? 'Issue'
        : parentType === 'PullRequestConnection' ? 'PullRequest'
        : parentType === 'PullRequestChangedFileConnection' ? 'PullRequestChangedFile'
        : parentType === 'LabelConnection' ? 'Label'
        : 'IssueComment';
      return nodes.map((n) => runSub(n, itemType));
    }
    if (field.name === 'edges') {
      const nodes = (parent.nodes as AnyRecord[] | undefined) ?? [];
      if (sub === null) return nodes.map((n) => ({ node: n }));
      return nodes.map((n) => {
        const edge: AnyRecord = { node: n, cursor: '' };
        return executeSelectionSet(ctx, state, edge, `${parentType}Edge`, sub);
      });
    }
    if (field.name === 'pageInfo') {
      const pageInfo = (parent.pageInfo as AnyRecord | undefined) ?? { hasNextPage: false, endCursor: null };
      return sub === null ? pageInfo : runSub(pageInfo, 'PageInfo');
    }
    if (field.name === 'totalCount') return (parent.nodes as AnyRecord[] | undefined)?.length ?? 0;
    return undefined;
  }

  if (parentType === 'PageInfo') {
    if (field.name === 'hasNextPage') return parent.hasNextPage ?? false;
    if (field.name === 'hasPreviousPage') return parent.hasPreviousPage ?? false;
    if (field.name === 'endCursor') return parent.endCursor ?? null;
    if (field.name === 'startCursor') return parent.startCursor ?? null;
    return undefined;
  }

  if (parentType === '__Type') {
    if (field.name === 'name') return parent.name;
    if (field.name === 'kind') return parent.kind;
    if (field.name === 'fields') {
      const fields = (parent.fields as Array<{ name: string }> | undefined) ?? [];
      if (sub === null) return fields;
      return fields.map((f) => runSub({ name: f.name, __typename: '__Field' }, '__Field'));
    }
    if (field.name === 'enumValues') {
      const values = (parent.enumValues as Array<{ name: string }> | undefined) ?? [];
      if (sub === null) return values;
      return values.map((v) => runSub({ name: v.name, __typename: '__EnumValue' }, '__EnumValue'));
    }
    return undefined;
  }

  if (parentType === '__Field' || parentType === '__EnumValue') {
    if (field.name === 'name') return parent.name;
    if (field.name === 'description') return null;
    return undefined;
  }

  if (parentType === 'Ref') {
    if (field.name === 'name') return parent.name;
    if (field.name === 'target') return null;
    return undefined;
  }

  if (parentType === 'Commit') {
    if (field.name === 'oid') return parent.oid;
    if (field.name === 'message') return '';
    return undefined;
  }

  if (parentType === 'PullRequestChangedFile') {
    if (field.name === 'path') return parent.path;
    if (field.name === 'additions') return 0;
    if (field.name === 'deletions') return 0;
    if (field.name === 'changeType') return 'MODIFIED';
    return undefined;
  }

  if (parentType === 'Label') {
    if (field.name === 'name') return parent.name;
    if (field.name === 'id') return globalId('Label', [String(parent.name ?? '')]);
    if (field.name === 'color') return 'ededed';
    return undefined;
  }

  if (parentType === 'IssueComment') {
    if (field.name === 'id') return parent.id;
    if (field.name === 'body') return parent.body;
    if (field.name === 'author') {
      const author = { login: VIEWER_LOGIN, __typename: 'User' };
      return sub === null ? author : runSub(author, 'User');
    }
    return undefined;
  }

  // Mutation payloads: unwrap the nested record and resolve the sub-selection
  // against it under its own type. A null inner record stays null.
  if (parentType === 'CreateIssuePayload' || parentType === 'CloseIssuePayload') {
    if (field.name === 'issue') {
      const issue = parent.issue as AnyRecord | null | undefined;
      if (issue === null || issue === undefined) return null;
      return runSub(issue, 'Issue');
    }
    return undefined;
  }

  if (parentType === 'CreatePullRequestPayload' || parentType === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') {
      const pull = parent.pullRequest as AnyRecord | null | undefined;
      if (pull === null || pull === undefined) return null;
      return runSub(pull, 'PullRequest');
    }
    return undefined;
  }

  if (parentType === 'AddCommentPayload') {
    if (field.name === 'commentEdge') {
      const edge = parent.commentEdge as AnyRecord | null | undefined;
      if (edge === null || edge === undefined) return null;
      return runSub(edge, 'IssueCommentEdge');
    }
    return undefined;
  }

  if (parentType === 'IssueCommentEdge') {
    if (field.name === 'node') {
      const node = parent.node as AnyRecord | null | undefined;
      if (node === null || node === undefined) return null;
      return runSub(node, 'IssueComment');
    }
    if (field.name === 'cursor') return parent.cursor ?? '';
    return undefined;
  }

  return undefined;
}

function resolveRepositoryField(
  ctx: GraphQLContext,
  state: ExecState,
  repo: Repo,
  parent: AnyRecord,
  field: FieldSelection,
  args: AnyRecord,
  sub: Selection[] | null,
  runSub: (value: AnyRecord, type: string) => AnyRecord,
): unknown {
  if (field.name === 'id') return repoGlobalId(repo);
  if (field.name === 'databaseId') return repo.id;
  if (field.name === 'name') return repo.name;
  if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
  if (field.name === 'owner') {
    const owner = { login: repo.owner, __typename: 'User' };
    return sub === null ? owner : runSub(owner, 'User');
  }
  if (field.name === 'defaultBranchRef') {
    const ref = { name: repo.defaultBranch, __typename: 'Ref' };
    return sub === null ? ref : runSub(ref, 'Ref');
  }
  if (field.name === 'viewerPermission') return 'ADMIN';
  if (field.name === 'hasIssuesEnabled') return true;
  if (field.name === 'description') return repo.description;
  if (field.name === 'isPrivate') return repo.private;
  if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
  if (field.name === 'createdAt') return repo.createdAt;
  if (field.name === 'updatedAt') return repo.updatedAt;
  if (field.name === 'issue') {
    const number = Number(args.number);
    const issue = repo.issues.find((i) => i.number === number);
    if (issue === undefined) return null;
    const rec = issueRecord(repo, issue);
    return sub === null ? rec : runSub(rec, 'Issue');
  }
  if (field.name === 'issues') {
    const first = typeof args.first === 'number' ? args.first : 30;
    const after = typeof args.after === 'string' ? args.after : null;
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    const orderBy = (args.orderBy as AnyRecord | undefined) ?? {};
    const direction = String(orderBy.direction ?? 'DESC');
    const fieldName = String(orderBy.field ?? 'CREATED_AT');
    let list = [...repo.issues];
    if (states !== null) {
      const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s.toLowerCase())));
      list = list.filter((i) => wanted.has(i.state));
    }
    list.sort((a, b) => {
      if (fieldName === 'CREATED_AT' || fieldName === 'UPDATED_AT') {
        return direction === 'ASC' ? a.number - b.number : b.number - a.number;
      }
      return direction === 'ASC' ? a.number - b.number : b.number - a.number;
    });
    // Cursor: base64 of the last issue number on the previous page.
    let startIndex = 0;
    if (after !== null && after !== '') {
      try {
        const decoded = Buffer.from(after, 'base64').toString('utf8');
        const lastNumber = parseInt(decoded, 10);
        if (!Number.isNaN(lastNumber)) {
          const idx = list.findIndex((i) => i.number === lastNumber);
          if (idx >= 0) startIndex = idx + 1;
        }
      } catch {
        // Bad cursor: start from the beginning.
      }
    }
    const page = list.slice(startIndex, startIndex + first);
    const hasNextPage = startIndex + first < list.length;
    const endCursor = page.length > 0 ? Buffer.from(String(page[page.length - 1].number), 'utf8').toString('base64') : null;
    const connection: AnyRecord = {
      nodes: page.map((i) => issueRecord(repo, i)),
      pageInfo: { hasNextPage, endCursor, startCursor: page.length > 0 ? Buffer.from(String(page[0].number), 'utf8').toString('base64') : null, hasPreviousPage: startIndex > 0 },
      __typename: 'IssueConnection',
    };
    return sub === null ? connection : runSub(connection, 'IssueConnection');
  }
  if (field.name === 'pullRequests') {
    const first = typeof args.first === 'number' ? args.first : 30;
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    let list = [...repo.pulls];
    if (states !== null) {
      const wanted = new Set(states.map((s) => s.toLowerCase()));
      list = list.filter((p) => wanted.has(p.merged ? 'merged' : p.state));
    }
    list.sort((a, b) => b.number - a.number);
    const page = list.slice(0, first);
    const connection: AnyRecord = {
      nodes: page.map((p) => pullRecord(repo, p)),
      pageInfo: { hasNextPage: list.length > first, endCursor: null, startCursor: null, hasPreviousPage: false },
      __typename: 'PullRequestConnection',
    };
    return sub === null ? connection : runSub(connection, 'PullRequestConnection');
  }
  if (field.name === 'pullRequest') {
    const number = Number(args.number);
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull === undefined) return null;
    const rec = pullRecord(repo, pull);
    return sub === null ? rec : runSub(rec, 'PullRequest');
  }
  void parent;
  return undefined;
}

function resolveMutation(
  ctx: GraphQLContext,
  state: ExecState,
  field: FieldSelection,
  args: AnyRecord,
  sub: Selection[] | null,
): unknown {
  const runSub = (value: AnyRecord, type: string): AnyRecord => {
    if (sub === null) return value;
    return executeSelectionSet(ctx, state, value, type, sub);
  };
  const input = (args.input as AnyRecord | undefined) ?? {};
  if (field.name === 'createIssue') {
    const repositoryId = String(input.repositoryId ?? '');
    const parsed = parseGlobalId(repositoryId);
    if (parsed === null || parsed.kind !== 'Repository') {
      fieldError(state, `createIssue: unknown repositoryId ${JSON.stringify(repositoryId)}`);
      return runSub({ issue: null }, 'CreateIssuePayload');
    }
    const repoId = parseInt(parsed.parts[0] ?? '', 10);
    const repo = [...ctx.forge.repos.values()].find((r) => r.id === repoId);
    if (repo === undefined) {
      fieldError(state, 'createIssue: repository not found');
      return runSub({ issue: null }, 'CreateIssuePayload');
    }
    const issue = ctx.forge.createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
    const payload: AnyRecord = { issue: issueRecord(repo, issue) };
    return runSub(payload, 'CreateIssuePayload');
  }
  if (field.name === 'closeIssue') {
    const issueId = String(input.issueId ?? '');
    const parsed = parseGlobalId(issueId);
    if (parsed === null || parsed.kind !== 'Issue') {
      fieldError(state, `closeIssue: unknown issueId ${JSON.stringify(issueId)}`);
      return runSub({ issue: null }, 'CloseIssuePayload');
    }
    const repoId = parseInt(parsed.parts[0] ?? '', 10);
    const number = parseInt(parsed.parts[1] ?? '', 10);
    const repo = [...ctx.forge.repos.values()].find((r) => r.id === repoId);
    const issue = repo?.issues.find((i) => i.number === number);
    if (repo === undefined || issue === undefined) {
      fieldError(state, 'closeIssue: issue not found');
      return runSub({ issue: null }, 'CloseIssuePayload');
    }
    issue.state = 'closed';
    issue.updatedAt = ctx.forge.nowIso();
    ctx.forge.bump(repo);
    const payload: AnyRecord = { issue: issueRecord(repo, issue) };
    return runSub(payload, 'CloseIssuePayload');
  }
  if (field.name === 'createPullRequest') {
    const repositoryId = String(input.repositoryId ?? '');
    const parsed = parseGlobalId(repositoryId);
    if (parsed === null || parsed.kind !== 'Repository') {
      fieldError(state, `createPullRequest: unknown repositoryId ${JSON.stringify(repositoryId)}`);
      return runSub({ pullRequest: null }, 'CreatePullRequestPayload');
    }
    const repoId = parseInt(parsed.parts[0] ?? '', 10);
    const repo = [...ctx.forge.repos.values()].find((r) => r.id === repoId);
    if (repo === undefined) {
      fieldError(state, 'createPullRequest: repository not found');
      return runSub({ pullRequest: null }, 'CreatePullRequestPayload');
    }
    const result = ctx.forge.createPull(repo, {
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? ''),
    });
    if ('error' in result) {
      fieldError(state, `createPullRequest: ${result.error}`);
      return runSub({ pullRequest: null }, 'CreatePullRequestPayload');
    }
    const payload: AnyRecord = { pullRequest: pullRecord(repo, result) };
    return runSub(payload, 'CreatePullRequestPayload');
  }
  if (field.name === 'mergePullRequest') {
    const pullRequestId = String(input.pullRequestId ?? '');
    const parsed = parseGlobalId(pullRequestId);
    if (parsed === null || parsed.kind !== 'PullRequest') {
      fieldError(state, `mergePullRequest: unknown pullRequestId ${JSON.stringify(pullRequestId)}`);
      return runSub({ pullRequest: null }, 'MergePullRequestPayload');
    }
    const repoId = parseInt(parsed.parts[0] ?? '', 10);
    const number = parseInt(parsed.parts[1] ?? '', 10);
    const repo = [...ctx.forge.repos.values()].find((r) => r.id === repoId);
    const pull = repo?.pulls.find((p) => p.number === number);
    if (repo === undefined || pull === undefined) {
      fieldError(state, 'mergePullRequest: pull request not found');
      return runSub({ pullRequest: null }, 'MergePullRequestPayload');
    }
    const result = ctx.forge.mergePull(repo, pull);
    if ('error' in result) {
      fieldError(state, `mergePullRequest: ${result.error}`);
      return runSub({ pullRequest: pullRecord(repo, pull) }, 'MergePullRequestPayload');
    }
    const payload: AnyRecord = { pullRequest: pullRecord(repo, pull) };
    return runSub(payload, 'MergePullRequestPayload');
  }
  if (field.name === 'addComment') {
    const subjectId = String(input.subjectId ?? '');
    const parsed = parseGlobalId(subjectId);
    if (parsed === null || parsed.kind !== 'Issue') {
      fieldError(state, `addComment: unknown subjectId ${JSON.stringify(subjectId)}`);
      return runSub({ commentEdge: null }, 'AddCommentPayload');
    }
    const repoId = parseInt(parsed.parts[0] ?? '', 10);
    const number = parseInt(parsed.parts[1] ?? '', 10);
    const repo = [...ctx.forge.repos.values()].find((r) => r.id === repoId);
    const issue = repo?.issues.find((i) => i.number === number);
    if (repo === undefined || issue === undefined) {
      fieldError(state, 'addComment: issue not found');
      return runSub({ commentEdge: null }, 'AddCommentPayload');
    }
    const comment = ctx.forge.createComment(repo, issue, String(input.body ?? ''));
    const node: AnyRecord = { id: commentGlobalId(repo, issue, comment.id), body: comment.body, __typename: 'IssueComment' };
    const payload: AnyRecord = { commentEdge: { node, cursor: '' } };
    return runSub(payload, 'AddCommentPayload');
  }
  return undefined;
}

// ---------------------------------------------------------------- records

function repoRecord(_ctx: GraphQLContext, repo: Repo): AnyRecord {
  return { __repo: repo, __typename: 'Repository' };
}

function issueRecord(repo: Repo, issue: Issue): AnyRecord {
  return { __repo: repo, __issue: issue, __typename: 'Issue' };
}

function pullRecord(repo: Repo, pull: Pull): AnyRecord {
  return { __repo: repo, __pull: pull, __typename: 'PullRequest' };
}

function pullMergeable(ctx: GraphQLContext, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  // Reuse the store's conflict logic: a conflict exists when head and base both
  // changed the same path differently since their merge-base.
  const baseOid = ctx.forge.refCommitOid(repo, pull.baseRef);
  const headOid = ctx.forge.refCommitOid(repo, pull.headRef);
  if (baseOid === undefined || headOid === undefined) return 'UNKNOWN';
  const mergeBase = findMergeBase(repo, headOid, baseOid);
  if (mergeBase === undefined) return 'UNKNOWN';
  const baseCommit = repo.objects.get(baseOid);
  const headCommit = repo.objects.get(headOid);
  const mergeBaseCommit = repo.objects.get(mergeBase);
  if (baseCommit === undefined || headCommit === undefined || mergeBaseCommit === undefined) return 'UNKNOWN';
  const ancestorFiles = treeFiles(repo, parseCommit(mergeBaseCommit.data).tree);
  const headFiles = treeFiles(repo, parseCommit(headCommit.data).tree);
  const baseFiles = treeFiles(repo, parseCommit(baseCommit.data).tree);
  const paths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
  for (const path of paths) {
    const ancestor = ancestorFiles.get(path);
    const head = headFiles.get(path);
    const base = baseFiles.get(path);
    if (head !== ancestor && base !== ancestor && head !== base) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function pullChangedFiles(ctx: GraphQLContext, repo: Repo, pull: Pull): string[] {
  const baseTip = ctx.forge.refCommitOid(repo, pull.baseRef);
  const headTip = ctx.forge.refCommitOid(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return [];
  const baseCommit = repo.objects.get(baseTip);
  const headCommit = repo.objects.get(headTip);
  if (baseCommit === undefined || headCommit === undefined) return [];
  const baseFiles = treeFiles(repo, parseCommit(baseCommit.data).tree);
  const headFiles = treeFiles(repo, parseCommit(headCommit.data).tree);
  const out: string[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    if (baseFiles.get(path) !== headFiles.get(path)) out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------- introspection

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'locked', 'assignees', 'milestone', 'reactions', 'timelineUrl', 'stateReason', 'repository', 'viewerDidAuthor'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'comments', 'reviews', 'labels', 'assignees', 'milestone', 'isDraft', 'url'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt', 'homepageUrl', 'stargazerCount', 'forkCount'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

function introspectionType(name: string): AnyRecord | null {
  if (name === 'Issue') return { name: 'Issue', kind: 'OBJECT', fields: ISSUE_FIELDS.map((n) => ({ name: n })), enumValues: [], __typename: '__Type' };
  if (name === 'PullRequest') return { name: 'PullRequest', kind: 'OBJECT', fields: PULL_REQUEST_FIELDS.map((n) => ({ name: n })), enumValues: [], __typename: '__Type' };
  if (name === 'Repository') return { name: 'Repository', kind: 'OBJECT', fields: REPOSITORY_FIELDS.map((n) => ({ name: n })), enumValues: [], __typename: '__Type' };
  if (name === 'SearchType') return { name: 'SearchType', kind: 'ENUM', fields: [], enumValues: SEARCH_TYPE_VALUES.map((n) => ({ name: n })), __typename: '__Type' };
  if (name === 'User') return { name: 'User', kind: 'OBJECT', fields: [{ name: 'login' }, { name: 'id' }, { name: 'name' }], enumValues: [], __typename: '__Type' };
  if (name === 'IssueState') return { name: 'IssueState', kind: 'ENUM', fields: [], enumValues: [{ name: 'OPEN' }, { name: 'CLOSED' }], __typename: '__Type' };
  if (name === 'PullRequestState') return { name: 'PullRequestState', kind: 'ENUM', fields: [], enumValues: [{ name: 'OPEN' }, { name: 'CLOSED' }, { name: 'MERGED' }], __typename: '__Type' };
  if (name === 'MergeableState') return { name: 'MergeableState', kind: 'ENUM', fields: [], enumValues: [{ name: 'MERGEABLE' }, { name: 'CONFLICTING' }, { name: 'UNKNOWN' }], __typename: '__Type' };
  if (name === 'RepositoryPermission') return { name: 'RepositoryPermission', kind: 'ENUM', fields: [], enumValues: [{ name: 'ADMIN' }, { name: 'MAINTAIN' }, { name: 'WRITE' }, { name: 'TRIAGE' }, { name: 'READ' }], __typename: '__Type' };
  if (name === 'IssueOrderField') return { name: 'IssueOrderField', kind: 'ENUM', fields: [], enumValues: [{ name: 'CREATED_AT' }, { name: 'UPDATED_AT' }, { name: 'COMMENTS' }], __typename: '__Type' };
  if (name === 'OrderDirection') return { name: 'OrderDirection', kind: 'ENUM', fields: [], enumValues: [{ name: 'ASC' }, { name: 'DESC' }], __typename: '__Type' };
  if (name === 'PullRequestMergeMethod') return { name: 'PullRequestMergeMethod', kind: 'ENUM', fields: [], enumValues: [{ name: 'MERGE' }, { name: 'SQUASH' }, { name: 'REBASE' }], __typename: '__Type' };
  return null;
}

// ---------------------------------------------------------------- entry

export interface GraphQLResult {
  status: number;
  body: unknown;
}

/** Execute one GraphQL request body (a single operation or a batch array). */
export function handleGraphQL(ctx: GraphQLContext, body: unknown): GraphQLResult {
  if (Array.isArray(body)) {
    const results = body.map((entry) => executeOne(ctx, entry));
    return { status: 200, body: results };
  }
  return { status: 200, body: executeOne(ctx, body) };
}

function executeOne(ctx: GraphQLContext, entry: unknown): AnyRecord {
  const obj = (typeof entry === 'object' && entry !== null ? entry : {}) as AnyRecord;
  const query = typeof obj.query === 'string' ? obj.query : '';
  const variables = (obj.variables as Record<string, unknown> | undefined) ?? {};
  const operationName = typeof obj.operationName === 'string' ? obj.operationName : null;
  if (query.trim() === '') {
    return { data: null, errors: [{ message: 'No query provided' }] };
  }
  let document: Document;
  try {
    document = parseGraphQL(query);
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL parse error: ${(err as Error).message}` }] };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation in document' }] };
  }
  let operation = document.operations[0];
  if (operationName !== null) {
    const found = document.operations.find((op) => op.name === operationName);
    if (found === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}"` }] };
    }
    operation = found;
  } else if (document.operations.length > 1) {
    return { data: null, errors: [{ message: 'Must provide operation name when there are multiple operations' }] };
  }
  const state: ExecState = { errors: [], fragments: document.fragments, variables };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, state, {}, rootType, operation.selectionSet);
  const out: AnyRecord = { data };
  if (state.errors.length > 0) out.errors = state.errors;
  return out;
}
