"""board-usage/usage.py 캐시·증분 집계 테스트.

실제 사용자 기록은 읽지 않습니다. 임시 HOME에 합성 Claude/Codex JSONL을 만들고,
캐시 디렉터리도 임시 경로(HERDR_AGENT_BOARD_CACHE)로 지정합니다.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / 'mods' / 'board-usage' / 'usage.py'
LEGACY = REPO / 'tests' / 'fixtures' / 'usage_legacy.py'


def load_usage():
    spec = importlib.util.spec_from_file_location('board_usage', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def jl(*events):
    return ''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in events)


def month_start(ts):
    t = time.localtime(ts)
    return time.mktime((t.tm_year, t.tm_mon, 1, 0, 0, 0, 0, 0, -1))


def next_month(ts, day=3):
    t = time.localtime(ts)
    y, m = (t.tm_year + 1, 1) if t.tm_mon == 12 else (t.tm_year, t.tm_mon + 1)
    return time.mktime((y, m, day, 12, 0, 0, 0, 0, -1))


class Fixture:
    def __init__(self, base):
        self.base = Path(base)
        self.home = self.base / 'home'
        self.cache = self.base / 'cache'
        self.proj = self.base / 'work' / 'proj'
        self.sub = self.proj / 'sub'
        self.other = self.base / 'work' / 'other'
        for d in (self.sub, self.other):
            d.mkdir(parents=True)
        self.claude = self.home / '.claude' / 'projects'
        self.codex = self.home / '.codex' / 'sessions' / '2026' / '11'
        self.files = {}

    def write(self, rel, text, mtime=None):
        path = self.home / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        self.files[rel] = path
        return path

    def populate(self, mtime=None):
        proj, sub, other = str(self.proj), str(self.sub), str(self.other)
        usage = {'input_tokens': 100000, 'output_tokens': 200000, 'cache_read_input_tokens': 30000, 'cache_creation_input_tokens': 4000}
        # 프로젝트 세션: 스킬 2회(중복 id 1회), forge Bash, mcp forge, 단가표 모델
        self.write('.claude/projects/p1/a.jsonl', jl(
            {'type': 'user', 'cwd': sub, 'message': {'role': 'user', 'content': '안녕 "cwd": "/fake"'}},
            {'type': 'assistant', 'cwd': sub, 'message': {'model': 'claude-opus-5-5', 'usage': usage, 'content': [
                {'type': 'tool_use', 'id': 't1', 'name': 'Skill', 'input': {'skill': 'review:pr'}},
                {'type': 'tool_use', 'id': 't1', 'name': 'Skill', 'input': {'skill': 'review:pr'}},
                {'type': 'tool_use', 'id': 't2', 'name': 'Bash', 'input': {'command': 'forge task list', 'cwd': other}},
            ]}},
            {'type': 'assistant', 'cwd': sub, 'message': {'model': 'claude-unknown', 'usage': usage, 'content': [
                {'type': 'tool_use', 'id': 't3', 'name': 'mcp__forge__card', 'input': {}},
                {'type': 'tool_use', 'id': 't4', 'name': 'Skill', 'input': {'skill': 'deploy'}},
            ]}},
            {'type': 'system', 'cwd': sub},
        ) + 'not json\n', mtime)
        # 다른 경로에서 시작해 중간에 프로젝트로 이동(usage·tool_use 없는 줄의 cwd도 반영돼야 함)
        self.write('.claude/projects/p2/b.jsonl', jl(
            {'type': 'user', 'cwd': other, 'message': {'content': 'x'}},
            {'type': 'assistant', 'cwd': other, 'message': {'model': 'claude-sonnet-5-5', 'usage': usage, 'content': []}},
            {'type': 'user', 'cwd': proj},
        ), mtime)
        # 프로젝트 밖 세션
        self.write('.claude/projects/p3/c.jsonl', jl(
            {'type': 'assistant', 'cwd': other, 'message': {'model': 'claude-haiku-5-5', 'usage': usage, 'content': [
                {'type': 'tool_use', 'id': 'x', 'name': 'Skill', 'input': {'skill': 'other-skill'}}]}},
            # usage·tool_use 없는 줄의 중첩 cwd는 프로젝트 판정에 쓰이면 안 됨(사전 필터 검증)
            {'type': 'progress', 'cwd': other, 'data': {'cwd': proj}},
            {'type': 'progress', 'data': {'cwd': proj}},
        ), mtime)
        # Codex: 프로젝트 세션과 밖 세션
        cu = {'input_tokens': 5000, 'cached_input_tokens': 1000, 'output_tokens': 700}
        self.write('.codex/sessions/2026/11/s1.jsonl', jl(
            {'type': 'session_meta', 'payload': {'cwd': proj}},
            {'type': 'token_usage_record', 'payload': {'usage': cu}},
            {'type': 'response_item', 'payload': {'type': 'custom_tool_call', 'name': 'exec', 'input': 'cat ~/.codex/skills/tdd/SKILL.md'}},
            {'type': 'response_item', 'payload': {'type': 'custom_tool_call', 'name': 'exec', 'input': 'forge verify'}},
        ), mtime)
        self.write('.codex/sessions/2026/11/s2.jsonl', jl(
            {'type': 'session_meta', 'payload': {'cwd': other}},
            {'type': 'token_usage_record', 'payload': {'usage': cu}},
        ), mtime)

    def env(self):
        env = dict(os.environ)
        env['HOME'] = str(self.home)
        env['HERDR_AGENT_BOARD_CACHE'] = str(self.cache)
        env.pop('XDG_CACHE_HOME', None)
        return env


def strip(result):
    out = dict(result)
    out.pop('_cache', None)
    out['codex'] = {k: v for k, v in result['codex'].items() if k != '_cache'}
    return json.loads(json.dumps(out))


class UsageCacheTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.fx = Fixture(self.tmp.name)
        self.fx.populate()
        # 모듈을 불러오기 전에 HOME을 임시 경로로 바꿔, 실제 사용자 기록을 절대 읽지 않게 합니다.
        self.patch_home = mock.patch.dict(os.environ, self.fx.env(), clear=True)
        self.patch_home.start()
        self.addCleanup(self.patch_home.stop)
        self.assertEqual(Path.home(), self.fx.home)
        self.usage = load_usage()

    def tearDown(self):
        self.tmp.cleanup()

    def collect(self, root=None, now=None):
        return self.usage.collect(str(root or self.fx.proj), home=self.fx.home, cache_dir=self.fx.cache, now=now)

    def legacy(self, root):
        out = subprocess.run([sys.executable, '-I', str(LEGACY), str(root)], env=self.fx.env(), capture_output=True, text=True, check=True)
        return json.loads(out.stdout)

    def test_결과가_기존_구현과_같다_캐시_전후_모두(self):
        for root in (self.fx.proj, self.fx.other, self.fx.sub):
            with self.subTest(root=str(root)):
                expected = self.legacy(root)
                self.assertEqual(strip(self.collect(root)), expected)  # 첫 실행(캐시 생성 또는 재사용)
                self.assertEqual(strip(self.collect(root)), expected)  # 캐시 재사용
        first = strip(self.collect())
        self.assertEqual(first['sessions'], 2)
        self.assertEqual(first['skill_sessions'], 1)
        self.assertEqual(first['forge_sessions'], 1)
        self.assertEqual(first['codex']['sessions'], 1)
        self.assertGreater(first['account_cost_usd'], first['cost_usd'])

    def test_두번째_실행은_파일을_다시_파싱하지_않는다(self):
        first = self.collect()
        self.assertEqual(first['_cache']['parsed'], 5)
        with mock.patch.object(self.usage, 'parse_claude_file', side_effect=AssertionError('재파싱')), \
             mock.patch.object(self.usage, 'parse_codex_file', side_effect=AssertionError('재파싱')):
            second = self.collect()
        self.assertEqual(second['_cache']['parsed'], 0)
        self.assertEqual(second['_cache']['reused'], 5)
        self.assertEqual(strip(first), strip(second))

    def test_한_파일만_바뀌면_그_파일만_다시_읽는다(self):
        self.collect()
        path = self.fx.files['.claude/projects/p3/c.jsonl']
        with open(path, 'a', encoding='utf-8') as f:
            f.write(json.dumps({'type': 'user', 'cwd': str(self.fx.proj)}) + '\n')
        st = path.stat()
        os.utime(path, (st.st_atime, st.st_mtime + 5))
        calls = []
        real = self.usage.parse_claude_file
        with mock.patch.object(self.usage, 'parse_claude_file', side_effect=lambda f, *a: calls.append(f) or real(f, *a)):
            result = self.collect()
        self.assertEqual([Path(c).name for c in calls], ['c.jsonl'])
        self.assertEqual(result['_cache']['parsed'], 1)
        self.assertEqual(strip(result), self.legacy(self.fx.proj))
        self.assertEqual(result['sessions'], 3)  # c.jsonl이 이제 프로젝트 세션

    def test_다른_cwd에서도_계정_비용을_재사용한다(self):
        a = self.collect(self.fx.proj)
        with mock.patch.object(self.usage, 'parse_claude_file', side_effect=AssertionError('재파싱')), \
             mock.patch.object(self.usage, 'parse_codex_file', side_effect=AssertionError('재파싱')):
            b = self.collect(self.fx.other)
        self.assertEqual(b['account_cost_usd'], a['account_cost_usd'])
        self.assertEqual(b['codex']['account_cost_usd'], a['codex']['account_cost_usd'])
        self.assertNotEqual(b['cost_usd'], a['cost_usd'])
        self.assertEqual(strip(b), self.legacy(self.fx.other))

    def test_새_달이면_캐시를_무효화한다(self):
        # 파일 mtime을 다음 달 2일로 두면, 이번 달과 다음 달 모두 집계 대상
        later = next_month(time.time(), day=2)
        for path in self.fx.files.values():
            os.utime(path, (later, later))
        self.collect(now=time.time())
        cache_file = self.fx.cache / 'usage-v1.json'
        month_before = json.loads(cache_file.read_text())['month']
        result = self.collect(now=next_month(time.time(), day=3))
        self.assertEqual(result['_cache']['parsed'], 5)
        self.assertNotEqual(json.loads(cache_file.read_text())['month'], month_before)

    def test_지난_달_파일은_빠지고_캐시에서도_지워진다(self):
        old = month_start(time.time()) - 86400
        path = self.fx.files['.codex/sessions/2026/11/s2.jsonl']
        os.utime(path, (old, old))
        result = self.collect()
        self.assertEqual(result['_cache']['parsed'], 4)
        self.assertEqual(strip(result), self.legacy(self.fx.proj))
        data = json.loads((self.fx.cache / 'usage-v1.json').read_text())
        self.assertEqual(len(data['files']), 4)

    def test_캐시에는_세션_본문이나_경로를_평문으로_두지_않는다(self):
        self.collect()
        text = (self.fx.cache / 'usage-v1.json').read_text()
        for secret in (str(self.fx.proj), str(self.fx.other), str(self.fx.home), 'forge task', '안녕', 'a.jsonl'):
            self.assertNotIn(secret, text)
        self.assertIn('review:pr', text)  # 스킬 이름 집계만 남음

    def test_스크립트_실행은_기존_JSON_형식을_출력한다(self):
        out = subprocess.run([sys.executable, '-I', str(SCRIPT), str(self.fx.proj)], env=self.fx.env(), capture_output=True, text=True, check=True)
        data = json.loads(out.stdout)
        self.assertEqual(strip(data), self.legacy(self.fx.proj))
        self.assertTrue((self.fx.cache / 'usage-v1.json').exists())

    def test_캐시가_깨져_있어도_다시_만든다(self):
        self.fx.cache.mkdir(parents=True)
        (self.fx.cache / 'usage-v1.json').write_text('{broken')
        self.assertEqual(strip(self.collect()), self.legacy(self.fx.proj))


if __name__ == '__main__':
    unittest.main()
