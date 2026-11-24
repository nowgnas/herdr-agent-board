// board-common(원본)과 각 모드 _common/ 복사본이 바이트 단위로 같은지, 모드 import가
// 모드 폴더 밖으로 나가지 않는지 검사합니다. 어긋나면 `node scripts/sync-common.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, relative, dirname, sep } from "node:path";
import { ROOT, SOURCE, COPIES } from "../scripts/sync-common.mjs";

const MODS = join(ROOT, "mods");
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;
const BUILTINS = new Set(["herdr", "gpui-kit", "gpui-base"]);

function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsFiles(p));
    else if (name.endsWith(".js")) out.push(p);
  }
  return out;
}
const specifiers = src => [...src.matchAll(IMPORT_RE)].map(m => m[1] ?? m[2] ?? m[3]);

test("모드의 _common 복사본은 board-common 원본과 바이트 단위로 같다", () => {
  for (const [mod, files] of Object.entries(COPIES)) {
    const dir = join(MODS, mod, "_common");
    assert.deepEqual(readdirSync(dir).sort(), [...files].sort(), `${mod}/_common 파일 목록`);
    for (const f of files)
      assert.ok(readFileSync(join(dir, f)).equals(readFileSync(join(SOURCE, f))),
        `${mod}/_common/${f}가 원본과 다릅니다 — node scripts/sync-common.mjs`);
  }
});

test("런타임 import는 같은 모드 폴더 안 상대경로나 내장 모듈뿐이다", () => {
  const mods = readdirSync(MODS).filter(m => m.startsWith("board") && m !== "board-common" && existsSync(join(MODS, m, "mod.json")));
  assert.ok(mods.length >= 8);
  for (const mod of mods) {
    const root = join(MODS, mod);
    for (const file of jsFiles(root)) {
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        if (BUILTINS.has(spec)) continue;
        assert.ok(spec.startsWith("./") || spec.startsWith("../"), `${relative(ROOT, file)}: 알 수 없는 모듈 ${spec}`);
        const target = resolve(dirname(file), spec);
        assert.ok(target.startsWith(root + sep), `${relative(ROOT, file)}: 모드 밖 import ${spec}`);
        assert.ok(existsSync(target), `${relative(ROOT, file)}: 없는 파일 ${spec}`);
      }
    }
  }
});

test("복사 목록은 모드가 실제 쓰는 공통 파일과 같다", () => {
  for (const [mod, files] of Object.entries(COPIES)) {
    const used = new Set();
    const root = join(MODS, mod);
    for (const file of jsFiles(root))
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        const target = resolve(dirname(file), spec);
        if (target.startsWith(join(root, "_common") + sep)) used.add(relative(join(root, "_common"), target));
      }
    assert.deepEqual([...used].sort(), [...files].sort(), `${mod}가 쓰는 _common 파일`);
  }
});
