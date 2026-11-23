import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, focused, props, run, exec, appHome, checking, theme, layout } from "herdr";

function node(root, id) {
  if (root?.id === id) return root;
  for (const child of root?.children ?? []) { const item = node(child, id); if (item) return item; }
  return null;
}
function current() {
  const space = spaces().find(s => s.active), focus = focused();
  const pane = panes().find(p => p.pane === focus?.pane);
  return { cwd: pane?.cwd || focus?.cwd || space?.folder || "", machine: space?.machine ?? null };
}
export default class Usage extends View {
  init(_props, cx) {
    this.refresh(cx);
    cx.timer.every(120000, cx => this.refresh(cx, true));
  }
  refresh(cx, periodic = false) {
    const loc = current(), key = JSON.stringify(loc);
    if (key !== this.key) { this.key = key; this.data = null; this.error = null; this.loading = false; }
    if (!loc.cwd || loc.machine || this.loading || checking()) return;
    if (!periodic && this.data) return;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const result = await exec("python3", [`${appHome()}/mods/board-usage/usage.py`, loc.cwd]);
        if (result.code !== 0) throw new Error("기록을 읽을 수 없습니다");
        if (this.key === key) { this.data = JSON.parse(result.stdout); this.error = null; }
      } catch { if (this.key === key) this.error = "기록 조회 실패"; }
      finally { if (this.key === key) this.loading = false; cx.notify(); }
    });
  }
  render(cx) {
    const loc = current();
    if (JSON.stringify(loc) !== this.key) this.refresh(cx);
    const t = theme(), collapsed = (node(layout(), "board-usage")?.size?.px ?? 190) < 80;
    const ratio = (n, total) => total ? `${n}/${total} · ${Math.round(100 * n / total)}%` : "관측된 세션 없음";
    // Share of sessions that actually used the feature: higher share reads as
    // "working" (green), none at all stays dim rather than alarming red.
    const ratioColor = (n, total) => !total ? t.dim : n / total >= 0.5 ? t.working : n > 0 ? t.ansi3 : t.dim;
    const dollars = n => `$${(n ?? 0).toFixed(2)}`;
    const codex = this.data?.codex;
    return v_flex().size_full().min_h(0).bg(t.canvas).border_t(1).border_color(t.border).text_color(t.foreground)
      .child(h_flex().id("usage-toggle").h(36).flex_none().px(12).gap(6).items_center().cursor_pointer().hover(s => s.bg(t.hover))
        .tooltip(collapsed ? "사용 현황 펼치기" : "사용 현황 접기")
        .on_click(() => run("layout.resize", collapsed ? { id: "board-usage", weight: 190 } : { id: "board-usage", px: 36 }))
        .child(div().flex_1().text_size(12).font_semibold().child("스킬 · 하네스"))
        .child(div().text_color(t.muted).child(collapsed ? "▴" : "▾")))
      .when(!collapsed, el => el.child(v_flex().flex_1().min_h(0).px(12).pb(8).gap(5).overflow_y_scrollbar().text_size(11)
        .when(Boolean(this.data), e => e.child(v_flex().flex_none().mb(4).pb(6).gap(2).border_b(1).border_color(t.border)
          .child(div().text_size(9).text_color(t.muted).child("계정 전체 추정 비용 · 당월"))
          .child(h_flex().justify_between()
            .child(div().text_color(t.ansi5).child("Claude")).child(div().font_semibold().text_color(t.working).child(dollars(this.data.account_cost_usd))))
          .child(h_flex().justify_between()
            .child(div().text_color(t.ansi6).child("Codex")).child(div().font_semibold().text_color(t.working).child(dollars(codex?.account_cost_usd))))
          .child(h_flex().justify_between().pt(2).border_t(1).border_color(t.border)
            .child(div().font_semibold().child("합계")).child(div().font_semibold().text_color(t.foreground).child(dollars((this.data.account_cost_usd ?? 0) + (codex?.account_cost_usd ?? 0)))))))
        .child(div().text_color(t.muted).child("현재 경로 · 당월 갱신 세션"))
        .when(Boolean(loc.machine), e => e.child(div().text_color(t.muted).child("원격 세션은 관측할 수 없습니다")))
        .when(!loc.machine && Boolean(this.error), e => e.child(div().text_color(t.muted).child(this.error ?? "")))
        .when(!loc.machine && !this.data && !this.error, e => e.child(div().text_color(t.muted).child(loc.cwd ? "기록 불러오는 중…" : "선택된 경로 없음")))
        .when(!loc.machine && Boolean(this.data), e => e
          .child(div().text_color(t.ansi5).font_semibold().child("Claude"))
          .child(h_flex().justify_between().child(div().text_color(t.muted).child("스킬 호출"))
            .child(div().text_color(ratioColor(this.data.skill_sessions, this.data.sessions)).child(ratio(this.data.skill_sessions, this.data.sessions))))
          .child(h_flex().justify_between().child(div().text_color(t.muted).child("Forge 호출"))
            .child(div().text_color(ratioColor(this.data.forge_sessions, this.data.sessions)).child(ratio(this.data.forge_sessions, this.data.sessions))))
          .children((this.data.top ?? []).map(([name, count]) => h_flex().gap(6)
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(name)).child(div().text_color(t.ansi5).child(`${count}회`))))
          .when(this.data.errors > 0, x => x.child(div().text_color(t.dim).child("Claude 일부 기록 읽기 실패")))
          .child(h_flex().justify_between().mt(2).child(div().text_color(t.muted).child("추정 비용")).child(div().font_semibold().text_color(t.working).child(dollars(this.data.cost_usd))))
          .child(div().mt(6).pt(6).border_t(1).border_color(t.border).text_color(t.ansi6).font_semibold().child("Codex"))
          .child(h_flex().justify_between().child(div().text_color(t.muted).child("스킬 호출"))
            .child(div().text_color(ratioColor(codex?.skill_sessions ?? 0, codex?.sessions ?? 0)).child(ratio(codex?.skill_sessions ?? 0, codex?.sessions ?? 0))))
          .child(h_flex().justify_between().child(div().text_color(t.muted).child("Forge 호출"))
            .child(div().text_color(ratioColor(codex?.forge_sessions ?? 0, codex?.sessions ?? 0)).child(ratio(codex?.forge_sessions ?? 0, codex?.sessions ?? 0))))
          .children((codex?.top ?? []).map(([name, count]) => h_flex().gap(6)
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(name)).child(div().text_color(t.ansi6).child(`${count}회`))))
          .when((codex?.errors ?? 0) > 0, x => x.child(div().text_color(t.dim).child("Codex 일부 기록 읽기 실패")))
          .child(h_flex().justify_between().mt(2).child(div().text_color(t.muted).child("추정 비용")).child(div().font_semibold().text_color(t.working).child(dollars(codex?.cost_usd)))))
        .when(!loc.machine && Boolean(this.data), e => e.child(div().mt(6).pt(4).text_color(t.dim).text_size(9).child("비용은 공개 단가 기준 추정치이며 실제 청구액과 다를 수 있습니다")))));
  }
}
