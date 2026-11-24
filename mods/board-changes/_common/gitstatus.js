// board-changes와 board-files가 같은 저장소에 git rev-parse/status를 따로
// 치지 않도록 공유하는 헬퍼. 모드마다 createGitStatus(herdr 함수들)로 만듭니다.
// - 실행 상태(진행 중 요청·마지막 확인 시각·rev-parse 결과·요청 순번)는 JS 메모리에만 둡니다.
//   Herdr는 shared 상태가 바뀔 때마다 전체 갱신·저장을 하므로 pending·TTL을 shared에 쓰지 않습니다.
// - 이 파일은 모드마다 _common/에 복사되어 모듈 인스턴스가 따로 생기므로, 실행 상태는
//   globalThis의 WeakMap(shared 함수 = 같은 Herdr 런타임을 키로)에 두어 복사본끼리 나눕니다.
// - 진행 중 요청은 머신+저장소(key)별로 하나의 Promise로 합칩니다.
// - 요청 순번은 status() 진입 즉시(어떤 await보다 먼저) 매깁니다. shared("board.git.status")에는
//   그 요청보다 나중 순번의 요청이 아직 진행 중이거나 이미 끝나지 않았고, 결과 서명이 달라졌을 때만
//   스냅샷을 씁니다. 다른 런타임이 쓴 스냅샷은 순번을 모르므로 요청 시작 시각(started)으로 비교합니다.
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

// 같은 shared 함수(= 같은 Herdr 런타임)를 쓰는 인스턴스끼리, 모드별 복사본을 넘어 실행 상태를 나눕니다.
const STATES_KEY = Symbol.for("herdr-agent-board.gitstatus.states");
const STATES = globalThis[STATES_KEY] ??= new WeakMap();
function stateFor(shared) {
  let st = STATES.get(shared);
  // seq: 마지막으로 매긴 순번, live: 아직 끝나지 않은 요청 순번, done: 실행을 마친 가장 큰 순번
  if (!st) STATES.set(shared, st = { runs: new Map(), checked: new Map(), roots: new Map(), seq: 0, live: new Set(), done: 0 });
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

  // 이 요청 뒤에 매긴 순번이 아직 진행 중이거나 이미 실행을 마쳤으면 옛 결과이므로 쓰지 않습니다.
  function superseded(seq) {
    if (st.done > seq) return true;
    for (const s of st.live) if (s > seq) return true;
    return false;
  }

  function publish(snap, seq) {
    if (superseded(seq)) return;
    const cur = shared(SNAPSHOT);
    if (cur && cur.started > snap.started) return; // 다른 런타임에서 더 나중에 시작한 요청의 결과
    if (cur && cur.key === snap.key && cur.sig === snap.sig) return;
    setShared(SNAPSHOT, snap);
  }

  // 앞 요청이 끝날 때 이 요청이 live에 있어 게시가 막혔을 수 있으므로, 실행 없이 끝나는 요청
  // (캐시 히트·진행 중 합류)은 자신을 live에서 뺀 뒤 그 저장소의 마지막 결과를 원래 순번으로 다시 게시해 봅니다.
  function catchUp(key) {
    const last = st.checked.get(key);
    if (last) publish(last.snap, last.seq);
  }

  async function run(rootPath, on, key, seq, started) {
    const status = await exec("git", STATUS_ARGS, { cwd: rootPath, on }).catch(() => null);
    if (status?.code !== 0) throw new Error("git status 실패");
    const parsed = parseStatus(status.stdout, STATUS_LIMIT);
    const snap = { key, root: rootPath, on: on ?? null, at: now(), started, ...parsed, sig: statusSignature(rootPath, parsed) };
    const prev = st.checked.get(key);
    if (!prev || prev.seq <= seq) {
      st.checked.delete(key);
      st.checked.set(key, { snap, seq });
      while (st.checked.size > ROOT_LIMIT) st.checked.delete(st.checked.keys().next().value);
    }
    publish(snap, seq);
    if (seq > st.done) st.done = seq;
    return snap;
  }

  async function status(cwd, on, { maxAge = STATUS_TTL } = {}) {
    // 순번·시작 시각은 어떤 await보다 먼저: 느린 rev-parse가 요청 순서를 뒤집지 않도록.
    const seq = ++st.seq, started = now();
    st.live.add(seq);
    let rootPath;
    try { rootPath = await root(cwd, on); } catch (e) { st.live.delete(seq); throw e; }
    const key = locKey(rootPath, on);
    const running = st.runs.get(key);
    if (running) {
      st.live.delete(seq);
      return running.then(snap => { catchUp(key); return snap; });
    }
    const mine = st.checked.get(key)?.snap, theirs = snapshot(rootPath, on);
    const fresh = [mine, theirs].filter(s => s && now() - s.at < maxAge).sort((a, b) => b.at - a.at)[0];
    if (fresh) { st.live.delete(seq); catchUp(key); return fresh; }
    const promise = run(rootPath, on, key, seq, started).finally(() => {
      st.live.delete(seq);
      if (st.runs.get(key) === promise) st.runs.delete(key);
    });
    st.runs.set(key, promise);
    return promise;
  }

  return { root, status, snapshot };
}
