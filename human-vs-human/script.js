// script.js — Game page: 7 rounds, $100 pot, 30s choice + 5s transition

const playerNameDisplay = document.getElementById("playerNameDisplay");
const opponentNameDisplay = document.getElementById("opponentNameDisplay");
const statusText = document.getElementById("statusText");
const phaseText = document.getElementById("phaseText");
const timerText = document.getElementById("timerText");

const splitBtn = document.getElementById("splitBtn");
const stealBtn = document.getElementById("stealBtn");
const resultText = document.getElementById("resultText");
const historyLog = document.getElementById("historyLog");
const roundCurrentEl = document.getElementById("roundCurrent");
const roundTotalEl = document.getElementById("roundTotal");
const potLabelEl = document.getElementById("potLabel");
const backToLobbyBtn = document.getElementById("backToLobbyBtn");

// Timer config
const CHOICE_DURATION = 30;      // 30s discuss + vote
const TRANSITION_DURATION = 5;   // 5s between rounds
const DEFAULT_TIMEOUT_CHOICE = "split"; // <-- change to "steal" if you want

let socket;
let clientId = null;
let playerName = null;
let opponentName = null;
let matchId = null;
let potPerRound = 100;
let currentRound = 0;
let totalRounds = 7;
let choiceLocked = false;
let sessionComplete = false;
let myRounds = [];

// timers
let choiceInterval = null;
let transitionInterval = null;
let choiceRemaining = 0;
let transitionRemaining = 0;

function loadSessionData() {
  clientId = sessionStorage.getItem("clientId");
  playerName = sessionStorage.getItem("playerName");
  matchId = sessionStorage.getItem("matchId");
  opponentName = sessionStorage.getItem("opponentName");
  const potStored = sessionStorage.getItem("potPerRound");
  const totalStored = sessionStorage.getItem("totalRounds");

  if (!clientId || !playerName || !matchId) {
    window.location.href = "index.html";
    return false;
  }

  potPerRound = potStored ? Number(potStored) : 100;
  totalRounds = totalStored ? Number(totalStored) : 7;
  return true;
}

function updateHeader() {
  roundCurrentEl.textContent = currentRound || "-";
  roundTotalEl.textContent = totalRounds || 7;
  potLabelEl.textContent = potPerRound;
}

function updateHistoryLog() {
  if (myRounds.length === 0) {
    historyLog.textContent = "No rounds yet.";
    return;
  }
  historyLog.textContent = myRounds
    .map((r) => {
      return (
        `Round ${r.round} vs ${r.opponentName} ` +
        `| You=${r.yourChoice.toUpperCase()}, Opp=${r.opponentChoice.toUpperCase()} ` +
        `| Payout=$${r.payout} | Outcome=${r.outcome}`
      );
    })
    .join("\n");
}

function describeOutcome(code, payout) {
  switch (code) {
    case "both-split":
      return `You both split and share the $${potPerRound} pot. You get $${payout}.`;
    case "p1-steals":
    case "p2-steals":
      if (payout > 0) {
        return `You stole the full $${potPerRound} pot. You get $${payout}.`;
      } else {
        return `Your opponent stole the full pot. You get $${payout}.`;
      }
    case "both-steal":
      return "Both tried to steal. No one gets anything this round.";
    default:
      return `Outcome: ${code}. You get $${payout}.`;
  }
}

// ---------- TIMERS ----------

function clearChoiceTimer() {
  if (choiceInterval) {
    clearInterval(choiceInterval);
    choiceInterval = null;
  }
}

function clearTransitionTimer() {
  if (transitionInterval) {
    clearInterval(transitionInterval);
    transitionInterval = null;
  }
}

function startChoicePhase() {
  if (sessionComplete) return;

  // Enable buttons only during choice phase
  choiceLocked = false;
  splitBtn.disabled = false;
  stealBtn.disabled = false;

  phaseText.textContent = "Phase: Choice (Discuss + Decide)";
  choiceRemaining = CHOICE_DURATION;
  timerText.textContent = `Timer: ${choiceRemaining}s`;

  statusText.textContent =
    `Round ${currentRound} of ${totalRounds} — ` +
    `you have ${CHOICE_DURATION} seconds to discuss and choose.`;

  clearChoiceTimer();
  clearTransitionTimer();

  choiceInterval = setInterval(() => {
    choiceRemaining -= 1;
    if (choiceRemaining < 0) choiceRemaining = 0;
    timerText.textContent = `Timer: ${choiceRemaining}s`;

    if (choiceRemaining <= 0) {
      clearChoiceTimer();

      // If player still hasn't chosen when timer ends, auto-submit default choice
      if (!choiceLocked && !sessionComplete && matchId) {
        lockChoice(DEFAULT_TIMEOUT_CHOICE, true);
      }
    }
  }, 1000);
}

function startTransitionPhase(isLastRound, nextRoundNumber) {
  clearChoiceTimer();
  clearTransitionTimer();

  if (isLastRound) {
    // No need for transition to a next round
    phaseText.textContent = "Phase: Session Complete";
    timerText.textContent = "Timer: —";
    return;
  }

  phaseText.textContent = "Phase: Transition";
  transitionRemaining = TRANSITION_DURATION;
  timerText.textContent = `Next round in: ${transitionRemaining}s`;

  // Keep the header showing the completed round during the transition.
  // When the transition ends, we advance the UI to the next round.

  splitBtn.disabled = true;
  stealBtn.disabled = true;

  transitionInterval = setInterval(() => {
    transitionRemaining -= 1;
    if (transitionRemaining < 0) transitionRemaining = 0;
    timerText.textContent = `Next round in: ${transitionRemaining}s`;

    if (transitionRemaining <= 0) {
      clearTransitionTimer();
      if (typeof nextRoundNumber === "number") {
        currentRound = nextRoundNumber;
        updateHeader();
      }

      // Next round choice phase begins
      startChoicePhase();
    }
  }, 1000);
}

// ---------- CHOICE SUBMISSION ----------

function lockChoice(choice, fromTimer = false) {
  if (!matchId || choiceLocked || sessionComplete) return;
  choiceLocked = true;

  splitBtn.disabled = true;
  stealBtn.disabled = true;

  if (fromTimer) {
    statusText.textContent =
      `Time is up. Automatically locked your choice as ${choice.toUpperCase()}. Waiting for opponent…`;
  } else {
    statusText.textContent =
      "Choice locked as " +
      choice.toUpperCase() +
      ". Waiting for opponent…";
  }

  resultText.textContent =
    "Your choice is locked. Waiting for opponent to choose.";

  socket.emit("playerChoice", {
    matchId,
    choice,
  });
}

// ---------- SOCKET.IO SETUP ----------

function initSocket() {
  socket = io();

  socket.on("connect", () => {
    statusText.textContent = "Connected. Joining your match…";

    socket.emit(
      "registerGame",
      { clientId, matchId },
      (resp) => {
        if (!resp || !resp.ok) {
          alert(
            "Failed to join match: " +
              (resp && resp.error ? resp.error : "Unknown error")
          );
          window.location.href = "index.html";
          return;
        }

        // Use server data to ensure consistency
        playerNameDisplay.textContent = resp.name || playerName;
        opponentName = resp.opponentName || opponentName || "Opponent";
        opponentNameDisplay.textContent = opponentName;

        currentRound = resp.round || 1;
        totalRounds = resp.totalRounds || totalRounds;
        potPerRound = resp.pot || potPerRound;

        updateHeader();

        resultText.textContent =
          "Round has started. Discuss and make your choice.";
        statusText.textContent =
          `Match joined vs ${opponentName}. Round ${currentRound} of ${totalRounds}.`;

        // Start 30s choice window for the first round
        startChoicePhase();
      }
    );
  });

  socket.on("roundResult", (data) => {
    // Stop choice timer (if still ticking)
    clearChoiceTimer();

    const completedRound = data.round;
    currentRound = completedRound;
    totalRounds = data.totalRounds || totalRounds;
    potPerRound = data.pot || potPerRound;
    opponentName = data.opponentName || opponentName || "Opponent";
    opponentNameDisplay.textContent = opponentName;
    updateHeader();

    const txt =
      `Round ${data.round} of ${data.totalRounds}: ` +
      `You chose ${data.yourChoice.toUpperCase()}, ` +
      `opponent chose ${data.opponentChoice.toUpperCase()}. ` +
      describeOutcome(data.outcome, data.payout);

    resultText.textContent = txt;
    statusText.textContent = data.isLastRound
      ? "Session complete. All 7 rounds have been played."
      : "Round complete. Transitioning to the next round…";

    myRounds.push({
      round: data.round,
      opponentName,
      yourChoice: data.yourChoice,
      opponentChoice: data.opponentChoice,
      payout: data.payout,
      outcome: data.outcome,
    });
    updateHistoryLog();

    if (data.isLastRound) {
      sessionComplete = true;
      splitBtn.disabled = true;
      stealBtn.disabled = true;
      backToLobbyBtn.style.display = "inline-flex";
      startTransitionPhase(true); // mark session complete in UI
    } else {
      // Start 5s transition, then begin the next round's 30s window
      const nextRound = completedRound + 1;
      startTransitionPhase(false, nextRound);
    }
  });

  socket.on("opponentLeft", () => {
    clearChoiceTimer();
    clearTransitionTimer();

    statusText.textContent =
      "Your opponent left the match. Session ended.";
    resultText.textContent =
      "Round cancelled (opponent disconnected). No payout this round.";
    splitBtn.disabled = true;
    stealBtn.disabled = true;
    sessionComplete = true;
    backToLobbyBtn.style.display = "inline-flex";
    phaseText.textContent = "Phase: Session Ended";
    timerText.textContent = "Timer: —";
  });

  socket.on("disconnect", () => {
    clearChoiceTimer();
    clearTransitionTimer();

    if (!sessionComplete) {
      statusText.textContent =
        "Disconnected from server. Refresh to reconnect.";
      splitBtn.disabled = true;
      stealBtn.disabled = true;
      phaseText.textContent = "Phase: Disconnected";
      timerText.textContent = "Timer: —";
    }
  });
}

// ---------- UI EVENTS ----------
splitBtn.addEventListener("click", () => lockChoice("split"));
stealBtn.addEventListener("click", () => lockChoice("steal"));
backToLobbyBtn.addEventListener("click", () => {
  window.location.href = "index.html";
});

// ---------- INIT ----------
(function init() {
  if (!loadSessionData()) return;
  playerNameDisplay.textContent = playerName;
  opponentNameDisplay.textContent = opponentName || "Opponent";
  updateHeader();
  updateHistoryLog();

  phaseText.textContent = "Phase: Waiting for round";
  timerText.textContent = "Timer: —";

  initSocket();
})();
