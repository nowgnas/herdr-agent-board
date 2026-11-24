"""board-picker/sessions.py 최근 세션 상한 테스트(임시 HOME + 합성 sqlite/jsonl만 사용)."""
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / 'mods' / 'board-picker' / 'sessions.py'
LEGACY = REPO / 'tests' / 'fixtures' / 'sessions_legacy.py'
BASE = 1_700_000_000


class SessionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.home = root / 'home'
        self.work = root / 'work'
        self.work.mkdir(parents=True)
        (self.home / '.codex').mkdir(parents=True)
        db = sqlite3.connect(self.home / '.codex' / 'state_5.sqlite')
        db.execute('CREATE TABLE threads (id TEXT, cwd TEXT, name TEXT, title TEXT, updated_at INTEGER, agent_role TEXT)')
        # Codex 짝수 초, Claude 홀수 초 → 섞인 최신순
        for i in range(150):
            db.execute('INSERT INTO threads VALUES (?,?,?,?,?,NULL)', (f'codex-{i}', str(self.work), '', f'codex 작업 {i}', BASE + 2 * i))
        db.execute("INSERT INTO threads VALUES ('sub', ?, '', 'sub', ?, 'worker')", (str(self.work), BASE + 999))
        db.commit(); db.close()
        proj = self.home / '.claude' / 'projects' / 'p'
        proj.mkdir(parents=True)
        for i in range(150):
            f = proj / f'claude-{i}.jsonl'
            f.write_text(json.dumps({'type': 'user', 'sessionId': f'claude-{i}', 'cwd': str(self.work), 'message': {'content': f'질문 {i}'}}) + '\n')
            os.utime(f, (BASE + 2 * i + 1, BASE + 2 * i + 1))
        self.env = dict(os.environ, HOME=str(self.home))

    def run_script(self, script, *args):
        out = subprocess.run([sys.executable, '-I', str(script), *args], env=self.env, capture_output=True, text=True, check=True)
        return json.loads(out.stdout)

    def test_기본은_최근_200개와_더보기_표시(self):
        data = self.run_script(SCRIPT)
        self.assertEqual(len(data['sessions']), 200)
        self.assertTrue(data['more'])
        updated = [s['updated'] for s in data['sessions']]
        self.assertEqual(updated, sorted(updated, reverse=True))
        self.assertEqual(data['sessions'][0]['id'], 'claude-149')
        # 가장 최근 200개 = 전체 300개 중 위쪽 200개
        legacy = self.run_script(LEGACY)['sessions']
        self.assertEqual(data['sessions'], legacy[:200])

    def test_상한을_늘리면_기존과_같은_전체_목록(self):
        data = self.run_script(SCRIPT, '--limit', '1000')
        self.assertFalse(data['more'])
        self.assertEqual(data['sessions'], self.run_script(LEGACY)['sessions'])
        self.assertEqual(data['errors'], [])

    def test_Claude는_상한만큼만_파일을_읽는다(self):
        with mock.patch.dict(os.environ, self.env, clear=True):
            spec = importlib.util.spec_from_file_location('board_sessions', SCRIPT)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            calls = []
            real = module.read_claude
            with mock.patch.object(module, 'read_claude', side_effect=lambda f: calls.append(f) or real(f)):
                result = module.collect(self.home, 20)
        self.assertEqual(len(result['sessions']), 20)
        self.assertEqual(len(calls), 20)
        self.assertEqual(Path(calls[0]).name, 'claude-149.jsonl')


if __name__ == '__main__':
    unittest.main()
