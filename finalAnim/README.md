# Split or Steal Avatar

Local research prototype for seven-round Split or Steal sessions with a Three.js
avatar, OpenAI conversation, Azure Speech audio/visemes, and an optional human
confederate route.

## Quick start

Requirements:

- Python 3.9+
- OpenAI and Azure Speech credentials in `.env`
- Chrome or another browser with Web Speech API support for microphone input

```bash
env WEB_APP_PORT=8002 ./run-local.sh
```

Open:

- Participant interface: <http://127.0.0.1:8002/>
- Confederate/operator interface: <http://127.0.0.1:8002/confederate>

The launcher creates `.venv`, installs `requirements.txt`, and starts the Flask
server on localhost. The port defaults to `8001` when neither `WEB_APP_PORT` nor
the `.env` value specifies another port.

## Environment

```dotenv
OPENAI_API_KEY=replace-with-openai-key
OPENAI_MODEL=gpt-4o-mini
SYSTEM_PROMPT=replace-with-study-prompt
AZURE_SPEECH_KEY=replace-with-azure-speech-key
AZURE_SPEECH_REGION=eastus
AZURE_VOICE_MALE=en-US-BrianNeural
AZURE_VOICE_FEMALE=en-US-JennyNeural
WEB_APP_PORT=8002
```

Never commit `.env`. The active speech path uses Azure Speech; the remaining
Deepgram dependency and helper are legacy compatibility code and are not used by
the participant reply routes.

## Current flow

1. Select the male or female avatar and enter an assigned participant ID.
2. Review the seven-round, $100-pot rules before the session activates.
3. Chat by text or browser speech recognition and choose Split or Steal.
4. In AI/Unknown routes, OpenAI generates responses and game choices.
5. In Human mode, the operator answers from the confederate interface.
6. Azure returns 24-kHz WAV audio and timed visemes that drive lip sync.

The operator interface can assign Human, AI, or Unknown routes and monitor recent
events. Generated session data is stored under `participant_logs/`, which is
ignored by Git.

Current limitations:

- Human mode enforces the seven-round counter and bank. AI and Unknown rounds are
  logged, but their browser counter/bank flow still needs equivalent enforcement.
- Unknown currently follows the same OpenAI route as AI.
- The confederate can see a submitted Human-mode choice before selecting a reply.

## Project layout

| File | Role |
| --- | --- |
| `server.py` | Flask routes, OpenAI calls, Azure synthesis, logging, and confederate queue |
| `index.html` | Participant and operator interface shell |
| `main.js` | Three.js rendering, interaction routing, browser speech, audio, and lip sync |
| `output/conversions/kevin_cc_reexport_three_fixed.glb` | Male avatar asset |
| `test-avatars/avaturn_feale_pose_edit.glb` | Female avatar asset |
| `.env` | Local credentials and configuration; never commit |

## API checks

- `GET /api/health` reports whether configured credentials are present. It does
  not prove that they authenticate successfully.
- `POST /api/viseme-demo-speak` accepts `text` and `avatar` and returns WAV audio
  plus Azure `mouth_cues` for integration testing.
- `GET /api/history/<session_id>` returns stored dialogue and AI-route game rounds.

This is a localhost research prototype, not a production deployment. Do not
expose it directly to a network without authentication, transport security, and
an approved research-data plan.
