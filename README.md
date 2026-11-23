# herdr-agent-board

A custom **"board"** layout for [Herdr](https://herdr.dev) — a kanban-style
view of every agent terminal (Claude Code, Codex, ...) across all your
spaces, plus a set of small panels for day-to-day review work: what
changed, what it costs, and where to open it next.

![preview](mods/board/preview.svg)

## What it looks like

```
┌─ Spaces & tabs ─┬──────────── Agent board ─────────────┬─ Files ──────┐
│                 │ Needs you │ Working │ Done │ Idle     │ Changed     │
│  space list     │  (filter bar: text / status / branch) │ files       │
│                 ├───────────────────────────────────────┤             │
│  스킬·하네스     │   path tabs (⌘1-9)                    │ file tree   │
│  사용량 + 비용   │   live terminal / diff preview         │             │
│                 │                                        │ recent      │
│                 │                                        │ commits     │
└─────────────────┴────────────────────────────────────────┴─────────────┘
```

## Features

- **Agent board** — every agent across every space, grouped into
  Needs you / Working / Done / Idle columns, with a filter bar
  (free-text search, status toggles, worktree-branch toggles) and a
  stable per-branch color dot so the same worktree always tags the same
  way.
- **Path tabs** — the same tab, across every space on the current
  machine, as quick-jump pills; `⌘1`-`⌘9` jump straight to the Nth one.
- **변경된 파일 (Changed files)** — every uncommitted change in the
  focused repo in one flat list (no digging through the file tree);
  click a row to see its diff.
- **Diff viewer** — clicking a changed file renders a real diff (`git
  diff HEAD`) with colored +/- backgrounds, old/new line numbers, and a
  lightweight per-language syntax highlighter (comments, strings,
  numbers, keywords) — not just a flat text dump. A toggle switches
  between the diff and the full current file.
- **파일 탐색기 (Files)** — a lazy file tree with git status marks
  (M/A/D/U) on files *and* on collapsed folders that contain changes,
  click-to-browser-open for `.html`/`.htm` (with an explicit source-view
  button too).
- **최근 커밋 (Recent commits)** — the last 30 commits in the focused
  repo; expand one to see its changed files, click to preview the
  current working-tree version.
- **스킬·하네스 사용량 (Skill/harness usage + cost)** — for both Claude
  Code and Codex CLI: how many of the last month's sessions used a Skill
  or Forge, the top skills by call count, and an **estimated dollar
  cost** for the current project and for the whole account, broken down
  by engine (Claude Code vs Codex), computed from each session's token
  usage against published per-model rates.
- **IDE로 열기 (Open in IDE)** — a header button that opens the current
  space's folder in IntelliJ IDEA, Rider, Cursor, or VS Code (`open -a`
  on macOS, the CLI launcher on Windows/Linux).
- **Worktree-aware** — spaces/tabs that are git worktrees get a color
  tag derived from their branch name, shared across the sidebar, path
  tabs, and filter bar.

## Layout

| File | What it is |
|---|---|
| `layouts/board.json` | the whole window: sidebar, header, kanban grid, live terminal / diff split, file sidebar |
| `themes/board-readable-dark.json` | the dark theme this layout uses |

## Mods

| Mod | Role |
|---|---|
| `mods/board` | kanban grid, sidebar, header, path tabs, pane header, filter bar |
| `mods/board-changes` | flat list of every uncommitted change |
| `mods/board-files` | lazy file tree with git status marks and html open-in-browser |
| `mods/board-preview` | diff viewer / full-file preview (shared by board-files, board-changes, board-timeline) |
| `mods/board-timeline` | recent commit log with expandable file lists |
| `mods/board-usage` | Claude/Codex skill & forge usage + estimated cost |
| `mods/board-ide-menu` | the "IDE로 열기" popup |
| `mods/board-menu` | right-click context menu for spaces/tabs |
| `mods/board-picker` | `⌘P` mod/agent picker |
| `mods/board-session` | new-session / worktree dialog |
| `mods/board-worktree` | worktree base helper shared by the above |

Only this layout and these mods are tracked here — Herdr's own shipped
layouts and mods (`main`, `terminals`, `win98`, `spaces`, `agents`, ...)
are rewritten by Herdr on every start, so they're intentionally left out
(see `.gitignore`).

## Installing

Copy into your Herdr home (`~/.config/herdr-app` by default, see
`HERDR_APP_HOME`):

```sh
git clone https://github.com/nowgnas/herdr-agent-board.git /tmp/herdr-agent-board
cp -R /tmp/herdr-agent-board/layouts/board.json ~/.config/herdr-app/layouts/
cp -R /tmp/herdr-agent-board/themes/board-readable-dark.json ~/.config/herdr-app/themes/
cp -R /tmp/herdr-agent-board/mods/board*/ ~/.config/herdr-app/mods/
herdr-app do layout.switch --name board
```

Then add these bindings to your own `keys.json` under a `"layout:board"`
section (not tracked here, since it's a single shared file):

```json
{
  "layout:board": {
    "cmd-p": "mod.open:board-picker",
    "cmd-d": "board.grid-split",
    "cmd-shift-b": "layout.toggle:board-files-column",
    "cmd-1": "board.path-tab-1",
    "cmd-2": "board.path-tab-2",
    "cmd-3": "board.path-tab-3",
    "cmd-4": "board.path-tab-4",
    "cmd-5": "board.path-tab-5",
    "cmd-6": "board.path-tab-6",
    "cmd-7": "board.path-tab-7",
    "cmd-8": "board.path-tab-8",
    "cmd-9": "board.path-tab-9"
  }
}
```

## Notes

- `board-usage`'s cost numbers are **estimates** from published per-model
  token pricing, not your actual bill — Codex pricing in particular uses
  one flat approximate rate since no per-model rate table was available.
- The usage/cost scan shells out to `python3`; the diff/changed-files/
  timeline panels shell out to `git`.
- `herdr-app check mods/<name>` validates each mod after any edit — see
  Herdr's own `AGENTS.md` for the full authoring reference.
