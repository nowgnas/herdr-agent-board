// A flat list of every uncommitted change in the focused space's repo, so you
// don't have to hunt through the file tree for what's dirty. Click a row to
// see its diff in board-preview (board-files does the same for a row it
// already has marked; this panel exists for "show me everything changed").
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, focused, exec, run, setShared, checking, theme, layout } from "herdr";

function node(root, id) {
  if (root?.id === id) return root;
  for (const child of root?.children ?? []) { const found = node(child, id); if (found) return found; }
  return null;
}
function location() {
  const space = spaces().find(s => s.active), focus = focused();
  const pane = panes().find(p => p.pane === focus?.pane);
  return { cwd: pane?.cwd || focus?.cwd || space?.folder || "", machine: space?.machine ?? null };
}
const STATUS_EVERY = 10000;
const MARK_COLOR = (t, mark) => mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked;

export default class Changes extends View {
  init(_props, cx) {
    this.refresh(cx);
    cx.timer.every(STATUS_EVERY, cx => this.refresh(cx));
  }
  refresh(cx) {
    const loc = location(), key = JSON.stringify(loc);
    if (key !== this.key) { this.key = key; this.root = null; this.items = null; this.error = null; }
    if (!loc.cwd || loc.machine || this.loading || checking()) return;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: loc.cwd });
        if (top.code !== 0) throw new Error("git 저장소가 아닙니다");
        const root = top.stdout.trim();
        const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false",
          "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root });
        if (status.code !== 0) throw new Error("git status 실패");
        const items = [];
        for (const entry of status.stdout.split("\0").filter(Boolean)) {
          const xy = entry.slice(0, 2), path = entry.slice(3);
          const mark = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          items.push({ path, mark });
        }
        items.sort((a, b) => a.path.localeCompare(b.path));
        if (this.key === key) { this.root = root; this.items = items; this.error = null; }
      } catch (e) { if (this.key === key) { this.error = String(e); this.items = null; } }
      finally { this.loading = false; cx.notify(); }
    });
  }
  preview(path) {
    setShared("board.preview", { root: this.root, path, on: null, diffable: true });
    run("layout.show", { id: "board-preview" });
  }
  row(item, t) {
    return h_flex().id(`change-${item.path}`).gap(6).items_center().py(2).px(2).rounded(4).cursor_pointer().hover(s => s.bg(t.hover))
      .tooltip(item.path).on_click(() => this.preview(item.path))
      .child(div().flex_none().w(12).text_color(MARK_COLOR(t, item.mark)).child(item.mark))
      .child(div().flex_1().min_w(0).truncate().child(item.path));
  }
  render(cx) {
    const loc = location();
    if (JSON.stringify(loc) !== this.key) this.refresh(cx);
    const t = theme(), collapsed = (node(layout(), "board-changes")?.size?.px ?? 160) < 70;
    return v_flex().size_full().min_h(0).bg(t.canvas).border_b(1).border_color(t.border).text_color(t.foreground)
      .child(h_flex().id("changes-toggle").h(26).flex_none().px(10).gap(6).items_center().cursor_pointer().hover(s => s.bg(t.hover))
        .tooltip(collapsed ? "변경된 파일 펼치기" : "변경된 파일 접기")
        .on_click(() => run("layout.resize", collapsed ? { id: "board-changes", px: 160 } : { id: "board-changes", px: 26 }))
        .child(div().flex_1().text_size(10).font_semibold().child("변경된 파일"))
        .when(Boolean(this.items?.length), el => el.child(div().flex_none().px(4).py(0.5).rounded(3).bg(t.raised).text_size(9).text_color(t.blocked).child(String(this.items.length))))
        .child(div().text_color(t.muted).child(collapsed ? "▸" : "▾")))
      .when(!collapsed, el => el.child(v_flex().flex_1().min_h(0).px(8).pb(6).gap(1).overflow_y_scrollbar().text_size(10)
        .when(Boolean(loc.machine), e => e.child(div().text_color(t.muted).child("원격 세션은 관측할 수 없습니다")))
        .when(!loc.machine && Boolean(this.error), e => e.child(div().text_color(t.muted).child(this.error ?? "")))
        .when(!loc.machine && !this.error && this.items === null, e => e.child(div().text_color(t.muted).child(loc.cwd ? "변경 사항 확인 중…" : "선택된 경로 없음")))
        .when(!loc.machine && !this.error && Boolean(this.items) && this.items.length === 0, e => e.child(div().text_color(t.muted).child("변경된 파일이 없습니다")))
        .when(!loc.machine && !this.error && Boolean(this.items) && this.items.length > 0, e => e.children(this.items.map(item => this.row(item, t))))));
  }
}
