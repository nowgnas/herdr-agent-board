// 실제 mods/*/main.js를 스텁 런타임에서 렌더해, 큰 목록·diff에서 화면 밖 행을 만들지 않는지 확인합니다.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("./harness/loader.mjs", import.meta.url);
const gpui = await import("./harness/gpui.mjs");
const { byIdPrefix, findAll, stats } = gpui;

function makeCx() {
  const cx = { notified: 0, tasks: [], timers: [], afters: [] };
  cx.notify = () => { cx.notified++; };
  cx.spawn = fn => { const p = Promise.resolve().then(() => fn(cx)); cx.tasks.push(p); return p; };
  cx.timer = { every: (ms, fn) => cx.timers.push({ ms, fn }), after: (ms, fn) => cx.afters.push({ ms, fn }) };
  cx.stop_propagation = () => {};
  // watch 루프처럼 끝나지 않는 작업이 있어도 멈추지 않게, 잠깐 기다린 뒤 넘어갑니다.
  cx.settle = async () => {
    for (let i = 0; i < 20; i++) {
      const t = cx.tasks.splice(0);
      if (!t.length) break;
      await Promise.race([Promise.allSettled(t), new Promise(r => setTimeout(r, 30))]);
      await new Promise(r => setTimeout(r, 0));
    }
  };
  return cx;
}
const Z = n => Array.from({ length: n }, (_, i) => `?? gen/file-${String(i).padStart(6, "0")}.txt`).join("\0") + "\0";

let calls;
function env({ statusOut = Z(3), layout } = {}) {
  calls = [];
  globalThis.__herdr = {
    spaces: [{ id: "s1", active: true, folder: "/repo", machine: null, tabs: [{ id: "t1", active: true, index: 1 }] }],
    panes: [{ pane: "p1", tab: "t1", cwd: "/repo" }],
    focused: { pane: "p1", tab: "t1" },
    shared: new Map(),
    layout: layout ?? { id: "root", children: [{ id: "board-files-column", children: [{ id: "board-changes", size: { px: 160 } }, { id: "board-files" }] }] },
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "rev-parse") return { code: 0, stdout: "/repo\n", stderr: "" };
      if (args.includes("status")) return { code: 0, stdout: globalThis.__herdr.statusOut, stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
    statusOut,
  };
}
// git status 실행 상태·TTL은 모듈 메모리에 남으므로, 테스트마다 시계를 1분씩 앞당겨 이전 결과를 만료시킵니다.
const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
beforeEach(() => { clockOffset += 60000; env(); });

test("changes: 변경 파일이 적으면 기존처럼 전부 그린다", async () => {
  const { default: Changes } = await import("../mods/board-changes/main.js");
  const view = new Changes(), cx = makeCx();
  view.init({}, cx); await cx.settle();
  const tree = view.render(cx);
  assert.equal(byIdPrefix(tree, "change-").length, 3);
  assert.equal(byIdPrefix(tree, "changes-more").length, 0);
});

test("changes: 2만 개여도 보이는 행만 만들고 '+N개 더'·상한 안내", async () => {
  env({ statusOut: Z(20000) });
  const { default: Changes } = await import("../mods/board-changes/main.js");
  const view = new Changes(), cx = makeCx();
  view.init({}, cx); await cx.settle();
  let tree = view.render(cx);
  const rows = byIdPrefix(tree, "change-");
  assert.ok(rows.length > 0 && rows.length <= 16, `rows=${rows.length}`);
  const more = byIdPrefix(tree, "changes-more")[0];
  assert.equal(view.total, 20000);
  assert.match(more.kids.join(""), /^\+4,800개 더$/); // 처음 200개 표시, 상한 5,000까지 남은 개수
  // 버튼을 누르면 1,000개씩 늘어나 최대 5,000개
  for (let i = 0; i < 10; i++) byIdPrefix(view.render(cx), "changes-more")[0]?.handlers.on_click({}, cx);
  tree = view.render(cx);
  assert.equal(view.limit, 5000);
  assert.equal(byIdPrefix(tree, "changes-more").length, 0);
  assert.ok(findAll(tree, n => n.kids.some(k => typeof k === "string" && k.includes("외 15,000개는 표시하지 않음"))).length === 1);
  // 휠로 끝까지 내려도 보이는 행만
  const list = byIdPrefix(tree, "changes-list")[0];
  list.handlers.on_size_change({ height: 200, width: 300 }, cx);
  list.handlers.on_scroll_wheel({ delta: { y: -1e9 } }, cx);
  tree = view.render(cx);
  const last = byIdPrefix(tree, "change-");
  assert.ok(last.length <= 20, `rows=${last.length}`);
  assert.equal(last[last.length - 1].props.id, "change-gen/file-004999.txt");
});

test("changes: 결과가 같으면 notify하지 않고, 접히면 폴링하지 않음", async () => {
  const { default: Changes } = await import("../mods/board-changes/main.js");
  const view = new Changes(), cx = makeCx();
  view.init({}, cx); await cx.settle();
  const before = cx.notified, items = view.items;
  globalThis.__herdr.shared.clear(); // 공유 캐시를 비워 실제로 다시 실행하게
  view.refresh(cx); await cx.settle();
  assert.equal(cx.notified, before);
  assert.equal(view.items, items); // 배열을 갈아끼우지 않음
  globalThis.__herdr.layout.children[0].children[0].size.px = 26; // 접힘
  calls.length = 0;
  cx.timers[0].fn(cx); await cx.settle();
  assert.equal(calls.length, 0);
});

test("changes: 실행 중 경로가 바뀌면 끝난 뒤 새 경로로 다시 조회", async () => {
  const { default: Changes } = await import("../mods/board-changes/main.js");
  const view = new Changes(), cx = makeCx();
  view.init({}, cx); // 실행 시작(아직 끝나지 않음)
  globalThis.__herdr.panes[0].cwd = "/repo2";
  view.render(cx); // 경로 변경 감지 → loading이라 바로는 못 침
  await cx.settle();
  assert.ok(calls.some(c => c[0] === "git" && c[1] === "rev-parse"));
  assert.equal(view.key, JSON.stringify({ cwd: "/repo2", machine: null }));
  assert.ok(view.items !== null, "새 경로 결과가 한 주기를 기다리지 않고 채워짐");
});

test("files와 changes: 같은 저장소 status는 한 번만 실행", async () => {
  const { default: Changes } = await import("../mods/board-changes/main.js");
  const { default: Files } = await import("../mods/board-files/main.js");
  globalThis.__herdr.exec = (orig => async (cmd, args, opts) => (cmd === "sh" ? { code: 0, stdout: "", stderr: "" } : orig(cmd, args, opts)))(globalThis.__herdr.exec);
  const c = new Changes(), f = new Files(), cx = makeCx();
  c.init({}, cx); await cx.settle();
  f.init({}, cx); await cx.settle();
  assert.equal(calls.filter(x => x.includes("status")).length, 1);
  assert.equal(Object.keys(f.marks).length, 3);
});

test("preview: 3만 줄 diff도 보이는 행만 만들고 '+N줄 더'", async () => {
  const body = Array.from({ length: 30000 }, (_, i) => `+const v${i} = "${i}";`).join("\n");
  const diff = `diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -0,0 +1,30000 @@\n${body}\n`;
  globalThis.__herdr.exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "sh" && args[1].includes("head -c")) { assert.equal(args[3], "400001"); return { code: 0, stdout: diff.slice(0, 400001), stderr: "" }; }
    return { code: 1, stdout: "", stderr: "" };
  };
  globalThis.__herdr.shared.set("board.preview", { root: "/repo", path: "x.js", on: null, diffable: true });
  const { default: Preview } = await import("../mods/board-preview/main.js");
  const view = new Preview(), cx = makeCx();
  view.render(cx); await cx.settle();
  stats.created = 0;
  const tree = view.render(cx);
  const diffBox = byIdPrefix(tree, "board-preview-diff")[0];
  assert.ok(diffBox, "가상 스크롤 diff");
  const rows = diffBox.kids.filter(k => k.kind === "h_flex" || k.kind === "div");
  assert.ok(rows.length <= 60, `rows=${rows.length}`);
  assert.ok(stats.created < 1500, `created=${stats.created}`);
  assert.equal(view.diffTruncated, true);
  const more = byIdPrefix(tree, "board-preview-more")[0];
  assert.match(more.kids.join(""), /줄 더$/);
});

test("preview: 작은 diff는 기존처럼 전부 그린다", async () => {
  const diff = "diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n";
  globalThis.__herdr.exec = async (cmd) => (cmd === "sh" ? { code: 0, stdout: diff, stderr: "" } : { code: 1, stdout: "" });
  globalThis.__herdr.shared.set("board.preview", { root: "/repo", path: "y.js", on: null, diffable: true });
  const { default: Preview } = await import("../mods/board-preview/main.js");
  const view = new Preview(), cx = makeCx();
  view.render(cx); await cx.settle();
  const tree = view.render(cx);
  assert.equal(byIdPrefix(tree, "board-preview-diff").length, 0);
  assert.equal(byIdPrefix(tree, "board-preview-more").length, 0);
  assert.equal(view.diffLines.length, 3);
});

test("board: 카드 500개 열은 보이는 카드만, 적으면 전부", async () => {
  const { default: Board } = await import("../mods/board/main.js");
  const mk = (n, status) => Array.from({ length: n }, (_, i) => ({ address: `${status}-${i}`, status, tab: "t1", space: "s1", program: { name: "claude" }, tab_name: "", space_name: "s" }));
  globalThis.__herdr.agents = [...mk(500, "working"), ...mk(3, "done")];
  globalThis.__herdr.props = {};
  const view = new Board(), cx = makeCx();
  view.init({}, cx);
  const tree = view.render(cx);
  const working = byIdPrefix(tree, "agent-working-"), done = byIdPrefix(tree, "agent-done-");
  assert.ok(working.length > 0 && working.length <= 12, `working=${working.length}`);
  assert.equal(done.length, 3);
  const orders = globalThis.__herdr.orders.length;
  view.render(cx);
  assert.equal(globalThis.__herdr.orders.length, orders, "순서가 같으면 setAgentOrder 생략");
});

test("usage: 실행 중 경로를 여러 번 바꿔도 python은 하나, 끝난 뒤 한 번만 재실행", async () => {
  const pending = [];
  globalThis.__herdr.layout = { id: "root", children: [{ id: "board-usage", size: { px: 190 } }] };
  globalThis.__herdr.exec = (cmd, args) => { calls.push([cmd, ...args]); return new Promise(r => pending.push(r)); };
  const { default: Usage } = await import("../mods/board-usage/main.js");
  const view = new Usage(), cx = makeCx();
  view.init({}, cx);
  for (const cwd of ["/a", "/b/", "/c", "/d"]) { globalThis.__herdr.panes[0].cwd = cwd; view.render(cx); }
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls.length, 1, "실행 중에는 새 python을 띄우지 않음");
  pending.shift()({ code: 0, stdout: JSON.stringify({ sessions: 1, codex: {} }) });
  await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].at(-1), "/d"); // 마지막 경로로 한 번만
  pending.shift()({ code: 0, stdout: JSON.stringify({ sessions: 2, codex: {} }) });
  await new Promise(r => setTimeout(r, 0)); await new Promise(r => setTimeout(r, 0));
  assert.equal(view.data.sessions, 2);
  assert.equal(calls.length, 2);
  // 이전 경로로 돌아가면 기억한 결과를 바로 보여 주고 다시 실행하지 않음
  globalThis.__herdr.panes[0].cwd = "/d/"; view.render(cx);
  assert.equal(calls.length, 2);
  // 접히면 주기 갱신을 건너뜀
  globalThis.__herdr.layout.children[0].size.px = 36;
  cx.timers[0].fn(cx);
  assert.equal(calls.length, 2);
});

test("files: 경로별 펼침 상태 saved는 최근 20개만", async () => {
  globalThis.__herdr.exec = async (cmd, args) => (cmd === "sh" ? { code: 0, stdout: "", stderr: "" } : { code: 128, stdout: "", stderr: "" });
  const { default: Files } = await import("../mods/board-files/main.js");
  const view = new Files(), cx = makeCx();
  view.init({}, cx);
  for (let i = 0; i < 30; i++) { globalThis.__herdr.panes[0].cwd = `/p${i}`; view.refresh(cx); }
  assert.equal(view.saved.size, 20);
  assert.ok(view.saved.has(JSON.stringify({ cwd: "/p28", on: null, space: "s1" })));
  assert.ok(!view.saved.has(JSON.stringify({ cwd: "/p0", on: null, space: "s1" })));
});
