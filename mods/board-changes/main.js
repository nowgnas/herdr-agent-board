// A flat list of every uncommitted change in the focused space's repo, so you
// don't have to hunt through the file tree for what's dirty. Click a row to
// see its diff in board-preview (board-files does the same for a row it
// already has marked; this panel exists for "show me everything changed").
//
// git rev-parse/status는 board-files와 공유합니다(_common/gitstatus.js, 원본 board-common).
// 목록은 처음 LIST_INITIAL개, "+N개 더"로 STATUS_LIMIT개까지 늘어나고, 많으면
// 화면에 보이는 행만 만드는 가상 스크롤로 그립니다. 접히거나 숨겨지면 폴링을 멈춥니다.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, focused, exec, run, shared, setShared, checking, theme, layout, settings } from "herdr";
import { createGitStatus, markOf } from "./_common/gitstatus.js";
import { panelState } from "./_common/panel.js";
import { LIST_INITIAL, LIST_STEP, STATUS_LIMIT, VIRTUAL_MIN_ROWS } from "./_common/limits.js";
import { virtualSlice, wheelScroll, scrollThumb, nextLimit } from "./_common/virtual.js";
import { tr } from "./_common/i18n.js";

function location() {
  const space = spaces().find(s => s.active), focus = focused();
  const pane = panes().find(p => p.pane === focus?.pane);
  return { cwd: pane?.cwd || focus?.cwd || space?.folder || "", machine: space?.machine ?? null };
}
const STATUS_EVERY = 10000, ROW_H = 18;
// 기존 접힘 판정 그대로: (size.px ?? 160) < 70
const PANEL = { defaultPx: 160, collapsedBelow: 70 };
const MARK_COLOR = (t, mark) => mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked;
const git = createGitStatus({ exec, shared, setShared });

export default class Changes extends View {
  init(_props, cx) {
    this.limit = LIST_INITIAL; this.scroll = 0;
    this.refresh(cx);
    cx.timer.every(STATUS_EVERY, cx => { if (this.active()) this.refresh(cx); });
  }
  active() { return panelState(layout(), "board-changes", PANEL).active; }
  refresh(cx) {
    const loc = location(), key = JSON.stringify(loc);
    if (key !== this.key) {
      this.key = key; this.root = null; this.items = null; this.total = 0; this.sig = null; this.error = null;
      this.limit = LIST_INITIAL; this.scroll = 0;
    }
    // 실행 중이면 끝난 뒤 finally에서 경로가 바뀌었는지 보고 한 번 더 부릅니다.
    if (!loc.cwd || loc.machine || this.loading || checking()) return;
    this.loading = true;
    cx.spawn(async cx => {
      let changed = false;
      try {
        const snap = await git.status(loc.cwd, null);
        if (this.key === key) changed = this.apply(snap);
      } catch (e) {
        if (this.key === key && (this.error !== String(e) || this.items !== null)) { this.error = String(e); this.items = null; this.sig = null; changed = true; }
      } finally {
        this.loading = false;
        if (changed) cx.notify();
        if (JSON.stringify(location()) !== key) this.refresh(cx);
      }
    });
  }
  // 파싱 결과가 이전과 같으면 배열을 바꾸지 않고 false(→ notify 생략).
  apply(snap) {
    if (snap.sig === this.sig && !this.error) return false;
    this.root = snap.root; this.total = snap.total; this.sig = snap.sig; this.error = null;
    this.items = snap.entries.map(([xy, path]) => ({ path, mark: markOf(xy) }));
    return true;
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
  // "+N개 더"와 상한 안내. 목록이 상한보다 적으면 null(기존 화면 그대로).
  more(t) {
    const shown = Math.min(this.items.length, this.limit), rest = this.items.length - shown, beyond = this.total - this.items.length;
    if (rest <= 0 && beyond <= 0) return null;
    return h_flex().flex_none().gap(6).items_center().px(10).py(3).text_size(10).text_color(t.muted)
      .when(rest > 0, el => el.child(div().id("changes-more").px(4).py(1).rounded(4).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => { this.limit = nextLimit(this.limit, this.items.length, LIST_STEP, STATUS_LIMIT); cx.notify(); })
        .child(tr(`+${rest.toLocaleString()}개 더`, `+${rest.toLocaleString()} more`))))
      .when(rest <= 0 && beyond > 0, el => el.child(div().text_color(t.dim)
        .child(tr(`외 ${beyond.toLocaleString()}개는 표시하지 않음 (상한 ${STATUS_LIMIT.toLocaleString()}개)`, `${beyond.toLocaleString()} more not shown (limit ${STATUS_LIMIT.toLocaleString()})`))));
  }
  virtualList(t) {
    const shown = Math.min(this.items.length, this.limit), items = this.items.length === shown ? this.items : this.items.slice(0, shown);
    const viewport = this.viewH ?? 120;
    const { rows, window: w } = virtualSlice(items, { rowHeight: ROW_H, viewport, scroll: this.scroll, overscan: 4 });
    this.scroll = w.scroll;
    const thumb = scrollThumb({ scroll: w.scroll, viewport, total: w.total, min: 12 });
    return div().id("changes-list").flex_1().min_h(0).mx(8).relative().overflow_hidden().text_size(10)
      .on_size_change((size, cx) => { const h = size.height / (settings().zoom || 1); if (h !== this.viewH) { this.viewH = h; cx.notify(); } })
      .on_scroll_wheel((e, cx) => { this.scroll = wheelScroll(this.scroll, e.delta?.y ?? 0, w.maxScroll); cx.notify(); })
      .children(rows.map(r => this.row(r.item, t).absolute().top(r.top).left(0).right(6).h(ROW_H - 1)))
      .when(Boolean(thumb), el => el.child(div().absolute().right(0).w(4).rounded(2).bg(t.border).top(thumb.top).h(thumb.height)));
  }
  render(cx) {
    const loc = location(), state = panelState(layout(), "board-changes", PANEL);
    if (JSON.stringify(loc) !== this.key) this.refresh(cx);
    else if (state.active && this.wasActive === false) this.refresh(cx); // 다시 펼치면 바로 갱신
    this.wasActive = state.active;
    const t = theme(), collapsed = state.collapsed;
    const ready = !loc.machine && !this.error && Boolean(this.items) && this.items.length > 0;
    const virtual = ready && Math.min(this.items.length, this.limit) > VIRTUAL_MIN_ROWS;
    return v_flex().size_full().min_h(0).bg(t.canvas).border_b(1).border_color(t.border).text_color(t.foreground)
      .child(h_flex().id("changes-toggle").h(26).flex_none().px(10).gap(6).items_center().cursor_pointer().hover(s => s.bg(t.hover))
        .tooltip(collapsed ? tr("변경된 파일 펼치기", "Expand changed files") : tr("변경된 파일 접기", "Collapse changed files"))
        .on_click(() => run("layout.resize", collapsed ? { id: "board-changes", px: 160 } : { id: "board-changes", px: 26 }))
        .child(div().flex_1().text_size(10).font_semibold().child(tr("변경된 파일", "Changed files")))
        .when(Boolean(this.items?.length), el => el.child(div().flex_none().px(4).py(0.5).rounded(3).bg(t.raised).text_size(9).text_color(t.blocked).child(String(this.total || this.items.length))))
        .child(div().text_color(t.muted).child(collapsed ? "▸" : "▾")))
      .when(!collapsed && virtual, el => el.child(this.virtualList(t)).child(v_flex().flex_none().pb(6).children([this.more(t)].filter(Boolean))))
      .when(!collapsed && !virtual, el => el.child(v_flex().flex_1().min_h(0).px(8).pb(6).gap(1).overflow_y_scrollbar().text_size(10)
        .when(Boolean(loc.machine), e => e.child(div().text_color(t.muted).child(tr("원격 세션은 관측할 수 없습니다", "Remote sessions can't be observed"))))
        .when(!loc.machine && Boolean(this.error), e => e.child(div().text_color(t.muted).child(this.error ?? "")))
        .when(!loc.machine && !this.error && this.items === null, e => e.child(div().text_color(t.muted).child(loc.cwd ? tr("변경 사항 확인 중…", "Checking for changes…") : tr("선택된 경로 없음", "No path selected"))))
        .when(!loc.machine && !this.error && Boolean(this.items) && this.items.length === 0, e => e.child(div().text_color(t.muted).child(tr("변경된 파일이 없습니다", "No changed files"))))
        .when(ready, e => e.children(this.items.slice(0, this.limit).map(item => this.row(item, t))).children([this.more(t)].filter(Boolean)))));
  }
}
