// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, as [old path, new path], for the `R` output lines of section 2. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 5: lines, breaks and matching at three tiers.
//
// A file's text is worked on as its lines plus the two facts section 3 fixes:
// which line break it uses and whether it ends with one. splitText reads those
// off a file's bytes, joinText writes them back, so a change that does not
// touch a file's end leaves its ending exactly as it was.

interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitText(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinText(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every start position at or after `from` where O's lines match at the tier, ascending. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions; null when it occurs at none. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const at = occurrences(lines, o, tier, from);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of a replacement: a context line (`ctx` is its index in O) or a new line (`ctx` -1). */
interface NPart {
  text: string;
  ctx: number;
}

/**
 * The file's lines with the match at `pos` replaced. Context lines are written
 * as the file's own matched lines; at tier 2 every other new line is
 * re-indented from O's first line's leading whitespace to the file's.
 */
function replaced(lines: string[], pos: number, o: string[], parts: NPart[], tier: number): string[] {
  const f = o.length > 0 ? leadWs(lines[pos]!) : '';
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const out: string[] = [];
  for (const part of parts) {
    if (part.ctx >= 0) {
      out.push(lines[pos + part.ctx]!);
      continue;
    }
    let s = part.text;
    if (tier === 2 && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
    out.push(s);
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + o.length)];
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.

/** A hunk body line: ' ' context, '-' old, '+' new, '\\' a no-newline marker. */
interface BodyLine {
  kind: string;
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** True when a `\` marker follows the body's last context or `+` line (for a creation, its last `+` line). */
function noBreakAfter(body: BodyLine[], plusOnly = false): boolean {
  let last = -1;
  body.forEach((b, i) => {
    if (b.kind === '+' || (!plusOnly && b.kind === ' ')) last = i;
  });
  if (last < 0) return false;
  return body.some((b, i) => i > last && b.kind === '\\');
}

/** The new lines a body writes for the match unit it describes, beside its old lines. */
function bodyParts(body: BodyLine[]): { o: string[]; parts: NPart[] } {
  const o: string[] = [];
  const parts: NPart[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      parts.push({ text: b.text, ctx: o.length });
      o.push(b.text);
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      parts.push({ text: b.text, ctx: -1 });
    }
  }
  return { o, parts };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const isPairAt = (j: number): boolean => (lines[j] ?? '').startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  const headerPath = (line: string): string | null => {
    let raw = line.slice(4);
    const tab = raw.indexOf('\t');
    if (tab >= 0) raw = raw.slice(0, tab);
    raw = raw.trim();
    if (raw === '/dev/null') return null;
    if (raw.startsWith('a/') || raw.startsWith('b/')) raw = raw.slice(2);
    return raw;
  };
  const diffPaths = (line: string, ln: number): [string, string] => {
    const toks = line.slice('diff --git '.length).split(' ');
    if (toks.length !== 2 || !toks[0]!.startsWith('a/') || !toks[1]!.startsWith('b/')) throw new Exit2(`error: parse ${ln}`);
    return [toks[0]!.slice(2), toks[1]!.slice(2)];
  };
  const sections: USection[] = [];
  let cur: USection | null = null;
  const start = (): USection => {
    cur = { pairOld: undefined, pairNew: undefined, diffOld: undefined, diffNew: undefined, renameOld: undefined, renameNew: undefined, newFile: false, delFile: false, hunks: [] };
    sections.push(cur);
    return cur;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const ln = i + 1;
    if (l.startsWith('diff --git ')) {
      const [x, y] = diffPaths(l, ln);
      const s = start();
      s.diffOld = x;
      s.diffNew = y;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${ln}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ') || isPairAt(j)) break;
        if (bl === '') {
          body.push({ kind: ' ', text: '' });
          j += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ kind: c, text: c === '\\' ? bl : bl.slice(1) });
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (isPairAt(i)) {
      if (cur === null || cur.hunks.length > 0 || cur.pairOld !== undefined) start();
      cur!.pairOld = headerPath(l);
      cur!.pairNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // The section's header, before its first hunk.
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${ln + 1}`);
      if (l.startsWith('rename from ')) cur.renameOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1; // Outside bodies and headers, lines are ignored.
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSection(s, strict));
}

function unifiedSection(s: USection, strict: boolean): Edit {
  const oldPath = s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : s.diffOld;
  const newPath = s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : s.diffNew;
  const isCreate = s.newFile || (s.pairOld !== undefined && s.pairOld === null);
  const isDelete = s.delFile || (s.pairNew !== undefined && s.pairNew === null);
  return (tree) => {
    if (isCreate) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const body = s.hunks.flatMap((h) => h.body);
      const added = body.filter((b) => b.kind === '+').map((b) => b.text);
      tree.now.set(p, added.length === 0 ? '' : added.join('\n') + (noBreakAfter(body, true) ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const op = oldPath!;
    const np = newPath ?? op;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (np !== op && !safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (np !== op && tree.get(np) !== null) throw new Fail('exists', np);
    const sp = splitText(before);
    let lines = sp.lines;
    let final = sp.final;
    let d = 0;
    for (const h of s.hunks) {
      const { o, parts } = bodyParts(h.body);
      if (o.length === 0) {
        const at = Math.min(h.a + d, lines.length);
        const atEnd = at === lines.length;
        const texts = parts.map((x) => x.text);
        lines = [...lines.slice(0, at), ...texts, ...lines.slice(at)];
        if (atEnd) final = !noBreakAfter(h.body);
        d += texts.length;
        continue;
      }
      const found = findTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', op);
      const target = h.a - 1 + d;
      let pos = found.at[0]!;
      for (const cand of found.at) {
        if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      }
      const touchesEnd = pos + o.length === lines.length;
      lines = replaced(lines, pos, o, parts, found.tier);
      if (touchesEnd) final = !noBreakAfter(h.body);
      d += parts.length - o.length;
    }
    const text = joinText(lines, sp.br, final);
    if (np !== op) {
      tree.now.set(op, null);
      tree.now.set(np, text);
      tree.moves.push([op, np]);
    } else {
      tree.now.set(np, text);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let p: string | null = null;
    for (let j = i - 1; j >= searchFrom; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      p = t;
      break;
    }
    if (p === null) p = prevPath;
    if (p === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceBlock(p, oldLines, newLines, strict));
    prevPath = p;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function searchReplaceBlock(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const sp = splitText(before);
    const found = findTier(sp.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.at.length > 1) throw new Fail('ambiguous', p);
    const parts = newLines.map((t) => ({ text: t, ctx: -1 }));
    tree.now.set(p, joinText(replaced(sp.lines, found.at[0]!, oldLines, parts, found.tier), sp.br, sp.final));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = sectionStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const header = { kind, path: l.slice(l.indexOf(': ') + 2).trim(), headerLine: i + 1, addLines: [] as string[], moveTo: null as string | null, chunks: [] as VChunk[] };
    sections.push(header);
    let j = i + 1;
    if (kind === 'add') {
      const got: string[] = [];
      while (j < last && sectionStart(lines[j]!) === null) {
        const bl = lines[j]!;
        if (bl.startsWith('+')) got.push(bl.slice(1));
        else if (bl === '') got.push('');
        else throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      while (got.length > 0 && got[got.length - 1] === '') got.pop();
      header.addLines = got;
    } else if (kind === 'delete') {
      while (j < last && sectionStart(lines[j]!) === null) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
    } else {
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        header.moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j += 1;
      }
      let chunk: VChunk | null = null;
      let closed = false;
      while (j < last && sectionStart(lines[j]!) === null) {
        const bl = lines[j]!;
        if (bl.startsWith('@@')) {
          chunk = { anchor: bl.slice(2).trim() || null, eof: false, body: [] };
          header.chunks.push(chunk);
          closed = false;
          j += 1;
          continue;
        }
        if (bl.trim() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${j + 1}`);
          chunk.eof = true;
          chunk = null;
          closed = true;
          j += 1;
          continue;
        }
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          if (chunk === null) {
            if (header.chunks.length > 0 || closed) throw new Exit2(`error: parse ${j + 1}`);
            chunk = { anchor: null, eof: false, body: [] };
            header.chunks.push(chunk);
          }
          chunk.body.push({ kind: bl === '' ? ' ' : bl[0]!, text: bl === '' ? '' : bl.slice(1) });
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      const tail = header.chunks[header.chunks.length - 1];
      if (tail !== undefined) {
        while (tail.body.length > 0 && tail.body[tail.body.length - 1]!.kind === ' ' && tail.body[tail.body.length - 1]!.text === '') tail.body.pop();
      }
      if (header.chunks.length === 0 && header.moveTo === null) throw new Exit2(`error: parse ${header.headerLine}`);
    }
    i = j;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aSection(s, strict));
}

function v4aSection(s: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = s.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (s.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, s.addLines.length === 0 ? '' : `${s.addLines.join('\n')}\n`);
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const np = s.moveTo;
    if (np !== null && !safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (np !== null && tree.get(np) !== null) throw new Fail('exists', np);
    const sp = splitText(before);
    let lines = sp.lines;
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        let at = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < lines.length; k += 1) {
            if (lineEq(lines[k]!, chunk.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const { o, parts } = bodyParts(chunk.body);
      if (o.length === 0) {
        const at = chunk.eof ? lines.length : cursor;
        const texts = parts.map((x) => x.text);
        lines = [...lines.slice(0, at), ...texts, ...lines.slice(at)];
        cursor = at + texts.length;
        continue;
      }
      const found = findTier(lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', p);
      const cands = chunk.eof ? found.at.filter((x) => x + o.length === lines.length) : found.at;
      if (cands.length === 0) throw new Fail('no-match', p);
      const pos = cands[0]!;
      lines = replaced(lines, pos, o, parts, found.tier);
      cursor = pos + parts.length;
    }
    const text = joinText(lines, sp.br, sp.final);
    if (np !== null) {
      tree.now.set(p, null);
      tree.now.set(np, text);
      tree.moves.push([p, np]);
    } else {
      tree.now.set(p, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A move whose old path is gone and whose new path is new prints as one R
  // line, sorted by the new path, in place of the pair's D and A lines.
  const renames = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (!renames.has(n) && tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) != null) renames.set(n, o);
  }
  const renamedFrom = new Set(renames.values());
  const rows: { key: string; line: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (renames.has(p)) rows.push({ key: p, line: `R ${renames.get(p)} -> ${p}` });
    else if (renamedFrom.has(p)) continue;
    else if (was !== now) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
