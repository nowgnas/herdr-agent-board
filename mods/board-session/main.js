import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { props, spaces, panes, run, theme, openOverlay, closeOverlay } from "herdr";

export default class SessionChoice extends View {
  render() {
    const space = spaces().find(s => s.active);
    const ids = new Set(space?.tabs.map(t => t.id) ?? []);
    const folder = panes().find(p => ids.has(p.tab) && p.cwd)?.cwd ?? space?.folder;
    const p = { space: space?.id, folder, machine: space?.machine, ...(props() ?? {}) }, t = theme();
    const option = (id, title, detail, action) => v_flex().id(id).p(12).gap(4).rounded(8)
      .border(1).border_color(t.border).bg(t.surface).cursor_pointer().hover(s => s.bg(t.hover))
      .on_click(action).child(div().font_semibold().text_color(t.foreground).child(title))
      .child(div().text_size(12).text_color(t.muted).child(detail));
    return v_flex().size_full().p(16).gap(12).bg(t.popover).text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child("세션을 어디에서 열까요?"))
      .child(div().text_size(11).text_color(t.muted).child(p.folder ?? ""))
      .child(option("session-current", "현재 경로에서 열기", "같은 폴더에 새 터미널 탭을 엽니다.", () => {
        closeOverlay(p.overlay);
        run("tab.new", { space: p.space, folder: p.folder });
      }))
      .child(option("session-worktree", "새 워크트리 만들기", "별도 폴더와 브랜치로 작업합니다. Git 저장소가 필요합니다.", () => {
        closeOverlay(p.overlay);
        openOverlay({ mod: "board-worktree", kind: "dialog", width: 620, height: 400,
          props: { space: p.space, folder: p.folder, machine: p.machine, action: "new" } });
      }));
  }
}
