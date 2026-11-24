// board-changes와 board-files가 같은 저장소에 git rev-parse/status를 따로
// 치지 않도록 공유하는 헬퍼. 모드마다 createGitStatus(herdr 함수들)로 만듭니다.
// - 실행 상태(진행 중 요청·마지막 확인 시각·rev-parse 결과)는 모듈 메모리에만 둡니다.
//   Herdr는 shared 상태가 바뀔 때마다 전체 갱신·저장을 하므로 pending·TTL을 shared에 쓰지 않습니다.
// - 진행 중 요청은 머신+저장소(key)별로 하나의 Promise로 합칩니다(같은 런타임의 인스턴스끼리 공유).
// - shared("board.git.status")에는 결과 서명이 달라졌을 때만, 그리고 그 요청이 여전히
//   가장 최근 요청일 때만 스냅샷을 씁니다. 다른 모드는 그 스냅샷을 받아 씁니다.
import { STATUS_LIMIT, STATUS_TTL } from "./limits.js";

export const STATUS_ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false",
  "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"];
const SNAPSHOT = "board.git.status";
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

// 같은 shared 함수(= 같은 Herdr 런타임)를 쓰는 인스턴스끼리 실행 상태를 나눕니다.
const STATES = new WeakMap();
function stateFor(shared) {
  let st = STATES.get(shared);
  if (!st) STATES.set(shared, st = { runs: new Map(), checked: new Map(), roots: new Map(), seq: 0 });
  return st;
}

export function createGitStatus({ exec, shared, setShared, now = () => Date.now() }) {
  const st = stateFor(shared);
  const locKey = (cwd, on) => `${on ?? ""}\n${cwd}`;

  async function root(cwd, on) {
    const key = locKey(cwd, on), hit = st.roots.get(key);
    if (hit && now() - hit.at < ROOT_TTL) return hit.root;
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
    if (top?.code !== 0) throw new Error("git 저장소가 아닙니다");
    const value = top.stdout.trim();
    st.roots.delete(key);
    st.roots.set(key, { root: value, at: now() });
    while (st.roots.size > ROOT_LIMIT) st.roots.delete(st.roots.keys().next().value);
    return value;
  }

  // 최신 공유 스냅샷(같은 저장소일 때만). 렌더/폴링에서 다른 모드 결과를 받아 쓸 때 사용.
  function snapshot(rootPath, on) {
    const snap = shared(SNAPSHOT);
    return snap && snap.key === locKey(rootPath, on) ? snap : null;
  }

  // 이 요청이 끝났을 때 공유 스냅샷을 써도 되는지: 이 런타임에서 더 나중에 시작한 요청이 없고,
  // 다른 모드가 그 뒤에 쓴 스냅샷도 없으며, 내용(key+서명)이 실제로 달라졌을 때만.
  function publish(snap, seq, startedAt) {
    if (seq !== st.seq) return;
    const cur = shared(SNAPSHOT);
    if (cur && cur.at > startedAt) return;
    if (cur && cur.key === snap.key && cur.sig === snap.sig) return;
    setShared(SNAPSHOT, snap);
  }

  async function run(rootPath, on, key) {
    const seq = ++st.seq, startedAt = now();
    const status = await exec("git", STATUS_ARGS, { cwd: rootPath, on }).catch(() => null);
    if (status?.code !== 0) throw new Error("git status 실패");
    const parsed = parseStatus(status.stdout, STATUS_LIMIT);
    const snap = { key, root: rootPath, on: on ?? null, at: now(), ...parsed, sig: statusSignature(rootPath, parsed) };
    const prev = st.checked.get(key);
    if (!prev || prev.startedAt <= startedAt) {
      st.checked.delete(key);
      st.checked.set(key, { snap, startedAt });
      while (st.checked.size > ROOT_LIMIT) st.checked.delete(st.checked.keys().next().value);
    }
    publish(snap, seq, startedAt);
    return snap;
  }

  async function status(cwd, on, { maxAge = STATUS_TTL } = {}) {
    const rootPath = await root(cwd, on);
    const key = locKey(rootPath, on);
    const running = st.runs.get(key);
    if (running) return running;
    const mine = st.checked.get(key)?.snap, theirs = snapshot(rootPath, on);
    const fresh = [mine, theirs].filter(s => s && now() - s.at < maxAge).sort((a, b) => b.at - a.at)[0];
    if (fresh) return fresh;
    const promise = run(rootPath, on, key).finally(() => { if (st.runs.get(key) === promise) st.runs.delete(key); });
    st.runs.set(key, promise);
    return promise;
  }

  return { root, status, snapshot };
}
