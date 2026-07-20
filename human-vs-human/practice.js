// practice.js - starts a single-participant practice match with a fixed opponent choice

const nameInput = document.getElementById("playerName");
const practiceBtn = document.getElementById("practiceBtn");
const practiceStatusEl = document.getElementById("practiceStatus");
const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{3,40}$/;

let socket;

function normalizeParticipantId(rawValue) {
  return (rawValue || "").trim().replace(/\s+/g, "").toUpperCase();
}

function initSocket() {
  socket = io();

  socket.on("connect", () => {
    practiceStatusEl.textContent =
      "Connected. Enter your participant ID and start practice.";
    practiceBtn.disabled = false;
  });

  socket.on("disconnect", () => {
    practiceStatusEl.textContent =
      "Disconnected from server. Refresh to reconnect.";
    practiceBtn.disabled = true;
  });
}

practiceBtn.addEventListener("click", () => {
  if (!socket || !socket.connected) {
    alert("Not connected to server.");
    return;
  }

  const participantId = normalizeParticipantId(nameInput.value);
  if (!PARTICIPANT_ID_PATTERN.test(participantId)) {
    alert("Please enter the assigned participant ID from your slip.");
    nameInput.focus();
    return;
  }

  sessionStorage.setItem("clientId", participantId);
  sessionStorage.setItem("playerName", participantId);
  sessionStorage.setItem("participantId", participantId);

  practiceStatusEl.textContent = "Starting practice session...";
  practiceBtn.disabled = true;

  socket.emit(
    "startPractice",
    { clientId: participantId, name: participantId, participantId },
    (resp) => {
      if (!resp || !resp.ok) {
        alert(
          "Practice failed: " +
            (resp && resp.error ? resp.error : "Unknown error")
        );
        practiceStatusEl.textContent = "Practice failed. Try again.";
        practiceBtn.disabled = false;
        return;
      }

      sessionStorage.setItem("matchId", resp.matchId);
      sessionStorage.setItem("opponentName", resp.opponentName);
      sessionStorage.setItem("totalRounds", String(resp.totalRounds));
      sessionStorage.setItem("potPerRound", String(resp.pot));
      window.location.href = "game.html";
    }
  );
});

(function init() {
  practiceBtn.disabled = true;
  initSocket();
})();
