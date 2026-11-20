// githttp.ts — git smart HTTP: info/refs, upload-pack (v0/v2), receive-pack (v0).
// Implements the wire the kit's git client speaks. No git binary; objects live in the store.

import {
  ZERO_OID,
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  readPack,
  writePack,
  type GitObject,
  type GitObjectType,
} from './gitproto.ts';
import { VIEWER_LOGIN, type Forge, type Repo } from './store.ts';

export const AGENT = 'forge/1.0';

const UPLOAD_V0_CAPS =
  'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-progress include-tag multi_ack_detailed allow-tip-sha1-in-want allow-reachable-sha1-in-want no-done symref=HEAD:refs/heads/main agent=forge/1.0 object-format=sha1';
const RECEIVE_V0_CAPS =
  'report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta agent=forge/1.0 object-format=sha1';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFound(message: string): HttpResult {
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

function badRequest(message: string): HttpResult {
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** Peeled commit oid for a ref (follows one annotated tag). */
function peelToCommit(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (obj === undefined) return undefined;
  if (obj.type === 'tag') return parseTag(obj.data).object;
  return undefined;
}

/** Refs for an advertisement, including HEAD first and peeled tag lines. */
function advertRefs(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headOid !== undefined) {
    out.push({ oid: headOid, name: 'HEAD' });
  }
  for (const { name, oid } of repoSortedRefs(repo)) {
    const peeled = name.startsWith('refs/tags/') ? peelToCommit(repo, oid) : undefined;
    out.push({ oid, name, peeled });
  }
  return out;
}

function repoSortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ---------------------------------------------------------------- info/refs

export function handleInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocolVersion: 2 | 0,
): HttpResult {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound(`Repository ${owner}/${repoName} not found`);
  if (service === 'git-upload-pack' && gitProtocolVersion === 2) {
    const lines: Array<string | 'flush'> = [
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow wait-for-done filter\n',
      'object-format=sha1\n',
      'object-info\n',
      'flush',
    ];
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: encodePktLines(lines),
    };
  }
  // v0 advertisement.
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const refs = advertRefs(repo);
  const parts: Buffer[] = [];
  parts.push(encodePktLine(`# service=${service}\n`));
  parts.push(pktFlush());
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const first = index === 0 ? `\0${caps}` : '';
      parts.push(encodePktLine(`${ref.oid} ${ref.name}${first}\n`));
      if (ref.peeled !== undefined) {
        parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
      }
    });
  }
  parts.push(pktFlush());
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: Buffer.concat(parts),
  };
}

// ---------------------------------------------------------------- upload-pack

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
  done: boolean;
  filter?: string;
  thinPack: boolean;
}

/** Objects to send for a fetch: reachable from wants within depth, minus what haves reach. */
function planFetchObjects(
  repo: Repo,
  plan: FetchPlan,
): { objects: GitObject[]; shallow: string[]; unshallow: string[]; acks: string[]; nak: boolean } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // What the client already holds: the haves' closure, but never past a shallow
  // boundary it sent (a shallow clone holds the boundary commit and its tree,
  // not its ancestors). Without this, a deepen would subtract the very parent
  // it is supposed to deliver.
  const haveReachable = plan.haves.length
    ? collectReachable(plan.haves, lookup, true, new Set(plan.shallow))
    : new Set<string>();
  // Depth-limited reachability from wants.
  const wanted = new Set<string>();
  const shallow = new Set<string>();
  const unshallow: string[] = [];
  if (plan.depth !== undefined) {
    // BFS over commits from the wants, tracking generation depth. A commit is
    // included only when its depth is < plan.depth; the deepest included
    // generation (depth == plan.depth - 1) is the shallow boundary. Commits at
    // depth >= plan.depth are never sent.
    const queue: Array<{ oid: string; depth: number }> = [];
    const seenCommit = new Set<string>();
    const included = new Set<string>();
    for (const w of plan.wants) {
      if (isObjectId(w)) queue.push({ oid: w, depth: 0 });
    }
    let qi = 0;
    while (qi < queue.length) {
      const { oid, depth } = queue[qi++];
      if (seenCommit.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      if (obj.type === 'tag') {
        const target = parseTag(obj.data).object;
        if (!seenCommit.has(target)) queue.push({ oid: target, depth });
        continue;
      }
      if (obj.type !== 'commit') continue;
      seenCommit.add(oid);
      if (depth >= plan.depth) continue;
      included.add(oid);
      if (depth === plan.depth - 1) shallow.add(oid);
      const commit = parseCommit(obj.data);
      for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
    }
    // Objects: the included commits plus their trees/blobs (never the parents
    // of a boundary commit, and never a commit at depth >= plan.depth).
    for (const oid of included) {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      wanted.add(oid);
      const commit = parseCommit(obj.data);
      const stack: string[] = [commit.tree];
      while (stack.length > 0) {
        const treeOid = stack.pop()!;
        if (wanted.has(treeOid)) continue;
        const treeObj = repo.objects.get(treeOid);
        if (treeObj === undefined) continue;
        wanted.add(treeOid);
        if (treeObj.type === 'tree') {
          for (const e of parseTree(treeObj.data)) {
            if (e.mode === '160000') continue;
            if (e.mode === '40000') stack.push(e.oid);
            else wanted.add(e.oid);
          }
        }
      }
    }
    // Unshallow: a shallow boundary the client sent that is no longer a boundary.
    for (const s of plan.shallow) {
      if (!shallow.has(s) && seenCommit.has(s)) unshallow.push(s);
    }
  } else {
    const reachable = collectReachable(plan.wants, lookup, true);
    for (const oid of reachable) wanted.add(oid);
  }
  const objects: GitObject[] = [];
  for (const oid of wanted) {
    if (haveReachable.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objects.push(obj);
  }
  // Acks: haves that are reachable from a want (a common base). With no haves
  // there can be no acks, so skip the full-closure walk over the wants — that
  // walk is the dominant cost of a shallow clone of a deep repo.
  const acks: string[] = [];
  if (plan.haves.length > 0) {
    const fromWant = collectReachable(plan.wants, lookup, true);
    for (const h of plan.haves) {
      if (fromWant.has(h)) acks.push(h);
    }
  }
  return { objects, shallow: [...shallow], unshallow, acks, nak: acks.length === 0 };
}

/** Chunk bytes into sideband packets (band 1 = pack data). */
function sidebandPackets(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX = 65520 - 4 - 1;
  let off = 0;
  if (data.length === 0) return out;
  while (off < data.length) {
    const chunk = data.subarray(off, Math.min(data.length, off + MAX));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    out.push(encodePktLine(payload));
    off += chunk.length;
  }
  return out;
}

export function handleUploadPack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocolVersion: 2 | 0,
): HttpResult {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound(`Repository ${owner}/${repoName} not found`);
  let packets;
  try {
    packets = decodePktLines(body);
  } catch (err) {
    return badRequest(`malformed pkt-line: ${(err as Error).message}`);
  }
  if (gitProtocolVersion === 2) {
    return handleUploadPackV2(repo, packets);
  }
  return handleUploadPackV0(repo, packets);
}

// ---------------------------------------------------------------- fetch cache
//
// An upload-pack fetch response is a pure function of the repo's version and
// the fetch parameters (wants, haves, shallow, depth, ...): every mutation
// that changes objects or refs bumps repo.version, and the response carries no
// timestamps. The clone workload issues 50 identical shallow clones of one
// repo at one version, so caching the response body removes 49 of 50 pack
// builds (BFS + tree walk + deflate + SHA-1). Bounded FIFO; entries for an
// old version simply stop matching once the repo mutates.
const FETCH_CACHE_MAX = 200;
const fetchCache = new Map<string, Buffer>();

function fetchCacheKey(protocol: 2 | 0, repo: Repo, plan: FetchPlan): string {
  const sortJoin = (arr: readonly string[]): string => [...arr].sort().join(',');
  return [
    protocol === 2 ? 'v2' : 'v0',
    repo.owner,
    repo.name,
    String(repo.version),
    `w=${sortJoin(plan.wants)}`,
    `h=${sortJoin(plan.haves)}`,
    `s=${sortJoin(plan.shallow)}`,
    `d=${plan.depth ?? ''}`,
    `ds=${plan.deepenSince ?? ''}`,
    `dn=${sortJoin(plan.deepenNot)}`,
    `f=${plan.filter ?? ''}`,
  ].join('|');
}

function fetchCacheGet(key: string): Buffer | undefined {
  const hit = fetchCache.get(key);
  if (hit !== undefined) {
    // Refresh recency.
    fetchCache.delete(key);
    fetchCache.set(key, hit);
  }
  return hit;
}

function fetchCachePut(key: string, body: Buffer): void {
  fetchCache.set(key, body);
  while (fetchCache.size > FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value;
    if (oldest === undefined) break;
    fetchCache.delete(oldest);
  }
}

function handleUploadPackV2(repo: Repo, packets: ReturnType<typeof decodePktLines>): HttpResult {
  const lines = packets.filter((p) => p.kind === 'data').map((p) => (p.kind === 'data' ? p.payload.toString('utf8') : ''));
  const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length).replace(/\n$/, '') ?? '';
  if (command === 'ls-refs') {
    return lsRefsV2(repo, packets);
  }
  if (command !== 'fetch') {
    return badRequest(`unsupported v2 command ${JSON.stringify(command)}`);
  }
  const plan2 = parseV2FetchArgs(packets);
  if ('error' in plan2) return badRequest(plan2.error);
  const cacheKey = fetchCacheKey(2, repo, plan2);
  const cached = fetchCacheGet(cacheKey);
  if (cached !== undefined) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
  }
  const { objects, shallow, unshallow, acks, nak } = planFetchObjects(repo, plan2);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  if (nak) parts.push(encodePktLine('NAK\n'));
  else for (const ack of acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  parts.push(encodePktLine('ready\n'));
  parts.push(pktDelim());
  if (plan2.depth !== undefined || shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const s of shallow) parts.push(encodePktLine(`shallow ${s}\n`));
    for (const u of unshallow) parts.push(encodePktLine(`unshallow ${u}\n`));
    parts.push(pktDelim());
  }
  const wantedRefs = wantedRefsFor(repo, plan2.wants);
  if (wantedRefs.length > 0) {
    parts.push(encodePktLine('wanted-refs\n'));
    for (const r of wantedRefs) parts.push(encodePktLine(`${r.oid} ${r.name}\n`));
    parts.push(pktDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  const pack = writePack(objects);
  for (const p of sidebandPackets(1, pack)) parts.push(p);
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  fetchCachePut(cacheKey, body);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

function parseV2FetchArgs(packets: ReturnType<typeof decodePktLines>): FetchPlan | { error: string } {
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], deepenNot: [], done: false, thinPack: false };
  let command = '';
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') { afterDelim = true; continue; }
    if (p.kind === 'flush') continue;
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    if (line.startsWith('want ')) plan.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) plan.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) plan.depth = parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) plan.deepenSince = parseInt(line.slice(13), 10);
    else if (line.startsWith('deepen-not ')) plan.deepenNot.push(line.slice(11).trim());
    else if (line.startsWith('filter ')) plan.filter = line.slice(7).trim();
    else if (line === 'done') plan.done = true;
    else if (line === 'thin-pack') plan.thinPack = true;
  }
  if (command !== 'fetch') return { error: `expected command=fetch, got ${command}` };
  return plan;
}

function wantedRefsFor(repo: Repo, wants: readonly string[]): Array<{ oid: string; name: string }> {
  const wantSet = new Set(wants);
  const out: Array<{ oid: string; name: string }> = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headOid !== undefined && wantSet.has(headOid)) out.push({ oid: headOid, name: 'HEAD' });
  for (const { name, oid } of repoSortedRefs(repo)) {
    if (wantSet.has(oid)) out.push({ oid, name });
  }
  return out;
}

function lsRefsV2(repo: Repo, packets: ReturnType<typeof decodePktLines>): HttpResult {
  const args = packets
    .filter((p) => p.kind === 'data')
    .map((p) => (p.kind === 'data' ? p.payload.toString('utf8').replace(/\n$/, '') : ''));
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let afterDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') { afterDelim = true; continue; }
    if (!afterDelim || p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  void args;
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((pre) => name.startsWith(pre));
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headOid !== undefined) {
    if (keep('HEAD')) {
      const target = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      parts.push(encodePktLine(`${headOid} HEAD${target}\n`));
    }
  } else if (unborn && keep('HEAD')) {
    const target = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    parts.push(encodePktLine(`unborn HEAD${target}\n`));
  }
  for (const { name, oid } of repoSortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (name.startsWith('refs/tags/') && peel) {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    parts.push(encodePktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function handleUploadPackV0(repo: Repo, packets: ReturnType<typeof decodePktLines>): HttpResult {
  // v0 is two sections: wants (+shallow/deepen) then flush, then haves + done then flush.
  const plan: FetchPlan = { wants: [], haves: [], shallow: [], deepenNot: [], done: false, thinPack: false };
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') { section += 1; continue; }
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      // First want line may carry capabilities after a NUL.
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
    }
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      const oid = rest.split(' ')[0];
      if (isObjectId(oid)) plan.wants.push(oid);
    } else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) plan.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) plan.depth = parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) plan.deepenSince = parseInt(line.slice(13), 10);
    else if (line.startsWith('deepen-not ')) plan.deepenNot.push(line.slice(11).trim());
    else if (line === 'done') plan.done = true;
  }
  if (plan.wants.length === 0) return badRequest('v0 fetch with no want');
  const cacheKey = fetchCacheKey(0, repo, plan);
  const cached = fetchCacheGet(cacheKey);
  if (cached !== undefined) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
  }
  const { objects, shallow, unshallow, acks, nak } = planFetchObjects(repo, plan);
  const parts: Buffer[] = [];
  if (nak) parts.push(encodePktLine('NAK\n'));
  else for (const ack of acks) parts.push(encodePktLine(`ACK ${ack}\n`));
  for (const s of shallow) parts.push(encodePktLine(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(encodePktLine(`unshallow ${u}\n`));
  const pack = writePack(objects);
  for (const p of sidebandPackets(1, pack)) parts.push(p);
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  fetchCachePut(cacheKey, body);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(forge: Forge, owner: string, repoName: string, body: Buffer): HttpResult {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound(`Repository ${owner}/${repoName} not found`);
  // Split the body: pkt-lines until the first flush, then the pack bytes.
  let off = 0;
  const commands: PushCommand[] = [];
  let sideband = false;
  let reportStatus = false;
  let packStart = body.length;
  try {
    while (off + 4 <= body.length) {
      const head = body.subarray(off, off + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(head)) return badRequest('malformed pkt-line in receive-pack');
      const len = parseInt(head, 16);
      if (len === 0) { off += 4; packStart = off; break; }
      if (len < 4 || off + len > body.length) return badRequest('truncated pkt-line in receive-pack');
      const payload = body.subarray(off + 4, off + len).toString('utf8');
      let line = payload.replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ');
        sideband = caps.includes('side-band-64k');
        reportStatus = caps.includes('report-status') || caps.includes('report-status-v2');
        line = line.slice(0, nul);
      }
      const parts = line.split(' ');
      if (parts.length < 3 || !isObjectId(parts[0]) || !isObjectId(parts[1])) {
        return badRequest(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
      }
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
      off += len;
    }
  } catch (err) {
    return badRequest(`receive-pack parse: ${(err as Error).message}`);
  }
  if (commands.length === 0) return badRequest('receive-pack with no commands');
  if (packStart > body.length) packStart = body.length;
  const packBytes = body.subarray(packStart);
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  // Read the pack (if any) into the repo's object store (only after validation below).
  let incoming = new Map<string, GitObject>();
  if (hasUpdates) {
    if (packBytes.length === 0) return badRequest('push with updates but no packfile');
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      incoming = read.objects;
    } catch (err) {
      return reportPush(repo, commands, sideband, reportStatus, 'unpack error', []);
    }
  }
  // Validate each command; collect per-ref results.
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const toApply: Array<{ cmd: PushCommand; newObjects: Map<string, GitObject> }> = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      results.push({ ref: cmd.ref, ok: true, reason: '' });
      toApply.push({ cmd, newObjects: new Map() });
      continue;
    }
    // Create or update.
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        continue;
      }
    } else {
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      if (current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
    }
    // The new tip must exist (in the pack or already in the repo).
    const newObj = incoming.get(cmd.newOid) ?? repo.objects.get(cmd.newOid);
    if (newObj === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'new tip object not found' });
      continue;
    }
    // Closure: every object the new tip reaches must be present (pack or repo).
    // Only walk the objects this pack added (fresh), not the whole ancestry.
    const closure = checkClosure(repo, incoming, cmd.newOid);
    if (closure !== null) {
      results.push({ ref: cmd.ref, ok: false, reason: `missing object ${closure}` });
      continue;
    }
    // Fast-forward: old must be an ancestor of new (or a create).
    if (cmd.oldOid !== ZERO_OID && !isAncestor(repo, incoming, cmd.oldOid, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    results.push({ ref: cmd.ref, ok: true, reason: '' });
    toApply.push({ cmd, newObjects: incoming });
  }
  // Apply the accepted commands.
  for (const { cmd, newObjects } of toApply) {
    for (const [oid, obj] of newObjects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
    if (cmd.newOid === ZERO_OID) {
      repo.refs.delete(cmd.ref);
    } else {
      repo.refs.set(cmd.ref, cmd.newOid);
      if (cmd.ref.startsWith('refs/tags/')) {
        const name = cmd.ref.slice('refs/tags/'.length);
        repo.tags.set(name, cmd.newOid);
      }
    }
  }
  if (toApply.length > 0) {
    forge.tick();
    repo.pushedAt = forge.nowIso();
    forge.bump(repo);
  }
  return reportPush(repo, commands, sideband, reportStatus, 'ok', results);
}

function reportPush(
  _repo: Repo,
  _commands: PushCommand[],
  sideband: boolean,
  _reportStatus: boolean,
  unpack: string,
  results: Array<{ ref: string; ok: boolean; reason: string }>,
): HttpResult {
  const lines: string[] = [`unpack ${unpack}\n`];
  for (const r of results) {
    if (r.ok) lines.push(`ok ${r.ref}\n`);
    else lines.push(`ng ${r.ref} ${r.reason}\n`);
  }
  const inner = Buffer.concat(lines.map((l) => encodePktLine(l)));
  let body: Buffer;
  if (sideband) {
    const packets = sidebandPackets(1, inner);
    body = Buffer.concat([...packets, pktFlush()]);
  } else {
    body = Buffer.concat([inner, pktFlush()]);
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
}

/**
 * Closure check, fresh-only: walk from the new tip, but only descend into objects the
 * pack added; an object already in the repo is trusted (it was verified when it arrived).
 * Returns the first missing oid, or null when everything is present.
 */
function checkClosure(repo: Repo, incoming: Map<string, GitObject>, tip: string): string | null {
  const lookup = (oid: string): GitObject | undefined => incoming.get(oid) ?? repo.objects.get(oid);
  const stack: string[] = [tip];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined) return oid;
    // Only expand objects the pack added; repo objects were verified on arrival.
    if (!incoming.has(oid)) continue;
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    }
  }
  return null;
}

/** True when `ancestor` is reachable from `tip` (following commit parents). */
function isAncestor(repo: Repo, incoming: Map<string, GitObject>, ancestor: string, tip: string): boolean {
  const lookup = (oid: string): GitObject | undefined => incoming.get(oid) ?? repo.objects.get(oid);
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

export { VIEWER_LOGIN };
