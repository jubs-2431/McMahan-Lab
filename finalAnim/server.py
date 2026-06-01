"""
Lightweight API for OpenAI chat + Deepgram TTS. Serves the static web UI from this folder.
"""
from __future__ import annotations

import base64
import io
import json
import os
import re
import subprocess
import tempfile
import wave
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Optional, Tuple

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_file, send_from_directory
from openai import OpenAI

load_dotenv()

ROOT = os.path.dirname(os.path.abspath(__file__))
LOG_ROOT = Path(ROOT) / "participant_logs"
BASIC_ANIM_ROOT = "/Users/aryanshah/Downloads/BasicAnim"
RHUBARB_BIN = Path(ROOT) / "vendor" / "rhubarb" / "Rhubarb-Lip-Sync-1.14.0-macOS" / "rhubarb"
DEFAULT_PREFERENCES = (
    "You have stable, human-like preferences and can talk naturally about them. "
    "Keep them light, conversational, and internally consistent across turns. "
    "When asked about favorites, answer with specific examples and short reasons."
)
SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{3,80}$")
SESSION_STORE: dict[str, deque[dict[str, str]]] = {}
GAME_STORE: dict[str, deque[dict[str, str]]] = {}
SESSION_LOCK = Lock()
ANIMATION_ASSET_MAP = {
    "Breathing Idle.glb": os.path.join(BASIC_ANIM_ROOT, "Breathing Idle.glb"),
    "Looking Around.glb": os.path.join(BASIC_ANIM_ROOT, "Looking Around.glb"),
    "Thinking.glb": os.path.join(BASIC_ANIM_ROOT, "Thinking.glb"),
    "Daven.glb": os.path.join(BASIC_ANIM_ROOT, "Daven.glb"),
}

app = Flask(__name__)


def _parse_memory_turns() -> int:
    raw_value = os.environ.get("CHAT_MEMORY_TURNS", "6").strip()
    try:
        return max(1, min(30, int(raw_value)))
    except ValueError:
        return 6


MAX_MEMORY_TURNS = _parse_memory_turns()


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
            },
        )
        _save_session_files_locked(session_id)


def _clear_session_history(session_id: str) -> None:
    with SESSION_LOCK:
        SESSION_STORE.pop(session_id, None)
        GAME_STORE.pop(session_id, None)
        _save_session_files_locked(session_id)


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


def _rhubarb_mouth_cues(audio_bytes: bytes, dialog_text: str) -> Tuple[list[dict[str, object]], Optional[str]]:
    if not RHUBARB_BIN.exists():
        return [], "Rhubarb binary is not installed"

    try:
        with tempfile.TemporaryDirectory(prefix="finalanim-rhubarb-") as tmp_dir:
            tmp_path = Path(tmp_dir)
            wav_path = tmp_path / "reply.wav"
            dialog_path = tmp_path / "dialog.txt"
            cues_path = tmp_path / "cues.json"

            wav_path.write_bytes(audio_bytes)
            dialog_path.write_text(dialog_text.strip() + "\n", encoding="utf-8")

            subprocess.run(
                [
                    str(RHUBARB_BIN),
                    "-f",
                    "json",
                    "--extendedShapes",
                    "GHX",
                    "-d",
                    str(dialog_path),
                    "-o",
                    str(cues_path),
                    str(wav_path),
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            )
            payload = json.loads(cues_path.read_text(encoding="utf-8"))
            cues = payload.get("mouthCues", [])
            return cues if isinstance(cues, list) else [], None
    except Exception as exc:
        return [], str(exc)


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


@app.route("/talkinghead-test")
def talkinghead_test():
    return send_from_directory(ROOT, "talkinghead_test.html")


@app.route("/headtts-test")
def headtts_test():
    return send_from_directory(ROOT, "headtts_test.html")


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


@app.route("/kevin.glb")
def kevin_glb():
    return send_from_directory(
        ROOT,
        "kevin.glb",
        mimetype="model/gltf-binary",
        conditional=True,
        max_age=3600,
    )


@app.route("/female.glb")
def female_glb():
    return send_from_directory(
        ROOT,
        "female.glb",
        mimetype="model/gltf-binary",
        conditional=True,
        max_age=3600,
    )


@app.route("/animation-assets/<path:filename>")
def animation_asset(filename: str):
    file_path = ANIMATION_ASSET_MAP.get(filename)
    if not file_path or not os.path.isfile(file_path):
        return jsonify({"error": f"Unknown animation asset: {filename}"}), 404
    return send_file(
        file_path,
        mimetype="model/gltf-binary",
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

    try:
        audio_bytes, mime = _deepgram_speak_bytes(reply)
    except Exception as e:
        return jsonify({"error": str(e), "reply": reply, "session_id": session_id}), 502
    mouth_cues, rhubarb_error = _rhubarb_mouth_cues(audio_bytes, reply)

    b64 = base64.b64encode(audio_bytes).decode("ascii")
    payload = {
        "reply": reply,
        "audio_base64": b64,
        "audio_mime": mime,
        "mouth_cues": mouth_cues,
        "session_id": session_id,
    }
    if rhubarb_error:
        payload["rhubarb_error"] = rhubarb_error
    return jsonify(payload)


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


@app.post("/api/split-steal")
def split_steal():
    payload = request.get_json(silent=True) or {}
    user_choice = _normalize_split_steal_choice(payload.get("choice"))
    if not user_choice:
        return jsonify({"error": "Missing valid `choice`; use `split` or `steal`."}), 400
    session_id = _normalize_session_id(payload.get("session_id"))

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
    reply = _format_split_steal_reply(user_choice, assistant_choice, outcome)

    _append_session_turn(
        session_id,
        f"I choose {user_choice} in Split or Steal.",
        reply,
    )
    _append_game_round(session_id, user_choice, assistant_choice, outcome, reply)

    try:
        audio_bytes, mime = _deepgram_speak_bytes(reply)
    except Exception as e:
        return jsonify(
            {
                "error": str(e),
                "reply": reply,
                "session_id": session_id,
                "user_choice": user_choice,
                "assistant_choice": assistant_choice,
                "outcome": outcome,
            }
        ), 502
    mouth_cues, rhubarb_error = _rhubarb_mouth_cues(audio_bytes, reply)

    b64 = base64.b64encode(audio_bytes).decode("ascii")
    payload = {
        "reply": reply,
        "audio_base64": b64,
        "audio_mime": mime,
        "mouth_cues": mouth_cues,
        "session_id": session_id,
        "user_choice": user_choice,
        "assistant_choice": assistant_choice,
        "outcome": outcome,
    }
    if rhubarb_error:
        payload["rhubarb_error"] = rhubarb_error
    return jsonify(payload)


@app.get("/api/health")
def health():
    return jsonify(
        {
            "ok": True,
            "openai": bool(os.environ.get("OPENAI_API_KEY", "").strip()),
            "deepgram": bool(os.environ.get("DEEPGRAM_API_KEY", "").strip()),
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
