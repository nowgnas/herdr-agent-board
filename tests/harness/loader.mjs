// node --test에서 mods/*/main.js를 불러오기 위한 로더 훅: Herdr 런타임 모듈을 스텁으로 바꿉니다.
const STUBS = { "herdr": "herdr.mjs", "gpui-kit": "gpui.mjs", "gpui-base": "gpui.mjs" };
export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) return { url: new URL(STUBS[specifier], import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
}
