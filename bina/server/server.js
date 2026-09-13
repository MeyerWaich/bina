import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { ha } from "./ha.js";
import { tools } from "./tools.js";
import { classify, roleAllows } from "./policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOUSE_PATH = process.env.BINA_HOUSE || "./house.json";
const MODEL = process.env.BINA_MODEL || "claude-sonnet-4-6";
const PORT = Number(process.env.BINA_PORT || 8787);

const anthropic = new Anthropic();
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "app")));

// ---------- state ----------
const house = JSON.parse(fs.readFileSync(HOUSE_PATH, "utf8"));
const saveHouse = () => fs.writeFileSync(HOUSE_PATH, JSON.stringify(house, null, 2));
const sessions = new Map();       // userId -> message history
const pending = new Map();        // confirmId -> { userId, call }
const feed = [];                  // in-memory feed; swap for SQLite later
const DATA = process.env.BINA_DATA || ".";
const audit = (entry) => fs.appendFileSync(path.join(DATA, "audit.log"), JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");

let stateCache = { at: 0, states: {}, areas: [] };
async function snapshot() {
  if (Date.now() - stateCache.at < 5000) return stateCache;
  const [list, areas] = await Promise.all([ha.states(), ha.areas().catch(() => [])]);
  const states = Object.fromEntries(list.map(s => [s.entity_id, s]));
  stateCache = { at: Date.now(), states, areas };
  return stateCache;
}

const INTERESTING = ["light", "switch", "media_player", "climate", "cover", "lock", "alarm_control_panel", "binary_sensor", "camera", "scene", "fan"];
function compactHouse({ states, areas }) {
  const byArea = areas.map(a => ({
    room: a.name,
    devices: a.entities.filter(id => INTERESTING.includes(id.split(".")[0]) && states[id]).map(id => {
      const s = states[id]; const at = s.attributes || {};
      const extra = at.brightness ? ` ${Math.round(at.brightness / 2.55)}%` : at.temperature ? ` set ${at.temperature}` : at.current_position != null ? ` ${at.current_position}%` : at.media_title ? ` "${at.media_title}"` : "";
      return `${id}=${s.state}${extra}`;
    })
  })).filter(a => a.devices.length);
  const assigned = new Set(areas.flatMap(a => a.entities));
  const loose = Object.values(states).filter(s => INTERESTING.includes(s.entity_id.split(".")[0]) && !assigned.has(s.entity_id)).map(s => `${s.entity_id}=${s.state}`);
  return { rooms: byArea, unassigned: loose.slice(0, 40) };
}

// ---------- prompt ----------
function systemPrompt(user) {
  const now = new Date().toLocaleString("en-US", { timeZone: house.timezone });
  return `You are Bina, the assistant for ${house.name}. You control the home through tools and speak like a calm, competent house manager. Reply in the user's language (${user.language}); Spanish, English or Hebrew.

Rules:
- Act, then confirm in one short line. No lists unless asked. No emojis.
- When a request implies several devices, do them all in one turn.
- Never claim something happened unless a tool succeeded. If a tool fails, say what failed and what you tried.
- Locks, alarm and garage are protected: the system will ask the user to confirm; tell them you're asking.
- Cameras are read only.
- Use room names, not entity ids, when talking to the user.
- Quiet hours ${house.quiet_hours.start} to ${house.quiet_hours.end}: keep audio low unless asked.
- Preferences: ${house.preferences.join(" | ")}
- Memory: ${house.memory.join(" | ") || "none yet"}
- Current time: ${now}. User: ${user.name} (${user.role}).`;
}

// ---------- tool execution ----------
async function runTool(name, input, user) {
  const snap = await snapshot();
  switch (name) {
    case "get_house": return compactHouse(snap);
    case "get_state": return snap.states[input.entity_id] || { error: "unknown entity" };
    case "get_events": {
      const rows = await ha.logbook(input.hours || 24);
      return rows.slice(-60).map(r => `${r.when?.slice(11, 16)} ${r.name}: ${r.message || r.state}`);
    }
    case "describe_camera": {
      const b64 = await ha.snapshot(input.entity_id);
      const r = await anthropic.messages.create({
        model: MODEL, max_tokens: 120,
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }, { type: "text", text: "One sentence: who or what is here and what are they doing. Say 'nothing notable' if empty." }] }]
      });
      return r.content.find(c => c.type === "text")?.text || "no description";
    }
    case "remember": house.memory.push(input.fact); saveHouse(); return "saved";
    case "diagnose": {
      const s = snap.states[input.entity_id];
      if (!s) return { error: "unknown entity" };
      return { state: s.state, last_changed: s.last_changed, last_updated: s.last_updated, available: s.state !== "unavailable", attributes: s.attributes };
    }
    case "create_automation":
      return { needs_confirmation: true, kind: "automation", name: input.name, summary: input.summary, yaml: input.yaml };
    case "call_service": {
      const decision = classify({ domain: input.domain, entityIds: input.entity_ids, house, states: snap.states });
      if (decision === "deny" || !roleAllows(user.role, decision)) return { error: `not allowed for ${user.role}` };
      if (decision === "confirm") return { needs_confirmation: true, kind: "service", ...input };
      await ha.call(input.domain, input.service, { entity_id: input.entity_ids, ...(input.data || {}) });
      audit({ user: user.id, action: `${input.domain}.${input.service}`, entities: input.entity_ids, data: input.data, confirmed: false });
      stateCache.at = 0;
      return "ok";
    }
    default: return { error: "unknown tool" };
  }
}

// ---------- agent loop ----------
async function chat(user, text) {
  const history = sessions.get(user.id) || [];
  history.push({ role: "user", content: text });
  const confirmations = [];
  let reply = "";
  for (let step = 0; step < 8; step++) {
    const r = await anthropic.messages.create({ model: MODEL, max_tokens: 800, system: systemPrompt(user), tools, messages: history });
    history.push({ role: "assistant", content: r.content });
    const uses = r.content.filter(c => c.type === "tool_use");
    reply = r.content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    if (!uses.length) break;
    const results = [];
    for (const u of uses) {
      let out;
      try { out = await runTool(u.name, u.input, user); } catch (e) { out = { error: e.message }; }
      if (out && out.needs_confirmation) {
        const id = Math.random().toString(36).slice(2, 10);
        pending.set(id, { userId: user.id, call: out });
        confirmations.push({ id, ...out });
        out = { pending_confirmation: id, note: "Waiting for the user to confirm in the app." };
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) });
    }
    history.push({ role: "user", content: results });
  }
  sessions.set(user.id, history.slice(-40));
  feed.unshift({ t: Date.now(), who: user.name, text, reply });
  return { reply, confirmations };
}

// ---------- routes ----------
const userFrom = (req) => house.residents.find(r => r.id === (req.headers["x-bina-user"] || "owner")) || house.residents[0];

app.post("/api/chat", async (req, res) => {
  try { res.json(await chat(userFrom(req), String(req.body.text || "").slice(0, 2000))); }
  catch (e) { res.status(500).json({ reply: "Something went wrong on my side: " + e.message, confirmations: [] }); }
});

app.post("/api/confirm/:id", async (req, res) => {
  const p = pending.get(req.params.id);
  const user = userFrom(req);
  if (!p) return res.status(404).json({ error: "expired" });
  pending.delete(req.params.id);
  if (req.body.approve === false) return res.json({ ok: true, reply: "Cancelled." });
  try {
    if (p.call.kind === "service") {
      await ha.call(p.call.domain, p.call.service, { entity_id: p.call.entity_ids, ...(p.call.data || {}) });
      audit({ user: user.id, action: `${p.call.domain}.${p.call.service}`, entities: p.call.entity_ids, confirmed: true });
    } else if (p.call.kind === "automation") {
      // Phase 1: hand the YAML to the integrator; Phase 2: push via HA config API.
      fs.appendFileSync(path.join(DATA, "automations.pending.yaml"), `\n# ${p.call.name}\n${p.call.yaml}\n`);
      audit({ user: user.id, action: "automation.draft", name: p.call.name, confirmed: true });
    }
    stateCache.at = 0;
    res.json({ ok: true, reply: "Done." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/house", async (_req, res) => {
  try { res.json(compactHouse(await snapshot())); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/feed", (_req, res) => res.json(feed.slice(0, 50)));

app.get("/api/brief", async (req, res) => {
  try {
    const user = userFrom(req);
    const events = await runTool("get_events", { hours: 24 }, user);
    const r = await anthropic.messages.create({
      model: MODEL, max_tokens: 300, system: systemPrompt(user),
      messages: [{ role: "user", content: `Write the morning brief for ${user.name} from these events. 3 to 6 short lines, plain language, most important first, no bullets:\n${events.join("\n")}` }]
    });
    const text = r.content.find(c => c.type === "text")?.text || "";
    feed.unshift({ t: Date.now(), who: "Bina", text: "Morning brief", reply: text });
    res.json({ brief: text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`Bina listening on :${PORT} for ${house.name}`));
