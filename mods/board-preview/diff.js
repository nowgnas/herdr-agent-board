// board-preview의 순수 로직: diff 파싱, 줄 단위 하이라이트(캐시), 읽기 상한 절단,
// 행 상한과 보이는 행 계산. herdr/gpui에 의존하지 않아 node --test로 검사합니다.
import { visibleWindow } from "./_common/virtual.js";

// The real syntax grammar (Editor/EditorState) only covers whole-file mode.
// A unified diff is rendered line-by-line with our own +/- backgrounds, so it
// needs its own lightweight, per-line highlighter — not a full grammar, just
// enough to color strings/comments/numbers/keywords so a diff doesn't read as
// a flat wall of text.
const HASH_COMMENT = new Set(["py", "rb", "sh", "bash", "zsh", "fish", "yml", "yaml", "toml", "pl", "r", "ex", "exs", "nim", "dockerfile", "makefile", "conf", "ini"]);
const SQL_COMMENT = new Set(["sql"]);
const HTML_COMMENT = new Set(["html", "htm", "xml", "svelte", "vue"]);
const NO_COMMENT = new Set(["json", "md", "txt", "csv"]);
function commentPattern(ext) {
  if (HTML_COMMENT.has(ext)) return "<!--.*?-->";
  if (HASH_COMMENT.has(ext)) return "#.*$";
  if (SQL_COMMENT.has(ext)) return "--.*$";
  if (NO_COMMENT.has(ext)) return null;
  return "//.*$";
}
const KEYWORDS = ["if", "else", "elif", "for", "foreach", "while", "do", "return", "function", "func", "fn", "def", "class", "struct",
  "interface", "implements", "extends", "import", "from", "export", "default", "const", "let", "var", "new", "this", "self", "try",
  "except", "catch", "finally", "throw", "raise", "switch", "case", "break", "continue", "async", "await", "public", "private",
  "protected", "static", "void", "null", "none", "nil", "undefined", "true", "false", "typeof", "instanceof", "in", "of", "as",
  "with", "lambda", "yield", "match", "pass", "global", "nonlocal", "package", "namespace", "using", "include", "require", "super",
  "is", "not", "and", "or"];
const KEYWORD_SRC = `\\b(?:${KEYWORDS.join("|")})\\b`;
const KINDS = ["comment", "string", "number", "keyword", "func", "type"];
const regexCache = new Map();
function tokenRegex(ext) {
  if (regexCache.has(ext)) return regexCache.get(ext);
  const comment = commentPattern(ext);
  const alts = [];
  if (comment) alts.push(`(?<comment>${comment})`);
  alts.push('(?<string>"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)');
  alts.push("(?<number>\\b\\d+(?:\\.\\d+)?\\b)");
  alts.push(`(?<keyword>${KEYWORD_SRC})`);
  alts.push("(?<func>\\b[a-zA-Z_$][\\w$]*(?=\\())");
  alts.push("(?<type>\\b[A-Z][A-Za-z0-9_]*\\b)");
  const re = new RegExp(alts.join("|"), "g");
  regexCache.set(ext, re);
  return re;
}

// 테마와 무관한 { text, kind } 세그먼트. 색은 렌더할 때 kind → 테마 색으로 바꿉니다.
export function highlightTokens(line, ext) {
  const re = tokenRegex(ext);
  re.lastIndex = 0;
  const segments = [];
  let last = 0, m;
  while ((m = re.exec(line))) {
    if (m.index > last) segments.push({ text: line.slice(last, m.index), kind: null });
    const kind = KINDS.find(k => m.groups[k] !== undefined) ?? null;
    segments.push({ text: m[0], kind });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < line.length) segments.push({ text: line.slice(last), kind: null });
  return segments;
}

// 한 줄의 하이라이트를 줄 객체에 캐시해, 렌더마다 다시 계산하지 않습니다.
export function segmentsOf(line, ext) {
  if (line.segs && line.segsExt === ext) return line.segs;
  line.segs = highlightTokens(line.text, ext);
  line.segsExt = ext;
  return line.segs;
}

export function highlightRange(lines, ext, start, end) {
  for (let i = Math.max(0, start); i < Math.min(lines.length, end); i++) segmentsOf(lines[i], ext);
}

// Strips the file-header noise (we already show the path in our own header
// bar) and tracks old/new line numbers through each hunk.
export function parseDiffLines(diffText) {
  const lines = diffText.replace(/\n$/, "").split("\n");
  const out = [];
  let oldLine = 0, newLine = 0;
  for (const raw of lines) {
    if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); out.push({ type: "hunk", text: raw }); continue; }
    if (raw.startsWith("\\ No newline")) { out.push({ type: "meta", text: raw }); continue; }
    if (raw.startsWith("+")) { out.push({ type: "add", text: raw.slice(1), newLine: newLine++ }); continue; }
    if (raw.startsWith("-")) { out.push({ type: "remove", text: raw.slice(1), oldLine: oldLine++ }); continue; }
    out.push({ type: "context", text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
  }
  return out;
}

// UTF-8 바이트 수(head -c 로 자른 출력이 상한을 넘었는지 판단할 때 사용).
export function utf8Length(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// max자를 넘으면 자르고, 잘린 마지막 반쪽 줄은 버립니다(줄바꿈이 없으면 글자 단위).
export function truncateText(text, max) {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  return { text: nl >= 0 ? cut.slice(0, nl + 1) : cut, truncated: true };
}

export function limitLines(lines, limit) {
  return lines.length > limit ? { shown: lines.slice(0, limit), hidden: lines.length - limit } : { shown: lines, hidden: 0 };
}

// 행 상한(limit)과 스크롤 위치로, 실제로 만들 행만 고르고 그 행만 하이라이트합니다.
export function diffView(lines, { limit, rowHeight, viewport, scroll, overscan = 6, ext }) {
  const count = Math.min(lines.length, limit);
  const window = visibleWindow({ count, rowHeight, viewport, scroll, overscan });
  const rows = [];
  for (let i = window.start; i < window.end; i++) {
    const item = lines[i];
    if (item.type !== "hunk" && item.type !== "meta") segmentsOf(item, ext);
    rows.push({ item, index: i, top: i * rowHeight - window.scroll });
  }
  return { rows, window, count, hidden: lines.length - count };
}

// 가장 긴 줄 길이(가로 스크롤 범위 추정용).
export function longestLine(lines, limit = lines.length) {
  let n = 0;
  for (let i = 0; i < Math.min(limit, lines.length); i++) if (lines[i].text.length > n) n = lines[i].text.length;
  return n;
}
