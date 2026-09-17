"""Recovery regressions. All persistence uses temporary folders; API calls are mocked."""
import json
import os
import tempfile
import subprocess
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import server


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.log_patch = patch.object(server, "LOG_ROOT", Path(self.directory.name))
        self.log_patch.start()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.log_patch.stop)
        self.restart()
        server.AUDIO_CACHE.clear()
        server.AUDIO_BUSY.clear()
        self.client = server.app.test_client()
        self.speech = patch.object(server, "_azure_speak_bytes", return_value=(b"RIFF-test-audio", []))
        self.speech.start()
        self.addCleanup(self.speech.stop)
        self.delay = patch.object(server, "HUMAN_PROCESSING_DELAY_SECONDS", 0)
        self.delay.start()
        self.addCleanup(self.delay.stop)
        self.env = patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.model = Mock()
        self.model.chat.completions.create.return_value = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="Split"))])
        self.ai_patch = patch.object(server, "OpenAI", return_value=self.model)
        self.ai_patch.start()
        self.addCleanup(self.ai_patch.stop)

    def restart(self):
        with server.SESSION_LOCK:
            server.SESSION_STORE.clear()
            server.GAME_STORE.clear()
            server.HUMAN_QUEUE.clear()

    def mode(self, sid="HUMAN_TEST", mode="human"):
        return self.client.post("/api/confederate/session-mode", json={"session_id": sid, "mode": mode})

    def human_choice(self, rid="human_choice_001", round_no=1):
        return self.client.post("/api/human-split-steal", json={
            "session_id": "HUMAN_TEST", "request_id": rid, "expected_round": round_no,
            "choice": "split", "avatar": "female"})

    def resolve(self, rid="human_choice_001"):
        return self.client.post("/api/confederate/reply", json={
            "session_id": "HUMAN_TEST", "message_id": rid, "choice": "split"})

    def ack(self, sid, rid):
        return self.client.post(f"/api/interaction/{sid}/{rid}/ack", json={"presentation": "audio"})

    def ai_choice(self, rid="ai_choice_001", round_no=1):
        return self.client.post("/api/split-steal", json={
            "session_id": "AI_TEST", "request_id": rid, "expected_round": round_no,
            "choice": "split", "avatar": "male"})

    def test_human_duplicate_retry_and_stale_round(self):
        self.mode()
        first = self.human_choice()
        retry = self.human_choice()
        self.assertEqual(first.get_json()["message_id"], retry.get_json()["message_id"])
        self.assertEqual(self.human_choice("different_request").status_code, 409)
        self.assertEqual(self.resolve().status_code, 200)
        self.assertTrue(self.resolve().get_json()["already_answered"])
        self.assertEqual(self.human_choice().status_code, 200)
        state = self.client.get("/api/session-state/HUMAN_TEST").get_json()
        self.assertEqual((state["round"], state["bank"]), (2, 50))
        self.ack("HUMAN_TEST", "human_choice_001")
        self.assertEqual(self.human_choice("stale_request_001").status_code, 409)
        self.assertEqual(self.human_choice("next_request_001", 2).status_code, 200)

    def test_concurrent_human_choices_only_queue_once(self):
        self.mode()
        barrier = threading.Barrier(2)
        def submit(rid):
            with server.app.test_client() as client:
                barrier.wait(timeout=2)
                return client.post("/api/human-split-steal", json={
                    "session_id": "HUMAN_TEST", "request_id": rid,
                    "choice": "split", "expected_round": 1}).status_code
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(submit, ["parallel_one", "parallel_two"]))
        self.assertEqual(sorted(results), [200, 409])
        self.assertEqual(len(server.HUMAN_QUEUE["HUMAN_TEST"]["pending"]), 1)

    def test_restart_restores_human_pending_result_bank_mode_and_ack(self):
        self.mode()
        self.human_choice()
        self.restart()
        session = self.client.post("/api/session-register", json={"session_id": "HUMAN_TEST"}).get_json()
        self.assertEqual(session["mode"], "human")
        self.assertEqual(session["recoverable"][0]["id"], "human_choice_001")
        self.resolve()
        self.restart()
        result = self.client.get("/api/interaction/HUMAN_TEST/human_choice_001").get_json()
        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["bank"], 50)
        self.ack("HUMAN_TEST", "human_choice_001")
        self.restart()
        session = self.client.get("/api/session-state/HUMAN_TEST").get_json()
        self.assertEqual((session["round"], session["bank"], session["mode"]), (2, 50, "human"))
        self.assertEqual(session["recoverable"], [])

    def test_restart_restores_ai_result_without_regeneration(self):
        first = self.ai_choice().get_json()
        self.restart()
        second = self.ai_choice().get_json()
        self.assertEqual((second["round"], second["bank"], second["message_id"]),
                         (first["round"], first["bank"], first["message_id"]))
        self.assertEqual(self.model.chat.completions.create.call_count, 1)

    def test_new_process_restores_committed_state(self):
        self.mode()
        self.human_choice()
        self.resolve()
        self.ack("HUMAN_TEST", "human_choice_001")
        code = (
            "import json,sys; from pathlib import Path; import server; "
            "server.LOG_ROOT=Path(sys.argv[1]); "
            "print(json.dumps(server.app.test_client().get('/api/session-state/HUMAN_TEST').get_json()))"
        )
        process = subprocess.run([sys.executable, "-c", code, str(server.LOG_ROOT)],
                                 check=True, capture_output=True, text=True, cwd=Path(server.__file__).parent)
        state = json.loads(process.stdout)
        self.assertEqual((state["round"], state["bank"], state["mode"]), (2, 50, "human"))
        self.assertEqual(state["recoverable"], [])

    def test_ai_failure_retries_same_id_and_blocks_other_requests(self):
        self.model.chat.completions.create.side_effect = RuntimeError("offline")
        self.assertEqual(self.ai_choice().status_code, 500)
        self.assertEqual(self.ai_choice("different_request").status_code, 409)
        self.restart()
        state = self.client.get("/api/interaction/AI_TEST/ai_choice_001").get_json()
        self.assertEqual(state["status"], "interrupted")
        self.model.chat.completions.create.side_effect = None
        self.assertEqual(self.ai_choice().get_json()["bank"], 50)

    def test_request_id_cannot_be_reused_for_different_choice(self):
        self.ai_choice()
        response = self.client.post("/api/split-steal", json={"session_id": "AI_TEST",
            "request_id": "ai_choice_001", "choice": "steal", "expected_round": 1})
        self.assertEqual(response.status_code, 409)

    def test_assigned_route_is_enforced_on_all_message_and_choice_endpoints(self):
        self.mode()
        for endpoint in ("/api/ask", "/api/reply", "/api/split-steal"):
            response = self.client.post(endpoint, json={"session_id": "HUMAN_TEST",
                "request_id": "wrong_route_001", "text": "Hello", "choice": "split", "expected_round": 1})
            self.assertEqual(response.status_code, 409, endpoint)
        for endpoint in ("/api/human-message", "/api/human-split-steal"):
            response = self.client.post(endpoint, json={"session_id": "AI_TEST",
                "request_id": "wrong_route_002", "text": "Hello", "choice": "split", "expected_round": 1})
            self.assertEqual(response.status_code, 409, endpoint)
        self.model.chat.completions.create.assert_not_called()

    def test_mode_change_is_blocked_until_response_presented(self):
        self.mode()
        self.human_choice()
        self.assertEqual(self.mode(mode="ai").status_code, 409)
        self.resolve()
        self.assertEqual(self.mode(mode="ai").status_code, 409)
        self.ack("HUMAN_TEST", "human_choice_001")
        self.assertEqual(self.mode(mode="unknown").status_code, 200)

    def test_speech_failure_preserves_ai_chat_and_human_round(self):
        self.mode()
        self.human_choice()
        self.resolve()
        with patch.object(server, "_azure_speak_bytes", side_effect=RuntimeError("offline")):
            human = self.client.post("/api/interaction/HUMAN_TEST/human_choice_001/audio").get_json()
            self.assertEqual(human["bank"], 50)
            self.assertIn("audio_error", human)
            chat = self.client.post("/api/ask", json={"session_id": "CHAT_TEST",
                "request_id": "chat_request_001", "text": "Hello"})
            self.assertEqual(chat.status_code, 200)
            self.assertIn("reply", chat.get_json())
            self.assertIn("audio_error", chat.get_json())
        audio = self.client.post("/api/interaction/HUMAN_TEST/human_choice_001/audio").get_json()
        self.assertIn("audio_base64", audio)
        self.assertEqual(self.client.get("/api/session-state/HUMAN_TEST").get_json()["bank"], 50)
        self.assertEqual(self.model.chat.completions.create.call_count, 1)

    def test_audio_cache_prevents_duplicate_synthesis(self):
        self.ai_choice()
        with patch.object(server, "_azure_speak_bytes") as synthesis:
            result = self.client.post("/api/interaction/AI_TEST/ai_choice_001/audio").get_json()
            self.assertIn("audio_base64", result)
            synthesis.assert_not_called()

    def test_human_seven_round_limit(self):
        self.mode()
        for number in range(1, 8):
            rid = f"human_round_{number}"
            self.assertEqual(self.human_choice(rid, number).status_code, 200)
            self.assertEqual(self.resolve(rid).status_code, 200)
            self.assertEqual(self.ack("HUMAN_TEST", rid).status_code, 200)
        state = self.client.get("/api/session-state/HUMAN_TEST").get_json()
        self.assertEqual(state["bank"], 350)
        self.assertTrue(state["complete"])
        self.assertEqual(self.human_choice("eighth_request", 8).status_code, 400)

    def test_human_and_unknown_rounds_share_log_schema(self):
        self.mode()
        self.human_choice()
        self.resolve()
        self.mode("AI_TEST", "unknown")
        self.ai_choice()
        records = []
        for sid in ("HUMAN_TEST", "AI_TEST"):
            rounds = json.loads((server.LOG_ROOT / sid / "split_steal_rounds.json").read_text())
            self.assertEqual(len(rounds), 1)
            record = rounds[0]
            for key in ("schema_version", "participant_id", "request_id", "mode", "engine", "round",
                        "participant_choice", "assistant_choice", "outcome", "payout", "bank", "pot",
                        "timestamp", "avatar", "model", "voice"):
                self.assertIn(key, record)
            self.assertEqual((record["outcome"], record["payout"]), ("tie", 50))
            records.append(record)
        self.assertEqual([r["mode"] for r in records], ["human", "unknown"])
        self.assertEqual(records[0]["avatar"], "female")

    def test_full_transcript_is_saved_beyond_model_memory_window(self):
        for number in range(8):
            rid = f"chat_turn_{number}"
            response = self.client.post("/api/ask", json={"session_id": "CHAT_TEST", "request_id": rid,
                                                       "text": f"Message {number}"})
            self.assertEqual(response.status_code, 200)
            self.ack("CHAT_TEST", rid)
        self.restart()
        history = self.client.get("/api/history/CHAT_TEST").get_json()
        self.assertEqual(len(history["dialogue"]), 16)
        self.assertEqual(len(server._get_model_history_snapshot("CHAT_TEST")), server.MAX_MEMORY_TURNS * 2)

    def test_legacy_rounds_and_pending_can_be_restored(self):
        directory = server.LOG_ROOT / "LEGACY_TEST"
        directory.mkdir()
        events = [
            {"type": "session_mode_set", "mode": "human", "timestamp": "2026-07-20T00:00:00+00:00"},
            {"type": "human_choice_resolved", "round": 2, "bank": 100},
            {"type": "human_message_pending", "id": "hm_legacy", "kind": "message", "session_id": "LEGACY_TEST",
             "participant_text": "Hello", "created_at": "2026-07-20T00:01:00+00:00"},
        ]
        (directory / "events.jsonl").write_text("".join(json.dumps(e)+"\n" for e in events))
        state = self.client.get("/api/session-state/LEGACY_TEST").get_json()
        self.assertEqual((state["round"], state["bank"], state["mode"]), (3, 100, "human"))
        self.assertEqual(state["recoverable"][0]["id"], "hm_legacy")
        replay = self.client.post("/api/human-message", json={"session_id": "LEGACY_TEST",
            "request_id": "hm_legacy", "text": "Hello", "avatar": "male"})
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.get_json()["message_id"], "hm_legacy")
        self.assertEqual(len(server.HUMAN_QUEUE["LEGACY_TEST"]["pending"]), 1)

    def test_corrupted_authoritative_save_is_not_reset(self):
        directory = server.LOG_ROOT / "BROKEN_TEST"
        directory.mkdir()
        (directory / "state.json").write_text("not json")
        response = self.client.post("/api/session-register", json={"session_id": "BROKEN_TEST"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual((directory / "state.json").read_text(), "not json")
        self.mode()
        dashboard = self.client.get("/api/confederate/sessions")
        self.assertEqual(dashboard.status_code, 200)
        self.assertEqual(dashboard.get_json()["session_errors"][0]["session_id"], "BROKEN_TEST")
        self.assertEqual(dashboard.get_json()["sessions"][0]["session_id"], "HUMAN_TEST")

    def test_atomic_save_failure_does_not_leave_a_ghost_payout(self):
        self.mode()
        self.human_choice()
        with patch.object(server, "_write_json", side_effect=OSError("disk unavailable")):
            with self.assertLogs(server.app.logger, level="ERROR"):
                self.assertEqual(self.resolve().status_code, 503)
        state = self.client.get("/api/session-state/HUMAN_TEST").get_json()
        self.assertEqual((state["round"], state["bank"]), (1, 0))
        self.assertEqual(self.resolve().status_code, 200)
        self.assertEqual(self.client.get("/api/session-state/HUMAN_TEST").get_json()["bank"], 50)

    def test_operator_routes_use_new_dashboard(self):
        for path in ("/confederate", "/confederate.html"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 302)
            self.assertEqual(response.location, "/?mode=confederate")


if __name__ == "__main__":
    unittest.main()
