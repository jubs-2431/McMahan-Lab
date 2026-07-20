import json
import os
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import server


class SplitStealStateTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_log_root = server.LOG_ROOT
        server.LOG_ROOT = Path(self.temp_dir.name)
        with server.SESSION_LOCK:
            server.SESSION_STORE.clear()
            server.GAME_STORE.clear()
            server.HUMAN_QUEUE.clear()
        self.client = server.app.test_client()

    def tearDown(self):
        server.LOG_ROOT = self.original_log_root
        self.temp_dir.cleanup()

    @staticmethod
    def _completion(choice):
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=choice))]
        )

    def test_ai_round_bank_and_completion_state(self):
        openai_client = Mock()
        openai_client.chat.completions.create.return_value = self._completion("Split")

        with (
            patch.dict(
                os.environ,
                {
                    "OPENAI_API_KEY": "test-key",
                    "AZURE_SPEECH_KEY": "",
                    "AZURE_SPEECH_REGION": "",
                },
                clear=False,
            ),
            patch.object(server, "OpenAI", return_value=openai_client),
        ):
            for expected_round in range(1, 8):
                response = self.client.post(
                    "/api/split-steal",
                    json={"choice": "split", "expected_round": expected_round, "session_id": "TEST_AI_STATE"},
                )
                self.assertEqual(response.status_code, 200)
                data = response.get_json()
                self.assertEqual(data["round"], expected_round)
                self.assertEqual(data["next_round"], min(expected_round + 1, 7))
                self.assertEqual(data["pot"], 100)
                self.assertEqual(data["payout"], 50)
                self.assertEqual(data["bank"], expected_round * 50)
                self.assertEqual(data["complete"], expected_round == 7)

            rejected = self.client.post(
                "/api/split-steal",
                json={"choice": "split", "expected_round": 7, "session_id": "TEST_AI_STATE"},
            )
            self.assertEqual(rejected.status_code, 400)
            self.assertEqual(rejected.get_json()["error"], "All rounds are complete.")

        restored = self.client.post(
            "/api/session-register", json={"session_id": "TEST_AI_STATE"}
        ).get_json()
        self.assertEqual(restored["bank"], 350)
        self.assertTrue(restored["complete"])

    def test_all_outcomes_have_correct_payouts(self):
        cases = [
            ("split", "Split", "tie", 50),
            ("steal", "Split", "user_wins", 100),
            ("split", "Steal", "assistant_wins", 0),
            ("steal", "Steal", "no_one_wins", 0),
        ]

        for index, (participant_choice, assistant_choice, outcome, payout) in enumerate(cases):
            with self.subTest(outcome=outcome):
                openai_client = Mock()
                openai_client.chat.completions.create.return_value = self._completion(assistant_choice)
                with (
                    patch.dict(
                        os.environ,
                        {
                            "OPENAI_API_KEY": "test-key",
                            "AZURE_SPEECH_KEY": "",
                            "AZURE_SPEECH_REGION": "",
                        },
                        clear=False,
                    ),
                    patch.object(server, "OpenAI", return_value=openai_client),
                ):
                    response = self.client.post(
                        "/api/split-steal",
                        json={"choice": participant_choice, "expected_round": 1, "session_id": f"PAYOUT_{index}"},
                    )

                data = response.get_json()
                self.assertEqual(response.status_code, 200)
                self.assertEqual(data["outcome"], outcome)
                self.assertEqual(data["payout"], payout)
                self.assertEqual(data["bank"], payout)

    def test_failed_request_releases_choice_lock(self):
        with patch.dict(os.environ, {}, clear=True):
            first = self.client.post(
                "/api/split-steal",
                json={"choice": "steal", "expected_round": 1, "session_id": "TEST_UNLOCK"},
            )
            second = self.client.post(
                "/api/split-steal",
                json={"choice": "steal", "expected_round": 1, "session_id": "TEST_UNLOCK"},
            )

        self.assertEqual(first.status_code, 500)
        self.assertEqual(second.status_code, 500)
        with server.SESSION_LOCK:
            self.assertFalse(server.HUMAN_QUEUE["TEST_UNLOCK"]["ai_choice_pending"])

    def test_duplicate_and_replayed_round_do_not_advance_twice(self):
        started = threading.Event()
        release = threading.Event()
        openai_client = Mock()

        def delayed_completion(**_kwargs):
            started.set()
            release.wait(timeout=2)
            return self._completion("Split")

        openai_client.chat.completions.create.side_effect = delayed_completion

        def submit_choice():
            with server.app.test_client() as client:
                return client.post(
                    "/api/split-steal",
                    json={"choice": "split", "expected_round": 1, "session_id": "TEST_DUPLICATE"},
                )

        with (
            patch.dict(
                os.environ,
                {
                    "OPENAI_API_KEY": "test-key",
                    "AZURE_SPEECH_KEY": "",
                    "AZURE_SPEECH_REGION": "",
                },
                clear=False,
            ),
            patch.object(server, "OpenAI", return_value=openai_client),
            ThreadPoolExecutor(max_workers=1) as executor,
        ):
            first_future = executor.submit(submit_choice)
            self.assertTrue(started.wait(timeout=1))
            overlapping = submit_choice()
            self.assertEqual(overlapping.status_code, 409)
            release.set()
            first = first_future.result(timeout=2)
            replayed = submit_choice()

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.get_json()["bank"], 50)
        self.assertEqual(replayed.status_code, 409)
        state = self.client.get("/api/session-state/TEST_DUPLICATE").get_json()
        self.assertEqual(state["round"], 2)
        self.assertEqual(state["bank"], 50)

    def test_azure_failure_advances_once_and_unknown_event_is_persisted(self):
        openai_client = Mock()
        openai_client.chat.completions.create.return_value = self._completion("Split")
        self.client.post(
            "/api/confederate/session-mode",
            json={"session_id": "TEST_UNKNOWN", "mode": "unknown"},
        )

        with (
            patch.dict(
                os.environ,
                {
                    "OPENAI_API_KEY": "test-key",
                    "AZURE_SPEECH_KEY": "azure-test-key",
                    "AZURE_SPEECH_REGION": "eastus",
                },
                clear=False,
            ),
            patch.object(server, "OpenAI", return_value=openai_client),
            patch.object(server, "_azure_speak_bytes", side_effect=RuntimeError("offline")),
        ):
            response = self.client.post(
                "/api/split-steal",
                json={"choice": "steal", "expected_round": 1, "session_id": "TEST_UNKNOWN"},
            )

        data = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(data["round"], 1)
        self.assertEqual(data["next_round"], 2)
        self.assertEqual(data["bank"], 100)
        self.assertIn("offline", data["audio_error"])

        events_path = server.LOG_ROOT / "TEST_UNKNOWN" / "events.jsonl"
        persisted_events = [
            json.loads(line)
            for line in events_path.read_text(encoding="utf-8").splitlines()
        ]
        resolved = [event for event in persisted_events if event.get("type") == "ai_choice_resolved"]
        rounds = [event for event in persisted_events if event.get("type") == "split_steal"]
        self.assertEqual(len(resolved), 1)
        self.assertEqual(len(rounds), 1)
        self.assertEqual(resolved[0]["mode"], "unknown")
        self.assertEqual(resolved[0]["round"], 1)
        self.assertEqual(resolved[0]["payout"], 100)
        self.assertEqual(resolved[0]["bank"], 100)
        self.assertEqual(rounds[0]["round"], 1)
        self.assertEqual(rounds[0]["payout"], 100)
        self.assertEqual(rounds[0]["bank"], 100)
        self.assertEqual(rounds[0]["pot"], 100)


if __name__ == "__main__":
    unittest.main()
