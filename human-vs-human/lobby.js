// lobby.js — handles name entry + waiting for match before redirecting

const nameInput = document.getElementById("playerName");
const playBtn = document.getElementById("playBtn");
const lobbyStatusEl = document.getElementById("lobbyStatus");
const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{3,40}$/;

let socket;
let clientId = null;
let participantId = null;

function normalizeParticipantId(rawValue) {
  return (rawValue || "").trim().replace(/\s+/g, "").toUpperCase();
}

// Set up socket.io
function initSocket() {
  socket = io();

  socket.on("connect", () => {
    lobbyStatusEl.textContent =
      "Connected. Enter your participant ID and press Play.";
    playBtn.disabled = false;
  });

  socket.on("matchReady", (data) => {
    // Store match info & opponent for game page
    sessionStorage.setItem("matchId", data.matchId);
    sessionStorage.setItem("opponentName", data.opponentName);
    sessionStorage.setItem("totalRounds", String(data.totalRounds));
    sessionStorage.setItem("potPerRound", String(data.pot));
    // Go to game page
    window.location.href = "game.html";
  });

  socket.on("disconnect", () => {
    lobbyStatusEl.textContent =
      "Disconnected from server. Refresh to reconnect.";
    playBtn.disabled = true;
  });
}

playBtn.addEventListener("click", () => {
  if (!socket || !socket.connected) {
    alert("Not connected to server.");
    return;
  }

  const rawName = nameInput.value.trim();
  participantId = normalizeParticipantId(rawName);
  if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
    alert("Please enter the assigned participant ID from your slip.");
    nameInput.focus();
    return;
  }

  clientId = participantId;
  sessionStorage.setItem("clientId", participantId);
  sessionStorage.setItem("playerName", participantId);
  sessionStorage.setItem("participantId", participantId);

  lobbyStatusEl.textContent =
    "Registering your participant ID and joining the queue…";
  playBtn.disabled = true;

  socket.emit(
    "registerLobby",
    { clientId, name: participantId, participantId },
    (resp) => {
      if (!resp || !resp.ok) {
        alert(
          "Registration failed: " +
            (resp && resp.error ? resp.error : "Unknown error")
        );
        lobbyStatusEl.textContent =
          "Registration failed. Try again.";
        playBtn.disabled = false;
        return;
      }

      lobbyStatusEl.textContent = "Looking for an opponent…";
      socket.emit("joinQueue");
    }
  );
});

// Init
(function init() {
  initSocket();
})();
