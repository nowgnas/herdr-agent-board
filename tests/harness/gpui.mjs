// gpui-kit/gpui-base 스텁: 모든 메서드가 자신을 돌려주는 요소. 만든 요소 수와 핸들러를 기록합니다.
export const stats = { created: 0 };
function element(kind, init) {
  stats.created++;
  const node = { kind, kids: init?.kids ? [...init.kids] : [], props: init?.props ? { ...init.props } : {}, handlers: {} };
  const proxy = new Proxy(node, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === "then") return undefined;
      return (...args) => {
        if (prop === "child") { if (args[0] != null) target.kids.push(args[0]); }
        else if (prop === "children") { for (const c of args[0] ?? []) if (c != null) target.kids.push(c); }
        else if (prop === "when") { return args[0] ? args[1](proxy) : proxy; }
        else if (prop.startsWith("on_")) target.handlers[prop] = args[args.length - 1];
        else target.props[prop] = args.length <= 1 ? args[0] : args;
        return proxy;
      };
    },
  });
  return proxy;
}
export class View {}
export const div = () => element("div"), svg = () => element("svg"), image = () => element("image");
export const v_flex = () => element("v_flex"), h_flex = () => element("h_flex");
export const Editor = { new: () => element("editor") };
export const EditorState = { new: opts => ({ opts, release() {} }) };
export const Input = { new: () => element("input") };
export const InputState = { new: () => ({ on() {}, focus() {}, value: () => "", set_value() {} }) };
export const Scrollbar = { vertical: () => element("scrollbar") };
export const TextView = {
  html: (id, html) => element("text-view", { props: { id, format: "html" }, kids: [html] }),
  markdown: (id, markdown) => element("text-view", { props: { id, format: "markdown" }, kids: [markdown] }),
};

// 트리 탐색 도우미
export function walk(node, fn) {
  if (!node || typeof node !== "object" || !node.kids) return;
  fn(node);
  for (const k of node.kids) walk(k, fn);
}
export function findAll(root, pred) { const out = []; walk(root, n => { if (pred(n)) out.push(n); }); return out; }
export const byIdPrefix = (root, prefix) => findAll(root, n => typeof n.props.id === "string" && n.props.id.startsWith(prefix));
