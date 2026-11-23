import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { shared, setShared, readTextFile, exec, run, theme, settings, checking } from "herdr";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };

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
function highlightLine(line, ext, t) {
  const re = tokenRegex(ext);
  re.lastIndex = 0;
  const segments = [];
  let last = 0, m;
  while ((m = re.exec(line))) {
    if (m.index > last) segments.push({ text: line.slice(last, m.index), color: null });
    const kind = Object.keys(m.groups).find(k => m.groups[k] !== undefined);
    const color = kind === "comment" ? t.dim : kind === "string" ? t.ansi2 : kind === "number" ? t.ansi1
      : kind === "keyword" ? t.ansi5 : kind === "func" ? t.ansi4 : kind === "type" ? t.ansi3 : null;
    segments.push({ text: m[0], color });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < line.length) segments.push({ text: line.slice(last), color: null });
  return segments;
}

// Strips the file-header noise (we already show the path in our own header
// bar) and tracks old/new line numbers through each hunk.
function parseDiffLines(diffText) {
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

export default class Preview extends View {
  load(selection, cx) {
    const key = JSON.stringify(selection);
    const fileKey = selection ? `${selection.root}\n${selection.path}\n${selection.on ?? ""}` : null;
    if (fileKey !== this.fileKey) this.preferFull = false; // selecting a different file resets the diff/full choice
    this.fileKey = fileKey;
    this.key = key;
    this.code?.release();
    this.code = null;
    this.diffLines = null;
    this.diffExt = null;
    this.error = null;
    this.isDiff = false;
    if (!selection?.root || !selection?.path || checking()) return;
    const wantDiff = Boolean(selection.diffable) && !this.preferFull;
    cx.spawn(async cx => {
      try {
        let text = null, isDiff = false;
        if (wantDiff) {
          const result = await exec("git", ["-c", "core.quotepath=false", "diff", "HEAD", "--", selection.path], { cwd: selection.root, on: selection.on }).catch(() => null);
          if (result?.code === 0 && result.stdout.trim()) { text = result.stdout; isDiff = true; }
        }
        if (!isDiff) text = await readTextFile(`${selection.root}/${selection.path}`, { on: selection.on });
        if (this.key !== key || JSON.stringify(shared("board.preview")) !== key) return;
        if (text === null) { this.error = wantDiff ? "삭제되었거나 더 이상 존재하지 않는 파일입니다" : "This file is no longer available"; return; }
        if (!isDiff && text.includes("\0")) { this.error = "Binary file · no text preview"; return; }
        const ext = selection.path.includes(".") ? selection.path.split(".").pop().toLowerCase() : "txt";
        this.isDiff = isDiff;
        if (isDiff) {
          this.diffExt = ext;
          this.diffLines = parseDiffLines(text.length > 400000 ? text.slice(0, 400000) : text);
        } else {
          const t = theme();
          this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
            value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
            font_family: settings().font_family, font_size: 12,
            syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        }
      } catch {
        if (this.key === key) this.error = "Cannot preview this file (binary, too large, or unreadable)";
      } finally { cx.notify(); }
    });
  }

  toggle(selection, cx) {
    this.preferFull = !this.preferFull;
    this.load(selection, cx);
  }

  diffRow(line, t) {
    const font = settings().font_family;
    if (line.type === "hunk") return div().flex_none().px(8).py(2).bg(t.raised).text_color(t.dim).text_size(10).font_family(font).whitespace_nowrap().child(line.text);
    if (line.type === "meta") return div().flex_none().px(8).text_color(t.dim).text_size(9).font_family(font).whitespace_nowrap().child(line.text);
    const bg = line.type === "add" ? `${t.ansi2}22` : line.type === "remove" ? `${t.ansi1}22` : null;
    const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
    const markerColor = line.type === "add" ? t.ansi2 : line.type === "remove" ? t.ansi1 : t.dim;
    const segs = highlightLine(line.text, this.diffExt, t);
    let row = h_flex().flex_none().h(17).gap(6).items_center().pl(4).whitespace_nowrap().text_size(12).font_family(font);
    if (bg) row = row.bg(bg);
    return row
      .child(div().flex_none().w(32).text_right().text_size(9).text_color(t.dim).child(line.oldLine ? String(line.oldLine) : ""))
      .child(div().flex_none().w(32).text_right().text_size(9).text_color(t.dim).child(line.newLine ? String(line.newLine) : ""))
      .child(div().flex_none().w(8).text_color(markerColor).child(marker))
      .child(h_flex().flex_none().gap(0).children(segs.map(s => div().child(s.text || " ").when(Boolean(s.color), el => el.text_color(s.color)))));
  }

  renderDiff(t) {
    return v_flex().flex_1().min_h(0).overflow_y_scrollbar().overflow_x_scrollbar().py(4)
      .children(this.diffLines.map(line => this.diffRow(line, t)));
  }

  render(cx) {
    const selection = shared("board.preview"), t = theme();
    if (JSON.stringify(selection) !== this.key) this.load(selection, cx);
    return v_flex().size_full().min_h(0).rounded(7).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground)
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).tooltip(selection?.path ?? "").child(selection?.path ?? "File"))
        .when(Boolean(selection?.diffable), el => el.child(div().id("board-preview-toggle").px(7).py(3).rounded(4).cursor_pointer().text_size(11).text_color(t.dim)
          .hover(s => s.bg(t.hover)).tooltip(this.isDiff || this.preferFull ? "" : "diff 보기로 전환")
          .on_click((_e, cx) => this.toggle(selection, cx)).child(this.preferFull ? "Diff 보기" : "전체 파일 보기")))
        .child(div().id("board-preview-close").px(8).py(4).rounded(4).cursor_pointer().hover(s => s.bg(t.hover))
          .tooltip("파일 미리보기 닫기").on_click(() => { setShared("board.preview", null); run("layout.hide", { id: "board-preview" }); }).child("×")))
      .child(this.isDiff && this.diffLines ? this.renderDiff(t)
        : this.code ? Editor.new(this.code).flex_1().min_h(0)
        : div().p(12).text_size(12).text_color(t.dim).child(this.error || (selection ? "Loading file…" : "Select a file")));
  }
}
