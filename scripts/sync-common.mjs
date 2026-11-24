// mods/board-common/은 공통 코드의 단일 원본입니다. Herdr는 각 모드 폴더를 루트로 로드하고
// 그 폴더 밖(../board-common) import를 거부하므로, 필요한 파일을 각 모드의 _common/에 복사합니다.
// 원본을 고친 뒤 `node scripts/sync-common.mjs`를 돌리세요. tests/common-copies.test.mjs가 어긋남을 잡습니다.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SOURCE = join(ROOT, "mods", "board-common");
// 모드 → 그 모드가 쓰는 공통 파일(원본 안의 상대 import까지 포함)
export const COPIES = {
  "board": ["limits.js", "virtual.js"],
  "board-changes": ["gitstatus.js", "limits.js", "panel.js", "virtual.js"],
  "board-files": ["gitstatus.js", "limits.js", "panel.js"],
  "board-picker": ["limits.js"],
  "board-preview": ["limits.js", "virtual.js"],
  "board-timeline": ["panel.js"],
  "board-todo": ["panel.js"],
  "board-usage": ["panel.js"],
};

export function sync() {
  for (const [mod, files] of Object.entries(COPIES)) {
    const dir = join(ROOT, "mods", mod, "_common");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), readFileSync(join(SOURCE, f)));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  sync();
  console.log(`synced ${Object.keys(COPIES).length} mods from ${readdirSync(SOURCE).join(", ")}`);
}
