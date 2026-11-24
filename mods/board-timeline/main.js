// Recent commit timeline for the focused space's repo: what actually
// happened recently, one commit at a time (board-hotspot is the aggregate
// view; this is the per-commit drill-down).
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, focused, exec, run, setShared, checking, theme, layout } from "herdr";
import { panelState } from "../board-common/panel.js";

function location() {
  const space = spaces().find(s => s.active), focus = focused();
  const pane = panes().find(p => p.pane === focus?.pane);
  return { cwd: pane?.cwd || focus?.cwd || space?.folder || "", machine: space?.machine ?? null };
}
const STATUS_EVERY = 60000, LIMIT = 30;
// 기존 접힘 판정 그대로: (size.px ?? 170) < 80
const PANEL = { defaultPx: 170, collapsedBelow: 80 };
const MARK_COLOR = (t, status) => status === "A" ? t.ansi2 : status === "D" ? t.ansi1 : t.blocked;

export default class Timeline extends View {
  init(_props, cx) {
    this.expanded = new Set();
    this.filesByHash = new Map();
    this.refresh(cx);
    cx.timer.every(STATUS_EVERY, cx => { if (this.active()) this.refresh(cx); });
  }
  active() { return panelState(layout(), "board-timeline", PANEL).active; }
  refresh(cx) {
    const loc = location(), key = JSON.stringify(loc);
    if (key !== this.key) {
      this.key = key; this.root = null; this.commits = null; this.error = null;
      this.expanded = new Set(); this.filesByHash = new Map();
    }
    if (!loc.cwd || loc.machine || this.loading || checking()) return;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: loc.cwd });
        if (top.code !== 0) throw new Error("git 저장소가 아닙니다");
        const root = top.stdout.trim();
        const log = await exec("git", ["log", `-n${LIMIT}`, "--format=%h\x1f%an\x1f%ar\x1f%s"], { cwd: root });
        if (log.code !== 0) throw new Error("git log 실패");
        const commits = log.stdout.split("\n").filter(Boolean).map(line => {
          const [hash, author, when, subject] = line.split("\x1f");
          return { hash, author, when, subject };
        });
        if (this.key === key) {
          this.root = root; this.commits = commits; this.error = null;
          // 최근 LIMIT개 커밋에 없는 파일 목록·펼침 상태는 버립니다.
          const live = new Set(commits.map(c => c.hash));
          for (const hash of [...this.filesByHash.keys()]) if (!live.has(hash)) this.filesByHash.delete(hash);
          for (const hash of [...this.expanded]) if (!live.has(hash)) this.expanded.delete(hash);
        }
      } catch (e) { if (this.key === key) { this.error = String(e); this.commits = null; } }
      finally {
        this.loading = false; cx.notify();
        // 실행 중에 경로가 바뀌었으면 한 주기를 기다리지 않고 새 경로로 바로 다시 조회
        if (JSON.stringify(location()) !== key) this.refresh(cx);
      }
    });
  }
  toggle(hash, cx) {
    if (this.expanded.has(hash)) { this.expanded.delete(hash); cx.notify(); return; }
    this.expanded.add(hash);
    cx.notify();
    if (this.filesByHash.has(hash)) return;
    const root = this.root, key = this.key;
    cx.spawn(async cx => {
      const result = await exec("git", ["-c", "core.quotepath=false", "show", "--name-status", "--format=", hash], { cwd: root }).catch(() => null);
      if (this.key !== key) return;
      const files = result && result.code === 0
        ? result.stdout.split("\n").filter(Boolean).map(line => {
          const [status, ...rest] = line.split("\t");
          return { status: status[0], path: rest.join("\t") };
        })
        : [];
      this.filesByHash.set(hash, files);
      cx.notify();
    });
  }
  preview(path) {
    setShared("board.preview", { root: this.root, path, on: null });
    run("layout.show", { id: "board-preview" });
  }
  row(c, t) {
    const open = this.expanded.has(c.hash);
    const files = this.filesByHash.get(c.hash);
    return v_flex().flex_none()
      .child(h_flex().id(`commit-${c.hash}`).gap(6).items_center().py(2).px(2).rounded(4).cursor_pointer().hover(s => s.bg(t.hover))
        .tooltip(`${c.subject}\n${c.author} · ${c.when}`)
        .on_click((_e, cx) => this.toggle(c.hash, cx))
        .child(svg(`mods/board-files/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim))
        .child(div().flex_none().font_semibold().text_color(t.accent).child(c.hash))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.subject)))
      .child(h_flex().pl(16).gap(6).text_size(9).text_color(t.dim)
        .child(div().min_w(0).truncate().text_color(t.ansi4).child(c.author)).child(div().flex_none().child(`· ${c.when}`)))
      .when(open, el => el.child(v_flex().flex_none().pl(16).pt(1).gap(1)
        .children(files === undefined ? [div().py(1.5).px(2).text_color(t.dim).child("불러오는 중…")]
          : files.length ? files.map(f => h_flex().id(`commit-file-${c.hash}-${f.path}`).gap(5).items_center().py(1.5).px(2).rounded(3).cursor_pointer().hover(s => s.bg(t.hover))
            .tooltip(`${f.path}\n(현재 작업 트리 버전을 미리 봅니다)`).on_click(() => this.preview(f.path))
            .child(div().flex_none().w(10).text_color(MARK_COLOR(t, f.status)).child(f.status))
            .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(f.path)))
            : [div().py(1.5).px(2).text_color(t.dim).child("변경 파일 없음")])));
  }
  render(cx) {
    const loc = location(), state = panelState(layout(), "board-timeline", PANEL);
    if (JSON.stringify(loc) !== this.key) this.refresh(cx);
    else if (state.active && this.wasActive === false) this.refresh(cx); // 다시 펼치면 바로 갱신
    this.wasActive = state.active;
    const t = theme(), collapsed = state.collapsed;
    return v_flex().size_full().min_h(0).bg(t.canvas).border_t(1).border_color(t.border).text_color(t.foreground)
      .child(h_flex().id("timeline-toggle").h(26).flex_none().px(10).gap(6).items_center().cursor_pointer().hover(s => s.bg(t.hover))
        .tooltip(collapsed ? "최근 커밋 펼치기" : "최근 커밋 접기")
        .on_click(() => run("layout.resize", collapsed ? { id: "board-timeline", weight: 170 } : { id: "board-timeline", px: 26 }))
        .child(div().flex_1().text_size(10).font_semibold().child("최근 커밋"))
        .child(div().text_color(t.muted).child(collapsed ? "▸" : "▾")))
      .when(!collapsed, el => el.child(v_flex().flex_1().min_h(0).px(8).pb(6).gap(4).overflow_y_scrollbar().text_size(10)
        .when(Boolean(loc.machine), e => e.child(div().text_color(t.muted).child("원격 세션은 관측할 수 없습니다")))
        .when(!loc.machine && Boolean(this.error), e => e.child(div().text_color(t.muted).child(this.error ?? "")))
        .when(!loc.machine && !this.error && this.commits === null, e => e.child(div().text_color(t.muted).child(loc.cwd ? "커밋 기록 불러오는 중…" : "선택된 경로 없음")))
        .when(!loc.machine && !this.error && Boolean(this.commits) && this.commits.length === 0, e => e.child(div().text_color(t.muted).child("커밋 기록이 없습니다")))
        .when(!loc.machine && !this.error && Boolean(this.commits) && this.commits.length > 0, e => e.children(this.commits.map(c => this.row(c, t))))));
  }
}
