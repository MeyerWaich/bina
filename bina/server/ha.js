// Thin Home Assistant REST client
const base = () => process.env.HA_URL.replace(/\/$/, "");
const headers = () => ({ Authorization: `Bearer ${process.env.HA_TOKEN}`, "Content-Type": "application/json" });

async function req(path, opts = {}) {
  const r = await fetch(base() + path, { ...opts, headers: headers() });
  if (!r.ok) throw new Error(`HA ${r.status} ${path}: ${await r.text()}`);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
}

export const ha = {
  states: () => req("/api/states"),
  state: (id) => req(`/api/states/${id}`),
  call: (domain, service, data) => req(`/api/services/${domain}/${service}`, { method: "POST", body: JSON.stringify(data) }),
  logbook: async (hours = 24) => {
    const start = new Date(Date.now() - hours * 3600e3).toISOString();
    return req(`/api/logbook/${start}`);
  },
  template: (template) => req("/api/template", { method: "POST", body: JSON.stringify({ template }) }),
  snapshot: async (entityId) => {
    const r = await fetch(`${base()}/api/camera_proxy/${entityId}`, { headers: { Authorization: `Bearer ${process.env.HA_TOKEN}` } });
    if (!r.ok) throw new Error(`snapshot ${r.status}`);
    return Buffer.from(await r.arrayBuffer()).toString("base64");
  },
  // area map via template (avoids websocket)
  areas: async () => {
    const tpl = `{% set ns = namespace(out=[]) %}{% for a in areas() %}{% set ns.out = ns.out + [{'id': a, 'name': area_name(a), 'entities': area_entities(a)}] %}{% endfor %}{{ ns.out | tojson }}`;
    const t = await ha.template(tpl);
    return typeof t === "string" ? JSON.parse(t) : t;
  }
};
