// board-changes와 board-files가 같은 저장소에 git rev-parse/status를 따로
// 치지 않도록 공유하는 헬퍼. 모드마다 createGitStatus(herdr 함수들)로 만들고,
// 결과는 herdr shared 상태("board.git.status")에 짧게 캐시해 다른 모드도 재사용합니다.
// - 같은 인스턴스 안의 동시 요청은 하나의 Promise로 합칩니다.
// - 다른 모드가 실행 중이면(pending 표시) 중복 실행하지 않고 { busy: true }를 돌려줍니다.
import { STATUS_LIMIT, STATUS_TTL, STATUS_PENDING_TTL } from "./limits.js";

export const STATUS_ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false",
  "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"];
const SNAPSHOT = "board.git.status", PENDING = "board.git.status.pending", ROOTS = "board.git.roots";
const ROOT_TTL = 30000, ROOT_LIMIT = 32;

export function markOf(xy) {
  return xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
}

// porcelain v1 -z 출력 → 경로순 정렬된 [xy, path] 중 limit개와 전체 개수.
export function parseStatus(stdout, limit = STATUS_LIMIT) {
  const all = [];
  for (const entry of (stdout ?? "").split("\0")) if (entry) all.push([entry.slice(0, 2), entry.slice(3)]);
  all.sort((a, b) => a[1].localeCompare(b[1]));
  return { entries: all.length > limit ? all.slice(0, limit) : all, total: all.length };
}

export function statusSignature(root, { entries, total }) {
  let sig = `${root}\n${total}\n`;
  for (const [xy, path] of entries) sig += `${xy}${path}\0`;
  return sig;
}

export function createGitStatus({ exec, shared, setShared, now = () => Date.now() }) {
  const inflight = new Map();
  const locKey = (cwd, on) => `${on ?? ""}\n${cwd}`;

  async function root(cwd, on) {
    const key = locKey(cwd, on), roots = shared(ROOTS) ?? {}, hit = roots[key];
    if (hit && now() - hit.at < ROOT_TTL) return hit.root;
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
    if (top?.code !== 0) throw new Error("git 저장소가 아닙니다");
    const value = top.stdout.trim();
    const next = Object.fromEntries(Object.entries(shared(ROOTS) ?? {}).filter(([, v]) => now() - v.at < ROOT_TTL).slice(-(ROOT_LIMIT - 1)));
    next[key] = { root: value, at: now() };
    setShared(ROOTS, next);
    return value;
  }

  // 최신 공유 스냅샷(같은 저장소일 때만). 렌더/폴링에서 다른 모드 결과를 받아 쓸 때 사용.
  function snapshot(rootPath, on) {
    const snap = shared(SNAPSHOT);
    return snap && snap.key === locKey(rootPath, on) ? snap : null;
  }

  async function run(rootPath, on) {
    const key = locKey(rootPath, on);
    setShared(PENDING, { key, at: now() });
    try {
      const status = await exec("git", STATUS_ARGS, { cwd: rootPath, on }).catch(() => null);
      if (status?.code !== 0) throw new Error("git status 실패");
      const parsed = parseStatus(status.stdout, STATUS_LIMIT);
      const snap = { key, root: rootPath, on: on ?? null, at: now(), ...parsed, sig: statusSignature(rootPath, parsed) };
      setShared(SNAPSHOT, snap);
      return snap;
    } finally {
      if (shared(PENDING)?.key === key) setShared(PENDING, null);
    }
  }

  async function status(cwd, on, { maxAge = STATUS_TTL } = {}) {
    const rootPath = await root(cwd, on);
    const key = locKey(rootPath, on);
    if (inflight.has(key)) return inflight.get(key);
    const snap = snapshot(rootPath, on);
    if (snap && now() - snap.at < maxAge) return snap;
    const pending = shared(PENDING);
    if (pending?.key === key && now() - pending.at < STATUS_PENDING_TTL) return { busy: true, root: rootPath, key };
    const promise = run(rootPath, on).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  return { root, status, snapshot };
}
