import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Settings as Cog, Paperclip, FileText } from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import Counter from './components/Counter/Counter';
import BorderGlow from './components/BorderGlow/BorderGlow';
import Shredder from './components/Shredder/Shredder';
import HoldButton from './components/HoldButton/Holdbutton';
import RevealBox from './components/RevealBox/RevealBox';
import FuseButton from './components/FuseButton/FuseButton';
import ErrorBoundary from './components/ErrorBoundary';
import mapImg from './assets/skyrimmap.jpg';
import { api, sk, dLabel, stamp, dayKey, hue, h12, nowInput, inputToIso } from './api';
import { THEMES, FONTS } from './themes';

const md = (s) => ({ __html: DOMPurify.sanitize(marked.parse(s || '')) });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const excerpt = (b) => b.replace(/[#>*_`[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 320);
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

function Overlay({ id, close, children }) { // frosted backdrop; the card grows into the sheet (shared layoutId)
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && close();
    addEventListener('keydown', k); document.body.style.overflow = 'hidden';
    return () => { removeEventListener('keydown', k); document.body.style.overflow = ''; };
  }, []);
  return createPortal(
    <div className="overlay-wrap">
      <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={close} />
      <motion.div layoutId={id} className="sheet"><button className="sheet-x" onClick={close}>Close</button>{children}</motion.div>
    </div>, document.body);
}

function Attachments({ report, me, onChange, locked }) {
  const [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const upload = async (files) => {
    if (!files.length) return;
    setBusy(true); setErr('');
    try {
      for (const file of files) {
        const fd = new FormData(); fd.append('file', file);
        const res = await fetch(`/api/reports/${report.id}/attachments`, { method: 'POST', body: fd, credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed');
      }
      onChange();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const remove = (id) => api.post(`/attachments/${id}/remove`).then(onChange).catch((e) => setErr(e.message));
  return (
    <div className="attach-block">
      <h3>Attachments</h3>
      <div className="attach-row">
        {report.attachments.map((a) => (
          <div key={a.id} className="attach-clip-wrap">
            {(me.role === 'warden' || !locked) && (
              <HoldButton size="sm" radius={99} holdTime={800} doneLabel="Gone" backgroundColor="transparent" textColor="var(--dim)"
                fillColor="#a33a34" glow={false} resetAfter={400} className="attach-del" onHold={() => remove(a.id)} aria-label="Remove attachment">×</HoldButton>)}
            <a className="attach-clip" href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" title={`${a.original_name} (${(a.size / 1024).toFixed(0)} KB)`}>
              <Paperclip size={16} className="attach-pin" />
              {a.mime.startsWith('image/') ? <img src={`/api/attachments/${a.id}`} alt="" /> : <FileText size={30} />}
              <span>{a.original_name}</span>
            </a>
          </div>))}
        {!locked && (
          <label className="attach-clip attach-add">
            <Paperclip size={16} className="attach-pin" />
            <span>{busy ? 'Uploading...' : 'Attach a file'}</span>
            <input type="file" hidden multiple accept=".pdf,image/png,image/jpeg,image/webp,image/gif" disabled={busy}
              onChange={(e) => { const files = [...e.target.files]; e.target.value = ''; upload(files); }} />
          </label>)}
      </div>
      {err && <p className="bad">{err}</p>}
    </div>
  );
}

export function Report({ r, me, onChange, reveal, onSearch }) {
  const [open, setOpen] = useState(false), [mode, setMode] = useState(null), [f, setF] = useState({}), [pool, setPool] = useState([]), [err, setErr] = useState('');
  const late = r.filed_at && Math.abs(new Date(r.filed_at) - new Date(r.created_at)) > 6e4;
  const pick = (m) => {
    setErr(''); setMode(mode === m ? null : m);
    if (m === 'edit') setF({ title: r.title, body: r.body, confidence: r.confidence || '', source: r.source || '', note: '' });
    if (m === 'link') { setF({ toId: '' }); api.get('/reports?limit=200').then(setPool); }
  };
  const send = (path, body) => api.post(`/reports/${r.id}/${path}`, body).then(() => { setMode(null); onChange(); }).catch((e) => setErr(e.message));
  const set = (k) => (e) => setF({ ...f, [k]: e.target ? e.target.value : e });
  const card = (
    <motion.article layoutId={'r' + r.id} className={'report card' + (r.deleted_at ? ' redacted' : '')} role="button" tabIndex={0}
      onClick={() => setOpen(true)} onKeyDown={(e) => e.key === 'Enter' && setOpen(true)}>
      <h3>{r.title}</h3>
      <p className="meta">{stamp(r.created_at)}, {r.author} <Meta conf={r.confidence} /></p>
      <p className="clamp">{excerpt(r.body)}</p>
    </motion.article>
  );
  return (
    <>
      {!open && (reveal ? <RevealBox>{card}</RevealBox> : card)}
      <AnimatePresence>{open && (
        <Overlay id={'r' + r.id} close={() => setOpen(false)}>
          <h2>{r.title}</h2>
          <p className="meta">{stamp(r.created_at)}, filed by {r.author}{late && ` on ${stamp(r.filed_at)}`}{r.deleted_at && `. Redacted ${stamp(r.deleted_at)}`} <Meta conf={r.confidence} source={r.source} /></p>
          <div className="md" dangerouslySetInnerHTML={md(r.body)} />
          <div>{r.tags.map((t) => <Chip key={t.id} tag={t} on />)}</div>
          {r.links.length > 0 && <p className="meta">Linked to: {r.links.map((l) => (onSearch
            ? <button key={l.id} className="lnk" onClick={() => { setOpen(false); onSearch(l.title); }}>{l.title}</button> : <span key={l.id} className="lnk">{l.title}</span>))}</p>}
          <Attachments report={r} me={me} onChange={onChange} locked={!!r.deleted_at} />
          {r.deleted_at ? (me.role === 'warden' && <button onClick={() => api.post(`/reports/${r.id}/restore`).then(onChange)}>Restore</button>) : (
            <div className="row">
              <button onClick={() => pick('edit')}>Edit</button><button onClick={() => pick('link')}>Link report</button>
              {r.revisions.length > 0 && <button onClick={() => pick('hist')}>History ({r.revisions.length})</button>}
            </div>)}
          {mode === 'edit' && (
            <div className="form"><input value={f.title} onChange={set('title')} /><textarea rows={8} value={f.body} onChange={set('body')} />
              <div className="row"><ConfSelect value={f.confidence} onChange={set('confidence')} /><SourceField value={f.source} onChange={set('source')} /></div>
              <input placeholder="Why are you changing it? (kept in the history)" value={f.note} onChange={set('note')} />
              <p className="dim">The original and every earlier version stay in the history.</p>
              <button className="primary" onClick={() => send('edit', f)}>Save revision</button></div>)}
          {mode === 'link' && (
            <div className="form row"><select value={f.toId} onChange={set('toId')}><option value="">Choose a report to link...</option>
              {pool.filter((p) => p.id !== r.id).map((p) => <option key={p.id} value={p.id}>{p.title} ({dLabel(sk(p.created_at))})</option>)}</select>
              <button className="primary" onClick={() => send('links', { toId: +f.toId })}>Link</button></div>)}
          {mode === 'hist' && (
            <div className="form">{r.revisions.map((v) => (
              <details key={v.id}><summary>{stamp(v.edited_at)}, {v.editor}{v.note && `: ${v.note}`}</summary><b>{v.title}</b><div className="md" dangerouslySetInnerHTML={md(v.body)} /></details>))}
              <details><summary>Original, {stamp(r.filed_at)}, {r.author}</summary><b>{r.original.title}</b><div className="md" dangerouslySetInnerHTML={md(r.original.body)} /></details></div>)}
          {err && <p className="bad">{err}</p>}
        </Overlay>)}</AnimatePresence>
    </>
  );
}

function InfoSide({ hold, stats, onPick, onClose, openTag }) {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.get(hold ? `/reports?tags=${hold.id}&limit=50` : '/reports?limit=100').then(setRows); }, [hold?.id]);
  const co = {};
  rows.forEach((r) => r.tags.forEach((t) => { if (t.id !== hold?.id && t.category !== 'Hold') co[t.id] = { ...t, n: (co[t.id]?.n || 0) + 1 }; }));
  const top = Object.values(co).sort((a, b) => b.n - a.n).slice(0, 10);
  const holds = stats.filter((t) => t.category === 'Hold').sort((a, b) => b.n - a.n);
  return (
    <aside className="panel side">
      <div className="row"><h2 style={{ flex: 1 }}>{hold ? hold.name : 'Skyrim'}</h2>{hold && <button onClick={onClose}>All of Skyrim</button>}</div>
      <p className="meta">{rows.length} report(s){rows[0] && `. Latest: ${stamp(rows[0].created_at)}`}</p>
      {!hold && <><h3>Holds by activity</h3>{holds.map((t) => <button key={t.id} className="poi-row" onClick={() => onPick(t)}><span>{t.name}</span><b>{t.n}</b></button>)}</>}
      {top.length > 0 && <><h3>{hold ? 'Also mentioned' : 'Most mentioned'}</h3><div>{top.map((t) => <Chip key={t.id} tag={t} n={t.n} onClick={() => openTag(hold ? [hold.id, t.id] : [t.id])} />)}</div></>}
      <h3>Latest {hold ? 'here' : 'reports'}</h3>
      {rows.slice(0, 5).map((r) => <div key={r.id} className="mini"><b>{r.title}</b><span className="meta">{stamp(r.created_at)}</span></div>)}
      {!rows.length && <p className="dim">Nothing reported yet.</p>}
      <button className="primary" onClick={() => openTag(hold ? [hold.id] : [])}>Open {hold ? 'all of them' : 'the archive'}</button>
    </aside>
  );
}

export function Dashboard({ me, openTag, setView }) {
  const [days, setDays] = useState([]), [stats, setStats] = useState([]), [recent, setRecent] = useState([]), [hold, setHold] = useState(null);
  const load = () => { api.get('/stats/heatmap').then(setDays); api.get('/stats/tags').then(setStats); api.get('/reports?limit=6').then(setRecent); };
  useEffect(load, []);
  return (
    <>
      <div className="top">
        <section className="panel map-block">
          <h2>The Reach of the Manifesto</h2>
          <MapView stats={stats} active={hold?.id} onPick={setHold} />
          <p className="dim">Select a hold to see what has been reported there.</p>
          <h2>Reports over the last year ({days.reduce((a, d) => a + d.n, 0)})</h2>
          <Heat days={days} />
        </section>
        <InfoSide hold={hold} stats={stats} onPick={setHold} onClose={() => setHold(null)} openTag={openTag} />
      </div>
      <section><h2>Recent reports</h2>
        {recent.map((r) => <Report key={r.id} r={r} me={me} onChange={load} reveal />)}
        {!recent.length && <p className="dim">Nothing lodged yet. <button onClick={() => setView('file')}>File the first report</button></p>}</section>
    </>
  );
}

const hit = (t, txt) => [t.name, ...(t.aliases || '').split(',').map((a) => a.trim())].filter(Boolean).some((n) => new RegExp(`\\b${esc(n)}(e?s)?\\b`, 'i').test(txt));

function TagPicker({ tags, on, lock = [], toggle, create, close, canDelete, onDeleted }) {
  const [q, setQ] = useState(''), [nc, setNc] = useState(''), [nt, setNt] = useState('');
  const g = {};
  tags.filter((t) => t.name.toLowerCase().includes(q.toLowerCase())).forEach((t) => (g[t.category] ||= []).push(t));
  const del = (id) => api.del('/tags/' + id).then(() => onDeleted(id)).catch(() => {});
  return (
    <div className="modal" onClick={close}>
      <div className="panel modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h2 style={{ flex: 1 }}>Tags</h2><button className="primary" onClick={close}>Done</button></div>
        <input placeholder="Filter tags..." value={q} onChange={(e) => setQ(e.target.value)} />
        {canDelete && <p className="dim">Hold the × to remove a tag from every report. Posting the same name again re-tags anything that still mentions it.</p>}
        {Object.entries(g).map(([c, ts]) => (
          <div key={c}><h3>{c}</h3>{ts.map((t) => (
            <span key={t.id} className="tag-row">
              <Chip tag={t} on={on.has(t.id)} onClick={() => !lock.includes(t.id) && toggle(t.id)} />
              {canDelete && c !== 'Person' && (
                <HoldButton size="sm" radius={99} holdTime={1000} doneLabel="Gone" backgroundColor="transparent" textColor="var(--dim)"
                  fillColor="#a33a34" glow={false} resetAfter={400} className="tag-del" onHold={() => del(t.id)}>×</HoldButton>)}
            </span>))}</div>))}
        {create && (
          <div className="row"><input list="tcats" placeholder="Category" value={nc} onChange={(e) => setNc(e.target.value)} />
            <datalist id="tcats">{Object.keys(g).map((c) => <option key={c} value={c} />)}</datalist>
            <input placeholder="New tag" value={nt} onChange={(e) => setNt(e.target.value)} />
            <button onClick={() => create(nc, nt).then(() => setNt(''))}>Create tag</button></div>)}
      </div>
    </div>
  );
}

export function Compose({ done, me }) {
  const [tags, setTags] = useState([]), [title, setTitle] = useState(''), [body, setBody] = useState(''), [when, setWhen] = useState(nowInput());
  const [pick, setPick] = useState([]), [conf, setConf] = useState(''), [source, setSource] = useState(''), [picker, setPicker] = useState(false), [err, setErr] = useState(''), [locked, setLocked] = useState(false);
  const pending = useRef(null);
  const load = () => api.get('/tags').then((c) => setTags(c.flatMap((x) => x.tags.map((t) => ({ ...t, category: x.name })))));
  useEffect(() => { load(); }, []);
  useEffect(() => () => { const p = pending.current; if (p) { pending.current = null; api.post('/reports', p); } }, []); // leaving mid-fuse still sends
  const auto = tags.filter((t) => hit(t, title + ' ' + body)).map((t) => t.id);
  const on = new Set([...auto, ...pick]);
  const toggle = (id) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const create = async (c, n) => {
    if (!c.trim() || !n.trim()) return;
    const { id } = await api.post('/tags', { category: c, name: n });
    setPick((p) => [...p, id]); load();
  };
  const arm = () => { pending.current = { title, body, tagIds: pick, occurredAt: inputToIso(when), confidence: conf, source }; setLocked(true); setErr(''); };
  const undo = () => { pending.current = null; setLocked(false); };
  const fire = () => {
    const p = pending.current; if (!p) return;
    pending.current = null;
    api.post('/reports', p).then(done).catch((e) => { setErr(e.message); setLocked(false); });
  };
  return (
    <div className="cols">
      <BorderGlow {...glow}>
        <div className="glow-pad">
          <h2>File a report</h2>
          <fieldset className="bare" disabled={locked}>
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
          </fieldset>
          {err && <p className="bad">{err}</p>}
          <p className="dim">After you press it, the fuse burns for six seconds. Press Undo before it ends and nothing is sent.</p>
          <FuseButton label="Lodge report" doneLabel="Lodged" undoLabel="Undo" undoWindow={6000} size="lg" radius={10} fuse="outline"
            background="#27272a" color="#f5f5f5" fuseColor="#e0b94a" disabled={!title.trim() || !body.trim()} onCommit={arm} onUndo={undo} onFuseEnd={fire} />
        </div>
      </BorderGlow>
      <div className="panel"><h2>{title || 'Preview'}</h2><p className="meta">{dLabel(sk(inputToIso(when)))} <Meta conf={conf} source={source} /></p>
        <div className="md" dangerouslySetInnerHTML={md(body || '*Nothing written yet.*')} /></div>
      {picker && <TagPicker tags={tags} on={on} lock={auto} toggle={toggle} create={create} close={() => setPicker(false)}
        canDelete={me.role === 'warden'} onDeleted={(id) => { setPick((p) => p.filter((x) => x !== id)); load(); }} />}
    </div>
  );
}

function ReportsArchive({ me, sel, setSel }) {
  const [q, setQ] = useState(''), [rows, setRows] = useState([]), [stats, setStats] = useState([]), [sd, setSd] = useState(false), [k, setK] = useState(0), [picker, setPicker] = useState(false);
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
        {rows.map((r) => <Report key={r.id} r={r} me={me} onChange={() => setK((x) => x + 1)} onSearch={setQ} />)}
        {picker && <TagPicker tags={stats} on={new Set(sel)} toggle={flip} close={() => setPicker(false)}
          canDelete={me.role === 'warden'} onDeleted={(id) => { setSel((s) => s.filter((x) => x !== id)); setK((x) => x + 1); }} />}
      </div>
      <aside className="shred-rail">
        <h3>Redaction shredder</h3>
        <p className="dim">Drag a report into the slot to redact it. It stays in the vault; a Warden can restore it.</p>
        <ErrorBoundary label="The shredder">
          {shreddable.length > 0 ? (
            <Shredder items={shreddable.map((r) => ({ id: r.id, title: r.title, at: r.created_at }))} width={320} height={440}
              color="#e4d8b8" slitColor="#3f3f46" onShred={shred}
              renderItem={(r) => <div className="shred-item"><b>{r.title}</b><span>{stamp(r.at)}</span></div>} />
          ) : <p className="dim">Nothing here of yours to redact yet.</p>}
        </ErrorBoundary>
      </aside>
    </div>
  );
}

export function Archive({ me, sel, setSel, sub, setSub, openTag }) {
  return (
    <ErrorBoundary label="The archive">
      <div className="row subnav">{[['reports', 'Reports'], ['pois', 'Persons of interest']].map(([k, l]) => (
        <button key={k} className={sub === k ? 'tab on' : 'tab'} onClick={() => setSub(k)}>{l}</button>))}</div>
      {sub === 'reports' ? <ReportsArchive me={me} sel={sel} setSel={setSel} /> : <PoisArchive me={me} openTag={openTag} />}
    </ErrorBoundary>
  );
}

function AccountPane({ me, setMe }) {
  const [callsign, setCallsign] = useState(me.callsign), [cur, setCur] = useState(''), [next, setNext] = useState('');
  const [csMsg, setCsMsg] = useState(''), [pwMsg, setPwMsg] = useState('');
  const renameSign = () => api.patch('/me/callsign', { callsign })
    .then(() => { setCsMsg('Saved.'); setMe({ ...me, callsign }); }).catch((e) => setCsMsg(e.message));
  const changePass = () => api.post('/me/password', { current: cur, next })
    .then(() => { setPwMsg('Passphrase changed.'); setCur(''); setNext(''); }).catch((e) => setPwMsg(e.message));
  return (
    <>
      <h3>Callsign</h3>
      <div className="row"><input value={callsign} onChange={(e) => setCallsign(e.target.value)} />
        <button onClick={renameSign} disabled={!callsign.trim() || callsign === me.callsign}>Save</button></div>
      {csMsg && <p className="dim">{csMsg}</p>}
      <h3>Passphrase</h3>
      <input type="password" placeholder="Current passphrase" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
      <input type="password" placeholder="New passphrase (8+ characters)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      <button onClick={changePass} disabled={!cur || next.length < 8}>Change passphrase</button>
      {pwMsg && <p className="dim">{pwMsg}</p>}
    </>
  );
}

export function SettingsCog({ settings, save, me, setMe }) {
  const [open, setOpen] = useState(false), [tab, setTab] = useState('look');
  return (
    <div className="cog">
      {open && (
        <div className="panel cog-pop">
          <div className="row subnav" style={{ marginBottom: 10 }}>
            <button className={tab === 'look' ? 'tab on' : 'tab'} onClick={() => setTab('look')}>Appearance</button>
            <button className={tab === 'acct' ? 'tab on' : 'tab'} onClick={() => setTab('acct')}>Account</button>
          </div>
          {tab === 'look' ? (
            <>
              <h3>Palette</h3>
              <div className="row">{Object.entries(THEMES).map(([k, t]) => (
                <button key={k} className={settings.theme === k ? 'tab on' : 'tab'} onClick={() => save({ ...settings, theme: k })}>{t.label}</button>))}</div>
              <h3>Typeface</h3>
              <div className="row">{Object.entries(FONTS).map(([k, l]) => (
                <button key={k} className={settings.font === k ? 'tab on' : 'tab'} onClick={() => save({ ...settings, font: k })}>{l}</button>))}</div>
              <label className="row" style={{ marginTop: 12 }}><input type="checkbox" checked={settings.animate !== false}
                onChange={(e) => save({ ...settings, animate: e.target.checked })} /> Animate the background</label>
              <p className="dim">Saved to your callsign.</p>
            </>
          ) : <AccountPane me={me} setMe={setMe} />}
        </div>)}
      <button className="cog-btn" onClick={() => setOpen(!open)} aria-label="Settings" aria-expanded={open}><Cog size={22} /></button>
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
          <td>{x.id !== me.id && (<div className="row">
            {x.role === 'pending' && <><HB done="Approved" onHold={() => role(x.id, 'agent')}>Hold to approve</HB><HB danger done="Denied" onHold={() => api.del('/users/' + x.id).then(load)}>Hold to deny</HB></>}
            {x.role === 'agent' && <><HB done="Promoted" onHold={() => role(x.id, 'warden')}>Hold to promote</HB><HB danger done="Suspended" onHold={() => role(x.id, 'pending')}>Hold to suspend</HB></>}
            {x.role === 'warden' && <HB danger done="Demoted" onHold={() => role(x.id, 'agent')}>Hold to demote</HB>}
          </div>)}</td></tr>))}</tbody></table>
    </div>
  );
}

function PoiCard({ p, me, reload, openTag }) {
  const [open, setOpen] = useState(false), [rows, setRows] = useState([]), [form, setForm] = useState(null), [err, setErr] = useState('');
  const loadRows = () => api.get(`/reports?tags=${p.id}&limit=100`).then(setRows);
  useEffect(() => { if (open) loadRows(); }, [open]);
  const save = () => api.put('/pois/' + p.id, form).then(() => { setForm(null); reload(); loadRows(); }).catch((e) => setErr(e.message));
  const redacted = !!p.deleted_at;
  const setRedaction = (on) => api.post(`/pois/${p.id}/${on ? 'redact' : 'restore'}`).then(reload).catch((e) => setErr(e.message));
  return (
    <>
      {!open && (
        <motion.article layoutId={'p' + p.id} className={'report card' + (redacted ? ' redacted' : '')} role="button" tabIndex={0} onClick={() => setOpen(true)} onKeyDown={(e) => e.key === 'Enter' && setOpen(true)}>
          <h3>{p.name}</h3>
          <p className="meta">{p.n} report(s){p.aliases && `, also known as ${p.aliases}`}</p>
          <p className="clamp">{redacted ? 'This file has been redacted.' : (excerpt(p.description) || 'No description yet.')}</p>
        </motion.article>)}
      <AnimatePresence>{open && (
        <Overlay id={'p' + p.id} close={() => setOpen(false)}>
          <h2>{p.name}</h2>
          {p.aliases && <p className="meta">Also known as {p.aliases}</p>}
          <p className="meta">{rows.length} report(s){rows.length > 0 && `. First seen ${stamp(rows.at(-1).created_at)}. Last seen ${stamp(rows[0].created_at)}`}{redacted && '. Redacted'}</p>
          {form ? (
            <div className="form"><input placeholder="Aliases, separated by commas (also tagged automatically)" value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} />
              <textarea rows={6} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              {err && <p className="bad">{err}</p>}
              <div className="row"><button className="primary" onClick={save}>Save</button><button onClick={() => setForm(null)}>Cancel</button></div></div>
          ) : (
            <>
              <div className="md" dangerouslySetInnerHTML={md((redacted ? '*This file has been redacted. Its contents are hidden and its tag no longer applies to reports.*' : p.description) || '*No description yet.*')} />
              <div className="row">
                {!redacted && <button onClick={() => setForm(p)}>Edit file</button>}
                <button className="primary" onClick={() => { setOpen(false); openTag([p.id]); }}>Read their reports</button>
                {me.role === 'warden' && (redacted
                  ? <HB done="Restored" onHold={() => setRedaction(false)}>Hold to restore</HB>
                  : <HB danger done="Redacted" onHold={() => setRedaction(true)}>Hold to redact</HB>)}
              </div>
            </>)}
          {err && <p className="bad">{err}</p>}
          <h3>Timeline</h3>
          {rows.map((r) => <div key={r.id} className="mini"><b>{r.title}</b><span className="meta">{stamp(r.created_at)}, {r.author} <Meta conf={r.confidence} /></span></div>)}
        </Overlay>)}</AnimatePresence>
    </>
  );
}

function PoisArchive({ me, openTag }) {
  const [list, setList] = useState([]), [q, setQ] = useState(''), [form, setForm] = useState(null), [err, setErr] = useState(''), [sd, setSd] = useState(false);
  const load = () => api.get(`/pois?deleted=${sd ? 1 : 0}`).then(setList);
  useEffect(() => { load(); }, [sd]);
  const create = () => api.post('/pois', form).then(() => { setForm(null); setErr(''); load(); }).catch((e) => setErr(e.message));
  const shown = list.filter((x) => (x.name + ' ' + x.aliases + ' ' + x.description).toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <div className="panel">
        <input placeholder="Search persons of interest..." value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="row"><span className="dim">{shown.length} file(s)</span>
          <button className="plus" onClick={() => setForm({ name: '', aliases: '', description: '' })}>+ New person</button>
          {me.role === 'warden' && <label><input type="checkbox" checked={sd} onChange={(e) => setSd(e.target.checked)} /> show redacted</label>}</div>
        {form && (
          <div className="form"><input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input placeholder="Aliases, separated by commas" value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} />
            <textarea rows={5} placeholder="Description, allegiances, habits. Markdown works." value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            {err && <p className="bad">{err}</p>}
            <div className="row"><button className="primary" onClick={create}>Open file</button><button onClick={() => setForm(null)}>Cancel</button></div></div>)}
      </div>
      {shown.map((p) => <PoiCard key={p.id} p={p} me={me} reload={load} openTag={openTag} />)}
      {!list.length && <p className="dim">No files yet. Anyone named in a report is tagged as soon as they have one.</p>}
    </div>
  );
}
