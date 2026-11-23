// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, setShared, run, notify } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const HTML_EXT = new Set(["html", "htm"]);

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.visibleRows = 200;
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => {
      if (this.on || !this.watched) this.queueRefresh(null, cx);
      this.refreshGit(cx);
    });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watchRequest?.cancel();
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        while (this.context === context) {
          const request = watchFolder(root);
          this.watchRequest = request;
          const paths = await request;
          if (this.watchRequest === request) this.watchRequest = null;
          if (this.current(context) && paths.length) this.queueRefresh(paths, cx);
        }
      } catch { if (this.context === context) this.watched = null; }
    });
  }

  queueRefresh(paths, cx) {
    if (!this.context) return;
    if (!paths) this.dirtyAll = true;
    else for (const path of paths) {
      if (path === this.root || !path.startsWith(this.root + "/")) { this.dirtyAll = true; continue; }
      const relative = path.slice(this.root.length + 1);
      const parts = relative.split("/");
      for (let i = 0; i < parts.length; i++) {
        const folder = parts.slice(0, i).join("/");
        if (!folder || this.folders.has(folder)) this.dirty.add(folder);
      }
    }
    if (this.queued) return;
    this.queued = true;
    const context = this.context;
    cx.timer.after(500, cx => {
      if (this.context !== context) return;
      this.queued = false;
      this.refresh(cx);
      this.refreshGit(cx);
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      this.watchRequest?.cancel(); this.watchRequest = null;
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on;
      this.entries = new Map(); this.folders = new Set(saved?.folders); this.pending = new Set();
      this.marks = {}; this.watched = null; this.error = null; this.limited = false; this.visibleRows = 200;
      this.loading = false; this.gitLoading = false; this.gitAt = 0; this.queued = false;
      this.dirty = new Set(); this.dirtyAll = true;
      if (cwd) { this.watch(cwd, cx); this.refreshGit(cx); }
    }
    if (!cwd || this.loading || (!this.dirtyAll && !this.dirty.size)) return;
    const context = this.context;
    const paths = this.dirtyAll ? ["", ...this.folders] : [...this.dirty];
    this.dirtyAll = false; this.dirty.clear(); this.loading = true; this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of paths) {
          if (!this.current(context)) return;
          if (!path || this.folders.has(path)) await this.loadFolder(path, context);
        }
        if (this.current(context)) this.error = null;
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) {
          this.loading = false;
          if (this.dirtyAll || this.dirty.size) this.queueRefresh([], cx);
        }
        cx.notify();
      }
    });
  }

  refreshGit(cx) {
    const context = this.context, cwd = context?.cwd, on = context?.on;
    if (!cwd || this.gitLoading || Date.now() - this.gitAt < 30000) return;
    this.gitLoading = true; this.gitAt = Date.now();
    cx.spawn(async cx => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (this.current(context)) {
          this.marks = marks;
        }
      } finally { if (this.context === context) this.gitLoading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path) {
    if (!path || !this.root) return;
    const diffable = Boolean(this.marks[`${this.root}/${path}`]);
    setShared("board.preview", { root: this.root, path, on: this.on, diffable });
    run("layout.show", { id: "board-preview" });
  }

  openInBrowser(path, cx) {
    if (!path || !this.root) return;
    if (this.on) { notify({ title: "원격 파일은 브라우저로 열 수 없습니다", body: path, level: "error" }); return; }
    const abs = `${this.root}/${path}`, platform = window()?.platform;
    cx.spawn(async () => {
      try {
        if (platform === "windows") await exec("cmd", ["/c", "start", "", abs]);
        else if (platform === "linux") await exec("xdg-open", [abs]);
        else await exec("open", [abs]);
      } catch (e) { notify({ title: "브라우저로 열기 실패", body: String(e), level: "error" }); }
    });
  }

  // How many changed files sit under each folder, so a collapsed folder still
  // signals "something changed inside" without expanding it.
  dirtyCounts() {
    const counts = new Map();
    for (const full in this.marks) {
      if (!this.root || !full.startsWith(this.root + "/")) continue;
      const rel = full.slice(this.root.length + 1);
      const parts = rel.split("/");
      for (let i = 1; i < parts.length; i++) {
        const folder = parts.slice(0, i).join("/");
        counts.set(folder, (counts.get(folder) ?? 0) + 1);
      }
    }
    return counts;
  }

  rows(prefix, depth, out, dirty) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const open = this.folders.has(path);
      out.push({ entry, path, open, depth, mark: this.marks[`${this.root}/${path}`], dirty: entry.dir ? dirty.get(path) : undefined });
      if (entry.dir && open) this.rows(path, depth + 1, out, dirty);
    }
    return out;
  }

  row({ entry, path, open, depth, mark, dirty }, t) {
    const ext = !entry.dir && path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
    const isHtml = !entry.dir && HTML_EXT.has(ext);
    return h_flex().id(`file-${path}`).h(28).flex_none().pl(14 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
      .tooltip(isHtml ? "클릭: 브라우저로 열기" : "")
      .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : isHtml ? this.openInBrowser(path, cx) : this.show(path, cx))
      .child(entry.dir ? svg(`mods/board-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(svg(`mods/board-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(dirty ? t.blocked : t.muted))
      .child(div().flex_1().min_w(0).truncate().child(entry.name))
      .when(isHtml, el => el
        .child(div().id(`file-open-${path}`).flex_none().px(5).py(1).rounded(4).text_size(11).text_color(t.dim)
          .hover(s => s.bg(t.selected)).tooltip("기본 브라우저로 열기")
          .on_click((_e, cx) => { cx.stop_propagation(); this.openInBrowser(path, cx); }).child("↗"))
        .child(div().id(`file-src-${path}`).flex_none().px(5).py(1).rounded(4).text_size(10).text_color(t.dim)
          .hover(s => s.bg(t.selected)).tooltip("소스 코드 보기")
          .on_click((_e, cx) => { cx.stop_propagation(); this.show(path); }).child("</>")))
      .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)))
      .when(Boolean(dirty) && !open, el => el.child(div().flex_none().px(4).py(0.5).rounded(3).bg(t.raised).text_size(9).text_color(t.blocked).tooltip(`변경된 파일 ${dirty}개`).child(String(dirty))));
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), rows = this.rows("", 0, [], this.dirtyCounts());
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.root?.split(/[\\/]/).pop() ?? "")))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().children(rows.slice(0, this.visibleRows).map(row => this.row(row, t)))
        .when(rows.length > this.visibleRows, el => el.child(div().id("files-more").p(8).cursor_pointer().text_size(12).text_color(t.muted).hover(s => s.bg(t.hover)).on_click((_e, cx) => { this.visibleRows += 200; cx.notify(); }).child(`더 보기 (${rows.length - this.visibleRows})`)))
        .when(Boolean(this.error) || (!rows.length && !this.limited), el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder")))))
      .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")));
  }
}
