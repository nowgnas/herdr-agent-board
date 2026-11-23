import glob, json, os, re, sys, time
from collections import Counter
from pathlib import Path

root = os.path.realpath(sys.argv[1])
_now = time.localtime()
cutoff = time.mktime((_now.tm_year, _now.tm_mon, 1, 0, 0, 0, 0, 0, -1))
forge_command = re.compile(r'(?:^|[;&|\s`])(?:\S*/)?forge\s+(?:task|gate|verify|card|resume|risk|confirm-plan|approve|pr|vault|mcp)(?:\s|$)')

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


def claude_usage():
    sessions = skills = forge = 0
    counts = Counter()
    errors = 0
    total_cost = 0.0
    account_cost = 0.0  # every session in the window, regardless of project
    for filename in glob.iglob(str(Path.home() / '.claude' / 'projects' / '*' / '*.jsonl')):
        try:
            if os.path.getmtime(filename) < cutoff: continue
            found = used_skill = used_forge = False
            seen = set()
            skill_names = []
            file_cost = 0.0
            with open(filename, encoding='utf-8') as stream:
                for line in stream:
                    try: event = json.loads(line)
                    except (ValueError, UnicodeError): continue
                    cwd = event.get('cwd')
                    if isinstance(cwd, str):
                        try: found |= os.path.commonpath([root, os.path.realpath(cwd)]) == root
                        except ValueError: pass
                    message = event.get('message') or {}
                    if not isinstance(message, dict): continue
                    usage, model = message.get('usage'), message.get('model')
                    if isinstance(usage, dict) and isinstance(model, str):
                        file_cost += claude_cost(usage, model)
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
                            if isinstance(skill, str) and re.fullmatch(r'[\w:./-]{1,120}', skill):
                                used_skill = True; skill_names.append(skill)
                        if name.startswith('mcp__forge__') or (name == 'Bash' and isinstance(args, dict) and forge_command.search(str(args.get('command', '')))):
                            used_forge = True
            account_cost += file_cost
            if found:
                sessions += 1
                skills += used_skill
                forge += used_forge
                counts.update(skill_names)
                total_cost += file_cost
        except (OSError, UnicodeError): errors += 1
    return {'sessions': sessions, 'skill_sessions': skills, 'forge_sessions': forge, 'top': counts.most_common(3), 'errors': errors,
            'cost_usd': round(total_cost, 2), 'account_cost_usd': round(account_cost, 2)}


# Codex has no dedicated "Skill" tool call: it reads a skill's SKILL.md (and
# runs forge) through its generic shell-exec tool, so we grep that tool's
# raw command text instead of matching a structured field.
SKILL_PATH = re.compile(r'[Ss][Kk][Ii][Ll][Ll][Ss]/([\w.\-]+)/SKILL\.md')


def codex_usage():
    sessions = skills = forge = 0
    counts = Counter()
    errors = 0
    total_cost = 0.0
    account_cost = 0.0  # every session in the window, regardless of project
    for filename in glob.iglob(str(Path.home() / '.codex' / 'sessions' / '**' / '*.jsonl'), recursive=True):
        try:
            if os.path.getmtime(filename) < cutoff: continue
            found = used_skill = used_forge = False
            skill_names = []
            file_cost = 0.0
            with open(filename, encoding='utf-8') as stream:
                for line in stream:
                    if '"session_meta"' in line:
                        try:
                            event = json.loads(line)
                            cwd = (event.get('payload') or {}).get('cwd')
                            if isinstance(cwd, str):
                                try: found = os.path.commonpath([root, os.path.realpath(cwd)]) == root
                                except ValueError: found = False
                        except (ValueError, UnicodeError): pass
                        continue
                    if '"token_usage_record"' in line:
                        try: event = json.loads(line)
                        except (ValueError, UnicodeError): continue
                        payload = event.get('payload') or {}
                        usage = payload.get('usage')
                        if isinstance(usage, dict): file_cost += codex_cost(usage)
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
            account_cost += file_cost
            if found:
                sessions += 1
                skills += used_skill
                forge += used_forge
                counts.update(skill_names)
                total_cost += file_cost
        except (OSError, UnicodeError): errors += 1
    return {'sessions': sessions, 'skill_sessions': skills, 'forge_sessions': forge, 'top': counts.most_common(3), 'errors': errors,
            'cost_usd': round(total_cost, 2), 'account_cost_usd': round(account_cost, 2)}


claude = claude_usage()
claude['codex'] = codex_usage()
print(json.dumps(claude, ensure_ascii=False))
