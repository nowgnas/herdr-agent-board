import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { shared, setShared, readTextFile, exec, run, theme, settings, checking, window } from "herdr";
import { parseDiffLines, segmentsOf, highlightRange, truncateText, utf8Length, diffView, longestLine, maxScrollX } from "./diff.js";
import { DIFF_MAX_CHARS, DIFF_MAX_LINES, VIRTUAL_MIN_ROWS } from "./_common/limits.js";
import { wheelScroll, scrollThumb } from "./_common/virtual.js";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
// 가상 스크롤 diff의 고정 행 높이와 12px 고정폭 글꼴의 대략적인 글자 폭(가로 스크롤 범위 추정)
// FONT_SIZE: diff 행 글자 크기(가로 스크롤 폭 계산에도 같은 값을 씁니다)
const ROW_H = 17, FONT_SIZE = 12, GUTTER_W = 100;
const SH_NAME = "board-preview";

// 원격(on)이거나 Windows가 아니면 sh가 있다고 보고, 읽는 단계에서 head -c로 용량을 제한합니다.
const useShell = on => Boolean(on) || window()?.platform !== "windows";
// head -c로 자른 출력: 바이트 상한을 넘었으면 잘린 마지막 반쪽 줄을 버리고 truncated 표시.
function capped(out) {
  if (utf8Length(out) <= DIFF_MAX_CHARS) return { text: out, truncated: false };
  return { text: truncateText(out, Math.min(out.length - 1, DIFF_MAX_CHARS)).text, truncated: true };
}

async function readDiff(selection) {
  const args = ["-c", "core.quotepath=false", "diff", "HEAD", "--", selection.path];
  const opts = { cwd: selection.root, on: selection.on };
  if (useShell(selection.on)) {
    try {
      const r = await exec("sh", ["-c", 'limit=$1; shift; git "$@" 2>/dev/null | head -c "$limit"', SH_NAME, String(DIFF_MAX_CHARS + 1), ...args], opts);
      if (r.code === 0) return r.stdout.trim() ? capped(r.stdout) : null;
    } catch {}
  }
  const result = await exec("git", args, opts).catch(() => null);
  return result?.code === 0 && result.stdout.trim() ? truncateText(result.stdout, DIFF_MAX_CHARS) : null;
}

// 상한보다 큰 파일만 head -c로 앞부분을 읽고, 그 밖에는 기존처럼 readTextFile.
async function readFileLimited(path, on) {
  if (useShell(on)) {
    try {
      const size = await exec("sh", ["-c", '[ -f "$1" ] && wc -c < "$1"', SH_NAME, path], { on });
      if (size.code === 0 && Number(size.stdout.trim()) > DIFF_MAX_CHARS) {
        const head = await exec("sh", ["-c", 'head -c "$2" "$1"', SH_NAME, path, String(DIFF_MAX_CHARS + 1)], { on });
        if (head.code === 0) return { text: capped(head.stdout).text, truncated: true };
      }
    } catch {}
  }
  const text = await readTextFile(path, { on });
  return text === null ? null : truncateText(text, DIFF_MAX_CHARS);
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
    this.diffTruncated = false;
    this.lineLimit = DIFF_MAX_LINES;
    this.scroll = 0; this.scrollX = 0; this.maxCells = 0;
    this.error = null;
    this.isDiff = false;
    if (!selection?.root || !selection?.path || checking()) return;
    const wantDiff = Boolean(selection.diffable) && !this.preferFull;
    cx.spawn(async cx => {
      try {
        // 읽는 단계에서 DIFF_MAX_CHARS로 제한(큰 출력을 통째로 받아 두지 않음)
        let read = null, isDiff = false;
        if (wantDiff) {
          read = await readDiff(selection).catch(() => null);
          isDiff = Boolean(read);
        }
        if (!isDiff) read = await readFileLimited(`${selection.root}/${selection.path}`, selection.on);
        if (this.key !== key || JSON.stringify(shared("board.preview")) !== key) return;
        if (read === null) { this.error = wantDiff ? "삭제되었거나 더 이상 존재하지 않는 파일입니다" : "This file is no longer available"; return; }
        const { text, truncated } = read;
        if (!isDiff && text.includes("\0")) { this.error = "Binary file · no text preview"; return; }
        const ext = selection.path.includes(".") ? selection.path.split(".").pop().toLowerCase() : "txt";
        this.isDiff = isDiff;
        if (isDiff) {
          this.diffExt = ext;
          this.diffTruncated = truncated;
          this.diffLines = parseDiffLines(text);
          // 하이라이트는 여기서 한 번만(행 상한까지). 그 뒤 줄은 처음 보일 때 한 번 계산해 캐시.
          highlightRange(this.diffLines, ext, 0, this.lineLimit);
          this.maxCells = longestLine(this.diffLines, this.lineLimit);
        } else {
          const t = theme();
          this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
            value: truncated ? text + "\n… (file truncated)" : text,
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

  segColor(kind, t) {
    return kind === "comment" ? t.dim : kind === "string" ? t.ansi2 : kind === "number" ? t.ansi1
      : kind === "keyword" ? t.ansi5 : kind === "func" ? t.ansi4 : kind === "type" ? t.ansi3 : null;
  }

  // i: a stable key (the line's index in this.diffLines) so GPUI can track each
  // absolutely-positioned virtual row across renders — without it, repositioning
  // on scroll isn't reliably picked up (rows can appear to "stick" in place).
  diffRow(line, t, fixed = false, i = 0) {
    const font = settings().font_family;
    if (line.type === "hunk") return div().id(`diff-row-${i}`).flex_none().px(8).py(2).bg(t.raised).text_color(t.dim).text_size(10).font_family(font).whitespace_nowrap().when(fixed, el => el.h(ROW_H).py(0)).child(line.text);
    if (line.type === "meta") return div().id(`diff-row-${i}`).flex_none().px(8).text_color(t.dim).text_size(9).font_family(font).whitespace_nowrap().when(fixed, el => el.h(ROW_H)).child(line.text);
    const bg = line.type === "add" ? `${t.ansi2}22` : line.type === "remove" ? `${t.ansi1}22` : null;
    const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
    const markerColor = line.type === "add" ? t.ansi2 : line.type === "remove" ? t.ansi1 : t.dim;
    const segs = segmentsOf(line, this.diffExt);
    let row = h_flex().id(`diff-row-${i}`).flex_none().h(ROW_H).gap(6).items_center().pl(4).whitespace_nowrap().text_size(FONT_SIZE).font_family(font);
    if (bg) row = row.bg(bg);
    return row
      .child(div().flex_none().w(32).text_right().text_size(9).text_color(t.dim).child(line.oldLine ? String(line.oldLine) : ""))
      .child(div().flex_none().w(32).text_right().text_size(9).text_color(t.dim).child(line.newLine ? String(line.newLine) : ""))
      .child(div().flex_none().w(8).text_color(markerColor).child(marker))
      .child(h_flex().flex_none().gap(0).children(segs.map(s => { const color = this.segColor(s.kind, t); return div().child(s.text || " ").when(Boolean(color), el => el.text_color(color)); })));
  }

  // 행 상한 초과("+N줄 더")·용량 절단 표시. 작은 diff에서는 아무것도 더하지 않습니다.
  diffFooter(t, hidden) {
    if (!hidden && !this.diffTruncated) return null;
    return h_flex().flex_none().px(10).py(5).gap(8).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
      .when(hidden > 0, el => el.child(div().id("board-preview-more").px(6).py(2).rounded(4).cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { this.lineLimit += DIFF_MAX_LINES; this.maxCells = longestLine(this.diffLines, this.lineLimit); cx.notify(); })
        .child(`+${hidden.toLocaleString()}줄 더`)))
      .when(this.diffTruncated, el => el.child(div().flex_1().min_w(0).truncate()
        .child(`diff가 ${DIFF_MAX_CHARS.toLocaleString()}자에서 잘렸습니다`)));
  }

  renderDiff(t) {
    const count = Math.min(this.diffLines.length, this.lineLimit), hidden = this.diffLines.length - count;
    const footer = this.diffFooter(t, hidden);
    if (count <= VIRTUAL_MIN_ROWS) {
      const list = v_flex().flex_1().min_h(0).overflow_y_scrollbar().overflow_x_scrollbar().py(4)
        .children(this.diffLines.slice(0, count).map((line, i) => this.diffRow(line, t, false, i)));
      return footer ? v_flex().flex_1().min_h(0).child(list).child(footer) : list;
    }
    // 가상 스크롤: 화면에 보이는 행(+overscan)만 만들고 나머지는 위치만 계산합니다.
    const viewport = this.viewH ?? 600, width = this.viewW ?? 800;
    const view = diffView(this.diffLines, { limit: this.lineLimit, rowHeight: ROW_H, viewport, scroll: this.scroll, ext: this.diffExt });
    this.scroll = view.window.scroll;
    const maxX = maxScrollX({ cells: this.maxCells, fontSize: FONT_SIZE, gutter: GUTTER_W, width });
    this.scrollX = Math.max(0, Math.min(this.scrollX, maxX));
    const thumb = scrollThumb({ scroll: view.window.scroll, viewport, total: view.window.total });
    const maxScroll = view.window.maxScroll;
    const list = div().id("board-preview-diff").flex_1().min_h(0).relative().overflow_hidden()
      .on_size_change((size, cx) => {
        const zoom = settings().zoom || 1, h = size.height / zoom, w = size.width / zoom;
        if (h !== this.viewH || w !== this.viewW) { this.viewH = h; this.viewW = w; cx.notify(); }
      })
      .on_scroll_wheel((e, cx) => {
        const dy = e.delta?.y ?? 0, dx = e.delta?.x ?? 0;
        if (e.modifiers?.shift && !dx) this.scrollX = Math.max(0, Math.min(this.scrollX - dy, maxX));
        else {
          this.scroll = wheelScroll(this.scroll, dy, maxScroll);
          if (dx) this.scrollX = Math.max(0, Math.min(this.scrollX - dx, maxX));
        }
        cx.notify();
      })
      .children(view.rows.map(r => this.diffRow(r.item, t, true, r.index).absolute().top(r.top).left(-this.scrollX).min_w(width + this.scrollX)))
      .when(Boolean(thumb), el => el.child(div().absolute().right(1).w(5).rounded(3).bg(t.border).top(thumb.top).h(thumb.height)));
    return v_flex().flex_1().min_h(0).child(list).when(Boolean(footer), el => el.child(footer));
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
