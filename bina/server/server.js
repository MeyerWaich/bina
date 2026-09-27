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
const DATA = process.env.BINA_DATA || ".";
const BRIEF_TIME = process.env.BINA_BRIEF_TIME || "07:30";

const anthropic = new Anthropic();
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "app")));

// ---------- persistent state ----------
const house = JSON.parse(fs.readFileSync(HOUSE_PATH, "utf8"));
house.memory ||= []; house.preferences ||= []; house.protected ||= [];
const saveHouse = () => fs.writeFileSync(HOUSE_PATH, JSON.stringify(house, null, 2));
const FEED_PATH = path.join(DATA, "feed.json");
let feed = []; try { feed = JSON.parse(fs.readFileSync(FEED_PATH, "utf8")); } catch {}
const pushFeed = (item) => { feed.unshift(item); feed = feed.slice(0, 200); fs.writeFile(FEED_PATH, JSON.stringify(feed), () => {}); };
const audit = (entry) => fs.appendFileSync(path.join(DATA, "audit.log"), JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
const sessions = new Map();       // userId -> message history
const pending = new Map();        // confirmId -> { userId, call }

// ---------- house model ----------
let reg = { at: 0, areas: [], entities: [], devices: [], exposed: {} };
async function registries() {
  if (Date.now() - reg.at < 60000) return reg;
  try {
    const [areas, entities, devices, exposed] = await Promise.all([ha.areas(), ha.entities(), ha.devices(), ha.exposed()]);
    reg = { at: Date.now(), areas, entities, devices, exposed };
  } catch (e) { console.error("registry", e.message); reg.at = Date.now() - 50000; }
  return reg;
}
let stateCache = { at: 0, states: {} };
async function states() {
  if (Date.now() - stateCache.at < 4000) return stateCache.states;
  const list = await ha.states();
  stateCache = { at: Date.now(), states: Object.fromEntries(list.map(s => [s.entity_id, s])) };
  return stateCache.states;
}

const INTERESTING = ["light", "switch", "media_player", "climate", "cover", "lock", "alarm_control_panel", "binary_sensor", "camera", "scene", "fan", "script"];
const PRIORITY = { alarm_control_panel: 0, lock: 1, binary_sensor: 2, climate: 3, light: 4, cover: 5, media_player: 6, camera: 7, switch: 8, fan: 9, scene: 10, script: 11 };
const noisy = (s) => s.state === "unavailable" || /^(update|connectivity|battery|problem|tamper)$/.test(s.attributes?.device_class || "") || /siren|motion_detection|_info$/.test(s.entity_id);
function line(s) {
  const at = s.attributes || {};
  const name = at.friendly_name ? ` (${at.friendly_name})` : "";
  const extra = at.brightness ? ` ${Math.round(at.brightness / 2.55)}%` : at.temperature != null ? ` set ${at.temperature}, now ${at.current_temperature ?? "?"}` : at.current_position != null ? ` ${at.current_position}%` : at.media_title ? ` "${at.media_title}"` : at.volume_level != null ? ` vol ${Math.round(at.volume_level * 100)}%` : at.device_class ? ` [${at.device_class}]` : "";
  return `${s.entity_id}${name}=${s.state}${extra}`;
}
async function houseModel() {
  const [r, st] = await Promise.all([registries(), states()]);
  const exposedIds = new Set(Object.entries(r.exposed).filter(([, v]) => v?.conversation).map(([k]) => k));
  const useExposure = exposedIds.size > 0;
  const areaOf = new Map(); // entity_id -> area_id
  const devArea = new Map(r.devices.map(d => [d.id, d.area_id]));
  for (const e of r.entities) areaOf.set(e.entity_id, e.area_id || devArea.get(e.device_id) || null);
  const areaName = new Map(r.areas.map(a => [a.area_id, a.name]));
  const rooms = new Map(); const loose = [];
  for (const s of Object.values(st)) {
    const dom = s.entity_id.split(".")[0];
    if (!INTERESTING.includes(dom) || noisy(s)) continue;
    if (useExposure && !exposedIds.has(s.entity_id)) continue;
    const a = areaOf.get(s.entity_id);
    if (a && areaName.has(a)) { if (!rooms.has(a)) rooms.set(a, []); rooms.get(a).push(s); } else loose.push(s);
  }
  const sortP = (x, y) => (PRIORITY[x.entity_id.split(".")[0]] ?? 99) - (PRIORITY[y.entity_id.split(".")[0]] ?? 99);
  return {
    rooms: [...rooms.entries()].map(([a, list]) => ({ room: areaName.get(a), devices: list.sort(sortP).map(line) })),
    unassigned: loose.sort(sortP).map(line)
  };
}
async function findPlayer(room) {
  const m = await houseModel();
  const want = room.toLowerCase();
  const inRoom = m.rooms.find(r => r.room.toLowerCase() === want || r.room.toLowerCase().includes(want) || want.includes(r.room.toLowerCase()));
  const pick = (lines) => (lines || []).map(l => l.split("=")[0].split(" ")[0]).find(id => id.startsWith("media_player."));
  return pick(inRoom?.devices) || pick(m.unassigned.filter(l => l.toLowerCase().includes(want)));
}

// ---------- prompt ----------
function systemPrompt(user) {
  const now = new Date().toLocaleString("en-US", { timeZone: house.timezone, weekday: "long", hour: "numeric", minute: "2-digit", month: "long", day: "numeric" });
  return `You are Bina, the assistant for ${house.name}. You control the home through tools and speak like a calm, competent house manager. Reply in the user's language (${user.language}); Spanish, English or Hebrew, matching whatever they wrote.

Rules:
- Act, then confirm in one short line. Plain text only: no markdown, no asterisks, no bullet lists, no headers, no emojis.
- When a request implies several devices, do them all in one turn. Use play_music for anything musical.
- Never claim something happened unless a tool succeeded. If a tool fails, say what failed.
- Locks, alarm and garage are protected: the system asks the user to confirm; tell them you're asking. After a lock or alarm change, status can take a minute to update; say so if asked right away.
- Cameras are read only. Contact sensors (device_class door/window/opening) say whether doors and sliders are open. Motion sensors say presence.
- Use room names, not entity ids, when talking to the user.
- If the user defines a mode or scene in words, save it with remember, then execute it when they name it later.
- If the user describes a routine ("when X, do Y"), build it with create_automation.
- Quiet hours ${house.quiet_hours.start} to ${house.quiet_hours.end}: keep audio low unless asked.
- Preferences: ${house.preferences.join(" | ") || "none"}
- Memory: ${house.memory.join(" | ") || "none yet"}
- Now: ${now}. User: ${user.name} (${user.role}).`;
}

// ---------- tool execution ----------
async function runTool(name, input, user) {
  switch (name) {
    case "get_house": return houseModel();
    case "get_state": return (await states())[input.entity_id] || { error: "unknown entity" };
    case "get_events": {
      const rows = await ha.logbook(input.hours || 24);
      return rows.slice(-80).map(r => `${r.when?.slice(11, 16)} ${r.name}: ${r.message || r.state}`);
    }
    case "describe_camera": {
      const b64 = await ha.snapshot(input.entity_id);
      const r = await anthropic.messages.create({
        model: MODEL, max_tokens: 120,
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }, { type: "text", text: `One sentence in ${user.language}: who or what is here and what are they doing. Say nothing notable if empty.` }] }]
      });
      return r.content.find(c => c.type === "text")?.text || "no description";
    }
    case "remember": house.memory.push(input.fact); saveHouse(); return "saved";
    case "diagnose": {
      const s = (await states())[input.entity_id];
      if (!s) return { error: "unknown entity" };
      return { state: s.state, last_changed: s.last_changed, last_updated: s.last_updated, available: s.state !== "unavailable", attributes: s.attributes };
    }
    case "play_music": {
      const player = await findPlayer(input.room);
      if (!player) return { error: `no speaker found for ${input.room}` };
      if (input.volume_pct != null) await ha.call("media_player", "volume_set", { entity_id: player, volume_level: Math.max(0, Math.min(1, input.volume_pct / 100)) });
      await ha.call("music_assistant", "play_media", { entity_id: player, media_id: input.query, enqueue: "replace" });
      audit({ user: user.id, action: "play_music", player, query: input.query });
      stateCache.at = 0;
      return { ok: true, player };
    }
    case "create_automation":
      return { needs_confirmation: true, kind: "automation", alias: input.alias, summary: input.summary, config: { mode: "single", ...input.config, alias: input.alias } };
    case "call_service": {
      const st = await states();
      const decision = classify({ domain: input.domain, service: input.service, entityIds: input.entity_ids, house, states: st });
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
    const r = await anthropic.messages.create({ model: MODEL, max_tokens: 900, system: systemPrompt(user), tools, messages: history });
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
  pushFeed({ t: Date.now(), who: user.name, text, reply });
  return { reply, confirmations };
}

// ---------- brief ----------
async function makeBrief(user) {
  const events = await runTool("get_events", { hours: 24 }, user);
  const m = await houseModel();
  const open = [...m.rooms.flatMap(r => r.devices), ...m.unassigned].filter(l => /\[(door|window|opening|garage_door)\]/.test(l) && /=on/.test(l));
  const r = await anthropic.messages.create({
    model: MODEL, max_tokens: 350, system: systemPrompt(user),
    messages: [{ role: "user", content: `Write the morning brief for ${user.name} in ${user.language}. 3 to 6 short lines, plain language, most important first, no bullets. Cover: visitors and doorbell, doors/sliders currently open, alarm and lock state, anything unavailable. Currently open: ${open.join("; ") || "nothing"}.\nEvents:\n${events.join("\n")}` }]
  });
  const text = r.content.find(c => c.type === "text")?.text || "";
  pushFeed({ t: Date.now(), who: "Bina", text: "Morning brief", reply: text });
  return text;
}
async function notifyAll(title, message) {
  try {
    const svcs = await ha.services();
    const notify = svcs.find(s => s.domain === "notify");
    const targets = Object.keys(notify?.services || {}).filter(n => n.startsWith("mobile_app_"));
    for (const n of targets) await ha.call("notify", n, { title, message }).catch(() => {});
    await ha.call("persistent_notification", "create", { title, message, notification_id: "bina_brief" }).catch(() => {});
    return targets.length;
  } catch { return 0; }
}
let lastBriefDay = "";
setInterval(async () => {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: house.timezone }));
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const day = now.toDateString();
  if (hhmm !== BRIEF_TIME || lastBriefDay === day) return;
  lastBriefDay = day;
  for (const u of house.residents.filter(r => r.brief)) {
    try { const text = await makeBrief(u); await notifyAll("Bina", text); } catch (e) { console.error("brief", e.message); }
  }
}, 30000);

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
  if (req.body.approve !== true) return res.json({ ok: true, reply: user.language === "es" ? "Cancelado." : "Cancelled." });
  try {
    if (p.call.kind === "service") {
      await ha.call(p.call.domain, p.call.service, { entity_id: p.call.entity_ids, ...(p.call.data || {}) });
      audit({ user: user.id, action: `${p.call.domain}.${p.call.service}`, entities: p.call.entity_ids, confirmed: true });
      setTimeout(() => ha.call("homeassistant", "update_entity", { entity_id: p.call.entity_ids }).catch(() => {}), 5000);
    } else if (p.call.kind === "automation") {
      const id = "bina_" + Date.now();
      await ha.saveAutomation(id, p.call.config);
      audit({ user: user.id, action: "automation.create", id, alias: p.call.alias, confirmed: true });
    }
    stateCache.at = 0;
    res.json({ ok: true, reply: user.language === "es" ? "Listo." : "Done." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/house", async (_req, res) => {
  try { res.json(await houseModel()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/feed", (_req, res) => res.json(feed.slice(0, 50)));
app.get("/api/brief", async (req, res) => {
  try { const text = await makeBrief(userFrom(req)); res.json({ brief: text }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/me", (req, res) => { const u = userFrom(req); res.json({ house: house.name, user: u.name, language: u.language }); });

app.listen(PORT, () => console.log(`Bina 0.2.0 listening on :${PORT} for ${house.name}, brief at ${BRIEF_TIME}`));
