# 상한 도입 전 sessions.py(main a9b6008) 사본. 새 구현과 결과를 비교하는 기준으로만 씁니다.
import glob, json, os, sqlite3
from pathlib import Path

home = Path.home()
rows = []
errors = []
try:
    db = sqlite3.connect(f'file:{home}/.codex/state_5.sqlite?mode=ro', uri=True, timeout=3)
    for sid, cwd, title, stamp in db.execute("SELECT id, cwd, COALESCE(NULLIF(name,''), NULLIF(title,''), id), updated_at FROM threads WHERE cwd <> '' AND agent_role IS NULL"):
        rows.append({'kind':'Codex','id':sid,'cwd':cwd,'title':title,'updated':stamp or 0,'available':os.path.isdir(cwd)})
    db.close()
except (OSError, sqlite3.Error) as exc:
    errors.append('Codex: ' + str(exc))
try:
    for filename in glob.iglob(str(home / '.claude' / 'projects' / '*' / '*.jsonl')):
        sid = Path(filename).stem
        cwd = title = None
        try:
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
            if cwd:
                rows.append({'kind':'Claude','id':sid,'cwd':cwd,'title':title or sid,'updated':os.path.getmtime(filename),'available':os.path.isdir(cwd)})
        except (OSError, UnicodeError): continue
except OSError as exc:
    errors.append('Claude: ' + str(exc))
rows.sort(key=lambda x: x['updated'], reverse=True)
print(json.dumps({'sessions':rows,'errors':errors}, ensure_ascii=False))
