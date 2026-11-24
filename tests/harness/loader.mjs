// node --test에서 mods/*/main.js를 불러오기 위한 로더 훅: Herdr 런타임 모듈을 스텁으로 바꿉니다.
// Herdr처럼 모드 폴더(mods/<이름>/) 밖으로 나가는 import는 거부합니다.
const STUBS = { "herdr": "herdr.mjs", "gpui-kit": "gpui.mjs", "gpui-base": "gpui.mjs" };
const MODS = new URL("../../mods/", import.meta.url).href;

export function modBoundary(url) {
  if (!url?.startsWith(MODS)) return null;
  const name = url.slice(MODS.length).split("/")[0];
  return name ? `${MODS}${name}/` : null;
}

export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) return { url: new URL(STUBS[specifier], import.meta.url).href, shortCircuit: true };
  const result = await next(specifier, context);
  const boundary = modBoundary(context.parentURL);
  if (boundary && !result.url.startsWith(boundary) && !result.url.startsWith("node:"))
    throw new Error(`모드 밖 import 거부: ${specifier} (from ${context.parentURL})`);
  return result;
}
