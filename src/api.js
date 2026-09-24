const call = async (method, url, body) => {
  const r = await fetch('/api' + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || r.statusText), { status: r.status });
  return d;
};
export const api = {
  get: (u) => call('GET', u),
  post: (u, b = {}) => call('POST', u, b),
  put: (u, b) => call('PUT', u, b),
  patch: (u, b) => call('PATCH', u, b),
  del: (u) => call('DELETE', u),
};

/* Skyrim time: real time shifted to UTC-5, year = real year - 1800 (2026 -> 4E 226), months renamed. */
export const MONTHS = ['Morning Star', "Sun's Dawn", 'First Seed', "Rain's Hand", 'Second Seed', 'Midyear',
  "Sun's Height", 'Last Seed', 'Hearthfire', 'Frostfall', "Sun's Dusk", 'Evening Star'];
export const sk = (t) => new Date(+new Date(t) - 5 * 36e5);
const p2 = (x) => String(x).padStart(2, '0');
export const dLabel = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, 4E ${d.getUTCFullYear() - 1800}`;
export const h12 = (H) => ((H + 11) % 12) + 1;
export const stamp = (t) => { const d = sk(t), H = d.getUTCHours(); return `${dLabel(d)}, ${h12(H)}:${p2(d.getUTCMinutes())} ${H < 12 ? 'AM' : 'PM'}`; };
/* <input type=datetime-local> values are read as Skyrim time (UTC-5), whatever the browser's zone. */
export const nowInput = () => sk(Date.now()).toISOString().slice(0, 16);
export const inputToIso = (v) => new Date(v + ':00-05:00').toISOString();
export const dayKey = (t) => sk(t).toISOString().slice(0, 10);
export const hue = (c) => ([...c].reduce((a, x) => a + x.charCodeAt(0), 0) * 37) % 360;
