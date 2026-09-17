"""Regressions for storage races, bounded speech and request lifecycle."""
import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
import unittest
import server
import test_recovery

REAL_SPEECH = server._azure_speak_bytes

class BackendEdges(unittest.TestCase):
    setUp = test_recovery.RecoveryTest.setUp
    restart = test_recovery.RecoveryTest.restart
    mode = test_recovery.RecoveryTest.mode
    ai_choice = test_recovery.RecoveryTest.ai_choice
    human_choice = test_recovery.RecoveryTest.human_choice
    resolve = test_recovery.RecoveryTest.resolve
    ack = test_recovery.RecoveryTest.ack

    def test_missing_bank_is_rejected_without_overwriting_save(self):
        self.ai_choice()
        path = server.LOG_ROOT / 'AI_TEST' / 'state.json'
        state = json.loads(path.read_text())
        del state['bank']
        path.write_text(json.dumps(state))
        before = path.read_bytes()
        self.restart()
        self.assertEqual(self.client.get('/api/session-state/AI_TEST').status_code, 409)
        self.assertEqual(path.read_bytes(), before)

    def test_chat_rejected_after_final_round(self):
        for number in range(1, 8):
            rid = 'complete_round_' + str(number)
            self.assertEqual(self.ai_choice(rid, number).status_code, 200)
            self.ack('AI_TEST', rid)
        response = self.client.post('/api/ask', json={'session_id':'AI_TEST',
            'request_id':'chat_after_end', 'text':'Hello'})
        self.assertEqual(response.status_code, 400)

    def test_inflight_ai_survives_another_failed_save(self):
        entered, release = threading.Event(), threading.Event()
        completion = self.model.chat.completions.create.return_value
        def generate(**kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return completion
        self.model.chat.completions.create.side_effect = generate
        def submit():
            with server.app.test_client() as client:
                return client.post('/api/split-steal', json={'session_id':'AI_TEST',
                    'request_id':'ai_choice_001', 'choice':'split', 'expected_round':1}).status_code
        with ThreadPoolExecutor() as pool:
            future = pool.submit(submit)
            try:
                self.assertTrue(entered.wait(3))
                with patch.object(server, '_write_json', side_effect=OSError('disk full')):
                    self.assertEqual(self.client.post('/api/session-register', json={'session_id':'AI_TEST'}).status_code, 503)
            finally:
                release.set()
            self.assertEqual(future.result(5), 200)
        state = self.client.get('/api/session-state/AI_TEST').get_json()
        self.assertEqual((state['round'],state['bank']), (2,50))
        self.assertEqual(self.ai_choice().get_json()['status'], 'ready')
        self.assertEqual(self.model.chat.completions.create.call_count, 1)

    def test_slow_session_save_does_not_block_other_sessions_or_dashboard(self):
        self.client.post('/api/session-register',json={'session_id':'AI_TEST'})
        entered, release = threading.Event(), threading.Event()
        original = server._write_json
        def slow(path, payload):
            if path.parent.name == 'AI_TEST' and path.name == 'state.json':
                entered.set()
                self.assertTrue(release.wait(5))
            return original(path,payload)
        def register():
            return server.app.test_client().post('/api/session-register',json={'session_id':'AI_TEST'}).status_code
        with ThreadPoolExecutor() as pool, patch.object(server,'_write_json',side_effect=slow):
            future = pool.submit(register)
            try:
                self.assertTrue(entered.wait(3))
                other = pool.submit(lambda: server.app.test_client().get('/api/session-state/OTHER_TEST').status_code)
                self.assertEqual(other.result(1),200)
                dashboard = pool.submit(lambda: server.app.test_client().get('/api/confederate/sessions').get_json())
                self.assertTrue(any(s.get('saving') for s in dashboard.result(1)['sessions']))
            finally:
                release.set()
            self.assertEqual(future.result(5),200)

    def test_cancelled_human_request_cannot_be_resolved(self):
        self.mode()
        self.human_choice()
        self.assertEqual(self.client.post('/api/confederate/cancel',json={
            'session_id':'HUMAN_TEST','message_id':'human_choice_001','reason':'Operator recovery'}).status_code,200)
        self.assertEqual(self.resolve().status_code,409)
        self.assertEqual(self.human_choice().status_code,409)
        self.assertEqual(self.human_choice('replacement_001').status_code,200)
        self.assertEqual(self.client.get('/api/session-state/HUMAN_TEST').get_json()['bank'],0)

    def test_cancelled_ai_callback_cannot_pay_out(self):
        entered, release = threading.Event(), threading.Event()
        completion = self.model.chat.completions.create.return_value
        def generate(**kwargs):
            entered.set()
            self.assertTrue(release.wait(5))
            return completion
        self.model.chat.completions.create.side_effect = generate
        with ThreadPoolExecutor() as pool:
            future = pool.submit(lambda: server.app.test_client().post('/api/split-steal', json={
                'session_id':'AI_TEST','request_id':'cancel_ai_001','choice':'split','expected_round':1}))
            try:
                self.assertTrue(entered.wait(3))
                response = self.client.post('/api/confederate/cancel',json={
                    'session_id':'AI_TEST','message_id':'cancel_ai_001','reason':'Cancel stuck request'})
                self.assertEqual(response.status_code,200)
            finally:
                release.set()
            self.assertEqual(future.result(5).get_json()['status'],'cancelled')
        self.assertEqual(self.client.get('/api/session-state/AI_TEST').get_json()['bank'],0)

    def test_speech_timeout_kills_worker_and_releases_capacity(self):
        worker = server.LOG_ROOT / 'sleep_worker.py'
        pidfile = server.LOG_ROOT / 'pid'
        worker.write_text('import os,time\nfrom pathlib import Path\nPath('+repr(str(pidfile))+').write_text(str(os.getpid()))\ntime.sleep(60)\n')
        slots = threading.BoundedSemaphore(1)
        with patch.object(server,'SPEECH_WORKER',worker), patch.object(server,'SPEECH_TIMEOUT_SECONDS',0.3), patch.object(server,'SPEECH_SLOTS',slots), patch.dict(os.environ,{'AZURE_SPEECH_KEY':'test','AZURE_SPEECH_REGION':'test'}):
            with self.assertRaisesRegex(RuntimeError,'timed out'):
                REAL_SPEECH('hello','voice')
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pidfile.read_text()),0)
        self.assertTrue(slots.acquire(blocking=False))
        slots.release()

    def test_audio_busy_returns_retryable_pending_and_ack_is_visible(self):
        self.mode()
        self.human_choice()
        self.resolve()
        entered, release = threading.Event(), threading.Event()
        def speech(*args):
            entered.set()
            self.assertTrue(release.wait(5))
            return b'audio', []
        with ThreadPoolExecutor() as pool, patch.object(server,'_azure_speak_bytes',side_effect=speech):
            future = pool.submit(lambda: server.app.test_client().post('/api/interaction/HUMAN_TEST/human_choice_001/audio').status_code)
            try:
                self.assertTrue(entered.wait(3))
                result = self.client.post('/api/interaction/HUMAN_TEST/human_choice_001/audio').get_json()
                self.assertTrue(result['audio_pending'])
            finally:
                release.set()
            self.assertEqual(future.result(5),200)
        self.ack('HUMAN_TEST','human_choice_001')
        self.assertTrue(self.client.get('/api/interaction/HUMAN_TEST/human_choice_001').get_json()['acknowledged'])

if __name__ == '__main__':
    unittest.main()
