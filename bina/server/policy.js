// Decides what Bina may do without asking.
const AUTO = new Set(["light", "switch", "media_player", "climate", "cover", "scene", "script", "input_boolean", "fan", "select", "number"]);
const CONFIRM = new Set(["lock", "alarm_control_panel"]);
const READ_ONLY = new Set(["camera", "sensor", "binary_sensor", "device_tracker", "person"]);

export function classify({ domain, entityIds = [], house, states }) {
  if (entityIds.some(id => house.protected.includes(id))) return "confirm";
  if (domain === "cover") {
    const garage = entityIds.some(id => (states[id]?.attributes?.device_class || "") === "garage");
    if (garage) return "confirm";
  }
  if (CONFIRM.has(domain)) return "confirm";
  if (READ_ONLY.has(domain)) return "deny";
  if (AUTO.has(domain)) return "auto";
  return "deny";
}

export function roleAllows(role, decision) {
  if (role === "owner") return true;
  if (role === "family") return decision !== "deny";
  if (role === "guest") return decision === "auto";
  if (role === "integrator") return decision === "auto";
  return false;
}
