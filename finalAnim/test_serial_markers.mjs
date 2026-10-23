import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { SerialMarkers, markerCode } from "./serial-markers.mjs";

function fixture({ hello = {}, ack = {}, drop = false, mode = "hardware" } = {}) {
  const sent = [];
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  class Socket {
    constructor() {
      this.readyState = 1;
      queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: "hello", protocol_version: 2,
        codebook_version: "driver-serial-v1", serial: { mode: "hardware", ready: true },
        lsl: { enabled: false }, ...hello }) }));
    }
    send(raw) {
      const frame = JSON.parse(raw);
      sent.push(frame);
      const [event, ...fields] = frame.label.split("|");
      const values = Object.fromEntries(fields.map(field => field.split("=")));
      const expectedCode = markerCode(event, values.round, values.actor, values.choice);
      if (!drop) queueMicrotask(() => this.onmessage({ data: JSON.stringify({ type: "ack", protocol_version: 2,
        id: frame.id, marker_code: expectedCode, serial: { status: "written", bytes_written: 1 },
        lsl: { enabled: false }, logged: true, ...ack }) }));
    }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const client = new SerialMarkers({ WebSocket: Socket, storage, timeout: 20, mode });
  return { client, sent, storage, Socket };
}
const context = { session: "TEST_001", round: 1, mode: "ai", actor: "participant", choice: "split" };

test("codebook matches all four reference conditions and actors", () => {
  for (const [i, mode] of ["practice", "human", "ai", "unknown"].entries()) {
    assert.equal(markerCode("sos_round_start", mode), 130 + i);
    assert.equal(markerCode("sos_outcome_shown", mode), 150 + i);
    assert.equal(markerCode("sos_round_end", mode), 154 + i);
    for (const [j, actor] of ["participant", "opponent"].entries()) {
      for (const [k, choice] of ["split", "steal"].entries()) {
        assert.equal(markerCode("sos_choice", mode, actor, choice), 134 + 4*i + 2*j + k);
      }
    }
  }
  assert.throws(() => markerCode("sos_choice", "ai", "participant", "invalid"));
});

test("v2 source and labels route to serial; confirmed markers survive client recreation", async () => {
  const { client, sent, storage, Socket } = fixture();
  await client.emit("sos_choice", context);
  assert.equal(sent[0].source, "operator_dashboard");
  assert.equal(sent[0].protocol_version, 2);
  assert.match(sent[0].label, /^sos_choice\|session=TEST_001\|trial=1\|round=ai\|actor=participant\|choice=split$/);
  const reloaded = new SerialMarkers({ WebSocket: Socket, storage });
  await reloaded.emit("sos_choice", context);
  assert.equal(sent.length, 1);
  await assert.rejects(reloaded.emit("sos_choice", { ...context, choice: "steal" }), /uncertain/);
});

test("default mode rejects LSL, simulation, disabled serial, and wrong codebook", async () => {
  for (const hello of [{ lsl: { enabled: true } }, { serial: { mode: "simulation", ready: true } },
    { serial: { mode: "hardware", ready: false } }, { codebook_version: "unknown" }]) {
    const { client, sent } = fixture({ hello });
    await assert.rejects(client.emit("sos_choice", context), /Bridge must/);
    assert.equal(sent.length, 0);
  }
});

test("failed, short, unaudited, or mismatched writes are rejected and never replayed", async () => {
  for (const ack of [{ type: "nack" }, { serial: { status: "written", bytes_written: 0 } },
    { logged: false }, { marker_code: 143 }, { lsl: { enabled: true } }]) {
    const { client, sent } = fixture({ ack });
    await assert.rejects(client.emit("sos_choice", context), /failed or was not audited/);
    await assert.rejects(client.emit("sos_choice", context), /uncertain/);
    assert.equal(sent.length, 1);
  }
});

test("lost ACK blocks late replay", async () => {
  const { client, sent } = fixture({ drop: true });
  await assert.rejects(client.emit("sos_choice", context), /timed out/);
  await assert.rejects(client.emit("sos_choice", context), /uncertain/);
  assert.equal(sent.length, 1);
});

test("simulation and no-acquisition modes require explicit selection", async () => {
  const { client, sent } = fixture({ mode: "simulate", hello: { serial: { mode: "simulation", ready: true } },
    ack: { serial: { status: "simulated", bytes_written: 0 } } });
  await client.emit("sos_choice", context);
  assert.equal(sent.length, 1);
  const off = fixture({ mode: "off" });
  await off.client.emit("sos_choice", context);
  assert.equal(off.sent.length, 0);
});

test("participant flow emits choice/outcome/end at presentation boundaries, and skips acknowledged results", async () => {
  const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
  const complete = source.slice(source.indexOf("async function completeInteraction(epoch)"), source.indexOf("async function sendInteraction(kind, value)"));
  for (const acknowledged of [false, true]) {
    const events = [];
    const sandbox = {
      pendingInteraction: { endpoint: "/api/split-steal", body: { session_id: "TEST_001", request_id: "request_123", choice: "split", expected_round: 1 },
        markerContext: { session: "TEST_001", round: 1, mode: "ai" } },
      serialMarkers: { ready: async () => {}, emit: async (event, ctx) => { events.push([event, ctx.actor]); } },
      currentInteractionMode: "ai", gameRound: 1, gamePhase: "Ready", avatarLoading: Promise.resolve(),
      apiJSON: async path => {
        if (path.endsWith("/ack")) events.push(["ack"]);
        return { status: "ready", acknowledged, assistant_choice: "split", audio_base64: "test", reply: "Split." };
      },
      assertCurrentSession() {}, applyGameState() {}, addDialogueEntry() {},
      setStatus() { events.push(["display"]); }, savePendingInteraction() {},
      updateGamePanel() {}, syncParticipantGameState: async () => {},
      playReplyAudio: async () => { events.push(["audio"]); }, Date,
    };
    vm.createContext(sandbox);
    vm.runInContext(complete + "\nglobalThis.run = completeInteraction;", sandbox);
    await sandbox.run(1);
    assert.deepEqual(events.map(row => row[0]), acknowledged
      ? ["sos_round_start", "sos_choice", "display"]
      : ["sos_round_start", "sos_choice", "sos_choice", "display", "sos_outcome_shown", "audio", "sos_round_end", "ack"]);
    if (!acknowledged) assert.equal(events[2][1], "opponent");
    assert.equal(sandbox.pendingInteraction, null);
  }
});


test("chat then choice in one round produces only one serial round start", async () => {
  const { client, sent } = fixture();
  const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
  const complete = source.slice(source.indexOf("async function completeInteraction(epoch)"), source.indexOf("async function sendInteraction(kind, value)"));
  const sandbox = {
    serialMarkers: client, currentInteractionMode: "ai", gameRound: 1, gamePhase: "Ready", avatarLoading: Promise.resolve(),
    apiJSON: async () => ({ status: "ready", acknowledged: false, assistant_choice: "split", audio_base64: "test", reply: "Hello." }),
    assertCurrentSession() {}, applyGameState() {}, addDialogueEntry() {}, setStatus() {}, savePendingInteraction() {},
    updateGamePanel() {}, syncParticipantGameState: async () => {}, playReplyAudio: async () => {}, Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(complete + "\nglobalThis.run = completeInteraction;", sandbox);
  for (const body of [{ text: "Hello" }, { choice: "split", expected_round: 1 }]) {
    sandbox.pendingInteraction = { endpoint: body.choice ? "/api/split-steal" : "/api/ask",
      markerContext: { session: "TEST_CHAT", round: 1, mode: "ai" },
      body: { session_id: "TEST_CHAT", request_id: crypto.randomUUID(), ...body } };
    await sandbox.run(1);
  }
  assert.deepEqual(sent.map(frame => frame.label.split("|")[0]),
    ["sos_round_start", "sos_choice", "sos_choice", "sos_outcome_shown", "sos_round_end"]);
});
