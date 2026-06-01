// server.js — Split or Steal with 2-page flow (lobby + game)
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const MAX_ROUNDS = 7;
const ROUND_POT = 100;
const LOG_PATH = path.join(__dirname, "rounds_log.csv");
const PARTICIPANT_LOG_ROOT = path.join(__dirname, "participant_logs");
const PARTICIPANT_ID_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;

// ---------- CSV LOGGING ----------
function ensureCsvHeader() {
  if (!fs.existsSync(LOG_PATH)) {
    const header =
      "timestamp,match_id,round,player_id,opponent_id,player_choice,opponent_choice,payout,outcome\n";
    fs.writeFileSync(LOG_PATH, header, "utf8");
  }
}

function logRound({
  timestamp,
  matchId,
  round,
  playerId,
  opponentId,
  playerChoice,
  opponentChoice,
  payout,
  outcome,
}) {
  ensureCsvHeader();
  const row =
    [
      timestamp,
      matchId,
      round,
      playerId,
      opponentId,
      playerChoice,
      opponentChoice,
      payout,
      outcome,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",") + "\n";

  fs.appendFile(LOG_PATH, row, (err) => {
    if (err) console.error("CSV write error:", err);
  });

  logParticipantRound({
    timestamp,
    matchId,
    round,
    playerId,
    opponentId,
    playerChoice,
    opponentChoice,
    payout,
    outcome,
  });
}

function normalizeParticipantId(value) {
  const candidate = String(value || "").trim().replace(/\s+/g, "").toUpperCase();
  return PARTICIPANT_ID_PATTERN.test(candidate) ? candidate : null;
}

function participantLogDir(participantId) {
  const safeId = normalizeParticipantId(participantId);
  if (!safeId) return null;
  const dir = path.join(PARTICIPANT_LOG_ROOT, safeId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonArray(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("JSON read error:", err);
    return [];
  }
}

function writeJson(filePath, payload) {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath, payload) {
  fs.appendFileSync(filePath, JSON.stringify(payload) + "\n", "utf8");
}

function appendParticipantCsv(filePath, row) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(
      filePath,
      "timestamp,match_id,round,participant_id,opponent_id,player_choice,opponent_choice,payout,outcome\n",
      "utf8"
    );
  }
  const line =
    [
      row.timestamp,
      row.matchId,
      row.round,
      row.playerId,
      row.opponentId,
      row.playerChoice,
      row.opponentChoice,
      row.payout,
      row.outcome,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",") + "\n";
  fs.appendFileSync(filePath, line, "utf8");
}

function logParticipantRound(row) {
  const dir = participantLogDir(row.playerId);
  if (!dir) return;
  const event = {
    type: "round",
    timestamp: row.timestamp,
    match_id: row.matchId,
    round: row.round,
    participant_id: row.playerId,
    opponent_id: row.opponentId,
    player_choice: row.playerChoice,
    opponent_choice: row.opponentChoice,
    payout: row.payout,
    outcome: row.outcome,
  };
  const roundsPath = path.join(dir, "rounds.json");
  const rounds = readJsonArray(roundsPath);
  rounds.push(event);
  writeJson(roundsPath, rounds);
  writeJson(path.join(dir, "session.json"), {
    participant_id: row.playerId,
    updated_at: row.timestamp,
    rounds,
  });
  appendJsonl(path.join(dir, "events.jsonl"), event);
  appendParticipantCsv(path.join(dir, "rounds.csv"), row);
}

// ---------- STATE ----------
/**
 * playersByClientId: clientId -> {
 *   clientId,
 *   name,
 *   lobbySocketId,
 *   gameSocketId,
 *   matchId
 * }
 */
const playersByClientId = new Map();
const socketToClientId = new Map();

/**
 * matches: matchId -> {
 *   matchId,
 *   clientIds: [c1, c2],
 *   round,
 *   maxRounds,
 *   pot,
 *   choices: { [clientId]: "split" | "steal" }
 * }
 */
const matches = new Map();

// Lobby queue of clientIds
let lobbyQueue = [];
let matchCounter = 1;

// ---------- HELPERS ----------
function randomClientId() {
  return (
    "C-" + Math.random().toString(36).substring(2, 8).toUpperCase()
  );
}

function computeOutcome(c1, c2) {
  const half = ROUND_POT / 2;
  if (c1 === "split" && c2 === "split") {
    return { code: "both-split", payout1: half, payout2: half };
  }
  if (c1 === "steal" && c2 === "split") {
    return { code: "p1-steals", payout1: ROUND_POT, payout2: 0 };
  }
  if (c1 === "split" && c2 === "steal") {
    return { code: "p2-steals", payout1: 0, payout2: ROUND_POT };
  }
  return { code: "both-steal", payout1: 0, payout2: 0 };
}

function removeFromQueue(clientId) {
  lobbyQueue = lobbyQueue.filter((id) => id !== clientId);
}

// ---------- EXPRESS ----------
app.use(express.static(__dirname));

// ---------- SOCKET.IO ----------
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("registerLobby", (data, callback) => {
    const normalizedParticipantId =
      normalizeParticipantId(data.participantId) ||
      normalizeParticipantId(data.clientId) ||
      normalizeParticipantId(data.name);
    if (!normalizedParticipantId) {
      if (typeof callback === "function") {
        callback({ ok: false, error: "Invalid participant ID." });
      }
      return;
    }
    const clientId = normalizedParticipantId;
    const name = normalizedParticipantId;

    let player = playersByClientId.get(clientId);
    if (!player) {
      player = {
        clientId,
        name,
        lobbySocketId: socket.id,
        gameSocketId: null,
        matchId: null,
      };
      playersByClientId.set(clientId, player);
    } else {
      player.name = name;
      player.lobbySocketId = socket.id;
    }

    socketToClientId.set(socket.id, clientId);

    console.log(`Lobby register: ${clientId} (${name}) on ${socket.id}`);

    if (typeof callback === "function") {
      callback({ ok: true, clientId, name });
    }
  });

  socket.on("joinQueue", () => {
    const clientId = socketToClientId.get(socket.id);
    if (!clientId) return;

    const player = playersByClientId.get(clientId);
    if (!player) return;

    if (player.matchId) return; // already in a match
    if (!lobbyQueue.includes(clientId)) {
      lobbyQueue.push(clientId);
    }

    console.log("Lobby queue:", lobbyQueue);

    if (lobbyQueue.length >= 2) {
      const c1 = lobbyQueue.shift();
      const c2 = lobbyQueue.shift();
      const p1 = playersByClientId.get(c1);
      const p2 = playersByClientId.get(c2);
      if (!p1 || !p2) return;

      const matchId = "M-" + matchCounter++;
      const match = {
        matchId,
        clientIds: [c1, c2],
        round: 1,
        maxRounds: MAX_ROUNDS,
        pot: ROUND_POT,
        choices: {},
      };
      matches.set(matchId, match);

      p1.matchId = matchId;
      p2.matchId = matchId;

      console.log(
        `Match created: ${matchId} between ${p1.name} and ${p2.name}`
      );

      // Tell lobby clients to navigate to game.html
      if (p1.lobbySocketId) {
        io.to(p1.lobbySocketId).emit("matchReady", {
          matchId,
          opponentName: p2.name,
          totalRounds: match.maxRounds,
          pot: match.pot,
        });
      }
      if (p2.lobbySocketId) {
        io.to(p2.lobbySocketId).emit("matchReady", {
          matchId,
          opponentName: p1.name,
          totalRounds: match.maxRounds,
          pot: match.pot,
        });
      }
    }
  });

  socket.on("registerGame", (data, callback) => {
    const { clientId, matchId } = data || {};
    const player = playersByClientId.get(clientId);
    const match = matches.get(matchId);

    if (!player || !match || player.matchId !== matchId) {
      if (typeof callback === "function") {
        callback({ ok: false, error: "Invalid match or player." });
      }
      return;
    }

    player.gameSocketId = socket.id;
    socketToClientId.set(socket.id, clientId);

    const opponentId = match.clientIds.find((id) => id !== clientId);
    const opponent = playersByClientId.get(opponentId);

    console.log(
      `Game register: ${clientId} (${player.name}) joined match ${matchId}`
    );

    if (typeof callback === "function") {
      callback({
        ok: true,
        name: player.name,
        opponentName: opponent ? opponent.name : "Opponent",
        round: match.round,
        totalRounds: match.maxRounds,
        pot: match.pot,
      });
    }
  });

  socket.on("playerChoice", ({ matchId, choice }) => {
    const clientId = socketToClientId.get(socket.id);
    if (!clientId || !matchId || !choice) return;

    const player = playersByClientId.get(clientId);
    const match = matches.get(matchId);
    if (!player || !match || player.matchId !== matchId) return;

    match.choices[clientId] = choice;

    const [c1, c2] = match.clientIds;
    if (match.choices[c1] && match.choices[c2]) {
      const choice1 = match.choices[c1];
      const choice2 = match.choices[c2];
      const p1 = playersByClientId.get(c1);
      const p2 = playersByClientId.get(c2);
      if (!p1 || !p2) return;

      const outcome = computeOutcome(choice1, choice2);
      const ts = new Date().toISOString();
      const roundNo = match.round;
      const isLastRound = roundNo >= match.maxRounds;

      // Log from each perspective
      logRound({
        timestamp: ts,
        matchId,
        round: roundNo,
        playerId: p1.name,
        opponentId: p2.name,
        playerChoice: choice1,
        opponentChoice: choice2,
        payout: outcome.payout1,
        outcome: outcome.code,
      });
      logRound({
        timestamp: ts,
        matchId,
        round: roundNo,
        playerId: p2.name,
        opponentId: p1.name,
        playerChoice: choice2,
        opponentChoice: choice1,
        payout: outcome.payout2,
        outcome: outcome.code,
      });

      // Notify players
      if (p1.gameSocketId) {
        io.to(p1.gameSocketId).emit("roundResult", {
          matchId,
          round: roundNo,
          totalRounds: match.maxRounds,
          yourChoice: choice1,
          opponentChoice: choice2,
          payout: outcome.payout1,
          pot: match.pot,
          opponentName: p2.name,
          outcome: outcome.code,
          isLastRound,
        });
      }

      if (p2.gameSocketId) {
        io.to(p2.gameSocketId).emit("roundResult", {
          matchId,
          round: roundNo,
          totalRounds: match.maxRounds,
          yourChoice: choice2,
          opponentChoice: choice1,
          payout: outcome.payout2,
          pot: match.pot,
          opponentName: p1.name,
          outcome: outcome.code,
          isLastRound,
        });
      }

      if (isLastRound) {
        // Clean up match
        p1.matchId = null;
        p2.matchId = null;
        matches.delete(matchId);
      } else {
        match.round += 1;
        match.choices = {};
      }
    }
  });

  socket.on("disconnect", () => {
    const clientId = socketToClientId.get(socket.id);
    socketToClientId.delete(socket.id);

    if (!clientId) return;
    const player = playersByClientId.get(clientId);
    if (!player) return;

    // Remove from lobby queue if they were there
    if (player.lobbySocketId === socket.id) {
      player.lobbySocketId = null;
      removeFromQueue(clientId);
    }

    // Handle disconnect during a match (game socket)
    if (player.gameSocketId === socket.id) {
      player.gameSocketId = null;
      if (player.matchId) {
        const match = matches.get(player.matchId);
        if (match) {
          const otherId = match.clientIds.find((id) => id !== clientId);
          const other = playersByClientId.get(otherId);
          if (other && other.gameSocketId) {
            io.to(other.gameSocketId).emit("opponentLeft");
          }
          if (other) other.matchId = null;
          matches.delete(player.matchId);
        }
        player.matchId = null;
      }
    }

    console.log("Socket disconnected:", socket.id, "clientId:", clientId);
  });
});

server.listen(PORT, () => {
  console.log("Server running on http://localhost:" + PORT);
});
