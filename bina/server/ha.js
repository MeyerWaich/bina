// Home Assistant client: REST for state/services, WebSocket for registries and exposure
import WebSocket from "ws";
const base = () => process.env.HA_URL.replace(/\/$/, "");
const headers = () => ({ Authorization: `Bearer ${process.env.HA_TOKEN}`, "Content-Type": "application/json" });

async function req(path, opts = {}) {
  const r = await fetch(base() + path, { ...opts, headers: headers() });
  if (!r.ok) throw new Error(`HA ${r.status} ${path}: ${await r.text()}`);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}

// one-shot websocket command
function wsCall(type, extra = {}) {
  return new Promise((resolve, reject) => {
    const url = base().replace(/^http/, "ws") + "/websocket";
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("ws timeout")); }, 8000);
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: process.env.HA_TOKEN }));
      else if (m.type === "auth_ok") ws.send(JSON.stringify({ id: 1, type, ...extra }));
      else if (m.type === "auth_invalid") { clearTimeout(timer); ws.close(); reject(new Error("ws auth")); }
      else if (m.id === 1) { clearTimeout(timer); ws.close(); m.success ? resolve(m.result) : reject(new Error(JSON.stringify(m.error))); }
    });
  });
}

export const ha = {
  states: () => req("/api/states"),
  state: (id) => req(`/api/states/${id}`),
  services: () => req("/api/services"),
  call: (domain, service, data) => req(`/api/services/${domain}/${service}`, { method: "POST", body: JSON.stringify(data) }),
  logbook: async (hours = 24) => req(`/api/logbook/${new Date(Date.now() - hours * 3600e3).toISOString()}`),
  snapshot: async (entityId) => {
    const r = await fetch(`${base()}/api/camera_proxy/${entityId}`, { headers: { Authorization: `Bearer ${process.env.HA_TOKEN}` } });
    if (!r.ok) throw new Error(`snapshot ${r.status}`);
    return Buffer.from(await r.arrayBuffer()).toString("base64");
  },
  saveAutomation: (id, config) => req(`/api/config/automation/config/${id}`, { method: "POST", body: JSON.stringify(config) }),
  // registries
  areas: () => wsCall("config/area_registry/list"),
  entities: () => wsCall("config/entity_registry/list"),
  devices: () => wsCall("config/device_registry/list"),
  exposed: async () => { const r = await wsCall("homeassistant/expose_entity/list"); return r.exposed_entities || {}; }
};
