"""당월 Claude Code / Codex 세션의 스킬·Forge 사용과 추정 비용을 집계합니다.

usage.py <경로>  →  JSON(기존 형식 그대로) 출력.

실행은 프로세스 단위라 메모리 캐시가 남지 않으므로, 세션 파일별 집계만 캐시 파일
(기본 ~/.cache/herdr-agent-board/usage-v1.json, HERDR_AGENT_BOARD_CACHE 또는
XDG_CACHE_HOME로 변경)에 저장합니다. 파일의 mtime·size가 같으면 다시 파싱하지 않고,
달이 바뀌면 캐시 전체를 버립니다. 캐시에는 세션 본문·명령·경로를 평문으로 두지 않습니다:
파일 키와 cwd는 해시(cwd는 조상 경로 해시 목록)로만, 그 밖에는 비용·스킬 이름·사용 여부만.
계정 전체 비용은 경로와 무관한 파일별 집계의 합이라, 다른 경로를 열어도 다시 읽지 않습니다.
"""
import glob, hashlib, json, os, re, sys, tempfile, time
from collections import Counter
from pathlib import Path

CACHE_VERSION = 1
CACHE_NAME = f'usage-v{CACHE_VERSION}.json'
forge_command = re.compile(r'(?:^|[;&|\s`])(?:\S*/)?forge\s+(?:task|gate|verify|card|resume|risk|confirm-plan|approve|pr|vault|mcp)(?:\s|$)')
SKILL_NAME = re.compile(r'[\w:./-]{1,120}')
# usage·tool_use가 없는 Claude 줄에서 최상위 cwd 후보를 찾는 사전 필터(아래 parse_claude_file 참고)
CWD_LITERAL = re.compile(r'"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"')


# Anthropic first-party rates, $ per 1M tokens. cache_read/cache_write are
# approximated from the published ratios where an exact rate isn't known;
# this is an estimate, not a billing record (no access to the account's
# actual invoice), hence the "추정" label in the UI.
CLAUDE_PRICING = {
    'claude-fable-5-2': dict(input=8.00, output=40.00, cache_read=0.20, cache_write=10.00),
    'claude-mythos-5-2': dict(input=8.00, output=40.00, cache_read=0.20, cache_write=10.00),
    'claude-fable-5-1': dict(input=10.00, output=50.00, cache_read=1.00, cache_write=12.50),
    'claude-mythos-5-1': dict(input=10.00, output=50.00, cache_read=1.00, cache_write=12.50),
    'claude-fable-5': dict(input=10.00, output=50.00, cache_read=1.00, cache_write=12.50),
    'claude-opus-5-5': dict(input=4.00, output=20.00, cache_read=0.20, cache_write=5.00),
    'claude-opus-5': dict(input=5.00, output=25.00, cache_read=0.50, cache_write=6.25),
    'claude-opus-4-8': dict(input=5.00, output=25.00, cache_read=0.50, cache_write=6.25),
    'claude-opus-4-7': dict(input=5.00, output=25.00, cache_read=0.50, cache_write=6.25),
    'claude-opus-4-6': dict(input=5.00, output=25.00, cache_read=0.50, cache_write=6.25),
    'claude-sonnet-5-5': dict(input=2.00, output=10.00, cache_read=0.10, cache_write=2.50),
    'claude-sonnet-5': dict(input=2.00, output=10.00, cache_read=0.20, cache_write=2.50),
    'claude-sonnet-4-6': dict(input=3.00, output=15.00, cache_read=0.30, cache_write=3.75),
    'claude-haiku-5-5': dict(input=0.10, output=0.50, cache_read=0.01, cache_write=0.125),
    'claude-haiku-4-5': dict(input=1.00, output=5.00, cache_read=0.10, cache_write=1.25),
}
DEFAULT_CLAUDE_PRICING = CLAUDE_PRICING['claude-sonnet-5-5']


def claude_cost(usage, model):
    if not isinstance(usage, dict):
        return 0.0
    p = CLAUDE_PRICING.get(model, DEFAULT_CLAUDE_PRICING)
    input_tok = usage.get('input_tokens') or 0
    output_tok = usage.get('output_tokens') or 0
    cache_read = usage.get('cache_read_input_tokens') or 0
    cache_write = usage.get('cache_creation_input_tokens') or 0
    return (input_tok * p['input'] + output_tok * p['output']
            + cache_read * p['cache_read'] + cache_write * p['cache_write']) / 1_000_000


# Codex's own model lineup and OpenAI's published rates for it aren't in this
# skill's reference material, so every Codex model uses one flat estimated
# rate (roughly the published gpt-5-codex tier) rather than a per-model table
# that would silently drift out of date; the UI marks this clearly as a rough
# estimate.
CODEX_PRICING = dict(input=1.25, cached=0.125, output=10.00)


def codex_cost(usage):
    if not isinstance(usage, dict):
        return 0.0
    input_tok = usage.get('input_tokens') or 0
    cached = usage.get('cached_input_tokens') or 0
    output_tok = usage.get('output_tokens') or 0
    uncached = max(0, input_tok - cached)
    return (uncached * CODEX_PRICING['input'] + cached * CODEX_PRICING['cached']
            + output_tok * CODEX_PRICING['output']) / 1_000_000


# Codex has no dedicated "Skill" tool call: it reads a skill's SKILL.md (and
# runs forge) through its generic shell-exec tool, so we grep that tool's
# raw command text instead of matching a structured field.
SKILL_PATH = re.compile(r'[Ss][Kk][Ii][Ll][Ll][Ss]/([\w.\-]+)/SKILL\.md')




def digest(text):
    return hashlib.sha256(text.encode('utf-8', 'surrogatepass')).hexdigest()[:20]


def ancestor_hashes(path):
    """realpath의 자신과 모든 조상 경로 해시. root가 이 목록에 있으면 commonpath([root, path]) == root."""
    out = []
    while True:
        out.append(digest(path))
        parent = os.path.dirname(path)
        if parent == path:
            return out
        path = parent


class Realpaths:
    """한 번의 실행 안에서 같은 cwd 문자열의 realpath를 다시 계산하지 않습니다."""
    def __init__(self):
        self.memo = {}

    def __call__(self, cwd):
        hit = self.memo.get(cwd)
        if hit is None:
            hit = self.memo[cwd] = os.path.realpath(cwd)
        return hit


def parse_claude_file(filename, realpath=None):
    realpath = realpath or Realpaths()
    cwds = set()        # 이 파일에 나온 최상위 cwd의 realpath
    seen_raw = set()    # 이미 처리한 최상위 cwd의 JSON 문자열 표현
    seen = set()
    used_skill = used_forge = False
    skill_names = []
    cost = 0.0
    with open(filename, encoding='utf-8') as stream:
        for line in stream:
            # 사전 필터: usage·tool_use가 없는 줄은 최상위 cwd만 기여합니다. 줄의 모든
            # "cwd": "..." 후보가 이미 처리한 값이면 그 줄은 새로 더할 것이 없으니 건너뜁니다.
            if '"usage"' not in line and '"tool_use"' not in line:
                if '"cwd"' not in line:
                    continue
                raws = CWD_LITERAL.findall(line)
                if raws and all(raw in seen_raw for raw in raws):
                    continue
            try: event = json.loads(line)
            except (ValueError, UnicodeError): continue
            cwd = event.get('cwd')
            if isinstance(cwd, str):
                seen_raw.add(json.dumps(cwd, ensure_ascii=False)[1:-1])
                cwds.add(realpath(cwd))
            message = event.get('message') or {}
            if not isinstance(message, dict): continue
            usage, model = message.get('usage'), message.get('model')
            if isinstance(usage, dict) and isinstance(model, str):
                cost += claude_cost(usage, model)
            content = message.get('content')
            if not isinstance(content, list): continue
            for item in content:
                if not isinstance(item, dict) or item.get('type') != 'tool_use': continue
                ident = item.get('id')
                if ident and ident in seen: continue
                if ident: seen.add(ident)
                name, args = item.get('name', ''), item.get('input') or {}
                if name == 'Skill' and isinstance(args, dict):
                    skill = args.get('skill')
                    if isinstance(skill, str) and SKILL_NAME.fullmatch(skill):
                        used_skill = True; skill_names.append(skill)
                if name.startswith('mcp__forge__') or (name == 'Bash' and isinstance(args, dict) and forge_command.search(str(args.get('command', '')))):
                    used_forge = True
    places = sorted({h for path in cwds for h in ancestor_hashes(path)})
    return {'cost': cost, 'skill': used_skill, 'forge': used_forge, 'skills': skill_names, 'places': places}


def parse_codex_file(filename, realpath=None):
    realpath = realpath or Realpaths()
    place = None  # 마지막 session_meta의 cwd(기존 구현과 같이 마지막 값이 프로젝트 판정)
    used_skill = used_forge = False
    skill_names = []
    cost = 0.0
    with open(filename, encoding='utf-8') as stream:
        for line in stream:
            if '"session_meta"' in line:
                try:
                    event = json.loads(line)
                    cwd = (event.get('payload') or {}).get('cwd')
                    if isinstance(cwd, str):
                        place = realpath(cwd)
                except (ValueError, UnicodeError): pass
                continue
            if '"token_usage_record"' in line:
                try: event = json.loads(line)
                except (ValueError, UnicodeError): continue
                payload = event.get('payload') or {}
                usage = payload.get('usage')
                if isinstance(usage, dict): cost += codex_cost(usage)
                continue
            if '"custom_tool_call"' not in line: continue
            try: event = json.loads(line)
            except (ValueError, UnicodeError): continue
            payload = event.get('payload') or {}
            if payload.get('type') != 'custom_tool_call' or payload.get('name') != 'exec': continue
            text = payload.get('input')
            if not isinstance(text, str): continue
            names = SKILL_PATH.findall(text)
            if names: used_skill = True; skill_names.extend(names)
            if forge_command.search(text): used_forge = True
    places = ancestor_hashes(place) if place else []
    return {'cost': cost, 'skill': used_skill, 'forge': used_forge, 'skills': skill_names, 'places': places}


def cache_dir_default(home):
    explicit = os.environ.get('HERDR_AGENT_BOARD_CACHE')
    if explicit:
        return Path(explicit)
    base = os.environ.get('XDG_CACHE_HOME')
    return (Path(base) if base else Path(home) / '.cache') / 'herdr-agent-board'


def load_cache(path, month):
    try:
        with open(path, encoding='utf-8') as stream:
            data = json.load(stream)
        if data.get('version') == CACHE_VERSION and data.get('month') == month and isinstance(data.get('files'), dict):
            return data['files']
    except (OSError, ValueError, AttributeError):
        pass
    return {}


def save_cache(path, month, files):
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, tmp = tempfile.mkstemp(prefix='.usage-', suffix='.tmp', dir=path.parent)
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump({'version': CACHE_VERSION, 'month': month, 'files': files}, stream, ensure_ascii=False, separators=(',', ':'))
        os.replace(tmp, path)  # 동시에 실행돼도 반쯤 쓴 파일이 보이지 않게
    except OSError:
        pass


def scan(kind, pattern, parser, cutoff, cache, fresh, stats, realpath):
    """이번 달 파일들의 (캐시 키, 파일별 집계)를 glob 순서대로. 실패한 파일 수도 함께."""
    records, errors = [], 0
    for filename in glob.iglob(pattern, recursive=True):
        try:
            st = os.stat(filename)
            if st.st_mtime < cutoff: continue
            key = kind + ':' + digest(filename)
            hit = cache.get(key)
            if hit and hit.get('mtime') == st.st_mtime_ns and hit.get('size') == st.st_size:
                stats['reused'] += 1
            else:
                hit = dict(parser(filename, realpath), mtime=st.st_mtime_ns, size=st.st_size)
                stats['parsed'] += 1
            fresh[key] = hit
            records.append(hit)
        except (OSError, UnicodeError): errors += 1
    return records, errors


def summarize(records, errors, root_hash):
    sessions = skills = forge = 0
    counts = Counter()
    total_cost = account_cost = 0.0
    for r in records:
        account_cost += r['cost']
        if root_hash in r['places']:
            sessions += 1
            skills += r['skill']
            forge += r['forge']
            counts.update(r['skills'])
            total_cost += r['cost']
    return {'sessions': sessions, 'skill_sessions': skills, 'forge_sessions': forge, 'top': counts.most_common(3), 'errors': errors,
            'cost_usd': round(total_cost, 2), 'account_cost_usd': round(account_cost, 2)}


def collect(root, home=None, cache_dir=None, now=None):
    home = Path(home) if home is not None else Path.home()
    now = time.time() if now is None else now
    t = time.localtime(now)
    cutoff = time.mktime((t.tm_year, t.tm_mon, 1, 0, 0, 0, 0, 0, -1))
    month = f'{t.tm_year:04d}-{t.tm_mon:02d}'
    cache_path = Path(cache_dir if cache_dir is not None else cache_dir_default(home)) / CACHE_NAME
    cache = load_cache(cache_path, month)
    fresh, stats, realpath = {}, {'parsed': 0, 'reused': 0}, Realpaths()
    claude_records, claude_errors = scan('claude', str(home / '.claude' / 'projects' / '*' / '*.jsonl'), parse_claude_file, cutoff, cache, fresh, stats, realpath)
    codex_records, codex_errors = scan('codex', str(home / '.codex' / 'sessions' / '**' / '*.jsonl'), parse_codex_file, cutoff, cache, fresh, stats, realpath)
    if stats['parsed'] or set(fresh) != set(cache):
        save_cache(cache_path, month, fresh)
    root_hash = digest(os.path.realpath(root))
    result = summarize(claude_records, claude_errors, root_hash)
    result['codex'] = summarize(codex_records, codex_errors, root_hash)
    result['_cache'] = stats
    return result


if __name__ == '__main__':
    print(json.dumps(collect(sys.argv[1]), ensure_ascii=False))
