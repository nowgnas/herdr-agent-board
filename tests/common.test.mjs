// 공통 모듈(상한 상수·가상 스크롤·패널 상태) 순수 로직 테스트
import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "../mods/board-common/limits.js";
import { visibleWindow, wheelScroll, scrollThumb, nextLimit, virtualSlice } from "../mods/board-common/virtual.js";
import { findNode, panelState } from "../mods/board-common/panel.js";

test("상한 상수: changes 표시 상한과 files marks 상한이 같다", () => {
  assert.equal(L.STATUS_LIMIT, 5000);
  assert.equal(L.LIST_INITIAL, 200);
  assert.equal(L.DIFF_MAX_CHARS, 400000);
  assert.equal(L.DIFF_MAX_LINES, 5000);
  assert.ok(L.LIST_INITIAL <= L.STATUS_LIMIT);
  assert.equal(L.PICKER_SESSION_LIMIT, 200);
  assert.equal(L.FILES_SAVED_LIMIT, 20);
});

test("visibleWindow: 화면에 보이는 행 + overscan만 남긴다", () => {
  const w = visibleWindow({ count: 100000, rowHeight: 17, viewport: 340, scroll: 0, overscan: 3 });
  assert.equal(w.start, 0);
  assert.equal(w.end, 23); // 340/17 = 20 + overscan 3
  assert.equal(w.total, 1700000);
  assert.equal(w.maxScroll, 1700000 - 340);
  const mid = visibleWindow({ count: 100000, rowHeight: 17, viewport: 340, scroll: 17 * 5000, overscan: 3 });
  assert.equal(mid.start, 4997);
  assert.equal(mid.end, 5023);
  assert.ok(mid.end - mid.start <= 20 + 6);
});

test("visibleWindow: 스크롤 범위를 넘으면 끝으로 고정하고, 적은 목록은 전부", () => {
  const end = visibleWindow({ count: 1000, rowHeight: 10, viewport: 100, scroll: 1e9, overscan: 0 });
  assert.equal(end.scroll, 9900);
  assert.equal(end.end, 1000);
  assert.equal(end.start, 990);
  const small = visibleWindow({ count: 3, rowHeight: 10, viewport: 100, scroll: 50 });
  assert.equal(small.scroll, 0);
  assert.deepEqual([small.start, small.end], [0, 3]);
  const empty = visibleWindow({ count: 0, rowHeight: 10, viewport: 100, scroll: 0 });
  assert.deepEqual([empty.start, empty.end, empty.total], [0, 0, 0]);
});

test("virtualSlice: 10만 행 중 렌더 대상은 보이는 행 수만큼", () => {
  const items = Array.from({ length: 100000 }, (_, i) => i);
  const { rows, window: w } = virtualSlice(items, { rowHeight: 18, viewport: 360, scroll: 18 * 777, overscan: 2 });
  assert.equal(rows.length, w.end - w.start);
  assert.ok(rows.length <= 24);
  assert.equal(rows[0].item, 775);
  assert.equal(rows[0].top, 775 * 18 - w.scroll);
});

test("wheelScroll: 휠 delta 방향과 범위 고정", () => {
  assert.equal(wheelScroll(100, -30, 1000), 130);
  assert.equal(wheelScroll(10, 30, 1000), 0);
  assert.equal(wheelScroll(990, -30, 1000), 1000);
});

test("scrollThumb: 넘칠 때만 위치·크기를 돌려준다", () => {
  assert.equal(scrollThumb({ scroll: 0, viewport: 100, total: 80 }), null);
  const th = scrollThumb({ scroll: 450, viewport: 100, total: 1000, min: 10 });
  assert.equal(th.height, 10);
  assert.equal(th.top, 45 * (90 / 90)); // (scroll/maxScroll) * (viewport - height)
  const tiny = scrollThumb({ scroll: 0, viewport: 100, total: 1e7, min: 16 });
  assert.equal(tiny.height, 16);
});

test("nextLimit: 더 보기는 step만큼 늘리되 total·max를 넘지 않는다", () => {
  assert.equal(nextLimit(200, 300, 1000, 5000), 300);
  assert.equal(nextLimit(200, 20000, 1000, 5000), 1200);
  assert.equal(nextLimit(4800, 20000, 1000, 5000), 5000);
  assert.equal(nextLimit(5000, 20000, 1000, Infinity), 6000);
});

test("panelState: 접힘(px)과 자신/조상 hidden 판정", () => {
  const layout = { id: "root", children: [
    { id: "col", hidden: true, children: [{ id: "board-changes", size: { px: 26 } }] },
    { id: "side", children: [{ id: "board-usage", size: { weight: 190 } }, { id: "board-todo", size: { px: 170 } }] },
  ] };
  assert.equal(findNode(layout, "board-usage").id, "board-usage");
  assert.deepEqual(panelState(layout, "board-changes", { defaultPx: 160, collapsedBelow: 70 }), { collapsed: true, hidden: true, active: false });
  assert.deepEqual(panelState(layout, "board-usage", { defaultPx: 190, collapsedBelow: 80 }), { collapsed: false, hidden: false, active: true });
  assert.deepEqual(panelState(layout, "board-todo", { defaultPx: 170, collapsedBelow: 70 }), { collapsed: false, hidden: false, active: true });
  // 노드가 없으면(레이아웃 밖 마운트) 기존 기본값대로 펼침·표시로 본다
  assert.deepEqual(panelState(layout, "nope", { defaultPx: 160, collapsedBelow: 70 }), { collapsed: false, hidden: false, active: true });
  // 접힘 판정이 없는 패널(files)은 hidden만 본다
  assert.equal(panelState(layout, "board-changes", {}).collapsed, false);
});
