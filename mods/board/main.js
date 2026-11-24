import { labelIndex } from "./labels.js";
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Scrollbar, InputState, Input } from "gpui-base";
import { agents, spaces, panes, props, run, openOverlay, focused, theme, pickFolder, notify, setAgentOrder, layout, nextCommand, checking, settings } from "herdr";
import { BOARD_VIRTUAL_MIN_CARDS } from "./_common/limits.js";
import { virtualSlice, wheelScroll, scrollThumb } from "./_common/virtual.js";
import { lang, setLang, tr } from "./_common/i18n.js";

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

const colors = () => {
  const t = theme();
  return { ink: t.foreground, muted: t.muted, line: t.border, bg: t.canvas, white: t.surface, violet: t.accent };
};
const states = () => [
  { key: "blocked", label: "Needs you", color: theme().blocked, wash: theme().raised },
  { key: "working", label: "Working", color: theme().working, wash: theme().raised },
  { key: "done", label: "Done", color: theme().done, wash: theme().raised },
  { key: "idle", label: "Idle", color: theme().idle, wash: theme().raised },
];
// The first live terminal determines the space folder, as in Herdr's shipped sidebar.
const spacePath = space => {
  const ids = new Set(space.tabs.map(t => t.id));
  return panes().find(p => ids.has(p.tab) && p.cwd)?.cwd || space.folder;
};
const dot = (color, size = 7) => div().size(size).rounded(size).bg(color).flex_none();
const icon = (program, size = 18) => program?.icon
  ? (program.tint ? svg(program.icon).text_color(colors().ink) : image(program.icon)).size(size).flex_none()
  : div().size(size).rounded(4).bg(colors().violet);
const STATUS_LABEL = { blocked: ["승인 대기", "Needs approval"], working: ["작업 중", "Working"], done: ["완료", "Done"], idle: ["대기", "Idle"] };
// A stable color per worktree branch, so the same branch always tags the same way.
const worktreeColor = branch => {
  if (!branch) return null;
  const t = theme(), palette = [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6, t.accent];
  let hash = 0;
  for (let i = 0; i < branch.length; i++) hash = (hash * 31 + branch.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
};
// 카드마다 spaces()를 훑지 않도록 render당 한 번 만든 space id 인덱스를 씁니다.
const spaceIndex = allSpaces => new Map(allSpaces.map(s => [s.id, s]));
const branchOf = (a, byId) => byId.get(a.space)?.branch ?? null;
// 카드 h(58) + gap(5): 가상 스크롤 열의 행 간격
const CARD_STRIDE = 63;
export default class Board extends View {
  init(_props, cx) {
    const role = props()?.role;
    if (role === undefined) {
      this.filterText = "";
      this.filterInput = InputState.new({ value: "", placeholder: tr("검색 (탭 · 스페이스 · 프로그램 · 주소)", "Search (tab · space · program · address)") });
      this.filterInput.on("change", (_e, cx) => { this.filterText = this.filterInput.value(); cx.notify(); });
      this.filterStatuses = new Set(states().map(s => s.key));
      this.filterBranches = new Set();
    }
    if (checking()) return;
    if (role === "sidebar") {
      cx.spawn(async () => {
        for (;;) {
          const command = await nextCommand();
          if (command !== "grid-split") continue;
          const f = focused();
          const current = panes().filter(p => p.tab === f?.tab);
          if (!f?.pane || !current.length) continue;
          // Split each existing cell once per round, alternating columns and rows.
          // Earlier splits add two leaves, so the next unsplit cell advances by two.
          const round = Math.floor(Math.log2(current.length));
          const base = 2 ** round;
          const target = current[2 * (current.length - base)];
          const direction = round % 2 === 0 ? "right" : "down";
          if (target) run("pane.split", { pane: target.pane, direction });
        }
      });
    } else if (role === "path-tabs") {
      // ⌘1..⌘9 (layout:board) jump straight to the Nth visible path tab.
      cx.spawn(async () => {
        for (;;) {
          const command = await nextCommand();
          const m = /^path-tab-([1-9])$/.exec(command ?? "");
          if (!m) continue;
          const entry = this.matches()[Number(m[1]) - 1];
          if (!entry) continue;
          run("tab.select", { id: entry.tab.id });
          if (entry.target?.pane) run("pane.focus", { pane: entry.target.pane });
        }
      });
    }
  }
  card(a, state, tabLabel, byId) {
    const branch = branchOf(a, byId), wColor = worktreeColor(branch);
    return h_flex().id(`agent-${a.address}`).w_full().h(58).flex_none().rounded(6).overflow_hidden()
      .bg(colors().white).border(1).border_color(colors().line).cursor_pointer().hover(s => s.border_color(state.color))
      .on_click(() => run("agent.focus", { terminal: a.address }))
      .child(div().w(3).h_full().bg(state.color).flex_none())
      .child(v_flex().flex_1().min_w(0).px(9).py(6).gap(3)
        .child(h_flex().gap(5).items_center().text_size(9).text_color(colors().muted)
          .when(Boolean(wColor), el => el.child(dot(wColor, 6).tooltip(branch)))
          .child(icon(a.program, 12)).child(div().truncate().child(a.program.name)).child(div().flex_1())
          .child(div().px(4).py(1).rounded(3).bg(state.wash).text_size(8.5).font_semibold().text_color(state.color).child(tr(...STATUS_LABEL[state.key]))))
        .child(div().text_size(12).font_semibold().text_color(colors().ink).truncate().child(tabLabel(a.tab)))
        .child(h_flex().items_center().justify_between().gap(6).text_size(9).text_color(colors().muted)
          .child(div().min_w(0).truncate().child(a.space_name))
          .child(div().flex_none().truncate().child(a.address))));
  }
  // The visible path-tab entries, in display order (⌘1..⌘9 index into this).
  matches() {
    const sp = spaces(), ps = panes(), f = focused();
    const byTab = new Map();
    for (const pane of ps) { const items = byTab.get(pane.tab) ?? []; items.push(pane); byTab.set(pane.tab, items); }
    const current = sp.find(s => s.active);
    const activeTab = current?.tabs.find(t => t.active);
    const selected = ps.find(p => p.pane === f?.pane) ?? ps.find(p => p.tab === activeTab?.id && p.terminal);
    const path = selected?.cwd;
    const machine = current?.machine ?? null;
    const matches = [];
    for (const space of sp) {
      if ((space.machine ?? null) !== machine) continue;
      for (const tab of space.tabs) {
        const mine = byTab.get(tab.id) ?? [];
        const target = mine.find(p => p.pane === selected?.pane) ?? mine.find(p => path && p.cwd === path);
        if (path ? target : space.id === current?.id) matches.push({ space, tab, target });
      }
    }
    return matches;
  }
  pathTabs() {
    const sp = spaces(), ps = panes();
    const tabLabel = labelIndex(sp, ps);
    const matches = this.matches();
    return h_flex().id("board-path-tabs").size_full().min_w(0).items_center().gap(4).px(6)
      .bg(colors().white).overflow_x_scrollbar().children(matches.map(({ space, tab, target }, i) =>
        h_flex().id(`path-tab-${tab.id}`).h(24).flex_none().max_w(280).px(8).gap(5).items_center().rounded(4)
          .bg(space.active && tab.active ? theme().selected : colors().bg).border(1)
          .border_color(space.active && tab.active ? colors().violet : colors().line).cursor_pointer()
          .tooltip(`${space.name} / ${tabLabel(tab.id)}${i < 9 ? ` · ⌘${i + 1}` : ""}\n${target?.cwd ?? space.folder}`)
          .on_click(() => {
            run("tab.select", { id: tab.id });
            if (target?.pane) run("pane.focus", { pane: target.pane });
          })
          .on_mouse_down("right", () => openOverlay({ mod: "board-menu", kind: "popup", width: 220,
            props: { tab: "tab", target: { id: tab.id } } }))
          .when(Boolean(worktreeColor(space.branch)), el => el.child(dot(worktreeColor(space.branch), 5).tooltip(space.branch)))
          .child(dot(states().find(s => s.key === tab.status)?.color ?? colors().muted, 5))
          .child(div().min_w(0).truncate().text_size(11).text_color(colors().ink).child(tabLabel(tab.id)))));
  }
  filterBar() {
    const t = theme(), branches = [...new Set(spaces().map(s => s.branch).filter(Boolean))];
    const resettable = Boolean(this.filterText) || this.filterStatuses.size < states().length || this.filterBranches.size > 0;
    return h_flex().id("board-filter-bar").flex_none().h(32).px(14).gap(5).items_center()
      .bg(colors().white).border_b(1).border_color(colors().line)
      .child(Input.new(this.filterInput).w(170).flex_none().h(22).px(7).items_center().rounded(4)
        .border(1).border_color(t.input).bg(t.background).text_color(t.foreground).text_size(10.5))
      .children(states().map(state => {
        const on = this.filterStatuses.has(state.key);
        return div().id(`filter-status-${state.key}`).px(6).py(2).rounded(4).cursor_pointer().text_size(10)
          .bg(on ? state.wash : colors().bg).border(1).border_color(on ? state.color : colors().line)
          .text_color(on ? state.color : colors().muted)
          .on_click((_e, cx) => {
            if (this.filterStatuses.has(state.key)) this.filterStatuses.delete(state.key); else this.filterStatuses.add(state.key);
            if (this.filterStatuses.size === 0) this.filterStatuses = new Set(states().map(s => s.key));
            cx.notify();
          }).child(state.label);
      }))
      .when(branches.length > 0, el => el
        .child(div().w(1).h(14).bg(colors().line).flex_none())
        .children(branches.map(branch => {
          const on = this.filterBranches.has(branch);
          return div().id(`filter-branch-${branch}`).px(6).py(2).rounded(4).cursor_pointer().text_size(10).max_w(120).truncate()
            .bg(on ? theme().selected : colors().bg).border(1).border_color(on ? worktreeColor(branch) : colors().line)
            .text_color(on ? colors().ink : colors().muted).tooltip(branch)
            .on_click((_e, cx) => {
              if (this.filterBranches.has(branch)) this.filterBranches.delete(branch); else this.filterBranches.add(branch);
              cx.notify();
            }).child(branch);
        })))
      .child(div().flex_1())
      .when(resettable, el => el.child(div().id("filter-clear").px(6).py(2).rounded(4).cursor_pointer().text_size(10)
        .text_color(colors().muted).hover(s => s.bg(theme().hover))
        .on_click((_e, cx) => {
          this.filterText = ""; this.filterInput.set_value("");
          this.filterStatuses = new Set(states().map(s => s.key)); this.filterBranches = new Set();
          cx.notify();
        }).child(tr("초기화", "Reset"))));
  }
  sidebar() {
    const sp = spaces(), ps = panes(), tabLabel = labelIndex(sp, ps), folderByTab = new Map();
    for (const pane of ps) if (pane.cwd && !folderByTab.has(pane.tab)) folderByTab.set(pane.tab, pane.cwd);
    const folderFor = space => space.tabs.map(tab => folderByTab.get(tab.id)).find(Boolean) || space.folder;
    const rows = sp.map(space => v_flex().flex_none().gap(1).mb(6)
      .child(h_flex().id(`space-${space.id}`).min_h(26).px(6).gap(4).items_center().rounded(5)
        .bg(space.active ? theme().selected : colors().white).cursor_pointer().hover(s => s.bg(theme().selected))
        .on_click(() => run("space.select", { id: space.id }))
        .on_mouse_down("right", () => openOverlay({ mod: "board-menu", kind: "popup", width: 220,
          props: { tab: "space", target: { id: space.id } } }))
        .when(Boolean(worktreeColor(space.branch)), el => el.child(dot(worktreeColor(space.branch), 6).tooltip(space.branch)))
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(11).tooltip(space.name).child(space.name))
        .child(div().id(`add-session-${space.id}`).px(5).py(2).flex_none().rounded(3)
          .tooltip(tr("현재 폴더 세션 / 새 워크트리", "New session in this folder / new worktree")).hover(s => s.bg(theme().hover))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            openOverlay({ mod: "board-session", kind: "dialog", width: 540, height: 260,
              props: { space: space.id, folder: spacePath(space), machine: space.machine } });
          }).child("+")))
      .child(div().px(8).text_size(9).text_color(theme().muted).tooltip(folderFor(space)).child(folderFor(space)))
      .when(Boolean(space.machine), el => el.child(div().px(8).text_size(9).text_color(colors().muted).child(space.machine)))
      .children(space.tabs.map(tab => h_flex().id(`tab-${tab.id}`).min_h(24).ml(8).px(6).gap(4)
        .items_center().rounded(4).cursor_pointer()
        .bg(space.active && tab.active ? theme().selected : colors().bg).hover(s => s.bg(theme().selected))
        .on_click(() => run("tab.select", { id: tab.id }))
        .on_mouse_down("right", () => openOverlay({ mod: "board-menu", kind: "popup", width: 220,
          props: { tab: "tab", target: { id: tab.id } } }))
        .child(dot(states().find(s => s.key === tab.status)?.color ?? colors().muted, 5))
        .child(div().flex_1().min_w(0).truncate().text_size(11).tooltip(tabLabel(tab.id)).child(tabLabel(tab.id))))));
    return v_flex().size_full().min_h(0).bg(colors().bg).text_color(colors().ink).text_size(11)
      .child(h_flex().h(36).flex_none().px(10).items_center().justify_between()
        .child(div().font_semibold().text_size(11.5).child("Spaces & tabs"))
        .child(div().id("board-new-space").px(5).py(2).rounded(3).cursor_pointer()
          .hover(s => s.bg(theme().selected)).tooltip(tr("폴더를 선택해 스페이스 추가", "Pick a folder to add a space"))
          .on_click((_e, cx) => cx.spawn(async () => {
            try {
              const folder = await pickFolder({ prompt: tr("스페이스로 열 폴더 선택", "Pick a folder to open as a space") });
              if (folder) run("space.new", { folder, machine: "" });
            } catch (error) { notify({ title: tr("폴더를 열 수 없습니다", "Could not open folder"), body: String(error), level: "error" }); }
          })).child("+")))
      .child(v_flex().flex_1().min_h(0).px(6).overflow_y_scrollbar().children(rows));
  }
  render() {
    const role = props()?.role;
    if (role === "sidebar") return this.sidebar();
    if (role === "path-tabs") return this.pathTabs();
    const list = agents(), allSpaces = spaces();
    const active = allSpaces.find(s => s.active);
    if (role === "header") return v_flex().size_full().bg(colors().white).px(16).justify_center().gap(8)
      .child(h_flex().items_center().gap(8)
        .child(h_flex().gap(2).items_center().children([12, 9, 15].map(h => div().w(4).h(h).rounded(2).bg(colors().violet))))
        .child(div().text_size(15).font_semibold().text_color(colors().ink).child(active?.name ?? "Project board"))
        .child(div().text_size(14).text_color(theme().border).child("/"))
        .child(div().text_size(11.5).text_color(colors().muted).child("Agent board"))
        .child(div().flex_1())
        .child(div().text_size(10).text_color(colors().muted).child(`${list.length} agents across ${spaces().length} spaces`))
        .child(div().id("board-ide-open").px(7).py(4).rounded(4).cursor_pointer()
          .bg(colors().bg).text_size(10.5).text_color(colors().ink).hover(s => s.bg(theme().hover))
          .tooltip(tr("현재 작업 위치를 IDE로 열기", "Open the current location in an IDE"))
          .on_click(() => openOverlay({ mod: "board-ide-menu", kind: "popup", width: 190, height: 4 * 32 + 8,
            props: { folder: active ? spacePath(active) : null, machine: active?.machine ?? null } }))
          .child(tr("IDE로 열기", "Open in IDE")))
        .child(div().id("board-files-toggle").px(7).py(4).rounded(4).cursor_pointer()
          .bg(findNode(layout(), "board-files-column")?.hidden ? colors().bg : theme().selected)
          .text_size(10.5).text_color(colors().ink).hover(s => s.bg(theme().hover))
          .tooltip(tr("파일 사이드바 열기 / 접기 (⌘⇧B)", "Show / hide the files sidebar (⌘⇧B)"))
          .on_click(() => run("layout.toggle", { id: "board-files-column" })).child("Files"))
        .child(h_flex().id("board-lang-toggle").flex_none().rounded(4).overflow_hidden().border(1).border_color(colors().line)
          .tooltip(tr("언어 전환", "Switch language"))
          .children(["ko", "en"].map(l => div().id(`board-lang-${l}`).px(6).py(4).cursor_pointer().text_size(9.5).font_semibold()
            .bg(lang() === l ? theme().selected : colors().bg).text_color(lang() === l ? colors().ink : colors().muted)
            .hover(s => s.bg(theme().hover)).on_click((_e, cx) => { setLang(l); cx.notify(); }).child(l.toUpperCase())))));
    if (role === "terminals") {
      const tab = active?.tabs.find(t => t.active), tabLabel = labelIndex(allSpaces, panes());
      return h_flex().size_full().px(10).items_center().gap(6).bg(colors().white)
        .child(dot(colors().violet, 6)).child(div().text_size(10.5).font_semibold().text_color(colors().ink).child("Live workspace"))
        .child(div().text_size(10).text_color(colors().muted).child(`${active?.name ?? ""} / ${tab ? tabLabel(tab.id) : ""}`));
    }
    if (role === "pane") {
      const p = panes().find(p => p.pane === props().pane);
      return h_flex().size_full().px(9).items_center().gap(5).bg(theme().chrome).border_b(1).border_color(colors().line)
        .child(icon(p?.program, 12)).child(div().text_size(10).text_color(colors().ink).child(p?.program?.name ?? "Terminal"))
        .child(div().flex_1()).child(dot(states().find(s => s.key === p?.status)?.color ?? colors().muted, 5))
        .when(Boolean(p && panes().filter(item => item.tab === p.tab).length > 1), el => el
          .child(div().id(`board-pane-close-${p.pane}`).px(5).rounded(3).cursor_pointer().tooltip(tr("패널 닫기", "Close pane"))
            .hover(s => s.bg(theme().hover)).on_click((_e, cx) => { cx.stop_propagation(); run("pane.close", { pane: p.pane }); }).child("×")));
    }
    const columns = states(), tabLabel = labelIndex(allSpaces, panes()), byId = spaceIndex(allSpaces);
    // 순서가 바뀔 때만 Herdr에 알립니다.
    const order = columns.flatMap(s => list.filter(a => a.status === s.key).map(a => a.address));
    const orderKey = order.join("\n");
    if (orderKey !== this.agentOrder) { this.agentOrder = orderKey; setAgentOrder(order); }
    const q = this.filterText.trim().toLowerCase();
    const filtered = list.filter(a => {
      if (!this.filterStatuses.has(a.status)) return false;
      if (this.filterBranches.size && !this.filterBranches.has(branchOf(a, byId))) return false;
      if (q && !`${a.tab_name} ${a.space_name} ${a.program?.name ?? ""} ${a.address}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return v_flex().size_full().bg(colors().bg)
      .child(this.filterBar())
      .child(h_flex().flex_1().min_h(0).px(14).py(9).gap(10).children(columns.map(state => {
        const cards = filtered.filter(a => a.status === state.key);
        return v_flex().flex_1().min_w(0).min_h(0).h_full().gap(5)
          .child(h_flex().h(19).flex_none().items_center().gap(5).px(2)
            .child(dot(state.color, 6)).child(div().text_size(11.5).font_semibold().text_color(colors().ink).child(state.label))
            .child(div().px(4).py(1).rounded(3).bg(state.wash).text_size(9).text_color(state.color).child(String(cards.length))))
          .child(cards.length > BOARD_VIRTUAL_MIN_CARDS ? this.virtualCards(cards, state, tabLabel, byId)
            : div().flex_1().min_h(0).relative()
              .child(v_flex().id(`board-cards-${state.key}`).absolute().inset_0().overflow_y_scroll().gap(5).children(cards.map(a => this.card(a, state, tabLabel, byId))))
              .child(Scrollbar.vertical(`board-cards-${state.key}`).absolute().inset_0()));
      })));
  }
  // 카드가 많은 열은 화면에 보이는 카드만 만듭니다(적을 때는 위의 기존 스크롤 그대로).
  virtualCards(cards, state, tabLabel, byId) {
    if (!this.cardScroll) { this.cardScroll = {}; this.cardView = {}; }
    const viewport = this.cardView[state.key] ?? 400;
    const { rows, window: w } = virtualSlice(cards, { rowHeight: CARD_STRIDE, viewport: viewport + 5, scroll: this.cardScroll[state.key] ?? 0, overscan: 2 });
    this.cardScroll[state.key] = w.scroll;
    const thumb = scrollThumb({ scroll: w.scroll, viewport, total: w.total - 5 });
    return div().id(`board-cards-${state.key}`).flex_1().min_h(0).relative().overflow_hidden()
      .on_size_change((size, cx) => {
        const h = size.height / (settings().zoom || 1);
        if (h !== this.cardView[state.key]) { this.cardView[state.key] = h; cx.notify(); }
      })
      .on_scroll_wheel((e, cx) => { this.cardScroll[state.key] = wheelScroll(this.cardScroll[state.key] ?? 0, e.delta?.y ?? 0, w.maxScroll); cx.notify(); })
      .children(rows.map(r => this.card(r.item, state, tabLabel, byId).absolute().top(r.top).left(0).right(0)))
      .when(Boolean(thumb), el => el.child(div().absolute().right(0).w(4).rounded(2).bg(colors().line).top(thumb.top).h(thumb.height)));
  }
}
