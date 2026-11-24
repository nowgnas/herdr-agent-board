// changes/files가 공유하는 git status 헬퍼 테스트(가짜 exec·shared 주입)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStatus, markOf, statusSignature, createGitStatus, STATUS_ARGS } from "../mods/board-common/gitstatus.js";

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

function fakeEnv() {
  const store = new Map();
  const calls = [];
  let clock = 1000;
  const env = {
    calls, store,
    tick(ms) { clock += ms; },
    now: () => clock,
    shared: k => store.get(k),
    setShared: (k, v) => store.set(k, v),
    exec: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      await new Promise(r => setTimeout(r, 5));
      if (args[0] === "rev-parse") return { code: 0, stdout: "/repo\n", stderr: "" };
      return { code: 0, stdout: Z([[" M", "a.js"], ["??", "new/b.js"]]), stderr: "" };
    },
  };
  return env;
}

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

test("다른 인스턴스가 실행 중이면 중복 실행하지 않고 busy를 돌려준다", async () => {
  const env = fakeEnv();
  const changes = createGitStatus(env), files = createGitStatus(env);
  const running = changes.status("/repo", null);
  await new Promise(r => setTimeout(r, 1)); // changes가 rev-parse를 끝내고 status 실행 중
  await new Promise(r => setTimeout(r, 6));
  const other = await files.status("/repo", null);
  assert.equal(other.busy, true);
  await running;
  assert.equal(env.calls.filter(c => c.args.includes("status")).length, 1);
});

test("git 저장소가 아니면 기존 문구로 실패", async () => {
  const env = fakeEnv();
  env.exec = async () => ({ code: 128, stdout: "", stderr: "fatal" });
  const git = createGitStatus(env);
  await assert.rejects(git.status("/x", null), /git 저장소가 아닙니다/);
});
