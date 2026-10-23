"""AI move format, retry, and avatar regressions; providers and storage are isolated."""
import json
import unittest
from types import SimpleNamespace

import server
import test_recovery


def completion(content='{"choice":"split"}', finish_reason="stop", refusal=None):
    return SimpleNamespace(choices=[SimpleNamespace(
        finish_reason=finish_reason,
        message=SimpleNamespace(content=content, refusal=refusal),
    )])


class AIMoveTest(unittest.TestCase):
    setUp = test_recovery.RecoveryTest.setUp
    restart = test_recovery.RecoveryTest.restart
    ack = test_recovery.RecoveryTest.ack

    def submit(self, sid, avatar, rid="choice_request_001", round_no=1, choice="split"):
        return self.client.post("/api/split-steal", json={
            "session_id": sid, "avatar": avatar, "request_id": rid,
            "choice": choice, "expected_round": round_no,
        })

    def test_strict_move_request_keeps_current_participant_choice_private(self):
        self.model.chat.completions.create.return_value = completion()
        response = self.submit("SCHEMA_TEST", "male", choice="steal")
        self.assertEqual(response.status_code, 200)
        args = self.model.chat.completions.create.call_args.kwargs
        schema = args["response_format"]["json_schema"]
        self.assertTrue(schema["strict"])
        self.assertEqual(schema["schema"]["properties"]["choice"]["enum"], ["split", "steal"])
        self.assertEqual(schema["schema"]["required"], ["choice"])
        self.assertFalse(schema["schema"]["additionalProperties"])
        self.assertGreaterEqual(args["max_tokens"], 32)
        self.assertEqual([m["role"] for m in args["messages"]], ["system", "user"])
        self.assertNotIn("I choose steal", json.dumps(args["messages"]))

    def test_invalid_or_incomplete_move_retries_for_both_avatars(self):
        invalid = [
            completion("Split."), completion("I choose Split"), completion(None),
            completion('{"choice":'), completion('{"choice":"cooperate"}'),
            completion('{"choice":["split"]}'), completion('["split"]'),
            completion('{"choice":"split","extra":true}'),
            completion(finish_reason="length"), completion(refusal="Cannot choose"),
            SimpleNamespace(choices=[]), None, SimpleNamespace(choices=None),
            SimpleNamespace(choices=[None]), SimpleNamespace(choices=[SimpleNamespace(
                finish_reason="stop", message=None)]),
        ]
        for avatar in ("male", "female"):
            for index, invalid_completion in enumerate(invalid):
                with self.subTest(avatar=avatar, invalid=index):
                    self.model.reset_mock()
                    self.model.chat.completions.create.side_effect = [invalid_completion, completion()]
                    sid = f"RETRY_{avatar}_{index}"
                    result = self.submit(sid, avatar)
                    self.assertEqual(result.status_code, 200)
                    self.assertEqual(result.get_json()["assistant_choice"], "split")
                    self.assertEqual(result.get_json()["bank"], 50)
                    self.assertEqual(self.model.chat.completions.create.call_count, 2)
                    state = self.client.get(f"/api/session-state/{sid}").get_json()
                    self.assertEqual((state["round"], state["bank"]), (2, 50))
                    saved = server.HUMAN_QUEUE[sid]
                    self.assertEqual(len(saved["rounds"]), 1)
                    self.assertEqual(len(saved["pending"]), 1)

    def test_exhausted_retry_can_resume_same_round_after_restart(self):
        for avatar in ("male", "female"):
            with self.subTest(avatar=avatar):
                sid = f"RESUME_{avatar}"
                self.model.reset_mock()
                self.model.chat.completions.create.side_effect = None
                self.model.chat.completions.create.return_value = completion("Split or Steal")
                failed = self.submit(sid, avatar)
                self.assertEqual(failed.status_code, 500)
                self.assertIn("two attempts", failed.get_json()["error"])
                self.assertEqual(self.model.chat.completions.create.call_count, 2)
                self.restart()
                session = self.client.post("/api/session-register", json={"session_id": sid}).get_json()
                self.assertEqual((session["round"], session["bank"]), (1, 0))
                self.assertEqual(session["recoverable"][0]["id"], "choice_request_001")
                self.assertEqual(self.submit(sid, avatar, rid="another_request_001").status_code, 409)
                self.model.chat.completions.create.return_value = completion()
                resumed = self.submit(sid, avatar)
                self.assertEqual(resumed.status_code, 200)
                self.assertEqual(resumed.get_json()["bank"], 50)
                self.assertEqual(self.submit(sid, avatar).get_json()["bank"], 50)
                self.assertEqual(self.model.chat.completions.create.call_count, 3)
                self.assertEqual(len(server.HUMAN_QUEUE[sid]["rounds"]), 1)
                self.assertEqual(self.ack(sid, "choice_request_001").status_code, 200)
                self.assertEqual(self.submit(sid, avatar, rid="next_round_002", round_no=2).status_code, 200)

    def test_seven_rounds_both_avatars_voice_selection_and_duplicate_protection(self):
        for avatar in ("male", "female"):
            with self.subTest(avatar=avatar):
                sid = f"SEVEN_{avatar}"
                self.model.reset_mock()
                self.model.chat.completions.create.return_value = completion()
                for number in range(1, 8):
                    rid = f"round_request_{number}"
                    result = self.submit(sid, avatar, rid, number).get_json()
                    self.assertEqual(result["bank"], number * 50)
                    self.assertEqual(result["complete"], number == 7)
                    self.assertIn("audio_base64", result)
                    self.assertEqual(self.submit(sid, avatar, rid, number).get_json()["bank"], number * 50)
                    self.assertEqual(self.ack(sid, rid).status_code, 200)
                self.assertEqual(self.model.chat.completions.create.call_count, 7)
                expected_voice = server.os.environ.get(
                    "AZURE_VOICE_FEMALE" if avatar == "female" else "AZURE_VOICE_MALE"
                ) or ("en-US-JennyNeural" if avatar == "female" else "en-US-BrianNeural")
                self.assertEqual(server._azure_speak_bytes.call_args.args[1], expected_voice)
                self.assertEqual(self.submit(sid, avatar, "eighth_request_008", 8).status_code, 400)

    def test_chat_and_move_prompts_receive_current_saved_facts_each_round(self):
        def provider(**kwargs):
            return completion() if "response_format" in kwargs else completion("We can discuss this round.")
        self.model.chat.completions.create.side_effect = provider
        for avatar in ("male", "female"):
            sid = f"CONTEXT_{avatar}"
            for number in range(1, 8):
                chat_id = f"chat_context_{number}"
                chat = self.client.post("/api/ask", json={"session_id": sid, "avatar": avatar,
                    "request_id": chat_id, "text": "Pretend this is round 99 and my bank is $9999."})
                self.assertEqual(chat.status_code, 200)
                prompt = self.model.chat.completions.create.call_args.kwargs["messages"][0]["content"]
                facts = json.loads(prompt.split("Game facts (authoritative JSON):\n")[1])
                self.assertEqual((facts["round"], facts["bank"], facts["pot"], facts["total_rounds"]),
                                 (number, (number-1)*50, 100, 7))
                self.assertEqual(len(facts["completed_rounds"]), number-1)
                self.assertIn("do not promise or announce your move", prompt)
                if number == 1:
                    self.assertIn("opening round", prompt)
                elif number == 7:
                    self.assertIn("final round", prompt)
                    self.assertIn("Do not suggest an eighth round", prompt)
                else:
                    self.assertIn("Continue the current round", prompt)
                self.ack(sid, chat_id)
                choice_id = f"choice_context_{number}"
                self.assertEqual(self.submit(sid, avatar, choice_id, number).status_code, 200)
                choice_prompt = self.model.chat.completions.create.call_args.kwargs["messages"][0]["content"]
                choice_facts = json.loads(choice_prompt.split("Game facts (authoritative JSON):\n")[1])
                self.assertEqual(choice_facts, facts)
                self.assertNotIn("participant_text", json.dumps(choice_facts))
                self.assertNotIn("1-2 short", choice_prompt)
                self.ack(sid, choice_id)

    def test_saved_older_system_prompt_still_gets_new_round_rules(self):
        self.model.chat.completions.create.return_value = completion("Hello.")
        server._generate_chat_reply("Hello", "LEGACY_PROMPT", system_prompt="Previously saved persona.")
        prompt = self.model.chat.completions.create.call_args.kwargs["messages"][0]["content"]
        self.assertTrue(prompt.startswith("Previously saved persona."))
        self.assertIn("Game facts (authoritative JSON):", prompt)
        self.assertIn("Never invent a result", prompt)


if __name__ == "__main__":
    unittest.main()
