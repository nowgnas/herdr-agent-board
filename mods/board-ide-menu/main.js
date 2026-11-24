// Small popup opened from the board header's "IDE로 열기" button: launches
// the current space's working folder in one of a few common editors.
// `mac` is the app name for `open -a` (works without any CLI tool installed);
// `cli` is the command-line launcher name used on Windows/Linux, where these
// are normally already on PATH after a standard install.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, exec, notify, window, closeOverlay, theme } from "herdr";
import { tr } from "./_common/i18n.js";

const IDES = [
  { id: "intellij", name: "IntelliJ IDEA", mac: "IntelliJ IDEA", cli: "idea" },
  { id: "rider", name: "Rider", mac: "Rider", cli: "rider" },
  { id: "cursor", name: "Cursor", mac: "Cursor", cli: "cursor" },
  { id: "vscode", name: "VS Code", mac: "Visual Studio Code", cli: "code" },
];

export default class IdeMenu extends View {
  open(ide, cx) {
    const { folder, machine, overlay } = props();
    closeOverlay(overlay);
    if (!folder) return;
    if (machine) { notify({ title: tr("원격 폴더는 IDE로 열 수 없습니다", "Remote folders can't be opened in an IDE"), body: folder, level: "error" }); return; }
    const platform = window()?.platform;
    cx.spawn(async () => {
      try {
        if (platform === "windows" || platform === "linux") await exec(ide.cli, [folder]);
        else await exec("open", ["-a", ide.mac, folder]);
      } catch {
        notify({ title: tr(`${ide.name}을(를) 열 수 없습니다`, `Could not open ${ide.name}`), body: tr("설치 여부와 커맨드라인 실행 파일(PATH) 등록을 확인해주세요", "Check that it's installed and its command-line launcher is on PATH"), level: "error" });
      }
    });
  }

  render(cx) {
    const t = theme(), folder = props()?.folder;
    return v_flex().size_full().bg(t.popover).text_color(t.foreground).text_size(12).py(4)
      .children(IDES.map(ide => h_flex().id(`ide-${ide.id}`).h(32).px(12).items_center().cursor_pointer().hover(s => s.bg(t.hover))
        .tooltip(folder ?? "")
        .on_click((_e, cx) => this.open(ide, cx)).child(ide.name)));
  }
}
