// IntelliJ's Cmd+Shift+F ("Find in Path"): plain-text search across every
// file in the focused space's repo (ripgrep when available, else grep),
// respecting .gitignore. Results list on the left; the right side shows the
// lines around whichever result is selected (↑/↓), so you can read the hit
// in context without leaving the popup. Enter/click a result opens the full
// file in board-preview and closes the popup. Bound to
// mod.open:board-find-in-path in keys.json.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, run, setShared, theme, props, closeOverlay, checking } from "herdr";

function location() {
  const space = spaces().find(s => s.active), focus = focused();
  const pane = panes().find(p => p.pane === focus?.pane);
  return { cwd: pane?.cwd || focus?.cwd || space?.folder || "", machine: space?.machine ?? null };
}

const RESULT_LIMIT = 500;
const DEBOUNCE_MS = 200;
const CONTEXT_BEFORE = 9, CONTEXT_AFTER = 9;

// "path:line:content" — split on the first ":<digits>:" so a path containing
// its own colons still parses.
function parseLine(line) {
  const m = /^(.*?):(\d+):(.*)$/.exec(line);
  if (!m) return null;
  return { path: m[1].startsWith("./") ? m[1].slice(2) : m[1], line: Number(m[2]), text: m[3] };
}

// Splits text into {text, hit} runs so the matched substring can be colored
// differently — every (case-insensitive) occurrence, not just the first.
function highlightSegments(text, query) {
  if (!query) return [{ text, hit: false }];
  const hay = text.toLowerCase(), needle = query.toLowerCase();
  const segs = [];
  let i = 0;
  while (i < text.length) {
    const idx = hay.indexOf(needle, i);
    if (idx === -1) { segs.push({ text: text.slice(i), hit: false }); break; }
    if (idx > i) segs.push({ text: text.slice(i, idx), hit: false });
    segs.push({ text: text.slice(idx, idx + query.length), hit: true });
    i = idx + query.length;
  }
  return segs.length ? segs : [{ text, hit: false }];
}

export default class FindInPath extends View {
  init(_props, cx) {
    this.input = InputState.new({ placeholder: "경로 내 텍스트 검색…" });
    this.input.on("change", (_e, cx) => { this.at = 0; this.listScroll.scroll_to_item(0); this.search(cx); });
    this.input.on("submit", (_e, cx) => this.open(this.rows()[this.at ?? 0], cx));
    this.input.focus();
    cx.timer.after(50, () => this.input.focus());
    this.at = 0;
    this.matches = null; // null = no query typed yet
    this.error = null;
    this.root = null;
    this.gen = 0;
    this.context = null; // { path, line, rows: [{num, text, isMatch}] }
    this.contextKey = null;
    this.contextError = null;
    this.listScroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.resolveRoot(cx);
  }

  resolveRoot(cx) {
    const loc = location();
    if (loc.machine) { this.error = "원격 스페이스는 지원하지 않습니다"; cx.notify(); return; }
    if (!loc.cwd || checking()) return;
    cx.spawn(async cx => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: loc.cwd });
        this.root = top.code === 0 ? top.stdout.trim() : loc.cwd;
      } catch { this.root = loc.cwd; }
      const q = this.input.value().trim();
      if (q) this.run(q, this.gen, cx);
      cx.notify();
    });
  }

  search(cx) {
    const query = this.input.value().trim();
    const gen = ++this.gen;
    if (!query) { this.matches = null; this.error = null; cx.notify(); return; }
    cx.timer.after(DEBOUNCE_MS, cx => {
      if (gen !== this.gen) return;
      this.run(query, gen, cx);
    });
  }

  run(query, gen, cx) {
    if (!this.root) return; // resolveRoot() re-fires this once it has a root
    cx.spawn(async cx => {
      try {
        let result = await exec(
          "rg", ["--line-number", "--no-heading", "--color", "never", "--fixed-strings", "--max-count", "200", "--", query, "."],
          { cwd: this.root },
        ).catch(() => null);
        if (!result) {
          // No rg: search only regular tracked/untracked-but-not-ignored files (git
          // ls-files), not a raw `grep -r .` — that also tries to read sockets, device
          // files, etc. sitting in the repo (e.g. herdr-app.sock) and grep errors out
          // on those instead of just skipping them.
          const ls = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: this.root });
          if (ls.code !== 0) throw new Error("파일 목록을 가져올 수 없습니다");
          const files = ls.stdout.split("\0").filter(Boolean).slice(0, 5000);
          result = files.length ? await exec("grep", ["-nF", "--", query, ...files], { cwd: this.root }) : { code: 1, stdout: "", stderr: "" };
        }
        if (gen !== this.gen) return;
        if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || "검색 실패");
        const matches = [];
        for (const line of result.stdout.split("\n")) {
          if (!line) continue;
          const m = parseLine(line);
          if (m) matches.push(m);
          if (matches.length >= RESULT_LIMIT) break;
        }
        this.matches = matches;
        this.error = null;
      } catch (e) {
        if (gen === this.gen) { this.error = String(e); this.matches = []; }
      } finally { if (gen === this.gen) cx.notify(); }
    });
  }

  rows() { return this.matches ?? []; }

  // Reads the selected result's file and slices the lines around the match,
  // so the right-hand pane always shows what's currently selected (by index +
  // line, not by object identity — a fresh search can return an equal-looking
  // match at the same index without this being a no-op).
  ensureContext(cx) {
    const m = this.rows()[this.at] ?? null;
    const key = m ? `${m.path}:${m.line}` : null;
    if (key === this.contextKey) return;
    this.contextKey = key;
    this.context = null;
    this.contextError = null;
    if (!m) return;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${this.root}/${m.path}`);
        if (text === null) throw new Error("파일을 열 수 없습니다");
        const lines = text.split("\n");
        const start = Math.max(0, m.line - 1 - CONTEXT_BEFORE);
        const end = Math.min(lines.length, m.line + CONTEXT_AFTER);
        const rows = [];
        for (let i = start; i < end; i++) rows.push({ num: i + 1, text: lines[i], isMatch: i + 1 === m.line });
        if (this.contextKey === key) this.context = { path: m.path, line: m.line, rows };
      } catch (e) {
        if (this.contextKey === key) this.contextError = String(e);
      } finally { if (this.contextKey === key) cx.notify(); }
    });
  }

  close() { closeOverlay(props().overlay); }

  open(m, cx) {
    if (!m) return;
    this.close();
    setShared("board.preview", { root: this.root, path: m.path, on: null, diffable: false });
    run("layout.show", { id: "board-preview" });
  }

  row(m, i, on, t) {
    return v_flex().id(`fip-${i}`).flex_none().px(10).py(4).rounded(6).cursor_pointer()
      .when(on, el => el.bg(t.hover)).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => this.open(m, cx))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.accent).child(m.path))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(`:${m.line}`)))
      .child(div().min_w(0).truncate().whitespace_nowrap().text_size(11.5).text_color(t.foreground).child(m.text.trim()));
  }

  contextRow(r, t, query) {
    const segs = r.isMatch ? highlightSegments(r.text, query) : [{ text: r.text, hit: false }];
    return h_flex().id(`fip-ctx-${r.num}`).flex_none().gap(8).px(8).whitespace_nowrap()
      .when(r.isMatch, el => el.bg(`${t.accent}1a`))
      .child(div().flex_none().w(40).text_right().text_size(10).text_color(r.isMatch ? t.accent : t.dim).when(r.isMatch, el => el.font_semibold()).child(String(r.num)))
      .child(h_flex().flex_none().gap(0).text_size(11.5).text_color(t.foreground)
        .children(segs.map(s => div().child(s.text || " ").when(s.hit, el => el.text_color(t.working).font_semibold()))));
  }

  renderContext(t, query) {
    if (this.contextError) return div().p(10).text_size(11).text_color(t.dim).child(this.contextError);
    if (!this.context) return div().p(10).text_size(11).text_color(t.dim).child(this.rows().length ? "불러오는 중…" : "");
    return v_flex().size_full().min_h(0)
      .child(div().flex_none().px(10).py(6).border_b(1).border_color(t.border).text_size(11).text_color(t.dim).truncate().child(`${this.context.path}:${this.context.line}`))
      .child(v_flex().flex_1().min_h(0).py(4).overflow_y_scrollbar().overflow_x_scrollbar()
        .children(this.context.rows.map(r => this.contextRow(r, t, query))));
  }

  render(cx) {
    const t = theme(), rows = this.rows(), query = this.input.value().trim();
    this.at = Math.max(0, Math.min(this.at ?? 0, rows.length - 1));
    this.ensureContext(cx);
    return v_flex().id("find-in-path").track_focus(this.handle).w_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "down") this.at = Math.min(rows.length - 1, (this.at ?? 0) + 1);
        else if (k === "up") this.at = Math.max(0, (this.at ?? 0) - 1);
        else return;
        this.listScroll.scroll_to_item(this.at);
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("경로 내 검색"))
        .child(div().id("fip-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .when(Boolean(this.error), el => el.child(div().text_size(11).text_color(t.dim).child(this.error)))
      .when(!this.error && Boolean(query) && this.matches === null, el => el.child(div().text_size(11).text_color(t.dim).child("검색 중…")))
      .when(!this.error && Boolean(this.matches), el => el.child(
        h_flex().h(440).flex_none().gap(10).mb(6)
          .child(v_flex().id("fip-list").track_scroll(this.listScroll).w(320).flex_none().h_full().min_h(0).overflow_y_scrollbar().border_1().border_color(t.border).rounded(7).py(4)
            .when(rows.length === 0, e2 => e2.child(div().p(8).text_size(11).text_color(t.dim).child("일치하는 결과 없음")))
            .children(rows.map((m, i) => this.row(m, i, i === this.at, t))))
          .child(v_flex().flex_1().h_full().min_h(0).border_1().border_color(t.border).rounded(7).bg(t.background)
            .child(this.renderContext(t, query)))));
  }
}
