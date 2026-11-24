// 화면 밖 행을 만들지 않는 가상 스크롤 계산(순수 함수). board-picker의 visible 행
// 패턴과 같이, 고정 높이 행의 위치만 계산하고 보이는 범위만 그리게 합니다.

const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, hi));

export function visibleWindow({ count, rowHeight, viewport, scroll = 0, overscan = 4 }) {
  const total = Math.max(0, count) * rowHeight;
  const maxScroll = Math.max(0, total - viewport);
  const s = clamp(Number(scroll) || 0, 0, maxScroll);
  if (!count) return { start: 0, end: 0, scroll: 0, maxScroll: 0, total: 0 };
  const start = Math.max(0, Math.floor(s / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((s + viewport) / rowHeight) + overscan);
  return { start, end, scroll: s, maxScroll, total };
}

// 보이는 행만 { item, index, top }으로 돌려줍니다. top은 뷰포트 기준 y.
export function virtualSlice(items, { rowHeight, viewport, scroll, overscan }) {
  const w = visibleWindow({ count: items.length, rowHeight, viewport, scroll, overscan });
  const rows = [];
  for (let i = w.start; i < w.end; i++) rows.push({ item: items[i], index: i, top: i * rowHeight - w.scroll });
  return { rows, window: w };
}

// gpui on_scroll_wheel의 delta는 위로 굴리면 양수(board-picker와 같은 부호).
export function wheelScroll(scroll, delta, maxScroll) {
  return clamp(scroll - delta, 0, Math.max(0, maxScroll));
}

// 표시용 스크롤 막대(thumb). 넘치지 않으면 null.
export function scrollThumb({ scroll, viewport, total, min = 16 }) {
  if (!(total > viewport) || viewport <= 0) return null;
  const height = Math.max(min, Math.round(viewport * viewport / total));
  const maxScroll = total - viewport;
  const top = maxScroll > 0 ? (clamp(scroll, 0, maxScroll) / maxScroll) * (viewport - height) : 0;
  return { top, height };
}

// "+N개 더": step만큼 늘리되 실제 개수(total)와 상한(max)을 넘지 않게.
export function nextLimit(current, total, step, max = Infinity) {
  return Math.min(total, max, current + step);
}
