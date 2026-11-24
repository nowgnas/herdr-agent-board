// A small todo board, backed by plain markdown files so it's readable and
// editable outside Herdr too (any editor, `cat`, git).
//
// Data layout (configurable folder, default `<appHome>/todo`), split into
// year/month folders so it doesn't pile up as one flat directory:
//
//   <folder>/
//     .pet.json              the todo pet's species + lifetime completed count
//     2026/
//       11/
//         2026-11-24.md      one file per calendar day, auto-created on first visit
//         2026-11-25.md
//
// Only today's file is ever shown — there is no "add a list" here, just
// today's todos. Inside a day's file:
//
//   # Todo
//
//   - [ ] write the proposal
//   - [x] review PR #42
//
//   ## Later
//   - [ ] refactor auth module
//
// `##`-`######` headings become section labels inside the list; `- [ ]` /
// `- [x]` lines are the checkable items (click to toggle). Any other
// non-blank line is shown as plain, non-interactive text, so nothing in the
// file is silently hidden.
//
// Completing an item also feeds a small pet (see pets.js): it hatches and
// grows through a few stages as the lifetime completed count goes up. The
// species is picked at random the first time this mod runs for a folder and
// then stays fixed, stored in `.pet.json` next to the day files.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, exec, readTextFile, writeTextFile, notify, home, run, checking, theme, layout, shared, setShared, pickFolder } from "herdr";
import { STAGES, pickRandomPet, petById, stageForTotal, buildSprite, petName, stageName } from "./pets.js";
import { panelState } from "./_common/panel.js";
import { lang, tr } from "./_common/i18n.js";

// 기존 접힘 판정 그대로: (size.px ?? 170) < 70
const PANEL = { defaultPx: 170, collapsedBelow: 70 };
// A folder picked in-app (see chooseFolder) overrides the layout's own
// props.folder, so the save location can be changed without editing JSON.
function folderFor() {
  const p = shared("board.todo.folder") || props()?.folder;
  return p ? (p.startsWith("~") ? p.replace(/^~/, home()) : p) : null;
}
const HEADING_RE = /^(#{2,6})\s+(.*)$/;
const ITEM_RE = /^(\s*)-\s*\[([ xX])\]\s?(.*)$/;
function parseList(text) {
  const lines = text.split("\n");
  const rows = [];
  lines.forEach((raw, i) => {
    const h = HEADING_RE.exec(raw);
    if (h) { rows.push({ i, type: "heading", text: h[2].trim() }); return; }
    const box = ITEM_RE.exec(raw);
    if (box) { rows.push({ i, type: "item", indent: box[1].length, checked: /x/i.test(box[2]), text: box[3] }); return; }
    if (raw.trim() && !/^#\s/.test(raw)) rows.push({ i, type: "text", text: raw });
  });
  return { rows, lines };
}
function toggleLine(line) {
  return line.replace(/^(\s*-\s*)\[([ xX])\](.*)$/, (_m, pre, mark, rest) => `${pre}[${/x/i.test(mark) ? " " : "x"}]${rest}`);
}
function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  const day = new Date(y, m - 1, d).getDay();
  if (lang() === "en") return `${MONTH_EN[m - 1]} ${d} (${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]})`;
  const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
  return `${m}월 ${d}일 (${WEEK[day]})`;
}
function dayDir(folder, key) {
  const [y, m] = key.split("-");
  return `${folder}/${y}/${m}`;
}
function dayPath(folder, key) {
  return `${dayDir(folder, key)}/${key}.md`;
}

export default class Todo extends View {
  init(_props, cx) {
    this.folder = null;
    this.today = null;
    this.list = null; // { rows, lines, text }
    this.input = null; // created lazily inside refresh's async callback
    this.pet = null; // { species, total }
    this.petPath = null;
    this.petRaw = null;
    this.error = null;
    // Per-file write queues: writeTextFile uses optimistic concurrency (it
    // rejects if the file changed since we last read it), so two saves to
    // the same file must run one after another, never overlapped — otherwise
    // the second always "fails" because the first already moved the file
    // past the version it expected.
    this.saveQueue = Promise.resolve();
    this.petQueue = Promise.resolve();
    // While a save/grow write is queued but not yet on disk, the periodic
    // poll below must not re-read the file: it would still see the old
    // (pre-toggle) content, revert the optimistic UI state back, and then a
    // follow-up click would save against that stale text and get rejected
    // ("stale snapshot") — the write that looked like it silently failed.
    this.pendingWrites = 0;
    this.refresh(cx);
    cx.timer.every(15000, cx => { if (this.active()) this.refresh(cx); });
  }

  active() { return panelState(layout(), "board-todo", PANEL).active; }

  refresh(cx) {
    const folder = folderFor();
    const today = dateKey();
    if (folder !== this.folder || today !== this.today) {
      this.folder = folder; this.today = today;
      this.list = null; this.error = null; this.input = null;
    }
    if (!folder || this.loading || this.pendingWrites > 0 || checking()) return;
    this.loading = true;
    const key = `${folder}|${today}`;
    cx.spawn(async cx => {
      let unchanged = false;
      try {
        const path = dayPath(folder, today);
        let text = await readTextFile(path);
        if (text === null) {
          await exec("mkdir", ["-p", dayDir(folder, today)]);
          text = "# Todo\n\n";
          await writeTextFile(path, text, null);
        }
        const petPath = `${folder}/.pet.json`;
        let petText = await readTextFile(petPath);
        // 파일 텍스트와 pet이 그대로면 다시 파싱하거나 다시 그리지 않습니다.
        if (`${this.folder}|${this.today}` === key && this.list?.text === text && this.petRaw !== null && this.petRaw === petText && !this.error) {
          unchanged = true;
          return;
        }
        let pet;
        if (petText === null) {
          await exec("mkdir", ["-p", folder]);
          pet = { species: pickRandomPet(), total: 0 };
          petText = JSON.stringify(pet);
          await writeTextFile(petPath, petText, null);
        } else {
          pet = JSON.parse(petText);
        }
        if (`${this.folder}|${this.today}` === key) {
          this.list = { ...parseList(text), text };
          if (!this.input) {
            this.input = InputState.new({ value: "", placeholder: tr("오늘 할 일 추가", "Add a todo for today") });
            this.input.on("submit", (_e, cx) => this.addItem(cx));
          }
          this.petPath = petPath; this.pet = pet; this.petRaw = petText;
          this.error = null;
        }
      } catch (e) {
        if (`${this.folder}|${this.today}` === key) { this.error = String(e); this.list = null; }
      } finally { this.loading = false; if (!unchanged) cx.notify(); }
    });
  }

  // Updates local state right away (so the UI feels instant and the next
  // save() builds on this version), then queues the actual write behind any
  // save already in flight for this file.
  save(lines, cx) {
    const folder = this.folder, today = this.today, path = dayPath(folder, today);
    const text = lines.join("\n");
    const expected = this.list.text;
    this.list = { ...parseList(text), text };
    cx.notify();
    this.pendingWrites++;
    this.saveQueue = this.saveQueue
      .then(() => writeTextFile(path, text, expected))
      .then(
        () => { this.pendingWrites--; },
        () => {
          this.pendingWrites--;
          notify({ title: tr("todo 파일 저장 실패", "Failed to save todo file"), body: today, level: "error" });
          this.refresh(cx);
        },
      );
  }

  toggle(lineIndex, cx) {
    const row = this.list.rows.find(r => r.i === lineIndex);
    const lines = [...this.list.lines];
    lines[lineIndex] = toggleLine(lines[lineIndex]);
    this.save(lines, cx);
    if (row && !row.checked) this.grow(cx);
  }

  addItem(cx) {
    const text = (this.input?.value() ?? "").trim();
    if (!text) return;
    const lines = [...this.list.lines];
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(`- [ ] ${text}`, "");
    this.input.set_value("");
    this.save(lines, cx);
  }

  grow(cx) {
    if (!this.pet) return;
    const before = stageForTotal(this.pet.total);
    const pet = { ...this.pet, total: this.pet.total + 1 };
    const raw = JSON.stringify(pet);
    const expected = this.petRaw;
    this.pet = pet; this.petRaw = raw;
    cx.notify();
    this.pendingWrites++;
    this.petQueue = this.petQueue
      .then(() => writeTextFile(this.petPath, raw, expected))
      .then(
        () => {
          this.pendingWrites--;
          const after = stageForTotal(pet.total);
          if (after > before) {
            const species = petById(pet.species), name = petName(species), stage = stageName(STAGES[after]);
            notify({
              title: tr(`${name}가 "${stage}" 단계로 진화했어요!`, `${name} evolved into "${stage}"!`),
              body: tr("todo를 계속 완료해서 더 키워보세요", "Keep completing todos to grow it further"), level: "info",
            });
          }
        },
        () => { this.pendingWrites--; this.refresh(cx); },
      );
  }

  chooseFolder(cx) {
    cx.spawn(async cx => {
      const folder = await pickFolder({ prompt: tr("Todo 저장 폴더 선택", "Choose a folder to save Todo") });
      if (!folder) return;
      setShared("board.todo.folder", folder);
      cx.notify();
    });
  }

  row(r, t) {
    if (r.type === "heading") return div().flex_none().pt(6).pb(2).text_size(10).font_semibold().text_color(t.dim).child(r.text);
    if (r.type === "text") return div().flex_none().py(1).pl(4 + r.indent).text_size(11).text_color(t.dim).child(r.text);
    let box = div().flex_none().size(13).rounded(3).border_1().border_color(r.checked ? t.working : t.input)
      .flex().items_center().justify_center().text_size(9).text_color(t.solid_foreground).child(r.checked ? "✓" : "");
    if (r.checked) box = box.bg(t.working);
    return h_flex().id(`todo-${r.i}`).flex_none().gap(6).items_center().py(2).pl(4 + r.indent).rounded(4)
      .cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.toggle(r.i, cx))
      .child(box)
      .child(div().flex_1().min_w(0).text_size(11.5).text_color(r.checked ? t.dim : t.foreground).when(r.checked, el => el.line_through()).child(r.text || " "));
  }

  petCard(t) {
    const species = petById(this.pet.species), name = petName(species);
    const total = this.pet.total ?? 0;
    const idx = stageForTotal(total);
    const stage = STAGES[idx];
    const next = STAGES[idx + 1];
    const grid = buildSprite(stage, species);
    let sprite = v_flex().flex_none().gap(0).children(
      grid.map(row => h_flex().flex_none().gap(0).children(
        row.map(color => { const cell = div().flex_none().size(stage.cellPx); return color ? cell.bg(color) : cell; }))));
    if (stage.sparkle) sprite = sprite.loop("opacity", { from: 0.82, to: 1, period: 1500 });
    const pct = next ? Math.max(4, Math.min(100, Math.round(((total - stage.needs) / (next.needs - stage.needs)) * 100))) : 100;
    return v_flex().id("todo-pet").flex_none().items_center().gap(4).p(8).mb(4).rounded(8).bg(t.canvas)
      .border_1().border_color(stage.aura ? species.color : t.border)
      .when(Boolean(stage.aura), el => el.shadow_sm())
      .tooltip(tr(`${name} · 완료한 todo ${total}개`, `${name} · ${total} todos completed`))
      .child(sprite)
      .child(div().text_size(10).font_semibold().text_color(t.foreground).child(`${name} · ${stageName(stage)}`))
      .child(h_flex().w_full().h(4).rounded(2).bg(t.raised).overflow_hidden()
        .child(div().h_full().rounded(2).bg(species.color).w(`${pct}%`)))
      .child(div().text_size(8).text_color(t.dim).child(next ? tr(`다음 진화까지 ${next.needs - total}개`, `${next.needs - total} more to evolve`) : tr("최고 단계 달성", "Max stage reached")));
  }

  render(cx) {
    const folder = folderFor(), today = dateKey();
    const state = panelState(layout(), "board-todo", PANEL);
    if (folder !== this.folder || today !== this.today) this.refresh(cx);
    else if (state.active && this.wasActive === false) this.refresh(cx); // 다시 펼치면 바로 갱신
    this.wasActive = state.active;
    const t = theme(), collapsed = state.collapsed;
    return v_flex().size_full().min_h(0).bg(t.canvas).border_t(1).border_color(t.border).text_color(t.foreground)
      .child(h_flex().id("todo-toggle").h(26).flex_none().px(10).gap(6).items_center().cursor_pointer().hover(s => s.bg(t.hover))
        .tooltip(collapsed ? tr("Todo 펼치기", "Expand Todo") : tr("Todo 접기", "Collapse Todo"))
        .on_click(() => run("layout.resize", collapsed ? { id: "board-todo", weight: 170 } : { id: "board-todo", px: 26 }))
        .child(div().flex_1().text_size(10).font_semibold().child(`Todo · ${dateLabel(today)}`))
        .child(div().id("todo-folder-btn").text_size(11).text_color(t.muted).cursor_pointer().hover(s => s.text_color(t.foreground))
          .tooltip(folder ? tr(`저장 위치: ${folder}\n클릭하여 변경`, `Save location: ${folder}\nClick to change`) : tr("저장 폴더 선택", "Choose save folder"))
          .on_click((_e, cx) => { cx.stop_propagation(); this.chooseFolder(cx); })
          .child("📁"))
        .child(div().text_color(t.muted).child(collapsed ? "▸" : "▾")))
      .when(!collapsed, el => el.child(v_flex().flex_1().min_h(0).p(8).gap(4).overflow_y_scrollbar()
        .when(!folder, e => e.child(div().p(8).text_size(11).text_color(t.dim).child(tr("props.folder가 설정되지 않았습니다", "props.folder is not set"))))
        .when(Boolean(folder) && Boolean(this.error), e => e.child(div().p(8).text_size(11).text_color(t.dim).child(this.error)))
        .when(Boolean(folder) && !this.error && this.list === null, e => e.child(div().p(8).text_size(11).text_color(t.dim).child(tr("불러오는 중…", "Loading…"))))
        .when(Boolean(folder) && !this.error && Boolean(this.list), e => e
          .when(Boolean(this.pet), el2 => el2.child(this.petCard(t)))
          .children(this.list.rows.map(r => this.row(r, t)))
          .when(Boolean(this.input), el2 => el2.child(Input.new(this.input).flex_none().h(26).px(7).mt(2).rounded(5).border_1().border_color(t.input).bg(t.background).text_size(11).text_color(t.foreground))))));
  }
}
