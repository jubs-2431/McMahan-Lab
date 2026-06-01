import * as THREE from "three";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const AVATARS = {
  male: { label: "Male", url: "/kevin.glb" },
  female: { label: "Female", url: "/female.glb" },
};
const MODEL_Y_OFFSET = 0;
const FACIAL_TRACK_EXCLUDE_PATTERN = /(head|neck|jaw|tongue|teeth|eye(?!brow)|upperjaw|tearline|eyeocclusion)/;
const BLINK_TARGET_LEFT_PATTERN = /^eyeblinkl$/;
const BLINK_TARGET_RIGHT_PATTERN = /^eyeblinkr$/;
const BLINK_DURATION = 0.16;
const BLINK_WINK_AMOUNT = 0.08;
const SHIRT_MESH_NAME = "Basic_T_shirts";
const BODY_MESH_NAME = "CC_Base_Body";
const LIP_SYNC_ATTACK = 48;
const LIP_SYNC_RELEASE = 28;
const LIP_SYNC_GATE = 0.01;
const JAW_SMOOTH_ATTACK = 34;
const JAW_SMOOTH_RELEASE = 22;
const JAW_TARGET_GATE = 0.02;
const LIP_SYNC_MESH_INCLUDE_PATTERN = /^(ccbasebody|ccbaseteeth|ccbasetongue)$/;
const LIP_SYNC_EXCLUDE_PATTERN = /(blink|brow|tongue|eye|squint|cheek|nostril|smile|frown|close|press|pucker|purse|funnel|stretch|narrow|roll|tight|suck)/;
const LIP_SYNC_OPEN_PATTERN = /(jawopen|mouthopen|openjaw|openmouth|vopen|vlipopen)/;
const LIP_SYNC_VOWEL_PATTERN = /(visemeaa|visemeah|visemeao|visemeoh|visemeou|phonemeaa|phonemeah|phonemeao|phonemeoh|phonemeou|vwide|vtighto)/;
const RHUBARB_CUE_LOOKAHEAD_SECONDS = 0.045;
const BUILD_ID = "20260601-finalanim-cue-driven-kevin";
const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{3,40}$/;

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
const participantForm = document.getElementById("participant-form");
const participantInput = document.getElementById("participant-id");
const participantError = document.getElementById("participant-error");
const participantLabel = document.getElementById("participant-label");
const changeParticipantBtn = document.getElementById("change-participant");
const HISTORY_STORAGE_KEY = "finalanim_dialogue_history";
const AVATAR_STORAGE_KEY = "finalanim_avatar_choice";

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

const hemi = new THREE.HemisphereLight(0xddeeff, 0x222233, 0.85);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 1.15);
key.position.set(2.5, 6, 4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xaabbff, 0.35);
fill.position.set(-3, 2, -2);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xffffff, 0.4);
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
let blinkPartsLeft = [];
let blinkPartsRight = [];
let jawBone = null;
let jawInitialQuaternion = null;
const jawOpenAxis = new THREE.Vector3(1, 0, 0);
let jawOpenSign = -1;
const jawDeltaQuat = new THREE.Quaternion();
const jawMaxAngle = 0.3;
let jawSmoothedInfluence = 0;

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
      item.textContent = `Split/Steal: You chose ${entry.userChoice}; Kevin chose ${entry.assistantChoice}. ${entry.outcomeText}`;
      const reply = document.createElement("div");
      reply.className = "history-meta";
      reply.textContent = `Kevin: ${entry.reply}`;
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
  dialogueHistory.push({ ...entry, at: new Date().toISOString() });
  dialogueHistory = dialogueHistory.slice(-50);
  saveDialogueHistory();
  renderDialogueHistory();
}

function getOutcomeText(outcome) {
  return {
    tie: "It is a tie.",
    user_wins: "You won.",
    assistant_wins: "Kevin won.",
    no_one_wins: "No one wins.",
  }[outcome] || "Round complete.";
}

function getInitialAvatarKey() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("avatar") || window.localStorage.getItem(AVATAR_STORAGE_KEY);
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
    button.disabled = requestInFlight || isActive;
    button.classList.toggle("active", isActive);
  });
}

function persistSessionId(sessionId) {
  conversationSessionId = sessionId || null;
}

function normalizeParticipantId(rawValue) {
  return (rawValue || "").trim().replace(/\s+/g, "").toUpperCase();
}

function setParticipantError(message) {
  if (participantError) participantError.textContent = message || "";
}

function setParticipantActive(sessionId) {
  conversationSessionId = sessionId;
  participantActive = true;
  dialogueHistory = loadDialogueHistory(sessionId);
  appEl?.classList.remove("needs-login");
  if (participantLabel) participantLabel.textContent = `Participant ID: ${sessionId}`;
  setParticipantError("");
  renderDialogueHistory();
  setStatus(avatarReady ? "Tap Speak to start continuous voice mode." : "Loading avatar...");
  updateSpeakButtonState();
  updateSendButtonState();
  window.setTimeout(() => chatInput?.focus(), 0);
}

function resetParticipant() {
  if (voiceModeEnabled) setVoiceModeEnabled(false);
  conversationSessionId = null;
  participantActive = false;
  dialogueHistory = [];
  appEl?.classList.add("needs-login");
  if (participantLabel) participantLabel.textContent = "Participant ID: --";
  if (participantInput) participantInput.value = "";
  setTranscript("");
  renderDialogueHistory();
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
    !!jawBone
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
  jawBone = null;
  jawInitialQuaternion = null;
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

    if (!child.isMesh || !child.morphTargetDictionary || !child.morphTargetInfluences) return;
    if (!LIP_SYNC_MESH_INCLUDE_PATTERN.test(normalizedName)) return;

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

      if (normalizedKey === "vopen") {
        registerPart(key, talkingOpenParts, 0.52);
      } else if (normalizedKey === "vlipopen") {
        registerPart(key, talkingOpenParts, 0.32);
      } else if (normalizedKey === "jawopen" || normalizedKey === "jawdown") {
        registerPart(key, talkingOpenParts, 0.17);
      } else if (normalizedKey === "mouthdroplower") {
        registerPart(key, talkingOpenParts, 0.14);
      } else if (normalizedKey === "mouthdropupper") {
        registerPart(key, talkingOpenParts, 0.06);
      } else if (normalizedKey === "vwide") {
        registerPart(key, talkingWideParts, 0.1);
      } else if (normalizedKey === "vtighto" || normalizedKey === "vtight") {
        registerPart(key, talkingRoundParts, normalizedKey === "vtighto" ? 0.13 : 0.08);
      } else if (normalizedKey === "vdentallip" || normalizedKey === "vaffricate") {
        registerPart(
          key,
          talkingConsonantParts,
          normalizedKey === "vdentallip" ? 0.11 : 0.09
        );
      } else if (normalizedKey === "mouthclose" || normalizedKey === "mouthcontract") {
        registerPart(key, talkingCloseParts, normalizedKey === "mouthclose" ? 0.1 : 0.05);
      } else if (
        normalizedKey === "tongueup" ||
        normalizedKey === "tonguetipup" ||
        normalizedKey === "tonguemidup" ||
        normalizedKey === "vtongueraise" ||
        normalizedKey === "vtongueup"
      ) {
        registerPart(key, tongueRaiseParts, 0.08);
      } else if (
        normalizedKey === "tongueout" ||
        normalizedKey === "tongueextend" ||
        normalizedKey === "vtongueout"
      ) {
        registerPart(key, tongueOutParts, 0.065);
      } else if (
        normalizedKey === "tongueroll" ||
        normalizedKey === "vtonguecurlu" ||
        normalizedKey === "vtonguecurld" ||
        normalizedKey === "tonguenarrow"
      ) {
        registerPart(key, tongueCurlParts, 0.05);
      }
    });
  });

  if (jawCandidates.length > 0) {
    jawCandidates.sort((a, b) => b.score - a.score);
    jawBone = jawCandidates[0].bone;
    jawInitialQuaternion = jawBone.quaternion.clone();
    calibrateJawMotion(model);
  }

  if (jawBone && talkingOpenParts.length > 0) {
    for (const part of talkingOpenParts) {
      part.weight *= 0.68;
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
  console.info(
    `Lip-sync targets: open=${talkingOpenParts.length}, wide=${talkingWideParts.length}, round=${talkingRoundParts.length}, consonant=${talkingConsonantParts.length}, close=${talkingCloseParts.length}, tongueRaise=${tongueRaiseParts.length}, tongueOut=${tongueOutParts.length}, tongueCurl=${tongueCurlParts.length}, jaw=${jawBone ? jawBone.name : "none"}`
  );
  console.info("Lip-sync open morphs:", uniqueOpenNames.join(", "));
  console.info("Lip-sync wide morphs:", uniqueWideNames.join(", "));
  console.info("Lip-sync round morphs:", uniqueRoundNames.join(", "));
  console.info("Lip-sync consonant morphs:", uniqueConsonantNames.join(", "));
  console.info("Lip-sync close morphs:", uniqueCloseNames.join(", "));
  console.info("Tongue raise morphs:", uniqueTongueRaiseNames.join(", "));
  console.info("Tongue out morphs:", uniqueTongueOutNames.join(", "));
  console.info("Tongue curl morphs:", uniqueTongueCurlNames.join(", "));
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
  const active = Math.pow(THREE.MathUtils.clamp(speechState.activity, 0, 1), 1.08);
  const openInfluence =
    Math.pow(clamped, 1.02) * (1.02 - speechState.close * 0.11) * (0.44 + active * 0.56);

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
  applyCollection(talkingWideParts, speechState.wide * active * 0.5);
  applyCollection(talkingRoundParts, speechState.round * active * 0.54);
  applyCollection(talkingConsonantParts, speechState.consonant * active * 0.62);
  applyCollection(talkingCloseParts, speechState.close * active * 0.78);
  const tongueActive = active * THREE.MathUtils.smoothstep(clamped, 0.025, 0.34);
  const tongueRaise =
    Math.max(speechState.consonant * 1.05, speechState.wide * 0.3 + speechState.round * 0.18) *
    tongueActive;
  const tongueOut =
    (speechState.consonant * 0.95 + speechState.close * 0.24) *
    tongueActive *
    (0.55 + clamped * 0.45);
  const tongueCurl =
    (speechState.round * 0.62 + speechState.consonant * 0.26) *
    tongueActive *
    0.9;
  applyCollection(tongueRaiseParts, tongueRaise);
  applyCollection(tongueOutParts, tongueOut);
  applyCollection(tongueCurlParts, tongueCurl);

  if (jawBone && jawInitialQuaternion) {
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

  trackLipSyncDebug(clamped, openInfluence);
}

function resetLipSync() {
  mouthSmoothed = 0;
  jawSmoothedInfluence = 0;
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
    neckUpper: findFirstObject(root, ["CC_Base_NeckTwist02", "mixamorig:Neck", "Neck"]),
    neckLower: findFirstObject(root, ["CC_Base_NeckTwist01", "Neck1"]),
    spineUpper: findFirstObject(root, ["CC_Base_Spine02", "mixamorig:Spine2", "Spine2"]),
    spineLower: findFirstObject(root, ["CC_Base_Spine01", "mixamorig:Spine1", "Spine1"]),
    clavicleL: findFirstObject(root, ["CC_Base_L_Clavicle", "mixamorig:LeftShoulder"]),
    clavicleR: findFirstObject(root, ["CC_Base_R_Clavicle", "mixamorig:RightShoulder"]),
    upperArmL: findFirstObject(root, ["CC_Base_L_Upperarm", "mixamorig:LeftArm"]),
    upperArmR: findFirstObject(root, ["CC_Base_R_Upperarm", "mixamorig:RightArm"]),
    forearmL: findFirstObject(root, ["CC_Base_L_Forearm", "mixamorig:LeftForeArm"]),
    forearmR: findFirstObject(root, ["CC_Base_R_Forearm", "mixamorig:RightForeArm"]),
    handL: findFirstObject(root, ["CC_Base_L_Hand", "mixamorig:LeftHand"]),
    handR: findFirstObject(root, ["CC_Base_R_Hand", "mixamorig:RightHand"]),
    eyeL: findFirstObject(root, ["CC_Base_L_Eye", "mixamorig:LeftEye", "LeftEye"]),
    eyeR: findFirstObject(root, ["CC_Base_R_Eye", "mixamorig:RightEye", "RightEye"]),
  };
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
  avatarRoot = model;
  model.visible = false;
  centerAvatar(model);
  scene.add(model);
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

  setStatus(
    hasLipSyncTargets()
      ? "Avatar ready. Tap Speak to start continuous voice mode."
      : "Avatar loaded. Tap Speak to start continuous voice mode."
  );
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
let rhubarbMouthCues = [];
let rhubarbCueIndex = 0;
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
    `[finalAnim] lip-sync debug frames=${lipSyncDebug.frames} seconds=${elapsed.toFixed(2)} maxMouth=${lipSyncDebug.maxMouth.toFixed(2)} maxOpen=${lipSyncDebug.maxOpen.toFixed(2)} maxJaw=${lipSyncDebug.maxJaw.toFixed(2)} cues=${rhubarbMouthCues.length}`
  );
}

function ensureAudioGraph() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.08;
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

function getBandAverage(startRatio, endRatio) {
  if (!freqData || freqData.length === 0) return 0;
  const start = Math.max(0, Math.floor(freqData.length * startRatio));
  const end = Math.max(start + 1, Math.min(freqData.length, Math.ceil(freqData.length * endRatio)));
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += freqData[i];
  return sum / Math.max(1, end - start) / 255;
}

function getRhubarbCueAt(time) {
  if (!rhubarbMouthCues.length) return null;
  const cueTime = time + RHUBARB_CUE_LOOKAHEAD_SECONDS;
  while (
    rhubarbCueIndex < rhubarbMouthCues.length - 1 &&
    cueTime >= Number(rhubarbMouthCues[rhubarbCueIndex].end || 0) + 0.01
  ) {
    rhubarbCueIndex += 1;
  }
  const cue = rhubarbMouthCues[rhubarbCueIndex];
  const start = Number(cue?.start || 0);
  const end = Number(cue?.end || start);
  return cueTime >= start - 0.018 && cueTime <= end + 0.05 ? cue : null;
}

function getRhubarbShapeTarget(shape) {
  switch (String(shape || "X").toUpperCase()) {
    case "A":
      return { mouth: 0.03, activity: 0.35, close: 0.82 };
    case "B":
      return { mouth: 0.07, activity: 0.95, consonant: 0.82, close: 0.78 };
    case "C":
      return { mouth: 0.38, activity: 1, wide: 0.82, close: 0.04 };
    case "D":
      return { mouth: 0.64, activity: 1, wide: 0.12 };
    case "E":
      return { mouth: 0.36, activity: 1, round: 0.86 };
    case "F":
      return { mouth: 0.26, activity: 1, round: 1, close: 0.1 };
    case "G":
      return { mouth: 0.12, activity: 0.96, consonant: 0.95, close: 0.42 };
    case "H":
      return { mouth: 0.34, activity: 1, wide: 0.18, consonant: 0.72, tongue: 0.95 };
    case "X":
    default:
      return { mouth: 0, activity: 0, close: 0 };
  }
}

function computeRhubarbLipSyncTarget(delta) {
  if (!currentReplyAudio || !rhubarbMouthCues.length) return null;

  const cue = getRhubarbCueAt(currentReplyAudio.currentTime || 0);
  const targetState = getRhubarbShapeTarget(cue?.value || "X");
  const mouthTarget = targetState.mouth || 0;
  const activityTarget = targetState.activity || 0;
  const response = mouthTarget > mouthSmoothed ? LIP_SYNC_ATTACK * 1.45 : LIP_SYNC_RELEASE * 1.55;

  mouthSmoothed += (mouthTarget - mouthSmoothed) * Math.min(1, delta * response);
  speechState.activity += (activityTarget - speechState.activity) * Math.min(1, delta * 20);
  speechState.wide += ((targetState.wide || 0) - speechState.wide) * Math.min(1, delta * 24);
  speechState.round += ((targetState.round || 0) - speechState.round) * Math.min(1, delta * 24);
  speechState.consonant +=
    ((targetState.consonant || 0) - speechState.consonant) * Math.min(1, delta * 30);
  speechState.close += ((targetState.close || 0) - speechState.close) * Math.min(1, delta * 30);

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

  const avgFreqNorm = rmsFromAnalyser();
  const freqEnergy = THREE.MathUtils.clamp((avgFreqNorm - 0.045) * 1.95, 0, 1);
  const lowBand = getBandAverage(0, 0.18);
  const midBand = getBandAverage(0.18, 0.5);
  const highBand = getBandAverage(0.5, 1);

  let rmsEnergy = 0;
  if (analyser && analyser.frequencyBinCount && audioCtx) {
    const timeData = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(timeData);
    let sumSquares = 0;
    for (let i = 0; i < timeData.length; i += 1) {
      const centered = (timeData[i] - 128) / 128;
      sumSquares += centered * centered;
    }
    const rms = Math.sqrt(sumSquares / timeData.length);
    rmsEnergy = THREE.MathUtils.clamp((rms - 0.014) * 26, 0, 1);
  }

  const loudness = Math.max(rmsEnergy, freqEnergy * 0.42);
  const activityTarget = THREE.MathUtils.clamp(loudness * 1.25, 0, 1);
  speechState.activity += (activityTarget - speechState.activity) * Math.min(1, delta * 13);
  const consonantDip = THREE.MathUtils.clamp((0.085 - rmsEnergy) * 3.2, 0, 0.28);
  let target = THREE.MathUtils.clamp((loudness - 0.035) * 1.05, 0, 0.58);
  let pulse = 0;
  let microClosure = 0;

  if (target > 0.06) {
    lipClosePulsePhase += delta * (8 + rmsEnergy * 7);
    pulse = Math.pow(Math.max(0, Math.sin(lipClosePulsePhase)), 4) * 0.06;
    microClosure =
      (0.006 + Math.max(0, midBand - lowBand) * 0.012) *
      (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(lipClosePulsePhase * 0.43 + 0.9)));
    target = Math.max(0, target - pulse);
  }

  target = Math.max(0, target - microClosure - consonantDip * 0.05);
  target = THREE.MathUtils.clamp(target, 0, 0.58);
  if (target < LIP_SYNC_GATE) target = 0;

  const wideTarget =
    THREE.MathUtils.clamp((highBand - lowBand * 0.42) * 1.05 + target * 0.06, 0, 0.14) *
    THREE.MathUtils.smoothstep(target, 0.1, 0.5);
  const roundTarget =
    THREE.MathUtils.clamp((lowBand - highBand * 0.5) * 0.95 + target * 0.05, 0, 0.12) *
    THREE.MathUtils.smoothstep(target, 0.08, 0.48);
  const consonantTarget =
    THREE.MathUtils.clamp((highBand - target * 0.42) * 0.5 + consonantDip * 0.08, 0, 0.1) *
    (1 - THREE.MathUtils.smoothstep(target, 0.3, 0.72));
  const closeTarget = THREE.MathUtils.clamp(
    pulse * 0.4 + consonantDip * 0.08 + microClosure * 0.45,
    0,
    0.1
  );

  speechState.wide += (wideTarget - speechState.wide) * Math.min(1, delta * 24);
  speechState.round += (roundTarget - speechState.round) * Math.min(1, delta * 24);
  speechState.consonant += (consonantTarget - speechState.consonant) * Math.min(1, delta * 30);
  speechState.close += (closeTarget - speechState.close) * Math.min(1, delta * 34);

  const response =
    target > mouthSmoothed
      ? LIP_SYNC_ATTACK
      : target === 0
        ? LIP_SYNC_RELEASE * 1.9
        : LIP_SYNC_RELEASE * 1.2;
  const previousMouth = mouthSmoothed;
  mouthSmoothed += (target - mouthSmoothed) * Math.min(1, delta * response);
  if (target > previousMouth) {
    mouthSmoothed = Math.max(mouthSmoothed, target * 0.78);
  }
  return mouthSmoothed;
}

let lipDrivenByAudio = false;
const clock = new THREE.Clock();
let avatarReady = false;
let voiceModeEnabled = false;
let recognitionListening = false;
let requestInFlight = false;
let listenRestartTimer = null;
let participantActive = false;
let conversationSessionId = null;
let dialogueHistory = [];
let currentAvatarKey = getInitialAvatarKey();

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

  if (!useAnimatedBase) {
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
      -1.02
    );
    applyLocalEulerOffset(
      poseRig.upperArmR,
      0.2 + breath * 0.04,
      0.12 + lookYaw * 0.03,
      1.02
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
    mouthSmoothed = rhubarbMouthCues.length
      ? computeRhubarbLipSyncTarget(delta)
      : computeLipSyncTarget(delta);
    setLipSyncInfluence(mouthSmoothed, delta);
  } else if (!lipDrivenByAudio && mouthSmoothed > 0.002) {
    mouthSmoothed = computeLipSyncTarget(delta);
    setLipSyncInfluence(mouthSmoothed, delta);
  } else if (!lipDrivenByAudio && mouthSmoothed <= 0.002) {
    setLipSyncInfluence(0, delta);
  }

  updateBlink(delta);
  updatePose(delta);
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

  speakBtn.disabled = !avatarReady || !participantActive;
  speakBtn.textContent = voiceModeEnabled ? "Stop speaking" : "Speak";
  speakBtn.classList.toggle("listening", voiceModeEnabled);
  updateAvatarButtonsState();
}

function updateSendButtonState() {
  if (!sendBtn || !chatInput) return;
  sendBtn.disabled = !avatarReady || !participantActive || requestInFlight || !chatInput.value.trim();
  gameChoiceBtns.forEach((button) => {
    button.disabled = !avatarReady || !participantActive || requestInFlight;
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
    if (!voiceModeEnabled || requestInFlight || lipDrivenByAudio || recognitionListening) return;
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
  rhubarbMouthCues = Array.isArray(mouthCues) ? mouthCues : [];
  rhubarbCueIndex = 0;
  beginLipSyncDebug();

  const srcNode = audioCtx.createMediaElementSource(audio);
  srcNode.connect(analyser);
  analyser.connect(audioCtx.destination);

  lipDrivenByAudio = true;
  resetLipSync();

  const cleanupAudio = () => {
    endLipSyncDebug();
    lipDrivenByAudio = false;
    currentReplyAudio = null;
    rhubarbMouthCues = [];
    rhubarbCueIndex = 0;
    resetLipSync();
    URL.revokeObjectURL(url);
    try {
      srcNode.disconnect();
    } catch (_) {}
  };

  await new Promise((resolve, reject) => {
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
      .then(() => audio.play())
      .catch((error) => {
        cleanupAudio();
        reject(error);
      });
  });
}

async function sendTranscript(text) {
  const cleanedText = (text || "").trim();
  if (!cleanedText || requestInFlight || !participantActive || !conversationSessionId) return;

  if (recognitionListening) {
    stopVoiceRecognition();
  }

  setTranscript(cleanedText);
  setStatus("Thinking…");
  requestInFlight = true;
  updateSpeakButtonState();
  updateSendButtonState();

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: cleanedText,
        session_id: conversationSessionId || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || res.statusText || "Request failed");
    }

    if (typeof data.session_id === "string" && data.session_id.trim()) {
      persistSessionId(data.session_id.trim());
    }

    setStatus(data.reply || "");
    addDialogueEntry({ type: "message", role: "You", text: cleanedText });
    addDialogueEntry({ type: "message", role: "Kevin", text: data.reply || "" });
    if (data.audio_base64) {
      await playReplyAudio(data.audio_base64, data.audio_mime, data.mouth_cues);
      if (!voiceModeEnabled) {
        setStatus("Tap Speak to start continuous voice mode.");
      }
    }
  } catch (e) {
    setStatus(String(e.message || e));
  } finally {
    requestInFlight = false;
    updateSpeakButtonState();
    updateSendButtonState();
    if (voiceModeEnabled && !lipDrivenByAudio) {
      scheduleListeningRestart(420);
    }
  }
}

async function sendSplitStealChoice(choice) {
  const normalizedChoice = (choice || "").trim().toLowerCase();
  if (!["split", "steal"].includes(normalizedChoice) || requestInFlight || !participantActive || !conversationSessionId) return;

  if (recognitionListening) {
    stopVoiceRecognition();
  }

  setTranscript(`I choose ${normalizedChoice}.`);
  setStatus("Kevin is choosing split or steal...");
  requestInFlight = true;
  updateSpeakButtonState();
  updateSendButtonState();

  try {
    const res = await fetch("/api/split-steal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        choice: normalizedChoice,
        session_id: conversationSessionId || undefined,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || res.statusText || "Request failed");
    }

    if (typeof data.session_id === "string" && data.session_id.trim()) {
      persistSessionId(data.session_id.trim());
    }

    setStatus(data.reply || "");
    addDialogueEntry({
      type: "split-steal",
      userChoice: data.user_choice || normalizedChoice,
      assistantChoice: data.assistant_choice || "unknown",
      outcome: data.outcome || "",
      outcomeText: getOutcomeText(data.outcome),
      reply: data.reply || "",
    });
    if (data.audio_base64) {
      await playReplyAudio(data.audio_base64, data.audio_mime, data.mouth_cues);
      if (!voiceModeEnabled) {
        setStatus(data.reply || "Tap Speak to start continuous voice mode.");
      }
    }
  } catch (e) {
    setStatus(String(e.message || e));
  } finally {
    requestInFlight = false;
    updateSpeakButtonState();
    updateSendButtonState();
    if (voiceModeEnabled && !lipDrivenByAudio) {
      scheduleListeningRestart(420);
    }
  }
}

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
    sendTranscript(finalQuestion);
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
  const participantId = normalizeParticipantId(participantInput?.value || "");
  if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
    setParticipantError("Use the assigned ID only: letters, numbers, dash, or underscore.");
    participantInput?.focus();
    return;
  }
  setParticipantActive(participantId);
});

changeParticipantBtn?.addEventListener("click", () => {
  resetParticipant();
});

chatInput?.addEventListener("input", () => {
  updateSendButtonState();
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
  sendTranscript(value);
  chatInput.value = "";
  updateSendButtonState();
});

gameChoiceBtns.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    sendSplitStealChoice(button.dataset.choice || "");
  });
});

avatarChoiceBtns.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled) return;
    switchAvatar(button.dataset.avatar || "");
  });
});

updateSendButtonState();
renderDialogueHistory();
updateAvatarButtonsState();
participantInput?.focus();

initAvatar().catch((error) => {
  console.error(error);
  setStatus("Could not load avatar or animations. Check the server.");
});
