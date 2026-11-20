// gitproto.ts — git object model, pkt-line codec, and packfile read/write.
// Written from the git smart-HTTP protocol (protocol v0/v2) as specified by the
// kit's conformance client. Node built-ins only (crypto, zlib).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

// ---------------------------------------------------------------- pkt-line

export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error('pkt-line too long');
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
export const pktResponseEnd = (): Buffer => Buffer.from('0002', 'ascii');

export function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else if (item === 'response-end') parts.push(pktResponseEnd());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** Decode a whole buffer into pkt-line packets. Throws on malformed framing. */
export function decodePktLines(bytes: Uint8Array): GitPacket[] {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const out: GitPacket[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line header ${JSON.stringify(head)}`);
    const len = parseInt(head, 16);
    if (len === 0) { out.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end' }); off += 4; continue; }
    if (len < 4 || len > PKT_LINE_MAX) throw new Error(`bad pkt-line length ${len}`);
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

export function packetsToLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const p of packets) if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------- objects

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  h.update(body);
  return h.digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off);
    if (sp < 0) throw new Error('tree: no mode separator');
    const nul = buf.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > buf.length) throw new Error('tree: truncated entry');
    entries.push({
      mode: buf.subarray(off, sp).toString('ascii'),
      name: buf.subarray(sp + 1, nul).toString('utf8'),
      oid: buf.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    if (!isObjectId(e.oid)) throw new Error(`tree entry ${e.name}: bad oid`);
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headEnd = blank < 0 ? buf.length : blank;
  const message = blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of buf.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author') author = val;
    else if (key === 'committer') committer = val;
  }
  if (!isObjectId(tree)) throw new Error('commit: no valid tree');
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer?: string;
  timestamp: number;
  timezone?: string;
}): Buffer {
  const tz = fields.timezone ?? '+0000';
  const who = `${fields.author} ${fields.timestamp} ${tz}`;
  const com = `${fields.committer ?? fields.author} ${fields.timestamp} ${tz}`;
  const lines = [`tree ${fields.tree}`];
  for (const p of fields.parents ?? []) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${com}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buf.indexOf('\n\n');
  const headEnd = blank < 0 ? buf.length : blank;
  const headers = new Map<string, string>();
  for (const line of buf.subarray(0, headEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) throw new Error('tag: header without value');
    headers.set(line.slice(0, sp), line.slice(sp + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag: no valid object');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') throw new Error('tag: bad type');
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buf.subarray(blank + 2).toString('utf8'),
  };
}

export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
  timezone?: string;
}): Buffer {
  const tz = fields.timezone ?? '+0000';
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger} ${fields.timestamp} ${tz}\n\n${fields.message}`,
    'utf8',
  );
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from roots (commit -> tree + parents, tree -> entries, tag -> target). */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * All objects reachable from `roots` (commits, their trees/blobs, tags).
 * `boundaries` (optional) are commits whose parents are NOT followed: they mark
 * the edge of a shallow clone's history, so the client holding one has the
 * commit and its tree but none of its ancestors.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  allowMissing = false,
  boundaries: ReadonlySet<string> = EMPTY_SET,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isObjectId(r)) queue.push(r);
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head++];
    if (seen.has(oid)) continue;
    const obj = lookup(oid);
    if (!obj) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} missing`);
    }
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      if (!boundaries.has(oid)) {
        for (const p of c.parents) queue.push(p);
      }
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue;
        queue.push(e.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------- packfile

function readPackVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buf.length) throw new Error('pack: truncated size header');
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    if (off >= buf.length) throw new Error('pack: truncated size varint');
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buf.length) throw new Error('pack: ofs-delta without base');
  let byte = buf[start];
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (off >= buf.length) throw new Error('pack: truncated ofs base');
    byte = buf[off++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: off };
}

export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('pack: zlib consumed nothing');
  return { data: result.buffer, next: offset + written };
}

export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const b = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const d = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let off = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (off >= d.length) throw new Error('delta: truncated size');
      const byte = d[off++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== b.length) throw new Error('delta: base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < d.length) {
    const op = d[off++];
    if (op & 0x80) {
      let copyOff = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (off >= d.length) throw new Error('delta: truncated copy offset');
          copyOff += d[off++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (off >= d.length) throw new Error('delta: truncated copy size');
          copySize += d[off++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOff + copySize > b.length) throw new Error('delta: copy out of base');
      if (written + copySize > targetSize) throw new Error('delta: copy past target');
      b.copy(out, written, copyOff, copyOff + copySize);
      written += copySize;
    } else if (op !== 0) {
      const n = op & 0x7f;
      if (off + n > d.length) throw new Error('delta: truncated insert');
      if (written + n > targetSize) throw new Error('delta: insert past target');
      d.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else {
      throw new Error('delta: opcode 0 invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta: size mismatch');
  return out;
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly checksumOk: boolean;
}

export function readPack(pack: Uint8Array, resolveBase?: ObjectLookup): PackReadResult {
  const buf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buf.length < 32) throw new Error('pack: too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack: bad magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack: version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOff = off;
    const header = readPackVarint(buf, off);
    off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOff, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(buf, off);
      off = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOff) throw new Error('pack: bad ofs base');
      entry.baseOffset = entryOff - base.baseOffset;
    } else if (typeCode === 7) {
      if (off + 20 > trailerStart) throw new Error('pack: truncated ref base');
      entry.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack: unknown type ${typeCode}`);
    }
    const inflated = inflateAt(buf.subarray(0, trailerStart), off);
    if (inflated.data.length !== header.size) throw new Error('pack: inflated size mismatch');
    entry.data = inflated.data;
    off = inflated.next;
    raw.push(entry);
    byOffset.set(entryOff, entry);
  }
  if (off !== trailerStart) throw new Error('pack: trailing bytes');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, { type: GitObjectType; data: Buffer }>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { _r?: { type: GitObjectType; data: Buffer; oid: string } })._r;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('pack: delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('pack: ofs base not in pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const inPack = resolvedByOid.get(wanted);
      if (inPack) {
        type = inPack.type;
        data = applyDelta(inPack.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`pack: ref base ${wanted} not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as unknown as { _r?: unknown })._r = out;
    resolvedByOid.set(oid, { type, data });
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const r = resolve(entry);
    if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
  }
  return { objects, checksumOk: trailer === computed };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1 over the body. */
export function writePack(objects: Iterable<{ type: GitObjectType; data: Uint8Array }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    const data = Buffer.isBuffer(obj.data) ? obj.data : Buffer.from(obj.data);
    parts.push(writePackObjectHeader(obj.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
