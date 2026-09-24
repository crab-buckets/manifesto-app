import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import Counter from './components/Counter/Counter';
import BorderGlow from './components/BorderGlow/BorderGlow';
import Shredder from './components/Shredder/Shredder';
import HoldButton from './components/HoldButton/Holdbutton';
import ScrollReveal from './components/Scroll Reveal/ScrollReaveal';
import mapImg from './assets/skyrimmap.jpg';
import { api, sk, dLabel, stamp, dayKey, hue, h12, nowInput, inputToIso } from './api';
import { THEMES, FONTS } from './themes';

const md = (s) => ({ __html: DOMPurify.sanitize(marked.parse(s || '')) });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const excerpt = (b) => b.replace(/[#>*_`[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 240);
const glow = { backgroundColor: 'var(--panel)', glowColor: '40 50 60', colors: ['#b08d3c', '#a33a34', '#4f8f86'], borderRadius: 10 };

/* Pin positions as % of skyrimmap.jpg, placed over each hold's shield. */
const HOLDS = {
  Solitude: [36.8, 19], Dawnstar: [55.7, 18.6], Winterhold: [74.5, 18], Morthal: [40.6, 30.8], Windhelm: [78.9, 40.5],
  Markarth: [10.5, 50.8], Whiterun: [53.8, 54], Falkreath: [42.5, 78.4], Riften: [89.1, 81.9],
};

export function Chip({ tag, on, onClick, n }) {
  return (
    <button type="button" className={'chip' + (on ? ' on' : '')} style={{ '--h': hue(tag.category) }} onClick={onClick}
      title={tag.category}>{tag.name}{n != null && <b>{n}</b>}</button>
  );
}

export function Clock() {
  const [t, setT] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setT(Date.now()), 1000); return () => clearInterval(i); }, []);
  const d = sk(t), H = d.getUTCHours(), h = h12(H);
  const c = { fontSize: 30, gap: 0, horizontalPadding: 2, gradientHeight: 7, gradientFrom: 'var(--bg)' };
  return (
    <div className="clock" aria-label="Skyrim time">
      <div className="clock-date">{dLabel(d)}</div>
      <div className="clock-row">
        <Counter value={h} places={h < 10 ? [1] : [10, 1]} {...c} /><i>:</i>
        <Counter value={d.getUTCMinutes()} places={[10, 1]} {...c} /><i>:</i>
        <Counter value={d.getUTCSeconds()} places={[10, 1]} {...c} />
        <span className="ampm">{H < 12 ? 'AM' : 'PM'}</span>
      </div>
    </div>
  );
}

function Heat({ days }) {
  const cells = useMemo(() => {
    const m = Object.fromEntries(days.map((x) => [x.day, x.n]));
    const now = Date.now(), dow = sk(now).getUTCDay(), out = [];
    for (let i = 52 * 7 + dow; i >= 0; i--) {
      const t = now - i * 864e5, k = dayKey(t), n = m[k] || 0;
      out.push(<div key={k} className={'l' + (n ? (n < 2 ? 1 : n < 4 ? 2 : n < 7 ? 3 : 4) : 0)} title={`${n} report(s), ${dLabel(sk(t))}`} />);
    }
    return out;
  }, [days]);
  return <div className="heat-wrap"><div className="heat">{cells}</div></div>;
}

function MapView({ stats, active, onPick }) {
  return (
    <div className="map">
      <img src={mapImg} alt="Map of Skyrim" />
      {stats.filter((t) => t.category === 'Hold' && HOLDS[t.name]).map((t) => {
        const [x, y] = HOLDS[t.name], s = Math.min(58, 26 + t.n * 6);
        return (
          <button key={t.id} className={'pin' + (t.n ? ' hot' : '') + (active === t.id ? ' active' : '')}
            style={{ left: x + '%', top: y + '%', width: s, height: s }} onClick={() => onPick(t)}
            title={`${t.name}: ${t.n} report(s)`}>{t.n || ''}</button>
        );
      })}
    </div>
  );
}

const CONF = { rumour: 'Rumour', witnessed: 'Witnessed', confirmed: 'Confirmed' };
const Meta = ({ conf, source }) => <>{conf && <span className={'conf ' + conf}>{CONF[conf]}</span>}{source && <span className="src">Source: {source}</span>}</>;
const ConfSelect = ({ value, onChange }) => (
  <select value={value || ''} onChange={(e) => onChange(e.target.value)}>
    <option value="">Confidence: unrated</option>{Object.entries(CONF).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
  </select>
);
function SourceField({ value, onChange }) { // pick an existing source or type a new one; new ones join the list permanently
  const [list, setList] = useState([]);
  useEffect(() => { api.get('/sources').then(setList).catch(() => {}); }, []);
  return (<><input list="sources" placeholder="Source (choose one, or type a new one)" value={value} onChange={(e) => onChange(e.target.value)} />
    <datalist id="sources">{list.map((x) => <option key={x} value={x} />)}</datalist></>);
}

export function Report({ r, me, onChange, reveal, onSearch }) {
  const [mode, setMode] = useState(null), [f, setF] = useState({}), [pool, setPool] = useState([]), [err, setErr] = useState('');
  const late = r.filed_at && Math.abs(new Date(r.filed_at) - new Date(r.created_at)) > 6e4;
  const open = (m) => {
    setErr(''); setMode(mode === m ? null : m);
    if (m === 'edit') setF({ title: r.title, body: r.body, confidence: r.confidence || '', source: r.source || '', note: '' });
    if (m === 'add') setF({ body: '', confidence: '', source: '' });
    if (m === 'link') { setF({ toId: '' }); api.get('/reports?limit=200').then(setPool); }
  };
  const send = (path, body) => api.post(`/reports/${r.id}/${path}`, body).then(() => { setMode(null); onChange(); }).catch((e) => setErr(e.message));
  const set = (k) => (e) => setF({ ...f, [k]: e.target ? e.target.value : e });
  return (
    <article className={'report' + (r.deleted_at ? ' redacted' : '')}>
      <h3>{r.title}</h3>
      <p className="meta">{stamp(r.created_at)}, filed by {r.author}{late && ` on ${stamp(r.filed_at)}`}{r.deleted_at && `. Redacted ${stamp(r.deleted_at)}`} <Meta conf={r.confidence} source={r.source} /></p>
      {reveal ? <ScrollReveal textClassName="sr-text" baseOpacity={0.15} blurStrength={3} rotationEnd="center center" wordAnimationEnd="center center">{excerpt(r.body)}</ScrollReveal>
        : <div className="md" dangerouslySetInnerHTML={md(r.body)} />}
      {r.addenda.map((a) => (
        <div className="addendum" key={a.id}>
          <p className="meta">Addendum, {stamp(a.created_at)}, {a.author} <Meta conf={a.confidence} source={a.source} /></p>
          <div className="md" dangerouslySetInnerHTML={md(a.body)} />
        </div>))}
      <div>{r.tags.map((t) => <Chip key={t.id} tag={t} on />)}</div>
      {r.links.length > 0 && <p className="meta">Linked to: {r.links.map((l) => (onSearch
        ? <button key={l.id} className="lnk" onClick={() => onSearch(l.title)}>{l.title}</button> : <span key={l.id} className="lnk">{l.title}</span>))}</p>}
      {r.deleted_at ? (me.role === 'warden' && <button onClick={() => api.post(`/reports/${r.id}/restore`).then(onChange)}>Restore</button>) : (
        <div className="row">
          <button onClick={() => open('edit')}>Edit</button><button onClick={() => open('add')}>Add addendum</button>
          <button onClick={() => open('link')}>Link report</button>
          {r.revisions.length > 0 && <button onClick={() => open('hist')}>History ({r.revisions.length})</button>}
        </div>)}
      {mode === 'edit' && (
        <div className="form"><input value={f.title} onChange={set('title')} /><textarea rows={8} value={f.body} onChange={set('body')} />
          <div className="row"><ConfSelect value={f.confidence} onChange={set('confidence')} /><SourceField value={f.source} onChange={set('source')} /></div>
          <input placeholder="Why are you changing it? (kept in the history)" value={f.note} onChange={set('note')} />
          <p className="dim">The original and every earlier version stay in the history.</p>
          <button className="primary" onClick={() => send('edit', f)}>Save revision</button></div>)}
      {mode === 'add' && (
        <div className="form"><textarea rows={5} placeholder="New information, added beneath the report. Markdown works." value={f.body} onChange={set('body')} />
          <div className="row"><ConfSelect value={f.confidence} onChange={set('confidence')} /><SourceField value={f.source} onChange={set('source')} /></div>
          <button className="primary" onClick={() => send('addenda', f)}>Add addendum</button></div>)}
      {mode === 'link' && (
        <div className="form row"><select value={f.toId} onChange={set('toId')}><option value="">Choose a report to link...</option>
          {pool.filter((p) => p.id !== r.id).map((p) => <option key={p.id} value={p.id}>{p.title} ({dLabel(sk(p.created_at))})</option>)}</select>
          <button className="primary" onClick={() => send('links', { toId: +f.toId })}>Link</button></div>)}
      {mode === 'hist' && (
        <div className="form">{r.revisions.map((v) => (
          <details key={v.id}><summary>{stamp(v.edited_at)}, {v.editor}{v.note && `: ${v.note}`}</summary><b>{v.title}</b><div className="md" dangerouslySetInnerHTML={md(v.body)} /></details>))}
          <details><summary>Original, {stamp(r.filed_at)}, {r.author}</summary><b>{r.original.title}</b><div className="md" dangerouslySetInnerHTML={md(r.original.body)} /></details></div>)}
      {err && <p className="bad">{err}</p>}
    </article>
  );
}

function HoldSide({ hold, onClose, openTag }) {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.get(`/reports?tags=${hold.id}&limit=50`).then(setRows); }, [hold.id]);
  const co = {};
  rows.forEach((r) => r.tags.forEach((t) => { if (t.id !== hold.id) co[t.id] = { ...t, n: (co[t.id]?.n || 0) + 1 }; }));
  const top = Object.values(co).sort((a, b) => b.n - a.n).slice(0, 10);
  return (
    <aside className="panel side">
      <div className="row"><h2 style={{ flex: 1 }}>{hold.name}</h2><button onClick={onClose} aria-label="Close">Close</button></div>
      <p className="meta">{rows.length} report(s){rows[0] && `. Latest: ${stamp(rows[0].created_at)}`}</p>
      {top.length > 0 && <><h3>Also mentioned</h3><div>{top.map((t) => <Chip key={t.id} tag={t} n={t.n} onClick={() => openTag([hold.id, t.id])} />)}</div></>}
      <h3>Latest here</h3>
      {rows.slice(0, 6).map((r) => <div key={r.id} className="mini"><b>{r.title}</b><span className="meta">{stamp(r.created_at)}</span></div>)}
      {!rows.length && <p className="dim">Nothing reported from this hold yet.</p>}
      <button className="primary" onClick={() => openTag([hold.id])}>Open all in the archive</button>
    </aside>
  );
}

export function Dashboard({ me, openTag, setView }) {
  const [days, setDays] = useState([]), [stats, setStats] = useState([]), [recent, setRecent] = useState([]), [hold, setHold] = useState(null);
  const load = () => { api.get('/stats/heatmap').then(setDays); api.get('/stats/tags').then(setStats); api.get('/reports?limit=4').then(setRecent); };
  useEffect(load, []);
  return (
    <>
      <div className={'top' + (hold ? ' open' : '')}>
        <section className="panel"><h2>The Reach of the Manifesto</h2><MapView stats={stats} active={hold?.id} onPick={setHold} />
          <p className="dim">Select a hold to see what has been reported there.</p></section>
        {hold && <HoldSide hold={hold} onClose={() => setHold(null)} openTag={openTag} />}
      </div>
      <section className="panel"><h2>Reports over the last year ({days.reduce((a, d) => a + d.n, 0)})</h2><Heat days={days} /></section>
      <section><h2>Recent reports</h2>
        {recent.map((r) => <Report key={r.id} r={r} me={me} onChange={load} reveal />)}
        {!recent.length && <p className="dim">Nothing lodged yet. <button onClick={() => setView('file')}>File the first report</button></p>}</section>
    </>
  );
}

const hit = (t, txt) => [t.name, ...(t.aliases || '').split(',').map((a) => a.trim())].filter(Boolean).some((n) => new RegExp(`\\b${esc(n)}(e?s)?\\b`, 'i').test(txt));

function TagPicker({ tags, on, lock = [], toggle, create, close }) {
  const [q, setQ] = useState(''), [nc, setNc] = useState(''), [nt, setNt] = useState('');
  const g = {};
  tags.filter((t) => t.name.toLowerCase().includes(q.toLowerCase())).forEach((t) => (g[t.category] ||= []).push(t));
  return (
    <div className="modal" onClick={close}>
      <div className="panel modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h2 style={{ flex: 1 }}>Tags</h2><button className="primary" onClick={close}>Done</button></div>
        <input placeholder="Filter tags..." value={q} onChange={(e) => setQ(e.target.value)} />
        {Object.entries(g).map(([c, ts]) => (
          <div key={c}><h3>{c}</h3>{ts.map((t) => <Chip key={t.id} tag={t} on={on.has(t.id)} onClick={() => !lock.includes(t.id) && toggle(t.id)} />)}</div>))}
        {create && (
          <div className="row"><input list="tcats" placeholder="Category" value={nc} onChange={(e) => setNc(e.target.value)} />
            <datalist id="tcats">{Object.keys(g).map((c) => <option key={c} value={c} />)}</datalist>
            <input placeholder="New tag" value={nt} onChange={(e) => setNt(e.target.value)} />
            <button onClick={() => create(nc, nt).then(() => setNt(''))}>Create tag</button></div>)}
      </div>
    </div>
  );
}

export function Compose({ done }) {
  const [tags, setTags] = useState([]), [title, setTitle] = useState(''), [body, setBody] = useState(''), [when, setWhen] = useState(nowInput());
  const [pick, setPick] = useState([]), [conf, setConf] = useState(''), [source, setSource] = useState(''), [picker, setPicker] = useState(false), [err, setErr] = useState('');
  const load = () => api.get('/tags').then((c) => setTags(c.flatMap((x) => x.tags.map((t) => ({ ...t, category: x.name })))));
  useEffect(() => { load(); }, []);
  const auto = tags.filter((t) => hit(t, title + ' ' + body)).map((t) => t.id);
  const on = new Set([...auto, ...pick]);
  const toggle = (id) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const create = async (c, n) => {
    if (!c.trim() || !n.trim()) return;
    const { id } = await api.post('/tags', { category: c, name: n });
    setPick((p) => [...p, id]); load();
  };
  const submit = () => api.post('/reports', { title, body, tagIds: pick, occurredAt: inputToIso(when), confidence: conf, source }).then(done).catch((e) => setErr(e.message));
  return (
    <div className="cols">
      <BorderGlow {...glow}>
        <div className="glow-pad">
          <h2>File a report</h2>
          <input placeholder="Subject" value={title} onChange={(e) => setTitle(e.target.value)} />
          <label className="dim">When it happened (Skyrim time, UTC-5)</label>
          <div className="row" style={{ marginBottom: 8 }}>
            <input type="datetime-local" value={when} max={nowInput()} onChange={(e) => setWhen(e.target.value)} />
            <button type="button" onClick={() => setWhen(nowInput())}>Use current time</button>
          </div>
          <textarea rows={10} placeholder="Markdown is supported. Names of holds, factions, creatures and persons of interest are tagged for you."
            value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="row" style={{ marginBottom: 8 }}><ConfSelect value={conf} onChange={setConf} /><SourceField value={source} onChange={setSource} /></div>
          <div>{tags.filter((t) => on.has(t.id)).map((t) => <Chip key={t.id} tag={t} on onClick={() => !auto.includes(t.id) && toggle(t.id)} />)}
            <button type="button" className="plus" onClick={() => setPicker(true)} aria-label="Add tags">+ Tags</button></div>
          {err && <p className="bad">{err}</p>}
          <button className="primary" onClick={submit}>Lodge report</button>
        </div>
      </BorderGlow>
      <div className="panel"><h2>{title || 'Preview'}</h2><p className="meta">{dLabel(sk(inputToIso(when)))} <Meta conf={conf} source={source} /></p>
        <div className="md" dangerouslySetInnerHTML={md(body || '*Nothing written yet.*')} /></div>
      {picker && <TagPicker tags={tags} on={on} lock={auto} toggle={toggle} create={create} close={() => setPicker(false)} />}
    </div>
  );
}

export function Archive({ me, sel, setSel }) {
  const [q, setQ] = useState(''), [rows, setRows] = useState([]), [stats, setStats] = useState([]), [sd, setSd] = useState(false), [k, setK] = useState(0);
  useEffect(() => { api.get('/stats/tags').then(setStats); }, [k]);
  useEffect(() => {
    const t = setTimeout(() => api.get(`/reports?q=${encodeURIComponent(q)}&tags=${sel.join(',')}&deleted=${sd ? 1 : 0}`).then(setRows), 250);
    return () => clearTimeout(t);
  }, [q, sel, sd, k]);
  const flip = (id) => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  const shreddable = rows.filter((r) => !r.deleted_at && (me.role === 'warden' || r.author === me.callsign));
  const shred = (item) => {
    api.post(`/reports/${item.id}/redact`);
    const now = new Date().toISOString();
    setRows((rs) => (sd ? rs.map((r) => (r.id === item.id ? { ...r, deleted_at: now } : r)) : rs.filter((r) => r.id !== item.id)));
    setTimeout(() => setK((x) => x + 1), 1500);
  };
  return (
    <div className="arch">
      <div>
        <div className="panel">
          <input placeholder="Search the contents of every report..." value={q} onChange={(e) => setQ(e.target.value)} />
          <div>{stats.filter((t) => sel.includes(t.id)).map((t) => <Chip key={t.id} tag={t} n={t.n} on onClick={() => flip(t.id)} />)}
            <button type="button" className="plus" onClick={() => setPicker(true)}>+ Filter by tag</button></div>
          <div className="row"><span className="dim">{rows.length} report(s)</span>
            {sel.length > 0 && <button onClick={() => setSel([])}>Clear filters</button>}
            {me.role === 'warden' && <label><input type="checkbox" checked={sd} onChange={(e) => setSd(e.target.checked)} /> show redacted</label>}</div>
        </div>
        {rows.map((r) => <Report key={r.id} r={r} me={me} onChange={() => setK(k + 1)} onSearch={setQ} />)}
        {picker && <TagPicker tags={stats} on={new Set(sel)} toggle={flip} close={() => setPicker(false)} />}
      </div>
      <aside className="shred-rail">
        <h3>Redaction shredder</h3>
        <p className="dim">Drag a report into the slot to redact it. It stays in the vault; a Warden can restore it.</p>
        <Shredder items={shreddable.map((r) => ({ id: r.id, title: r.title, at: r.created_at }))} width={320} height={440}
          color="#e4d8b8" slitColor="#3f3f46" onShred={shred}
          renderItem={(r) => <div className="shred-item"><b>{r.title}</b><span>{stamp(r.at)}</span></div>} />
      </aside>
    </div>
  );
}

export function Settings({ settings, save }) {
  return (
    <div className="panel"><h2>Settings</h2>
      <p className="dim">Saved to your callsign, so they follow you to any device.</p>
      <h3>Palette</h3>
      <div className="row">{Object.entries(THEMES).map(([k, t]) => (
        <button key={k} className={settings.theme === k ? 'tab on' : 'tab'} onClick={() => save({ ...settings, theme: k })}>{t.label}</button>))}</div>
      <h3>Typeface</h3>
      <div className="row">{Object.entries(FONTS).map(([k, l]) => (
        <button key={k} className={settings.font === k ? 'tab on' : 'tab'} onClick={() => save({ ...settings, font: k })}>{l}</button>))}</div>
    </div>
  );
}

const HB = ({ children, done, danger, onHold }) => (
  <HoldButton size="sm" radius={6} holdTime={danger ? 1800 : 1200} doneLabel={done} backgroundColor="var(--cell)" textColor="var(--ink)"
    fillColor={danger ? '#a33a34' : '#4f8f86'} glow={false} resetAfter={500} onHold={onHold}>{children}</HoldButton>
);

export function Personnel({ me }) {
  const [u, setU] = useState([]);
  const load = () => api.get('/users').then(setU);
  useEffect(() => { load(); }, []);
  const role = (id, r) => api.patch('/users/' + id, { role: r }).then(load);
  return (
    <div className="panel"><h2>Personnel</h2><p className="dim">Hold a button to confirm. A tap does nothing.</p>
      <table><tbody>{u.map((x) => (
        <tr key={x.id}><td>{x.callsign}</td><td className="dim">{x.role}</td><td className="dim">{stamp(x.created_at)}</td>
          <td className="row">{x.id !== me.id && (<>
            {x.role === 'pending' && <><HB done="Approved" onHold={() => role(x.id, 'agent')}>Hold to approve</HB><HB danger done="Denied" onHold={() => api.del('/users/' + x.id).then(load)}>Hold to deny</HB></>}
            {x.role === 'agent' && <><HB done="Promoted" onHold={() => role(x.id, 'warden')}>Hold to promote</HB><HB danger done="Suspended" onHold={() => role(x.id, 'pending')}>Hold to suspend</HB></>}
            {x.role === 'warden' && <HB danger done="Demoted" onHold={() => role(x.id, 'agent')}>Hold to demote</HB>}
          </>)}</td></tr>))}</tbody></table>
    </div>
  );
}

export function Pois({ me }) {
  const [list, setList] = useState([]), [cur, setCur] = useState(null), [rows, setRows] = useState([]), [form, setForm] = useState(null), [q, setQ] = useState(''), [err, setErr] = useState('');
  const load = () => api.get('/pois').then(setList);
  const loadRows = () => (cur ? api.get(`/reports?tags=${cur}&limit=100`).then(setRows) : setRows([]));
  useEffect(() => { load(); }, []);
  useEffect(() => { loadRows(); }, [cur]);
  const p = list.find((x) => x.id === cur);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const save = async () => {
    try {
      if (form.id) { await api.put('/pois/' + form.id, form); loadRows(); } else setCur((await api.post('/pois', form)).id);
      setForm(null); setErr(''); load();
    } catch (e) { setErr(e.message); }
  };
  return (
    <div className="cols poi">
      <div className="panel">
        <h2>Persons of interest</h2>
        <input placeholder="Search names..." value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary" onClick={() => setForm({ name: '', aliases: '', description: '' })}>+ New person</button>
        {list.filter((x) => (x.name + ' ' + x.aliases).toLowerCase().includes(q.toLowerCase())).map((x) => (
          <button key={x.id} className={'poi-row' + (cur === x.id ? ' on' : '')} onClick={() => { setCur(x.id); setForm(null); }}>
            <span>{x.name}</span><b>{x.n}</b></button>))}
        {!list.length && <p className="dim">No one yet. Anyone named in a report is tagged once they have a file.</p>}
      </div>
      <div>
        {form && (
          <div className="panel"><h2>{form.id ? 'Edit file' : 'Open a file'}</h2>
            <input placeholder="Name" value={form.name} disabled={!!form.id} onChange={set('name')} />
            <input placeholder="Aliases, separated by commas (also tagged automatically)" value={form.aliases} onChange={set('aliases')} />
            <textarea rows={6} placeholder="Description, allegiances, habits. Markdown works." value={form.description} onChange={set('description')} />
            {err && <p className="bad">{err}</p>}
            <div className="row"><button className="primary" onClick={save}>Save</button><button onClick={() => setForm(null)}>Cancel</button></div></div>)}
        {!form && p && (
          <>
            <div className="panel"><div className="row"><h2 style={{ flex: 1 }}>{p.name}</h2><button onClick={() => setForm(p)}>Edit file</button></div>
              {p.aliases && <p className="meta">Also known as {p.aliases}</p>}
              <p className="meta">{rows.length} report(s){rows.length > 0 && `. First seen ${stamp(rows.at(-1).created_at)}. Last seen ${stamp(rows[0].created_at)}`}</p>
              <div className="md" dangerouslySetInnerHTML={md(p.description || '*No description yet.*')} /></div>
            <h3>Timeline</h3>
            {rows.map((r) => <Report key={r.id} r={r} me={me} onChange={() => { loadRows(); load(); }} />)}
          </>)}
        {!form && !p && <div className="panel"><p className="dim">Choose a person to open their file, or start a new one.</p></div>}
      </div>
    </div>
  );
}
