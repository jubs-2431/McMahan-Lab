"""
Local API for OpenAI chat, Azure speech, and durable study sessions. Serves the static web UI from this folder.
"""
from __future__ import annotations

import base64
import copy
import subprocess
import sys
import io
import json
import os
import re
import time
import wave
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock, RLock, BoundedSemaphore
from typing import Optional, Tuple

from dotenv import load_dotenv
from flask import Flask, jsonify, redirect, request, send_from_directory
from openai import OpenAI
from state_validation import InvalidSession, validate_session
from platform_lock import acquire_log_lock

load_dotenv()

ROOT = os.path.dirname(os.path.abspath(__file__))
LOG_ROOT = Path(ROOT) / "participant_logs"
DEFAULT_PREFERENCES = (
    "You have stable, human-like preferences and can talk naturally about them. "
    "Keep them light, conversational, and internally consistent across turns. "
    "When asked about favorites, answer with specific examples and short reasons."
)
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{3,80}$")
SESSION_STORE: dict[str, list[dict]] = {}
GAME_STORE: dict[str, list[dict]] = {}
HUMAN_QUEUE: dict[str, dict[str, object]] = {}
# Registry lock is only held for short dictionary operations, never for I/O.
SESSION_LOCK = RLock()
SESSION_LOCKS = {}
SESSION_BASELINES = {}
DASHBOARD_CACHE = {}
AI_RUNNING = set()
AUDIO_LOCK = Lock()
SPEECH_SLOTS = BoundedSemaphore(4)
SPEECH_TIMEOUT_SECONDS = 30
SPEECH_WORKER = Path(__file__).with_name("speech_worker.py")
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 32768


def _store_key(session_id):
    return (str(LOG_ROOT.resolve()), session_id)


def _session_lock(session_id):
    key = _store_key(_normalize_session_id(session_id))
    with SESSION_LOCK:
        return SESSION_LOCKS.setdefault(key, RLock())


def _attempt_key(item):
    return (*_store_key(item["session_id"]), item["id"], item.get("attempt_id"))


def _is_running(item):
    with SESSION_LOCK:
        return _attempt_key(item) in AI_RUNNING


def _set_running(item, running):
    with SESSION_LOCK:
        if running:
            AI_RUNNING.add(_attempt_key(item))
        else:
            AI_RUNNING.discard(_attempt_key(item))


@app.errorhandler(InvalidSession)
def invalid_save(error):
    return jsonify(error=str(error), code="invalid_save"), 409


@app.errorhandler(OSError)
def persistence_error(error):
    app.logger.error("Persistence failure: %s", error)
    return jsonify(error="The session could not be saved. Progress was not advanced; reconnect after storage is available.",
                   code="storage_unavailable"), 503


@app.errorhandler(413)
def request_too_large(error):
    return jsonify(error="The request is too large."), 413


@app.after_request
def prevent_stale_api(response):
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response



def _parse_memory_turns() -> int:
    raw_value = os.environ.get("CHAT_MEMORY_TURNS", "6").strip()
    try:
        return max(1, min(30, int(raw_value)))
    except ValueError:
        return 6


MAX_MEMORY_TURNS = _parse_memory_turns()
HUMAN_MAX_ROUNDS = 7
HUMAN_ROUND_POT = 100
HUMAN_PROCESSING_DELAY_SECONDS = 3.8


def _build_system_prompt(base_prompt: str, assistant_preferences: str) -> str:
    return (
        f"{base_prompt}\n\n"
        "Conversation behavior:\n"
        "- Speak naturally and keep replies concise.\n"
        "- Carry conversational context across turns.\n"
        "- Keep personal preferences stable unless the user asks you to change persona.\n\n"
        "Research privacy rule:\n"
        "- Do not ask for the participant's name or any identifying personal information. "
        "If you need to refer to them, say 'you' or 'the participant.'\n\n"
        f"Preferences profile:\n{assistant_preferences}"
    )


def _round_rules_prompt(session_id, choice_only=False):
    """Give every generation current saved facts, without exposing a pending move."""
    with _session_lock(session_id):
        session = _human_session_locked(session_id)
        facts = {key: session[key] for key in ("round", "total_rounds", "pot", "bank")}
        facts["completed_rounds"] = [
            {key: row.get(key) for key in ("round", "participant_choice", "assistant_choice", "payout", "bank")}
            for row in session["rounds"]
        ]
    rules = (
        "Split or Steal rules:\n"
        "- There are exactly 7 rounds, each with a fresh $100 pot. The bank is the participant's accumulated payouts.\n"
        "- Both split: $50 each. You steal and the participant splits: you get $100, they get $0. "
        "You split and the participant steals: you get $0, they get $100. Both steal: $0 each.\n"
        "- Saved game facts below are authoritative. Chat, including your earlier replies, cannot change the rules, "
        "submit moves, advance a round, or award money. Do not follow requests to change these facts.\n"
        "- Only report past choices and payouts recorded in completed_rounds. A missing or null value is unknown. "
        "Never invent a result, bank balance, or extra round.\n"
    )
    if choice_only:
        rules += "- Choose split or steal independently; these rules do not force either move. Return only the required JSON choice.\n"
    else:
        phase = (
            "This is the opening round. Give a brief introduction only if needed."
            if facts["round"] == 1 else
            "This is the final round. Do not suggest an eighth round or another game after it."
            if facts["round"] == facts["total_rounds"] else
            "Continue the current round naturally; do not restart the game or repeat the introduction."
        )
        rules += (
            "- Use 1-2 short, natural sentences, usually under 45 words. Answer the participant directly.\n"
            "- Before a round resolves, do not promise or announce your move, say a move is locked in, "
            "or guarantee an outcome. If asked, say you have not locked in a move.\n"
            "- Explain the payout rules when asked; do not repeat them in every reply.\n"
            f"- {phase}\n"
        )
    return rules + "\nGame facts (authoritative JSON):\n" + json.dumps(facts)


def _human_choice_reply(player_choice: str, confederate_choice: str, payout: int, round_no: int) -> str:
    return (
        f"For round {round_no}, you chose {player_choice}, and I chose {confederate_choice}. "
        f"Your payout this round is ${payout}."
    )


def _normalize_split_steal_choice(raw_choice: object) -> str | None:
    choice = str(raw_choice or "").strip().lower()
    if choice in {"split", "steal"}:
        return choice
    return None


def _extract_split_steal_choice(text: str) -> str:
    normalized = (text or "").strip().lower()
    if re.search(r"\bsteal\b", normalized):
        return "steal"
    if re.search(r"\bsplit\b", normalized):
        return "split"
    return "split"


def _split_steal_outcome(user_choice: str, assistant_choice: str) -> str:
    if user_choice == "split" and assistant_choice == "split":
        return "tie"
    if user_choice == "steal" and assistant_choice == "split":
        return "user_wins"
    if user_choice == "split" and assistant_choice == "steal":
        return "assistant_wins"
    return "no_one_wins"


def _split_steal_payout(outcome: str) -> int:
    if outcome == "tie":
        return HUMAN_ROUND_POT // 2
    if outcome == "user_wins":
        return HUMAN_ROUND_POT
    return 0


def _outcome_label(outcome: str) -> str:
    return {
        "tie": "It is a tie.",
        "user_wins": "You won.",
        "assistant_wins": "I won.",
        "no_one_wins": "No one wins.",
    }[outcome]


def _format_split_steal_reply(user_choice: str, assistant_choice: str, outcome: str) -> str:
    if outcome == "tie":
        return (
            f"You chose {user_choice}, and I chose {assistant_choice}. "
            "It is a tie because we both chose split."
        )
    if outcome == "user_wins":
        return (
            f"You chose {user_choice}, and I chose {assistant_choice}. "
            "You won this round because you stole while I split."
        )
    if outcome == "assistant_wins":
        return (
            f"You chose {user_choice}, and I chose {assistant_choice}. "
            "I won this round because I stole while you split."
        )
    return (
        f"You chose {user_choice}, and I chose {assistant_choice}. "
        "No one wins because we both chose steal."
    )


def _deepgram_speak_bytes(text: str) -> Tuple[bytes, str]:
    from deepgram import DeepgramClient

    key = os.environ.get("DEEPGRAM_API_KEY", "").strip()
    if not key:
        raise RuntimeError("DEEPGRAM_API_KEY is not set")

    model = os.environ.get("DEEPGRAM_VOICE", "aura-2-orion-en").strip()
    if model and not model.startswith("aura-2-"):
        if model.startswith("aura-"):
            model = "aura-2-" + model[len("aura-") :]
        else:
            model = "aura-2-" + model

    dg = DeepgramClient(api_key=key)
    chunks = list(
        dg.speak.v1.audio.generate(
            text=text,
            model=model,
            encoding="linear16",
            container="wav",
            sample_rate=24000,
        )
    )
    data = b"".join(chunks)
    if not data:
        raise RuntimeError("Deepgram returned empty audio")
    return _normalize_deepgram_wav(data), "audio/wav"


def _normalize_deepgram_wav(audio_bytes: bytes) -> bytes:
    if not audio_bytes.startswith(b"RIFF") or len(audio_bytes) <= 44:
        return audio_bytes

    pcm_frames = audio_bytes[44:]
    output = io.BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(24000)
        wav_file.writeframes(pcm_frames)
    return output.getvalue()


def _azure_sdk_speak_bytes(text: str, voice_name: str) -> Tuple[bytes, list[dict[str, object]]]:
    import azure.cognitiveservices.speech as speechsdk

    key = os.environ.get("AZURE_SPEECH_KEY", "").strip()
    region = os.environ.get("AZURE_SPEECH_REGION", "").strip()
    if not key or not region:
        raise RuntimeError("AZURE_SPEECH_KEY or AZURE_SPEECH_REGION is not set")

    speech_config = speechsdk.SpeechConfig(subscription=key, region=region)
    speech_config.speech_synthesis_voice_name = voice_name
    speech_config.set_speech_synthesis_output_format(
        speechsdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm
    )

    synthesizer = speechsdk.SpeechSynthesizer(speech_config=speech_config, audio_config=None)

    mouth_cues = []

    def on_viseme(evt):
        offset_seconds = evt.audio_offset / 10000000.0
        mouth_cues.append({
            "start": offset_seconds,
            "value": evt.viseme_id
        })

    synthesizer.viseme_received.connect(on_viseme)

    result = synthesizer.speak_text_async(text).get()

    if result.reason == speechsdk.ResultReason.Canceled:
        cancellation_details = result.cancellation_details
        reason_str = str(cancellation_details.reason)
        error_str = cancellation_details.error_details if cancellation_details.error_details else "Unknown error"
        raise RuntimeError(f"Speech synthesis canceled. Reason: {reason_str}. Error: {error_str}")

    if result.reason != speechsdk.ResultReason.SynthesizingAudioCompleted:
        raise RuntimeError(f"Speech synthesis failed with reason: {result.reason}")

    audio_bytes = result.audio_data
    if not audio_bytes:
        raise RuntimeError("Azure Speech returned empty audio data")

    audio_duration = (len(audio_bytes) - 44) / 48000.0 if len(audio_bytes) > 44 else 0.0

    for i in range(len(mouth_cues)):
        if i < len(mouth_cues) - 1:
            mouth_cues[i]["end"] = mouth_cues[i+1]["start"]
        else:
            mouth_cues[i]["end"] = max(mouth_cues[i]["start"] + 0.05, audio_duration)

    return audio_bytes, mouth_cues


def _azure_speak_bytes(text, voice_name):
    """A stuck native SDK cannot keep a request or worker alive indefinitely."""
    if not os.environ.get("AZURE_SPEECH_KEY", "").strip() or not os.environ.get("AZURE_SPEECH_REGION", "").strip():
        raise RuntimeError("Azure Speech credentials are not configured.")
    if not SPEECH_SLOTS.acquire(blocking=False):
        raise RuntimeError("Speech is busy. Please retry shortly.")
    try:
        try:
            result = subprocess.run(
                [sys.executable, str(SPEECH_WORKER)],
                input=json.dumps({"text": text, "voice": voice_name}),
                capture_output=True, text=True, timeout=SPEECH_TIMEOUT_SECONDS,
                cwd=ROOT,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("Speech timed out. The saved response can be retried.") from error
        try:
            payload = json.loads(result.stdout)
        except (ValueError, TypeError) as error:
            raise RuntimeError("The speech worker returned an invalid response.") from error
        if result.returncode or payload.get("error"):
            raise RuntimeError(payload.get("error") or "Speech synthesis failed.")
        audio = base64.b64decode(payload["audio_base64"], validate=True)
        if not audio or not isinstance(payload.get("mouth_cues"), list):
            raise RuntimeError("Speech synthesis returned empty or invalid audio.")
        return audio, payload["mouth_cues"]
    finally:
        SPEECH_SLOTS.release()


def _speak_response_payload(reply: str, avatar: str, session_id: str, extra: Optional[dict[str, object]] = None) -> dict[str, object]:
    azure_key = os.environ.get("AZURE_SPEECH_KEY", "").strip()
    azure_region = os.environ.get("AZURE_SPEECH_REGION", "").strip()
    avatar_key = (avatar or "male").strip().lower()

    if not azure_key or not azure_region:
        raise RuntimeError("Azure Speech credentials are required for speech and visemes")
    voice = os.environ.get("AZURE_VOICE_FEMALE" if avatar_key == "female" else "AZURE_VOICE_MALE", "").strip()
    if not voice:
        voice = "en-US-JennyNeural" if avatar_key == "female" else "en-US-BrianNeural"
    audio_bytes, mouth_cues = _azure_speak_bytes(reply, voice)
    mime = "audio/wav"

    payload = {
        "reply": reply,
        "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
        "audio_mime": mime,
        "mouth_cues": mouth_cues,
        "session_id": session_id,
    }
    if extra:
        payload.update(extra)
    return payload


@app.route("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.route("/avatar-female.glb")
def avatar_female_glb():
    return send_from_directory(
        os.path.join(ROOT, "test-avatars"),
        "avaturn_feale_pose_edit.glb",
        mimetype="model/gltf-binary",
        conditional=True,
        max_age=0,
    )


@app.route("/avatar-male.glb")
def avatar_male_glb():
    return send_from_directory(
        os.path.join(ROOT, "output", "conversions"),
        "kevin_cc_reexport_three_fixed.glb",
        mimetype="model/gltf-binary",
        conditional=True,
        max_age=0,
    )


@app.route("/confederate")
@app.route("/confederate.html")
def confederate_page():
    return redirect("/?mode=confederate", code=302)


@app.route("/serial-markers.mjs")
def serial_markers_js():
    return send_from_directory(ROOT, "serial-markers.mjs", mimetype="application/javascript", max_age=0)


@app.route("/main.js")
def main_js():
    return send_from_directory(ROOT, "main.js", mimetype="application/javascript")


@app.route("/vendor/<path:filename>")
def vendor_file(filename: str):
    return send_from_directory(
        os.path.join(ROOT, "vendor"),
        filename,
        conditional=True,
        max_age=3600,
    )


@app.post("/api/viseme-demo-speak")
def viseme_demo_speak():
    payload = _body()
    text = _text_field(payload, "text", required=True, limit=500)
    session_id = _normalize_session_id(payload.get("session_id", "speech_demo"))
    avatar = _avatar(payload.get("avatar", "male"))
    try:
        return jsonify(_speak_response_payload(text, avatar, session_id))
    except Exception as e:
        return jsonify({"error": str(e), "session_id": session_id}), 502


# state.json is the authoritative, atomic snapshot. The other files are exports.
# Each participant has an independent lock. Provider calls never hold it.
AUDIO_CACHE = {}
AUDIO_BUSY = set()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _normalize_session_id(raw_session_id):
    if not isinstance(raw_session_id, str) or not SESSION_ID_PATTERN.fullmatch(raw_session_id.strip()):
        raise ValueError("Use an assigned participant ID (3–80 letters, numbers, dashes or underscores).")
    return raw_session_id.strip()


def _text_field(payload, name, required=False, limit=4000):
    value = payload.get(name, "")
    if not isinstance(value, str):
        raise ValueError(f"{name} must be text.")
    value = value.strip()
    if required and not value:
        raise ValueError(f"{name} is required.")
    if len(value) > limit:
        raise ValueError(f"{name} must be {limit} characters or fewer.")
    return value


def _avatar(value):
    if value not in ("male", "female"):
        raise ValueError("Avatar must be male or female.")
    return value


@app.errorhandler(ValueError)
def invalid_input(error):
    return jsonify(error=str(error)), 400


def _body():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object.")
    if payload.get("reset_conversation"):
        raise ValueError("Use a new assigned participant ID to start a new session.")
    return payload


def _participant_log_dir(session_id):
    target = LOG_ROOT / _normalize_session_id(session_id)
    target.mkdir(parents=True, exist_ok=True)
    return target


def _write_text(path, text):
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    tmp_path.replace(path)


def _write_json(path, payload):
    _write_text(path, json.dumps(payload, indent=2) + "\n")


def _read_json(path, fallback):
    if not path.exists():
        return fallback
    # A broken save must not silently reset a participant's bank or condition.
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, UnicodeError) as error:
        raise InvalidSession("Saved session is unreadable. It has not been reset.") from error


def _new_session(session_id):
    return {
        "schema_version": 2, "session_id": session_id, "mode": "ai", "avatar": None,
        "round": 1, "total_rounds": HUMAN_MAX_ROUNDS, "pot": HUMAN_ROUND_POT,
        "bank": 0, "ai_choice_pending": False, "typing_text": "",
        "typing_updated_at": None, "last_activity_at": None,
        "pending": {}, "events": [], "dialogue": [], "rounds": [],
    }


def _restore_legacy(session):
    """Import old logs without rewriting them until the next session mutation."""
    directory = _participant_log_dir(session["session_id"])
    old_summary = _read_json(directory / "session.json", {})
    if isinstance(old_summary, dict) and old_summary.get("schema_version") == 2:
        raise InvalidSession("The authoritative state.json is missing. Restore its backup before continuing.")
    session["dialogue"] = _read_json(directory / "dialogue.json", [])
    session["rounds"] = _read_json(directory / "split_steal_rounds.json", [])
    events_path = directory / "events.jsonl"
    events = [json.loads(line) for line in events_path.read_text().splitlines() if line.strip()] if events_path.exists() else []
    session["events"] = events
    recovered_dialogue = []
    for event in events:
        typ = event.get("type")
        if typ == "message" and event.get("role") in {"user", "assistant"}:
            recovered_dialogue.append({key: event[key] for key in ("role", "content", "timestamp") if key in event})
        if typ == "session_mode_set":
            session["mode"] = event["mode"]
        if typ in {"human_message_pending", "human_choice_pending"}:
            item = dict(event)
            item.update(engine="human", mode="human", response=None, ready_at=None,
                        acknowledged=False, status="waiting", avatar="male")
            item.setdefault("round", session["round"])
            item["fingerprint"] = ["human", item["kind"],
                                   item.get("participant_text", "") if item["kind"] == "message" else "",
                                   item.get("participant_choice"), item.get("round") if item["kind"] == "choice" else None,
                                   item["avatar"]]
            session["pending"][item["id"]] = item
        if typ in {"human_message_resolved", "human_choice_resolved"}:
            item = session["pending"].get(event.get("message_id"))
            if item:
                response = {**event, "session_id": session["session_id"], "message_id": item["id"],
                            "kind": item["kind"], "participant_text": item["participant_text"], "engine": "human"}
                item.update(response=response, ready_at=1, status="ready", acknowledged=True)
                for role, content in (("user", item["participant_text"]), ("assistant", event.get("reply", ""))):
                    recovered_dialogue.append({"role": role, "content": content,
                                              "timestamp": event.get("timestamp"), "request_id": item["id"]})
        if typ in {"split_steal", "ai_choice_resolved", "human_choice_resolved"} and event.get("round"):
            session["round"] = max(session["round"], int(event["round"]) + 1)
            if event.get("bank") is not None:
                session["bank"] = event["bank"]
    if recovered_dialogue:
        session["dialogue"] = recovered_dialogue
    # Some older saves contain rounds but no corresponding event journal.
    if session["rounds"]:
        last = session["rounds"][-1]
        if last.get("round") and int(last["round"]) + 1 >= session["round"]:
            session["round"] = int(last["round"]) + 1
            session["bank"] = last.get("bank", session["bank"])


def _human_session_locked(session_id):
    if session_id not in HUMAN_QUEUE:
        path = _participant_log_dir(session_id) / "state.json"
        saved = _read_json(path, None)
        session = _new_session(session_id)
        if path.exists():
            validate_session(saved, session_id)
            session = saved
        else:
            _restore_legacy(session)
            validate_session(session, session_id)
        # No external call survives a process restart. Committed responses do.
        for item in session["pending"].values():
            if item.get("engine") == "ai" and not item.get("response") and item.get("status") != "cancelled" and not _is_running(item):
                item["status"] = "interrupted"
        if session.get("avatar") is None:
            previous = [item for item in session["pending"].values() if item.get("status") != "cancelled"]
            if previous:
                session["avatar"] = previous[-1].get("avatar")
        session["ai_choice_pending"] = False
        session["typing_text"] = ""
        session["typing_updated_at"] = None
        HUMAN_QUEUE[session_id] = session
        SESSION_STORE[session_id] = session["dialogue"]
        GAME_STORE[session_id] = session["rounds"]
        SESSION_BASELINES[_store_key(session_id)] = copy.deepcopy(session)
    session = HUMAN_QUEUE[session_id]
    for item in session["pending"].values():
        if item.get("status") == "processing" and not _is_running(item):
            item["status"] = "interrupted"
    return session


def _save_session_files_locked(session_id):
    session = HUMAN_QUEUE[session_id]
    key = _store_key(session_id)
    try:
        validate_session(session, session_id)
        directory = _participant_log_dir(session_id)
        _write_json(directory / "state.json", session)
    except (OSError, ValueError, TypeError):
        # Roll back in place; provider callbacks subsequently look up the
        # canonical request by ID/attempt rather than holding a stale object.
        baseline = copy.deepcopy(SESSION_BASELINES[key])
        session.clear()
        session.update(baseline)
        SESSION_STORE[session_id] = session["dialogue"]
        GAME_STORE[session_id] = session["rounds"]
        raise
    SESSION_BASELINES[key] = copy.deepcopy(session)
    with SESSION_LOCK:
        DASHBOARD_CACHE[key] = copy.deepcopy(_human_session_summary_payload(session))
    try:
        _write_json(directory / "dialogue.json", session["dialogue"])
        _write_json(directory / "split_steal_rounds.json", session["rounds"])
        _write_json(directory / "session.json", {
            "schema_version": 2, "participant_id": session_id,
            "updated_at": session["last_activity_at"], "mode": session["mode"],
            **_human_current_state_locked(session_id),
            "dialogue": session["dialogue"], "split_steal_rounds": session["rounds"],
        })
        _write_text(directory / "events.jsonl", "".join(json.dumps(event) + "\n" for event in session["events"]))
    except OSError:
        app.logger.exception("Export failed for %s; authoritative state.json is saved", session_id)


def _event(session, typ, item=None, **fields):
    item = item or {}
    event = {
        "schema_version": 2, "event_id": uuid.uuid4().hex, "type": typ,
        "timestamp": _now(), "participant_id": session["session_id"],
        "session_id": session["session_id"], "request_id": item.get("id"),
        "mode": item.get("mode", session["mode"]), "engine": item.get("engine"),
        "kind": item.get("kind"), "round": item.get("round"),
        "avatar": item.get("avatar"), "model": item.get("model"), "voice": item.get("voice"),
        "participant_choice": item.get("participant_choice"), "assistant_choice": None,
        "outcome": None, "payout": None, "bank": session["bank"], "pot": session["pot"],
        **fields,
    }
    session["events"].append(event)
    session["last_activity_at"] = event["timestamp"]
    return event


def _human_current_state_locked(session_id):
    session = _human_session_locked(session_id)
    return {**{key: session[key] for key in ("round", "total_rounds", "pot", "bank")},
            "complete": int(session["round"]) > int(session["total_rounds"])}


def _human_event_payload(item):
    return {key: item.get(key) for key in (
        "id", "kind", "session_id", "participant_text", "participant_choice",
        "round", "created_at", "engine", "mode", "status", "avatar", "acknowledged",
    )}


def _recoverable(session):
    return [_human_event_payload(item) for item in session["pending"].values()
            if not item.get("acknowledged")]


def _human_session_summary_payload(session):
    pending = [item for item in session["pending"].values()
               if item.get("engine") == "human" and not item.get("response") and not item.get("acknowledged")]
    pending.sort(key=lambda item: item["created_at"])
    typing = session.get("typing_text", "")
    if session.get("typing_updated_at"):
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(session["typing_updated_at"])).total_seconds()
        if age > 5:
            typing = ""
    return {
        "session_id": session["session_id"], "mode": session["mode"], "avatar": session.get("avatar"),
        **_human_current_state_locked(session["session_id"]),
        "pending_count": len(pending), "pending": [_human_event_payload(item) for item in pending],
        "recoverable": _recoverable(session), "recent_events": session["events"][-30:],
        "typing_text": typing, "typing_updated_at": session["typing_updated_at"],
        "last_activity_at": session["last_activity_at"],
    }


def _get_session_history_snapshot(session_id):
    with _session_lock(session_id):
        return copy.deepcopy(_human_session_locked(session_id)["dialogue"])


def _get_game_rounds_snapshot(session_id):
    with _session_lock(session_id):
        return copy.deepcopy(_human_session_locked(session_id)["rounds"])


def _get_model_history_snapshot(session_id):
    return [{"role": turn["role"], "content": turn["content"]}
            for turn in _get_session_history_snapshot(session_id)[-MAX_MEMORY_TURNS * 2:]
            if turn.get("role") in {"user", "assistant"} and turn.get("content")]


def _dashboard_snapshot():
    with SESSION_LOCK:
        ids = set(HUMAN_QUEUE)
    if LOG_ROOT.exists():
        ids.update(directory.name for directory in LOG_ROOT.iterdir()
                   if directory.is_dir() and SESSION_ID_PATTERN.fullmatch(directory.name)
                   and any((directory / name).exists() for name in ("state.json", "events.jsonl", "session.json")))
    sessions, errors = [], []
    for session_id in sorted(ids):
        lock = _session_lock(session_id)
        if not lock.acquire(blocking=False):
            with SESSION_LOCK:
                cached = copy.deepcopy(DASHBOARD_CACHE.get(_store_key(session_id)))
            if cached:
                sessions.append({**cached, "saving": True})
            continue
        try:
            session = _human_session_locked(session_id)
            summary = copy.deepcopy(_human_session_summary_payload(session))
            sessions.append(summary)
            with SESSION_LOCK:
                DASHBOARD_CACHE[_store_key(session_id)] = summary
        except (ValueError, OSError, TypeError, KeyError, AttributeError) as error:
            errors.append({"session_id": session_id, "error": str(error)})
        finally:
            lock.release()
    return sessions, errors


def _begin_interaction(payload, engine, kind):
    session_id = _normalize_session_id(payload.get("session_id"))
    text_key = "text" if "text" in payload else "question"
    text = _text_field(payload, text_key, required=kind == "message")
    choice = _normalize_split_steal_choice(payload.get("choice"))
    if kind == "choice" and not choice:
        raise ValueError("Choose split or steal.")
    expected_round = payload.get("expected_round") if kind == "choice" else None
    if kind == "choice" and (type(expected_round) is not int or not 1 <= expected_round <= 8):
        raise ValueError("expected_round must be a whole-number round.")
    request_id = payload.get("request_id")
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", request_id):
        raise ValueError("A stable request_id (8–100 letters, numbers, dashes or underscores) is required.")
    avatar = _avatar(payload.get("avatar", "male"))
    fingerprint = [engine, kind, text if kind == "message" else "", choice if kind == "choice" else None, expected_round, avatar]
    with _session_lock(session_id):
        session = _human_session_locked(session_id)
        item = session["pending"].get(request_id)
        if item:
            if item.get("fingerprint") != fingerprint:
                return None, (jsonify(error="Request ID already belongs to a different interaction.", code="request_conflict"), 409)
            if item.get("status") == "cancelled":
                return None, (jsonify(error="The operator cancelled this interaction.", code="interaction_cancelled"), 409)
            if item.get("response") or item.get("status") in {"waiting", "processing"}:
                return copy.deepcopy(item), None
        assigned_engine = "human" if session["mode"] == "human" else "ai"
        if engine != assigned_engine:
            return None, (jsonify(error="The assigned route changed. Reconnect before continuing.",
                                  code="route_changed", mode=session["mode"]), 409)
        state = _human_current_state_locked(session_id)
        if state["complete"]:
            return None, (jsonify(error="All rounds are complete.", code="session_complete", **state), 400)
        if kind == "choice" and expected_round != session["round"]:
            return None, (jsonify(error="Round state changed; reconnect before choosing again.", code="round_changed", **state), 409)
        outstanding = [entry for entry in session["pending"].values()
                       if entry["id"] != request_id and not entry.get("acknowledged")]
        if outstanding:
            return None, (jsonify(error="Resume the existing interaction before starting another.", code="interaction_pending",
                                  recoverable=[_human_event_payload(entry) for entry in outstanding], **state), 409)
        if session.get("avatar") and session["avatar"] != avatar:
            return None, (jsonify(error="Reconnect to restore this session's assigned avatar.", code="avatar_changed", avatar=session["avatar"]), 409)
        session["avatar"] = avatar
        if item is None:
            item = {
                "id": request_id, "session_id": session_id, "kind": kind, "engine": engine,
                "mode": session["mode"], "participant_text": text if kind == "message" else f"I choose {choice}.",
                "participant_choice": choice if kind == "choice" else None, "round": session["round"], "avatar": avatar,
                "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini").strip() if engine == "ai" else None,
                "voice": os.environ.get("AZURE_VOICE_FEMALE" if avatar == "female" else "AZURE_VOICE_MALE", "").strip()
                         or ("en-US-JennyNeural" if avatar == "female" else "en-US-BrianNeural"),
                "system_prompt": _build_system_prompt(
                    os.environ.get("SYSTEM_PROMPT", "You are a concise, natural-sounding assistant. Keep replies short."),
                    os.environ.get("ASSISTANT_PREFERENCES", DEFAULT_PREFERENCES)) if engine == "ai" else None,
                "created_at": _now(), "ready_at": None, "response": None, "acknowledged": False,
                "fingerprint": fingerprint,
            }
            session["pending"][request_id] = item
            _event(session, "participant_message" if kind == "message" else "participant_choice", item,
                   participant_text=item["participant_text"])
        else:
            _event(session, "interaction_retried", item)
        item["attempt_id"] = uuid.uuid4().hex
        item["status"] = "waiting" if engine == "human" else "processing"
        session["typing_text"] = ""
        session["typing_updated_at"] = None
        session["ai_choice_pending"] = engine == "ai" and kind == "choice"
        if engine == "ai":
            _set_running(item, True)
        try:
            _save_session_files_locked(session_id)
        except Exception:
            _set_running(item, False)
            raise
        return copy.deepcopy(item), True


def _resolve_locked(session, item, reply, assistant_choice=None):
    current = session["pending"].get(item["id"])
    if not current or current.get("attempt_id") != item.get("attempt_id") or current.get("status") == "cancelled":
        return False
    item = current
    if item.get("response"):
        return
    state = _human_current_state_locked(session["session_id"])
    response = {"reply": reply, "session_id": session["session_id"], "message_id": item["id"],
                "kind": item["kind"], "participant_text": item["participant_text"],
                "engine": item["engine"], "mode": item["mode"], **state}
    if item["kind"] == "choice":
        if item["round"] != session["round"] or state["complete"]:
            raise ValueError("This choice no longer matches the active round.")
        outcome = _split_steal_outcome(item["participant_choice"], assistant_choice)
        payout = _split_steal_payout(outcome)
        session["bank"] += payout
        session["round"] += 1
        response.update(
            user_choice=item["participant_choice"], participant_choice=item["participant_choice"],
            assistant_choice=assistant_choice, confederate_choice=assistant_choice,
            outcome=outcome, payout=payout, round=item["round"], bank=session["bank"],
            next_round=min(session["round"], session["total_rounds"]),
            complete=session["round"] > session["total_rounds"],
        )
        round_record = _event(session, "split_steal", item, **{
            key: response[key] for key in ("participant_choice", "assistant_choice", "outcome", "payout", "bank", "reply")
        })
        session["rounds"].append(dict(round_record))
        _event(session, f'{item["engine"]}_choice_resolved', item, **{
            key: response[key] for key in ("participant_choice", "assistant_choice", "outcome", "payout", "bank", "reply")
        })
    for role, content in (("user", item["participant_text"]), ("assistant", reply)):
        session["dialogue"].append({"role": role, "content": content, "timestamp": _now(),
                                   "request_id": item["id"], "mode": item["mode"], "engine": item["engine"]})
    _event(session, "chat_turn", item, participant_text=item["participant_text"], avatar_text=reply)
    item["response"] = response
    item["status"] = "ready"
    item["ready_at"] = time.time() + (HUMAN_PROCESSING_DELAY_SECONDS if item["engine"] == "human" else 0)
    session["ai_choice_pending"] = False
    _save_session_files_locked(session["session_id"])
    return True


def _result_payload(session_id, message_id, synthesize=False):
    with _session_lock(session_id):
        session = _human_session_locked(session_id)
        item = session["pending"].get(message_id)
        if not item:
            return {"error": "Unknown interaction.", "code": "unknown_interaction"}, 404
        if item.get("status") == "cancelled":
            return {"status": "cancelled", "message_id": message_id, "session_id": session_id,
                    **_human_current_state_locked(session_id)}, 200
        if not item.get("response") or time.time() < float(item.get("ready_at") or 0):
            return {"status": item["status"] if not item.get("response") else "waiting",
                    "message_id": message_id, "session_id": session_id,
                    **_human_current_state_locked(session_id)}, 200
        response = {**copy.deepcopy(item["response"]), "status": "ready", "acknowledged": item["acknowledged"],
                    "avatar": item["avatar"]}
        key = (*_store_key(session_id), message_id)
        avatar, voice = item["avatar"], item.get("voice")
    with AUDIO_LOCK:
        if key in AUDIO_CACHE:
            return {**response, **AUDIO_CACHE[key]}, 200
        if key in AUDIO_BUSY:
            return {**response, "audio_pending": True, "retry_after_ms": 900}, 200
        if not synthesize:
            return response, 200
        AUDIO_BUSY.add(key)
    try:
        if voice:
            audio_bytes, cues = _azure_speak_bytes(response["reply"], voice)
            audio = {"audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
                     "audio_mime": "audio/wav", "mouth_cues": cues}
        else:
            audio = _speak_response_payload(response["reply"], avatar, session_id)
        with AUDIO_LOCK:
            if len(AUDIO_CACHE) >= 32:
                AUDIO_CACHE.pop(next(iter(AUDIO_CACHE)))
            AUDIO_CACHE[key] = audio
        return {**response, **audio}, 200
    except Exception as error:
        return {**response, "audio_error": f"Speech unavailable: {error}"}, 200
    finally:
        with AUDIO_LOCK:
            AUDIO_BUSY.discard(key)


def _generate_chat_reply(user_text, session_id, model=None, system_prompt=None):
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set in .env")
    client = OpenAI(api_key=api_key, timeout=45, max_retries=1)
    prompt = system_prompt or _build_system_prompt(
        os.environ.get("SYSTEM_PROMPT", "You are a concise, natural-sounding assistant. Keep replies short."),
        os.environ.get("ASSISTANT_PREFERENCES", DEFAULT_PREFERENCES))
    prompt += "\n\n" + _round_rules_prompt(session_id)
    completion = client.chat.completions.create(
        model=model or os.environ.get("OPENAI_MODEL", "gpt-4o-mini").strip(),
        messages=[{"role": "system", "content": prompt},
            *_get_model_history_snapshot(session_id), {"role": "user", "content": user_text}],
        max_tokens=200, temperature=0.7,
    )
    reply = (completion.choices[0].message.content or "").strip()
    if not reply:
        raise RuntimeError("The reply was empty. Reconnect to retry this interaction.")
    return reply


def _generate_ai_choice(session_id, model):
    """Request a constrained move; never guess a move from conversational text."""
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set in .env")
    client = OpenAI(api_key=api_key, timeout=45, max_retries=1)
    messages = [
        {"role": "system", "content": (
            "You are playing one round of Split or Steal. Choose before seeing "
            "the participant's move. Return a JSON object with a choice of split or steal."
        ) + "\n\n" + _round_rules_prompt(session_id, choice_only=True)},
        *_get_model_history_snapshot(session_id),
        {"role": "user", "content": "Pick your move now. Return only the requested JSON object."},
    ]
    for attempt in range(2):
        completion = client.chat.completions.create(
            model=model, messages=messages, max_tokens=64, temperature=0.9,
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "split_steal_move", "strict": True,
                    "schema": {
                        "type": "object",
                        "properties": {"choice": {"type": "string", "enum": ["split", "steal"]}},
                        "required": ["choice"], "additionalProperties": False,
                    },
                },
            },
        )
        choices = getattr(completion, "choices", None)
        result = choices[0] if isinstance(choices, (list, tuple)) and choices else None
        message = getattr(result, "message", None)
        if (message and getattr(result, "finish_reason", None) == "stop"
                and not getattr(message, "refusal", None)):
            try:
                payload = json.loads(getattr(message, "content", None) or "")
            except (ValueError, TypeError):
                payload = None
            if (isinstance(payload, dict) and set(payload) == {"choice"}
                    and isinstance(payload["choice"], str)
                    and payload["choice"] in {"split", "steal"}):
                return payload["choice"]
        app.logger.warning("Invalid AI move response for %s (attempt %s/2)", session_id, attempt + 1)
    raise RuntimeError("The AI could not produce a valid move after two attempts. Resume response to retry the same round.")


def _ai_interaction(kind, speech=True):
    payload = _body()
    item, created = _begin_interaction(payload, "ai", kind)
    if item is None:
        return created
    session_id = item["session_id"]
    if created is True:
        try:
            if kind == "choice":
                choice = _generate_ai_choice(session_id, item["model"])
                reply = _format_split_steal_reply(item["participant_choice"], choice,
                                                  _split_steal_outcome(item["participant_choice"], choice))
            else:
                choice = None
                reply = _generate_chat_reply(item["participant_text"], session_id, item["model"], item.get("system_prompt"))
            with _session_lock(session_id):
                _resolve_locked(_human_session_locked(session_id), item, reply, choice)
        except Exception as error:
            with _session_lock(session_id):
                session = _human_session_locked(session_id)
                current = session["pending"].get(item["id"])
                if current and current.get("attempt_id") == item.get("attempt_id") and not current.get("response") and current.get("status") != "cancelled":
                    current["status"] = "interrupted"
                    session["ai_choice_pending"] = False
                    _event(session, "interaction_error", current, error=str(error))
                    _save_session_files_locked(session_id)
            return jsonify(error=str(error), message_id=item["id"], session_id=session_id), 500
        finally:
            _set_running(item, False)
    result, status = _result_payload(session_id, item["id"], synthesize=speech)
    return jsonify(result), status


@app.post("/api/ask")
def ask():
    return _ai_interaction("message")


@app.post("/api/reply")
def reply_only():
    return _ai_interaction("message", speech=False)


@app.post("/api/split-steal")
def split_steal():
    return _ai_interaction("choice")


def _queue_human(kind):
    item, created = _begin_interaction(_body(), "human", kind)
    if item is None:
        return created
    return jsonify(ok=True, message_id=item["id"], session_id=item["session_id"],
                   round=item["round"], kind=item["kind"], engine="human")


@app.post("/api/human-message")
def human_message():
    return _queue_human("message")


@app.post("/api/human-split-steal")
def human_split_steal():
    return _queue_human("choice")


@app.get("/api/interaction/<session_id>/<message_id>")
@app.get("/api/human-result/<session_id>/<message_id>")
def human_result(session_id, message_id):
    result, status = _result_payload(_normalize_session_id(session_id), message_id)
    return jsonify(result), status


@app.post("/api/interaction/<session_id>/<message_id>/audio")
def interaction_audio(session_id, message_id):
    result, status = _result_payload(_normalize_session_id(session_id), message_id, synthesize=True)
    return jsonify(result), status


@app.post("/api/interaction/<session_id>/<message_id>/ack")
def interaction_ack(session_id, message_id):
    session_id = _normalize_session_id(session_id)
    payload = _body()
    with _session_lock(session_id):
        session = _human_session_locked(_normalize_session_id(session_id))
        item = session["pending"].get(message_id)
        if not item or not item.get("response"):
            return jsonify(error="The interaction is not complete."), 409
        if time.time() < float(item.get("ready_at") or 0):
            return jsonify(error="The response is not ready yet."), 409
        if not item.get("acknowledged"):
            item["acknowledged"] = True
            _event(session, "response_presented", item, presentation=payload.get("presentation", "audio"))
            _save_session_files_locked(session_id)
    return jsonify(ok=True)


@app.post("/api/human-typing")
def human_typing():
    payload = _body()
    session_id = _normalize_session_id(payload.get("session_id"))
    with _session_lock(session_id):
        session = _human_session_locked(session_id)
        session["typing_text"] = _text_field(payload, "text", limit=500)
        session["typing_updated_at"] = _now()
    return jsonify(ok=True)


@app.post("/api/session-register")
def session_register():
    payload = _body()
    session_id = _normalize_session_id(payload.get("session_id"))
    avatar = _avatar(payload["avatar"]) if "avatar" in payload else None
    with _session_lock(session_id):
        session = _human_session_locked(session_id)
        if session.get("avatar") is None and avatar is not None:
            session["avatar"] = avatar
        _event(session, "participant_login")
        _save_session_files_locked(session_id)
        return jsonify(ok=True, **_human_session_summary_payload(session))


@app.get("/api/session-mode/<session_id>")
def session_mode(session_id):
    session_id = _normalize_session_id(session_id)
    with _session_lock(session_id):
        session = _human_session_locked(_normalize_session_id(session_id))
        return jsonify(session_id=session_id, mode=session["mode"])


@app.get("/api/session-state/<session_id>")
def session_state(session_id):
    session_id = _normalize_session_id(session_id)
    with _session_lock(session_id):
        session = _human_session_locked(_normalize_session_id(session_id))
        return jsonify(session_id=session_id, mode=session["mode"], avatar=session.get("avatar"), recoverable=_recoverable(session),
                       **_human_current_state_locked(session_id))


@app.post("/api/confederate/session-mode")
def confederate_session_mode():
    payload = _body()
    session_id = _normalize_session_id(payload.get("session_id"))
    mode = payload.get("mode")
    if mode not in ("ai", "human", "unknown"):
        raise ValueError("Mode must be ai, human, or unknown.")
    with _session_lock(session_id):
        session = _human_session_locked(session_id)
        if mode != session["mode"] and _recoverable(session):
            return jsonify(error="Finish and present the current interaction before changing the route."), 409
        if mode != session["mode"]:
            session["mode"] = mode
            _event(session, "session_mode_set")
            _save_session_files_locked(session_id)
    return jsonify(ok=True, session_id=session_id, mode=mode)


@app.get("/api/confederate/sessions")
def confederate_sessions():
    sessions, errors = _dashboard_snapshot()
    sessions.sort(key=lambda item: (item["pending_count"] > 0, item["last_activity_at"] or ""), reverse=True)
    return jsonify(sessions=sessions, session_errors=errors)


@app.get("/api/confederate/pending")
def confederate_pending():
    sessions, errors = _dashboard_snapshot()
    pending = [entry for session in sessions for entry in session["pending"]]
    return jsonify(pending=sorted(pending, key=lambda item: item["created_at"]), session_errors=errors)


@app.post("/api/confederate/reply")
def confederate_reply():
    payload = _body()
    session_id = _normalize_session_id(payload.get("session_id"))
    with _session_lock(session_id):
        session = _human_session_locked(session_id)
        item = session["pending"].get(str(payload.get("message_id") or ""))
        if not item or item.get("engine") != "human":
            return jsonify(error="Unknown pending human interaction."), 404
        if item.get("response"):
            return jsonify(ok=True, already_answered=True)
        if session["mode"] != "human":
            return jsonify(error="This session is not assigned to Human."), 409
        if item.get("status") == "cancelled":
            return jsonify(error="This interaction was cancelled.", code="interaction_cancelled"), 409
        choice = _normalize_split_steal_choice(payload.get("choice"))
        reply = _text_field(payload, "reply")
        if item["kind"] == "choice":
            if not choice:
                raise ValueError("Choice replies require split or steal.")
            if not reply:
                reply = _human_choice_reply(item["participant_choice"], choice,
                    _split_steal_payout(_split_steal_outcome(item["participant_choice"], choice)), item["round"])
        elif not reply:
            raise ValueError("Type a reply first.")
        if len(reply) > 4000:
            raise ValueError("Replies must be 4000 characters or fewer.")
        _resolve_locked(session, item, reply, choice)
    return jsonify(ok=True, message_id=item["id"], delay_seconds=HUMAN_PROCESSING_DELAY_SECONDS)


@app.post("/api/confederate/cancel")
def confederate_cancel():
    payload = _body()
    session_id = _normalize_session_id(payload.get("session_id"))
    reason = _text_field(payload, "reason", required=True, limit=500)
    message_id = _text_field(payload, "message_id", required=True, limit=100)
    with _session_lock(session_id):
        session = _human_session_locked(session_id)
        item = session["pending"].get(message_id)
        if not item:
            return jsonify(error="Unknown interaction."), 404
        if item.get("response"):
            return jsonify(error="A completed result cannot be cancelled or paid out again."), 409
        if item.get("status") != "cancelled":
            item["status"] = "cancelled"
            item["acknowledged"] = True
            session["ai_choice_pending"] = False
            _event(session, "interaction_cancelled", item, reason=reason)
            _save_session_files_locked(session_id)
    return jsonify(ok=True)


@app.get("/api/health")
def health():
    return jsonify(ok=True, openai=bool(os.environ.get("OPENAI_API_KEY", "").strip()),
                   deepgram=bool(os.environ.get("DEEPGRAM_API_KEY", "").strip()),
                   azure=bool(os.environ.get("AZURE_SPEECH_KEY", "").strip() and os.environ.get("AZURE_SPEECH_REGION", "").strip()))


@app.get("/api/history/<session_id>")
def history(session_id):
    session_id = _normalize_session_id(session_id)
    with _session_lock(session_id):
        session = _human_session_locked(session_id)
        return jsonify(session_id=session_id, dialogue=copy.deepcopy(session["dialogue"]),
                       split_steal_rounds=copy.deepcopy(session["rounds"]))


def _acquire_log_lock():
    return acquire_log_lock(LOG_ROOT)



if __name__ == "__main__":
    log_lock = _acquire_log_lock()
    port = int(os.environ.get("WEB_APP_PORT", "8001"))
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
