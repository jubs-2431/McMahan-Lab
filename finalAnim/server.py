"""
Lightweight API for OpenAI chat + Deepgram TTS. Serves the static web UI from this folder.
"""
from __future__ import annotations

import base64
import io
import json
import os
import re
import time
import wave
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Optional, Tuple

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from openai import OpenAI

load_dotenv()

ROOT = os.path.dirname(os.path.abspath(__file__))
LOG_ROOT = Path(ROOT) / "participant_logs"
DEFAULT_PREFERENCES = (
    "You have stable, human-like preferences and can talk naturally about them. "
    "Keep them light, conversational, and internally consistent across turns. "
    "When asked about favorites, answer with specific examples and short reasons."
)
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{3,80}$")
SESSION_STORE: dict[str, deque[dict[str, str]]] = {}
GAME_STORE: dict[str, deque[dict[str, str]]] = {}
HUMAN_QUEUE: dict[str, dict[str, object]] = {}
SESSION_LOCK = Lock()
app = Flask(__name__)


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


def _normalize_session_id(raw_session_id: object) -> str:
    candidate = str(raw_session_id or "").strip()
    if SESSION_ID_PATTERN.fullmatch(candidate):
        return candidate
    return f"chat_{uuid.uuid4().hex[:16]}"


def _participant_log_dir(session_id: str) -> Path:
    safe_id = _normalize_session_id(session_id)
    target = LOG_ROOT / safe_id
    target.mkdir(parents=True, exist_ok=True)
    return target


def _write_json(path: Path, payload: object) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(path)


def _append_jsonl(path: Path, payload: object) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, separators=(",", ":")) + "\n")


def _read_json(path: Path, fallback: object) -> object:
    try:
        if not path.exists():
            return fallback
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def _save_session_files_locked(session_id: str) -> None:
    log_dir = _participant_log_dir(session_id)
    dialogue = list(SESSION_STORE.get(session_id, []))
    rounds = list(GAME_STORE.get(session_id, []))
    session_payload = {
        "participant_id": session_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "dialogue": dialogue,
        "split_steal_rounds": rounds,
    }
    _write_json(log_dir / "dialogue.json", dialogue)
    _write_json(log_dir / "split_steal_rounds.json", rounds)
    _write_json(log_dir / "session.json", session_payload)


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


def _get_session_history_snapshot(session_id: str) -> list[dict[str, str]]:
    with SESSION_LOCK:
        history = SESSION_STORE.get(session_id)
        if history is None:
            log_dir = _participant_log_dir(session_id)
            saved_history = _read_json(log_dir / "dialogue.json", [])
            if not isinstance(saved_history, list):
                saved_history = []
            history = deque(saved_history[-MAX_MEMORY_TURNS * 2 :], maxlen=MAX_MEMORY_TURNS * 2)
            SESSION_STORE[session_id] = history
        return list(history)


def _get_game_rounds_snapshot(session_id: str) -> list[dict[str, str]]:
    with SESSION_LOCK:
        rounds = GAME_STORE.get(session_id)
        if rounds is None:
            log_dir = _participant_log_dir(session_id)
            saved_rounds = _read_json(log_dir / "split_steal_rounds.json", [])
            if not isinstance(saved_rounds, list):
                saved_rounds = []
            rounds = deque(saved_rounds[-50:], maxlen=50)
            GAME_STORE[session_id] = rounds
        return list(rounds)


def _get_model_history_snapshot(session_id: str) -> list[dict[str, str]]:
    return [
        {"role": turn["role"], "content": turn["content"]}
        for turn in _get_session_history_snapshot(session_id)
        if turn.get("role") in {"user", "assistant"} and turn.get("content")
    ]


def _append_session_turn(session_id: str, question: str, answer: str) -> None:
    with SESSION_LOCK:
        history = SESSION_STORE.setdefault(session_id, deque(maxlen=MAX_MEMORY_TURNS * 2))
        timestamp = datetime.now(timezone.utc).isoformat()
        user_turn = {"role": "user", "content": question, "timestamp": timestamp}
        assistant_turn = {"role": "assistant", "content": answer, "timestamp": timestamp}
        history.append(user_turn)
        history.append(assistant_turn)
        human_session = _human_session_locked(session_id)
        human_session["last_activity_at"] = timestamp
        human_session["events"].append(
            {
                "type": "chat_turn",
                "participant_text": question,
                "avatar_text": answer,
                "mode": human_session.get("mode") or "ai",
                "timestamp": timestamp,
            }
        )
        log_dir = _participant_log_dir(session_id)
        _append_jsonl(log_dir / "events.jsonl", {"type": "message", **user_turn})
        _append_jsonl(log_dir / "events.jsonl", {"type": "message", **assistant_turn})
        _save_session_files_locked(session_id)


def _append_game_round(
    session_id: str,
    user_choice: str,
    assistant_choice: str,
    outcome: str,
    reply: str,
    round_no: int,
    payout: int,
    bank: int,
    pot: int,
) -> None:
    with SESSION_LOCK:
        rounds = GAME_STORE.setdefault(session_id, deque(maxlen=50))
        timestamp = datetime.now(timezone.utc).isoformat()
        rounds.append(
            {
                "timestamp": timestamp,
                "user_choice": user_choice,
                "assistant_choice": assistant_choice,
                "outcome": outcome,
                "reply": reply,
                "round": round_no,
                "payout": payout,
                "bank": bank,
                "pot": pot,
            }
        )
        log_dir = _participant_log_dir(session_id)
        _append_jsonl(
            log_dir / "events.jsonl",
            {
                "type": "split_steal",
                "timestamp": timestamp,
                "user_choice": user_choice,
                "assistant_choice": assistant_choice,
                "outcome": outcome,
                "reply": reply,
                "round": round_no,
                "payout": payout,
                "bank": bank,
                "pot": pot,
            },
        )
        _save_session_files_locked(session_id)


def _clear_session_history(session_id: str) -> None:
    with SESSION_LOCK:
        SESSION_STORE.pop(session_id, None)
        GAME_STORE.pop(session_id, None)
        HUMAN_QUEUE.pop(session_id, None)
        _save_session_files_locked(session_id)


def _human_session_locked(session_id: str) -> dict[str, object]:
    session = HUMAN_QUEUE.setdefault(
        session_id,
        {
            "session_id": session_id,
            "mode": "ai",
            "round": 1,
            "total_rounds": HUMAN_MAX_ROUNDS,
            "pot": HUMAN_ROUND_POT,
            "bank": 0,
            "ai_choice_pending": False,
            "typing_text": "",
            "typing_updated_at": None,
            "last_activity_at": None,
            "pending": {},
            "events": [],
        },
    )
    return session


def _human_event_payload(item: dict[str, object]) -> dict[str, object]:
    return {
        "id": item["id"],
        "kind": item["kind"],
        "session_id": item["session_id"],
        "participant_text": item.get("participant_text", ""),
        "participant_choice": item.get("participant_choice"),
        "round": item.get("round"),
        "created_at": item.get("created_at"),
    }


def _human_current_state_locked(session_id: str) -> dict[str, object]:
    session = _human_session_locked(session_id)
    return {
        "round": session["round"],
        "total_rounds": session["total_rounds"],
        "pot": session["pot"],
        "bank": session["bank"],
        "complete": int(session["round"]) > int(session["total_rounds"]),
    }


def _human_session_summary_payload(session: dict[str, object]) -> dict[str, object]:
    pending_items = [
        item
        for item in session.get("pending", {}).values()
        if isinstance(item, dict) and not item.get("response")
    ]
    pending_items.sort(key=lambda item: str(item.get("created_at") or ""))
    return {
        "session_id": session["session_id"],
        "mode": session.get("mode") or "ai",
        "round": session["round"],
        "total_rounds": session["total_rounds"],
        "pot": session["pot"],
        "bank": session["bank"],
        "complete": int(session["round"]) > int(session["total_rounds"]),
        "pending_count": len(pending_items),
        "pending": [_human_event_payload(item) for item in pending_items],
        "recent_events": list(session.get("events", []))[-30:],
        "typing_text": session.get("typing_text") or "",
        "typing_updated_at": session.get("typing_updated_at"),
        "last_activity_at": session.get("last_activity_at") or session.get("typing_updated_at"),
    }


def _human_choice_outcome(player_choice: str, confederate_choice: str) -> tuple[str, int]:
    if player_choice == "split" and confederate_choice == "split":
        return "both-split", HUMAN_ROUND_POT // 2
    if player_choice == "steal" and confederate_choice == "split":
        return "player-steals", HUMAN_ROUND_POT
    if player_choice == "split" and confederate_choice == "steal":
        return "confederate-steals", 0
    return "both-steal", 0


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


def _azure_speak_bytes(text: str, voice_name: str) -> Tuple[bytes, list[dict[str, object]]]:
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


def _generate_chat_reply(user_text: str, session_id: str) -> str:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set in .env")

    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini").strip()
    base_system = os.environ.get(
        "SYSTEM_PROMPT",
        "You are a concise, natural-sounding assistant. Keep replies short.",
    )
    assistant_preferences = os.environ.get(
        "ASSISTANT_PREFERENCES",
        DEFAULT_PREFERENCES,
    ).strip()

    client = OpenAI(api_key=api_key)
    completion = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "system",
                "content": _build_system_prompt(base_system, assistant_preferences),
            },
            *_get_model_history_snapshot(session_id),
            {"role": "user", "content": user_text},
        ],
        max_tokens=200,
        temperature=0.7,
    )
    reply = (completion.choices[0].message.content or "").strip()
    if not reply:
        reply = "I did not get a reply. Try again."
    _append_session_turn(session_id, user_text, reply)
    return reply


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
    return send_from_directory(ROOT, "confederate.html")


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


@app.post("/api/ask")
def ask():
    payload = request.get_json(silent=True) or {}
    user_text = (payload.get("text") or payload.get("question") or "").strip()
    if not user_text:
        return jsonify({"error": "Missing `text` in JSON body."}), 400
    session_id = _normalize_session_id(payload.get("session_id"))
    if payload.get("reset_conversation"):
        _clear_session_history(session_id)

    try:
        reply = _generate_chat_reply(user_text, session_id)
    except Exception as e:
        return jsonify({"error": str(e), "session_id": session_id}), 500

    azure_key = os.environ.get("AZURE_SPEECH_KEY", "").strip()
    azure_region = os.environ.get("AZURE_SPEECH_REGION", "").strip()
    avatar = payload.get("avatar", "male").strip().lower()

    if not azure_key or not azure_region:
        return jsonify({"error": "Azure Speech credentials are required for speech and visemes", "reply": reply, "session_id": session_id}), 502
    try:
        voice = os.environ.get("AZURE_VOICE_FEMALE" if avatar == "female" else "AZURE_VOICE_MALE", "").strip()
        if not voice:
            voice = "en-US-JennyNeural" if avatar == "female" else "en-US-BrianNeural"
        audio_bytes, mouth_cues = _azure_speak_bytes(reply, voice)
        mime = "audio/wav"
    except Exception as e:
        return jsonify({"error": f"Azure Speech synthesis failed: {e}", "reply": reply, "session_id": session_id}), 502

    b64 = base64.b64encode(audio_bytes).decode("ascii")
    response_payload = {
        "reply": reply,
        "audio_base64": b64,
        "audio_mime": mime,
        "mouth_cues": mouth_cues,
        "session_id": session_id,
    }
    return jsonify(response_payload)


@app.post("/api/reply")
def reply_only():
    payload = request.get_json(silent=True) or {}
    user_text = (payload.get("text") or payload.get("question") or "").strip()
    if not user_text:
        return jsonify({"error": "Missing `text` in JSON body."}), 400
    session_id = _normalize_session_id(payload.get("session_id"))
    if payload.get("reset_conversation"):
        _clear_session_history(session_id)

    try:
        reply = _generate_chat_reply(user_text, session_id)
    except Exception as e:
        return jsonify({"error": str(e), "session_id": session_id}), 500

    return jsonify({"reply": reply, "session_id": session_id})


@app.post("/api/viseme-demo-speak")
def viseme_demo_speak():
    payload = request.get_json(silent=True) or {}
    text = (payload.get("text") or "").strip()
    if not text:
        return jsonify({"error": "Missing `text` in JSON body."}), 400
    if len(text) > 500:
        return jsonify({"error": "`text` must be 500 characters or fewer."}), 400

    session_id = _normalize_session_id(payload.get("session_id"))
    avatar = (payload.get("avatar") or "male").strip().lower()
    try:
        return jsonify(_speak_response_payload(text, avatar, session_id))
    except Exception as e:
        return jsonify({"error": str(e), "session_id": session_id}), 502


@app.post("/api/human-message")
def human_message():
    payload = request.get_json(silent=True) or {}
    user_text = (payload.get("text") or "").strip()
    if not user_text:
        return jsonify({"error": "Missing `text` in JSON body."}), 400
    session_id = _normalize_session_id(payload.get("session_id"))
    if payload.get("reset_conversation"):
        _clear_session_history(session_id)

    message_id = f"hm_{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc).isoformat()
    with SESSION_LOCK:
        session = _human_session_locked(session_id)
        item = {
            "id": message_id,
            "kind": "message",
            "session_id": session_id,
            "participant_text": user_text,
            "created_at": now,
            "avatar": (payload.get("avatar") or "male").strip().lower(),
            "ready_at": None,
            "response": None,
        }
        session["typing_text"] = ""
        session["typing_updated_at"] = None
        session["last_activity_at"] = now
        session["pending"][message_id] = item
        session["events"].append({"type": "participant_message", **_human_event_payload(item)})
        log_dir = _participant_log_dir(session_id)
        _append_jsonl(log_dir / "events.jsonl", {"type": "human_message_pending", **_human_event_payload(item)})

    return jsonify({"ok": True, "message_id": message_id, "session_id": session_id})


@app.post("/api/human-typing")
def human_typing():
    payload = request.get_json(silent=True) or {}
    session_id = _normalize_session_id(payload.get("session_id"))
    text = str(payload.get("text") or "")[:500]
    now = datetime.now(timezone.utc).isoformat()
    with SESSION_LOCK:
        session = _human_session_locked(session_id)
        session["typing_text"] = text
        session["typing_updated_at"] = now
        session["last_activity_at"] = now
    return jsonify({"ok": True, "session_id": session_id, "typing_updated_at": now})


@app.post("/api/session-register")
def session_register():
    payload = request.get_json(silent=True) or {}
    session_id = _normalize_session_id(payload.get("session_id"))
    now = datetime.now(timezone.utc).isoformat()
    with SESSION_LOCK:
        session = _human_session_locked(session_id)
        session["last_activity_at"] = now
        session["events"].append({"type": "participant_login", "timestamp": now})
        log_dir = _participant_log_dir(session_id)
        _append_jsonl(log_dir / "events.jsonl", {"type": "participant_login", "timestamp": now})
        summary = _human_session_summary_payload(session)
    return jsonify({"ok": True, **summary})


@app.get("/api/session-mode/<session_id>")
def session_mode(session_id: str):
    normalized_session_id = _normalize_session_id(session_id)
    with SESSION_LOCK:
        session = _human_session_locked(normalized_session_id)
        mode = str(session.get("mode") or "ai")
    if mode not in {"ai", "human", "unknown"}:
        mode = "ai"
    return jsonify({"session_id": normalized_session_id, "mode": mode})


@app.get("/api/session-state/<session_id>")
def session_state(session_id: str):
    normalized_session_id = _normalize_session_id(session_id)
    with SESSION_LOCK:
        state = _human_current_state_locked(normalized_session_id)
    return jsonify({"session_id": normalized_session_id, **state})


@app.post("/api/confederate/session-mode")
def confederate_session_mode():
    payload = request.get_json(silent=True) or {}
    session_id = _normalize_session_id(payload.get("session_id"))
    mode = str(payload.get("mode") or "").strip().lower()
    if mode not in {"ai", "human", "unknown"}:
        return jsonify({"error": "Mode must be ai, human, or unknown."}), 400
    now = datetime.now(timezone.utc).isoformat()
    with SESSION_LOCK:
        session = _human_session_locked(session_id)
        session["mode"] = mode
        session["last_activity_at"] = now
        session["events"].append({"type": "session_mode_set", "mode": mode, "timestamp": now})
        log_dir = _participant_log_dir(session_id)
        _append_jsonl(log_dir / "events.jsonl", {"type": "session_mode_set", "mode": mode, "timestamp": now})
    return jsonify({"ok": True, "session_id": session_id, "mode": mode})


@app.post("/api/human-split-steal")
def human_split_steal():
    payload = request.get_json(silent=True) or {}
    user_choice = _normalize_split_steal_choice(payload.get("choice"))
    if not user_choice:
        return jsonify({"error": "Missing valid `choice`; use `split` or `steal`."}), 400
    session_id = _normalize_session_id(payload.get("session_id"))

    with SESSION_LOCK:
        state = _human_current_state_locked(session_id)
        if state["complete"]:
            return jsonify({"error": "All rounds are complete.", "session_id": session_id, **state}), 400

        session = _human_session_locked(session_id)
        message_id = f"hc_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).isoformat()
        item = {
            "id": message_id,
            "kind": "choice",
            "session_id": session_id,
            "participant_text": f"Participant chose {user_choice}.",
            "participant_choice": user_choice,
            "round": session["round"],
            "created_at": now,
            "avatar": (payload.get("avatar") or "male").strip().lower(),
            "ready_at": None,
            "response": None,
        }
        session["typing_text"] = ""
        session["typing_updated_at"] = None
        session["last_activity_at"] = now
        session["pending"][message_id] = item
        session["events"].append({"type": "participant_choice", **_human_event_payload(item)})
        log_dir = _participant_log_dir(session_id)
        _append_jsonl(log_dir / "events.jsonl", {"type": "human_choice_pending", **_human_event_payload(item)})

    return jsonify({
        "ok": True,
        "message_id": message_id,
        "session_id": session_id,
        "round": item["round"],
        "pot": HUMAN_ROUND_POT,
        "total_rounds": HUMAN_MAX_ROUNDS,
    })


@app.get("/api/human-result/<session_id>/<message_id>")
def human_result(session_id: str, message_id: str):
    normalized_session_id = _normalize_session_id(session_id)
    with SESSION_LOCK:
        session = _human_session_locked(normalized_session_id)
        item = session["pending"].get(message_id)
        if not item:
            return jsonify({"error": "Unknown pending human interaction."}), 404
        response = item.get("response")
        ready_at = item.get("ready_at")
        state = _human_current_state_locked(normalized_session_id)
        if not response or not ready_at or time.time() < float(ready_at):
            return jsonify({"status": "waiting", "session_id": normalized_session_id, "message_id": message_id, **state})
        cached_payload = item.get("payload")
        if cached_payload:
            return jsonify(cached_payload)

    try:
        payload = _speak_response_payload(
            str(response["reply"]),
            str(item.get("avatar") or "male"),
            normalized_session_id,
            {
                "status": "ready",
                "message_id": message_id,
                "kind": item.get("kind"),
                **dict(response),
            },
        )
    except Exception as e:
        return jsonify({"error": f"Speech synthesis failed: {e}", "session_id": normalized_session_id}), 502

    with SESSION_LOCK:
        item["payload"] = payload
    return jsonify(payload)


@app.get("/api/confederate/pending")
def confederate_pending():
    pending = []
    with SESSION_LOCK:
        for session in HUMAN_QUEUE.values():
            for item in session.get("pending", {}).values():
                if not item.get("response"):
                    pending.append(_human_event_payload(item))
    pending.sort(key=lambda item: str(item.get("created_at") or ""))
    return jsonify({"pending": pending})


@app.get("/api/confederate/sessions")
def confederate_sessions():
    with SESSION_LOCK:
        sessions = [
            _human_session_summary_payload(session)
            for session in HUMAN_QUEUE.values()
        ]
    sessions.sort(
        key=lambda item: (
            int(item.get("pending_count") or 0) == 0,
            str(item.get("last_activity_at") or ""),
        )
    )
    return jsonify({"sessions": sessions})


@app.post("/api/confederate/reply")
def confederate_reply():
    payload = request.get_json(silent=True) or {}
    session_id = _normalize_session_id(payload.get("session_id"))
    message_id = str(payload.get("message_id") or "").strip()
    reply = (payload.get("reply") or "").strip()
    confederate_choice = _normalize_split_steal_choice(payload.get("choice"))
    if not message_id:
        return jsonify({"error": "Missing `message_id`."}), 400

    with SESSION_LOCK:
        session = _human_session_locked(session_id)
        item = session["pending"].get(message_id)
        if not item:
            return jsonify({"error": "Unknown pending human interaction."}), 404
        if item.get("response"):
            return jsonify({"ok": True, "already_answered": True})

        if item.get("kind") == "choice":
            if not confederate_choice:
                return jsonify({"error": "Choice replies require `choice`: split or steal."}), 400
            player_choice = str(item.get("participant_choice"))
            outcome, payout = _human_choice_outcome(player_choice, confederate_choice)
            round_no = int(item.get("round") or session["round"])
            if not reply:
                reply = _human_choice_reply(player_choice, confederate_choice, payout, round_no)
            session["bank"] = int(session["bank"]) + payout
            is_last = round_no >= int(session["total_rounds"])
            session["round"] = int(session["total_rounds"]) + 1 if is_last else round_no + 1
            response = {
                "reply": reply,
                "participant_choice": player_choice,
                "confederate_choice": confederate_choice,
                "outcome": outcome,
                "payout": payout,
                "round": round_no,
                "pot": session["pot"],
                "bank": session["bank"],
                "total_rounds": session["total_rounds"],
                "complete": is_last,
            }
            event_type = "human_choice_resolved"
        else:
            if not reply:
                return jsonify({"error": "Missing `reply`."}), 400
            response = {"reply": reply}
            event_type = "human_message_resolved"

        item["response"] = response
        item["ready_at"] = time.time() + HUMAN_PROCESSING_DELAY_SECONDS
        item["answered_at"] = datetime.now(timezone.utc).isoformat()
        session["last_activity_at"] = item["answered_at"]
        session["events"].append({"type": event_type, "message_id": message_id, "timestamp": item["answered_at"], **response})
        log_dir = _participant_log_dir(session_id)
        _append_jsonl(log_dir / "events.jsonl", {"type": event_type, "message_id": message_id, "timestamp": item["answered_at"], **response})

    return jsonify({"ok": True, "message_id": message_id, "delay_seconds": HUMAN_PROCESSING_DELAY_SECONDS})


@app.post("/api/split-steal")
def split_steal():
    payload = request.get_json(silent=True) or {}
    user_choice = _normalize_split_steal_choice(payload.get("choice"))
    if not user_choice:
        return jsonify({"error": "Missing valid `choice`; use `split` or `steal`."}), 400
    session_id = _normalize_session_id(payload.get("session_id"))
    try:
        expected_round = int(payload.get("expected_round"))
    except (TypeError, ValueError):
        return jsonify({"error": "Missing valid `expected_round`."}), 400

    with SESSION_LOCK:
        session = _human_session_locked(session_id)
        state = _human_current_state_locked(session_id)
        if state["complete"]:
            return jsonify({"error": "All rounds are complete.", "session_id": session_id, **state}), 400
        if expected_round != int(session["round"]):
            return jsonify({"error": "Round state changed; refresh before choosing again.", "session_id": session_id, **state}), 409
        if session.get("ai_choice_pending"):
            return jsonify({"error": "A choice is already being processed.", "session_id": session_id, **state}), 409
        round_no = int(session["round"])
        starting_bank = int(session["bank"])
        pot = int(session["pot"])
        session["ai_choice_pending"] = True

    try:
        api_key = os.environ.get("OPENAI_API_KEY", "").strip()
        if not api_key:
            return jsonify({"error": "OPENAI_API_KEY is not set in .env"}), 500

        model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini").strip()
        client = OpenAI(api_key=api_key)
        choice_completion = client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are Kevin playing one round of Split or Steal. "
                        "Choose your move before seeing the user's move. "
                        "Do not ask for the participant's name or identifying information. "
                        "Reply with exactly one word: Split or Steal."
                    ),
                },
                *_get_model_history_snapshot(session_id),
                {
                    "role": "user",
                    "content": "Pick your move now. Do not ask questions. Reply only Split or Steal.",
                },
            ],
            max_tokens=5,
            temperature=0.9,
        )
        assistant_choice = _extract_split_steal_choice(
            choice_completion.choices[0].message.content or ""
        )
        outcome = _split_steal_outcome(user_choice, assistant_choice)
        payout = _split_steal_payout(outcome)
        bank = starting_bank + payout
        reply = _format_split_steal_reply(user_choice, assistant_choice, outcome)

        _append_session_turn(
            session_id,
            f"I choose {user_choice} in Split or Steal.",
            reply,
        )
        _append_game_round(
            session_id,
            user_choice,
            assistant_choice,
            outcome,
            reply,
            round_no,
            payout,
            bank,
            pot,
        )

        with SESSION_LOCK:
            session = _human_session_locked(session_id)
            session["bank"] = bank
            is_last = round_no >= int(session["total_rounds"])
            session["round"] = int(session["total_rounds"]) + 1 if is_last else round_no + 1
            resolved_at = datetime.now(timezone.utc).isoformat()
            session["last_activity_at"] = resolved_at
            resolved_event = {
                "type": "ai_choice_resolved",
                "round": round_no,
                "participant_choice": user_choice,
                "assistant_choice": assistant_choice,
                "outcome": outcome,
                "payout": payout,
                "bank": bank,
                "mode": session.get("mode") or "ai",
                "timestamp": resolved_at,
            }
            session["events"].append(resolved_event)
            _append_jsonl(_participant_log_dir(session_id) / "events.jsonl", resolved_event)
            next_round = min(int(session["round"]), int(session["total_rounds"]))
            total_rounds = int(session["total_rounds"])

        response_payload = {
            "reply": reply,
            "session_id": session_id,
            "user_choice": user_choice,
            "assistant_choice": assistant_choice,
            "outcome": outcome,
            "payout": payout,
            "round": round_no,
            "next_round": next_round,
            "pot": pot,
            "bank": bank,
            "total_rounds": total_rounds,
            "complete": is_last,
        }

        azure_key = os.environ.get("AZURE_SPEECH_KEY", "").strip()
        azure_region = os.environ.get("AZURE_SPEECH_REGION", "").strip()
        avatar = str(payload.get("avatar") or "male").strip().lower()
        if not azure_key or not azure_region:
            response_payload["audio_error"] = "Azure Speech credentials are not configured."
            return jsonify(response_payload)

        try:
            voice = os.environ.get("AZURE_VOICE_FEMALE" if avatar == "female" else "AZURE_VOICE_MALE", "").strip()
            if not voice:
                voice = "en-US-JennyNeural" if avatar == "female" else "en-US-BrianNeural"
            audio_bytes, mouth_cues = _azure_speak_bytes(reply, voice)
            response_payload.update({
                "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
                "audio_mime": "audio/wav",
                "mouth_cues": mouth_cues,
            })
        except Exception as exc:
            response_payload["audio_error"] = f"Azure Speech synthesis failed: {exc}"
        return jsonify(response_payload)
    finally:
        with SESSION_LOCK:
            _human_session_locked(session_id)["ai_choice_pending"] = False


@app.get("/api/health")
def health():
    return jsonify(
        {
            "ok": True,
            "openai": bool(os.environ.get("OPENAI_API_KEY", "").strip()),
            "deepgram": bool(os.environ.get("DEEPGRAM_API_KEY", "").strip()),
            "azure": bool(os.environ.get("AZURE_SPEECH_KEY", "").strip() and os.environ.get("AZURE_SPEECH_REGION", "").strip()),
        }
    )


@app.get("/api/history/<session_id>")
def history(session_id: str):
    normalized_session_id = _normalize_session_id(session_id)
    dialogue = _get_session_history_snapshot(normalized_session_id)
    rounds = _get_game_rounds_snapshot(normalized_session_id)
    return jsonify(
        {
            "session_id": normalized_session_id,
            "dialogue": dialogue,
            "split_steal_rounds": rounds,
        }
    )


if __name__ == "__main__":
    port = int(os.environ.get("WEB_APP_PORT", "8001"))
    # threaded=True helps when serving a very large GLB while handling API calls
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
