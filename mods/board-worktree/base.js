import { tr } from "./_common/i18n.js";

// git(args) returns { ok, out, err }. Only local remote-tracking refs are read.
export async function defaultBase(git) {
  for (const name of ["origin/main", "origin/master"]) {
    const result = await git(["rev-parse", "--verify", `refs/remotes/${name}^{commit}`]);
    if (result.ok) return name;
  }
  return "";
}

export function worktreeArgs(branch, path, exists, base) {
  if (exists) return ["worktree", "add", path, branch];
  if (!base) throw new Error(tr("기준 브랜치를 입력하세요. origin/main 또는 origin/master가 없습니다.", "Enter a base branch. origin/main and origin/master were not found."));
  return ["worktree", "add", "--no-track", "-b", branch, path, base];
}
