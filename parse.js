// parse.js — a fast drop-in for marked 18.1.3 (default options: gfm on, breaks off).
// Written from scratch against the CommonMark 0.31.2 + GFM 0.29 specs and the
// observed behaviour of marked on the practice set. Single-pass block parser
// plus an inline parser with a CommonMark delimiter stack. No dependencies,
// no caching across calls: every parse() call is stateless.

// ---- character helpers ----------------------------------------------------
const PUNCT = '!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
function isPunct(ch) { return ch !== '' && PUNCT.indexOf(ch) >= 0; }
function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'; }
function isAlphaNum(ch) { const c = ch.charCodeAt(0); return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }

// Fast ASCII char-class lookup: a Uint8Array indexed by char code. Replaces
// per-character regex tests in the hot inline loop (a regex .test() on one
// character is far slower than a table lookup).
function charTable(chars) {
  const t = new Uint8Array(128);
  for (let k = 0; k < chars.length; k++) t[chars.charCodeAt(k)] = 1;
  return t;
}
const EMAIL_LOCAL = charTable("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?^_`{|}~-");
const DOMAIN_CH = charTable('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-');
const PATH_CH = charTable("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:/?#@!$'()*+,;=%");
const SCHEME_CH = charTable('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+.-');
const LABEL_CH = charTable('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-');
const PATHSEG_CH = charTable("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:!$&'()*+,;=%@");

// Escape text for HTML: & < > " '  (marked's escape set). A '&' that starts
// an entity reference (&word; / &#digits; / &#x hex;) is left unescaped
// (marked's escapeNoEncode) — named references pass through verbatim.
function isEntityRef(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return false;
  if (s.charCodeAt(j) === 35) { // '#'
    j++;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) {
      j++;
      const st = j;
      while (j < n) {
        const c = s.charCodeAt(j);
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)) j++;
        else break;
      }
      const k = j - st;
      return k >= 1 && k <= 6 && j < n && s[j] === ';';
    }
    const st = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c >= 48 && c <= 57) j++;
      else break;
    }
    const k = j - st;
    return k >= 1 && k <= 7 && j < n && s[j] === ';';
  }
  const st = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) j++;
    else break;
  }
  return j - st >= 1 && j < n && s[j] === ';';
}

function escText(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { if (!isEntityRef(s, i)) rep = '&amp;'; }
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape code content: same set, but '&' is ALWAYS escaped (code spans and
// fenced code do not pass entity references through).
function escCode(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape attribute values the way marked does for href/title (same set).
function escAttr(s) { return escText(s); }

// ---- HTML entities --------------------------------------------------------
// Marked passes named entity references through verbatim (even invalid
// names) and decodes only VALID numeric references: &#1-7 decimal digits;
// or &#x 1-6 hex digits;. A numeric reference that decodes to 0, a
// surrogate, or > 0x10FFFF becomes U+FFFD. Anything else is plain text and
// the '&' is escaped by escText (unless it starts an entity reference).
function decodeNumericEntityAt(s, i) {
  const n = s.length;
  if (i + 1 >= n || s[i + 1] !== '#') return null;
  let j = i + 2, hex = false;
  if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
  const start = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (hex ? ((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))
            : (c >= 48 && c <= 57)) j++;
    else break;
  }
  const digits = j - start;
  if (digits < 1 || digits > (hex ? 6 : 7)) return null;
  if (j >= n || s[j] !== ';') return null;
  let cp = parseInt(s.slice(start, j), hex ? 16 : 10);
  if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
  return [String.fromCodePoint(cp), j - i + 1];
}

// ---- URL handling (marked's cleanUrl) -------------------------------------
// encodeURI the href, keeping literal %XX sequences intact; a URI that
// encodeURI rejects (lone surrogate etc.) makes the link drop to plain text.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// Unescape backslash escapes in a link destination / title: \x -> x for
// ASCII punctuation, and \n -> n etc. (only punctuation loses its backslash).
function unescapeBackslash(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isPunct(s[i + 1])) {
      out += s.slice(start, i) + s[i + 1];
      i++; start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Parse a link destination starting at s[i] (after '(' or in a ref def).
// Returns [dest, nextIndex] or null. dest is still raw (escapes/entities kept).
function parseDest(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s[i] === '<') {
    let j = i + 1;
    while (j < n && s[j] !== '>') {
      if (s[j] === '\n' || s[j] === '<') return null;
      if (s[j] === '\\' && j + 1 < n) j++;
      j++;
    }
    if (j >= n) return null;
    return [s.slice(i + 1, j), j + 1];
  }
  // bare destination: no spaces, no control chars, balanced parens
  let j = i, depth = 0;
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\n' || c === '\t' || c.charCodeAt(0) < 32) break;
    if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) { j += 2; continue; }
    if (c === '(') { depth++; if (depth > 32) return null; }
    else if (c === ')') { if (depth === 0) break; depth--; }
    j++;
  }
  if (j === i) return null;
  return [s.slice(i, j), j];
}

// Parse a link title starting at s[i] (after spaces, at ", ', or (). 
// Returns [title, nextIndex] or null.
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s[i];
  let close;
  if (q === '"') close = '"';
  else if (q === "'") close = "'";
  else if (q === '(') close = ')';
  else return null;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === close) return [s.slice(i + 1, j), j + 1];
    if (c === '\\' && j + 1 < n && isPunct(s[j + 1])) { j += 2; continue; }
    j++;
  }
  return null;
}

// Skip spaces/tabs/newlines (at most one newline for link parsing) from i.
function skipWs(s, i, allowNewline) {
  const n = s.length;
  let nl = false;
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t') i++;
    else if (allowNewline && c === '\n' && !nl) { nl = true; i++; }
    else break;
  }
  return i;
}

// Normalise a link label for reference lookup: collapse whitespace, case-fold.
function normLabel(s) {
  // Unicode case folding for label matching: ß / ẞ fold to "ss"
  // (toLowerCase gives ß for both, so fold ß after lowercasing).
  return s.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// ---- inline parsing -------------------------------------------------------
// Nodes: string (text, entities decoded), {c} code span, {h} raw html,
// {b} hard break, {l} link, {g} image, {d} delimiter run, {s} strike,
// {e} em, {t} strong. Delimiter nodes are resolved by processEmphasis.

const RE_WS = /\s/;
// CommonMark "Unicode punctuation character": general categories P
// (punctuation) or S (symbol) — so $, £, € count as punctuation for
// emphasis flanking.
const RE_PUNCT = /[\p{P}\p{S}]/u;
function isUnicodePunct(ch) { return ch !== '' && RE_PUNCT.test(ch); }
function isUnicodeWs(ch) { return ch !== '' && RE_WS.test(ch); }

// Flanking info for a delimiter run at [start,end) in s.
function flanking(s, start, end) {
  const before = start > 0 ? s[start - 1] : '';
  const after = end < s.length ? s[end] : '';
  const beforeWs = before === '' || isUnicodeWs(before);
  const afterWs = after === '' || isUnicodeWs(after);
  const beforePunct = before !== '' && isUnicodePunct(before);
  const afterPunct = after !== '' && isUnicodePunct(after);
  const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return [leftFlanking, rightFlanking];
}

// Find the end of a code span starting at s[i] (a backtick run). Returns
// [content, nextIndex] or null when unterminated.
function parseCodeSpan(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && s[j] === '`') j++;
  const run = j - i;
  const closer = '`'.repeat(run);
  let k = j;
  while (k < n) {
    const p = s.indexOf(closer, k);
    if (p < 0) return null;
    // a closer run must be exactly `run` long (not part of a longer run)
    if (s[p + run] === '`') { k = p + run; continue; }
    if (p > 0 && s[p - 1] === '`') { k = p + run; continue; }
    let content = s.slice(j, p);
    content = content.replace(/\n/g, ' ');
    if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
      content = content.slice(1, -1);
    }
    return [content, p + run];
  }
  return null;
}

// Try to read inline HTML starting at s[i] === '<'. Returns [html, nextIndex] or null.
function parseInlineHtml(s, i) {
  const n = s.length;
  // comment: <!--> and <!---> are abruptly-closed (empty) comments
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return ['<!-->', i + 5];
    if (s.startsWith('<!--->', i)) return ['<!--->', i + 6];
    let j = i + 4;
    while (j < n) {
      if (s[j] === '-' && s[j + 1] === '-' && s[j + 2] === '>') return [s.slice(i, j + 3), j + 3];
      j++;
    }
    return null;
  }
  // processing instruction
  if (s.startsWith('<?', i)) {
    const j = s.indexOf('?>', i + 2);
    if (j < 0) return null;
    return [s.slice(i, j + 2), j + 2];
  }
  // declaration <!A ...>
  if (s.startsWith('<!', i)) {
    const c = s[i + 2];
    if (c && /[A-Z]/.test(c)) {
      let j = i + 2;
      while (j < n && s[j] !== '>') j++;
      if (j >= n) return null;
      return [s.slice(i, j + 1), j + 1];
    }
    // CDATA
    if (s.startsWith('<![CDATA[', i)) {
      const j = s.indexOf(']]>', i + 9);
      if (j < 0) return null;
      return [s.slice(i, j + 3), j + 3];
    }
    return null;
  }
  // tag: <name ...> or </name ...>
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= n) return null;
  const tc0 = s.charCodeAt(j);
  if (!((tc0 >= 65 && tc0 <= 90) || (tc0 >= 97 && tc0 <= 122))) return null;
  while (j < n && LABEL_CH[s.charCodeAt(j)]) j++;
  // a closing tag takes no attributes: only whitespace then '>'
  if (closing) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j < n && s[j] === '>') return [s.slice(i, j + 1), j + 1];
    return null;
  }
  // attributes until > : each attribute is a name, optionally = value
  // (unquoted, 'quoted', or "quoted"). An attribute name must be
  // preceded by whitespace (so <m:abc> is not a tag). Anything else
  // (e.g. a backslash or ')') makes this not a tag.
  while (j < n) {
    let ws = 0;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; ws++; }
    if (j >= n) return null;
    const c = s[j];
    if (c === '>') return [s.slice(i, j + 1), j + 1];
    if (c === '/' && s[j + 1] === '>') return [s.slice(i, j + 2), j + 2];
    if (ws === 0) return null; // attribute name without preceding space
    // attribute name
    if (!/[A-Za-z_:]/.test(c)) return null;
    while (j < n && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    // optional = value; only consume the whitespace if '=' follows,
    // otherwise leave it for the next attribute's separator
    const afterName = j;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j < n && s[j] === '=') {
      j++;
      while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (j >= n) return null;
      const q = s[j];
      if (q === '"' || q === "'") {
        j++;
        while (j < n && s[j] !== q) j++;
        if (j >= n) return null;
        j++;
      } else {
        // unquoted value: no whitespace, ", ', =, <, >, `
        if (/[\s"'=<>`]/.test(s[j])) return null;
        while (j < n && !/[\s"'=<>`]/.test(s[j])) j++;
      }
    } else {
      j = afterName;
    }
  }
  return null;
}

// Try to read an autolink <scheme:...> or <email> starting at s[i] === '<'.
// Returns [href, text, nextIndex] or null.
function parseAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  // scheme: 2-32 chars [A-Za-z][A-Za-z0-9+.-]* then ':'
  if (j < n && /[A-Za-z]/.test(s[j])) {
    let k = j;
    while (k < n && /[A-Za-z0-9+.-]/.test(s[k])) k++;
    if (k - j >= 2 && k - j <= 32 && s[k] === ':') {
      let m = k + 1;
      while (m < n && s[m] !== '>' && s[m] !== ' ' && s[m] !== '\n' && s[m] !== '<') m++;
      if (m < n && s[m] === '>') {
        const url = s.slice(i + 1, m);
        return [url, url, m + 1];
      }
    }
  }
  // email: local@domain
  let k = j;
  while (k < n && /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(s[k])) k++;
  if (k > j && s[k] === '@') {
    let m = k + 1;
    while (m < n && /[A-Za-z0-9.-]/.test(s[m])) m++;
    const em = s.slice(j, m);
    if (m < n && s[m] === '>' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
      return ['mailto:' + em, em, m + 1];
    }
  }
  return null;
}

// Find the ']' matching the '[' at s[i]. Returns index of ']' or -1.
function findLinkEnd(s, i) {
  const n = s.length;
  let depth = 0, j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '`') {
      const cs = parseCodeSpan(s, j);
      if (cs) { j = cs[1]; continue; }
      j++; continue;
    }
    // an HTML tag (or comment/PI/declaration) can contain ']' without
    // closing the link text; skip a complete one. Likewise an autolink
    // <https://...> can contain ']' (it is part of the URL).
    if (c === '<') {
      const al = parseAutolink(s, j);
      if (al) { j = al[2]; continue; }
      const h = parseInlineHtml(s, j);
      if (h) { j = h[1]; continue; }
      j++; continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return j;
      depth--;
    }
    j++;
  }
  return -1;
}

// Try to parse a link/image whose '[' is at s[i]. image=true for '!['.
// Returns {node, next} or null. defs: Map of link reference definitions.
function tryLink(s, i, defs, image) {
  const n = s.length;
  const end = findLinkEnd(s, i);
  if (end < 0) return null;
  const text = s.slice(i + 1, end);
  // A LINK text must not contain an unescaped '[' that opens a nested
  // link (that kills the outer link). This rule does not apply to an
  // IMAGE: its description may contain link syntax (it is rendered as
  // plain text for the alt attribute).
  if (!image && text.indexOf('[') >= 0) {
    let from = 0;
    while (true) {
      const inner = text.indexOf('[', from);
      if (inner < 0) break;
      from = inner + 1;
      let bs = 0;
      for (let q = inner - 1; q >= 0 && text[q] === '\\'; q--) bs++;
      if (bs % 2 === 1) continue; // escaped '[': literal, skip
      let isImage = false;
      if (inner > 0 && text[inner - 1] === '!') {
        let bs2 = 0;
        for (let q = inner - 2; q >= 0 && text[q] === '\\'; q--) bs2++;
        if (bs2 % 2 === 0) isImage = true;
      }
      if (!isImage && tryLink(s, i + 1 + inner, defs, false)) return null;
    }
  }
  let j = end + 1;
  let dest = null, title = null;
  let inlineDone = false;
  if (j < n && s[j] === '(') {
    // inline link; on any failure fall through to the reference forms
    // (e.g. [foo](not a link) falls back to shortcut reference [foo])
    let k = skipWs(s, j + 1, true);
    if (k < n && s[k] === ')') {
      dest = ''; j = k + 1; inlineDone = true;
    } else {
      const d = parseDest(s, k);
      if (d) {
        dest = d[0]; k = d[1];
        k = skipWs(s, k, true);
        let ok = true;
        if (k < n && s[k] !== ')') {
          const t = parseTitle(s, k);
          if (!t) ok = false;
          else { title = t[0]; k = t[1]; k = skipWs(s, k, true); }
        }
        if (ok && k < n && s[k] === ')') { j = k + 1; inlineDone = true; }
      }
    }
  }
  if (!inlineDone) {
    // reference forms
    let label = null;
    if (j < n && s[j] === '[') {
      const e2 = s.indexOf(']', j + 1);
      if (e2 < 0) return null;
      label = e2 === j + 1 ? text : s.slice(j + 1, e2);
      j = e2 + 1;
    } else {
      label = text;
      j = end + 1;
    }
    const def = defs.get(normLabel(label));
    if (!def) return null;
    dest = def.dest; title = def.title;
  }
  dest = unescapeBackslash(dest);
  if (title !== null && title !== undefined) title = unescapeBackslash(title);
  // link text must not contain links or autolinks (no nested <a>);
  // image alt text keeps links parsed so plainText can extract them
  const kids = parseInline(text, defs, !image);
  if (image) {
    const alt = plainText(kids);
    return { node: { g: { src: dest, title: title, alt: alt } }, next: j };
  }
  return { node: { l: { href: dest, title: title, kids: kids } }, next: j };
}

// Plain-text rendering of inline nodes (for image alt text).
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (typeof nd === 'string') out += nd;
    else if (nd.c !== undefined) out += nd.c;
    else if (nd.l) out += plainText(nd.l.kids);
    else if (nd.g) out += nd.g.alt;
    else if (nd.e) out += plainText(nd.e);
    else if (nd.t) out += plainText(nd.t);
    else if (nd.s) out += plainText(nd.s);
    else if (nd.d) out += nd.d.ch.repeat(nd.d.n);
    else if (nd.b) out += '\n';
  }
  return out;
}

// Trim trailing punctuation off a www/email autolink per GFM rules.
function trimAutolinkEnd(s) {
  let end = s.length;
  while (end > 0) {
    const c = s[end - 1];
    if (c === '?' || c === '!' || c === '.' || c === ',' || c === ':' || c === ';' || c === '*' || c === '_' || c === '~') { end--; continue; }
    if (c === ')') {
      // drop if unbalanced: count parens BEFORE this trailing ')'
      // (excluding the ')' itself); keep it only if an unmatched '('
      // precedes it
      let depth = 0;
      for (let i = 0; i < end - 1; i++) {
        if (s[i] === '(') depth++;
        else if (s[i] === ')') depth--;
      }
      if (depth <= 0) { end--; continue; }
    }
    break;
  }
  return s.slice(0, end);
}

// Try a www. autolink starting at s[i]. Returns [url, nextIndex] or null.
function parseWwwAutolink(s, i) {
  if (!s.startsWith('www.', i)) return null;
  const n = s.length;
  let j = i + 4;
  // domain: labels of [A-Za-z0-9-] separated by '.', at least one dot total
  let labels = 0, hasDot = false;
  while (j < n) {
    const st = j;
    while (j < n && LABEL_CH[s.charCodeAt(j)]) j++;
    if (j === st) break;
    labels++;
    if (j < n && s[j] === '.') { hasDot = true; j++; continue; }
    break;
  }
  if (!hasDot || labels < 2) return null;
  // optional path: GFM path chars, stopping before a named entity (&name;
  // other than &amp;)
  const k = scanAutolinkPath(s, j);
  let url = trimAutolinkEnd(s.slice(i, k));
  if (url.length === 0) return null;
  return [url, i + url.length];
}

// Try an email autolink starting at s[i]. Returns [email, nextIndex] or null.
function parseEmailAutolink(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && EMAIL_LOCAL[s.charCodeAt(j)]) j++;
  if (j === i || j >= n || s[j] !== '@') return null;
  // local part must not start/end with '.' and no '..'
  const local = s.slice(i, j);
  if (local[0] === '.' || local[local.length - 1] === '.' || local.indexOf('..') >= 0) return null;
  let k = j + 1;
  const dstart = k;
  while (k < n && DOMAIN_CH[s.charCodeAt(k)]) k++;
  // a '_' right after the domain means the word continues: not an email
  if (k < n && s[k] === '_') return null;
  let dom = s.slice(dstart, k);
  // a trailing '.' is a separator left over; a trailing '-' makes the
  // last domain label malformed, so the whole thing is not an email
  while (dom.length > 0 && dom[dom.length - 1] === '.') dom = dom.slice(0, -1);
  if (dom.length === 0 || dom[dom.length - 1] === '-') return null;
  const parts = dom.split('.');
  if (parts.length < 2) return null;
  for (const p of parts) {
    if (p.length === 0 || p[0] === '-' || p[p.length - 1] === '-') return null;
  }
  const email = local + '@' + dom;
  return [email, i + email.length];
}

// Scan an autolink path (query/fragment/path chars) starting at s[i].
// Stops before a `&` that begins a named entity reference (other than
// `&amp;`): such an entity is not part of the URL. Numeric entities and
// `&` not followed by `;` are part of the URL. Returns the end index.
function scanAutolinkPath(s, i) {
  const n = s.length;
  let k = i;
  while (k < n) {
    const c = s[k];
    if (c === '&') {
      // named entity? &name; where name is letters/digits
      let j = k + 1;
      if (j < n && s[j] !== '#') {
        const st = j;
        while (j < n && isAlphaNum(s[j])) j++;
        if (j > st && j < n && s[j] === ';') {
          const name = s.slice(st, j);
          if (name !== 'amp') return k;
        }
      }
      k++; continue;
    }
    if (PATH_CH[s.charCodeAt(k)]) { k++; continue; }
    break;
  }
  return k;
}

// Try a scheme autolink starting at s[i] (a letter). Returns [url, nextIndex]
// or null. A scheme is 2-32 chars (letter, then letters/digits/+/-/.),
// followed by ':' and then either '//' + domain + path (hierarchical) or
// an email address with an optional single /resource (mailto:/xmpp:).
function parseSchemeAutolink(s, i) {
  const n = s.length;
  const c0 = s.charCodeAt(i);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return null;
  let j = i + 1;
  while (j < n && SCHEME_CH[s.charCodeAt(j)]) j++;
  const schemeLen = j - i;
  if (schemeLen < 2 || schemeLen > 32) return null;
  if (j >= n || s[j] !== ':') return null;
  const afterColon = j + 1;
  // hierarchical: scheme://domain[/path...]
  if (s.startsWith('//', afterColon)) {
    let k = afterColon + 2;
    // domain: labels of [A-Za-z0-9-] separated by '.', at least one label
    let labels = 0;
    while (k < n) {
      const st = k;
      while (k < n && LABEL_CH[s.charCodeAt(k)]) k++;
      if (k === st) break;
      labels++;
      if (k < n && s[k] === '.') {
        // a '.' only continues the domain if another label follows
        if (k + 1 < n && LABEL_CH[s.charCodeAt(k + 1)]) { k++; continue; }
        break;
      }
      break;
    }
    if (labels < 1) return null;
    // optional path (covers :port, /path, ?query, #frag)
    const pend = scanAutolinkPath(s, k);
    let url = s.slice(i, pend);
    url = trimAutolinkEnd(url);
    if (url.length === 0) return null;
    return [url, i + url.length];
  }
  // non-hierarchical: scheme:local@domain[/resource]
  const em = parseEmailAutolink(s, afterColon);
  if (!em) return null;
  let end = em[1];
  // optional single /resource segment (no '/', '?', '#' inside)
  if (end < n && s[end] === '/') {
    let k = end + 1;
    const st = k;
    while (k < n && PATHSEG_CH[s.charCodeAt(k)]) k++;
    if (k > st) {
      const seg = trimAutolinkEnd(s.slice(end, k));
      if (seg.length > 1) end = end + seg.length;
    }
  }
  const url = s.slice(i, end);
  return [url, end];
}

// Main inline scan: text -> node list.
function parseInline(s, defs, noLink) {
  const n = s.length;
  const nodes = [];
  let buf = '';
  const flush = () => { if (buf !== '') { nodes.push(buf); buf = ''; } };
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        flush(); nodes.push({ b: 1 }); i += 2;
        // a hard break eats the next line's leading whitespace
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        continue;
      }
      if (nx !== undefined && isPunct(nx)) {
        // an escaped '&' is a literal '&' and must be escaped, never
        // merged with following text into an entity reference
        if (nx === '&') { flush(); nodes.push('&'); }
        else buf += nx;
        i += 2; continue;
      }
      buf += '\\'; i++; continue;
    }
    if (c === '`') {
      const cs = parseCodeSpan(s, i);
      if (cs) { flush(); nodes.push({ c: cs[0] }); i = cs[1]; continue; }
      // no matching closer run: the whole backtick run is literal text
      // (a shorter run inside it must not pair with a later backtick)
      let j = i;
      while (j < n && s[j] === '`') j++;
      buf += s.slice(i, j); i = j; continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const r = tryLink(s, i + 1, defs, true);
      if (r) { flush(); nodes.push(r.node); i = r.next; continue; }
      buf += '!'; i++; continue;
    }
    if (c === '[') {
      if (!noLink) {
        const r = tryLink(s, i, defs, false);
        if (r) { flush(); nodes.push(r.node); i = r.next; continue; }
      }
      buf += '['; i++; continue;
    }
    if (c === '<') {
      // angle-bracket autolinks are allowed even inside link text
      // (marked nests them); bare www/scheme/email autolinks are not
      const al = parseAutolink(s, i);
      if (al) { flush(); nodes.push({ l: { href: al[0], title: null, kids: [al[1]], autolink: true } }); i = al[2]; continue; }
      const h = parseInlineHtml(s, i);
      if (h) { flush(); nodes.push({ h: h[0] }); i = h[1]; continue; }
      buf += '<'; i++; continue;
    }
    if (c === '&') {
      // only numeric references decode; named ones pass through verbatim
      // (escText leaves a valid &word; reference unescaped). A numeric
      // reference decoding to '&' is a literal '&': keep it in its own
      // node so it cannot merge with following text into an entity.
      const d = decodeNumericEntityAt(s, i);
      if (d) {
        if (d[0] === '&') { flush(); nodes.push('&'); }
        else buf += d[0];
        i += d[1]; continue;
      }
      buf += '&'; i++; continue;
    }
    if (c === '*' || c === '_') {
      let j = i;
      while (j < n && s[j] === c) j++;
      const run = j - i;
      const [lf, rf] = flanking(s, i, j);
      let canOpen, canClose;
      if (c === '*') { canOpen = lf; canClose = rf; }
      else {
        canOpen = lf && (!rf || isUnicodePunct(i > 0 ? s[i - 1] : ''));
        canClose = rf && (!lf || isUnicodePunct(j < n ? s[j] : ''));
      }
      flush();
      nodes.push({ d: { ch: c, n: run, canOpen: canOpen, canClose: canClose } });
      i = j; continue;
    }
    if (c === '~') {
      let j = i;
      while (j < n && s[j] === '~') j++;
      // strikethrough delimiter: a run of exactly 1 or 2 tildes.
      // A run of 3+ is literal text.
      if (j - i >= 1 && j - i <= 2) {
        const [lf, rf] = flanking(s, i, j);
        flush();
        nodes.push({ d: { ch: '~', n: j - i, canOpen: lf, canClose: rf } });
        i = j; continue;
      }
      buf += s.slice(i, j); i = j; continue;
    }
    if (c === '\n') {
      // hard break when preceded by 2+ spaces (in buf) or handled above
      if (buf.length >= 2 && buf[buf.length - 1] === ' ' && buf[buf.length - 2] === ' ') {
        buf = buf.replace(/ +$/, '');
        flush(); nodes.push({ b: 1 });
        i++;
        // a hard break eats the next line's leading whitespace
        while (i < n && (s[i] === ' ' || s[i] === '\t')) i++;
        continue;
      } else {
        buf += '\n';
      }
      i++; continue;
    }
    // extended autolinks: www. at a word start, email anywhere a local part starts
    if (!noLink && c === 'w' && s.startsWith('www.', i)) {
      const prev = i > 0 ? s[i - 1] : '';
      if (prev === '' || isUnicodeWs(prev) || isUnicodePunct(prev)) {
        const w = parseWwwAutolink(s, i);
        if (w) {
          flush();
          nodes.push({ l: { href: 'http://' + w[0], title: null, kids: [w[0]], autolink: true } });
          i = w[1]; continue;
        }
      }
    }
    if (!noLink && EMAIL_LOCAL[c.charCodeAt(0)]) {
      // scheme autolink (http://, mailto:, xmpp:, ...) at a word start:
      // try it before the bare email, so `mailto:foo@bar.baz` links whole
      const cc = c.charCodeAt(0);
      if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)) {
        const prev = i > 0 ? s[i - 1] : '';
        if (prev === '' || isUnicodeWs(prev) || isUnicodePunct(prev)) {
          const sc = parseSchemeAutolink(s, i);
          if (sc) {
            flush();
            nodes.push({ l: { href: sc[0], title: null, kids: [sc[0]], autolink: true } });
            i = sc[1]; continue;
          }
        }
      }
      const em = parseEmailAutolink(s, i);
      if (em) {
        flush();
        nodes.push({ l: { href: 'mailto:' + em[0], title: null, kids: [em[0]], autolink: true } });
        i = em[1]; continue;
      }
    }
    buf += c; i++;
  }
  flush();
  processEmphasis(nodes);
  return nodes;
}

// CommonMark emphasis resolution over the node list (in place).
function processEmphasis(nodes) {
  const stack = [];
  for (const nd of nodes) if (nd.d) stack.push(nd);
  for (let ci = 0; ci < stack.length; ci++) {
    const closer = stack[ci];
    if (!closer.d || !closer.d.canClose || closer.d.n === 0) continue;
    let oi = ci - 1;
    while (oi >= 0) {
      const opener = stack[oi];
      if (!opener.d || opener.d.n === 0 || !opener.d.canOpen || opener.d.ch !== closer.d.ch) { oi--; continue; }
      // odd-match rule
      if ((opener.d.canOpen && opener.d.canClose) || (closer.d.canOpen && closer.d.canClose)) {
        const sum = opener.d.n + closer.d.n;
        if (sum % 3 === 0 && !(opener.d.n % 3 === 0 && closer.d.n % 3 === 0)) { oi--; continue; }
      }
      const use = (opener.d.n >= 2 && closer.d.n >= 2) ? 2 : 1;
      // (strikethrough accepts use 1 or 2; both make <del>)
      // wrap nodes between opener and closer
      const oiPos = nodes.indexOf(opener);
      const ciPos = nodes.indexOf(closer);
      if (oiPos < 0 || ciPos < 0 || ciPos - oiPos < 2) { oi--; continue; }
      const kids = nodes.slice(oiPos + 1, ciPos);
      let node;
      if (closer.d.ch === '~') node = { s: kids };
      else node = use === 2 ? { t: kids } : { e: kids };
      nodes.splice(oiPos + 1, ciPos - oiPos - 1, node);
      opener.d.n -= use;
      closer.d.n -= use;
      if (opener.d.n === 0) {
        const p = nodes.indexOf(opener);
        if (p >= 0) nodes.splice(p, 1);
        stack.splice(oi, 1);
        ci--;
        oi--; // opener consumed: move to the previous opener
      }
      if (closer.d.n === 0) {
        const p = nodes.indexOf(closer);
        if (p >= 0) nodes.splice(p, 1);
        stack.splice(ci, 1);
        ci--;
        break;
      }
      // if the opener still has delimiters left, retry the SAME
      // opener-closer pair (it can match again, e.g. *** -> <em><strong>)
      // instead of moving on; no oi-- here.
    }
  }
}

// Render inline nodes to HTML.
function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (typeof nd === 'string') out += escText(nd);
    else if (nd.c !== undefined) out += '<code>' + escCode(nd.c) + '</code>';
    else if (nd.h !== undefined) out += nd.h;
    else if (nd.b) out += '<br>';
    else if (nd.d) out += escText(nd.d.ch.repeat(nd.d.n));
    else if (nd.e) out += '<em>' + renderInline(nd.e) + '</em>';
    else if (nd.t) out += '<strong>' + renderInline(nd.t) + '</strong>';
    else if (nd.s) out += '<del>' + renderInline(nd.s) + '</del>';
    else if (nd.l) {
      const href = cleanUrl(nd.l.href);
      if (href === null) { out += renderInline(nd.l.kids); continue; }
      out += '<a href="' + escAttr(href) + '"';
      if (nd.l.title !== null && nd.l.title !== undefined) out += ' title="' + escAttr(nd.l.title) + '"';
      out += '>' + renderInline(nd.l.kids) + '</a>';
    } else if (nd.g) {
      const src = cleanUrl(nd.g.src);
      if (src === null) { out += escText(nd.g.alt); continue; }
      out += '<img src="' + escAttr(src) + '" alt="' + escAttr(nd.g.alt) + '"';
      if (nd.g.title !== null && nd.g.title !== undefined) out += ' title="' + escAttr(nd.g.title) + '"';
      out += '>';
    }
  }
  return out;
}

// ---- block parsing --------------------------------------------------------
// Tree builder following the CommonMark reference algorithm: a stack of open
// containers; each input line is matched against the containers, then either
// continues the open leaf block or starts a new block.

function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Columns of leading whitespace (space=1, tab=to next multiple of 4).
function indentOf(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Remove a list marker (at `lead` spaces in, `markerWidth` wide) plus the
// whitespace after it, up to `contentIndent` columns. A tab straddling the
// boundary becomes the spaces that remain.
function stripContentIndent(line, lead, markerWidth, contentIndent) {
  let col = lead + markerWidth;
  let i = lead + markerWidth;
  while (i < line.length && col < contentIndent) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= contentIndent) { col += w; i++; }
      else return ' '.repeat(col + w - contentIndent) + line.slice(i + 1);
    } else break;
  }
  return line.slice(i);
}

// Remove `n` columns of leading indent; a tab straddling the boundary
// becomes the spaces that remain.
function stripIndent(s, n) {
  let col = 0, i = 0;
  while (i < s.length && col < n) {
    const c = s[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else return ' '.repeat(col + w - n) + s.slice(i + 1);
    } else break;
  }
  return s.slice(i);
}

// Strip up to 3 leading spaces (no tabs) for block-start matching.
function stripUpTo3(s) {
  let i = 0;
  while (i < s.length && i < 3 && s[i] === ' ') i++;
  return s.slice(i);
}

// The last open leaf block of the container at stack[d], or null.
function openLeaf(container) {
  const kids = container.node.children;
  if (!kids || kids.length === 0) return null;
  const last = kids[kids.length - 1];
  if (last.open === false) return null;
  if (last.t === 'para' || last.t === 'fcode' || last.t === 'icode' || last.t === 'html' || last.t === 'table') return last;
  return null;
}

// Close (mark not open) every container above depth d, finalising leaves.
function closeAbove(stack, d) {
  for (let k = stack.length - 1; k > d; k--) {
    const c = stack[k];
    finalizeContainer(c.node);
    c.node.open = false;
    stack.pop();
  }
  const leaf = openLeaf(stack[d]);
  if (leaf) finalizeLeaf(leaf);
}

function finalizeLeaf(leaf) {
  leaf.open = false;
  if (leaf.t === 'para') {
    // trim trailing blank lines (they are separators, not content)
    while (leaf.lines.length > 0 && isBlank(leaf.lines[leaf.lines.length - 1])) leaf.lines.pop();
  }
  if (leaf.t === 'icode') {
    while (leaf.lines.length > 0 && isBlank(leaf.lines[leaf.lines.length - 1])) leaf.lines.pop();
  }
  if (leaf.t === 'fcode') {
    // strip trailing exactly-empty lines (a whitespace-only last line
    // is content and is kept)
    while (leaf.lines.length > 0 && leaf.lines[leaf.lines.length - 1] === '') leaf.lines.pop();
  }
}

function finalizeContainer(node) {
  if (!node.children) return;
  const last = node.children[node.children.length - 1];
  if (last && last.open !== false && (last.t === 'para' || last.t === 'fcode' || last.t === 'icode' || last.t === 'html' || last.t === 'table')) {
    finalizeLeaf(last);
  }
}

// Mark every open container in the stack as having seen a blank line (for
// list tight/loose detection).
function markBlank(stack) {
  for (const c of stack) c.blank = true;
}

// ---- block-start detectors ------------------------------------------------
function isSetextLine(s) {
  const t = stripUpTo3(s);
  if (t.length === 0) return 0;
  const c = t[0];
  if (c !== '=' && c !== '-') return 0;
  // a contiguous run of the char, then only trailing spaces/tabs
  let i = 0;
  while (i < t.length && t[i] === c) i++;
  while (i < t.length && (t[i] === ' ' || t[i] === '\t')) i++;
  if (i !== t.length) return 0;
  return c === '=' ? 1 : 2;
}

// Split a table row on unescaped pipes; drop empty first/last cells.
function splitRow(s) {
  const cells = [];
  let cur = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    // In a table cell, `\|` is an escaped pipe: it becomes a literal `|`
    // in the cell content (before inline parsing, so it is `|` even
    // inside a code span). `\\` stays two chars so the inline parser
    // turns it into a single backslash.
    if (c === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (c === '\\' && i + 1 < s.length && s[i + 1] === '\\') { cur += c + s[i + 1]; i += 2; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

// Is `s` a table delimiter row? Returns alignments array or null.
function tableDelim(s) {
  const t = stripUpTo3(s);
  // a delimiter row may have at most 3 leading spaces; stripUpTo3 leaves
  // a leading space/tab behind when the indent is 4+
  if (t.length === 0 || t[0] === ' ' || t[0] === '\t') return null;
  const cells = splitRow(t);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    if (/^:?-+:?$/.test(cell)) {
      aligns.push(cell[0] === ':' ? (cell[cell.length - 1] === ':' ? 'center' : 'left') : (cell[cell.length - 1] === ':' ? 'right' : null));
    } else return null;
  }
  return aligns;
}

// Parse a link reference definition from stripped lines starting at `lines[i]`.
// Returns {dest, title, consumed} or null.
// Find the ']' closing a definition label starting at s[i] === '['.
// Skips code spans and escaped chars, but does NOT count '[' depth: a
// label ends at the first unescaped ']' (so a label containing '[' can
// never be followed by ':' and is not a definition). Returns the index
// of ']' or -1.
function findLabelEnd(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '`') {
      const cs = parseCodeSpan(s, j);
      if (cs) { j = cs[1]; continue; }
      j++; continue;
    }
    if (c === ']') return j;
    j++;
  }
  return -1;
}

function parseDef(lines, i) {
  // Join the candidate lines with \n. The label, destination and title
  // may each span lines, but a blank line ends the definition.
  const first = lines[i];
  const s = stripUpTo3(first);
  if (s[0] !== '[') return null;
  const text = s + lines.slice(i + 1).map((l) => '\n' + l).join('');
  const end = findLabelEnd(text, 0);
  if (end < 0) return null;
  const label = text.slice(1, end);
  if (label.length === 0 || label.length > 999 || normLabel(label) === '') return null;
  // a label must not contain an unescaped '[' outside a code span
  {
    let q = 0;
    let bad = false;
    while (q < label.length) {
      const ch = label[q];
      if (ch === '\\' && q + 1 < label.length) { q += 2; continue; }
      if (ch === '`') {
        const cs = parseCodeSpan(label, q);
        if (cs) { q = cs[1]; continue; }
        q++; continue;
      }
      if (ch === '[') { bad = true; break; }
      q++;
    }
    if (bad) return null;
  }
  let pos = end + 1;
  if (text[pos] !== ':') return null;
  pos++;
  // Skip whitespace (spaces, tabs, newlines) but not across a blank line.
  const skipWs = (p) => {
    while (p < text.length) {
      const c = text[p];
      if (c === ' ' || c === '\t') { p++; continue; }
      if (c === '\n') {
        let q = p + 1;
        while (q < text.length && (text[q] === ' ' || text[q] === '\t')) q++;
        if (q >= text.length || text[q] === '\n') return -1;
        p = q;
        continue;
      }
      break;
    }
    return p;
  };
  const lineOf = (p) => {
    let n = 0;
    for (let k = 0; k < p; k++) if (text[k] === '\n') n++;
    return n;
  };
  pos = skipWs(pos);
  if (pos < 0 || pos >= text.length) return null;
  const d = parseDest(text, pos);
  if (!d) return null;
  let dest = d[0];
  const destEnd = d[1];
  const destLine = lineOf(destEnd);
  let title = null;
  let endPos = destEnd;
  const p = skipWs(destEnd);
  if (p < 0) {
    // a blank line follows the destination: dest-only definition
    endPos = destEnd;
  } else if (p < text.length && (text[p] === '"' || text[p] === "'" || text[p] === '(')) {
    if (p === destEnd) return null; // no whitespace between dest and title
    const titleLine = lineOf(p);
    const t = parseTitle(text, p);
    if (t) {
      let q = t[1];
      while (q < text.length && (text[q] === ' ' || text[q] === '\t')) q++;
      if (q >= text.length || text[q] === '\n') {
        title = t[0];
        endPos = t[1];
      } else if (titleLine === destLine) {
        return null; // garbage after a title on the dest's line
      } else {
        endPos = destEnd; // malformed title on a later line: dest-only
      }
    } else if (titleLine === destLine) {
      return null; // unclosed title on the dest's line
    } else {
      endPos = destEnd; // unclosed title on a later line: dest-only
    }
  } else if (p < text.length) {
    // non-title content after the destination
    if (lineOf(p) === destLine) return null;
    endPos = destEnd;
  }
  const consumed = lineOf(endPos) + 1;
  dest = unescapeBackslash(dest);
  if (title !== null) title = unescapeBackslash(title);
  return { label: normLabel(label), dest: dest, title: title, consumed: consumed };
}

// Fence info: s starts with a run of ` or ~. Returns {ch, len, info} or null.
function fenceStart(s) {
  const t = stripUpTo3(s);
  const ch = t[0];
  if (ch !== '`' && ch !== '~') return null;
  let i = 0;
  while (i < t.length && t[i] === ch) i++;
  if (i < 3) return null;
  const info = t.slice(i);
  if (ch === '`' && info.indexOf('`') >= 0) return null;
  return { ch: ch, len: i, info: info.trim(), indent: s.length - t.length };
}

function isClosingFence(s, fence) {
  const t = stripUpTo3(s);
  if (t[0] !== fence.ch) return false;
  let i = 0;
  while (i < t.length && t[i] === fence.ch) i++;
  if (i < fence.len) return false;
  for (let j = i; j < t.length; j++) {
    if (t[j] !== ' ' && t[j] !== '\t') return false;
  }
  return true;
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// HTML block start: returns {type, endMarker} or null. type 1-5 end at a
// marker line; 6-7 end at a blank line. `canInterrupt` says whether this
// type may interrupt a paragraph.
function htmlBlockStart(s) {
  const t = stripUpTo3(s);
  if (t[0] !== '<') return null;
  const rest = t.slice(1);
  const lower = t.toLowerCase();
  if (lower.startsWith('<pre') || lower.startsWith('<script') || lower.startsWith('<style') || lower.startsWith('<textarea')) {
    const after = t.slice(1 + (lower.startsWith('<pre') ? 3 : lower.startsWith('<script') ? 6 : lower.startsWith('<style') ? 5 : 8));
    if (after === '' || after[0] === ' ' || after[0] === '\t' || after[0] === '>' || after.startsWith('/>')) {
      const name = lower.startsWith('<pre') ? 'pre' : lower.startsWith('<script') ? 'script' : lower.startsWith('<style') ? 'style' : 'textarea';
      return { type: 1, end: '</' + name + '>' };
    }
    return null;
  }
  if (t.startsWith('<!--')) return { type: 2, end: '-->' };
  if (t.startsWith('<?')) return { type: 3, end: '?>' };
  if (t.startsWith('<!') && t.length > 2 && ((t.charCodeAt(2) >= 65 && t.charCodeAt(2) <= 90) || (t.charCodeAt(2) >= 97 && t.charCodeAt(2) <= 122))) return { type: 4, end: '>' };
  if (t.startsWith('<![CDATA[')) return { type: 5, end: ']]>' };
  // tag name
  let j = 0, closing = false;
  if (rest[0] === '/') { closing = true; j = 1; }
  if (j >= rest.length) return null;
  const rc0 = rest.charCodeAt(j);
  if (!((rc0 >= 65 && rc0 <= 90) || (rc0 >= 97 && rc0 <= 122))) return null;
  const nameStart = j;
  while (j < rest.length && LABEL_CH[rest.charCodeAt(j)]) j++;
  const name = rest.slice(nameStart, j).toLowerCase();
  const after = rest[j];
  if (after !== undefined && after !== ' ' && after !== '\t' && after !== '>' && after !== '/') return null;
  if (BLOCK_TAGS.has(name)) return { type: 6, end: null };
  // type 7: a complete (valid) tag alone on the line. Validate the tag
  // with the same attribute rules as inline HTML; a malformed tag such
  // as <a h*#ref="hi"> is not an HTML block.
  const tag = parseInlineHtml(t, 0);
  if (!tag) return null;
  if (t.slice(tag[1]).trim() !== '') return null;
  return { type: 7, end: null };
}

// Does `s` start a block that can interrupt a paragraph? Returns 'atx' |
// 'fence' | 'hr' | 'html' | 'bq' | 'list' or null.
function interruptStart(s) {
  const t = stripUpTo3(s);
  if (t[0] === '#') {
    let i = 0;
    while (i < t.length && t[i] === '#') i++;
    if (i >= 1 && i <= 6 && (i === t.length || t[i] === ' ' || t[i] === '\t')) return 'atx';
  }
  if (fenceStart(s)) return 'fence';
  if (/^([*_-])([ \t]*\1){2,}[ \t]*$/.test(t)) return 'hr';
  const hb = htmlBlockStart(s);
  if (hb && hb.type !== 7) return 'html';
  if (t[0] === '>') return 'bq';
  const m = listMarker(s);
  if (m) {
    if (m.ordered) { if (m.start === 1 && !m.empty) return 'list'; }
    else if (!m.empty) return 'list';
  }
  return null;
}

// List marker info for a line, or null. `s` is the container-stripped line.
function listMarker(s) {
  const t = stripUpTo3(s);
  const lead = s.length - t.length;
  let i = 0, ordered = false, bullet = '', start = 0, delim = '';
  if (t[0] === '-' || t[0] === '+' || t[0] === '*') {
    bullet = t[0]; i = 1;
  } else if (/[0-9]/.test(t[0] || '')) {
    let j = 0;
    while (j < t.length && /[0-9]/.test(t[j])) j++;
    if (j > 9 || j === 0) return null;
    if (t[j] !== '.' && t[j] !== ')') return null;
    ordered = true; start = parseInt(t.slice(0, j), 10); delim = t[j]; i = j + 1;
  } else return null;
  // whitespace after the marker
  const markerEndCol = lead + i;
  let col = markerEndCol, k = i;
  while (k < t.length && (t[k] === ' ' || t[k] === '\t')) {
    if (t[k] === ' ') col++;
    else col += 4 - (col % 4);
    k++;
    if (col - markerEndCol >= 5) break;
  }
  const wsCols = col - markerEndCol;
  let empty = false, contentIndent;
  if (k >= t.length) { empty = true; contentIndent = markerEndCol + 1; }
  else if (wsCols === 0) return null; // no space after marker
  else if (wsCols >= 5) contentIndent = markerEndCol + 1;
  else contentIndent = col;
  return { ordered: ordered, bullet: bullet, delim: delim, start: start, empty: empty, contentIndent: contentIndent, markerWidth: i, lead: lead };
}

// Strip a raw line through the current container stack; null on failure.
function stripThrough(line, stack) {
  let rest = line;
  for (let k = 1; k < stack.length; k++) {
    const r = stack[k].match(rest);
    if (r === null) return null;
    rest = r;
  }
  return rest;
}

function buildTree(lines, defs, endsWithNL) {
  const doc = { t: 'doc', children: [] };
  const stack = [{ node: doc, match: (r) => r, blank: false }];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    // --- match containers. Once the line has become blank by stripping
    // a container's prefix, it matches every deeper container (the leaf
    // sees the fully stripped blank line). A line that is blank from the
    // start only matches a container whose match accepts it (a blockquote
    // needs its `>`; a list accepts a blank line; an item needs indent).
    let rest = raw, d = 0;
    const rawBlank = isBlank(raw);
    for (let k = 1; k < stack.length; k++) {
      if (isBlank(rest) && !rawBlank) { d = k; continue; }
      const r = stack[k].match(rest);
      if (r === null) break;
      rest = r; d = k;
    }
    if (d < stack.length - 1) {
      // a fenced code block swallows its content lines even when they
      // do not match an enclosing LIST item's indent (e.g. a 0-indent
      // line inside a fenced block in a list item). But a line that
      // lacks a blockquote '>' prefix ends the blockquote (and the
      // code block inside it), and a non-blank line that follows a
      // blank line inside the code block also ends it (the list item
      // is over; the blank is stripped as trailing).
      const tipLeaf = openLeaf(stack[stack.length - 1]);
      const failC = stack[d + 1];
      const failIsBq = failC && failC.node && failC.node.t === 'bq';
      const lastWasBlank = tipLeaf && tipLeaf.lines.length > 0 && isBlank(tipLeaf.lines[tipLeaf.lines.length - 1]);
      if (tipLeaf && tipLeaf.t === 'fcode' && !failIsBq && (isBlank(rest) || !lastWasBlank)) {
        // fall through to the leaf loop with cur = rest
      } else {
        // a fenced block that ends right after a blank line drops that
        // trailing blank line from its content
        if (tipLeaf && tipLeaf.t === 'fcode' && lastWasBlank) {
          while (tipLeaf.lines.length > 0 && isBlank(tipLeaf.lines[tipLeaf.lines.length - 1])) tipLeaf.lines.pop();
        }
        // lazy continuation: the deepest open leaf is a paragraph and the
        // line (after stripping the containers that did match) does not
        // start a block that can interrupt a paragraph -> it joins the
        // paragraph. Inside a blockquote, a lazy line with >= 4 columns
        // of indent has 4 columns stripped, and a lazy line that looks
        // like a setext underline following another lazy line is indented
        // by 4 spaces so it stays paragraph text.
        const leaf = openLeaf(stack[stack.length - 1]);
        if (leaf && leaf.t === 'para' && !isBlank(rest) && !interruptStart(rest) && !listMarker(rest)) {
          let line = rest;
          if (stack[stack.length - 1].node.t === 'bq') {
            if (leaf.lastLazy && isSetextLine(line)) {
              line = '    ' + line.replace(/^[ ]+/, '');
            } else if (indentOf(line) >= 4) {
              line = stripIndent(line, 4);
            }
          }
          leaf.lines.push(line);
          leaf.lastLazy = true;
          i++;
          continue;
        }
        closeAbove(stack, d);
      }
    }
    // --- process `rest` in container stack[d]; opening a container
    // reprocesses the remainder in the new context ---
    let cur = rest;
    let extraLines = 0;
    let handled = false;
    while (!handled) {
      const top = stack[stack.length - 1];
      const leaf = openLeaf(top);
      if (leaf) {
        if (leaf.t === 'fcode') {
          if (isClosingFence(cur, leaf.fence)) finalizeLeaf(leaf);
          // up to N spaces of indentation are removed from each content
          // line, where N is the leading fence's indent
          else leaf.lines.push(stripIndent(cur, leaf.indent || 0));
          handled = true;
        } else if (leaf.t === 'icode') {
          if (isBlank(cur)) { leaf.lines.push(stripIndent(cur, 4)); handled = true; }
          else if (indentOf(cur) >= 4) { leaf.lines.push(stripIndent(cur, 4)); handled = true; }
          else finalizeLeaf(leaf); // fall through to new-block logic
        } else if (leaf.t === 'html') {
          if (leaf.endsAtBlank && isBlank(cur)) {
            // an html block ending at a blank line has no trailing newline
            leaf.trail = false;
            finalizeLeaf(leaf); markBlank(stack); handled = true;
          } else {
            leaf.lines.push(cur);
            if (leaf.end && cur.toLowerCase().indexOf(leaf.end) >= 0) {
              // trailing newline unless the next line is blank in this
              // container's context (or the source ends without one)
              const nx = lines[i + 1];
              const st = nx === undefined ? null : stripThrough(nx, stack);
              leaf.trail = nx === undefined ? endsWithNL : !(st !== null && isBlank(st));
              finalizeLeaf(leaf);
            }
            handled = true;
          }
        } else if (leaf.t === 'para') {
          if (isBlank(cur)) { finalizeLeaf(leaf); markBlank(stack); handled = true; }
          else {
            const se = isSetextLine(cur);
            if (se) {
              leaf.t = 'head'; leaf.level = se;
              // setext heading content: paragraph lines joined, leading
              // and trailing whitespace stripped
              leaf.text = leaf.lines.join('\n').trim();
              delete leaf.lines; finalizeLeaf(leaf); handled = true;
            } else {
              let done = false;
              if (leaf.lines.length === 1) {
                const aligns = tableDelim(cur);
                if (aligns) {
                  const headerCells = splitRow(leaf.lines[0]);
                  if (headerCells.length === aligns.length) {
                    leaf.t = 'table'; leaf.aligns = aligns;
                    leaf.header = headerCells; leaf.rows = [];
                    delete leaf.lines; handled = true; done = true;
                  }
                }
              }
              if (!done) {
                // an ordered list not starting with 1 cannot interrupt
                // a paragraph at document level, but it CAN start a
                // nested list inside a list item
                let intr = interruptStart(cur);
                if (!intr) {
                  const mm = listMarker(cur);
                  const topNode = stack[stack.length - 1].node;
                  if (mm && mm.ordered && !mm.empty && topNode.t === 'item') intr = 'list';
                }
                if (intr) finalizeLeaf(leaf); // fall through
                else { leaf.lines.push(cur); leaf.lastLazy = false; handled = true; }
              }
            }
          }
        } else if (leaf.t === 'table') {
          // a line that is exactly one tab is a table row of empty
          // cells, not a blank line ending the table
          if (isBlank(cur) && cur !== '\t') { finalizeLeaf(leaf); markBlank(stack); handled = true; }
          else if (interruptStart(cur)) finalizeLeaf(leaf); // fall through
          else { leaf.rows.push(cur); handled = true; }
        }
      } else if (isBlank(cur)) {
        markBlank(stack);
        handled = true;
      }
      if (!handled) {
        // A list can only hold items. If the line is a thematic break
        // (which can look like a list marker, e.g. `* * *`) while the
        // top container is a list, close the list and reprocess the
        // line in the parent container. A genuine (even empty) list
        // marker is handled by startNewBlock's list branch.
        const topC = stack[stack.length - 1];
        if (topC.node.t === 'list' && /^([*_-])([ \t]*\1){2,}[ \t]*$/.test(stripUpTo3(cur))) {
          closeAbove(stack, stack.length - 2);
          continue;
        }
        const r = startNewBlock(cur, stack, lines, i, defs, endsWithNL);
        if (r.extra) { extraLines = r.extra; handled = true; }
        else if (r.cur !== undefined) { cur = r.cur; }
        else handled = true;
      }
    }
    i += 1 + extraLines;
  }
  closeAbove(stack, 0);
  return doc;
}

// Start a new block from `cur` in the deepest container. Returns
// {extra} when the line is consumed (extra = further lines consumed, e.g.
// by a link definition), {cur} when a container was opened and the
// remainder must be reprocessed, or {} when the line is consumed.
function startNewBlock(cur, stack, lines, i, defs, endsWithNL) {
  const cont = stack[stack.length - 1];
  const node = cont.node;
  // A blank line seen since the last block started in this container makes
  // the enclosing list loose when a new block starts after it.
  const noteBlank = () => {
    if (cont.blank && node.children.length > 0 && node.t === 'item' && node.list) node.list.loose = true;
    cont.blank = false;
  };
  // indented code
  if (indentOf(cur) >= 4) {
    noteBlank();
    node.children.push({ t: 'icode', lines: [stripIndent(cur, 4)], open: true });
    return {};
  }
  const s = stripUpTo3(cur);
  // link reference definition
  if (s[0] === '[') {
    const stripped = [cur];
    // a definition's label, destination and title may each span lines;
    // gather following lines until a blank line (which ends a definition)
    for (let k = 1; k < 10 && i + k < lines.length; k++) {
      const st = stripThrough(lines[i + k], stack);
      if (st === null) break;
      stripped.push(st);
      if (isBlank(st)) break;
    }
    const def = parseDef(stripped, 0);
    if (def) {
      if (!defs.has(def.label)) defs.set(def.label, { dest: def.dest, title: def.title });
      return { extra: def.consumed - 1 };
    }
  }
  // ATX heading
  let n = 0;
  while (n < s.length && s[n] === '#') n++;
  if (n >= 1 && n <= 6 && (n === s.length || s[n] === ' ' || s[n] === '\t')) {
    noteBlank();
    // strip a closing sequence of #s first (it is preceded by space/tab,
    // which includes the space after the opening sequence, so a heading
    // whose whole content is #s is empty), then trim the content
    let content = s.slice(n);
    const m = content.match(/^(.*?)[ \t]+#+[ \t]*$/);
    if (m) content = m[1];
    content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    node.children.push({ t: 'head', level: n, text: content, open: false });
    return {};
  }
  // fenced code
  const f = fenceStart(cur);
  if (f) {
    noteBlank();
    node.children.push({ t: 'fcode', fence: f, info: f.info, indent: f.indent, lines: [], open: true });
    return {};
  }
  // thematic break
  if (/^([*_-])([ \t]*\1){2,}[ \t]*$/.test(s)) {
    noteBlank();
    node.children.push({ t: 'hr', open: false });
    return {};
  }
  // HTML block
  const hb = htmlBlockStart(cur);
  if (hb) {
    noteBlank();
    const leaf = { t: 'html', lines: [cur], end: hb.end, endsAtBlank: hb.end === null, open: true };
    node.children.push(leaf);
    if (hb.end && cur.toLowerCase().indexOf(hb.end) >= 0) {
      const nx = lines[i + 1];
      const st = nx === undefined ? null : stripThrough(nx, stack);
      leaf.trail = nx === undefined ? endsWithNL : !(st !== null && isBlank(st));
      finalizeLeaf(leaf);
    }
    return {};
  }
  // blockquote
  if (s[0] === '>') {
    noteBlank();
    let r = s.slice(1);
    if (r[0] === ' ') r = r.slice(1);
    const bq = { t: 'bq', children: [], open: true };
    node.children.push(bq);
    stack.push({ node: bq, match: (line) => {
      const t2 = stripUpTo3(line);
      if (t2[0] !== '>') return null;
      let rr = t2.slice(1);
      // column of rr[0] in the original line
      let col = (line.length - t2.length) + 1;
      if (rr[0] === ' ') { rr = rr.slice(1); col++; }
      // a tab right after '>' (or after the optional space) expands to
      // spaces measured from its column
      if (rr[0] === '\t') {
        const w = 4 - (col % 4);
        rr = ' '.repeat(w) + rr.slice(1);
      }
      return rr;
    }, blank: false });
    return { cur: r };
  }
  // list
  const m = listMarker(cur);
  if (m) {
    const kids = node.children;
    const last = kids.length ? kids[kids.length - 1] : null;
    const compatible = (l) => l && l.t === 'list' && l.open !== false &&
      l.ordered === m.ordered &&
      (m.ordered ? l.delim === m.delim : l.bullet === m.bullet);
    // the container itself may be the open list (its item was just closed),
    // otherwise the last child may be one
    let list = compatible(node) ? node : (compatible(last) ? last : null);
    if (!list) {
      noteBlank();
      list = { t: 'list', ordered: m.ordered, start: m.start, delim: m.delim, bullet: m.bullet, children: [], loose: false, open: true };
      kids.push(list);
      const listNode = list;
      const listEntryObj = { node: list, match: null, blank: false };
      listEntryObj.match = (line) => {
        if (isBlank(line)) return line;
        const items = listNode.children;
        if (items.length > 0) {
          const lastItem = items[items.length - 1];
          const ci = lastItem.contentIndent;
          // an empty item cannot be continued after a blank line: the
          // blank line ends it, so a following indented line is a new
          // block outside the list
          if (!(lastItem.children.length === 0 && listEntryObj.blank) && indentOf(line) >= ci) return line;
        }
        const mm = listMarker(line);
        if (mm && mm.ordered === listNode.ordered &&
            (mm.ordered ? mm.delim === listNode.delim : mm.bullet === listNode.bullet)) return line;
        return null;
      };
      stack.push(listEntryObj);
    }
    let listEntry = stack[stack.length - 1];
    if (listEntry.node !== list) listEntry = stack.find((e) => e.node === list) || listEntry;
    if (listEntry.blank && list.children.length > 0) list.loose = true;
    listEntry.blank = false;
    const item = { t: 'item', children: [], task: null, list: list, contentIndent: m.contentIndent, open: true };
    list.children.push(item);
    const ci = m.contentIndent;
    const itemEntryObj = { node: item, match: null, blank: false };
    itemEntryObj.match = (line) => {
      // a blank line never closes a list item (it only makes the list
      // loose); the item is closed by the next non-matching line.
      // Exception: an empty item is ended by a blank line, so a
      // following indented line cannot continue it.
      if (isBlank(line)) return line;
      if (item.children.length === 0 && itemEntryObj.blank) return null;
      if (indentOf(line) >= ci) {
        const r = stripIndent(line, ci);
        // a tab starting exactly at the content-indent boundary expands
        // to spaces (its width from this column)
        if (r[0] === '\t') return ' '.repeat(4 - (ci % 4)) + r.slice(1);
        return r;
      }
      return null;
    };
    stack.push(itemEntryObj);
    let rem = stripContentIndent(cur, m.lead, m.markerWidth, ci);
    // task list: [ ] / [x] / [X] followed by content on the same line.
    // The checkbox makes the item's first block a paragraph.
    if (!m.empty && rem[0] === '[' && (rem[1] === ' ' || rem[1] === 'x' || rem[1] === 'X') && rem[2] === ']') {
      let k = 3;
      while (k < rem.length && (rem[k] === ' ' || rem[k] === '\t')) k++;
      if (k < rem.length) {
        item.task = rem[1] === ' ' ? 'unchecked' : 'checked';
        rem = rem.slice(3);
        item.children.push({ t: 'para', lines: [rem], open: true });
        return {};
      }
    }
    if (isBlank(rem)) return {};
    return { cur: rem };
  }
  // paragraph
  noteBlank();
  node.children.push({ t: 'para', lines: [cur], open: true });
  return {};
}

// ---- rendering ------------------------------------------------------------
function renderBlocks(node, defs) {
  let out = '';
  for (const b of node.children) out += renderBlock(b, defs);
  return out;
}

function renderBlock(b, defs) {
  switch (b.t) {
    case 'para':
      return '<p>' + renderInline(parseInline(b.lines.join('\n'), defs)) + '</p>\n';
    case 'head':
      return '<h' + b.level + '>' + renderInline(parseInline(b.text, defs)) + '</h' + b.level + '>\n';
    case 'hr':
      return '<hr>\n';
    case 'icode': {
      const text = b.lines.join('\n');
      return '<pre><code>' + escCode(text) + (text === '' ? '' : '\n') + '</code></pre>\n';
    }
    case 'fcode': {
      const text = b.lines.join('\n');
      let cls = '';
      if (b.info !== '') {
        const lang = unescapeBackslash(b.info.split(/[ \t]+/)[0]);
        cls = ' class="language-' + escAttr(lang) + '"';
      }
      return '<pre><code' + cls + '>' + escCode(text) + (text === '' ? '' : '\n') + '</code></pre>\n';
    }
    case 'html':
      // trailing newline: explicit flag wins; otherwise a block that ends
      // at a blank line (types 6/7) has none, a block with an end
      // condition (types 1-5) has one
      return b.lines.join('\n') + (b.trail !== undefined ? (b.trail ? '\n' : '') : (b.endsAtBlank ? '' : '\n'));
    case 'bq':
      return '<blockquote>\n' + renderBlocks(b, defs) + '</blockquote>\n';
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const item of b.children) out += renderItem(item, b.loose, defs);
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < b.header.length; k++) {
        const a = b.aligns[k];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(parseInline(b.header[k], defs)) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length > 0) {
        out += '<tbody>';
        for (const row of b.rows) {
          const cells = splitRow(row);
          out += '<tr>\n';
          for (let k = 0; k < b.header.length; k++) {
            const c = k < cells.length ? cells[k] : '';
            const a = b.aligns[k];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + renderInline(parseInline(c, defs)) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}

function renderItem(item, loose, defs) {
  let out = '<li>';
  const kids = item.children;
  if (item.task) {
    const box = item.task === 'checked'
      ? '<input checked="" disabled="" type="checkbox">'
      : '<input disabled="" type="checkbox">';
    if (kids.length > 0 && kids[0].t === 'para') {
      const inner = renderInline(parseInline(kids[0].lines.join('\n'), defs));
      if (loose) out += '<p>' + box + inner + '</p>\n';
      else out += box + inner;
      for (let k = 1; k < kids.length; k++) out += renderChild(kids[k], loose, defs);
      return out + '</li>\n';
    }
    out += box;
  }
  for (const k of kids) out += renderChild(k, loose, defs);
  return out + '</li>\n';
}

function renderChild(b, loose, defs) {
  if (b.t === 'para' && !loose) {
    return renderInline(parseInline(b.lines.join('\n'), defs));
  }
  return renderBlock(b, defs);
}

// Entry point: render `markdown` exactly as marked 18.1.3 with defaults.
export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const endsWithNL = src.endsWith('\n');
  let lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const defs = new Map();
  const tree = buildTree(lines, defs, endsWithNL);
  // An html block that is the last block of the document and was never
  // given an explicit trailing-newline flag mirrors whether the source
  // ends with a newline.
  let last = tree;
  while (last.children && last.children.length > 0) last = last.children[last.children.length - 1];
  if (last.t === 'html' && last.trail === undefined) last.trail = endsWithNL;
  return renderBlocks(tree, defs);
}
