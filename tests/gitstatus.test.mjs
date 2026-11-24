// changes/files가 공유하는 git status 헬퍼 테스트(가짜 exec·shared 주입)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, markOf, statusSignature, createGitStatus, STATUS_ARGS } from "../mods/board-changes/_common/gitstatus.js";

const Z = entries => entries.map(([xy, p]) => `${xy} ${p}`).join("\0") + "\0";

test("markOf: 기존 changes/files 판정과 같다", () => {
  assert.equal(markOf("??"), "A");
  assert.equal(markOf("A "), "A");
  assert.equal(markOf("UU"), "U");
  assert.equal(markOf(" D"), "D");
  assert.equal(markOf(" M"), "M");
});

test("parseStatus: 정렬 후 상한까지만 남기고 전체 개수는 유지", () => {
  const out = Z([[" M", "b.txt"], ["??", "a/새 파일.txt"], ["??", "c.txt"]]);
  const r = parseStatus(out, 2);
  assert.equal(r.total, 3);
  assert.deepEqual(r.entries, [["??", "a/새 파일.txt"], [" M", "b.txt"]]);
  assert.deepEqual(parseStatus("", 10), { entries: [], total: 0 });
});

test("statusSignature: 내용이 같으면 같은 서명", () => {
  const a = parseStatus(Z([[" M", "x"], ["??", "y"]]), 10);
  const b = parseStatus(Z([["??", "y"], [" M", "x"]]), 10);
  assert.equal(statusSignature("/r", a), statusSignature("/r", b));
  assert.notEqual(statusSignature("/r", a), statusSignature("/other", b));
});

// store를 넘기면 같은 shared 저장소를 다른 런타임(다른 shared 함수)에서 보는 것처럼 만듭니다.
function fakeEnv({ store = new Map(), delay = () => 5, stdout = () => Z([[" M", "a.js"], ["??", "new/b.js"]]), rootOf = () => "/repo" } = {}) {
  const calls = [], writes = [];
  let clock = 1000;
  const env = {
    calls, store, writes,
    tick(ms) { clock += ms; },
    now: () => clock,
    shared: k => store.get(k),
    setShared: (k, v) => { writes.push(k); store.set(k, v); },
    exec: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (args[0] === "rev-parse") return { code: 0, stdout: rootOf(opts.cwd) + "\n", stderr: "" };
      await new Promise(r => setTimeout(r, delay(opts.cwd)));
      return { code: 0, stdout: stdout(opts.cwd), stderr: "" };
    },
  };
  return env;
}
const statusCwds = env => env.calls.filter(c => c.args.includes("status")).map(c => c.opts.cwd);

test("동시에 두 번 요청해도 git status는 한 번만 실행", async () => {
  const env = fakeEnv();
  const git = createGitStatus(env);
  const [a, b] = await Promise.all([git.status("/repo/sub", null), git.status("/repo", null)]);
  assert.equal(a.root, "/repo");
  assert.deepEqual(a.entries, b.entries);
  assert.equal(env.calls.filter(c => c.args.includes("status")).length, 1);
  const statusCall = env.calls.find(c => c.args.includes("status"));
  assert.deepEqual(statusCall.args, STATUS_ARGS);
  assert.ok(STATUS_ARGS.includes("--untracked-files=all"));
  assert.equal(statusCall.opts.cwd, "/repo");
});

test("짧은 TTL 안에서는 캐시, 지나면 다시 실행; rev-parse도 캐시", async () => {
  const env = fakeEnv();
  const git = createGitStatus(env);
  await git.status("/repo", null);
  env.tick(1000);
  await git.status("/repo", null);
  assert.equal(env.calls.filter(c => c.args.includes("status")).length, 1);
  env.tick(10000);
  await git.status("/repo", null);
  assert.equal(env.calls.filter(c => c.args.includes("status")).length, 2);
  assert.equal(env.calls.filter(c => c.args[0] === "rev-parse").length, 1);
});

test("다른 모드 인스턴스(files)도 shared 결과를 재사용", async () => {
  const env = fakeEnv();
  const changes = createGitStatus(env), files = createGitStatus(env);
  const a = await changes.status("/repo", null);
  const b = await files.status("/repo", null);
  assert.equal(env.calls.filter(c => c.args.includes("status")).length, 1);
  assert.equal(b.sig, a.sig);
});

test("같은 결과가 반복되면 shared에 다시 쓰지 않는다(pending·rev-parse도 shared에 안 씀)", async () => {
  const env = fakeEnv();
  const git = createGitStatus(env);
  await git.status("/repo", null);
  assert.deepEqual(env.writes, ["board.git.status"]);
  for (let i = 0; i < 3; i++) { env.tick(6000); await git.status("/repo", null); }
  assert.equal(statusCwds(env).length, 4);
  assert.deepEqual(env.writes, ["board.git.status"]);
});

test("결과가 달라지면 그때만 shared 스냅샷을 바꾼다", async () => {
  let out = Z([[" M", "a.js"]]);
  const env = fakeEnv({ stdout: () => out });
  const git = createGitStatus(env);
  await git.status("/repo", null);
  out = Z([[" M", "a.js"], ["??", "b.js"]]);
  env.tick(6000);
  const snap = await git.status("/repo", null);
  assert.equal(env.writes.length, 2);
  assert.equal(env.store.get("board.git.status").sig, snap.sig);
  assert.equal(snap.total, 2);
});

test("저장소 전환: A 실행 중 → B → 다른 인스턴스 A여도 A는 한 번만(/A,/B)", async () => {
  const env = fakeEnv({ rootOf: cwd => cwd, delay: cwd => (cwd === "/A" ? 30 : 5), stdout: cwd => Z([[" M", `${cwd.slice(1)}.js`]]) });
  const changes = createGitStatus(env), files = createGitStatus(env);
  const a1 = changes.status("/A", null);
  await new Promise(r => setTimeout(r, 1));
  const b = changes.status("/B", null);
  await new Promise(r => setTimeout(r, 1));
  const a2 = files.status("/A", null);
  const [ra1, rb, ra2] = await Promise.all([a1, b, a2]);
  assert.deepEqual(statusCwds(env), ["/A", "/B"]);
  assert.equal(ra1, ra2);
  assert.equal(rb.root, "/B");
  // 늦게 끝난 A가 더 나중 요청인 B의 스냅샷을 덮지 않는다
  assert.equal(env.store.get("board.git.status").root, "/B");
  assert.equal(changes.snapshot("/A", null), null);
});

test("늦게 끝난 이전 요청은 다른 런타임이 더 나중에 쓴 스냅샷을 덮지 않는다", async () => {
  const store = new Map();
  const slow = fakeEnv({ store, rootOf: cwd => cwd, delay: () => 30, stdout: () => Z([[" M", "old.js"]]) });
  const fast = fakeEnv({ store, rootOf: cwd => cwd, delay: () => 1, stdout: () => Z([[" M", "new.js"]]) });
  const pending = createGitStatus(slow).status("/A", null);
  await new Promise(r => setTimeout(r, 1));
  fast.tick(10); // fast 쪽 시계가 더 나중
  await createGitStatus(fast).status("/A", null);
  await pending;
  assert.deepEqual(store.get("board.git.status").entries, [[" M", "new.js"]]);
  assert.deepEqual(slow.writes, []);
});

test("다른 런타임의 모드도 결과가 같으면 shared에 쓰지 않는다", async () => {
  const store = new Map();
  const changesEnv = fakeEnv({ store }), filesEnv = fakeEnv({ store });
  await createGitStatus(changesEnv).status("/repo", null);
  filesEnv.tick(6000);
  const files = await createGitStatus(filesEnv).status("/repo", null);
  assert.equal(files.sig, store.get("board.git.status").sig);
  assert.deepEqual(filesEnv.writes, []);
});

test("git 저장소가 아니면 기존 문구로 실패", async () => {
  const env = fakeEnv();
  env.exec = async () => ({ code: 128, stdout: "", stderr: "fatal" });
  const git = createGitStatus(env);
  await assert.rejects(git.status("/x", null), /git 저장소가 아닙니다/);
});
