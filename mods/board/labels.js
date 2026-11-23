import { spaces, panes } from "herdr";
// Snapshot lookups once per render instead of scanning every tab for every label.
export function labelIndex(allSpaces = spaces(), allPanes = panes()) {
  const tabs = new Map(), leads = new Map();
  for (const space of allSpaces) for (const tab of space.tabs) tabs.set(tab.id, { space, tab });
  for (const pane of allPanes) {
    const prior = leads.get(pane.tab);
    if (!prior || (!prior.terminal && pane.terminal)) leads.set(pane.tab, pane);
  }
  return id => {
    const info = tabs.get(id);
    if (!info) return "Terminal";
    const { space, tab } = info;
    if (tab.named) return tab.name;
    const lead = leads.get(id);
    return [lead?.branch, lead?.program?.name ?? "Terminal", space.tabs.length > 1 ? `#${tab.index}` : null].filter(Boolean).join(" · ");
  };
}
export function tabLabel(id) { return labelIndex()(id); }
