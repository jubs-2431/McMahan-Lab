# Windows setup: finalAnim and EmotivPRO

Use Windows x64, Python 3.12 x64 with the `py` launcher, Git and Git LFS,
EmotivPRO, and your configured virtual/null-modem pair **COM5 ↔ COM6**.
The bridge owns COM5; EmotivPRO owns COM6. Keep both on the participant computer.

## 1. Get the current code

Run in PowerShell from the folder where you keep lab projects:

```powershell
git lfs install
git clone --branch codex/fix-avatar-cheek-teeth-lip-sync https://github.com/jubs-2431/McMahan-Lab.git
git -C .\McMahan-Lab lfs pull
git clone https://github.com/Myssttx/driver-moral-simulator.git
```

The first repo is private: sign in with a GitHub account that has access.
For an existing checkout, select the same branch and `git pull --ff-only`, then
`git lfs pull`. Keep any local changes safe before changing branches.
Git LFS downloads the actual male and female GLB avatar files.

## 2. Configure and start finalAnim

Open `McMahan-Lab\finalAnim` in File Explorer and double-click
`start-windows.bat`. On first launch it creates a virtual environment, installs
dependencies, copies `.env.example` to `.env`, and opens Notepad.
Fill in your own OpenAI key, Azure Speech key and Azure Speech region.
Leave `WEB_APP_PORT=8002` unless that port is already in use. Save and close
Notepad, then run `start-windows.bat` again. Keep its window open.
The launcher calls the venv directly; no PowerShell activation-policy change is needed.
Never share or commit `.env`.

The equivalent manual commands, from `McMahan-Lab\finalAnim`, are:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
# Copy only if .env does not already exist:
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
.\.venv\Scripts\python.exe server.py
```

## 3. Install the serial bridge

In a second PowerShell window, go to `driver-moral-simulator`:

```powershell
py -3.12 -m venv python\.venv
.\python\.venv\Scripts\python.exe -m pip install -r python\requirements.txt
.\python\.venv\Scripts\python.exe python\marker_bridge.py --list-serial-ports
```

Confirm COM5 and COM6 are the paired ports you configured. Merely seeing both
names in Device Manager does not prove they are paired. Close other applications
that have either endpoint open.

## 4. Configure EmotivPRO

Connect the headset. In EmotivPRO, open **Settings → Serial port marking**:

- COM port: **COM6**
- Bits per second: **115200**
- Data bits: **8**
- Parity: **None**
- Stop bits: **1**
- Flow control: **None**

Click **Start**, return to the recording screen and start a test recording.
Leave the LSL marker inlet off to avoid duplicate markers.

## 5. Start the bridge on COM5

From `driver-moral-simulator` in the second PowerShell window:

```powershell
.\python\.venv\Scripts\python.exe python\marker_bridge.py --serial-port COM5 --disable-lsl
```

Keep this window open. It should report hardware serial ready on COM5 and LSL
disabled, listening at `ws://127.0.0.1:7779/markers`.
Do not start a second bridge or another COM5 writer.

## 6. Run an end-to-end test

Open Chrome or Edge on the same computer:

- Participant: <http://127.0.0.1:8002/>
- Avatar operator/confederate: <http://127.0.0.1:8002/confederate>

Use a fresh test participant ID, select an avatar, accept the rules, and send a
message or choose Split/Steal. Allow microphone access if using voice input.
In Human mode the operator must respond from `/confederate`.
In AI/Unknown mode OpenAI replies automatically; both paths need Azure Speech
for audio and lip sync. Use the same participant tab throughout the run.

An AI round should produce:

1. `132`: round start at first interaction, including chat.
2. `142` or `143`: participant split or steal.
3. `144` or `145`: opponent split or steal.
4. `152`: outcome displayed.
5. `156`: round end after audio.

Bridge ACKs must show `written` and `bytes_written: 1`. In EmotivPRO, look for
serial markers in the recording timeline, then export the test recording and
check the integer code sequence. An OS write alone does not prove receipt.
Test both avatars and the Human, AI and Unknown routes before a study session.

The external repo's protocol dashboard is optional for manual milestones such
as consent and surveys. To run it, install Node.js LTS, run `npm install` then
`npm run dev` in `driver-moral-simulator`, and open
<http://localhost:3000/split-or-steal>. Do not manually duplicate the automatic
finalAnim round/choice/outcome markers.

## Troubleshooting and records

- **Port access denied:** close other programs using COM5; EmotivPRO must use COM6.
- **Bridge unavailable:** check that the bridge is on the participant computer,
  COM5 opened, LSL is disabled, and port 7779 is available.
- **Missing avatar:** run `git lfs pull` in `McMahan-Lab` and reload the page.
- **Missing or failed audio:** check your Azure key and region; do not substitute
  a Deepgram key. An OpenAI/Azure health flag only checks configuration presence.
- **Uncertain serial delivery:** stop that acquisition run and inspect the bridge
  audit log. Do not clear browser storage or replay markers to continue the run.
  Start a new run with a new participant/session ID after resolving the issue.
- **Logs:** finalAnim saves under `finalAnim\participant_logs`; bridge audit CSVs
  and metadata are under `driver-moral-simulator\python\sessions`.
- Stop the bridge and finalAnim with **Ctrl+C** in their respective windows.

These instructions configure software transport. The lab must verify actual
marker receipt and timing in its own EmotivPRO recording.
