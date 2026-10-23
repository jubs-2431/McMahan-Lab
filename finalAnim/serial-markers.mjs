// Protocol/codebook: Myssttx/driver-moral-simulator, driver-serial-v1.
// The shared bridge owns the port; this client never creates an LSL outlet.
export function markerCode(event, mode, actor, choice) {
  const condition = ["practice", "human", "ai", "unknown"].indexOf(mode);
  if (condition < 0) throw new Error("Unknown serial marker condition.");
  if (event === "sos_round_start") return 130 + condition;
  if (event === "sos_round_end") return 154 + condition;
  if (event === "sos_outcome_shown") return 150 + condition;
  if (event === "sos_choice" && ["participant", "opponent"].includes(actor)
      && ["split", "steal"].includes(choice)) {
    return 134 + 4 * condition + (actor === "opponent" ? 2 : 0) + (choice === "steal" ? 1 : 0);
  }
  throw new Error("Unknown serial marker event.");
}

export class SerialMarkers {
  constructor({ WebSocket, storage, mode = "hardware", timeout = 3000 }) {
    if (!["hardware", "simulate", "off"].includes(mode)) throw new Error("Invalid serialMarkers setting.");
    Object.assign(this, { WebSocket, storage, mode, timeout });
    this.socket = null;
    this.connecting = null;
    this.pending = new Map();
  }

  async ready() {
    if (this.mode === "off") return;
    if (this.socket?.readyState === 1 && this.hello) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const socket = new this.WebSocket("ws://127.0.0.1:7779/markers");
      this.socket = socket;
      this.hello = null;
      let settled = false;
      const fail = (error) => {
        this.hello = null;
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
        for (const item of this.pending.values()) item.reject(error);
        this.pending.clear();
      };
      const timer = setTimeout(() => {
        fail(new Error("Serial marker bridge unavailable. Start marker_bridge.py with --disable-lsl."));
        socket.close();
      }, this.timeout);
      socket.onmessage = ({ data }) => {
        let message;
        try { message = JSON.parse(data); } catch { return; }
        if (message.type === "hello") {
          const expected = this.mode === "simulate" ? "simulation" : "hardware";
          if (message.protocol_version !== 2 || message.serial?.mode !== expected
              || !message.serial.ready || message.lsl?.enabled !== false
              || message.codebook_version !== "driver-serial-v1") {
            fail(new Error("Bridge must have serial ready, driver-serial-v1, and LSL disabled. Simulation requires serialMarkers=simulate."));
            socket.close();
            return;
          }
          if (settled) return;
          this.hello = message;
          settled = true;
          clearTimeout(timer);
          resolve();
        } else {
          const item = this.pending.get(message.id);
          if (item) { this.pending.delete(message.id); item.resolve(message); }
        }
      };
      socket.onerror = () => fail(new Error("Serial marker connection failed."));
      socket.onclose = () => fail(new Error("Serial marker bridge disconnected."));
    });
    try { await this.connecting; } finally { this.connecting = null; }
  }

  async emit(event, { session, round, mode, actor, choice, request = "" }) {
    if (this.mode === "off") return;
    const code = markerCode(event, mode, actor, choice);
    const key = `finalanim_serial:${JSON.stringify([session, round, mode, event, actor || ""])}`;
    const previous = this.storage.getItem(key);
    if (previous === `confirmed:${code}`) return;
    if (previous) throw new Error("A serial marker has uncertain delivery. Stop and have the operator inspect the bridge audit log; it will not be replayed.");
    await this.ready();
    const id = crypto.randomUUID();
    const label = [event, `session=${session}`, `trial=${round}`, `round=${mode}`,
      actor && `actor=${actor}`, choice && `choice=${choice}`, request && `request=${request}`].filter(Boolean).join("|");
    // Save before sending: a lost ACK or reload must never replay a late marker.
    this.storage.setItem(key, "uncertain");
    let timer;
    try {
      const reply = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Serial marker ACK timed out; delivery is uncertain. Operator review required.")), this.timeout);
        this.pending.set(id, { resolve, reject });
        this.socket.send(JSON.stringify({ type: "marker", protocol_version: 2, id,
          source: "operator_dashboard", label, client_monotonic_ms: performance.now(), client_utc: new Date().toISOString() }));
      });
      const expected = this.mode === "simulate" ? "simulated" : "written";
      if (reply.type !== "ack" || reply.protocol_version !== 2 || reply.marker_code !== code
          || reply.serial?.status !== expected || (expected === "written" && reply.serial.bytes_written !== 1)
          || reply.logged !== true || reply.lsl?.enabled !== false) {
        throw new Error(`Serial marker ${code} failed or was not audited: ${reply.error || "invalid ACK"}. Operator review required.`);
      }
      this.storage.setItem(key, `confirmed:${code}`);
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }
}
