import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import { ha } from "./ha.js";
import { tools } from "./tools.js";
import { classify, roleAllows } from "./policy.js";
import { icons } from "./icons.js";

const VERSION = "0.5.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOUSE_PATH = process.env.BINA_HOUSE || "./house.json";
const MODEL = process.env.BINA_MODEL || "claude-sonnet-4-6";
const PORT = Number(process.env.BINA_PORT || 8787);
const DATA = process.env.BINA_DATA || ".";
const BRIEF_TIME = process.env.BINA_BRIEF_TIME || "07:30";
const ALERT_URL = process.env.BINA_ALERT_URL || "";          // e.g. https://ntfy.sh/your-topic (integrator alerts)
const DOORBELL_ALERTS = process.env.BINA_DOORBELL !== "false";
const SNAP_DIR = path.join(DATA, "snaps");
fs.mkdirSync(SNAP_DIR, { recursive: true });

const anthropic = new Anthropic();
const app = express();
app.use(express.json({ limit: "8mb" }));
for (const [n, b64] of Object.entries(icons)) app.get("/" + n, (_q, r) => r.type("png").set("Cache-Control", "max-age=604800").send(Buffer.from(b64, "base64")));
app.use(express.static(path.join(__dirname, "..", "app")));
app.use("/snaps", express.static(SNAP_DIR, { maxAge: "7d" }));
const PHOTO_DIR = path.join(DATA, "photos");
fs.mkdirSync(PHOTO_DIR, { recursive: true });
app.use("/photos", express.static(PHOTO_DIR, { maxAge: "1h" }));

// ---------- persistent state ----------
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const house = JSON.parse(fs.readFileSync(HOUSE_PATH, "utf8"));
house.memory ||= []; house.preferences ||= []; house.protected ||= []; house.scenes ||= [];
const saveHouse = () => fs.writeFileSync(HOUSE_PATH, JSON.stringify(house, null, 2));
const FEED_PATH = path.join(DATA, "feed.json"), EVENTS_PATH = path.join(DATA, "events.json"), ALERTS_PATH = path.join(DATA, "alerts.json");
let feed = readJson(FEED_PATH, []), events = readJson(EVENTS_PATH, []), alerts = readJson(ALERTS_PATH, []).filter(a => !/macbook|iphone|ipad|imac/i.test(a.message || ""));
const pushFeed = (item) => { feed.unshift(item); feed = feed.slice(0, 200); fs.writeFile(FEED_PATH, JSON.stringify(feed), () => {}); };
const pushEvent = (item) => { events.unshift(item); events = events.slice(0, 150); fs.writeFile(EVENTS_PATH, JSON.stringify(events), () => {}); };
const pushAlert = (item) => { alerts.unshift(item); alerts = alerts.slice(0, 100); fs.writeFile(ALERTS_PATH, JSON.stringify(alerts), () => {}); };
const audit = (entry) => fs.appendFileSync(path.join(DATA, "audit.log"), JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
const sessions = new Map();
const pending = new Map();
const owner = () => house.residents.find(r => r.role === "owner") || house.residents[0];
const es = () => owner().language === "es";

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
  if (Date.now() - stateCache.at < 3000) return stateCache.states;
  const list = await ha.states();
  stateCache = { at: Date.now(), states: Object.fromEntries(list.map(s => [s.entity_id, s])) };
  return stateCache.states;
}

const INTERESTING = ["light", "switch", "media_player", "climate", "cover", "lock", "alarm_control_panel", "binary_sensor", "camera", "scene", "fan", "script"];
const PRIORITY = { alarm_control_panel: 0, lock: 1, binary_sensor: 2, climate: 3, light: 4, cover: 5, media_player: 6, camera: 7, switch: 8, fan: 9, scene: 10, script: 11 };
const noisy = (s) => s.state === "unavailable" || /^(update|connectivity|battery|problem|tamper)$/.test(s.attributes?.device_class || "") || /siren|motion_detection|_info$/.test(s.entity_id);
const dom = (id) => id.split(".")[0];
const fname = (s) => s?.attributes?.friendly_name || s?.entity_id?.split(".")[1].replace(/_/g, " ");

// exposed entities with their room
async function exposedEntities({ includeNoisy = false } = {}) {
  const [r, st] = await Promise.all([registries(), states()]);
  const exposedIds = new Set(Object.entries(r.exposed).filter(([, v]) => v?.conversation).map(([k]) => k));
  const useExposure = exposedIds.size > 0;
  const devArea = new Map(r.devices.map(d => [d.id, d.area_id]));
  const entReg = new Map(r.entities.map(e => [e.entity_id, e]));
  const areaName = new Map(r.areas.map(a => [a.area_id, a.name]));
  const out = [];
  for (const s of Object.values(st)) {
    if (!INTERESTING.includes(dom(s.entity_id))) continue;
    if (!includeNoisy && noisy(s)) continue;
    if (useExposure && !exposedIds.has(s.entity_id)) continue;
    const e = entReg.get(s.entity_id);
    const a = e ? (e.area_id || devArea.get(e.device_id)) : null;
    out.push({ s, room: a && areaName.has(a) ? areaName.get(a) : null });
  }
  return out;
}
function line(s) {
  const at = s.attributes || {};
  const name = at.friendly_name ? ` (${at.friendly_name})` : "";
  const extra = at.brightness ? ` ${Math.round(at.brightness / 2.55)}%` : at.temperature != null ? ` set ${at.temperature}, now ${at.current_temperature ?? "?"}` : at.current_position != null ? ` ${at.current_position}%` : at.media_title ? ` "${at.media_title}"` : at.volume_level != null ? ` vol ${Math.round(at.volume_level * 100)}%` : at.device_class ? ` [${at.device_class}]` : "";
  return `${s.entity_id}${name}=${s.state}${extra}`;
}
const sortP = (x, y) => (PRIORITY[dom(x.entity_id)] ?? 99) - (PRIORITY[dom(y.entity_id)] ?? 99);
async function houseModel() {
  const list = await exposedEntities();
  const rooms = new Map(); const loose = [];
  for (const { s, room } of list) { if (room) { if (!rooms.has(room)) rooms.set(room, []); rooms.get(room).push(s); } else loose.push(s); }
  return {
    rooms: [...rooms.entries()].map(([room, l]) => ({ room, devices: l.sort(sortP).map(line) })),
    unassigned: loose.sort(sortP).map(line),
    scenes: house.scenes.map(s => s.name)
  };
}
async function findPlayer(room) {
  const list = (await exposedEntities()).filter(x => dom(x.s.entity_id) === "media_player" && !/tv|tele/i.test(fname(x.s)));
  const want = norm(room);
  const hit = list.find(x => x.room && (norm(x.room) === want || norm(x.room).includes(want) || want.includes(norm(x.room))))
    || list.find(x => norm(fname(x.s)).includes(want));
  return hit?.s.entity_id;
}

// ---------- text helpers ----------
const norm = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[¿?¡!.,;:]/g, " ").replace(/\s+/g, " ").trim();
function findScene(text) {
  const n = norm(text).replace(/^(bina )?(activa |pon |modo |escena |scene |run |start |activate )+/, "").replace(/^(el |la |los |las |the )/, "");
  return house.scenes.find(s => { const k = norm(s.name).replace(/^modo /, ""); return n === k || n === "modo " + k || (n.endsWith(k) && n.length <= k.length + 8); });
}

// ---------- scenes ----------
async function runScene(scene, user) {
  const confirmations = []; const done = []; const failed = [];
  for (const a of scene.actions || []) {
    try {
      if (a.music) { await runTool("play_music", a.music, user, {}); done.push("music"); continue; }
      const st = await states();
      const decision = classify({ domain: a.domain, service: a.service, entityIds: a.entity_ids || [], house, states: st });
      if (decision === "deny" || !roleAllows(user.role, decision)) { failed.push(a.domain); continue; }
      if (decision === "confirm") { const id = newId(); const call = { kind: "service", ...a }; pending.set(id, { userId: user.id, call }); confirmations.push({ id, ...call }); continue; }
      await ha.call(a.domain, a.service, { entity_id: a.entity_ids, ...(a.data || {}) });
      done.push(a.domain);
    } catch (e) { failed.push(`${a.domain}: ${e.message.slice(0, 80)}`); }
  }
  stateCache.at = 0;
  audit({ user: user.id, action: "scene", name: scene.name, done: done.length, failed });
  return { done, failed, confirmations };
}
const newId = () => Math.random().toString(36).slice(2, 10);

// ---------- prompt ----------
function systemPrompt(user) {
  const now = new Date().toLocaleString("en-US", { timeZone: house.timezone, weekday: "long", hour: "numeric", minute: "2-digit", month: "long", day: "numeric" });
  return `You are Bina, the assistant for ${house.name}. You control the home through tools and speak like a calm, competent house manager. Reply in the user's language (${user.language}); Spanish, English or Hebrew, matching whatever they wrote.

Rules:
- Act, then confirm in one short line. Plain text only: no markdown, no asterisks, no bullet lists, no headers, no emojis.
- When a request implies several devices, do them all in one turn. Use play_music for anything musical.
- "Lo mismo aqui / play this in the kitchen too": join the target speaker to the one already playing with media_player.join.
- Never claim something happened unless a tool succeeded. If a tool fails, say what failed.
- Locks, alarm and garage are protected: the system asks the user to confirm; tell them you're asking. After a lock or alarm change, status can take a minute to update; say so if asked right away.
- Cameras are read only. Use describe_camera when asked what is happening at a camera; the picture is shown to the user automatically.
- Contact sensors (device_class door/window/opening) say whether doors and sliders are open. Motion sensors say presence.
- Use room names, not entity ids, when talking to the user.
- When the user defines a mode or scene in words, save it with save_scene (it becomes a button on the home screen), then run it.
- If the user describes a routine ("when X, do Y"), build it with create_automation.
- Quiet hours ${house.quiet_hours.start} to ${house.quiet_hours.end}: keep audio low unless asked.
- Saved scenes: ${house.scenes.map(s => s.name).join(", ") || "none"}
- Preferences: ${house.preferences.join(" | ") || "none"}
- Memory: ${house.memory.join(" | ") || "none yet"}
- Now: ${now}. User: ${user.name} (${user.role}).`;
}

// ---------- cameras ----------
async function snapshotFile(entityId, tag = "snap") {
  const b64 = await ha.snapshot(entityId);
  const file = `${Date.now()}-${tag}.jpg`;
  fs.writeFileSync(path.join(SNAP_DIR, file), Buffer.from(b64, "base64"));
  pruneSnaps();
  return { b64, url: `snaps/${file}` };
}
function pruneSnaps() {
  try {
    const files = fs.readdirSync(SNAP_DIR).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 300))) fs.unlinkSync(path.join(SNAP_DIR, f));
  } catch {}
}
async function describeImage(b64, lang) {
  const r = await anthropic.messages.create({
    model: MODEL, max_tokens: 120,
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }, { type: "text", text: `One short sentence in ${lang === "es" ? "Spanish" : lang === "he" ? "Hebrew" : "English"}: who or what is here and what are they doing (delivery, visitor, car, animal). Say nothing notable if empty. No names.` }] }]
  });
  return r.content.find(c => c.type === "text")?.text?.trim() || "";
}

// ---------- tool execution ----------
async function runTool(name, input, user, ctx) {
  switch (name) {
    case "get_house": return houseModel();
    case "get_state": return (await states())[input.entity_id] || { error: "unknown entity" };
    case "get_events": {
      const rows = await ha.logbook(input.hours || 24);
      const cam = events.filter(e => e.t > Date.now() - (input.hours || 24) * 3600e3).map(e => `${new Date(e.t).toLocaleTimeString("en-US", { timeZone: house.timezone, hour: "numeric", minute: "2-digit" })} ${e.title}: ${e.text}`);
      return [...cam, ...rows.slice(-80).map(r => `${r.when?.slice(11, 16)}Z ${r.name}: ${r.message || r.state}`)];
    }
    case "describe_camera": {
      const snap = await snapshotFile(input.entity_id, "ask");
      ctx.images?.push(snap.url);
      return { description: await describeImage(snap.b64, user.language), shown_to_user: true };
    }
    case "remember": house.memory.push(input.fact); saveHouse(); return "saved";
    case "save_scene": {
      const scene = { id: norm(input.name).replace(/\s+/g, "-") || newId(), name: input.name, mood: MOODS.includes(input.mood) ? input.mood : guessMood(input.name), actions: input.actions || [] };
      house.scenes = house.scenes.filter(s => norm(s.name) !== norm(scene.name)); house.scenes.push(scene); saveHouse();
      return { saved: true, note: "It is now a button on the home screen." };
    }
    case "run_scene": {
      const sc = findScene(input.name) || house.scenes.find(s => norm(s.name).includes(norm(input.name)));
      if (!sc) return { error: "no scene with that name" };
      const r = await runScene(sc, user);
      ctx.confirmations?.push(...r.confirmations);
      return { done: r.done.length, failed: r.failed, waiting_confirmation: r.confirmations.length };
    }
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

// ---------- fast path: scenes and simple commands without the AI ----------
const PROTECTED_WORDS = /(cerradura|candado|\block|unlock|desbloq|bloque|alarma|alarm|garage|garaje|porton|puerta|door|gate|camara|camera|timbre)/;
const NOT_SIMPLE = /(^| )(que|cual|cuales|hay|como|cuando|quien|donde|por que|is|are|what|which|who|when|how|why|did|was|y|and|despues|luego|si|if|pon|play|toca|reproduce|musica|music|cancion|song|recuerda|remember|crea|create|siempre|every|cada)( |$)/;
async function fastPath(user, text) {
  const sc = findScene(text);
  if (sc) {
    const r = await runScene(sc, user);
    const reply = r.failed.length ? (es() ? `${sc.name}: listo, menos ${r.failed.join(", ")}.` : `${sc.name}: done, except ${r.failed.join(", ")}.`) : (es() ? `${sc.name} listo.` : `${sc.name} done.`);
    return { reply, confirmations: r.confirmations, fast: true };
  }
  const n = norm(text);
  if (n.length > 60 || PROTECTED_WORDS.test(n) || NOT_SIMPLE.test(n) || /[0-9]+ ?(grados|degrees)/.test(n)) return null;
  try {
    const r = await ha.conversation(text, user.language);
    const resp = r?.response;
    if (resp?.response_type === "action_done" && (resp.data?.success?.length || 0) > 0 && !(resp.data?.failed?.length)) {
      stateCache.at = 0;
      audit({ user: user.id, action: "assist", text, targets: resp.data.success.map(x => x.id) });
      return { reply: resp.speech?.plain?.speech || (es() ? "Listo." : "Done."), confirmations: [], fast: true };
    }
  } catch (e) { console.error("assist", e.message); }
  return null;
}

// ---------- agent loop ----------
async function chat(user, text) {
  const fast = await fastPath(user, text).catch(() => null);
  if (fast) { pushFeed({ t: Date.now(), who: user.name, text, reply: fast.reply }); return fast; }
  const history = sessions.get(user.id) || [];
  history.push({ role: "user", content: text });
  const ctx = { confirmations: [], images: [] };
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
      try { out = await runTool(u.name, u.input, user, ctx); } catch (e) { out = { error: e.message }; }
      if (out && out.needs_confirmation) {
        const id = newId();
        pending.set(id, { userId: user.id, call: out });
        ctx.confirmations.push({ id, ...out });
        out = { pending_confirmation: id, note: "Waiting for the user to confirm in the app." };
      }
      results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) });
    }
    history.push({ role: "user", content: results });
  }
  sessions.set(user.id, trimHistory(history));
  pushFeed({ t: Date.now(), who: user.name, text, reply });
  return { reply, confirmations: ctx.confirmations, images: ctx.images };
}
// keep history valid: never start on a tool_result
function trimHistory(h) {
  let out = h.slice(-30);
  while (out.length && !(out[0].role === "user" && typeof out[0].content === "string")) out = out.slice(1);
  return out;
}

// ---------- notifications ----------
async function notifyOwner(title, message) {
  try {
    const svcs = await ha.services();
    const notify = svcs.find(s => s.domain === "notify");
    const targets = Object.keys(notify?.services || {}).filter(n => n.startsWith("mobile_app_"));
    for (const n of targets) await ha.call("notify", n, { title, message }).catch(() => {});
    return targets.length;
  } catch { return 0; }
}
async function alertIntegrator(title, message) {
  pushAlert({ t: Date.now(), title, message });
  await ha.call("persistent_notification", "create", { title: `Bina: ${title}`, message, notification_id: "bina_" + norm(title).replace(/\s+/g, "_").slice(0, 40) }).catch(() => {});
  if (ALERT_URL) {
    await fetch(ALERT_URL, { method: "POST", headers: { Title: `${house.name}: ${title}`, Tags: "house" }, body: message }).catch(e => console.error("alert_url", e.message));
  }
}

// ---------- monitors: doorbell/motion capture, offline devices, batteries ----------
const lastShot = new Map();
let prevStates = null;
async function monitorEvents() {
  const st = await states();
  if (!prevStates) { prevStates = st; return; }
  const r = await registries();
  const entReg = new Map(r.entities.map(e => [e.entity_id, e]));
  const alarm = Object.values(st).find(s => dom(s.entity_id) === "alarm_control_panel" && (Object.keys(r.exposed).length === 0 || r.exposed[s.entity_id]?.conversation));
  const armed = alarm && /^armed/.test(alarm.state);
  for (const s of Object.values(st)) {
    const id = s.entity_id, prev = prevStates[id];
    if (!prev || prev.state === s.state) continue;
    const isDing = (dom(id) === "binary_sensor" && /ding|doorbell/.test(id) && s.state === "on") || (dom(id) === "event" && /ding|doorbell/.test(id));
    const isMotion = dom(id) === "binary_sensor" && (s.attributes?.device_class === "motion" || /_motion$/.test(id)) && s.state === "on";
    if (!isDing && !(isMotion && armed)) continue;
    const devId = entReg.get(id)?.device_id;
    if (!devId) continue;
    if (Date.now() - (lastShot.get(devId) || 0) < (isDing ? 30000 : 120000)) continue;
    lastShot.set(devId, Date.now());
    const cams = r.entities.filter(e => e.device_id === devId && dom(e.entity_id) === "camera").map(e => e.entity_id);
    const cam = cams.find(c => /snapshot/.test(c)) || cams[0];
    const devName = r.devices.find(d => d.id === devId)?.name_by_user || r.devices.find(d => d.id === devId)?.name || fname(s);
    const title = isDing ? (es() ? `Timbre: ${devName}` : `Doorbell: ${devName}`) : (es() ? `Movimiento con alarma armada: ${devName}` : `Motion while armed: ${devName}`);
    let text = "", image = null;
    if (cam) {
      try {
        if (isDing) await new Promise(res => setTimeout(res, 2500));
        const snap = await snapshotFile(cam, isDing ? "ding" : "motion");
        image = snap.url;
        text = await describeImage(snap.b64, owner().language);
      } catch (e) { console.error("capture", e.message); }
    }
    pushEvent({ t: Date.now(), kind: isDing ? "doorbell" : "motion", title, text, image, camera: cam });
    if (isDing ? DOORBELL_ALERTS : true) notifyOwner(title, text || (es() ? "Abre Bina para ver." : "Open Bina to see."));
  }
  prevStates = st;
}

const offlineSince = new Map(); const offlineAlerted = new Set(); const batteryAlerted = new Map();
async function monitorHealth() {
  const list = await exposedEntities({ includeNoisy: true });
  const st = await states();
  const now = Date.now(); const down = []; const back = [];
  for (const { s, room } of list) {
    if (isPersonal(s) || isNoise(s)) continue;
    const label = `${cleanName(fname(s), room)}${room ? " (" + room + ")" : ""}`;
    if (s.state === "unavailable") {
      if (!offlineSince.has(s.entity_id)) offlineSince.set(s.entity_id, now);
      if (now - offlineSince.get(s.entity_id) > 10 * 60e3 && !offlineAlerted.has(s.entity_id)) { offlineAlerted.add(s.entity_id); down.push(label); }
    } else {
      offlineSince.delete(s.entity_id);
      if (offlineAlerted.delete(s.entity_id)) back.push(label);
    }
  }
  if (down.length) await alertIntegrator(es() ? "Equipos sin conexión" : "Devices offline", down.join(", "));
  if (back.length) await alertIntegrator(es() ? "Equipos de vuelta" : "Devices back online", back.join(", "));
  // batteries: any sensor with device_class battery under 20, once a day
  const low = Object.values(st).filter(s => s.attributes?.device_class === "battery" && !isNaN(+s.state) && +s.state < 20 && now - (batteryAlerted.get(s.entity_id) || 0) > 86400e3);
  if (low.length) { low.forEach(s => batteryAlerted.set(s.entity_id, now)); await alertIntegrator(es() ? "Batería baja" : "Low battery", low.map(s => `${fname(s)} ${s.state}%`).join(", ")); }
}
setInterval(() => monitorEvents().catch(e => console.error("events", e.message)), 5000);
setInterval(() => monitorHealth().catch(e => console.error("health", e.message)), 120000);

// ---------- brief ----------
async function makeBrief(user) {
  const evs = await runTool("get_events", { hours: 24 }, user, {});
  const m = await houseModel();
  const open = [...m.rooms.flatMap(r => r.devices), ...m.unassigned].filter(l => /\[(door|window|opening|garage_door)\]/.test(l) && /=on/.test(l));
  const r = await anthropic.messages.create({
    model: MODEL, max_tokens: 350, system: systemPrompt(user),
    messages: [{ role: "user", content: `Write the morning brief for ${user.name} in ${user.language}. 3 to 6 short lines, plain language, most important first, no bullets. Cover: visitors and doorbell, doors/sliders currently open, alarm and lock state, anything unavailable. Currently open: ${open.join("; ") || "nothing"}.\nEvents:\n${evs.join("\n")}` }]
  });
  const text = r.content.find(c => c.type === "text")?.text || "";
  pushFeed({ t: Date.now(), who: "Bina", text: es() ? "Resumen del día" : "Morning brief", reply: text });
  return text;
}
let lastBriefDay = "";
setInterval(async () => {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: house.timezone }));
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (hhmm !== BRIEF_TIME || lastBriefDay === now.toDateString()) return;
  lastBriefDay = now.toDateString();
  for (const u of house.residents.filter(r => r.brief)) {
    try { const text = await makeBrief(u); await notifyOwner("Bina", text); } catch (e) { console.error("brief", e.message); }
  }
}, 30000);

// ---------- suggestions ----------
async function suggestScenes(user) {
  const list = await exposedEntities();
  const useful = list.filter(x => ["light", "cover", "climate", "media_player", "fan", "switch"].includes(dom(x.s.entity_id)));
  const inv = useful.map(x => `${x.s.entity_id} | ${fname(x.s)} | ${x.room || "-"}`).join("\n");
  const rooms = [...new Set(useful.filter(x => dom(x.s.entity_id) === "media_player").map(x => x.room).filter(Boolean))];
  const action = { type: "object", properties: { domain: { type: "string" }, service: { type: "string" }, entity_ids: { type: "array", items: { type: "string" } }, data: { type: "object" }, music: { type: "object", properties: { query: { type: "string" }, room: { type: "string" }, volume_pct: { type: "number" } } } } };
  const tool = { name: "scenes", description: "Return the proposed scenes", input_schema: { type: "object", properties: { scenes: { type: "array", items: { type: "object", properties: { name: { type: "string" }, summary: { type: "string" }, actions: { type: "array", items: action } }, required: ["name", "summary", "actions"] } } }, required: ["scenes"] } };
  const r = await anthropic.messages.create({
    model: MODEL, max_tokens: 8000, tools: [tool], tool_choice: { type: "tool", name: "scenes" },
    messages: [{ role: "user", content: `Devices (entity_id | name | room):\n${inv}\nRooms with speakers: ${rooms.join(", ") || "none"}\n\nPropose 6 useful scenes for this exact house, names and summaries in ${user.language === "es" ? "Spanish" : "English"} (morning, movie night, dinner, relax, leaving, good night or similar), skipping existing ones: ${house.scenes.map(s => s.name).join(", ") || "none"}. Group lights per scene into as few actions as possible (one light.turn_on action with several entity_ids and data.brightness_pct, one light.turn_off action). Shades: cover.open_cover / cover.close_cover. Climate: climate.set_temperature with data.temperature. Music: an action with only music {query, room, volume_pct} using a room with speakers. Never locks, alarm or cameras. Names: 1 or 2 words. Summary: one short line.` }]
  });
  const out = r.content.find(c => c.type === "tool_use")?.input?.scenes || [];
  const known = new Set(list.map(x => x.s.entity_id));
  return out.map(s => ({ ...s, actions: (s.actions || []).filter(a => (a.music && a.music.query) || (a.domain && (a.entity_ids || []).length && a.entity_ids.every(id => known.has(id)) && !["lock", "alarm_control_panel", "camera"].includes(a.domain))).map(a => a.music && a.music.query ? { music: a.music } : { domain: a.domain, service: a.service, entity_ids: a.entity_ids, data: a.data || {} }) })).filter(s => s.actions.length);
}

// ---------- scenes: plain-language description, moods, active detection, capture ----------
const MOODS = ["morning", "movie", "dinner", "relax", "away", "night", "party", "focus", "default"];
function guessMood(name) {
  const n = norm(name);
  if (/manana|morning|despert|dia\b|dias|wake|amanec/.test(n)) return "morning";
  if (/cine|movie|pelicula|tv|film|theater|teatro/.test(n)) return "movie";
  if (/cena|dinner|comida|almuerzo|lunch|desayuno|breakfast/.test(n)) return "dinner";
  if (/relax|chill|tranq|lectura|read|spa/.test(n)) return "relax";
  if (/salir|saliendo|me voy|away|leave|leaving|vacacion|ausente/.test(n)) return "away";
  if (/noche|night|dormir|sleep|bed|cama/.test(n)) return "night";
  if (/fiesta|party|entertain|visita|guests|shabbat|sabbat/.test(n)) return "party";
  if (/trabajo|work|focus|oficina|office|estudio/.test(n)) return "focus";
  return "default";
}
function photoUrl(kind, id) {
  const f = `${kind}-${String(id).replace(/[^a-z0-9_-]/gi, "_")}.jpg`;
  try { const st = fs.statSync(path.join(PHOTO_DIR, f)); return `photos/${f}?v=${Math.round(st.mtimeMs)}`; } catch { return null; }
}
async function entityInfo() {
  const list = await exposedEntities({ includeNoisy: true });
  return new Map(list.map(x => [x.s.entity_id, { name: cleanName(fname(x.s), x.room), room: x.room, s: x.s }]));
}
// short parts for the card + full lines for the detail sheet
function describeScene(scene, info, lang) {
  const E = lang !== "en";
  const parts = []; const lines = [];
  const lightsOn = [], lightsOff = [], levels = [];
  for (const a of scene.actions || []) {
    if (a.music) {
      parts.push({ kind: "music", text: E ? `${a.music.query} en ${a.music.room}` : `${a.music.query} in ${a.music.room}` });
      lines.push({ kind: "music", room: a.music.room, name: a.music.query, setting: a.music.volume_pct != null ? `${E ? "vol" : "vol"} ${a.music.volume_pct}%` : "" });
      continue;
    }
    const ids = a.entity_ids || [];
    for (const id of ids) {
      const i = info.get(id) || { name: id.split(".")[1].replace(/_/g, " "), room: null };
      const d = a.domain, sv = a.service, data = a.data || {};
      let kind = d, setting = "";
      if (d === "light" || (d === "switch" && /turn_/.test(sv))) {
        kind = "light";
        if (sv === "turn_off") { lightsOff.push(id); setting = E ? "apagada" : "off"; }
        else { lightsOn.push(id); const lv = data.brightness_pct ?? (data.brightness != null ? Math.round(data.brightness / 2.55) : 100); levels.push(lv); setting = `${lv}%`; }
      } else if (d === "cover") { kind = "shade"; setting = sv === "open_cover" ? (E ? "abrir" : "open") : sv === "close_cover" ? (E ? "cerrar" : "close") : data.position != null ? `${data.position}%` : sv; }
      else if (d === "climate") { kind = "climate"; setting = data.temperature != null ? `${data.temperature}°` : (data.hvac_mode || sv); }
      else if (d === "media_player") { kind = /tv|tele/i.test(i.name + id) ? "tv" : "speaker"; setting = { media_pause: E ? "pausa" : "pause", turn_off: E ? "apagar" : "off", turn_on: E ? "prender" : "on", volume_set: `vol ${Math.round((data.volume_level || 0) * 100)}%`, select_source: data.source || "" }[sv] || sv.replace(/_/g, " "); }
      else if (d === "lock") { kind = "lock"; setting = sv === "lock" ? (E ? "cerrar con llave" : "lock") : (E ? "abrir" : "unlock"); }
      else if (d === "alarm_control_panel") { kind = "alarm"; setting = /arm/.test(sv) ? (E ? "armar" : "arm") : (E ? "desarmar" : "disarm"); }
      else if (d === "fan") { kind = "fan"; setting = sv === "turn_off" ? (E ? "apagar" : "off") : (E ? "prender" : "on"); }
      else if (d === "scene" || d === "script") { kind = "scene"; setting = ""; }
      lines.push({ kind, room: i.room, name: i.name, setting, id });
    }
  }
  if (lightsOn.length) {
    const avg = Math.round(levels.reduce((x, y) => x + y, 0) / levels.length);
    const allSame = levels.every(l => l === levels[0]);
    parts.unshift({ kind: "light", text: E ? `${lightsOn.length} ${lightsOn.length === 1 ? "luz" : "luces"} ${allSame ? "al " + levels[0] : "~" + avg}%` : `${lightsOn.length} ${lightsOn.length === 1 ? "light" : "lights"} at ${allSame ? levels[0] : "~" + avg}%` });
  }
  if (lightsOff.length) parts.splice(lightsOn.length ? 1 : 0, 0, { kind: "lightoff", text: E ? `apaga ${lightsOff.length}` : `${lightsOff.length} off` });
  const by = (k) => lines.filter(l => l.kind === k);
  if (by("shade").length) parts.push({ kind: "shade", text: (E ? "persianas " : "shades ") + by("shade")[0].setting });
  if (by("climate").length) parts.push({ kind: "climate", text: by("climate")[0].setting });
  if (by("tv").length) parts.push({ kind: "tv", text: (E ? "tele: " : "TV: ") + by("tv").map(l => l.setting).join(", ") });
  if (by("speaker").length) parts.push({ kind: "speaker", text: (E ? "audio " : "audio ") + by("speaker")[0].setting });
  if (by("lock").length) parts.push({ kind: "lock", text: by("lock")[0].setting });
  if (by("alarm").length) parts.push({ kind: "alarm", text: (E ? "alarma: " : "alarm: ") + by("alarm")[0].setting });
  const rooms = [...new Set(lines.map(l => l.room).filter(Boolean))];
  return { parts, lines, rooms };
}
// a scene is "active" when every light/cover/climate target it sets matches the house now
function sceneActive(scene, st) {
  let checked = 0;
  for (const a of scene.actions || []) {
    if (a.music) continue;
    for (const id of a.entity_ids || []) {
      const s = st[id]; if (!s) continue;
      if (a.domain === "light") {
        checked++;
        if (a.service === "turn_off") { if (s.state !== "off") return false; }
        else {
          if (s.state !== "on") return false;
          const want = a.data?.brightness_pct; const have = s.attributes?.brightness != null ? s.attributes.brightness / 2.55 : null;
          if (want != null && have != null && Math.abs(want - have) > 6) return false;
        }
      } else if (a.domain === "cover") {
        checked++;
        if (a.service === "open_cover" && !["open", "opening"].includes(s.state)) return false;
        if (a.service === "close_cover" && !["closed", "closing"].includes(s.state)) return false;
      } else if (a.domain === "climate" && a.data?.temperature != null) {
        checked++;
        if (Math.abs((s.attributes?.temperature ?? -99) - a.data.temperature) > 0.6) return false;
      }
    }
  }
  return checked > 0;
}
async function scenesView(lang) {
  const [info, st] = await Promise.all([entityInfo(), states()]);
  return house.scenes.map(sc => {
    const d = describeScene(sc, info, lang);
    return { id: sc.id, name: sc.name, mood: sc.mood || guessMood(sc.name), photo: photoUrl("scene", sc.id), parts: d.parts, rooms: d.rooms, active: sceneActive(sc, st) };
  });
}
// snapshot of the house right now (Savant-style capture)
async function captureScene(name, roomsFilter) {
  const list = await exposedEntities();
  const inRoom = (x) => !roomsFilter?.length || (x.room && roomsFilter.includes(x.room));
  const actions = []; const byLevel = new Map(); const offs = [];
  for (const x of list.filter(inRoom)) {
    const s = x.s, d = dom(s.entity_id), a = s.attributes || {};
    if (d === "light") {
      if (s.state === "on") { const lv = a.brightness != null ? Math.max(1, Math.round(a.brightness / 2.55)) : 100; if (!byLevel.has(lv)) byLevel.set(lv, []); byLevel.get(lv).push(s.entity_id); }
      else if (s.state === "off") offs.push(s.entity_id);
    } else if (d === "cover" && a.current_position != null) actions.push({ domain: "cover", service: "set_cover_position", entity_ids: [s.entity_id], data: { position: a.current_position } });
    else if (d === "cover" && ["open", "closed"].includes(s.state)) actions.push({ domain: "cover", service: s.state === "open" ? "open_cover" : "close_cover", entity_ids: [s.entity_id] });
    else if (d === "climate" && a.temperature != null && s.state !== "off") actions.push({ domain: "climate", service: "set_temperature", entity_ids: [s.entity_id], data: { temperature: a.temperature } });
    else if (d === "media_player" && s.state === "playing" && !isTV(s) && a.media_title && x.room) actions.push({ music: { query: [a.media_title, a.media_artist].filter(Boolean).join(" "), room: x.room, volume_pct: a.volume_level != null ? Math.round(a.volume_level * 100) : undefined } });
  }
  for (const [lv, ids] of byLevel) actions.unshift({ domain: "light", service: "turn_on", entity_ids: ids, data: { brightness_pct: lv } });
  if (offs.length) actions.push({ domain: "light", service: "turn_off", entity_ids: offs });
  const scene = { id: norm(name).replace(/\s+/g, "-") || newId(), name, mood: guessMood(name), actions };
  house.scenes = house.scenes.filter(x => norm(x.name) !== norm(name)); house.scenes.push(scene); saveHouse();
  return scene;
}
// everything controllable in one room
async function roomDetail(room) {
  const list = (await exposedEntities()).filter(x => (x.room || "") === room);
  const out = [];
  for (const { s } of list) {
    if (isNoise(s) || isPersonal(s)) continue;
    const d = dom(s.entity_id), a = s.attributes || {}, base = { id: s.entity_id, name: cleanName(fname(s), room), state: s.state };
    if (d === "light") out.push({ ...base, kind: "light", on: s.state === "on", level: a.brightness != null ? Math.round(a.brightness / 2.55) : (s.state === "on" ? 100 : 0), dimmable: (a.supported_color_modes || []).length ? a.supported_color_modes.some(m => m !== "onoff") : a.brightness != null || s.state === "off" });
    else if (d === "switch") out.push({ ...base, kind: /light|lamp|cabinet|uplight|downlight|sconce|pendant|luz/i.test(fname(s)) ? "light" : "switch", on: s.state === "on", level: s.state === "on" ? 100 : 0, dimmable: false });
    else if (d === "media_player") out.push({ ...base, kind: isTV(s) ? "tv" : "speaker", on: !["off", "standby", "unavailable"].includes(s.state), playing: s.state === "playing", title: a.media_title || "", artist: a.media_artist || "", source: a.source || a.app_name || "", sources: (a.source_list || []).slice(0, 12), volume: a.volume_level != null ? Math.round(a.volume_level * 100) : null, art: a.entity_picture || null });
    else if (d === "cover") out.push({ ...base, kind: "shade", position: a.current_position ?? (s.state === "open" ? 100 : 0) });
    else if (d === "climate") out.push({ ...base, kind: "climate", mode: s.state, current: a.current_temperature, target: a.temperature, min: a.min_temp, max: a.max_temp });
    else if (d === "lock") out.push({ ...base, kind: "lock" });
    else if (d === "binary_sensor" && /^(door|window|opening|garage_door)$/.test(a.device_class || "")) out.push({ ...base, kind: "contact", open: s.state === "on" });
    else if (d === "camera") out.push({ ...base, kind: "camera" });
    else if (d === "fan") out.push({ ...base, kind: "fan", on: s.state === "on" });
  }
  const order = { light: 0, switch: 1, shade: 2, climate: 3, speaker: 4, tv: 5, fan: 6, contact: 7, lock: 8, camera: 9 };
  out.sort((x, y) => (order[x.kind] ?? 99) - (order[y.kind] ?? 99) || x.name.localeCompare(y.name));
  return { room, photo: photoUrl("room", room), devices: out };
}
async function roomsView() {
  const list = await exposedEntities();
  const rooms = new Map();
  for (const { s, room } of list) {
    if (!room || isNoise(s) || isPersonal(s)) continue;
    if (!rooms.has(room)) rooms.set(room, { room, lightsOn: 0, lights: 0, playing: null, tvOn: false, temp: null, open: 0, devices: 0 });
    const r = rooms.get(room), d = dom(s.entity_id), a = s.attributes || {};
    r.devices++;
    if (d === "light" || (d === "switch" && /light|lamp|cabinet|uplight|downlight|sconce|pendant|luz/i.test(fname(s)))) { r.lights++; if (s.state === "on") r.lightsOn++; }
    if (d === "media_player" && s.state === "playing" && !isTV(s)) r.playing = a.media_title || "♪";
    if (d === "media_player" && isTV(s) && !["off", "standby", "unavailable"].includes(s.state)) r.tvOn = true;
    if (d === "climate" && a.current_temperature != null) r.temp = Math.round(a.current_temperature);
    if (d === "binary_sensor" && s.state === "on" && /^(door|window|opening)$/.test(a.device_class || "")) r.open++;
  }
  return [...rooms.values()].filter(r => r.devices > 0).map(r => ({ ...r, photo: photoUrl("room", r.room) })).sort((a, b) => (b.lightsOn + (b.playing ? 2 : 0) + (b.tvOn ? 2 : 0)) - (a.lightsOn + (a.playing ? 2 : 0) + (a.tvOn ? 2 : 0)) || b.lights - a.lights);
}

// ---------- routes ----------
const userFrom = (req) => house.residents.find(r => r.id === (req.headers["x-bina-user"] || "owner")) || house.residents[0];
const wrap = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { console.error(req.path, e.message); res.status(500).json({ error: e.message }); } };

app.post("/api/chat", async (req, res) => {
  try { res.json(await chat(userFrom(req), String(req.body.text || "").slice(0, 2000))); }
  catch (e) { res.status(500).json({ reply: (es() ? "Algo falló de mi lado: " : "Something went wrong on my side: ") + e.message, confirmations: [] }); }
});

app.post("/api/confirm/:id", wrap(async (req, res) => {
  const p = pending.get(req.params.id);
  const user = userFrom(req);
  if (!p) return res.status(404).json({ error: es() ? "Expiró, pídelo de nuevo." : "Expired, ask again." });
  pending.delete(req.params.id);
  if (req.body.approve !== true) return res.json({ ok: true, reply: user.language === "es" ? "Cancelado." : "Cancelled." });
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
}));

// ---------- live status: everything that is on right now ----------
// "Main Floor Kitchen Kitchen Downlights" (room Kitchen) -> "Downlights"
function cleanName(name, room) {
  let n = String(name || "").replace(/^(main|first|second|upper|lower|ground|1st|2nd|3rd)\s+floor\s+/i, "").replace(/^(planta (baja|alta)|primer piso|segundo piso)\s+/i, "");
  if (room) { const r = room.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); let prev; do { prev = n; n = n.replace(new RegExp("^" + r + "\\s+", "i"), ""); } while (n !== prev); }
  n = n.replace(/\b(\w+)\s+\1\b/gi, "$1").trim();
  return n || name;
}
const isPersonal = (s) => /macbook|iphone|ipad|imac|android|pixel|galaxy|laptop/i.test(fname(s) + " " + s.entity_id);
const isNoise = (s) => /keypad|_led\b| led\b|button|scene_controller/i.test(fname(s) + " " + s.entity_id);
const isTV = (s) => s.attributes?.device_class === "tv" || /\b(tv|tele|television|samsung|lg|sony)\b/i.test(fname(s) + " " + s.entity_id);
async function liveStatus() {
  const list = await exposedEntities();
  const out = { lights: [], audio: [], video: [], climate: [], shades: [], other: [], security: { alarm: null, locks: [], open: [] } };
  for (const { s, room } of list) {
    const d = dom(s.entity_id), a = s.attributes || {}, base = { id: s.entity_id, name: cleanName(fname(s), room), room };
    if (isNoise(s) || (d === "media_player" && isPersonal(s))) continue;
    if (d === "light" && s.state === "on") out.lights.push({ ...base, level: a.brightness != null ? Math.round(a.brightness / 2.55) : null });
    else if (d === "media_player" && !["off", "standby", "unavailable", "unknown"].includes(s.state)) {
      const item = { ...base, state: s.state, title: a.media_title || "", artist: a.media_artist || "", source: a.source || a.app_name || "", volume: a.volume_level != null ? Math.round(a.volume_level * 100) : null, muted: !!a.is_volume_muted };
      if (isTV(s)) out.video.push(item); else if (s.state === "playing" || s.state === "paused" || s.state === "buffering") out.audio.push(item);
    }
    else if (d === "climate") out.climate.push({ ...base, mode: s.state, action: a.hvac_action || "", current: a.current_temperature, target: a.temperature ?? a.target_temp_low ?? null });
    else if (d === "cover" && ["open", "opening", "closing"].includes(s.state)) out.shades.push({ ...base, state: s.state, position: a.current_position ?? null });
    else if (d === "switch" && s.state === "on" && /light|lamp|cabinet|uplight|downlight|sconce|pendant|chandelier|strip|luz|lampara/i.test(fname(s))) out.lights.push({ ...base, level: null });
    else if ((d === "fan" || d === "switch") && s.state === "on") out.other.push(base);
    else if (d === "alarm_control_panel") out.security.alarm = { id: s.entity_id, state: s.state };
    else if (d === "lock") out.security.locks.push({ ...base, state: s.state });
    else if (d === "binary_sensor" && /^(door|window|opening|garage_door)$/.test(a.device_class || "") && s.state === "on") out.security.open.push(base);
  }
  const byRoom = (x, y) => String(x.room || "~").localeCompare(String(y.room || "~"));
  out.lights.sort(byRoom); out.audio.sort(byRoom); out.video.sort(byRoom);
  const st = await states();
  out.activeScenes = house.scenes.filter(sc => { try { return sceneActive(sc, st); } catch { return false; } }).map(sc => sc.id);
  out.rooms = await roomsView();
  out.at = Date.now();
  return out;
}
app.get("/api/live", wrap(async (_req, res) => { stateCache.at = 0; res.json(await liveStatus()); }));

// server-sent events: push the live status whenever something changes
const streams = new Set(); let lastLive = "";
app.get("/api/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.(); res.write("retry: 3000\n\n");
  streams.add(res); lastLive = "";
  req.on("close", () => streams.delete(res));
});
setInterval(async () => {
  if (!streams.size) return;
  try {
    stateCache.at = 0;
    const live = await liveStatus(); const key = JSON.stringify({ ...live, at: 0 });
    if (key === lastLive) { for (const r of streams) r.write(": ping\n\n"); return; }
    lastLive = key; const msg = `data: ${JSON.stringify(live)}\n\n`;
    for (const r of streams) r.write(msg);
  } catch (e) { console.error("stream", e.message); }
}, 2000);

// turn one thing off (or pause a speaker)
app.post("/api/off", wrap(async (req, res) => {
  const id = String(req.body?.entity_id || ""); const d = dom(id);
  const st = await states(); const s = st[id];
  if (!s) return res.status(404).json({ error: "unknown" });
  const allowed = (await exposedEntities({ includeNoisy: true })).some(x => x.s.entity_id === id);
  if (!allowed) return res.status(403).json({ error: "not exposed" });
  if (d === "light" || d === "switch" || d === "fan") await ha.call(d, "turn_off", { entity_id: id });
  else if (d === "media_player") await ha.call("media_player", isTV(s) ? "turn_off" : "media_pause", { entity_id: id });
  else if (d === "cover") await ha.call("cover", "close_cover", { entity_id: id });
  else return res.status(400).json({ error: "not supported" });
  stateCache.at = 0; lastLive = ""; audit({ user: userFrom(req).id, action: "off", entity: id });
  res.json({ ok: true });
}));
app.post("/api/level", wrap(async (req, res) => {
  const id = String(req.body?.entity_id || ""), v = Math.max(0, Math.min(100, Number(req.body?.value)));
  const allowed = (await exposedEntities({ includeNoisy: true })).some(x => x.s.entity_id === id);
  if (!allowed || isNaN(v)) return res.status(400).json({ error: "bad request" });
  if (dom(id) === "light") await ha.call("light", v > 0 ? "turn_on" : "turn_off", v > 0 ? { entity_id: id, brightness_pct: v } : { entity_id: id });
  else if (dom(id) === "media_player") await ha.call("media_player", "volume_set", { entity_id: id, volume_level: v / 100 });
  else return res.status(400).json({ error: "not supported" });
  stateCache.at = 0; lastLive = ""; res.json({ ok: true });
}));

// home screen data
app.get("/api/home", wrap(async (req, res) => {
  const list = await exposedEntities();
  const pick = (d) => list.filter(x => dom(x.s.entity_id) === d);
  const alarm = pick("alarm_control_panel")[0]?.s;
  const locks = pick("lock").map(x => ({ id: x.s.entity_id, name: fname(x.s), state: x.s.state }));
  const climate = pick("climate").map(x => ({ id: x.s.entity_id, name: fname(x.s), current: x.s.attributes.current_temperature, target: x.s.attributes.temperature, mode: x.s.state }));
  const openings = pick("binary_sensor").filter(x => /^(door|window|opening|garage_door)$/.test(x.s.attributes.device_class || "") && x.s.state === "on").map(x => fname(x.s));
  const rooms = new Map();
  for (const x of pick("light")) { const k = x.room || (es() ? "Otros" : "Other"); if (!rooms.has(k)) rooms.set(k, { room: k, on: 0, total: 0 }); const r = rooms.get(k); r.total++; if (x.s.state === "on") r.on++; }
  const playing = pick("media_player").filter(x => x.s.state === "playing").map(x => ({ id: x.s.entity_id, name: fname(x.s), room: x.room, title: x.s.attributes.media_title || "", artist: x.s.attributes.media_artist || "" }));
  res.json({
    version: VERSION, house: house.name, user: userFrom(req).name, language: userFrom(req).language,
    status: { alarm: alarm ? { id: alarm.entity_id, state: alarm.state } : null, locks, climate, openings },
    scenes: await scenesView(userFrom(req).language),
    roomCards: await roomsView(),
    homePhoto: photoUrl("home", "main"),
    rooms: [...rooms.values()].sort((a, b) => b.total - a.total),
    playing,
    events: events.slice(0, 4),
    alerts: alerts.filter(a => a.t > Date.now() - 48 * 3600e3).filter((a, i, all) => all.findIndex(b => norm(b.title) === norm(a.title) && b.message === a.message) === i).slice(0, 2)
  });
}));
app.post("/api/scene/:id", wrap(async (req, res) => {
  const sc = house.scenes.find(s => s.id === req.params.id);
  if (!sc) return res.status(404).json({ error: "no scene" });
  const r = await runScene(sc, userFrom(req));
  pushFeed({ t: Date.now(), who: userFrom(req).name, text: sc.name, reply: r.failed.length ? `fallos: ${r.failed.join(", ")}` : "OK" });
  res.json({ ok: !r.failed.length, failed: r.failed, confirmations: r.confirmations });
}));
app.delete("/api/scene/:id", wrap(async (req, res) => { house.scenes = house.scenes.filter(s => s.id !== req.params.id); saveHouse(); res.json({ ok: true }); }));
app.post("/api/scenes", wrap(async (req, res) => {
  const { name, actions } = req.body || {};
  if (!name || !Array.isArray(actions)) return res.status(400).json({ error: "name and actions" });
  const out = await runTool("save_scene", { name, actions }, userFrom(req), {});
  res.json(out);
}));
app.get("/api/suggest", wrap(async (req, res) => res.json(await suggestScenes(userFrom(req)))));
app.post("/api/room", wrap(async (req, res) => {
  const { room, on } = req.body || {};
  const lights = (await exposedEntities()).filter(x => dom(x.s.entity_id) === "light" && (x.room || (es() ? "Otros" : "Other")) === room).map(x => x.s.entity_id);
  if (!lights.length) return res.status(404).json({ error: "no lights" });
  await ha.call("light", on ? "turn_on" : "turn_off", { entity_id: lights });
  stateCache.at = 0; audit({ user: userFrom(req).id, action: "room", room, on });
  res.json({ ok: true });
}));
app.post("/api/alloff", wrap(async (req, res) => {
  const list = await exposedEntities();
  const lights = list.filter(x => dom(x.s.entity_id) === "light" && x.s.state === "on").map(x => x.s.entity_id);
  const players = list.filter(x => dom(x.s.entity_id) === "media_player" && x.s.state === "playing").map(x => x.s.entity_id);
  if (lights.length) await ha.call("light", "turn_off", { entity_id: lights });
  if (players.length) await ha.call("media_player", "media_pause", { entity_id: players }).catch(() => {});
  stateCache.at = 0; audit({ user: userFrom(req).id, action: "alloff", lights: lights.length, players: players.length });
  res.json({ ok: true, lights: lights.length, players: players.length });
}));
app.post("/api/media", wrap(async (req, res) => {
  const { entity_id, action } = req.body || {};
  if (!/^media_player\./.test(entity_id) || !["media_pause", "media_play", "media_next_track", "volume_up", "volume_down"].includes(action)) return res.status(400).json({ error: "bad request" });
  await ha.call("media_player", action, { entity_id }); stateCache.at = 0; res.json({ ok: true });
}));
app.get("/api/scene/:id", wrap(async (req, res) => {
  const sc = house.scenes.find(s => s.id === req.params.id);
  if (!sc) return res.status(404).json({ error: "no scene" });
  const d = describeScene(sc, await entityInfo(), userFrom(req).language);
  res.json({ id: sc.id, name: sc.name, mood: sc.mood || guessMood(sc.name), photo: photoUrl("scene", sc.id), ...d, active: sceneActive(sc, await states()) });
}));
app.patch("/api/scene/:id", wrap(async (req, res) => {
  const sc = house.scenes.find(s => s.id === req.params.id);
  if (!sc) return res.status(404).json({ error: "no scene" });
  if (req.body?.name) sc.name = String(req.body.name).slice(0, 40);
  if (MOODS.includes(req.body?.mood)) sc.mood = req.body.mood;
  saveHouse(); res.json({ ok: true });
}));
app.post("/api/capture", wrap(async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: "name" });
  const sc = await captureScene(name, req.body?.rooms);
  audit({ user: userFrom(req).id, action: "capture", name, actions: sc.actions.length });
  res.json({ ok: true, id: sc.id });
}));
app.post("/api/photo", wrap(async (req, res) => {
  const { kind, id, data } = req.body || {};
  if (!["scene", "room", "home"].includes(kind) || !id || !/^data:image\/jpeg;base64,/.test(data || "")) return res.status(400).json({ error: "bad photo" });
  const f = `${kind}-${String(id).replace(/[^a-z0-9_-]/gi, "_")}.jpg`;
  fs.writeFileSync(path.join(PHOTO_DIR, f), Buffer.from(data.split(",")[1], "base64"));
  res.json({ ok: true, url: photoUrl(kind, id) });
}));
app.delete("/api/photo", wrap(async (req, res) => {
  const { kind, id } = req.body || {};
  try { fs.unlinkSync(path.join(PHOTO_DIR, `${kind}-${String(id).replace(/[^a-z0-9_-]/gi, "_")}.jpg`)); } catch {}
  res.json({ ok: true });
}));
app.get("/api/rooms/:room", wrap(async (req, res) => res.json(await roomDetail(req.params.room))));
// one control for every device type
app.post("/api/set", wrap(async (req, res) => {
  const { entity_id: id, action, value } = req.body || {};
  const info = await entityInfo(); const it = info.get(id);
  if (!it) return res.status(403).json({ error: "not exposed" });
  const d = dom(id); const s = it.s; let call = null;
  if (d === "light") call = action === "off" ? ["light", "turn_off", {}] : action === "level" ? (Number(value) > 0 ? ["light", "turn_on", { brightness_pct: Math.min(100, Number(value)) }] : ["light", "turn_off", {}]) : ["light", s.state === "on" && action !== "on" ? "turn_off" : "turn_on", {}];
  else if (d === "switch" || d === "fan") call = [d, action === "off" || (action !== "on" && s.state === "on") ? "turn_off" : "turn_on", {}];
  else if (d === "cover") call = action === "open" ? ["cover", "open_cover", {}] : action === "close" ? ["cover", "close_cover", {}] : action === "stop" ? ["cover", "stop_cover", {}] : ["cover", "set_cover_position", { position: Math.max(0, Math.min(100, Number(value))) }];
  else if (d === "climate") call = ["climate", "set_temperature", { temperature: Number(value) }];
  else if (d === "media_player") call = { play: ["media_player", "media_play", {}], pause: ["media_player", "media_pause", {}], next: ["media_player", "media_next_track", {}], prev: ["media_player", "media_previous_track", {}], volume: ["media_player", "volume_set", { volume_level: Math.max(0, Math.min(1, Number(value) / 100)) }], on: ["media_player", "turn_on", {}], off: ["media_player", "turn_off", {}], source: ["media_player", "select_source", { source: String(value) }] }[action];
  if (!call) return res.status(400).json({ error: "unsupported" });
  await ha.call(call[0], call[1], { entity_id: id, ...call[2] });
  stateCache.at = 0; lastLive = ""; audit({ user: userFrom(req).id, action: `${call[0]}.${call[1]}`, entity: id, value });
  res.json({ ok: true });
}));
app.get("/api/house", wrap(async (_req, res) => res.json(await houseModel())));
app.get("/api/feed", (_req, res) => res.json(feed.slice(0, 50)));
app.get("/api/events", (_req, res) => res.json(events.slice(0, 60)));
app.get("/api/alerts", (_req, res) => res.json(alerts.slice(0, 50)));
app.get("/api/brief", wrap(async (req, res) => res.json({ brief: await makeBrief(userFrom(req)) })));
app.get("/api/me", (req, res) => { const u = userFrom(req); res.json({ house: house.name, user: u.name, language: u.language, version: VERSION }); });

app.listen(PORT, () => console.log(`Bina ${VERSION} listening on :${PORT} for ${house.name}, brief at ${BRIEF_TIME}, alerts ${ALERT_URL ? "on" : "local only"}`));
