// Code hotspots: files touched by the most commits recently, for the focused
// space's repo. A quick "what keeps changing / what's risky" pointer.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, focused, exec, run, setShared, checking, theme, layout } from "herdr";

function node(root, id) {
  if (root?.id === id) return root;
  for (const child of root?.children ?? []) { const found = node(child, id); if (found) return found; }
  return null;
}
function current() {
  const space = spaces().find(s => s.active), focus = focused();
  const pane = panes().find(p => p.pane === focus?.pane);
  return { cwd: pane?.cwd || focus?.cwd || space?.folder || "", machine: space?.machine ?? null };
}
const DAYS = 30, LIMIT = 12;

// git log --numstat prints one "--commit--" marker per commit, then one
// numstat line per file it touched: "<added>\t<removed>\t<path>".
function parseChurn(stdout) {
  const counts = new Map();
  let touched = new Set();
  for (const line of stdout.split("\n")) {
    if (line === "--commit--") { touched = new Set(); continue; }
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const [, addStr, delStr, path] = m;
    const entry = counts.get(path) ?? { path, commits: 0, added: 0, removed: 0 };
    if (!touched.has(path)) { entry.commits += 1; touched.add(path); }
    if (addStr !== "-") entry.added += Number(addStr);
    if (delStr !== "-") entry.removed += Number(delStr);
    counts.set(path, entry);
  }
  return [...counts.values()].sort((a, b) => b.commits - a.commits || (b.added + b.removed) - (a.added + a.removed)).slice(0, LIMIT);
}

export default class Hotspot extends View {
  init(_props, cx) {
    this.refresh(cx);
    cx.timer.every(180000, cx => this.refresh(cx, true));
  }
  refresh(cx, periodic = false) {
    const loc = current(), key = JSON.stringify(loc);
    if (key !== this.key) { this.key = key; this.data = null; this.error = null; this.loading = false; }
    if (!loc.cwd || loc.machine || this.loading || checking()) return;
    if (!periodic && this.data) return;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: loc.cwd });
        if (top.code !== 0) throw new Error("git 저장소가 아닙니다");
        const root = top.stdout.trim();
        const log = await exec("git", ["-c", "core.quotepath=false", "log", `--since=${DAYS}.days`, "--pretty=format:--commit--", "--numstat", "--no-renames"], { cwd: root });
        if (log.code !== 0) throw new Error("git log 실패");
        const files = parseChurn(log.stdout);
        if (this.key === key) {
          this.data = { root, files, maxCommits: Math.max(1, ...files.map(f => f.commits)) };
          this.error = null;
        }
      } catch (e) { if (this.key === key) this.error = String(e); }
      finally { if (this.key === key) this.loading = false; cx.notify(); }
    });
  }
  row(f, t) {
    const pct = Math.max(6, Math.round(100 * f.commits / this.data.maxCommits));
    return h_flex().id(`hotspot-${f.path}`).gap(6).items_center().py(2).px(2).rounded(4).cursor_pointer().hover(s => s.bg(t.hover))
      .tooltip(`${f.path}\n${f.commits}회 커밋 · +${f.added}/-${f.removed}`)
      .on_click(() => {
        setShared("board.preview", { root: this.data.root, path: f.path, on: null });
        run("layout.show", { id: "board-preview" });
      })
      .child(div().flex_1().min_w(0).truncate().child(f.path))
      .child(div().w(40).h(5).flex_none().rounded(3).bg(t.raised).relative()
        .child(div().absolute().left_0().top_0().h_full().rounded(3).bg(t.accent).w(`${pct}%`)))
      .child(div().w(18).flex_none().text_right().text_color(t.muted).child(String(f.commits)));
  }
  render(cx) {
    const loc = current();
    if (JSON.stringify(loc) !== this.key) this.refresh(cx);
    const t = theme(), collapsed = (node(layout(), "board-hotspot")?.size?.px ?? 170) < 80;
    return v_flex().size_full().min_h(0).bg(t.canvas).border_t(1).border_color(t.border).text_color(t.foreground)
      .child(h_flex().id("hotspot-toggle").h(26).flex_none().px(10).gap(6).items_center().cursor_pointer().hover(s => s.bg(t.hover))
        .tooltip(collapsed ? "코드 핫스팟 펼치기" : "코드 핫스팟 접기")
        .on_click(() => run("layout.resize", collapsed ? { id: "board-hotspot", weight: 170 } : { id: "board-hotspot", px: 26 }))
        .child(div().flex_1().text_size(10).font_semibold().child(`코드 핫스팟 · 최근 ${DAYS}일`))
        .child(div().text_color(t.muted).child(collapsed ? "▸" : "▾")))
      .when(!collapsed, el => el.child(v_flex().flex_1().min_h(0).px(8).pb(6).gap(1).overflow_y_scrollbar().text_size(10)
        .when(Boolean(loc.machine), e => e.child(div().text_color(t.muted).child("원격 세션은 관측할 수 없습니다")))
        .when(!loc.machine && Boolean(this.error), e => e.child(div().text_color(t.muted).child(this.error ?? "")))
        .when(!loc.machine && !this.data && !this.error, e => e.child(div().text_color(t.muted).child(loc.cwd ? "커밋 기록 불러오는 중…" : "선택된 경로 없음")))
        .when(!loc.machine && Boolean(this.data) && this.data.files.length === 0, e => e.child(div().text_color(t.muted).child(`최근 ${DAYS}일간 커밋이 없습니다`)))
        .when(!loc.machine && Boolean(this.data) && this.data.files.length > 0, e => e.children(this.data.files.map(f => this.row(f, t))))));
  }
}
