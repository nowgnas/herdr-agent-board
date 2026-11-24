// 레이아웃 노드 상태(접힘·숨김) 판정. 접히거나 숨겨진 패널은 폴링하지 않습니다.

export function findNode(root, id) {
  if (root?.id === id) return root;
  for (const child of root?.children ?? []) { const found = findNode(child, id); if (found) return found; }
  return null;
}

function pathTo(root, id, trail = []) {
  if (!root) return null;
  const next = [...trail, root];
  if (root.id === id) return next;
  for (const child of root.children ?? []) { const found = pathTo(child, id, next); if (found) return found; }
  return null;
}

// collapsedBelow/defaultPx는 각 패널의 기존 접힘 판정 값 그대로 넘깁니다
// (예: changes는 (size.px ?? 160) < 70). 노드나 조상 중 하나라도 hidden이면 숨김.
export function panelState(root, id, { defaultPx, collapsedBelow } = {}) {
  const trail = pathTo(root, id);
  const node = trail?.[trail.length - 1] ?? null;
  const hidden = Boolean(trail?.some(n => n.hidden));
  const collapsed = collapsedBelow !== undefined && (node?.size?.px ?? defaultPx) < collapsedBelow;
  return { collapsed, hidden, active: !collapsed && !hidden };
}
