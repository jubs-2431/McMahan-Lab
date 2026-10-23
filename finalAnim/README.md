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
activity and transcripts across all routes. Both `/confederate` and
`/confederate.html` redirect to `/?mode=confederate`. The operator can change a
route once the current interaction has been presented and acknowledged.
Generated session data is stored under `participant_logs/`, which is ignored by Git.

## Recovery and persistence

Every AI reply receives the current round, pot, bank, and completed results from
the saved game state. Basic instructions keep chat brief, explain the real
payout rules, avoid promising an unchosen move, and prevent invented results or
extra rounds. Round 1 permits a brief introduction; rounds 2-6 continue normally;
round 7 is explicitly the final round. These are model instructions, not a
guarantee of perfect wording; the server remains responsible for moves/payouts.

AI game moves use a strict JSON schema with only `split` and `steal` allowed.
An invalid, incomplete, or refused move response is retried once automatically.
If both attempts fail, the session pauses with its round and bank unchanged;
**Resume response** retries that same interaction. No default move is substituted.

`participant_logs/<ID>/state.json` is the authoritative session snapshot. Atomic
replacement saves the assigned route, round, bank, full transcript, events, and
pending/resolved interactions together. A restart restores this snapshot; model
context still uses only the configured recent turns. Keep the same assigned ID
to resume a session. Use a different assigned ID for a new participant.

The participant page stores the outgoing request ID before sending. Refreshing,
reconnecting, or choosing **Resume response** uses that same interaction. A
completed response is saved before speech synthesis. If speech fails, the UI
shows the saved reply and pauses; resume retries its audio without regenerating
the reply or awarding another payout. Controls unlock after playback and a
successful acknowledgement. Human waiting times out after three minutes with a
resume action; it does not create another queue item. Route lookup failures also
pause the session rather than defaulting to AI.

Old event logs and JSON exports are imported when no `state.json` exists. Recovery
can only restore information that the older version recorded. In particular,
legacy pending records do not include the avatar, and legacy resolved responses
have no playback acknowledgement; the importer uses the male avatar for those
pending records and treats previously resolved legacy responses as delivered.
An invalid authoritative save produces an error instead of resetting progress.
Run only one server process against a given log directory; the session lock is
process-local.

## Research exports

`dialogue.json`, `split_steal_rounds.json`, `session.json`, and `events.jsonl` are
readable exports of the saved snapshot. Older records retain their original
fields. New records use schema version 2. Each new round has the same fields in
Human, AI, and Unknown routes: participant ID, request ID, assigned mode, actual
engine, round, participant/assistant choices, outcome, payout, bank, pot,
timestamp, avatar, model, and voice. The model is null for Human interactions.
Outcome values are `tie`, `user_wins`, `assistant_wins`, and `no_one_wins` in all
routes. `split_steal` is the canonical round event; the corresponding
`ai_choice_resolved` / `human_choice_resolved` events describe the same round and
must not be counted as extra rounds. `response_presented` records acknowledgement
after browser playback. Event timestamps describe server events, not precise
human response-time measurements.

Exports are refreshed after the authoritative save. If an export write fails,
the server logs the error and retains the saved snapshot; the next successful
session write refreshes the exports.

Current limitations:

- All routes enforce the seven-round counter and accumulate the participant's
  payouts in the displayed bank.
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
- `GET /api/history/<session_id>` returns the full stored dialogue and round history.
- New interactions accept a stable `request_id`; choices also require
  `expected_round`. Reusing an ID with different inputs returns HTTP 409.
- `GET /api/interaction/<session_id>/<message_id>` retrieves the saved response
  or waiting/interrupted status without generating audio.
- `POST /api/interaction/<session_id>/<message_id>/audio` retries speech for the
  saved response. A speech error leaves the response intact.
- `POST /api/interaction/<session_id>/<message_id>/ack` with
  `{"presentation":"audio"}` confirms playback. Until acknowledgement, another
  interaction or a route change is rejected.

## Regression checks

```bash
.venv/bin/python -m unittest -v test_game_state.py test_recovery.py test_backend_edges.py test_ai_moves.py
node --input-type=module --check < main.js
```

The tests use temporary log directories and mocked providers, without contacting
OpenAI/Azure or modifying participant records.

This is a localhost research prototype, not a production deployment. Do not
expose it directly to a network without authentication, transport security, and
an approved research-data plan.

Recovery guarantees: canonical saves are validated before use; invalid saves are rejected without resetting progress. Failed writes restore the last committed in-memory snapshot. Per-session locks keep another participant’s disk writes from blocking requests; operator polling uses the last saved summary while a session is busy. Run one server per log directory (the launcher process holds an exclusive file lock).

Speech runs in a child process with a 30-second timeout and a four-worker limit. Pending audio is polled by the browser; a failed synthesis can be retried without another payout or model response. Browser recovery uses per-tab session storage and stable request IDs. Rejoining restores the saved avatar and transcript. Completed sessions reject both chat and choices.

Operators can cancel an uncompleted response with a logged reason using the dashboard or `POST /api/confederate/cancel` (`session_id`, `message_id`, `reason`). Cancellation prevents late model results from committing; completed payouts cannot be cancelled.


## Serial EEG markers (no LSL)

Participant interactions require the shared protocol-v2 marker bridge from
[Myssttx/driver-moral-simulator](https://github.com/Myssttx/driver-moral-simulator).
Run it on the **participant browser computer**, with LSL disabled:

```bash
python3 python/marker_bridge.py --list-serial-ports
python3 python/marker_bridge.py --serial-port YOUR_SENDER_PORT --disable-lsl
```

The reference repo does **not** specify a fixed COM number (`port: null`). Select
the actual sender endpoint; configure EmotivPRO on the opposite receiver endpoint
of the serial pair. Both ends use **115200 baud, 8N1, no flow control**. The bridge
writes one raw uint8 byte per event, with no ASCII conversion or line ending.
The browser connects to `ws://127.0.0.1:7779/markers`; only the shared bridge
opens the serial port. Do not run another port writer or manually duplicate
these automatic round markers in the operator dashboard.

This app uses the reference `driver-serial-v1` codebook, with source
`operator_dashboard`, for human/AI/unknown conditions respectively:

- Round start at the first interaction: 131 / 132 / 133.
- Participant split or steal: 138-139 / 142-143 / 146-147.
- Opponent split or steal when the saved result is received: 140-141 / 144-145 / 148-149.
- Outcome displayed: 151 / 152 / 153.
- Round end after audio presentation: 155 / 156 / 157.

Protocol milestones such as consent and session start/end remain manual controls
in the reference operator dashboard. Browser event timing includes WebSocket
latency; markers are not hardware-synchronized display-onset timestamps.

Each marker requires an audited ACK with the expected byte code and a one-byte
`written` result. LSL-enabled bridges and simulation are rejected by default.
Missing/failed markers pause the interaction. Confirmed markers are remembered
in this tab's session storage and not replayed on recovery. A sent marker whose
ACK is lost is marked uncertain and blocks replay: the operator must inspect the
bridge audit CSV and stop that acquisition run before starting a new run with a
new participant/session ID. Do not clear storage to continue an uncertain run.
Use unique IDs per acquisition run and keep the same tab throughout it.

For deliberate simulation, run the bridge with `--serial-simulate --disable-lsl`
and open the participant page with `?serialMarkers=simulate`. For standalone
avatar development without acquisition, explicitly use `?serialMarkers=off`.
A `written` ACK only proves the OS accepted one byte; verify a short test recording
and the integer marker channel in EmotivPRO before collecting study data.

Serial client checks: `node --test test_serial_markers.mjs`.
