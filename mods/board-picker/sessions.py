"""⌘P 피커의 Codex / Claude 세션 목록. 최근 세션부터 --limit개(기본 200)만 돌려줍니다.

sessions.py [--limit N]  →  {"sessions": [...], "errors": [...], "more": bool, "limit": N}
Claude 세션은 파일 mtime 최신순으로 정렬한 뒤 상한만큼만 엽니다.
"""
import glob, json, os, sqlite3, sys
from pathlib import Path

DEFAULT_LIMIT = 200  # board-common/limits.js의 PICKER_SESSION_LIMIT과 같게(main.js가 --limit으로 넘김)


def read_claude(filename):
    sid = Path(filename).stem
    cwd = title = None
    with open(filename, encoding='utf-8') as stream:
        for i, line in enumerate(stream):
            if i >= 500: break
            try: item = json.loads(line)
            except (ValueError, UnicodeError): continue
            if item.get('sessionId') not in (None, sid): continue
            cwd = item.get('cwd') or cwd
            title = item.get('customTitle') or title
            if not title and item.get('type') == 'user':
                message = item.get('message') or {}
                content = message.get('content') if isinstance(message, dict) else None
                if isinstance(content, str) and content.strip(): title = content.strip()[:160]
            if cwd and title: break
    return sid, cwd, title


def codex_sessions(home, limit, errors):
    rows, more = [], False
    try:
        db = sqlite3.connect(f'file:{home}/.codex/state_5.sqlite?mode=ro', uri=True, timeout=3)
        query = ("SELECT id, cwd, COALESCE(NULLIF(name,''), NULLIF(title,''), id), updated_at FROM threads "
                 "WHERE cwd <> '' AND agent_role IS NULL ORDER BY updated_at DESC LIMIT ?")
        for sid, cwd, title, stamp in db.execute(query, (limit + 1,)):
            rows.append({'kind':'Codex','id':sid,'cwd':cwd,'title':title,'updated':stamp or 0,'available':os.path.isdir(cwd)})
        db.close()
    except (OSError, sqlite3.Error) as exc:
        errors.append('Codex: ' + str(exc))
    if len(rows) > limit:
        rows, more = rows[:limit], True
    return rows, more


def claude_sessions(home, limit, errors):
    rows = []
    try:
        files = []
        for filename in glob.iglob(str(Path(home) / '.claude' / 'projects' / '*' / '*.jsonl')):
            try: files.append((os.path.getmtime(filename), filename))
            except OSError: continue
        files.sort(key=lambda x: x[0], reverse=True)
        for index, (mtime, filename) in enumerate(files):
            if len(rows) >= limit:
                return rows, True
            try:
                sid, cwd, title = read_claude(filename)
                if cwd:
                    rows.append({'kind':'Claude','id':sid,'cwd':cwd,'title':title or sid,'updated':mtime,'available':os.path.isdir(cwd)})
            except (OSError, UnicodeError): continue
    except OSError as exc:
        errors.append('Claude: ' + str(exc))
    return rows, False


def collect(home, limit=DEFAULT_LIMIT):
    errors = []
    codex, codex_more = codex_sessions(home, limit, errors)
    claude, claude_more = claude_sessions(home, limit, errors)
    rows = codex + claude
    rows.sort(key=lambda x: x['updated'], reverse=True)
    more = codex_more or claude_more or len(rows) > limit
    return {'sessions': rows[:limit], 'errors': errors, 'more': more, 'limit': limit}


def parse_limit(argv):
    if '--limit' in argv:
        try: return max(1, int(argv[argv.index('--limit') + 1]))
        except (IndexError, ValueError): pass
    return DEFAULT_LIMIT


if __name__ == '__main__':
    print(json.dumps(collect(Path.home(), parse_limit(sys.argv[1:])), ensure_ascii=False))
