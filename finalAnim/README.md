# Kevin — voice avatar (local)

Minimal **voice-in → assistant reply → TTS out** web app with a **Three.js** portrait of `kevin.glb`, **lip sync** from playback volume (uses `V_Open` / `V_Lip_Open` when present), and **blinking** via `Eye_Blink_L` / `Eye_Blink_R`.

## Quick start

- Python 3.9+
- OpenAI + Deepgram keys in `.env` (the script will create `.env` from `.env.example` if needed)

```bash
./run-local.sh
```

On the first run, the script creates `.venv`, installs `requirements.txt`, and starts the server. Later runs reuse the same environment for faster startup.

Open **http://127.0.0.1:8001** (or the `WEB_APP_PORT` value from `.env`).

## Manual run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

Use **Chrome** (or another browser with **Web Speech API**). Click **Speak**, allow the microphone, talk, then wait for the spoken reply.

## Project layout

| File        | Role                                              |
| ----------- | ------------------------------------------------- |
| `server.py` | Flask app: static files + `POST /api/ask`         |
| `index.html`| Page shell + styles                               |
| `main.js`   | Three.js scene, GLTF, mic/STT, audio + lip sync   |
| `kevin.glb` | Avatar                                            |
| `.env`      | `OPENAI_*`, `DEEPGRAM_*`, optional tuning         |

## API

`POST /api/ask` with JSON `{"text":"your message"}` returns `reply`, `audio_base64`, and `audio_mime`.

`GET /api/health` reports whether API keys are present (not whether they are valid).
