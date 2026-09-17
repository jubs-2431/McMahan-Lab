import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const AVATARS = {
  male: { label: "Male", url: "/avatar-male.glb" },
  female: { label: "Female", url: "/avatar-female.glb" },
};
const MODEL_Y_OFFSET = 0;
const FACIAL_TRACK_EXCLUDE_PATTERN = /(head|neck|jaw|tongue|teeth|eye(?!brow)|upperjaw|tearline|eyeocclusion)/;
const BLINK_TARGET_LEFT_PATTERN = /^(eyeblinkl|eyeblinkleft)$/;
const BLINK_TARGET_RIGHT_PATTERN = /^(eyeblinkr|eyeblinkright)$/;
const BLINK_DURATION = 0.16;
const BLINK_WINK_AMOUNT = 0.08;
const SHIRT_MESH_NAME = "Basic_T_shirts";
const BODY_MESH_NAME = "CC_Base_Body";
const LIP_SYNC_ATTACK = 9;
const LIP_SYNC_RELEASE = 7;
const LIP_SYNC_GATE = 0.01;
const JAW_SMOOTH_ATTACK = 34;
const JAW_SMOOTH_RELEASE = 22;
const JAW_TARGET_GATE = 0.02;
const JAW_BONE_LIP_SYNC_ENABLED = false;
const LOWER_TEETH_MAX_DROP = 0.014;
const LIP_SYNC_MESH_INCLUDE_PATTERN = /ccbasebody|ccbaseteeth|ccbasetongue|headmesh|teethmesh|tonguemesh/;
const LIP_SYNC_EXCLUDE_PATTERN = /(blink|brow|tongue|eye|squint|cheek|nostril|smile|frown|close|press|pucker|purse|funnel|stretch|narrow|roll|tight|suck)/;
const LIP_SYNC_OPEN_PATTERN = /(jawopen|mouthopen|openjaw|openmouth|vopen|vlipopen)/;
const LIP_SYNC_VOWEL_PATTERN = /(visemeaa|visemeah|visemeao|visemeoh|visemeou|phonemeaa|phonemeah|phonemeao|phonemeoh|phonemeou|vwide|vtighto)/;
const BUILD_ID = "20260911-recovery";
const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;

const appEl = document.getElementById("app");
const canvas = document.getElementById("viewport");
const stageEl = document.getElementById("stage");
const statusEl = document.getElementById("status");
const speakBtn = document.getElementById("speak");
const transcriptEl = document.getElementById("transcript");
const historyEl = document.getElementById("history");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send");
const gameChoiceBtns = Array.from(document.querySelectorAll(".game-choice"));
const avatarChoiceBtns = Array.from(document.querySelectorAll(".avatar-choice"));
const modeChoiceBtns = Array.from(document.querySelectorAll(".mode-choice"));
const confederateOpenBtn = document.getElementById("confederate-open");
const participantForm = document.getElementById("participant-form");
const participantInput = document.getElementById("participant-id");
const participantError = document.getElementById("participant-error");
const participantLabel = document.getElementById("participant-label");
const modeLabel = document.getElementById("mode-label");
const changeParticipantBtn = document.getElementById("change-participant");
const openRulesBtn = document.getElementById("open-rules");
const rulesDialog = document.getElementById("rules-dialog");
const rulesConfirmBtn = document.getElementById("rules-confirm");
const roundCurrentEl = document.getElementById("round-current");
const roundTotalEl = document.getElementById("round-total");
const roundPotEl = document.getElementById("round-pot");
const bankTotalEl = document.getElementById("bank-total");
const roundPhaseEl = document.getElementById("round-phase");
const confederatePanel = document.getElementById("confederate-panel");
const confederateSessionList = document.getElementById("confederate-session-list");
const confederateChat = document.getElementById("confederate-chat");
const confederateRefreshBtn = document.getElementById("confederate-refresh");
const confederateBackBtn = document.getElementById("confederate-back");
const HISTORY_STORAGE_KEY = "finalanim_dialogue_history";
const AVATAR_STORAGE_KEY = "finalanim_avatar_choice";
const INTERACTION_MODE_STORAGE_KEY = "finalanim_interaction_mode";
const GAME_TOTAL_ROUNDS = 7;
const GAME_ROUND_POT = 100;
const HUMAN_POLL_INTERVAL_MS = 900;
const HUMAN_POLL_TIMEOUT_MS = 180000;
const CONFEDERATE_POLL_INTERVAL_MS = 1200;
const recoveryPanel = document.getElementById("session-recovery");
const recoveryMessage = document.getElementById("recovery-message");
const recoveryButton = document.getElementById("recovery-retry");
const operatorStatus = document.getElementById("operator-status");

function getViewportSize() {
  const width = Math.max(stageEl?.clientWidth || window.innerWidth, 1);
  const height = Math.max(stageEl?.clientHeight || window.innerHeight, 1);
  return { width, height };
}

const initialViewport = getViewportSize();

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(initialViewport.width, initialViewport.height, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe8edf3);

const camera = new THREE.PerspectiveCamera(
  38,
  initialViewport.width / initialViewport.height,
  0.1,
  100
);
camera.position.set(0, 1.5, 2.15);
camera.lookAt(0, 1.4, 0);

const hemi = new THREE.HemisphereLight(0xffffff, 0x667085, 1.7);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(2.5, 4.5, 3);
scene.add(key);
const fill = new THREE.DirectionalLight(0xaec4ff, 0.95);
fill.position.set(-3, 2, 2);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 0.25);
rim.position.set(-1, 3, -4);
scene.add(rim);

const tempVecA = new THREE.Vector3();
const tempVecB = new THREE.Vector3();
const tempEuler = new THREE.Euler(0, 0, 0, "XYZ");
const tempQuat = new THREE.Quaternion();

let avatarRoot = null;
let mixer = null;
let currentAction = null;
let idleAction = null;
let idleTime = 0;
let talkFocus = 0;
let poseRig = null;
let poseRest = new Map();
let poseBase = new Map();
let activeDrivenBones = new Set();

const actions = {};
const actionDrivenBones = new Map();

const talkingOpenParts = [];
const talkingWideParts = [];
const talkingRoundParts = [];
const talkingConsonantParts = [];
const talkingCloseParts = [];
const tongueRaiseParts = [];
const tongueOutParts = [];
const tongueCurlParts = [];
const teethOpenParts = [];
let blinkPartsLeft = [];
let blinkPartsRight = [];
let jawBone = null;
let jawInitialQuaternion = null;
const jawOpenAxis = new THREE.Vector3(1, 0, 0);
let jawOpenSign = -1;
const jawDeltaQuat = new THREE.Quaternion();
const jawMaxAngle = 0.28;
let jawSmoothedInfluence = 0;
let lowerTeethBone = null;
let lowerTeethInitialPosition = null;
let lowerTeethSmoothedInfluence = 0;
const femaleMouthMorphParts = [];
let activeFemaleVisemeId = 0;
let femaleVisemeIntensity = 0;

const FEMALE_AVATURN_VISEMES = {
  0: {},
  1: { visemee: 0.4, jawopen: 0.1, mouthstretchleft: 0.05, mouthstretchright: 0.05 },
  2: { visemeaa: 0.64, jawopen: 0.21 },
  3: { visemeo: 0.52, mouthfunnel: 0.12, jawopen: 0.14 },
  4: { visemee: 0.48 },
  5: { visemerr: 0.34, mouthpucker: 0.08 },
  6: { visemei: 0.42, mouthstretchleft: 0.05, mouthstretchright: 0.05 },
  7: { visemeu: 0.44, mouthpucker: 0.12 },
  8: { visemeo: 0.45, mouthfunnel: 0.1 },
  9: { visemeaa: 0.44, visemeo: 0.26, jawopen: 0.16 },
  10: { visemeo: 0.34, visemei: 0.18 },
  11: { visemeaa: 0.45, visemei: 0.22, jawopen: 0.12 },
  12: { jawopen: 0.08 },
  13: { visemerr: 0.36, mouthpucker: 0.08 },
  14: { visemedd: 0.32, jawopen: 0.08 },
  15: { visemess: 0.4, mouthstretchleft: 0.04, mouthstretchright: 0.04 },
  16: { visemech: 0.36, mouthpucker: 0.1 },
  17: { visemeth: 0.36 },
  18: { visemeff: 0.42 },
  19: { visemedd: 0.34 },
  20: { visemekk: 0.34, jawopen: 0.06 },
  21: { visemepp: 0.56, mouthclose: 0.1 },
};
const FEMALE_AVATURN_MOUTH_TARGETS = new Set(
  Object.values(FEMALE_AVATURN_VISEMES).flatMap((targets) => Object.keys(targets))
);

function setStatus(msg) {
  statusEl.textContent = msg;
}

function setTranscript(msg) {
  transcriptEl.textContent = msg ? `You: ${msg}` : "";
}

function getHistoryStorageKey(sessionId = conversationSessionId) {
  return sessionId ? `${HISTORY_STORAGE_KEY}_${sessionId}` : HISTORY_STORAGE_KEY;
}

function loadDialogueHistory(sessionId = conversationSessionId) {
  try {
    const raw = window.localStorage.getItem(getHistoryStorageKey(sessionId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(-50) : [];
  } catch (error) {
    console.warn("Could not read dialogue history:", error);
    return [];
  }
}

function saveDialogueHistory() {
  try {
    if (!conversationSessionId) return;
    window.localStorage.setItem(getHistoryStorageKey(), JSON.stringify(dialogueHistory.slice(-50)));
  } catch (error) {
    console.warn("Could not save dialogue history:", error);
  }
}

function renderDialogueHistory() {
  if (!historyEl) return;
  historyEl.replaceChildren();

  if (dialogueHistory.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No dialogue yet.";
    historyEl.appendChild(empty);
    return;
  }

  dialogueHistory.slice(-12).forEach((entry) => {
    const item = document.createElement("div");
    item.className = "history-item";

    if (entry.type === "split-steal") {
      item.textContent = `Split/Steal: You chose ${entry.userChoice}; Assistant chose ${entry.assistantChoice}. ${entry.outcomeText}`;
      const reply = document.createElement("div");
      reply.className = "history-meta";
      reply.textContent = `Assistant: ${entry.reply}`;
      item.appendChild(reply);
    } else if (entry.type === "human-choice") {
      item.textContent = `Split/Steal: You chose ${entry.userChoice}; Opponent chose ${entry.confederateChoice}. ${entry.outcomeText}`;
      const reply = document.createElement("div");
      reply.className = "history-meta";
      reply.textContent = `Opponent: ${entry.reply}`;
      item.appendChild(reply);
    } else {
      item.textContent = `${entry.role}: ${entry.text}`;
    }

    historyEl.appendChild(item);
  });
  historyEl.scrollTop = historyEl.scrollHeight;
}

function addDialogueEntry(entry) {
  if (!participantActive) return;
  if (entry.requestId && dialogueHistory.some((old) =>
    old.requestId === entry.requestId && old.role === entry.role && old.type === entry.type)) return;
  dialogueHistory.push({ ...entry, at: new Date().toISOString() });
  dialogueHistory = dialogueHistory.slice(-50);
  saveDialogueHistory();
  renderDialogueHistory();
}

function getOutcomeText(outcome) {
  return {
    tie: "It is a tie.",
    user_wins: "You won.",
    assistant_wins: "Assistant won.",
    no_one_wins: "No one wins.",
    "both-split": "You both split the pot.",
    "player-steals": "You stole the full pot.",
    "confederate-steals": "Your opponent stole the full pot.",
    "both-steal": "Both chose steal. No payout.",
  }[outcome] || "Round complete.";
}

function getInitialInteractionMode() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("mode");
  return ["ai", "human", "unknown", "confederate"].includes(requested) ? requested : "ai";
}

function persistInteractionMode(mode) {
  if (mode === "confederate") return;
  try {
    window.localStorage.setItem(INTERACTION_MODE_STORAGE_KEY, mode);
  } catch (error) {
    console.warn("Could not persist interaction mode:", error);
  }
}

function getModeDisplay(mode = currentInteractionMode) {
  return {
    ai: "AI",
    human: "Human",
    unknown: "Unknown",
    confederate: "Confederate",
  }[mode] || "AI";
}

function updateModeButtonsState() {
  modeChoiceBtns.forEach((button) => {
    const mode = button.dataset.mode || "";
    button.classList.toggle("active", mode === currentInteractionMode);
  });
  if (modeLabel) modeLabel.textContent = "Session active";
}

function setInteractionMode(mode) {
  if (!["ai", "human", "unknown", "confederate"].includes(mode)) return;
  currentInteractionMode = mode;
  persistInteractionMode(mode);
  updateModeButtonsState();
  if (mode === "confederate") {
    enterConfederateMode();
    return;
  }
  updateGamePanel();
  if (participantActive) {
    setStatus(mode === "human"
      ? "Session ready."
      : mode === "unknown"
        ? "Session ready."
        : "Session ready.");
  }
}

function normalizeRouteMode(mode) {
  return ["ai", "human", "unknown"].includes(mode) ? mode : "ai";
}

async function getAssignedInteractionMode() {
  const epoch = sessionEpoch;
  if (!conversationSessionId) throw new Error("Sign in before continuing.");
  const data = await apiJSON(`/api/session-mode/${encodeURIComponent(conversationSessionId)}`);
  assertCurrentSession(epoch);
  if (!["ai", "human", "unknown"].includes(data.mode)) throw new Error("The assigned route is unavailable. Reconnect to continue.");
  currentInteractionMode = data.mode;
  updateModeButtonsState();
  return currentInteractionMode;
}

async function registerParticipantSession() {
  const epoch = sessionEpoch;
  const data = await apiJSON("/api/session-register", {
    method: "POST", body: JSON.stringify({ session_id: conversationSessionId, avatar: currentAvatarKey }),
  });
  assertCurrentSession(epoch);
  if (!["ai", "human", "unknown"].includes(data.mode)) throw new Error("The assigned route is unavailable. Reconnect to continue.");
  currentInteractionMode = data.mode;
  updateModeButtonsState();
  applyGameState(data);
  return data;
}

function enterConfederateMode() {
  cancelReplyAudio?.();
  if (voiceModeEnabled) setVoiceModeEnabled(false);
  participantActive = false;
  sessionEpoch += 1;
  requestInFlight = false;
  appEl?.classList.remove("needs-login");
  appEl?.classList.add("confederate-mode");
  setTranscript("");
  startConfederatePolling();
}

function exitConfederateMode() {
  stopConfederatePolling();
  confederateSelectedSessionId = "";
  appEl?.classList.remove("confederate-mode");
  appEl?.classList.add("needs-login");
  setInteractionMode("ai");
  window.setTimeout(() => participantInput?.focus(), 0);
}

function renderConfederateSessions() {
  if (!confederateSessionList) return;
  const signature = JSON.stringify([confederateSelectedSessionId, confederateSessions.map((item) =>
    [item.session_id, item.mode, item.pending_count, item.round, item.total_rounds, !!item.typing_text])]);
  if (signature === confederateListSignature) return;
  confederateListSignature = signature;
  const focusedId = confederateSessionList.contains(document.activeElement)
    ? document.activeElement.dataset.sessionId : null;
  confederateSessionList.replaceChildren();

  if (confederateSessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "confederate-empty";
    empty.textContent = "Waiting for participant sessions...";
    confederateSessionList.appendChild(empty);
    return;
  }

  confederateSessions.forEach((session) => {
    const sessionId = String(session.session_id || "");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "confederate-session";
    button.dataset.sessionId = sessionId;
    button.classList.toggle("active", sessionId === confederateSelectedSessionId);
    button.textContent = `Participant ${sessionId}`;

    const meta = document.createElement("span");
    meta.className = "confederate-session-meta";
    const pendingCount = Number(session.pending_count || 0);
    const round = Number(session.round || 1);
    const totalRounds = Number(session.total_rounds || GAME_TOTAL_ROUNDS);
    const typingText = String(session.typing_text || "").trim();
    meta.textContent = `${getModeDisplay(normalizeRouteMode(session.mode))} · ${pendingCount} pending · Round ${Math.min(round, totalRounds)}/${totalRounds}${typingText ? " · typing" : ""}`;
    button.appendChild(meta);

    button.addEventListener("click", () => {
      confederateSelectedSessionId = sessionId;
      confederateChatSignature = "";
      renderConfederateSessions();
      renderConfederateChat();
    });

    confederateSessionList.appendChild(button);
    if (focusedId === sessionId) button.focus({ preventScroll: true });
  });
}

function renderConfederateCard(item) {
  const draftKey = `${item.session_id}:${item.id}`;
  if (confederateCards.has(draftKey)) return confederateCards.get(draftKey);
  const card = document.createElement("article");
  card.className = "confederate-card";

  const meta = document.createElement("div");
  meta.className = "confederate-meta";
  meta.textContent = `${String(item.kind || "").toUpperCase()}${item.round ? ` · Round ${item.round}` : ""}`;

  const message = document.createElement("div");
  message.className = "confederate-message";
  message.textContent = item.kind === "choice"
    ? `Participant chose ${String(item.participant_choice || "").toUpperCase()}. Pick your move and optionally write what the avatar should say.`
    : String(item.participant_text || "");

  const choiceRow = document.createElement("div");
  choiceRow.className = "confederate-choice-row";
  if (item.kind === "choice") {
    ["split", "steal"].forEach((choice) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `confederate-choice-${item.id}`;
      input.value = choice;
      input.checked = confederateChoices.get(draftKey) === choice;
      input.addEventListener("change", () => confederateChoices.set(draftKey, choice));
      label.append(input, choice[0].toUpperCase() + choice.slice(1));
      choiceRow.appendChild(label);
    });
  }

  const textarea = document.createElement("textarea");
  textarea.placeholder = item.kind === "choice"
    ? "Optional spoken response. Leave blank for automatic round summary."
    : "Type the response the avatar should speak...";
  textarea.value = confederateDrafts.get(draftKey) || "";
  textarea.addEventListener("input", () => {
    confederateDrafts.set(draftKey, textarea.value);
  });

  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "confederate-submit";
  submit.textContent = "Send to avatar";

  const error = document.createElement("div");
  error.className = "confederate-error";

  submit.addEventListener("click", async () => {
    if (confederateSubmissions.has(draftKey)) return;
    const selected = card.querySelector(`input[name="confederate-choice-${item.id}"]:checked`);
    if (item.kind === "choice" && !selected) {
      error.textContent = "Choose Split or Steal first.";
      return;
    }
    if (item.kind !== "choice" && !textarea.value.trim()) {
      error.textContent = "Type a reply first.";
      textarea.focus();
      return;
    }
    confederateSubmissions.add(draftKey);
    submit.disabled = true;
    error.textContent = "";
    try {
      await apiJSON("/api/confederate/reply", {
        method: "POST",
        body: JSON.stringify({
          session_id: item.session_id, message_id: item.id,
          reply: textarea.value.trim(), choice: selected ? selected.value : undefined,
        }),
      }, 15000);
      confederateDrafts.delete(draftKey);
      confederateChoices.delete(draftKey);
      confederateCards.delete(draftKey);
      confederateChatSignature = "";
      await fetchConfederateSessions();
    } catch (err) {
      submit.disabled = false;
      error.textContent = String(err.message || err);
    } finally {
      confederateSubmissions.delete(draftKey);
    }
  });

  card.append(meta, message, choiceRow, textarea, submit, error);
  confederateCards.set(draftKey, card);
  return card;
}

function eventTimestamp(event) {
  return event.timestamp || event.created_at || event.answered_at || "";
}

function renderConfederateEvent(event) {
  const item = document.createElement("div");
  item.className = "confederate-event";

  const meta = document.createElement("div");
  meta.className = "confederate-event-meta";
  meta.textContent = `${String(event.type || "event").replaceAll("_", " ")} · ${eventTimestamp(event) ? new Date(eventTimestamp(event)).toLocaleTimeString() : ""}`;
  item.appendChild(meta);

  const addLine = (label, text) => {
    const value = String(text || "").trim();
    if (!value) return;
    const line = document.createElement("div");
    line.className = "confederate-event-line";
    line.textContent = `${label}: ${value}`;
    item.appendChild(line);
  };

  if (event.type === "split_steal" || event.type === "ai_choice_resolved") {
    addLine("Round", event.round);
    addLine("Choices", `Participant ${event.participant_choice || event.user_choice}; opponent ${event.assistant_choice}`);
    addLine("Payout", `$${Number(event.payout || 0)} · Bank $${Number(event.bank || 0)}`);
    addLine("Outcome", getOutcomeText(event.outcome));
  } else if (event.type === "chat_turn") {
    addLine("Participant", event.participant_text);
    addLine("Avatar", event.avatar_text);
  } else if (event.type === "participant_message") {
    addLine("Participant", event.participant_text);
  } else if (event.type === "human_message_resolved") {
    addLine("Avatar", event.reply);
  } else if (event.type === "participant_choice") {
    addLine("Participant", event.participant_text || `Chose ${event.participant_choice || ""}`);
  } else if (event.type === "human_choice_resolved") {
    addLine("Round", event.round ? String(event.round) : "");
    addLine("Choices", `Participant ${event.participant_choice || "unknown"}; avatar ${event.confederate_choice || "unknown"}`);
    addLine("Outcome", event.outcome);
    addLine("Avatar", event.reply);
  } else if (event.type === "session_mode_set") {
    addLine("Route", getModeDisplay(normalizeRouteMode(event.mode)));
  } else if (event.type === "participant_login") {
    addLine("Status", "Participant signed in");
  } else {
    addLine("Detail", event.participant_text || event.reply || event.mode || event.outcome || "");
  }

  return item;
}

function renderConfederateChat() {
  if (!confederateChat) return;

  if (!confederateSelectedSessionId) {
    const signature = "no-selected-session";
    if (signature === confederateChatSignature) return;
    confederateChatSignature = signature;
    confederateChat.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "confederate-empty";
    empty.textContent = "Choose a participant ID to enter that chat.";
    confederateChat.appendChild(empty);
    return;
  }

  const session = confederateSessions.find((item) => String(item.session_id || "") === confederateSelectedSessionId);
  if (!session) {
    const signature = `missing:${confederateSelectedSessionId}`;
    if (signature === confederateChatSignature) return;
    confederateChatSignature = signature;
    confederateChat.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "confederate-empty";
    empty.textContent = "That participant session is no longer active.";
    confederateChat.appendChild(empty);
    return;
  }

  const pending = Array.isArray(session.pending) ? session.pending : [];
  const recentEvents = Array.isArray(session.recent_events) ? session.recent_events : [];
  const signature = JSON.stringify({
    session_id: confederateSelectedSessionId,
    mode: normalizeRouteMode(session.mode),
    recoverable: (session.recoverable || []).map((item) => [item.id, item.status]),
    bank: Number(session.bank || 0),
    round: Number(session.round || 1),
    total_rounds: Number(session.total_rounds || GAME_TOTAL_ROUNDS),
    pending: pending.map((item) => ({
      id: item.id,
      kind: item.kind,
      round: item.round || null,
      text: item.participant_text || "",
      choice: item.participant_choice || "",
    })),
    recent_events: recentEvents.map((event) => ({
      type: event.type || "",
      timestamp: eventTimestamp(event),
      participant_text: event.participant_text || "",
      participant_choice: event.participant_choice || "",
      avatar_text: event.avatar_text || "",
      reply: event.reply || "",
      mode: event.mode || "",
      outcome: event.outcome || "",
      round: event.round || null,
    })),
  });
  const liveTyping = document.getElementById("confederate-typing");
  if (liveTyping) {
    liveTyping.textContent = session.typing_text ? `Typing now: ${session.typing_text}` : "";
    liveTyping.hidden = !session.typing_text;
  }
  if (signature === confederateChatSignature) return;
  const focused = confederateChat.contains(document.activeElement) ? document.activeElement : null;
  const selection = focused?.tagName === "TEXTAREA" ? [focused.selectionStart, focused.selectionEnd] : null;
  const scrollTop = confederateChat.scrollTop;
  confederateChatSignature = signature;
  confederateChat.replaceChildren();

  const header = document.createElement("div");
  header.className = "confederate-meta";
  header.textContent = `Participant ${confederateSelectedSessionId} · Bank $${Number(session.bank || 0)} · Route ${getModeDisplay(normalizeRouteMode(session.mode))}`;
  confederateChat.appendChild(header);

  const routeActions = document.createElement("div");
  routeActions.className = "confederate-route-actions";
  [
    ["human", "Human"],
    ["ai", "AI"],
    ["unknown", "Unknown"],
  ].forEach(([mode, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "route-choice";
    button.disabled = (session.recoverable || []).length > 0;
    button.classList.toggle("active", normalizeRouteMode(session.mode) === mode);
    button.textContent = label;
    button.addEventListener("click", () => setConfederateSessionMode(confederateSelectedSessionId, mode));
    routeActions.appendChild(button);
  });
  confederateChat.appendChild(routeActions);
  (session.recoverable || []).filter((item) => item.status !== "ready").forEach((item) => {
    const cancel = document.createElement("button");
    cancel.textContent = `Cancel pending response (${item.id})`;
    cancel.addEventListener("click", async () => {
      const reason = window.prompt("Reason for cancelling this uncompleted response (saved in the session log):");
      if (!reason?.trim()) return;
      cancel.disabled = true;
      try {
        await apiJSON("/api/confederate/cancel", { method: "POST", body: JSON.stringify({
          session_id: session.session_id, message_id: item.id, reason: reason.trim(),
        }) });
        await fetchConfederateSessions();
      } catch (error) { cancel.disabled = false; setStatus(error.message); }
    });
    confederateChat.appendChild(cancel);
  });

  const typingText = String(session.typing_text || "").trim();
  const typing = document.createElement("div");
  typing.id = "confederate-typing";
  typing.textContent = typingText ? `Typing now: ${typingText}` : "";
  typing.hidden = !typingText;
  confederateChat.appendChild(typing);

  const visibleEvents = recentEvents.filter((event) =>
    !["human_message_pending", "human_choice_pending"].includes(event.type) &&
    !(event.schema_version === 2 && ["ai_choice_resolved", "human_choice_resolved"].includes(event.type)));
  if (visibleEvents.length > 0) {
    visibleEvents.slice(-12).forEach((event) => {
      confederateChat.appendChild(renderConfederateEvent(event));
    });
  }

  if (pending.length === 0) {
    const empty = document.createElement("div");
    empty.className = "confederate-empty";
    empty.textContent = visibleEvents.length > 0
      ? "No pending response needed right now."
      : "No participant activity yet.";
    confederateChat.appendChild(empty);
    return;
  }

  pending.forEach((item) => confederateChat.appendChild(renderConfederateCard(item)));
  if (focused && confederateChat.contains(focused)) {
    focused.focus({ preventScroll: true });
    if (selection) focused.setSelectionRange(...selection);
  }
  confederateChat.scrollTop = scrollTop;
}

async function setConfederateSessionMode(sessionId, mode) {
  if (!sessionId) return;
  try {
    await apiJSON("/api/confederate/session-mode", {
      method: "POST", body: JSON.stringify({ session_id: sessionId, mode }),
    }, 15000);
    confederateChatSignature = "";
    operatorStatus.textContent = "Route saved.";
    await fetchConfederateSessions();
  } catch (error) {
    operatorStatus.textContent = error.message || "Could not change the route.";
  }
}

async function fetchConfederateSessions() {
  if (!confederatePanel || !appEl?.classList.contains("confederate-mode") || confederatePollInFlight) return;
  confederatePollInFlight = true;
  try {
    const data = await apiJSON("/api/confederate/sessions", {}, 10000);
    if (operatorStatus.dataset.offline === "true") operatorStatus.textContent = "Connected.";
    operatorStatus.dataset.offline = "false";
    if (data.session_errors?.length) {
      operatorStatus.textContent = `These saved sessions need recovery: ${data.session_errors.map((item) => item.session_id).join(", ")}. Their saves have not been reset.`;
    }
    confederateSessions = Array.isArray(data.sessions) ? data.sessions : [];
    if (
      confederateSelectedSessionId &&
      !confederateSessions.some((item) => String(item.session_id || "") === confederateSelectedSessionId)
    ) {
      confederateSelectedSessionId = "";
    }
    renderConfederateSessions();
    renderConfederateChat();
  } catch (error) {
    operatorStatus.textContent = "Connection lost. Showing the last received activity; reconnecting...";
    operatorStatus.dataset.offline = "true";
  } finally {
    confederatePollInFlight = false;
  }
}

function startConfederatePolling() {
  stopConfederatePolling();
  fetchConfederateSessions();
  confederatePollTimer = window.setInterval(fetchConfederateSessions, CONFEDERATE_POLL_INTERVAL_MS);
}

function stopConfederatePolling() {
  if (!confederatePollTimer) return;
  window.clearInterval(confederatePollTimer);
  confederatePollTimer = null;
}

function updateGamePanel() {
  if (roundCurrentEl) roundCurrentEl.textContent = String(Math.min(gameRound, GAME_TOTAL_ROUNDS));
  if (roundTotalEl) roundTotalEl.textContent = String(GAME_TOTAL_ROUNDS);
  if (roundPotEl) roundPotEl.textContent = String(GAME_ROUND_POT);
  if (bankTotalEl) bankTotalEl.textContent = String(gameBank);
  if (roundPhaseEl) roundPhaseEl.textContent = gamePhase;
}

function applyGameState(data) {
  if (!data || typeof data !== "object") return;
  gameBank = Number(data.bank ?? gameBank);
  gameComplete = !!data.complete;
  gameRound = gameComplete
    ? GAME_TOTAL_ROUNDS
    : Math.min(GAME_TOTAL_ROUNDS, Number(data.next_round ?? data.round ?? gameRound));
  gamePhase = gameComplete ? "Complete" : "Ready";
  updateGamePanel();
  updateSendButtonState();
}

async function syncParticipantGameState() {
  const epoch = sessionEpoch;
  if (!conversationSessionId) return;
  const data = await apiJSON(`/api/session-state/${encodeURIComponent(conversationSessionId)}`);
  assertCurrentSession(epoch);
  applyGameState(data);
}

function getInitialAvatarKey() {
  const params = new URLSearchParams(window.location.search);
  let stored;
  try { stored = window.localStorage.getItem(AVATAR_STORAGE_KEY); } catch (_) {}
  const requested = params.get("avatar") || stored;
  return Object.prototype.hasOwnProperty.call(AVATARS, requested) ? requested : "male";
}

function persistAvatarKey(key) {
  try {
    window.localStorage.setItem(AVATAR_STORAGE_KEY, key);
  } catch (error) {
    console.warn("Could not persist avatar choice:", error);
  }
}

function updateAvatarButtonsState() {
  avatarChoiceBtns.forEach((button) => {
    const key = button.dataset.avatar || "";
    const isActive = key === currentAvatarKey;
    button.disabled = requestInFlight || sessionPaused || isActive;
    button.classList.toggle("active", isActive);
  });
}

function persistSessionId(sessionId) {
  conversationSessionId = sessionId || null;
}

function normalizeParticipantId(rawValue) {
  return (rawValue || "").trim();
}

function setParticipantError(message) {
  if (participantError) participantError.textContent = message || "";
}

function setParticipantActive(sessionId) {
  sessionEpoch += 1;
  conversationSessionId = sessionId;
  participantActive = true;
  sessionPaused = true;
  pendingInteraction = readPendingInteraction();
  gameRound = 1;
  gameBank = 0;
  gameComplete = false;
  gamePhase = "Connecting";
  dialogueHistory = loadDialogueHistory(sessionId);
  appEl?.classList.remove("needs-login");
  if (participantLabel) participantLabel.textContent = `Participant ID: ${sessionId}`;
  setParticipantError("");
  renderDialogueHistory();
  updateGamePanel();
  reconnectSession();
}

function resetParticipant() {
  cancelReplyAudio?.();
  if (humanTypingTimer) window.clearTimeout(humanTypingTimer);
  lastHumanTypingText = "";
  sessionEpoch += 1;
  requestInFlight = false;
  sessionPaused = false;
  pendingInteraction = null;
  recoveryPanel.hidden = true;
  if (voiceModeEnabled) setVoiceModeEnabled(false);
  conversationSessionId = null;
  participantActive = false;
  dialogueHistory = [];
  gameRound = 1;
  gameBank = 0;
  gameComplete = false;
  gamePhase = "Ready";
  appEl?.classList.add("needs-login");
  if (participantLabel) participantLabel.textContent = "Participant ID: --";
  if (participantInput) participantInput.value = "";
  setTranscript("");
  renderDialogueHistory();
  updateModeButtonsState();
  updateGamePanel();
  updateSpeakButtonState();
  updateSendButtonState();
  window.setTimeout(() => participantInput?.focus(), 0);
}

function hasLipSyncTargets() {
  return (
    talkingOpenParts.length > 0 ||
    talkingWideParts.length > 0 ||
    talkingRoundParts.length > 0 ||
    talkingConsonantParts.length > 0 ||
    talkingCloseParts.length > 0 ||
    teethOpenParts.length > 0 ||
    femaleMouthMorphParts.length > 0 ||
    !!jawBone ||
    !!lowerTeethBone
  );
}

function detectLipSyncTargets(model) {
  talkingOpenParts.length = 0;
  talkingWideParts.length = 0;
  talkingRoundParts.length = 0;
  talkingConsonantParts.length = 0;
  talkingCloseParts.length = 0;
  tongueRaiseParts.length = 0;
  tongueOutParts.length = 0;
  tongueCurlParts.length = 0;
  teethOpenParts.length = 0;
  jawBone = null;
  jawInitialQuaternion = null;
  lowerTeethBone = null;
  lowerTeethInitialPosition = null;
  lowerTeethSmoothedInfluence = 0;
  femaleMouthMorphParts.length = 0;
  activeFemaleVisemeId = 0;
  femaleVisemeIntensity = 0;
  jawOpenAxis.set(1, 0, 0);
  jawOpenSign = -1;
  jawSmoothedInfluence = 0;

  const jawCandidates = [];

  model.traverse((child) => {
    const normalizedName = normalizeNodeName(child.name || "");

    if (child.isBone && (normalizedName.includes("jaw") || normalizedName.includes("mouth"))) {
      let score = 0;
      if (normalizedName.includes("jawroot")) score += 8;
      if (normalizedName.includes("lowerjaw")) score += 6;
      if (normalizedName.includes("jaw")) score += 4;
      if (normalizedName.includes("mouth")) score += 2;
      if (normalizedName.includes("upper")) score -= 3;
      if (score > 0) jawCandidates.push({ bone: child, score });
    }

    if (
      child.isBone &&
      (normalizedName.includes("teeth02") || normalizedName.includes("lowerteeth"))
    ) {
      lowerTeethBone = child;
      lowerTeethInitialPosition = child.position.clone();
    }

    if (!child.isMesh || !child.morphTargetDictionary || !child.morphTargetInfluences) return;
    if (!LIP_SYNC_MESH_INCLUDE_PATTERN.test(normalizedName)) return;

    if (currentAvatarKey === "female") {
      Object.entries(child.morphTargetDictionary).forEach(([key, index]) => {
        const normalizedKey = normalizeNodeName(key);
        if (FEMALE_AVATURN_MOUTH_TARGETS.has(normalizedKey)) {
          femaleMouthMorphParts.push({
            mesh: child,
            index,
            normalizedKey,
            baseValue: child.morphTargetInfluences[index] ?? 0,
          });
        }
      });
      return;
    }

    if (normalizedName.includes("teeth")) {
      const registerTeethPart = (key, weight) => {
        const index = child.morphTargetDictionary[key];
        if (typeof index !== "number") return;
        teethOpenParts.push({
          mesh: child,
          index,
          key,
          baseValue: child.morphTargetInfluences[index] ?? 0,
          weight,
        });
      };

      if (Object.prototype.hasOwnProperty.call(child.morphTargetDictionary, "V_Open")) {
        registerTeethPart("V_Open", 0.22);
      } else if (Object.prototype.hasOwnProperty.call(child.morphTargetDictionary, "mouthOpen")) {
        registerTeethPart("mouthOpen", 0.18);
      }
      return;
    }

    const registerPart = (key, collection, weight) => {
      const index = child.morphTargetDictionary[key];
      if (typeof index !== "number") return;
      collection.push({
        mesh: child,
        index,
        key,
        baseValue: child.morphTargetInfluences[index] ?? 0,
        weight,
      });
    };

    Object.keys(child.morphTargetDictionary).forEach((key) => {
      const normalizedKey = normalizeNodeName(key);

      const isMouthInteriorMesh = normalizedName.includes("tongue");

      if (normalizedKey === "vopen") {
        registerPart(key, talkingOpenParts, isMouthInteriorMesh ? 0.78 : 0.48);
      } else if (normalizedKey === "visemeaa") {
        registerPart(key, talkingOpenParts, isMouthInteriorMesh ? 0.46 : 0.22);
      } else if (normalizedKey === "mouthopen") {
        registerPart(key, talkingOpenParts, isMouthInteriorMesh ? 0.56 : 0.18);
      } else if (normalizedKey === "vlipopen" || normalizedKey === "visemee") {
        registerPart(key, talkingOpenParts, isMouthInteriorMesh ? 0.38 : 0.16);
      } else if (normalizedKey === "jawopen" || normalizedKey === "jawdown") {
        if (isMouthInteriorMesh) registerPart(key, talkingOpenParts, 0.58);
      } else if (normalizedKey === "mouthdroplower") {
        if (isMouthInteriorMesh) registerPart(key, talkingOpenParts, 0.42);
      } else if (normalizedKey === "mouthdropupper") {
        if (isMouthInteriorMesh) registerPart(key, talkingOpenParts, 0.18);
      } else if (normalizedKey === "vwide" || normalizedKey === "visemess" || normalizedKey === "visemei") {
        registerPart(key, talkingWideParts, 0.85);
      } else if (normalizedKey === "vtighto" || normalizedKey === "vtight" || normalizedKey === "visemeo" || normalizedKey === "visemeu") {
        registerPart(key, talkingRoundParts, 0.90);
      } else if (normalizedKey === "vdentallip" || normalizedKey === "vaffricate" || normalizedKey === "visemeff" || normalizedKey === "visemeth" || normalizedKey === "visemedd") {
        registerPart(
          key,
          talkingConsonantParts,
          0.85
        );
      } else if (normalizedKey === "mouthclose" || normalizedKey === "mouthcontract" || normalizedKey === "visemesil" || normalizedKey === "visemepp") {
        registerPart(key, talkingCloseParts, 0.85);
      } else if (
        normalizedKey === "tongueup" ||
        normalizedKey === "tonguetipup" ||
        normalizedKey === "tonguemidup" ||
        normalizedKey === "vtongueraise" ||
        normalizedKey === "vtongueup"
      ) {
        registerPart(key, tongueRaiseParts, 0.18);
      } else if (
        normalizedKey === "tongueout" ||
        normalizedKey === "tongueextend" ||
        normalizedKey === "vtongueout"
      ) {
        registerPart(key, tongueOutParts, 0.12);
      } else if (
        normalizedKey === "tongueroll" ||
        normalizedKey === "vtonguecurlu" ||
        normalizedKey === "vtonguecurld" ||
        normalizedKey === "tonguenarrow"
      ) {
        registerPart(key, tongueCurlParts, 0.1);
      }
    });
  });

  if (jawCandidates.length > 0) {
    jawCandidates.sort((a, b) => b.score - a.score);
    jawBone = jawCandidates[0].bone;
    jawInitialQuaternion = jawBone.quaternion.clone();
    calibrateJawMotion(model);
  }

  if (JAW_BONE_LIP_SYNC_ENABLED && jawBone && talkingOpenParts.length > 0) {
    for (const part of talkingOpenParts) {
      part.weight *= 0.95;
    }
  }

  const uniqueOpenNames = [...new Set(talkingOpenParts.map((part) => part.key))];
  const uniqueWideNames = [...new Set(talkingWideParts.map((part) => part.key))];
  const uniqueRoundNames = [...new Set(talkingRoundParts.map((part) => part.key))];
  const uniqueConsonantNames = [...new Set(talkingConsonantParts.map((part) => part.key))];
  const uniqueCloseNames = [...new Set(talkingCloseParts.map((part) => part.key))];
  const uniqueTongueRaiseNames = [...new Set(tongueRaiseParts.map((part) => part.key))];
  const uniqueTongueOutNames = [...new Set(tongueOutParts.map((part) => part.key))];
  const uniqueTongueCurlNames = [...new Set(tongueCurlParts.map((part) => part.key))];
  const uniqueTeethNames = [...new Set(teethOpenParts.map((part) => part.key))];
  console.info(
    `Lip-sync targets: open=${talkingOpenParts.length}, wide=${talkingWideParts.length}, round=${talkingRoundParts.length}, consonant=${talkingConsonantParts.length}, close=${talkingCloseParts.length}, tongueRaise=${tongueRaiseParts.length}, tongueOut=${tongueOutParts.length}, tongueCurl=${tongueCurlParts.length}, teeth=${teethOpenParts.length}, femaleMouth=${femaleMouthMorphParts.length}, jaw=${jawBone ? jawBone.name : "none"}${JAW_BONE_LIP_SYNC_ENABLED ? "" : " (disabled)"}, lowerTeeth=${lowerTeethBone ? lowerTeethBone.name : "none"}`
  );
  console.info("Lip-sync open morphs:", uniqueOpenNames.join(", "));
  console.info("Lip-sync wide morphs:", uniqueWideNames.join(", "));
  console.info("Lip-sync round morphs:", uniqueRoundNames.join(", "));
  console.info("Lip-sync consonant morphs:", uniqueConsonantNames.join(", "));
  console.info("Lip-sync close morphs:", uniqueCloseNames.join(", "));
  console.info("Tongue raise morphs:", uniqueTongueRaiseNames.join(", "));
  console.info("Tongue out morphs:", uniqueTongueOutNames.join(", "));
  console.info("Tongue curl morphs:", uniqueTongueCurlNames.join(", "));
  console.info("Teeth open morphs:", uniqueTeethNames.join(", "));
}

function findJawTipTarget(jaw) {
  let farthestNode = null;
  let maxDistance = 0;
  const jawPos = new THREE.Vector3();
  const nodePos = new THREE.Vector3();
  jaw.getWorldPosition(jawPos);

  jaw.traverse((node) => {
    if (node === jaw) return;
    if (!node.isBone && !node.isMesh) return;

    node.getWorldPosition(nodePos);
    const distance = jawPos.distanceTo(nodePos);
    if (distance > maxDistance) {
      maxDistance = distance;
      farthestNode = node;
    }
  });

  return farthestNode;
}

function calibrateJawMotion(model) {
  if (!jawBone || !jawInitialQuaternion) return;

  jawBone.updateWorldMatrix(true, true);
  const tipTarget = findJawTipTarget(jawBone);
  if (!tipTarget) return;

  const worldUp = new THREE.Vector3(0, 1, 0);
  const worldForward = new THREE.Vector3();
  model.getWorldDirection(worldForward);
  if (worldForward.lengthSq() < 1e-6) worldForward.set(0, 0, 1);
  worldForward.normalize();

  const worldRight = new THREE.Vector3().crossVectors(worldForward, worldUp);
  if (worldRight.lengthSq() < 1e-6) {
    worldRight.set(1, 0, 0);
  } else {
    worldRight.normalize();
  }

  const restTip = new THREE.Vector3();
  tipTarget.getWorldPosition(restTip);

  const axisCandidates = [
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1),
  ];

  let bestScore = -Infinity;
  const bestAxis = new THREE.Vector3(1, 0, 0);
  let bestSign = -1;
  const movedTip = new THREE.Vector3();
  const displacement = new THREE.Vector3();
  const testQuat = new THREE.Quaternion();
  const testAngle = 0.14;

  axisCandidates.forEach((axis) => {
    [1, -1].forEach((sign) => {
      jawBone.quaternion.copy(jawInitialQuaternion);
      testQuat.setFromAxisAngle(axis, sign * testAngle);
      jawBone.quaternion.multiply(testQuat);
      jawBone.updateWorldMatrix(true, true);
      tipTarget.getWorldPosition(movedTip);

      displacement.copy(movedTip).sub(restTip);
      const downward = -displacement.dot(worldUp);
      const sideways = Math.abs(displacement.dot(worldRight));
      const depth = Math.abs(displacement.dot(worldForward));
      const score = downward * 2.2 + depth * 0.4 - sideways * 2.6;

      if (score > bestScore) {
        bestScore = score;
        bestAxis.copy(axis);
        bestSign = sign;
      }
    });
  });

  jawBone.quaternion.copy(jawInitialQuaternion);
  jawBone.updateWorldMatrix(true, true);

  jawOpenAxis.copy(bestAxis);
  jawOpenSign = bestSign;
  console.info(
    `Jaw calibration axis=${jawOpenAxis.x},${jawOpenAxis.y},${jawOpenAxis.z} sign=${jawOpenSign}`
  );
}

function setLipSyncInfluence(influence, delta = 1 / 60) {
  const clamped = THREE.MathUtils.clamp(influence, 0, 1);
  const active = Math.pow(THREE.MathUtils.clamp(speechState.activity, 0, 1), 0.85);
  const openInfluence = Math.pow(clamped, 0.82) * (0.62 + active * 0.38);

  if (currentAvatarKey === "female") {
    applyFemaleAvaturnViseme(delta);
    trackLipSyncDebug(clamped, openInfluence);
    return;
  }

  const applyCollection = (parts, amount) => {
    for (const part of parts) {
      if (!part.mesh.morphTargetInfluences) continue;
      part.mesh.morphTargetInfluences[part.index] = THREE.MathUtils.clamp(
        part.baseValue + amount * part.weight,
        0,
        1
      );
    }
  };

  applyCollection(talkingOpenParts, openInfluence);
  applyCollection(teethOpenParts, THREE.MathUtils.clamp(openInfluence, 0, 0.55));
  applyCollection(talkingWideParts, speechState.wide * active * 0.85);
  applyCollection(talkingRoundParts, speechState.round * active * 0.95);
  applyCollection(talkingConsonantParts, speechState.consonant * active * 0.90);
  applyCollection(talkingCloseParts, speechState.close * active * 0.85);
  const tongueActive = active * THREE.MathUtils.smoothstep(clamped, 0.025, 0.34);
  const tongueRaise =
    Math.max(speechState.consonant * 0.8, speechState.wide * 0.22 + speechState.round * 0.16) *
    tongueActive;
  const tongueOut =
    (speechState.consonant * 0.52 + speechState.close * 0.16) *
    tongueActive *
    (0.55 + clamped * 0.45);
  const tongueCurl =
    (speechState.round * 0.46 + speechState.consonant * 0.16) *
    tongueActive *
    0.9;
  applyCollection(tongueRaiseParts, tongueRaise);
  applyCollection(tongueOutParts, tongueOut);
  applyCollection(tongueCurlParts, tongueCurl);

  if (JAW_BONE_LIP_SYNC_ENABLED && jawBone && jawInitialQuaternion) {
    const jawTarget =
      clamped <= JAW_TARGET_GATE
        ? 0
        : Math.pow((clamped - JAW_TARGET_GATE) / (1 - JAW_TARGET_GATE), 0.92);
    const response = jawTarget > jawSmoothedInfluence ? JAW_SMOOTH_ATTACK : JAW_SMOOTH_RELEASE;
    const smoothing = Math.min(1, Math.max(0.001, delta * response));
    jawSmoothedInfluence += (jawTarget - jawSmoothedInfluence) * smoothing;
    const jawDriven = THREE.MathUtils.smootherstep(jawSmoothedInfluence, 0, 1);

    jawDeltaQuat.setFromAxisAngle(jawOpenAxis, jawDriven * jawMaxAngle * jawOpenSign);
    jawBone.quaternion.copy(jawInitialQuaternion).multiply(jawDeltaQuat);
  }

  if (lowerTeethBone && lowerTeethInitialPosition) {
    const teethTarget = THREE.MathUtils.clamp(
      openInfluence * 0.95 + speechState.round * active * 0.18,
      0,
      1
    );
    const response = teethTarget > lowerTeethSmoothedInfluence ? 28 : 18;
    lowerTeethSmoothedInfluence +=
      (teethTarget - lowerTeethSmoothedInfluence) * Math.min(1, delta * response);
  }

  trackLipSyncDebug(clamped, openInfluence);
}

function applyLowerTeethOffset() {
  if (!lowerTeethBone || !lowerTeethInitialPosition) return;

  lowerTeethBone.position.copy(lowerTeethInitialPosition);
  if (lowerTeethSmoothedInfluence <= 0.001) return;

  if (!lowerTeethBone.parent) {
    lowerTeethBone.position.y -= LOWER_TEETH_MAX_DROP * lowerTeethSmoothedInfluence;
    return;
  }

  lowerTeethBone.parent.updateWorldMatrix(true, false);
  tempVecA.copy(lowerTeethBone.position);
  lowerTeethBone.parent.localToWorld(tempVecA);
  tempVecA.y -= LOWER_TEETH_MAX_DROP * lowerTeethSmoothedInfluence;
  lowerTeethBone.parent.worldToLocal(tempVecA);
  lowerTeethBone.position.copy(tempVecA);
}

function applyFemaleAvaturnViseme(delta) {
  if (currentAvatarKey !== "female") return;
  const targets = FEMALE_AVATURN_VISEMES[activeFemaleVisemeId] || FEMALE_AVATURN_VISEMES[0];
  const scale = THREE.MathUtils.clamp(femaleVisemeIntensity * 0.98, 0, 0.98);
  for (const part of femaleMouthMorphParts) {
    if (!part.mesh.morphTargetInfluences) continue;
    const target = (targets[part.normalizedKey] || 0) * scale;
    const current = (part.mesh.morphTargetInfluences[part.index] || 0) - part.baseValue;
    const response = target > current ? 8.5 : 5.5;
    const next = THREE.MathUtils.lerp(current, target, Math.min(1, delta * response));
    part.mesh.morphTargetInfluences[part.index] = THREE.MathUtils.clamp(
      part.baseValue + next,
      0,
      1
    );
  }
}

function resetLipSync() {
  mouthSmoothed = 0;
  activeFemaleVisemeId = 0;
  femaleVisemeIntensity = 0;
  jawSmoothedInfluence = 0;
  lowerTeethSmoothedInfluence = 0;
  speechState.activity = 0;
  speechState.wide = 0;
  speechState.round = 0;
  speechState.consonant = 0;
  speechState.close = 0;
  setLipSyncInfluence(0, 1);
}

function setBlink(strength) {
  const s = Math.max(0, Math.min(1, strength));
  const leftStrength = THREE.MathUtils.clamp(s + blinkLeadSide * BLINK_WINK_AMOUNT * s, 0, 1);
  const rightStrength = THREE.MathUtils.clamp(s - blinkLeadSide * BLINK_WINK_AMOUNT * s, 0, 1);
  for (const part of blinkPartsLeft) {
    if (!part.mesh.morphTargetInfluences) continue;
    part.mesh.morphTargetInfluences[part.index] = THREE.MathUtils.clamp(
      part.baseValue + leftStrength,
      0,
      1
    );
  }
  for (const part of blinkPartsRight) {
    if (!part.mesh.morphTargetInfluences) continue;
    part.mesh.morphTargetInfluences[part.index] = THREE.MathUtils.clamp(
      part.baseValue + rightStrength,
      0,
      1
    );
  }
}

function collectMorphTargets(mesh, matcher) {
  if (!mesh?.morphTargetDictionary || !mesh.morphTargetInfluences) return [];

  return Object.entries(mesh.morphTargetDictionary)
    .map(([key, index]) => ({
      normalizedKey: normalizeNodeName(key),
      index,
    }))
    .filter((entry) => matcher(entry.normalizedKey))
    .map((entry) => ({
      mesh,
      index: entry.index,
      baseValue: mesh.morphTargetInfluences[entry.index] ?? 0,
    }));
}

function detectBlinkTargets(model) {
  blinkPartsLeft = [];
  blinkPartsRight = [];

  model.traverse((child) => {
    if (!child.isMesh) return;
    blinkPartsLeft.push(...collectMorphTargets(child, (key) => BLINK_TARGET_LEFT_PATTERN.test(key)));
    blinkPartsRight.push(...collectMorphTargets(child, (key) => BLINK_TARGET_RIGHT_PATTERN.test(key)));
  });

  scheduleNextBlink(true);
  blinkT = 0;
  queuedBlinkCount = 0;
  blinkPauseTimer = 0;
  blinkStrength = 0;
  blinkLeadSide = 0;
  console.info(`Blink targets detected: L=${blinkPartsLeft.length}, R=${blinkPartsRight.length}`);
}

function randomInRange(min, max) {
  return min + Math.random() * (max - min);
}

function scheduleNextBlink(initial = false) {
  blinkInterval = initial ? randomInRange(1.2, 2.2) : randomInRange(3.8, 7.2);
}

function cleanupShirtBleed(model) {
  const shirtMesh = model.getObjectByName(SHIRT_MESH_NAME);
  const bodyMesh = model.getObjectByName(BODY_MESH_NAME);
  if (!shirtMesh?.isMesh || !bodyMesh?.isMesh || !bodyMesh.geometry) return;

  shirtMesh.scale.multiply(new THREE.Vector3(1.028, 1.012, 1.036));
  shirtMesh.updateMatrixWorld(true);

  const geometry = bodyMesh.geometry;
  if (geometry.userData.torsoTrimmed) return;

  const position = geometry.getAttribute("position");
  if (!position) return;

  geometry.computeBoundingBox();
  shirtMesh.geometry?.computeBoundingBox();
  const shirtBox = shirtMesh.geometry?.boundingBox;
  if (!geometry.boundingBox || !shirtBox) return;

  const shirtCenterX = (shirtBox.min.x + shirtBox.max.x) * 0.5;
  const shirtCenterZ = (shirtBox.min.z + shirtBox.max.z) * 0.5;
  const shirtWidth = shirtBox.max.x - shirtBox.min.x;
  const shirtDepth = shirtBox.max.z - shirtBox.min.z;
  const shirtHeight = shirtBox.max.y - shirtBox.min.y;
  const torsoMinY = shirtBox.min.y + shirtHeight * 0.04;
  const torsoMaxY = shirtBox.max.y - shirtHeight * 0.03;
  const torsoHalfWidth = shirtWidth * 0.4;
  const torsoHalfDepth = shirtDepth * 0.54;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const dx = x - shirtCenterX;
    const dz = z - shirtCenterZ;

    if (
      y < torsoMinY ||
      y > torsoMaxY ||
      Math.abs(dx) > torsoHalfWidth ||
      Math.abs(dz) > torsoHalfDepth
    ) {
      continue;
    }

    const yT = (y - torsoMinY) / Math.max(torsoMaxY - torsoMinY, 1e-4);
    const waistFalloff = 1 - Math.pow(Math.abs(yT - 0.5) / 0.5, 1.6);
    const sideFalloff = 1 - Math.pow(Math.abs(dx) / Math.max(torsoHalfWidth, 1e-4), 1.35);
    const frontFalloff = 1 - Math.pow(Math.abs(dz) / Math.max(torsoHalfDepth, 1e-4), 1.1);
    const influence = THREE.MathUtils.clamp(waistFalloff * sideFalloff * frontFalloff, 0, 1);
    if (influence <= 0) continue;

    const shoulderBias = THREE.MathUtils.smoothstep(yT, 0.52, 0.98);
    const shrinkX = 1 - (0.06 + shoulderBias * 0.14) * influence;
    const shrinkZ = 1 - (0.11 + shoulderBias * 0.08) * influence;
    position.setXYZ(i, shirtCenterX + dx * shrinkX, y, shirtCenterZ + dz * shrinkZ);
  }

  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.torsoTrimmed = true;
}

function applyAvatarStyling(model) {
  model.traverse((node) => {
    if (!node.isMesh && !node.isSkinnedMesh) return;
    const nodeName = normalizeNodeName(node.name);
    const materials = Array.isArray(node.material) ? node.material : [node.material];

    if (currentAvatarKey === "male") {
      if (
        nodeName.startsWith("ccbaseeyeocclusion") ||
        nodeName.includes("sideburnsstubble") ||
        nodeName.includes("circlesparse") ||
        nodeName.includes("mustachesparse") ||
        nodeName.includes("soulpatchsparse")
      ) {
        node.visible = false;
        return;
      }
      if (nodeName.includes("basictshirts")) {
        node.scale.set(1.028, 1.014, 1.028);
      }
    }

    for (const material of materials) {
      if (!material) continue;
      const materialName = normalizeNodeName(material.name);

      if (currentAvatarKey === "male") {
        material.metalness = 0;
        material.envMapIntensity = 0.25;
        if (materialName.includes("skin")) {
          material.roughness = materialName.includes("body") ? 0.82 : 0.79;
          material.envMapIntensity = 0.16;
          material.color?.set(materialName.includes("arm") ? 0xffeee4 : 0xfff3ec);
          if (material.normalMap && material.normalScale) {
            const normalLift = materialName.includes("head") ? 1.08 : 1.03;
            material.normalScale.set(normalLift, normalLift);
          }
        } else if (materialName.includes("tearline")) {
          material.transparent = true;
          material.opacity = 0.24;
          material.alphaTest = 0.02;
          material.depthWrite = false;
          material.roughness = 0.02;
          material.envMapIntensity = 0.2;
          material.side = THREE.FrontSide;
        } else if (materialName.includes("cornea")) {
          material.transparent = true;
          material.opacity = 0.3;
          material.depthWrite = false;
          material.roughness = 0.015;
          material.envMapIntensity = 0.22;
          material.side = THREE.FrontSide;
        } else if (materialName.includes("eye") && !materialName.includes("eyelash")) {
          material.roughness = 0.68;
          material.envMapIntensity = 0.055;
          material.color?.set(0xf3f0e8);
        } else if (materialName.includes("scalp")) {
          material.transparent = true;
          material.opacity = 0;
          material.depthWrite = false;
          material.alphaTest = 1;
        } else if (materialName.includes("eyelash")) {
          material.roughness = 0.9;
          material.envMapIntensity = 0.04;
          material.alphaTest = 0.78;
          material.transparent = true;
          material.opacity = 0.36;
          material.depthWrite = false;
        } else if (materialName.includes("browbase")) {
          material.roughness = 0.9;
          material.envMapIntensity = 0.04;
          material.color?.set(0xffffff);
          material.alphaTest = 1;
          material.transparent = true;
          material.opacity = 0;
          material.depthWrite = false;
        } else if (materialName.includes("brow")) {
          material.roughness = 0.9;
          material.envMapIntensity = 0.06;
          material.color?.set(0xffffff);
          material.alphaTest = 0.6;
          material.transparent = true;
          material.opacity = 0.68;
          material.depthWrite = false;
        } else if (materialName.includes("hair")) {
          material.roughness = 0.9;
          material.envMapIntensity = 0.08;
          material.alphaTest = 0.52;
          material.transparent = true;
          material.opacity = 0.78;
          material.depthWrite = false;
        } else if (materialName.includes("beard")) {
          material.roughness = 0.86;
          material.envMapIntensity = 0.12;
          material.alphaTest = 0.4;
          material.transparent = true;
          material.opacity = 0.72;
          material.depthWrite = false;
        } else if (materialName.includes("basictshirts")) {
          material.roughness = 0.92;
          material.envMapIntensity = 0.055;
          if (material.normalMap && material.normalScale) material.normalScale.set(1.34, 1.34);
          material.polygonOffset = true;
          material.polygonOffsetFactor = -1;
          material.polygonOffsetUnits = -1;
          material.depthWrite = true;
        } else if (materialName.includes("teeth")) {
          material.roughness = 0.62;
          material.envMapIntensity = 0.12;
        } else if (materialName.includes("tongue")) {
          material.roughness = 0.9;
          material.envMapIntensity = 0.05;
          material.color?.set(0x4f1f26);
        }
      } else if (currentAvatarKey === "female") {
        material.metalness = 0;
        material.envMapIntensity = 0.16;
        if (materialName.includes("hair")) {
          material.roughness = 0.98;
          material.envMapIntensity = 0.035;
          material.transparent = false;
          material.opacity = 1;
          material.alphaTest = materialName.includes("hair0") ? 0.56 : 0.36;
          material.alphaToCoverage = true;
          material.depthWrite = true;
          material.side = THREE.FrontSide;
        } else if (materialName === "avaturnlook0material") {
          material.roughness = 0.92;
          material.envMapIntensity = 0.065;
          if (material.normalMap && material.normalScale) material.normalScale.set(1.32, 1.32);
        } else if (materialName === "body" || materialName === "head") {
          material.roughness = 0.86;
          material.envMapIntensity = 0.12;
          if (material.normalMap && material.normalScale) material.normalScale.set(1.06, 1.06);
        } else if (materialName.includes("eye")) {
          material.roughness = 0.72;
          material.envMapIntensity = 0.08;
        }
      }

      material.needsUpdate = true;
    }
  });
}

function findFirstObject(root, names) {
  for (const name of names) {
    const found = root.getObjectByName(name);
    if (found) return found;
  }
  return null;
}

function buildPoseRig(root) {
  return {
    head: findFirstObject(root, ["CC_Base_Head", "mixamorig:Head", "Head"]),
    neckUpper: findFirstObject(root, ["CC_Base_NeckTwist02", "mixamorig:Neck", "Neck", "Neck1"]),
    neckLower: findFirstObject(root, ["CC_Base_NeckTwist01", "Neck1", "Neck"]),
    spineUpper: findFirstObject(root, ["CC_Base_Spine02", "mixamorig:Spine2", "Spine2"]),
    spineLower: findFirstObject(root, ["CC_Base_Spine01", "mixamorig:Spine1", "Spine1"]),
    clavicleL: findFirstObject(root, ["CC_Base_L_Clavicle", "mixamorig:LeftShoulder", "LeftShoulder"]),
    clavicleR: findFirstObject(root, ["CC_Base_R_Clavicle", "mixamorig:RightShoulder", "RightShoulder"]),
    upperArmL: findFirstObject(root, ["CC_Base_L_Upperarm", "mixamorig:LeftArm", "LeftArm"]),
    upperArmR: findFirstObject(root, ["CC_Base_R_Upperarm", "mixamorig:RightArm", "RightArm"]),
    forearmL: findFirstObject(root, ["CC_Base_L_Forearm", "mixamorig:LeftForeArm", "LeftForeArm"]),
    forearmR: findFirstObject(root, ["CC_Base_R_Forearm", "mixamorig:RightForeArm", "RightForeArm"]),
    handL: findFirstObject(root, ["CC_Base_L_Hand", "mixamorig:LeftHand", "LeftHand"]),
    handR: findFirstObject(root, ["CC_Base_R_Hand", "mixamorig:RightHand", "RightHand"]),
    eyeL: findFirstObject(root, ["CC_Base_L_Eye", "mixamorig:LeftEye", "LeftEye"]),
    eyeR: findFirstObject(root, ["CC_Base_R_Eye", "mixamorig:RightEye", "RightEye"]),
  };
}

function applyFirstAnimationFrame(root, gltf) {
  const clip = gltf.animations?.[0];
  if (!clip?.tracks?.length) return { applied: 0, tracks: 0, time: 0 };
  const firstKeyTime = clip.tracks.reduce((time, track) => {
    const trackTime = track.times?.length ? track.times[0] : time;
    return Math.min(time, trackTime);
  }, clip.duration || 0);
  let applied = 0;
  for (const track of clip.tracks) {
    if (!track.values?.length) continue;
    const [nodeName, propertyName] = track.name.split(".");
    const node = root.getObjectByName(nodeName);
    if (!node) continue;
    if (propertyName === "position") {
      node.position.fromArray(track.values, 0);
      applied += 1;
    } else if (propertyName === "quaternion") {
      node.quaternion.fromArray(track.values, 0).normalize();
      applied += 1;
    } else if (propertyName === "scale") {
      node.scale.fromArray(track.values, 0);
      applied += 1;
    }
  }
  root.updateMatrixWorld(true);
  return { applied, tracks: clip.tracks.length, time: firstKeyTime };
}

function capturePoseRest(rig) {
  poseRest = new Map();
  poseBase = new Map();
  for (const bone of Object.values(rig)) {
    if (!bone) continue;
    poseRest.set(bone, bone.quaternion.clone());
    poseBase.set(bone, bone.quaternion.clone());
  }
}

function capturePoseBase(useAnimatedBase) {
  if (!poseRig) return;
  for (const bone of Object.values(poseRig)) {
    if (!bone) continue;
    const target = poseBase.get(bone) || new THREE.Quaternion();
    const rest = poseRest.get(bone);
    const isDriven = useAnimatedBase && activeDrivenBones.has(bone.name);
    target.copy(isDriven ? bone.quaternion : rest || bone.quaternion);
    poseBase.set(bone, target);
  }
}

function applyLocalEulerOffset(bone, x = 0, y = 0, z = 0) {
  if (!bone) return;
  const base = poseBase.get(bone) || poseRest.get(bone);
  if (base) {
    bone.quaternion.copy(base);
  }
  tempEuler.set(x, y, z, "XYZ");
  tempQuat.setFromEuler(tempEuler);
  bone.quaternion.multiply(tempQuat);
}

function applyKevinFixedBodyPose(delta) {
  if (currentAvatarKey !== "male" || !poseRig) return;
  const breath = Math.sin(idleTime * 1.18);
  const slow = Math.sin(idleTime * 0.42 + 0.7);
  const focus = lipDrivenByAudio ? 0.35 : 1;

  applyLocalEulerOffset(poseRig.spineLower, breath * 0.0025, slow * 0.003 * focus, 0);
  applyLocalEulerOffset(poseRig.spineUpper, breath * 0.004, 0, 0.004 + slow * 0.003 * focus);
  applyLocalEulerOffset(poseRig.clavicleL, 0, 0.006, -0.012 + breath * 0.003);
  applyLocalEulerOffset(poseRig.clavicleR, 0, -0.004, 0.006 - breath * 0.002);

  if (poseRig.upperArmL) poseRig.upperArmL.rotation.set(0.055 - 0.008, -0.08, -1.46);
  if (poseRig.upperArmR) poseRig.upperArmR.rotation.set(0.055 + 0.006, 0.08, 1.46);
  if (poseRig.forearmL) poseRig.forearmL.rotation.set(0.035 + 0.012 + breath * 0.002, -0.02, -0.105);
  if (poseRig.forearmR) poseRig.forearmR.rotation.set(0.035 + 0.01 - breath * 0.0015, 0.02, 0.105);
  if (poseRig.handL) poseRig.handL.rotation.set(0, 0, 0.018);
  if (poseRig.handR) poseRig.handR.rotation.set(0, 0, -0.012);
}

function centerAvatar(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(tempVecA);
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box.min.y;
  root.position.y += MODEL_Y_OFFSET;
  root.updateMatrixWorld(true);
}

function getPortraitTarget(root, box, size) {
  const target = tempVecB.set(
    (box.min.x + box.max.x) * 0.5,
    box.min.y + size.y * 0.94,
    (box.min.z + box.max.z) * 0.5
  );

  if (!poseRig) return target;

  const facePoints = [];
  if (poseRig.eyeL) facePoints.push(poseRig.eyeL.getWorldPosition(new THREE.Vector3()));
  if (poseRig.eyeR) facePoints.push(poseRig.eyeR.getWorldPosition(new THREE.Vector3()));
  if (poseRig.head) facePoints.push(poseRig.head.getWorldPosition(new THREE.Vector3()));

  if (facePoints.length === 0) return target;

  target.set(0, 0, 0);
  for (const p of facePoints) target.add(p);
  target.multiplyScalar(1 / facePoints.length);
  target.y += size.y * 0.012;
  return target;
}

function frameBust(root) {
  if (!root) return;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(tempVecA);
  const target = getPortraitTarget(root, box, size);
  const bustHeight = Math.max(size.y * 0.115, 0.34);
  const shoulderWidth = Math.max(size.x * 0.22, 0.3);
  const halfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
  const distHeight = (bustHeight * 0.5) / Math.tan(halfFov);
  const distWidth =
    (shoulderWidth * 0.5) / (Math.tan(halfFov) * Math.max(camera.aspect, 0.7));
  const distance = Math.max(distHeight, distWidth) + size.z * 1.15;

  camera.position.set(target.x, target.y + size.y * 0.038, box.max.z + distance * 0.8);
  camera.lookAt(target);
}

function normalizeNodeName(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getTrackNodeName(trackName) {
  if (!trackName) return "";
  return trackName.split(".")[0];
}

function extractTrackNodeCandidates(trackName) {
  const candidates = new Set();
  const head = getTrackNodeName(trackName);
  if (head) {
    candidates.add(head);
    const tail = head.split("/").pop();
    if (tail) candidates.add(tail);
  }

  const bracketRegex = /\[(?:'|")?([^'"\]]+)(?:'|")?\]/g;
  let match = bracketRegex.exec(trackName);
  while (match) {
    if (match[1]) candidates.add(match[1]);
    match = bracketRegex.exec(trackName);
  }

  return Array.from(candidates);
}

function isMorphTrack(trackName) {
  return /\.morphTargetInfluences(?:\[\d+\])?$/.test(trackName || "");
}

function isFacialTrack(track, resolvedNodeName = "") {
  if (!track) return false;
  if (isMorphTrack(track.name)) return true;
  const normalizedNodeName = normalizeNodeName(resolvedNodeName || getTrackNodeName(track.name));
  return FACIAL_TRACK_EXCLUDE_PATTERN.test(normalizedNodeName);
}

function buildNodeNameMaps(model) {
  const exactNames = new Set();
  const normalizedToExact = new Map();

  model.traverse((child) => {
    if (!child.name) return;
    exactNames.add(child.name);
    const normalized = normalizeNodeName(child.name);
    if (normalized && !normalizedToExact.has(normalized)) {
      normalizedToExact.set(normalized, child.name);
    }
  });

  return { exactNames, normalizedToExact };
}

function sanitizeClipForModel(clip, model) {
  if (!clip) return null;

  const { exactNames, normalizedToExact } = buildNodeNameMaps(model);
  const filteredTracks = [];

  clip.tracks.forEach((track) => {
    if (track.name.endsWith(".scale")) return;

    const candidates = extractTrackNodeCandidates(track.name);
    if (candidates.length === 0) return;

    let resolvedNodeName = null;
    for (const candidate of candidates) {
      if (THREE.PropertyBinding.findNode(model, candidate)) {
        resolvedNodeName = candidate;
        break;
      }
      if (exactNames.has(candidate)) {
        resolvedNodeName = candidate;
        break;
      }
      const normalized = normalizeNodeName(candidate);
      const remappedNodeName = normalizedToExact.get(normalized);
      if (remappedNodeName && THREE.PropertyBinding.findNode(model, remappedNodeName)) {
        resolvedNodeName = remappedNodeName;
        break;
      }
    }

    if (!resolvedNodeName) return;
    if (isFacialTrack(track, resolvedNodeName)) return;

    if (track.name.endsWith(".position")) {
      const normalizedNode = normalizeNodeName(resolvedNodeName);
      const rootLike =
        normalizedNode === "hips" ||
        normalizedNode.endsWith("hips") ||
        normalizedNode.endsWith("root") ||
        normalizedNode.includes("boneroot") ||
        normalizedNode.includes("pelvis");
      if (rootLike && track.values?.length) {
        let maxAbs = 0;
        for (let i = 0; i < track.values.length; i += 1) {
          maxAbs = Math.max(maxAbs, Math.abs(track.values[i]));
        }
        if (maxAbs > 5) return;
      }
    }

    const originalNodeName = getTrackNodeName(track.name);
    if (resolvedNodeName === originalNodeName) {
      filteredTracks.push(track);
    } else {
      const remappedTrack = track.clone();
      remappedTrack.name = track.name.replace(originalNodeName, resolvedNodeName);
      filteredTracks.push(remappedTrack);
    }
  });

  if (filteredTracks.length === 0) return null;
  return new THREE.AnimationClip(clip.name, clip.duration, filteredTracks);
}

function getClipBodyMotionScore(clip, model) {
  if (!clip?.tracks) return 0;
  let boneQuatTracks = 0;
  clip.tracks.forEach((track) => {
    if (!track.name.endsWith(".quaternion")) return;
    const node = THREE.PropertyBinding.findNode(model, getTrackNodeName(track.name));
    if (node?.isBone) boneQuatTracks += 1;
  });
  return boneQuatTracks;
}

function trackHasChange(track, epsilon = 1e-5) {
  const values = track.values;
  const valueSize = track.getValueSize();
  if (!values || values.length <= valueSize) return false;

  for (let i = valueSize; i < values.length; i += valueSize) {
    for (let j = 0; j < valueSize; j += 1) {
      if (Math.abs(values[i + j] - values[j]) > epsilon) return true;
    }
  }
  return false;
}

function clipHasMeaningfulMotion(clip) {
  if (!clip?.tracks?.length) return false;
  const boneTracks = clip.tracks.filter(
    (track) => track.name.endsWith(".quaternion") || track.name.endsWith(".position")
  );
  if (boneTracks.length === 0) return false;
  return boneTracks.some((track) => trackHasChange(track));
}

function isUsableBodyClip(clip, model) {
  return getClipBodyMotionScore(clip, model) >= 20;
}

function pickBestNativeClips(rawClips, model, count = 3) {
  return (rawClips || [])
    .map((clip) => sanitizeClipForModel(clip, model))
    .filter(
      (clip) =>
        clip &&
        clip.tracks?.length &&
        isUsableBodyClip(clip, model) &&
        clipHasMeaningfulMotion(clip)
    )
    .sort((a, b) => getClipBodyMotionScore(b, model) - getClipBodyMotionScore(a, model))
    .slice(0, count);
}

function isSafePlayableClip(clip, model) {
  return !!clip && isUsableBodyClip(clip, model) && clipHasMeaningfulMotion(clip);
}

function getDrivenBonesForClip(clip, model) {
  const driven = new Set();
  if (!clip?.tracks) return driven;
  clip.tracks.forEach((track) => {
    if (!track.name.endsWith(".quaternion")) return;
    const nodeName = getTrackNodeName(track.name);
    const node = THREE.PropertyBinding.findNode(model, nodeName);
    if (node?.isBone) driven.add(node.name);
  });
  return driven;
}

function setCurrentAction(action, name) {
  currentAction = action;
  activeDrivenBones = actionDrivenBones.get(name) || new Set();
}

function playAction(name, fade = 0.45) {
  const nextAction = actions[name];
  if (!nextAction || nextAction === currentAction) return;

  if (currentAction) currentAction.fadeOut(fade);
  nextAction.reset();
  nextAction.fadeIn(fade).play();
  setCurrentAction(nextAction, name);
}

function transitionToIdle(fade = 0.25) {
  if (!idleAction || currentAction === idleAction) return;
  if (currentAction) currentAction.fadeOut(fade);
  idleAction.reset();
  idleAction.fadeIn(fade).play();
  setCurrentAction(idleAction, "idle");
}

async function loadOptionalGltf(loader, url) {
  try {
    return await loader.loadAsync(url);
  } catch (error) {
    console.warn(`Failed to load ${url}:`, error);
    return null;
  }
}

async function initAvatar() {
  const loader = new GLTFLoader();
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.6/");
  loader.setDRACOLoader(dracoLoader);
  setStatus("Loading avatar…");

  const avatar = AVATARS[currentAvatarKey] || AVATARS.male;
  const avatarGltf = await loader.loadAsync(avatar.url);
  const model = avatarGltf.scene;
  const exportedPose = currentAvatarKey === "female"
    ? applyFirstAnimationFrame(model, avatarGltf)
    : null;
  avatarRoot = model;
  model.visible = false;
  centerAvatar(model);
  scene.add(model);
  applyAvatarStyling(model);
  cleanupShirtBleed(model);
  poseRig = buildPoseRig(model);
  capturePoseRest(poseRig);
  detectLipSyncTargets(model);
  detectBlinkTargets(model);
  frameBust(model);
  resetLipSync();
  setBlink(0);

  mixer = new THREE.AnimationMixer(model);
  const emptyIdleClip = new THREE.AnimationClip("idle-empty", 1, []);
  idleAction = mixer.clipAction(emptyIdleClip);
  idleAction.setLoop(THREE.LoopRepeat, Infinity);
  idleAction.clampWhenFinished = false;
  actions.idle = idleAction;
  actionDrivenBones.set("idle", new Set());

  idleAction.play();
  setCurrentAction(idleAction, "idle");
  mixer.update(1 / 60);
  updatePose(1 / 60);
  model.visible = true;
  frameBust(model);

  if (!participantActive) setStatus("Avatar ready.");
  else if (!sessionPaused && !requestInFlight && !gameComplete) setStatus("Session ready.");
  avatarReady = true;
  updateSpeakButtonState();
  updateSendButtonState();
}

function switchAvatar(nextKey) {
  if (!Object.prototype.hasOwnProperty.call(AVATARS, nextKey) || nextKey === currentAvatarKey) return;
  persistAvatarKey(nextKey);
  const url = new URL(window.location.href);
  url.searchParams.set("avatar", nextKey);
  window.location.href = url.toString();
}

window.addEventListener("resize", () => {
  const { width, height } = getViewportSize();
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  frameBust(avatarRoot);
});

let mouthSmoothed = 0;
let blinkT = 0;
let blinkStrength = 0;
let blinkInterval = 1.1;
let queuedBlinkCount = 0;
let blinkPauseTimer = 0;
let lipClosePulsePhase = 0;
let blinkLeadSide = 0;
const speechState = {
  activity: 0,
  wide: 0,
  round: 0,
  consonant: 0,
  close: 0,
};

console.info(`[finalAnim] build ${BUILD_ID}`);

function updateBlink(delta) {
  if (blinkPartsLeft.length === 0 || blinkPartsRight.length === 0) return;

  if (blinkPauseTimer > 0) {
    blinkPauseTimer = Math.max(0, blinkPauseTimer - delta);
    blinkStrength = 0;
    setBlink(0);
    return;
  }

  blinkT += delta;

  if (queuedBlinkCount <= 0) {
    if (blinkT < blinkInterval) {
      blinkStrength = 0;
      setBlink(0);
      return;
    }
    queuedBlinkCount = Math.random() < 0.14 ? 2 : 1;
    blinkT = 0;
    blinkLeadSide = Math.random() < 0.5 ? -1 : 1;
  }

  const closePhase = BLINK_DURATION * 0.38;
  const openPhase = BLINK_DURATION - closePhase;
  let influence = 0;

  if (blinkT <= closePhase) {
    influence = blinkT / Math.max(closePhase, 1e-4);
  } else if (blinkT <= BLINK_DURATION) {
    influence = 1 - (blinkT - closePhase) / Math.max(openPhase, 1e-4);
  } else {
    queuedBlinkCount -= 1;
    blinkT = 0;
    influence = 0;
    if (queuedBlinkCount > 0) {
      blinkPauseTimer = randomInRange(0.05, 0.11);
      blinkLeadSide *= -0.35;
    } else {
      scheduleNextBlink(false);
      blinkLeadSide = 0;
    }
  }

  blinkStrength = THREE.MathUtils.clamp(influence * 1.1, 0, 1);
  setBlink(blinkStrength);
}

let audioCtx = null;
let analyser = null;
let freqData = null;
let currentReplyAudio = null;
let visemeCues = [];
let visemeCueIndex = 0;
const lipSyncDebug = {
  active: false,
  frames: 0,
  maxMouth: 0,
  maxOpen: 0,
  maxJaw: 0,
  startedAt: 0,
};

function beginLipSyncDebug() {
  lipSyncDebug.active = true;
  lipSyncDebug.frames = 0;
  lipSyncDebug.maxMouth = 0;
  lipSyncDebug.maxOpen = 0;
  lipSyncDebug.maxJaw = 0;
  lipSyncDebug.startedAt = performance.now();
}

function trackLipSyncDebug(mouthAmount, openAmount) {
  if (!lipSyncDebug.active) return;
  lipSyncDebug.frames += 1;
  lipSyncDebug.maxMouth = Math.max(lipSyncDebug.maxMouth, mouthAmount);
  lipSyncDebug.maxOpen = Math.max(lipSyncDebug.maxOpen, openAmount);
  lipSyncDebug.maxJaw = Math.max(lipSyncDebug.maxJaw, jawSmoothedInfluence);
}

function endLipSyncDebug() {
  if (!lipSyncDebug.active) return;
  lipSyncDebug.active = false;
  const elapsed = (performance.now() - lipSyncDebug.startedAt) / 1000;
  console.info(
    `[finalAnim] lip-sync debug frames=${lipSyncDebug.frames} seconds=${elapsed.toFixed(2)} maxMouth=${lipSyncDebug.maxMouth.toFixed(2)} maxOpen=${lipSyncDebug.maxOpen.toFixed(2)} maxJaw=${lipSyncDebug.maxJaw.toFixed(2)} cues=${visemeCues.length}`
  );
}

function ensureAudioGraph() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 32;
    analyser.smoothingTimeConstant = 0.16;
    freqData = new Uint8Array(analyser.frequencyBinCount);
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

function rmsFromAnalyser() {
  analyser.getByteFrequencyData(freqData);
  let sum = 0;
  const n = freqData.length;
  for (let i = 0; i < n; i += 1) sum += freqData[i];
  return n > 0 ? sum / n / 255 : 0;
}

function getAnalyserLoudness() {
  if (!analyser || !freqData) return 0;
  // Same math as THREE.AudioAnalyser.getAverageFrequency(), mapped like the pasted example.
  const averageFrequency = rmsFromAnalyser() * 255;
  return THREE.MathUtils.clamp(THREE.MathUtils.mapLinear(averageFrequency, 0, 80, 0, 1), 0, 1);
}

function getBandAverage(startRatio, endRatio) {
  if (!freqData || freqData.length === 0) return 0;
  const start = Math.max(0, Math.floor(freqData.length * startRatio));
  const end = Math.max(start + 1, Math.min(freqData.length, Math.ceil(freqData.length * endRatio)));
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += freqData[i];
  return sum / Math.max(1, end - start) / 255;
}

const AUDIO_LATENCY_OFFSET = 0.08; // 80ms latency offset to match Web Audio output

function getVisemeCueAt(time) {
  if (!visemeCues.length) return null;
  const lookupTime = Math.max(0, time - AUDIO_LATENCY_OFFSET);
  for (let i = 0; i < visemeCues.length; i++) {
    const cue = visemeCues[i];
    const start = Number(cue.start || 0);
    const end = Number(cue.end || start);
    if (lookupTime >= start && lookupTime <= end) {
      return cue;
    }
  }
  return null;
}

function getAzureShapeTarget(id) {
  if (currentAvatarKey === "male") {
    switch (Number(id)) {
      case 0:
        return { mouth: 0, activity: 0, close: 0.2 };
      case 12:
        return { mouth: 0.18, activity: 0.82, close: 0.95, consonant: 0.3 };
      case 1:
      case 4:
        return { mouth: 0.72, activity: 1, wide: 0.62 };
      case 2:
      case 9:
      case 11:
        return { mouth: 1, activity: 1, wide: 0.28 };
      case 3:
      case 8:
      case 10:
        return { mouth: 0.82, activity: 1, round: 0.92 };
      case 5:
      case 13:
      case 21:
        return { mouth: 0.48, activity: 0.95, round: 0.48, consonant: 0.24 };
      case 6:
        return { mouth: 0.46, activity: 1, wide: 0.82, consonant: 0.2 };
      case 7:
        return { mouth: 0.3, activity: 0.95, round: 0.95 };
      case 14:
      case 17:
      case 19:
      case 20:
        return { mouth: 0.38, activity: 0.95, consonant: 0.82, wide: 0.24 };
      case 15:
      case 16:
      case 18:
        return { mouth: 0.32, activity: 0.98, consonant: 0.78, wide: 0.36 };
      default:
        return { mouth: 0, activity: 0, close: 0 };
    }
  }

  switch (Number(id)) {
    case 0: // silence
      return { mouth: 0, activity: 0, close: 0 };
    case 1: // AE
      return { mouth: 0.52, activity: 0.95, wide: 0.58 };
    case 2: // AA
      return { mouth: 0.88, activity: 1, wide: 0.24 };
    case 3: // AO
      return { mouth: 0.68, activity: 0.98, round: 0.82 };
    case 4: // EH
      return { mouth: 0.5, activity: 0.95, wide: 0.72 };
    case 5: // ER
      return { mouth: 0.34, activity: 0.92, round: 0.55 };
    case 6: // IY
      return { mouth: 0.36, activity: 0.96, wide: 0.82 };
    case 7: // UW
      return { mouth: 0.3, activity: 0.94, round: 0.95 };
    case 8: // OW
      return { mouth: 0.52, activity: 0.96, round: 0.88 };
    case 9: // AW
      return { mouth: 0.7, activity: 1, round: 0.38, wide: 0.2 };
    case 10: // OY
      return { mouth: 0.42, activity: 0.96, round: 0.62, wide: 0.28 };
    case 11: // AY
      return { mouth: 0.62, activity: 0.98, wide: 0.48 };
    case 12: // H
      return { mouth: 0.18, activity: 0.72, wide: 0.12 };
    case 13: // R
      return { mouth: 0.3, activity: 0.9, round: 0.48, consonant: 0.28 };
    case 14: // L
      return { mouth: 0.2, activity: 0.88, consonant: 0.7, tongue: 0.72 };
    case 15: // S, Z
      return { mouth: 0.2, activity: 0.9, consonant: 0.9, wide: 0.38 };
    case 16: // SH
      return { mouth: 0.24, activity: 0.92, consonant: 0.82, round: 0.45 };
    case 17: // TH
      return { mouth: 0.22, activity: 0.9, consonant: 0.84, tongue: 0.8 };
    case 18: // F, V
      return { mouth: 0.12, activity: 0.86, consonant: 0.95, close: 0.22 };
    case 19: // D, T, N
      return { mouth: 0.2, activity: 0.9, consonant: 0.82, tongue: 0.62 };
    case 20: // K, G
      return { mouth: 0.18, activity: 0.88, consonant: 0.76 };
    case 21: // P, B, M
      return { mouth: 0, activity: 0.92, consonant: 0.38, close: 1 };
    default:
      return { mouth: 0, activity: 0, close: 0 };
  }
}

function getVisemeShapeTarget(value) {
  if (value === undefined || value === null) {
    return { mouth: 0, activity: 0, close: 0 };
  }
  const num = Number(value);
  if (!isNaN(num) && String(value).trim() !== "") {
    return getAzureShapeTarget(num);
  }
  return { mouth: 0, activity: 0, close: 0 };
}

function computeVisemeLipSyncTarget(delta) {
  if (!currentReplyAudio || !visemeCues.length) return null;

  const cue = getVisemeCueAt(currentReplyAudio.currentTime || 0);
  activeFemaleVisemeId = currentAvatarKey === "female" ? Number(cue?.value || 0) : 0;
  const targetState = getVisemeShapeTarget(cue?.value);
  const loudness = getAnalyserLoudness();
  femaleVisemeIntensity = cue
    ? THREE.MathUtils.clamp(0.82 + loudness * 0.3, 0.82, 1)
    : 0;

  const isSilentValue =
    !cue?.value ||
    cue.value === 0 ||
    cue.value === 21 ||
    String(cue.value) === "0" ||
    String(cue.value) === "21";

  const energyScale = !isSilentValue
    ? THREE.MathUtils.clamp(0.75 + loudness * 0.35, 0.70, 1.10)
    : THREE.MathUtils.clamp(loudness * 0.32, 0, 0.3);

  const mouthTarget = THREE.MathUtils.clamp((targetState.mouth || 0) * energyScale, 0, 0.95);
  const activityTarget = THREE.MathUtils.clamp(
    Math.max(targetState.activity || 0, loudness * 0.85),
    0,
    1
  );
  const response = mouthTarget > mouthSmoothed ? LIP_SYNC_ATTACK * 1.05 : LIP_SYNC_RELEASE * 1.2;

  mouthSmoothed += (mouthTarget - mouthSmoothed) * Math.min(1, delta * response);
  speechState.activity += (activityTarget - speechState.activity) * Math.min(1, delta * 15);
  speechState.wide += ((targetState.wide || 0) - speechState.wide) * Math.min(1, delta * 12);
  speechState.round += ((targetState.round || 0) - speechState.round) * Math.min(1, delta * 15);
  speechState.consonant +=
    ((targetState.consonant || 0) - speechState.consonant) * Math.min(1, delta * 16);
  speechState.close += ((targetState.close || 0) - speechState.close) * Math.min(1, delta * 16);

  if (targetState.tongue) {
    speechState.consonant = Math.max(speechState.consonant, targetState.tongue);
  }

  return mouthSmoothed;
}

function computeLipSyncTarget(delta) {
  if (!analyser || !lipDrivenByAudio) {
    mouthSmoothed += (0 - mouthSmoothed) * Math.min(1, delta * (LIP_SYNC_RELEASE * 1.9));
    lipClosePulsePhase = 0;
    speechState.activity += (0 - speechState.activity) * Math.min(1, delta * 8);
    speechState.wide += (0 - speechState.wide) * Math.min(1, delta * 10);
    speechState.round += (0 - speechState.round) * Math.min(1, delta * 10);
    speechState.consonant += (0 - speechState.consonant) * Math.min(1, delta * 12);
    speechState.close += (0 - speechState.close) * Math.min(1, delta * 12);
    return mouthSmoothed;
  }

  const averageFrequency = getAnalyserLoudness();
  let target = THREE.MathUtils.mapLinear(averageFrequency, 0, 1, 0, 0.70);
  target = THREE.MathUtils.clamp(target, 0, 0.70);
  if (target < LIP_SYNC_GATE) target = 0;

  const smoothing = target > mouthSmoothed ? 0.34 : 0.16;
  mouthSmoothed = THREE.MathUtils.lerp(mouthSmoothed, target, smoothing);

  const lowBand = getBandAverage(0, 0.22);
  const highBand = getBandAverage(0.45, 1);
  const activityTarget = THREE.MathUtils.clamp(target * 1.35, 0, 1);
  const wideTarget = THREE.MathUtils.clamp(highBand * 0.18 + target * 0.08, 0, 0.22);
  const roundTarget = THREE.MathUtils.clamp(lowBand * 0.2 + target * 0.04, 0, 0.22);
  const consonantTarget = THREE.MathUtils.clamp(highBand * 0.14, 0, 0.18);

  speechState.activity += (activityTarget - speechState.activity) * Math.min(1, delta * 16);
  speechState.wide += (wideTarget - speechState.wide) * Math.min(1, delta * 12);
  speechState.round += (roundTarget - speechState.round) * Math.min(1, delta * 12);
  speechState.consonant += (consonantTarget - speechState.consonant) * Math.min(1, delta * 14);
  speechState.close += (0 - speechState.close) * Math.min(1, delta * 18);

  return mouthSmoothed;
}

let lipDrivenByAudio = false;
const clock = new THREE.Clock();
let avatarReady = false;
let avatarLoading = null;
let voiceModeEnabled = false;
let recognitionListening = false;
let requestInFlight = false;
let listenRestartTimer = null;
let participantActive = false;
let conversationSessionId = null;
let dialogueHistory = [];
let currentAvatarKey = getInitialAvatarKey();
let currentInteractionMode = getInitialInteractionMode();
let gameRound = 1;
let gameBank = 0;
let gameComplete = false;
let gamePhase = "Ready";
let confederatePollTimer = null;
let confederateSessions = [];
let confederateSelectedSessionId = "";
let confederateChatSignature = "";
let confederateListSignature = "";
const confederateDrafts = new Map();
const confederateChoices = new Map();
const confederateCards = new Map();
const confederateSubmissions = new Set();
let confederatePollInFlight = false;
let sessionPaused = false;
let sessionEpoch = 0;
let pendingInteraction = null;
let cancelReplyAudio = null;
let humanTypingTimer = null;
let lastHumanTypingText = "";
let pendingParticipantId = "";

function openRulesDialog(participantId = "") {
  pendingParticipantId = participantId;
  if (rulesConfirmBtn) {
    rulesConfirmBtn.textContent = participantId ? "Start session" : "Return to game";
  }
  if (rulesDialog && !rulesDialog.open) {
    rulesDialog.showModal();
  }
  window.setTimeout(() => rulesConfirmBtn?.focus(), 0);
}

function closeRulesDialog() {
  if (rulesDialog?.open) rulesDialog.close();
}

function confirmRules() {
  const participantId = pendingParticipantId;
  pendingParticipantId = "";
  closeRulesDialog();
  if (participantId) setParticipantActive(participantId);
}

function updatePose(delta) {
  if (!poseRig) return;

  idleTime += delta;
  const useAnimatedBase = activeDrivenBones.size > 0;
  capturePoseBase(useAnimatedBase);

  const wantsFocus = lipDrivenByAudio ? 1 : 0.35;
  talkFocus += (wantsFocus - talkFocus) * Math.min(1, delta * 4.5);

  const ambientBlend = currentAction && currentAction !== idleAction ? 0.35 : 1;
  const idleYaw =
    (Math.sin(idleTime * 0.42) * 0.07 + Math.sin(idleTime * 0.17) * 0.02) * ambientBlend;
  const idlePitch = Math.sin(idleTime * 0.31 + 0.7) * 0.035 * ambientBlend;
  const idleRoll = Math.sin(idleTime * 0.22 + 1.2) * 0.025 * ambientBlend;
  const breath = Math.sin(idleTime * 1.7) * 0.015;

  const lookYaw = THREE.MathUtils.lerp(idleYaw, 0, talkFocus);
  const lookPitch = THREE.MathUtils.lerp(idlePitch, -0.035, talkFocus);
  const lookRoll = THREE.MathUtils.lerp(idleRoll, 0, talkFocus);

  applyLocalEulerOffset(
    poseRig.spineLower,
    lookPitch * 0.04 + breath * 0.08,
    lookYaw * 0.05,
    0
  );
  applyLocalEulerOffset(
    poseRig.spineUpper,
    lookPitch * 0.08 + breath * 0.12,
    lookYaw * 0.08,
    lookRoll * 0.05
  );
  applyLocalEulerOffset(
    poseRig.neckLower,
    lookPitch * 0.18,
    lookYaw * 0.2,
    lookRoll * 0.05
  );
  applyLocalEulerOffset(
    poseRig.neckUpper,
    lookPitch * 0.22,
    lookYaw * 0.26,
    lookRoll * 0.08
  );
  applyLocalEulerOffset(
    poseRig.head,
    lookPitch * 0.42,
    lookYaw * 0.5,
    lookRoll * 0.12
  );
  applyLocalEulerOffset(poseRig.eyeL, lookPitch * 0.28, lookYaw * 0.42, 0);
  applyLocalEulerOffset(poseRig.eyeR, lookPitch * 0.28, lookYaw * 0.42, 0);

  if (!useAnimatedBase && currentAvatarKey === "male") {
    applyKevinFixedBodyPose(delta);
    return;
  }

  if (!useAnimatedBase && currentAvatarKey !== "female") {
    const shoulderLift = Math.sin(idleTime * 1.7 + 0.8) * 0.015;
    applyLocalEulerOffset(
      poseRig.clavicleL,
      breath * 0.08,
      -0.08 + lookYaw * 0.02,
      -0.18 - shoulderLift * 0.4
    );
    applyLocalEulerOffset(
      poseRig.clavicleR,
      breath * 0.08,
      0.08 + lookYaw * 0.02,
      0.18 + shoulderLift * 0.4
    );
    applyLocalEulerOffset(
      poseRig.upperArmL,
      0.2 + breath * 0.04,
      -0.12 + lookYaw * 0.03,
      -0.68
    );
    applyLocalEulerOffset(
      poseRig.upperArmR,
      0.2 + breath * 0.04,
      0.12 + lookYaw * 0.03,
      0.68
    );
    applyLocalEulerOffset(poseRig.forearmL, -0.14, 0.02, -0.12);
    applyLocalEulerOffset(poseRig.forearmR, -0.14, -0.02, 0.12);
    applyLocalEulerOffset(poseRig.handL, 0.04, 0, 0.08);
    applyLocalEulerOffset(poseRig.handR, 0.04, 0, -0.08);
  }
}

function tick() {
  requestAnimationFrame(tick);
  const delta = clock.getDelta();
  mixer?.update(delta);

  if (lipDrivenByAudio && analyser && hasLipSyncTargets()) {
    if (visemeCues.length > 0) {
      mouthSmoothed = computeVisemeLipSyncTarget(delta);
    } else {
      mouthSmoothed = computeLipSyncTarget(delta);
    }
    setLipSyncInfluence(mouthSmoothed, delta);
  } else if (!lipDrivenByAudio && mouthSmoothed > 0.002) {
    if (visemeCues.length > 0) {
      mouthSmoothed = computeVisemeLipSyncTarget(delta);
    } else {
      mouthSmoothed = computeLipSyncTarget(delta);
    }
    setLipSyncInfluence(mouthSmoothed, delta);
  } else if (!lipDrivenByAudio && mouthSmoothed <= 0.002) {
    setLipSyncInfluence(0, delta);
  }

  updateBlink(delta);
  updatePose(delta);
  applyLowerTeethOffset();
  renderer.render(scene, camera);
}

tick();

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

function updateSpeakButtonState() {
  if (!SpeechRecognition) {
    speakBtn.disabled = true;
    speakBtn.textContent = "Speak";
    speakBtn.classList.remove("listening");
    return;
  }

  speakBtn.disabled = !avatarReady || !participantActive || sessionPaused || requestInFlight || gameComplete;
  speakBtn.textContent = voiceModeEnabled ? "Stop speaking" : "Speak";
  speakBtn.classList.toggle("listening", voiceModeEnabled);
  updateAvatarButtonsState();
}

function updateSendButtonState() {
  if (!sendBtn || !chatInput) return;
  sendBtn.disabled = !avatarReady || !participantActive || sessionPaused || requestInFlight || gameComplete || !chatInput.value.trim();
  gameChoiceBtns.forEach((button) => {
    button.disabled = !avatarReady || !participantActive || sessionPaused || requestInFlight || gameComplete;
  });
  updateAvatarButtonsState();
}

function clearListeningRestartTimer() {
  if (!listenRestartTimer) return;
  window.clearTimeout(listenRestartTimer);
  listenRestartTimer = null;
}

function scheduleListeningRestart(delay = 350) {
  clearListeningRestartTimer();
  if (!voiceModeEnabled) return;
  listenRestartTimer = window.setTimeout(() => {
    listenRestartTimer = null;
    if (!voiceModeEnabled || sessionPaused || requestInFlight || gameComplete || lipDrivenByAudio || recognitionListening) return;
    startVoiceRecognition();
  }, delay);
}

async function playReplyAudio(base64, mime, mouthCues = []) {
  ensureAudioGraph();
  transitionToIdle(0.18);

  const bin = atob(base64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const blob = new Blob([buf], { type: mime || "audio/mpeg" });
  const url = URL.createObjectURL(blob);

  const audio = new Audio();
  audio.src = url;
  audio.crossOrigin = "anonymous";
  currentReplyAudio = audio;
  visemeCues = Array.isArray(mouthCues) ? mouthCues : [];
  visemeCueIndex = 0;
  beginLipSyncDebug();

  const srcNode = audioCtx.createMediaElementSource(audio);
  srcNode.connect(analyser);
  analyser.connect(audioCtx.destination);

  lipDrivenByAudio = true;
  resetLipSync();

  let settled = false;
  let watchdog;
  const cleanupAudio = () => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    audio.pause();
    audio.onended = audio.onerror = null;
    endLipSyncDebug();
    lipDrivenByAudio = false;
    currentReplyAudio = null;
    cancelReplyAudio = null;
    visemeCues = [];
    visemeCueIndex = 0;
    resetLipSync();
    URL.revokeObjectURL(url);
    try {
      srcNode.disconnect();
    } catch (_) {}
  };

  await new Promise((resolve, reject) => {
    watchdog = setTimeout(() => { cleanupAudio(); reject(new Error("Audio playback timed out. Resume to retry.")); }, 180000);
    cancelReplyAudio = () => {
      audio.pause();
      cleanupAudio();
      reject(new Error("Session changed."));
    };
    audio.onended = () => {
      cleanupAudio();
      if (voiceModeEnabled) {
        setStatus("Listening for your next question…");
      }
      resolve();
    };
    audio.onerror = (event) => {
      cleanupAudio();
      reject(event);
    };
    audioCtx
      .resume()
      .then(() => { if (!settled) return audio.play(); })
      .catch((error) => {
        cleanupAudio();
        reject(error);
      });
  });
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function queueHumanTypingUpdate(text) {
  if (!participantActive || !conversationSessionId) return;
  const nextText = String(text || "").slice(0, 500);
  if (nextText === lastHumanTypingText) return;
  lastHumanTypingText = nextText;
  if (humanTypingTimer) window.clearTimeout(humanTypingTimer);
  const sessionId = conversationSessionId;
  const epoch = sessionEpoch;
  humanTypingTimer = window.setTimeout(async () => {
    if (epoch !== sessionEpoch || !participantActive) return;
    try {
      await apiJSON("/api/human-typing", {
        method: "POST", body: JSON.stringify({ session_id: sessionId, text: nextText }),
      }, 10000);
    } catch (error) {
      console.warn("Could not send typing update:", error);
    }
  }, 180);
}

async function apiJSON(url, options = {}, timeout = 65000) {
  const response = await fetch(url, {
    ...options, headers: { "Content-Type": "application/json", ...options.headers },
    signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== "object") throw new Error("The server response was interrupted. Reconnect to continue.");
  if (!response.ok) {
    const error = new Error(data.error || "The connection failed. Reconnect to continue.");
    error.data = data;
    error.status = response.status;
    throw error;
  }
  return data;
}

function pendingStorageKey() {
  return `finalanim_pending_${conversationSessionId}`;
}

function readPendingInteraction() {
  try {
    const key = pendingStorageKey();
    const raw = window.sessionStorage.getItem(key) || window.localStorage.getItem(key);
    const item = JSON.parse(raw || "null");
    if (!item || !["/api/ask", "/api/split-steal", "/api/human-message", "/api/human-split-steal"].includes(item.endpoint)
        || item.body?.session_id !== conversationSessionId
        || !/^[A-Za-z0-9_-]{8,100}$/.test(item.body?.request_id || "")
        || (item.messageId && item.messageId !== item.body.request_id)) return null;
    window.sessionStorage.setItem(key, JSON.stringify(item));
    window.localStorage.removeItem(key);
    return item;
  } catch (_) { return null; }
}

function savePendingInteraction() {
  if (pendingInteraction) {
    try { window.sessionStorage.setItem(pendingStorageKey(), JSON.stringify(pendingInteraction)); }
    catch (_) { throw new Error("Browser storage is unavailable. Enable session storage before continuing."); }
  } else {
    try { window.sessionStorage.removeItem(pendingStorageKey()); } catch (_) {}
  }
}

async function restoreSessionAvatar(key, epoch) {
  if (!key || key === currentAvatarKey) return;
  await avatarLoading;
  assertCurrentSession(epoch);
  mixer?.stopAllAction();
  if (avatarRoot) {
    scene.remove(avatarRoot);
    avatarRoot.traverse((node) => {
      node.geometry?.dispose();
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      materials.forEach((material) => material?.dispose());
    });
  }
  Object.keys(actions).forEach((name) => delete actions[name]);
  actionDrivenBones.clear();
  avatarReady = false;
  currentAvatarKey = key;
  persistAvatarKey(key);
  avatarLoading = initAvatar();
  await avatarLoading;
  assertCurrentSession(epoch);
  updateAvatarButtonsState();
}

function interactionFromSummary(item) {
  const human = item.engine === "human";
  return {
    endpoint: item.kind === "choice"
      ? (human ? "/api/human-split-steal" : "/api/split-steal")
      : (human ? "/api/human-message" : "/api/ask"),
    body: {
      request_id: item.id, session_id: conversationSessionId, avatar: item.avatar || currentAvatarKey,
      ...(item.kind === "choice"
        ? { choice: item.participant_choice, expected_round: item.round }
        : { text: item.participant_text }),
    },
    messageId: item.id,
  };
}

function pauseSession(message, action = "Reconnect") {
  sessionPaused = true;
  stopVoiceRecognition();
  clearListeningRestartTimer();
  gamePhase = "Paused";
  recoveryMessage.textContent = message;
  recoveryButton.textContent = action;
  recoveryPanel.hidden = false;
  setStatus("Session paused. Reconnect to continue.");
  updateGamePanel();
  updateSpeakButtonState();
  updateSendButtonState();
}

function assertCurrentSession(epoch) {
  if (epoch !== sessionEpoch || !participantActive) throw new Error("Session changed.");
}

async function reconnectSession() {
  if (requestInFlight || !participantActive) return;
  const epoch = sessionEpoch;
  requestInFlight = true;
  sessionPaused = true;
  recoveryButton.disabled = true;
  updateSpeakButtonState();
  updateSendButtonState();
  try {
    const session = await registerParticipantSession();
    assertCurrentSession(epoch);
    await restoreSessionAvatar(session.avatar, epoch);
    const history = await apiJSON(`/api/history/${encodeURIComponent(conversationSessionId)}`);
    assertCurrentSession(epoch);
    dialogueHistory = (history.dialogue || []).slice(-50).map((turn) => ({
      type: "message", role: turn.role === "user" ? "You" : "Opponent", text: turn.content,
      requestId: turn.request_id, at: turn.timestamp,
    }));
    saveDialogueHistory();
    renderDialogueHistory();
    const outstanding = session.recoverable || [];
    if (outstanding.length) {
      const item = outstanding.find((entry) => entry.id === pendingInteraction?.body.request_id) || outstanding[0];
      if (pendingInteraction?.body.request_id !== item.id) pendingInteraction = interactionFromSummary(item);
      pendingInteraction.messageId = item.id;
      savePendingInteraction();
    }
    if (pendingInteraction) {
      await completeInteraction(epoch);
    }
    sessionPaused = false;
    recoveryPanel.hidden = true;
    gamePhase = gameComplete ? "Complete" : "Ready";
    setStatus(gameComplete ? `Session complete. Total bank: $${gameBank}.` : "Session ready.");
  } catch (error) {
    if (epoch === sessionEpoch) {
      if ([400, 409].includes(error.status) && !pendingInteraction?.messageId) {
        if (pendingInteraction?.body.text && !chatInput.value) chatInput.value = pendingInteraction.body.text;
        pendingInteraction = null;
        savePendingInteraction();
      }
      pauseSession(error.message || "Could not reconnect.", pendingInteraction ? "Resume response" : "Reconnect");
    }
  } finally {
    if (epoch === sessionEpoch) {
      requestInFlight = false;
      recoveryButton.disabled = false;
      updateGamePanel();
      updateSpeakButtonState();
      updateSendButtonState();
      if (!sessionPaused && voiceModeEnabled) scheduleListeningRestart(420);
    }
  }
}

async function completeInteraction(epoch) {
  const pending = pendingInteraction;
  const sid = encodeURIComponent(pending.body.session_id);
  const id = encodeURIComponent(pending.body.request_id);
  const base = `/api/interaction/${sid}/${id}`;
  let data;
  if (pending.messageId) {
    data = await apiJSON(base);
    assertCurrentSession(epoch);
  }
  if (!data || data.status === "interrupted") {
    data = await apiJSON(pending.endpoint, { method: "POST", body: JSON.stringify(pending.body) });
    assertCurrentSession(epoch);
    pending.messageId = data.message_id || pending.body.request_id;
    savePendingInteraction();
  }
  const finishCancelled = async () => {
    pendingInteraction = null;
    savePendingInteraction();
    await syncParticipantGameState();
    assertCurrentSession(epoch);
    throw new Error("The operator cancelled this response. Reconnect to continue.");
  };
  if (data.status === "cancelled") return finishCancelled();
  const startedAt = Date.now();
  if (data.status !== "ready") {
    setStatus("Waiting for your response...");
    gamePhase = "Waiting";
    updateGamePanel();
  }
  while (data.status !== "ready") {
    assertCurrentSession(epoch);
    if (Date.now() - startedAt >= HUMAN_POLL_TIMEOUT_MS) {
      throw new Error("The response is still pending. Resume to keep waiting for the same response.");
    }
    await delay(HUMAN_POLL_INTERVAL_MS);
    assertCurrentSession(epoch);
    data = await apiJSON(base);
    if (data.status === "cancelled") return finishCancelled();
    if (data.status === "interrupted") throw new Error("The response was interrupted. Resume to retry safely.");
  }
  assertCurrentSession(epoch);
  applyGameState(data);
  addDialogueEntry({ type: "message", role: "You", text: data.participant_text, requestId: pending.body.request_id });
  addDialogueEntry({ type: "message", role: "Opponent", text: data.reply || "", requestId: pending.body.request_id });
  setStatus(data.reply || "Response ready.");
  if (data.acknowledged) {
    pendingInteraction = null;
    savePendingInteraction();
    await syncParticipantGameState();
    assertCurrentSession(epoch);
    return;
  }
  if (!pending.presentationDone) {
    if (!data.audio_base64) {
      data = await apiJSON(`${base}/audio`, { method: "POST", body: "{}" });
      assertCurrentSession(epoch);
    }
    const audioStartedAt = Date.now();
    while (data.audio_pending && Date.now() - audioStartedAt < 45000) {
      await delay(900);
      assertCurrentSession(epoch);
      data = await apiJSON(`${base}/audio`, { method: "POST", body: "{}" });
      assertCurrentSession(epoch);
    }
    if (!data.audio_base64) {
      throw new Error("Your response is saved, but its audio is unavailable. Resume to retry audio without repeating the interaction.");
    }
    await avatarLoading;
    assertCurrentSession(epoch);
    await playReplyAudio(data.audio_base64, data.audio_mime, data.mouth_cues);
    assertCurrentSession(epoch);
    pending.presentationDone = true;
    savePendingInteraction();
  }
  await apiJSON(`${base}/ack`, { method: "POST", body: JSON.stringify({ presentation: "audio" }) });
  assertCurrentSession(epoch);
  pendingInteraction = null;
  savePendingInteraction();
  await syncParticipantGameState();
  assertCurrentSession(epoch);
}

async function sendInteraction(kind, value) {
  if (requestInFlight || sessionPaused || !participantActive || !conversationSessionId || gameComplete) return;
  const epoch = sessionEpoch;
  requestInFlight = true;
  stopVoiceRecognition();
  updateSpeakButtonState();
  updateSendButtonState();
  try {
    const mode = await getAssignedInteractionMode();
    assertCurrentSession(epoch);
    const human = mode === "human";
    pendingInteraction = {
      endpoint: kind === "choice"
        ? (human ? "/api/human-split-steal" : "/api/split-steal")
        : (human ? "/api/human-message" : "/api/ask"),
      body: { session_id: conversationSessionId, request_id: crypto.randomUUID(), avatar: currentAvatarKey,
        ...(kind === "choice" ? { choice: value, expected_round: gameRound } : { text: value }) },
    };
    savePendingInteraction();
    if (kind === "message") chatInput.value = "";
    queueHumanTypingUpdate("");
    gamePhase = "Waiting";
    updateGamePanel();
    setStatus("Preparing response...");
    await completeInteraction(epoch);
    setStatus(gameComplete ? `Session complete. Total bank: $${gameBank}.` : `Round ${gameRound} ready.`);
  } catch (error) {
    if (epoch === sessionEpoch) {
      // A rejected stale route/round never created this ID; use the server's pending record instead.
      if ([400, 409].includes(error.status) && !pendingInteraction?.messageId) {
        if (pendingInteraction?.body.text && !chatInput.value) chatInput.value = pendingInteraction.body.text;
        pendingInteraction = null;
        savePendingInteraction();
      }
      pauseSession(error.message || "The response was interrupted.", pendingInteraction ? "Resume response" : "Reconnect");
    }
  } finally {
    if (epoch === sessionEpoch) {
      requestInFlight = false;
      updateSpeakButtonState();
      updateSendButtonState();
      if (!sessionPaused && voiceModeEnabled) scheduleListeningRestart(420);
    }
  }
}

function sendRoutedTranscript(text) {
  const value = (text || "").trim();
  if (value) return sendInteraction("message", value);
}

function sendRoutedSplitStealChoice(choice) {
  if (["split", "steal"].includes(choice)) return sendInteraction("choice", choice);
}

recoveryButton.addEventListener("click", reconnectSession);

let recognition = null;
function initVoiceRecognition() {
  if (!SpeechRecognition || recognition) return;

  recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.continuous = false;

  recognition.onstart = () => {
    recognitionListening = true;
    setStatus("Listening… tap Stop speaking to end voice mode.");
    updateSpeakButtonState();
  };

  recognition.onresult = (ev) => {
    let interimTranscript = "";
    let finalTranscript = "";
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const transcript = ev.results[i][0]?.transcript?.trim();
      if (!transcript) continue;
      if (ev.results[i].isFinal) {
        finalTranscript += `${transcript} `;
      } else {
        interimTranscript += `${transcript} `;
      }
    }
    const preview = `${finalTranscript}${interimTranscript}`.trim();
    if (preview) setTranscript(preview);
    const finalQuestion = finalTranscript.trim();
    if (!finalQuestion) return;
    sendRoutedTranscript(finalQuestion);
    try {
      recognition.stop();
    } catch (_) {}
  };

  recognition.onerror = (ev) => {
    recognitionListening = false;
    updateSpeakButtonState();
    if (!voiceModeEnabled) return;

    if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
      setStatus("Microphone blocked. Allow mic access and try again.");
      voiceModeEnabled = false;
      updateSpeakButtonState();
      return;
    }

    if (ev.error === "no-speech") {
      setStatus("No speech detected. Still listening…");
      scheduleListeningRestart(350);
      return;
    }

    setStatus(`Speech error: ${ev.error}`);
    scheduleListeningRestart(800);
  };

  recognition.onend = () => {
    recognitionListening = false;
    updateSpeakButtonState();
    if (voiceModeEnabled && !requestInFlight && !lipDrivenByAudio) {
      scheduleListeningRestart(250);
    }
  };
}

function startVoiceRecognition() {
  if (!SpeechRecognition) {
    setStatus("Speech recognition is not supported in this browser. Try Chrome.");
    return;
  }
  if (requestInFlight || lipDrivenByAudio || recognitionListening) return;
  ensureAudioGraph();
  initVoiceRecognition();
  if (!recognition) return;
  try {
    recognition.start();
  } catch (_) {
    scheduleListeningRestart(650);
  }
}

function stopVoiceRecognition() {
  clearListeningRestartTimer();
  if (!recognition || !recognitionListening) return;
  try {
    recognition.stop();
  } catch (_) {}
}

function setVoiceModeEnabled(enabled) {
  const nextState = !!enabled;
  if (voiceModeEnabled === nextState) return;
  voiceModeEnabled = nextState;
  updateSpeakButtonState();

  if (voiceModeEnabled) {
    setStatus("Voice mode on. Start talking. Tap Stop speaking to end.");
    startVoiceRecognition();
  } else {
    stopVoiceRecognition();
    setStatus("Voice mode off.");
  }
}

speakBtn.addEventListener("click", () => {
  if (speakBtn.disabled) return;
  setVoiceModeEnabled(!voiceModeEnabled);
});

participantForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (currentInteractionMode === "confederate") {
    enterConfederateMode();
    return;
  }
  const participantId = normalizeParticipantId(participantInput?.value || "");
  if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
    setParticipantError("Use the assigned ID only: letters, numbers, dash, or underscore.");
    participantInput?.focus();
    return;
  }
  openRulesDialog(participantId);
});

openRulesBtn?.addEventListener("click", () => {
  openRulesDialog();
});

rulesConfirmBtn?.addEventListener("click", confirmRules);

rulesDialog?.addEventListener("cancel", () => {
  pendingParticipantId = "";
});

changeParticipantBtn?.addEventListener("click", () => {
  resetParticipant();
});

chatInput?.addEventListener("input", () => {
  updateSendButtonState();
  queueHumanTypingUpdate(chatInput.value || "");
});

chatInput?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  event.preventDefault();
  if (!chatForm) return;
  if (typeof chatForm.requestSubmit === "function") {
    chatForm.requestSubmit();
  } else {
    chatForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  }
});

chatForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = chatInput?.value || "";
  if (!value.trim()) return;
  sendRoutedTranscript(value);
  updateSendButtonState();
});

gameChoiceBtns.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    sendRoutedSplitStealChoice(button.dataset.choice || "");
  });
});

modeChoiceBtns.forEach((button) => {
  button.addEventListener("click", () => {
    setInteractionMode(button.dataset.mode || "ai");
  });
});

avatarChoiceBtns.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    switchAvatar(button.dataset.avatar || "");
  });
});

confederateBackBtn?.addEventListener("click", () => {
  exitConfederateMode();
});

confederateRefreshBtn?.addEventListener("click", () => {
  fetchConfederateSessions();
});

confederateOpenBtn?.addEventListener("click", () => {
  setInteractionMode("confederate");
});

updateSendButtonState();
renderDialogueHistory();
updateAvatarButtonsState();
updateModeButtonsState();
updateGamePanel();
if (currentInteractionMode === "confederate") {
  enterConfederateMode();
} else {
  participantInput?.focus();
}

avatarLoading = initAvatar();
avatarLoading.catch((error) => {
  console.error(error);
  setStatus("Could not load avatar or animations. Check the server.");
});
