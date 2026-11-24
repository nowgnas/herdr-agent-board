// IntelliJ's Cmd+Shift+O ("Go to File"): fuzzy-filter every file tracked (or
// untracked-but-not-ignored) in the focused space's repo, Enter/click opens
// the pick in board-preview. Bound to mod.open:board-goto-file in keys.json.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, run, setShared, theme, props, closeOverlay, checking } from "herdr";

function location() {
  const space = spaces().find(s => s.active), focus = focused();
  const pane = panes().find(p => p.pane === focus?.pane);
  return { cwd: pane?.cwd || focus?.cwd || space?.folder || "", machine: space?.machine ?? null };
}

const RESULT_LIMIT = 300;

// Subsequence fuzzy match (every typed character must occur, in order,
// somewhere in the path) — case-insensitive, like IntelliJ's file search.
// null = no match. Higher score = better; favors hits in the filename and
// consecutive characters over scattered ones.
function fuzzyScore(path, query) {
  const hay = path.toLowerCase();
  let qi = 0, score = 0, lastIndex = -2;
  for (let i = 0; i < hay.length && qi < query.length; i++) {
    if (hay[i] === query[qi]) {
      score += lastIndex === i - 1 ? 3 : 1;
      lastIndex = i;
      qi++;
    }
  }
  if (qi < query.length) return null;
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base.includes(query)) score += 20;
  return score - path.length * 0.01;
}

export default class GotoFile extends View {
  init(_props, cx) {
    this.input = InputState.new({ placeholder: "파일 이름으로 이동…" });
    this.listScroll = ScrollHandle.new();
    this.input.on("change", (_e, cx) => { this.at = 0; this.listScroll.scroll_to_item(0); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.open(this.rows()[this.at ?? 0], cx));
    this.input.focus();
    cx.timer.after(50, () => this.input.focus());
    this.at = 0;
    this.files = null;
    this.root = null;
    this.error = null;
    this.handle = cx.focus_handle();
    this.load(cx);
  }

  load(cx) {
    const loc = location();
    if (loc.machine) { this.error = "원격 스페이스는 지원하지 않습니다"; this.files = []; return; }
    if (!loc.cwd || checking()) return;
    cx.spawn(async cx => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: loc.cwd });
        if (top.code !== 0) throw new Error("git 저장소가 아닙니다");
        this.root = top.stdout.trim();
        const ls = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: this.root });
        if (ls.code !== 0) throw new Error("파일 목록을 가져올 수 없습니다");
        this.files = ls.stdout.split("\0").filter(Boolean);
        this.error = null;
      } catch (e) { this.error = String(e); this.files = []; }
      finally { cx.notify(); }
    });
  }

  rows() {
    const q = this.input.value().trim().toLowerCase();
    if (!q) return (this.files ?? []).slice(0, RESULT_LIMIT);
    const scored = [];
    for (const path of this.files ?? []) {
      const s = fuzzyScore(path, q);
      if (s !== null) scored.push({ path, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, RESULT_LIMIT).map(r => r.path);
  }

  close() { closeOverlay(props().overlay); }

  open(path, cx) {
    if (!path) return;
    this.close();
    setShared("board.preview", { root: this.root, path, on: null, diffable: false });
    run("layout.show", { id: "board-preview" });
  }

  row(path, i, on, t) {
    const idx = path.lastIndexOf("/");
    const name = idx >= 0 ? path.slice(idx + 1) : path;
    const dir = idx >= 0 ? path.slice(0, idx) : "";
    return h_flex().id(`goto-file-${i}`).px(10).h(28).flex_none().items_center().gap(8).rounded(6).cursor_pointer()
      .when(on, el => el.bg(t.hover)).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => this.open(path, cx))
      .child(div().flex_none().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(dir));
  }

  render(cx) {
    const t = theme(), rows = this.rows();
    this.at = Math.max(0, Math.min(this.at ?? 0, rows.length - 1));
    return v_flex().id("goto-file").track_focus(this.handle).w_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
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
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("파일로 이동"))
        .child(div().id("goto-file-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover(s => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .when(Boolean(this.error), el => el.child(div().text_size(11).text_color(t.dim).child(this.error)))
      .when(!this.error && this.files === null, el => el.child(div().text_size(11).text_color(t.dim).child("파일 목록 불러오는 중…")))
      .when(!this.error && this.files !== null, el => el.child(
        v_flex().id("goto-file-list").track_scroll(this.listScroll).h(Math.min(360, Math.max(28, rows.length * 28))).min_h(0).overflow_y_scrollbar().mb(6)
          .when(rows.length === 0, e2 => e2.child(div().p(8).text_size(11).text_color(t.dim).child("일치하는 파일 없음")))
          .children(rows.map((path, i) => this.row(path, i, i === this.at, t)))));
  }
}
